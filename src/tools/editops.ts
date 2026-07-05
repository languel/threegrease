// Edit-mode stroke operators (the Stroke/Point menus in Blender).
import type { GPStroke, Vec3 } from '../core/types';
import {
  activeLayer, activeObject, cloneStroke, clonePoint, ensureFrame, genId,
} from '../core/gpdata';
import {
  simplifyStroke, smoothPoints, subdivideStroke, v3dist, strokeLength,
} from '../core/mathutil';
import type { AppCtx } from './context';
import { forEachEditableStroke, deselectAll } from './select';
import { splitRuns } from './draw';

const strokeSelected = (ctx: AppCtx, s: GPStroke) =>
  s.select || s.points.some((p) => p.select);

export function deleteSelected(ctx: AppCtx, dissolve = false): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s, _layer, frame) => {
    if (!strokeSelected(ctx, s)) return;
    if (ctx.settings.selectMode === 'STROKE' && s.select) {
      frame.strokes.splice(frame.strokes.indexOf(s), 1);
      return;
    }
    if (dissolve) {
      s.points = s.points.filter((p) => !p.select);
      if (s.points.length < 1) frame.strokes.splice(frame.strokes.indexOf(s), 1);
    } else {
      const runs = splitRuns(s, s.points.map((p) => !p.select));
      frame.strokes.splice(frame.strokes.indexOf(s), 1, ...runs.filter((r) => r.points.length > 0));
    }
  });
  ctx.requestRender();
}

export function duplicateSelected(ctx: AppCtx): void {
  ctx.pushUndo();
  const dups: GPStroke[] = [];
  forEachEditableStroke(ctx, (s, _l, frame) => {
    if (!strokeSelected(ctx, s)) return;
    const selPts = s.points.filter((p) => p.select);
    const copy = cloneStroke(s);
    if (selPts.length && selPts.length < s.points.length && ctx.settings.selectMode === 'POINT') {
      copy.points = s.points.filter((p) => p.select).map(clonePoint);
      copy.cyclic = false;
    }
    s.select = false;
    for (const p of s.points) p.select = false;
    copy.select = true;
    for (const p of copy.points) p.select = true;
    frame.strokes.push(copy);
    dups.push(copy);
  });
  ctx.requestRender();
}

export function copySelected(ctx: AppCtx): void {
  ctx.copyBuffer = [];
  forEachEditableStroke(ctx, (s) => {
    if (strokeSelected(ctx, s)) ctx.copyBuffer.push(cloneStroke(s));
  });
}

export function pasteBuffer(ctx: AppCtx): void {
  if (!ctx.copyBuffer.length) return;
  const ob = activeObject(ctx.scene);
  const layer = activeLayer(ob);
  if (!layer || layer.lock) return;
  ctx.pushUndo();
  const frame = ensureFrame(layer, ctx.scene.frame, ctx.settings.autoKey);
  deselectAll(ctx);
  for (const s of ctx.copyBuffer) {
    const copy = cloneStroke(s);
    copy.select = true;
    for (const p of copy.points) p.select = true;
    frame.strokes.push(copy);
  }
  ctx.requestRender();
}

export function splitSelected(ctx: AppCtx): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s, _l, frame) => {
    const selPts = s.points.filter((p) => p.select);
    if (!selPts.length || selPts.length === s.points.length) return;
    const runsSel = splitRuns(s, s.points.map((p) => p.select));
    const runsUnsel = splitRuns(s, s.points.map((p) => !p.select));
    frame.strokes.splice(frame.strokes.indexOf(s), 1, ...runsUnsel, ...runsSel);
  });
  ctx.requestRender();
}

export function joinSelected(ctx: AppCtx): void {
  ctx.pushUndo();
  const groups = new Map<object, GPStroke[]>();
  forEachEditableStroke(ctx, (s, _l, frame) => {
    if (!strokeSelected(ctx, s)) return;
    const arr = groups.get(frame) ?? [];
    arr.push(s);
    groups.set(frame, arr);
  });
  for (const [frameObj, strokes] of groups) {
    if (strokes.length < 2) continue;
    const frame = frameObj as { strokes: GPStroke[] };
    const base = strokes[0];
    // greedily connect nearest endpoints
    let rest = strokes.slice(1);
    while (rest.length) {
      const tail = base.points[base.points.length - 1].co;
      let bestI = 0, bestRev = false, bestD = Infinity;
      rest.forEach((s, i) => {
        const dHead = v3dist(tail, s.points[0].co);
        const dTail = v3dist(tail, s.points[s.points.length - 1].co);
        if (dHead < bestD) { bestD = dHead; bestI = i; bestRev = false; }
        if (dTail < bestD) { bestD = dTail; bestI = i; bestRev = true; }
      });
      const next = rest.splice(bestI, 1)[0];
      const pts = bestRev ? [...next.points].reverse() : next.points;
      base.points.push(...pts);
      frame.strokes.splice(frame.strokes.indexOf(next), 1);
    }
    base.cyclic = false;
  }
  ctx.requestRender();
}

export function mergeByDistance(ctx: AppCtx, threshold = 0.01): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => {
    if (!strokeSelected(ctx, s)) return;
    const out = [s.points[0]];
    for (let i = 1; i < s.points.length; i++) {
      if (v3dist(out[out.length - 1].co, s.points[i].co) >= threshold) out.push(s.points[i]);
    }
    if (out.length >= 1) s.points = out;
  });
  ctx.requestRender();
}

