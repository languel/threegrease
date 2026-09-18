// Measure tool: rulers over the scene, in real units.
//
// This exists for blockout work. You bring in reference photographs of a
// room, build geometry against them by eye, and then need to know whether
// what you built is actually the size of the room — and, more often, to make
// it so. So the tool does three jobs:
//
//   1. report distances, corner angles, and the area of a closed ring
//   2. serve as the reference for "this segment is really 4.2 m", which
//      rescales the whole scene onto real units — see App.scaleSceneToMeasure
//   3. STAY on what it measures. A point placed on a corner is bound to that
//      corner, so moving the wall moves the dimension with it.
//
// A measurement is an object (`ObjKind` 'MEASURE'): it has a transform, a
// parent, a name and a row in the outliner, and it is edited the way a pen
// is — the same magnet (tools/snapping.ts) places every point. What it does
// NOT have is a mesh: it is drawn on the HUD canvas, which sits above the
// GL canvas, so a dimension is legible over the scene and over whatever the
// scene look has done to it. That is deliberate, not a shortcut — an
// annotation that a bloom pass can smear is not an annotation.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { Tool, ToolEvent } from './toolsys';
import type { GPScene, LengthUnit, TGMeasure, TGMeasurePoint, Vec3 } from '../core/types';
import {
  createMeasure, formatArea, formatLength, measureLocalMatrix, measureWorldPoints,
  pathLength, polygonArea, toWorldLength, type MeasureResolvers,
} from '../core/measures';
import { applyGuide, objectToScreen, setStrokeExclusion } from './projection';
import {
  isObjectSelected, measureResolvers, measureWorldMatrix, worldMatrixOf, worldPointsOf,
  type ObjRef,
} from './objects';
import { snapWorldPoint, SNAP_LABEL, type SnapHit, type SnapKind } from './snapping';

export { formatLength, formatArea, toWorldLength } from '../core/measures';
export { measureResolvers, worldPointsOf } from './objects';

/** grab radius for picking an existing measurement point, px */
const HANDLE_PX = 12;

/** The space a DRAFT's points live in: identity, because a draft has no
 *  object yet. One shared instance rather than a fresh measure per click,
 *  which would burn an id every time the pointer went down. */
/** The "stroke" id a ruler draft holds its sticky placement session under. */
const DRAFT_SESSION = -1;

const DRAFT_HOST: TGMeasure = {
  id: -1, name: '', points: [], visible: true,
  translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parent: null,
};

/** Default ink: a cyan that survives both a dark viewport and white paper. */
export const MEASURE_COLOR: Vec3 = [0.30, 0.82, 0.78];

/** Total length, with the closing leg when the ring is closed. */
export function measureLength(scene: GPScene, m: TGMeasure): number {
  return pathLength(worldPointsOf(scene, m), m.closed);
}

/** Enclosed area, or 0 for an open path. */
export function measureArea(scene: GPScene, m: TGMeasure): number {
  return m.closed ? polygonArea(worldPointsOf(scene, m)) : 0;
}

/**
 * A snap turned into a measurement point.
 *
 * The bind is what makes this more than a snap: the world point is pushed
 * into the TARGET's local space and kept there, so it survives the target
 * being moved, rotated, scaled or rescaled with the scene. Modes that
 * resolve against a plane or a lattice name no target and produce a free
 * point, which is the honest outcome — there is nothing to hold on to.
 */
export function pointFromSnap(
  scene: GPScene, m: TGMeasure, hit: SnapHit, bindEnabled: boolean,
): TGMeasurePoint {
  const local = new THREE.Vector3().copy(hit.point)
    .applyMatrix4(measureWorldMatrix(scene, m).invert());
  const pos: Vec3 = [local.x, local.y, local.z];
  if (!bindEnabled || !hit.ref) return { pos, bind: null };

  if (hit.ref.kind === 'ACTOR') {
    // a body deforms, so the point rides the nearest JOINT rather than the
    // object transform — an object matrix would leave a dimension on a
    // shoulder floating where the shoulder used to be
    const near = nearestJoint(scene, hit.ref.id, hit.point);
    if (near) {
      return { pos, bind: { target: hit.ref, kind: hit.kind, local: near.offset, joint: near.name } };
    }
  }
  const inv = worldMatrixOf(scene, hit.ref).invert();
  const l = hit.point.clone().applyMatrix4(inv);
  return { pos, bind: { target: hit.ref, kind: hit.kind, local: [l.x, l.y, l.z], joint: null } };
}

