// Edit-mode stroke operators (the Stroke/Point menus in Blender).
import type { GPLayer, GPStroke, Vec3 } from '../core/types';
import {
  activeLayer, activeObject, cloneStroke, clonePoint, createFrame, createLayer,
  createObject, ensureFrame, genId,
} from '../core/gpdata';
import {
  simplifyStroke, smoothPoints, subdivideStroke, v3dist, strokeLength,
} from '../core/mathutil';
import type { AppCtx } from './context';
import { forEachEditableStroke, deselectAll, selectedPoints } from './select';
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

/**
 * Blender GP "Separate" (P): move the selection out into a brand new GP
 * object — same world transform and a cloned material list (so
 * materialIndex stays valid), one new layer per source layer touched.
 * Point-mode partial selections split first (like splitSelected) so only
 * the selected run leaves; the rest stays behind. Returns strokes moved.
 */
export function separateSelected(ctx: AppCtx): number {
  const ob = activeObject(ctx.scene);
  const newOb = createObject(`${ob.name} split`);
  newOb.translation = [...ob.translation];
  newOb.rotation = [...ob.rotation];
  newOb.scale = [...ob.scale];
  newOb.materials = ob.materials.map((m) => ({ ...m }));
  newOb.activeMaterial = ob.activeMaterial;
  newOb.layers = [];
  const layerMap = new Map<number, GPLayer>();
  let count = 0;

  const placeInNewObject = (stroke: GPStroke, oldLayer: GPLayer, frameNumber: number) => {
    let newLayer = layerMap.get(oldLayer.id);
    if (!newLayer) {
      newLayer = createLayer(oldLayer.name);
      layerMap.set(oldLayer.id, newLayer);
      newOb.layers.push(newLayer);
    }
    let newFrame = newLayer.frames.find((f) => f.frameNumber === frameNumber);
    if (!newFrame) { newFrame = createFrame(frameNumber); newLayer.frames.push(newFrame); }
    stroke.select = false;
    for (const p of stroke.points) p.select = false;
    newFrame.strokes.push(stroke);
    count++;
  };

  ctx.pushUndo();
  forEachEditableStroke(ctx, (s, layer, frame) => {
    if (!strokeSelected(ctx, s)) return;
    const selPts = s.points.filter((p) => p.select);
    if (ctx.settings.selectMode === 'POINT' && selPts.length && selPts.length < s.points.length) {
      const runsSel = splitRuns(s, s.points.map((p) => p.select));
      const runsUnsel = splitRuns(s, s.points.map((p) => !p.select));
      frame.strokes.splice(frame.strokes.indexOf(s), 1, ...runsUnsel);
      for (const run of runsSel) placeInNewObject(run, layer, frame.frameNumber);
      return;
    }
    frame.strokes.splice(frame.strokes.indexOf(s), 1);
    placeInNewObject(s, layer, frame.frameNumber);
  });

  if (count > 0) {
    newOb.activeLayerId = newOb.layers[0].id;
    const i = ctx.scene.objects.indexOf(ob);
    ctx.scene.objects.splice(i + 1, 0, newOb);
  }
  ctx.requestRender();
  return count;
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

function pointsMedian(pts: { s: GPStroke; index: number }[]): Vec3 {
  const m: Vec3 = [0, 0, 0];
  for (const { s, index } of pts) {
    const c = s.points[index].co;
    m[0] += c[0]; m[1] += c[1]; m[2] += c[2];
  }
  const n = pts.length || 1;
  return [m[0] / n, m[1] / n, m[2] / n];
}

/** Last-touched selected point, for "Selection/Cursor to Active" — there's
 *  no dedicated active-point tracking, so the last one iteration order
 *  reaches stands in (matches how object-mode active/lastPicked degrades
 *  to "the last one touched"). */
function activePointCo(ctx: AppCtx): Vec3 | null {
  const pts = selectedPoints(ctx);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  return last.s.points[last.index].co;
}

/** Blender "Selection to Cursor": every selected point collapses onto the
 *  cursor. `keepOffset` moves each stroke's selection as a rigid group
 *  instead (that stroke's selected-point median lands on the cursor,
 *  relative offsets preserved) — this was this function's ONLY behavior
 *  before the Blender-parity Snap submenu, now the explicit opt-in. */
export function snapToCursor(ctx: AppCtx, keepOffset = false): void {
  const pts = selectedPoints(ctx);
  if (!pts.length) return;
  ctx.pushUndo();
  const cursor = ctx.scene.cursor;
  if (keepOffset) {
    forEachEditableStroke(ctx, (s) => {
      if (!strokeSelected(ctx, s)) return;
      const med: Vec3 = [0, 0, 0];
      for (const p of s.points) { med[0] += p.co[0]; med[1] += p.co[1]; med[2] += p.co[2]; }
      med[0] /= s.points.length; med[1] /= s.points.length; med[2] /= s.points.length;
      const d: Vec3 = [cursor[0] - med[0], cursor[1] - med[1], cursor[2] - med[2]];
      for (const p of s.points) p.co = [p.co[0] + d[0], p.co[1] + d[1], p.co[2] + d[2]];
    });
  } else {
    for (const { s, index } of pts) s.points[index].co = [...cursor] as Vec3;
  }
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

/** Every OTHER selected point collapses onto the active (last-touched) point. */
export function snapSelectionToActive(ctx: AppCtx): void {
  const pts = selectedPoints(ctx);
  const active = activePointCo(ctx);
  if (!pts.length || !active) return;
  ctx.pushUndo();
  for (const { s, index } of pts) s.points[index].co = [...active] as Vec3;
  ctx.requestRender();
}

export function snapCursorToSelection(ctx: AppCtx): void {
  const pts = selectedPoints(ctx);
  if (!pts.length) return;
  ctx.scene.cursor = pointsMedian(pts);
  ctx.requestRender();
}

export function snapCursorToWorldOrigin(ctx: AppCtx): void {
  ctx.scene.cursor = [0, 0, 0];
  ctx.requestRender();
}

export function snapCursorToGrid(ctx: AppCtx, step = 0.1): void {
  ctx.scene.cursor = ctx.scene.cursor.map((v) => Math.round(v / step) * step) as Vec3;
  ctx.requestRender();
}

export function snapCursorToActive(ctx: AppCtx): void {
  const active = activePointCo(ctx);
  if (!active) return;
  ctx.scene.cursor = [...active] as Vec3;
  ctx.requestRender();
}

/** GP-specific: snap the SELECTED points of each selected stroke to that
 *  same stroke's own first/last point (per-stroke, so a multi-stroke
 *  selection snaps each stroke to its own endpoint rather than one global
 *  point). Whole-stroke (STROKE select mode) selections collapse entirely. */
export function snapSelectionToStrokeEnd(ctx: AppCtx, which: 'start' | 'end'): void {
  ctx.pushUndo();
  let any = false;
  forEachEditableStroke(ctx, (s) => {
    if (!strokeSelected(ctx, s) || !s.points.length) return;
    const target = which === 'start' ? s.points[0].co : s.points[s.points.length - 1].co;
    for (const p of s.points) {
      if (p.select || ctx.settings.selectMode === 'STROKE') { p.co = [...target] as Vec3; any = true; }
    }
  });
  if (any) ctx.requestRender();
}

/** Cursor to the first selected stroke's start/end point. */
export function snapCursorToStrokeEnd(ctx: AppCtx, which: 'start' | 'end'): void {
  let target: Vec3 | null = null;
  forEachEditableStroke(ctx, (s) => {
    if (target || !strokeSelected(ctx, s) || !s.points.length) return;
    target = which === 'start' ? s.points[0].co : s.points[s.points.length - 1].co;
  });
  if (!target) return;
  ctx.scene.cursor = [...target] as Vec3;
  ctx.requestRender();
}

/**
 * Separate ▸ By Material: one GP object per material slot the active object
 * actually uses, across every layer and keyframe. The strokes of the lowest
 * slot stay where they are. Each new object is named after its material,
 * keeps the full material list (so `materialIndex` stays valid) and the
 * source's transform. Returns objects created.
 */
export function separateByMaterial(ctx: AppCtx): number {
  const ob = activeObject(ctx.scene);
  const used = new Set<number>();
  for (const l of ob.layers) for (const f of l.frames) for (const s of f.strokes) used.add(s.materialIndex);
  const slots = [...used].sort((a, b) => a - b);
  if (slots.length < 2) return 0;
  ctx.pushUndo();
  let at = ctx.scene.objects.indexOf(ob);
  for (const slot of slots.slice(1)) {
    const newOb = createObject(`${ob.name} ${ob.materials[slot]?.name ?? `slot ${slot}`}`);
    newOb.translation = [...ob.translation];
    newOb.rotation = [...ob.rotation];
    newOb.scale = [...ob.scale];
    newOb.parent = ob.parent ? { ...ob.parent } : null;
    newOb.materials = ob.materials.map((m) => ({ ...m }));
    newOb.activeMaterial = slot;
    newOb.layers = [];
    for (const layer of ob.layers) {
      const nl = createLayer(layer.name);
      for (const frame of layer.frames) {
        const moving = frame.strokes.filter((s) => s.materialIndex === slot);
        if (!moving.length) continue;
        frame.strokes = frame.strokes.filter((s) => s.materialIndex !== slot);
        const nf = createFrame(frame.frameNumber);
        nf.strokes = moving;
        nl.frames.push(nf);
      }
      if (nl.frames.length) newOb.layers.push(nl);
    }
    if (!newOb.layers.length) continue;
    newOb.activeLayerId = newOb.layers[0].id;
    ctx.scene.objects.splice(++at, 0, newOb);
  }
  ctx.requestRender();
  return slots.length - 1;
}
