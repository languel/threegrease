import type { GPFrame, GPLayer, GPStroke } from '../core/types';
import { activeLayer, activeObject, createFrame, cloneStroke } from '../core/gpdata';
import { lerp, resamplePoints } from '../core/mathutil';
import type { AppCtx } from '../tools/context';

/**
 * Interpolate a breakdown frame between the two keyframes surrounding
 * `frame` on the active layer (Blender's Interpolate tool). Strokes are
 * matched by order + material; points resampled to a common count.
 */
export function interpolateFrame(ctx: AppCtx, frame: number, factor: number): boolean {
  const ob = activeObject(ctx.scene);
  const layer = activeLayer(ob);
  if (!layer || layer.lock) return false;
  const before = lastKeyBefore(layer, frame);
  const after = firstKeyAfter(layer, frame);
  if (!before || !after) return false;

  ctx.pushUndo();
  const nf = createFrame(frame);
  nf.keyframeType = 'BREAKDOWN';
  nf.strokes = interpolateStrokes(before.strokes, after.strokes, factor);
  // replace any existing key at this exact frame
  const existing = layer.frames.findIndex((f) => f.frameNumber === frame);
  if (existing >= 0) layer.frames.splice(existing, 1);
  layer.frames.push(nf);
  layer.frames.sort((a, b) => a.frameNumber - b.frameNumber);
  ctx.requestRender();
  return true;
}

/** Interpolate Sequence: fill every frame between the surrounding keyframes. */
export function interpolateSequence(ctx: AppCtx): number {
  const ob = activeObject(ctx.scene);
  const layer = activeLayer(ob);
  if (!layer || layer.lock) return 0;
  const before = lastKeyBefore(layer, ctx.scene.frame);
  const after = firstKeyAfter(layer, ctx.scene.frame);
  if (!before || !after) return 0;
  const span = after.frameNumber - before.frameNumber;
  if (span < 2) return 0;
  ctx.pushUndo();
  let made = 0;
  for (let f = before.frameNumber + 1; f < after.frameNumber; f++) {
    const t = (f - before.frameNumber) / span;
    const nf = createFrame(f);
    nf.keyframeType = 'BREAKDOWN';
    nf.strokes = interpolateStrokes(before.strokes, after.strokes, t);
    const existing = layer.frames.findIndex((k) => k.frameNumber === f);
    if (existing >= 0) layer.frames.splice(existing, 1);
    layer.frames.push(nf);
    made++;
  }
  layer.frames.sort((a, b) => a.frameNumber - b.frameNumber);
  ctx.requestRender();
  return made;
}

function lastKeyBefore(layer: GPLayer, frame: number): GPFrame | null {
  let best: GPFrame | null = null;
  for (const f of layer.frames) {
    if (f.frameNumber < frame && (!best || f.frameNumber > best.frameNumber)) best = f;
  }
  return best;
}
function firstKeyAfter(layer: GPLayer, frame: number): GPFrame | null {
  let best: GPFrame | null = null;
  for (const f of layer.frames) {
    if (f.frameNumber > frame && (!best || f.frameNumber < best.frameNumber)) best = f;
  }
  return best;
}

function interpolateStrokes(a: GPStroke[], b: GPStroke[], t: number): GPStroke[] {
  const out: GPStroke[] = [];
  // pair strokes by material in encounter order (Blender matches by index)
  const bPool = [...b];
  for (const sa of a) {
    const bi = bPool.findIndex((s) => s.materialIndex === sa.materialIndex);
    const sb = bi >= 0 ? bPool.splice(bi, 1)[0] : null;
    if (!sb) {
      if (t < 0.5) out.push(cloneStroke(sa));
      continue;
    }
    const count = Math.max(sa.points.length, sb.points.length);
    const pa = resamplePoints(sa.points, count);
    const pb = resamplePoints(sb.points, count);
    const ns = cloneStroke(sa);
    ns.points = pa.map((p, i) => {
      const q = pb[i];
      const np = { ...p, co: [...p.co] as [number, number, number], vertexColor: [...p.vertexColor] as [number, number, number, number] };
      for (let k = 0; k < 3; k++) np.co[k] = lerp(p.co[k], q.co[k], t);
      np.pressure = lerp(p.pressure, q.pressure, t);
      np.strength = lerp(p.strength, q.strength, t);
      np.weight = lerp(p.weight, q.weight, t);
      for (let k = 0; k < 4; k++) np.vertexColor[k] = lerp(p.vertexColor[k], q.vertexColor[k], t);
      return np;
    });
    out.push(ns);
  }
  // strokes only present in b appear past the midpoint
  if (t >= 0.5) for (const sb of bPool) out.push(cloneStroke(sb));
  return out;
}