function nearestJoint(
  scene: GPScene, actorId: number, world: THREE.Vector3,
): { name: string; offset: Vec3 } | null {
  const a = scene.actors.find((x) => x.id === actorId);
  if (!a || !a.pose.length) return null;
  const mat = worldMatrixOf(scene, { kind: 'ACTOR', id: actorId });
  const rot = new THREE.Matrix4().extractRotation(mat);
  let best: { name: string; offset: Vec3; d: number } | null = null;
  for (let i = 0; i < a.joints.length; i++) {
    const p = a.pose[i];
    if (!p) continue;
    const jw = new THREE.Vector3(...p).applyMatrix4(mat);
    const d = jw.distanceToSquared(world);
    if (!best || d < best.d) {
      const off = world.clone().sub(jw).applyMatrix4(new THREE.Matrix4().copy(rot).invert());
      best = { name: a.joints[i].name, offset: [off.x, off.y, off.z], d };
    }
  }
  return best ? { name: best.name, offset: best.offset } : null;
}

export class MeasureTool implements Tool {
  id = 'measure';
  cursor = 'crosshair';

  /** the ruler being drawn, before it is committed to the scene */
  private draft: TGMeasurePoint[] = [];
  /** the measure a draft is EXTENDING, if it is not a new one */
  private extending: number | null = null;
  /** live pointer position while drafting, so the last leg rubber-bands */
  private preview: THREE.Vector3 | null = null;
  private previewKind: SnapKind = 'FREE';
  private previewRef: ObjRef | null = null;
  /** dragging an existing point: [measureId, pointIndex] */
  private drag: { id: number; index: number } | null = null;
  /** point under the pointer, for the delete key and the hover ring */
  private hover: { id: number; index: number } | null = null;

