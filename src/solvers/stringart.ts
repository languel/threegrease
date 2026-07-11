// Main-thread side of the string-art solver: pin ring from a stroke,
// target image preparation, worker orchestration, stroke output.
import type { GPStroke, Vec3 } from '../core/types';
import { activeLayer, activeObject, createLayer, createPoint, createStroke, ensureFrame, frameAt } from '../core/gpdata';
import { resamplePoints } from '../core/mathutil';
import { defaultStyle } from '../core/brushes';
import type { AppCtx } from '../tools/context';

export interface StringArtOptions {
  pinCount: number;
  maxChords: number;
  opacity: number;      // darkness removed per pass (also stroke strength)
  minGain: number;
  imageSize: number;    // working resolution (longest side)
}

export const DEFAULT_STRINGART: StringArtOptions = {
  pinCount: 240, maxChords: 1500, opacity: 0.22, minGain: 0.04, imageSize: 200,
};

/** The frame stroke pins ride on: selected stroke, else last stroke. */
export function pinSourceStroke(ctx: AppCtx): GPStroke | null {
  const ob = activeObject(ctx.scene);
  for (const layer of ob.layers) {
    if (layer.hide) continue;
    const f = frameAt(layer, ctx.scene.frame);
    if (!f) continue;
    for (const s of f.strokes) {
      if ((s.select || s.points.some((p) => p.select)) && s.points.length >= 3) return s;
    }
  }
  const layer = activeLayer(ob);
  const f = layer ? frameAt(layer, ctx.scene.frame) : null;
  return f?.strokes.filter((s) => s.points.length >= 3).at(-1) ?? null;
}

/** Load a user image into a grayscale residual buffer. */
export async function loadTargetImage(file: File, size: number):
  Promise<{ gray: Float32Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = size / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(8, Math.round(bitmap.width * scale));
  const h = Math.max(8, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c2d = canvas.getContext('2d')!;
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, w, h);
  c2d.drawImage(bitmap, 0, 0, w, h);
  const img = c2d.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    gray[i] = 1 - (0.299 * r + 0.587 * g + 0.114 * b) / 255; // darkness
  }
  return { gray, width: w, height: h };
}

export interface StringArtRun {
  cancel(): void;
}

/**
 * Run the solver: pins are the source stroke resampled to pinCount (3D);
 * their 2D image coordinates come from the stroke's own bounding box in
 * its dominant plane. Output: one polyline stroke chaining the pins into
 * a new "StringArt" layer.
 */
export function runStringArt(
  ctx: AppCtx,
  target: { gray: Float32Array; width: number; height: number },
  opts: StringArtOptions,
  onProgress: (done: number) => void,
  onDone: (chords: number) => void,
): StringArtRun | null {
  const source = pinSourceStroke(ctx);
  if (!source) return null;
  const pins3d = resamplePoints(source.points, opts.pinCount).map((p) => p.co);

  // 2D mapping: bbox of the two dominant axes of the pin ring
  const spans = [0, 1, 2].map((a) => {
    const vals = pins3d.map((p) => p[a]);
    return { a, min: Math.min(...vals), max: Math.max(...vals) };
  }).sort((u, v) => (v.max - v.min) - (u.max - u.min));
  const [U, V] = [spans[0], spans[1]];
  const pins2d: [number, number][] = pins3d.map((p) => [
    Math.round(((p[U.a] - U.min) / Math.max(1e-9, U.max - U.min)) * (target.width - 1)),
    // image y grows downward; V grows upward in world
    Math.round((1 - (p[V.a] - V.min) / Math.max(1e-9, V.max - V.min)) * (target.height - 1)),
  ]);

  const worker = new Worker(new URL('./stringart.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data as { type: string; chords: number[]; done: number };
    if (msg.type === 'progress') { onProgress(msg.done); return; }
    if (msg.type === 'done') {
      applyResult(ctx, pins3d, msg.chords, opts);
      onDone(msg.done);
    }
    worker.terminate();
  };
  worker.postMessage({
    pins: pins2d, width: target.width, height: target.height,
    gray: target.gray.slice(), // solver mutates its copy
    opacity: opts.opacity, maxChords: opts.maxChords,
    minGain: opts.minGain, minPinSeparation: Math.max(2, Math.round(opts.pinCount * 0.05)),
  });
  return { cancel: () => worker.postMessage('cancel') };
}

function applyResult(ctx: AppCtx, pins3d: Vec3[], chords: number[], opts: StringArtOptions): void {
  const ob = activeObject(ctx.scene);
  ctx.pushUndo();
  let layer = ob.layers.find((l) => l.name === 'StringArt');
  if (!layer) {
    layer = createLayer('StringArt');
    ob.layers.push(layer);
  }
  const frame = ensureFrame(layer, ctx.scene.frame, false);
  const stroke = createStroke(ob.activeMaterial, 0.004);
  stroke.style = { ...defaultStyle(), unit: 'SCENE' };
  stroke.hardness = 0.9;
  const strength = Math.min(1, opts.opacity * 2.2);
  // subdivide each chord (~0.4u steps) so the string sim has vertices to bend
  const SUBDIV_STEP = 0.4;
  for (let ci = 0; ci < chords.length; ci++) {
    const a = pins3d[chords[ci]];
    if (ci === 0) {
      const p = createPoint([...a] as Vec3);
      p.strength = strength;
      stroke.points.push(p);
      continue;
    }
    const prev = pins3d[chords[ci - 1]];
    const len = Math.hypot(a[0] - prev[0], a[1] - prev[1], a[2] - prev[2]);
    const steps = Math.max(1, Math.ceil(len / SUBDIV_STEP));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const p = createPoint([
        prev[0] + (a[0] - prev[0]) * t,
        prev[1] + (a[1] - prev[1]) * t,
        prev[2] + (a[2] - prev[2]) * t,
      ]);
      p.strength = strength;
      stroke.points.push(p);
    }
  }
  frame.strokes.push(stroke);
  ctx.requestRender();
  ctx.refreshUI();
}
