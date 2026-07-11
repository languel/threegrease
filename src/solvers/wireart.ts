// Main-thread side of the multi-view wire art solver (P6) + assist helpers.
import * as THREE from 'three';
import type { GPCamera, Vec3 } from '../core/types';
import { activeObject, createLayer, createPoint, createStroke, ensureFrame } from '../core/gpdata';
import { defaultStyle } from '../core/brushes';
import { evalCamera } from '../anim/camera';
import type { AppCtx } from '../tools/context';

export interface WireArtOptions {
  grid: number;
  imageSize: number;
  darkThreshold: number;
  coverRadius: number;
  maxVoxels: number;
  boundsSize: number;   // solve cube edge length, centered at origin
}

export const DEFAULT_WIREART: WireArtOptions = {
  grid: 48, imageSize: 128, darkThreshold: 0.35,
  coverRadius: 3, maxVoxels: 240, boundsSize: 4,
};

/** dataURL -> darkness buffer at working resolution. */
export async function targetToGray(
  dataUrl: string, size: number,
): Promise<{ gray: Float32Array; width: number; height: number }> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('bad image'));
    img.src = dataUrl;
  });
  const scale = size / Math.max(img.width, img.height);
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c2d = canvas.getContext('2d')!;
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, w, h);
  c2d.drawImage(img, 0, 0, w, h);
  const data = c2d.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 1 - (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  }
  return { gray, width: w, height: h };
}

/** view-projection matrix for a GPCamera at the current frame. */
export function cameraViewProj(cam: GPCamera, frame: number, aspect: number): Float32Array {
  const pose = evalCamera(cam, frame);
  const persp = new THREE.PerspectiveCamera(pose.fov, aspect, 0.05, 100);
  persp.position.copy(pose.position);
  persp.quaternion.copy(pose.quaternion);
  persp.updateMatrixWorld();
  const vp = new THREE.Matrix4()
    .multiplyMatrices(persp.projectionMatrix, persp.matrixWorldInverse);
  return new Float32Array(vp.elements);
}

/**
 * Solve a wire from the targets of 2-3 cameras; output one stroke into a
 * "WireArt" layer. Cameras without a target are skipped.
 */
export async function runWireArt(
  ctx: AppCtx, opts: WireArtOptions,
  onProgress: (n: number) => void,
): Promise<{ points: number; hull: number } | { error: string }> {
  const cams = ctx.scene.cameras.filter((c) => c.target);
  if (cams.length < 2) return { error: 'need targets on at least 2 cameras' };

  const views: { gray: Float32Array; width: number; height: number; viewProj: Float32Array }[] = [];
  for (const cam of cams.slice(0, 3)) {
    const g = await targetToGray(cam.target!, opts.imageSize);
    views.push({
      gray: g.gray, width: g.width, height: g.height,
      viewProj: cameraViewProj(cam, ctx.scene.frame, g.width / g.height),
    });
  }

  const half = opts.boundsSize / 2;
  const result = await new Promise<{ points: [number, number, number][]; hull: number }>((resolve) => {
    const worker = new Worker(new URL('./wireart.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') { onProgress(e.data.done); return; }
      resolve(e.data);
      worker.terminate();
    };
    worker.postMessage({
      views,
      bounds: { min: [-half, -half, -half + 1], max: [half, half, half + 1] },
      grid: opts.grid,
      darkThreshold: opts.darkThreshold,
      coverRadius: opts.coverRadius,
      maxVoxels: opts.maxVoxels,
      smoothIterations: 3,
    });
  });

  if (!result.points.length) return { error: `empty hull (${result.hull} voxels)` };

  const ob = activeObject(ctx.scene);
  ctx.pushUndo();
  let layer = ob.layers.find((l) => l.name === 'WireArt');
  if (!layer) {
    layer = createLayer('WireArt');
    ob.layers.push(layer);
  }
  const frame = ensureFrame(layer, ctx.scene.frame, false);
  const stroke = createStroke(ob.activeMaterial, 0.02);
  stroke.style = { ...defaultStyle(), unit: 'SCENE' };
  for (const p of result.points) stroke.points.push(createPoint([...p] as Vec3));
  frame.strokes.push(stroke);
  ctx.requestRender();
  ctx.refreshUI();
  return { points: result.points.length, hull: result.hull };
}