  /** Existing measurement point under the pointer, if any. */
  private pick(ctx: AppCtx, x: number, y: number): { id: number; index: number } | null {
    let best: { id: number; index: number } | null = null;
    let bestD = HANDLE_PX * HANDLE_PX;
    for (const m of ctx.scene.measures) {
      if (!m.visible || m.locked || m.lock) continue;
      const pts = worldPointsOf(ctx.scene, m);
      for (let i = 0; i < pts.length; i++) {
        const s = objectToScreen(ctx, [pts[i].x, pts[i].y, pts[i].z]);
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < bestD) { bestD = d; best = { id: m.id, index: i }; }
      }
    }
    return best;
  }

  /**
   * The pointer after the drawing GUIDE has had its say — parallel,
   * circular, radial, grid, isometric — measured from the previous point of
   * the ruler being drafted, exactly as a stroke's guide is measured from
   * where the stroke began. Returned as client coordinates, which is what
   * the magnet takes.
   */
  private guided(ctx: AppCtx, e: ToolEvent): { clientX: number; clientY: number } {
    if (ctx.settings.guide.type === 'NONE') return { clientX: e.clientX, clientY: e.clientY };
    const rect = ctx.canvas.getBoundingClientRect();
    const toScreen = (p: THREE.Vector3) => objectToScreen(ctx, [p.x, p.y, p.z]);
    let start: THREE.Vector2 | null = null;
    if (this.draft.length) {
      const pts = measureWorldPoints({ ...DRAFT_HOST, points: this.draft }, measureResolvers(ctx.scene));
      start = toScreen(pts[pts.length - 1]);
    }
    const c = ctx.scene.cursor;
    const center = objectToScreen(ctx, [c[0], c[1], c[2]]);
    const g = applyGuide(ctx, new THREE.Vector2(e.x, e.y), start, center);
    return { clientX: g.x + rect.left, clientY: g.y + rect.top };
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    // grab an existing point first — adjusting a ruler you already placed is
    // far more common than starting another one on top of it
    const hit = this.pick(ctx, e.x, e.y);
    if (hit && !this.draft.length) {
      ctx.pushUndo();
      this.drag = hit;
      return;
    }
    const g = this.guided(ctx, e);
    const snapped = snapWorldPoint(ctx, g.clientX, g.clientY);
    if (!snapped) return;
    // Shift with a measurement selected CONTINUES it rather than starting
    // another: a dimension chain is one object, and having to re-place the
    // shared corner by hand is both fiddly and wrong (the two points then
    // drift apart the moment anything moves).
    if (!this.draft.length && e.shift) {
      const sel = ctx.scene.measures.find((m) => isObjectSelected(ctx.scene, { kind: 'MEASURE', id: m.id }) && !m.locked);
      if (sel) {
        ctx.pushUndo();
        sel.points.push(pointFromSnap(ctx.scene, sel, snapped, ctx.settings.snap.enabled));
        ctx.refreshUI();
        return;
      }
    }
    const host = this.draftHost(ctx);
    this.draft.push(pointFromSnap(ctx.scene, host, snapped, ctx.settings.snap.enabled));
    if (this.draft.length === 1) {
      // A ruler gets the same sticky session a stroke does. The planes that
      // are captured from a FIRST point — Up from Ground, View at Origin, the
      // two perpendicular placements — only engage while one is open, so
      // without it every point of a ruler landed back on the floor instead
      // of rising from where it began. -1 names no real stroke, so nothing
      // is excluded from snapping.
      setStrokeExclusion(DRAFT_SESSION);
      const again = snapWorldPoint(ctx, g.clientX, g.clientY);
      if (again) this.draft[0] = pointFromSnap(ctx.scene, host, again, ctx.settings.snap.enabled);
    }
  }

  /** A draft has no measure of its own yet, so its points are expressed
   *  against an identity one — which is what `createMeasure` then makes. */
  private draftHost(ctx: AppCtx): TGMeasure {
    const existing = this.extending !== null
      ? ctx.scene.measures.find((m) => m.id === this.extending) : undefined;
    return existing ?? DRAFT_HOST;
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    this.hover = this.draft.length ? null : this.pick(ctx, e.x, e.y);
    const dragged = this.drag
      ? worldPointsOf(ctx.scene, ctx.scene.measures.find((m) => m.id === this.drag!.id)!)[this.drag.index]
      : undefined;
    const g = this.drag ? { clientX: e.clientX, clientY: e.clientY } : this.guided(ctx, e);
    const snapped = snapWorldPoint(ctx, g.clientX, g.clientY, dragged);
    if (!snapped) return;
    this.preview = snapped.point;
    this.previewKind = snapped.kind;
    this.previewRef = snapped.ref ?? null;
    if (this.drag) {
      const m = ctx.scene.measures.find((x) => x.id === this.drag!.id);
      if (m) {
        // re-placing a point re-binds it: it belongs to whatever it landed
        // on now, not to whatever it used to be attached to
        m.points[this.drag.index] = pointFromSnap(ctx.scene, m, snapped, ctx.settings.snap.enabled);
      }
    }
  }

  onUp(ctx: AppCtx, _e: ToolEvent): void {
    if (this.drag) ctx.refreshUI();
    this.drag = null;
  }

  onKey(ctx: AppCtx, key: string): boolean {
    if (key === 'Escape') { this.cancel(ctx); return true; }
    if (key === 'Enter') { this.commit(ctx); return true; }
    // Backspace drops the last point rather than the whole ruler — a
    // three-point measurement is a lot of aiming to throw away over one miss
    if (key === 'Backspace' && this.draft.length) {
      this.draft.pop();
      return true;
    }
    // ...and with nothing being drafted it deletes the point under the
    // pointer, so a measurement can be corrected instead of redone
    if ((key === 'Backspace' || key === 'Delete' || key === 'x') && this.hover) {
      const m = ctx.scene.measures.find((x) => x.id === this.hover!.id);
      if (m && m.points.length > 2) {
        ctx.pushUndo();
        m.points.splice(this.hover.index, 1);
        this.hover = null;
        ctx.refreshUI();
        return true;
      }
    }
    if (key === 'c') {
      const sel = ctx.scene.measures.find((m) => isObjectSelected(ctx.scene, { kind: 'MEASURE', id: m.id }));
      if (sel && sel.points.length > 2) {
        ctx.pushUndo();
        sel.closed = !sel.closed;
        ctx.refreshUI();
        return true;
      }
    }
    return false;
  }

  onCancel(ctx: AppCtx): void { this.cancel(ctx); }

  private cancel(ctx: AppCtx): void {
    if (this.draft.length) setStrokeExclusion(null);
    this.draft = [];
    this.extending = null;
    this.drag = null;
    ctx.requestRender();
  }

  /** Commit the draft. A single point is not a measurement, so it is
   *  discarded rather than saved as a degenerate one. */
  private commit(ctx: AppCtx): void {
    if (this.draft.length >= 2) {
      ctx.pushUndo();
      const m = createMeasure(ctx.scene.measures, this.draft);
      recentre(m);
      for (const other of ctx.scene.measures) other.select = false;
      m.select = true;
      ctx.scene.measures.push(m);
      ctx.refreshUI();
    }
    this.draft = [];
    this.extending = null;
    setStrokeExclusion(null);
  }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    drawMeasures(ctx, hud, this);
  }

  /** State the shared overlay needs. Kept as one accessor so the drawing
   *  routine can be used with no tool active at all (see drawMeasures). */
  liveDraft(): {
    draft: TGMeasurePoint[]; preview: THREE.Vector3 | null;
    kind: SnapKind; hover: { id: number; index: number } | null;
  } {
    return { draft: this.draft, preview: this.preview, kind: this.previewKind, hover: this.hover };
  }
}