export function subdivideSelected(ctx: AppCtx): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => {
    if (strokeSelected(ctx, s)) subdivideStroke(s, 1, ctx.settings.selectMode === 'POINT');
  });
  ctx.requestRender();
}

export function simplifySelected(ctx: AppCtx, epsilon = 0.01): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => { if (strokeSelected(ctx, s)) simplifyStroke(s, epsilon); });
  ctx.requestRender();
}

export function smoothSelected(ctx: AppCtx, factor = 0.5, iterations = 2): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => {
    if (strokeSelected(ctx, s)) smoothPoints(s.points, factor, iterations, s.cyclic);
  });
  ctx.requestRender();
}

export function toggleCyclic(ctx: AppCtx): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => { if (strokeSelected(ctx, s)) s.cyclic = !s.cyclic; });
  ctx.requestRender();
}

export function switchDirection(ctx: AppCtx): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => { if (strokeSelected(ctx, s)) s.points.reverse(); });
  ctx.requestRender();
}

export function setStartPoint(ctx: AppCtx): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => {
    if (!s.cyclic || !strokeSelected(ctx, s)) return;
    const idx = s.points.findIndex((p) => p.select);
    if (idx > 0) s.points = [...s.points.slice(idx), ...s.points.slice(0, idx)];
  });
  ctx.requestRender();
}

export function normalizeThickness(ctx: AppCtx, value = 1): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => {
    if (strokeSelected(ctx, s)) for (const p of s.points) p.pressure = value;
  });
  ctx.requestRender();
}

export function normalizeOpacity(ctx: AppCtx, value = 1): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => {
    if (strokeSelected(ctx, s)) for (const p of s.points) p.strength = value;
  });
  ctx.requestRender();
}

export type ArrangeOp = 'TOP' | 'UP' | 'DOWN' | 'BOTTOM';
export function arrangeSelected(ctx: AppCtx, op: ArrangeOp): void {
  ctx.pushUndo();
  const ob = activeObject(ctx.scene);
  for (const layer of ob.layers) {
    if (layer.hide || layer.lock) continue;
    for (const frame of layer.frames) {
      const sel = frame.strokes.filter((s) => strokeSelected(ctx, s));
      if (!sel.length) continue;
      const rest = frame.strokes.filter((s) => !strokeSelected(ctx, s));
      if (op === 'TOP') frame.strokes = [...rest, ...sel];
      else if (op === 'BOTTOM') frame.strokes = [...sel, ...rest];
      else {
        const arr = [...frame.strokes];
        const indices = sel.map((s) => arr.indexOf(s)).sort((a, b) => (op === 'UP' ? b - a : a - b));
        for (const i of indices) {
          const j = op === 'UP' ? i + 1 : i - 1;
          if (j < 0 || j >= arr.length || sel.includes(arr[j])) continue;
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        frame.strokes = arr;
      }
    }
  }
  ctx.requestRender();
}

export function moveToLayer(ctx: AppCtx, targetLayerId: number): void {
  ctx.pushUndo();
  const ob = activeObject(ctx.scene);
  const target = ob.layers.find((l) => l.id === targetLayerId);
  if (!target || target.lock) return;
  const moved: GPStroke[] = [];
  forEachEditableStroke(ctx, (s, layer, frame) => {
    if (layer.id === targetLayerId || !strokeSelected(ctx, s)) return;
    frame.strokes.splice(frame.strokes.indexOf(s), 1);
    moved.push(s);
  });
  if (moved.length) {
    const tf = ensureFrame(target, ctx.scene.frame, false);
    tf.strokes.push(...moved);
  }
  ctx.requestRender();
}

export function assignMaterial(ctx: AppCtx, materialIndex: number): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => { if (strokeSelected(ctx, s)) s.materialIndex = materialIndex; });
  ctx.requestRender();
}

export function snapToCursor(ctx: AppCtx): void {
  ctx.pushUndo();
  const cursor = ctx.scene.cursor;
  forEachEditableStroke(ctx, (s) => {
    if (!strokeSelected(ctx, s)) return;
    // move stroke median to cursor
    const med: Vec3 = [0, 0, 0];
    for (const p of s.points) { med[0] += p.co[0]; med[1] += p.co[1]; med[2] += p.co[2]; }
    med[0] /= s.points.length; med[1] /= s.points.length; med[2] /= s.points.length;
    const d: Vec3 = [cursor[0] - med[0], cursor[1] - med[1], cursor[2] - med[2]];
    for (const p of s.points) p.co = [p.co[0] + d[0], p.co[1] + d[1], p.co[2] + d[2]];
  });
  ctx.requestRender();
}

export function snapToGrid(ctx: AppCtx, step = 0.1): void {
  ctx.pushUndo();
  forEachEditableStroke(ctx, (s) => {
    for (const p of s.points) {
      if (!p.select && !(ctx.settings.selectMode === 'STROKE' && s.select)) continue;
      p.co = p.co.map((v) => Math.round(v / step) * step) as Vec3;
    }
  });
  ctx.requestRender();
}