/**
 * Draw every measurement, and the one being drafted.
 *
 * Exported and tool-independent on purpose: a dimension you can only see
 * while the measure tool is active is not an annotation of the scene, it is
 * a mode. The App draws these from its own HUD pass, and the tool only adds
 * the rubber-band leg on top.
 */
export function drawMeasures(
  ctx: AppCtx, hud: CanvasRenderingContext2D, tool?: MeasureTool,
): void {
  const unit = ctx.settings.lengthUnit;
  hud.save();
  hud.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  hud.lineWidth = 1.5;
  hud.textBaseline = 'middle';

  const live = tool?.liveDraft();
  for (const m of ctx.scene.measures) {
    if (!m.visible) continue;
    const selected = isObjectSelected(ctx.scene, { kind: 'MEASURE', id: m.id });
    const color = m.locked || m.lock ? '#7f8c9a' : rgbCss(m.color ?? MEASURE_COLOR);
    drawRuler(ctx, hud, worldPointsOf(ctx.scene, m), m, unit, color, false, selected,
      live?.hover?.id === m.id ? live.hover.index : -1);
  }

  if (live?.draft.length) {
    const host: TGMeasure = { ...DRAFT_HOST, points: live.draft };
    const pts = measureWorldPoints(host, measureResolvers(ctx.scene));
    if (live.preview) pts.push(live.preview);
    drawRuler(ctx, hud, pts, host, unit, '#ffc84d', true, false, -1);
  }

  // name what the pointer is currently catching, so a snap is never a
  // silent surprise
  if (live?.preview && (live.draft.length || tool)) {
    const label = SNAP_LABEL[live.kind];
    if (label) {
      const s = objectToScreen(ctx, [live.preview.x, live.preview.y, live.preview.z]);
      hud.fillStyle = '#ffc84d';
      hud.fillText(label, s.x + 12, s.y + 14);
    }
  }
  hud.restore();
}

/**
 * Move a measurement's origin onto its own centre of gravity.
 *
 * A ruler built from world points would otherwise have its origin at the
 * world origin, and the transform widget would appear metres away from the
 * thing you just selected — Blender's own "origin away from geometry", but
 * arrived at by accident rather than by choice. The points are shifted by
 * the same amount they lose, so nothing on screen moves.
 */
function recentre(m: TGMeasure): void {
  if (!m.points.length) return;
  const c: Vec3 = [0, 0, 0];
  for (const p of m.points) for (let i = 0; i < 3; i++) c[i] += p.pos[i] / m.points.length;
  m.translation = c;
  for (const p of m.points) p.pos = [p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]];
}

function rgbCss(c: Vec3): string {
  const b = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${b(c[0])},${b(c[1])},${b(c[2])})`;
}

function drawRuler(
  ctx: AppCtx, hud: CanvasRenderingContext2D, pts: THREE.Vector3[], m: TGMeasure,
  unit: LengthUnit, color: string, dashed: boolean, selected: boolean, hoverIndex: number,
): void {
  if (pts.length < 2) {
    if (pts.length === 1) {
      const s = objectToScreen(ctx, [pts[0].x, pts[0].y, pts[0].z]);
      hud.strokeStyle = color;
      hud.beginPath();
      hud.arc(s.x, s.y, 4, 0, Math.PI * 2);
      hud.stroke();
    }
    return;
  }
  const screen = pts.map((p) => objectToScreen(ctx, [p.x, p.y, p.z]));
  const closed = !!m.closed && pts.length > 2;

  // a selected ruler wears a soft halo rather than a different colour, so
  // its measurements still read as the same measurements
  if (selected) {
    hud.strokeStyle = 'rgba(255,255,255,0.35)';
    hud.lineWidth = 4.5;
    strokePath(hud, screen, closed);
    hud.lineWidth = 1.5;
  }

  hud.strokeStyle = color;
  hud.setLineDash(dashed ? [5, 4] : []);
  strokePath(hud, screen, closed);
  hud.setLineDash([]);

  // a BOUND point is filled, a free one hollow — the difference between a
  // dimension that will follow the wall and one that will be left behind is
  // worth being able to see at a glance
  for (let i = 0; i < screen.length; i++) {
    const bound = !!m.points[i]?.bind;
    hud.beginPath();
    hud.arc(screen[i].x, screen[i].y, i === hoverIndex ? 5.5 : 3.5, 0, Math.PI * 2);
    if (bound) { hud.fillStyle = color; hud.fill(); } else { hud.stroke(); }
  }

  // per-segment length, written along the segment's midpoint
  const legs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < legs; i++) {
    const j = (i + 1) % pts.length;
    const mid = { x: (screen[i].x + screen[j].x) / 2, y: (screen[i].y + screen[j].y) / 2 };
    label(hud, formatLength(pts[i].distanceTo(pts[j]), unit), mid.x, mid.y - 9, color);
  }

  // interior angles — squaring a room off photographs is mostly a question
  // of whether the corners are actually 90
  if (m.angles !== false) {
    const corners = closed ? pts.length : pts.length - 1;
    for (let i = closed ? 0 : 1; i < corners; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const here = pts[i];
      const next = pts[(i + 1) % pts.length];
      const u = prev.clone().sub(here);
      const v = next.clone().sub(here);
      if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) continue;
      const deg = THREE.MathUtils.radToDeg(u.angleTo(v));
      label(hud, `${deg.toFixed(1)}°`, screen[i].x + 10, screen[i].y - 10, color);
    }
  }

  // running total, once it is actually a path rather than one segment
  if (pts.length > 2) {
    const total = pathLength(pts, closed);
    const last = screen[screen.length - 1];
    const text = closed
      ? `⬡ ${formatArea(polygonArea(pts), unit)} · ${formatLength(total, unit)}`
      : `Σ ${formatLength(total, unit)}`;
    label(hud, text, last.x + 10, last.y + 12, color);
  }
}

function strokePath(
  hud: CanvasRenderingContext2D, screen: { x: number; y: number }[], closed: boolean,
): void {
  hud.beginPath();
  hud.moveTo(screen[0].x, screen[0].y);
  for (let i = 1; i < screen.length; i++) hud.lineTo(screen[i].x, screen[i].y);
  if (closed) hud.closePath();
  hud.stroke();
}

/** Text with a dark plate behind it, so a measurement stays readable over a
 *  bright reference photograph as well as over the dark viewport. */
function label(
  hud: CanvasRenderingContext2D, text: string, x: number, y: number, color: string,
): void {
  const w = hud.measureText(text).width;
  hud.fillStyle = 'rgba(12,14,18,0.72)';
  hud.fillRect(x - w / 2 - 4, y - 8, w + 8, 16);
  hud.fillStyle = color;
  hud.textAlign = 'center';
  hud.fillText(text, x, y);
  hud.textAlign = 'left';
}
