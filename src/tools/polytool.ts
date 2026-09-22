// Topology Pen: the context-sensitive editable-mesh tool (POLY mode),
// matching PolyQuilt's operations table — the op depends on the element
// under the pointer, whether the press was a click / drag / long-press
// (hold) / hold+drag, and the active construction state:
//
//   target   | click                | drag            | hold        | hold+drag
//   ---------+----------------------+-----------------+-------------+--------------------
//   empty    | vertex -> face fill  | —               | (arms)      | knife
//   vertex   | face fill / finalize | move (merge)    | delete/     | extrude edge
//            |  on the last vertex  |  on release     |  dissolve   |  from vertex
//   edge     | insert vertex -> fill| move edge       | delete/     | boundary: quad
//            |  (splits the edge)   |                 |  dissolve   |  extrude; interior:
//            |                      |                 |             |  loop cut (quads)
//   face     | vertex on face ->    | move face       | delete face | —
//            |  fill                |                 |             |
//
//   Shift+click = AutoQuad (infer the fillable patch from nearby open
//   edges) · Cmd+click = toggle element selection (Delete/X removes,
//   M welds the selected vertices into ONE at their centre, Shift+M welds
//   the selection's close PAIRS independently — the two ways to rejoin
//   parts a base built from several chains left merely coincident) ·
//   Ctrl while dragging = disable source snapping · Enter finishes an
//   open chain · Escape cancels the modal op with exact restoration.
//
// Dissolve semantics (PolyQuilt "fusion if shared faces exist, else
// deletion"): edge with two faces melts into one n-gon; 2-edge pass-
// through vertex fuses its edges; everything else deletes with the
// documented cascades. Undo grouping: modal ops snapshot ONLY the poly
// mesh at start, mutate live for preview, and on commit restore-the-
// before, pushUndo, re-apply-the-after — one undo step per operation,
// none on cancel (docs/design/polymesh.md).
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { TGPolyMesh, Vec3 } from '../core/types';
import type { Tool, ToolEvent } from './toolsys';
import { applyGuide, drawingPlane, perpendicularPlaneAt } from './projection';
import { snapIncrement } from './context';
import { worldMatrixOf } from './objects';
import {
  addEdge, addFace, addVertex, cleanupDegenerateFaces, dissolveEdge, dissolveVertex,
  edgeFaceCount, getEdge, getFace, getVertex, isBoundaryEdge, mergeVertices, pokeFace,
  removeEdge, removeFace, removeFaceCascade, removeVertex, splitEdge, splitFace, touchPolyMesh,
} from '../core/polymesh';
import { createPolyMesh } from '../core/polymesh';
import { deselectAllObjects } from './objects';
import { bindingFor, pickConstruction, pickPolyEdge, pickPolyFace, pickPolyVertex, type ConstructionHit } from './polypick';
import { autoQuad, walkQuadLoop, type LoopCutPlan } from './polyops';
import { clearPolyOverlay, polyOverlay } from '../render/polymesh';

const VERTEX_PX = 14;
const EDGE_PX = 10;
const DRAG_PX = 5;
const HOLD_MS = 450;          // long-press threshold (PolyQuilt-style hold)
const ENDPOINT_SNAP_T = 0.12; // edge-split clicks this close to an end reuse it
/** grab an edge inside its middle band -> extrude/loop-cut; outside -> move */
const EDGE_CENTER_T = [0.35, 0.65] as const;

/** Tool flavors, mirroring the Blender trio PolyQuilt ships alongside:
 *  QUILT = the full context pen; BUILD = Blender's Poly Build mapping
 *  (Shift+click deletes, drag on a boundary edge extrudes from anywhere);
 *  PATCH = Quad Patch (click infers/fills the patch under the cursor). */
export type PolyToolVariant = 'QUILT' | 'BUILD' | 'PATCH';

function takeSnapshot(pm: TGPolyMesh): string {
  return JSON.stringify({ vertices: pm.vertices, edges: pm.edges, faces: pm.faces, nextElemId: pm.nextElemId });
}
function restoreSnapshot(pm: TGPolyMesh, snap: string): void {
  const s = JSON.parse(snap) as Pick<TGPolyMesh, 'vertices' | 'edges' | 'faces' | 'nextElemId'>;
  pm.vertices = s.vertices;
  pm.edges = s.edges;
  pm.faces = s.faces;
  pm.nextElemId = s.nextElemId;
  touchPolyMesh(pm);
}

type ToolState =
  | { kind: 'IDLE' }
  | { kind: 'BUILD'; meshId: number; vertexIds: number[]; before: string; plane: THREE.Plane }
  | { kind: 'MOVE'; meshId: number; vertexId: number; before: string; moved: boolean }
  | {
      kind: 'MOVE_ELEMS'; meshId: number; vertexIds: number[]; before: string;
      plane: THREE.Plane; startWorld: THREE.Vector3;
    }
  | {
      kind: 'EXTRUDE'; meshId: number; srcEdgeId: number; newVa: number; newVb: number;
      before: string; plane: THREE.Plane; startWorld: THREE.Vector3;
    }
  | { kind: 'VERT_EXTRUDE'; meshId: number; fromId: number; newId: number; before: string }
  | {
      kind: 'LOOPCUT'; meshId: number; plan: LoopCutPlan; before: string;
      hoverEdgeId: number; t: number;
    }
  | { kind: 'KNIFE'; meshId: number; before: string; a: THREE.Vector2; b: THREE.Vector2 };

/** Pointer press being disambiguated into click / drag / hold / hold+drag. */
interface Pending {
  x: number; y: number;
  downAt: number;
  hit: ConstructionHit;
  dragged: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Cmd, alone — select-toggle's own modifier, distinct from `ctrl` (Ctrl
   *  OR Cmd), which already means "disable snapping" for this tool. */
  meta: boolean;
}

/** A drag's axis lock, G-style: along one world axis, or (Shift) in the
 *  plane square to it. */
type AxisLock = { kind: 'AXIS' | 'PLANE'; axis: 'x' | 'y' | 'z' };
const AXIS_DIR: Record<'x' | 'y' | 'z', THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1),
};
const AXIS_COLOR: Record<'x' | 'y' | 'z', string> = {
  x: 'rgba(255,82,82,0.9)', y: 'rgba(130,210,60,0.9)', z: 'rgba(80,140,255,0.9)',
};

export class PolyPenTool implements Tool {
  id: string;
  cursor = 'crosshair';
  private variant: PolyToolVariant;
  private state: ToolState = { kind: 'IDLE' };
  private pending: Pending | null = null;
  /** last hovered edge (for intent feedback + center-band classification) */
  private edgeHover: { edgeId: number; t: number; boundary: boolean } | null = null;
  /**
   * The axis lock of the drag in progress — the same X / Y / Z (and Shift+
   * for the plane) that G uses, pressed mid-drag; pressing the same one
   * again frees it. Under Plane: Up from Ground an edge or face drag STARTS
   * locked to the up axis, since lifting a plan straight up into walls is
   * what that plane is for.
   */
  private axisLock: AxisLock | null = null;
  /** world point the lock is measured from (the dragged element at rest) */
  private lockOrigin: THREE.Vector3 | null = null;
  /** the last pointer event, to re-run the drag when the lock changes */
  private lastEvent: ToolEvent | null = null;

  constructor(id = 'polypen', variant: PolyToolVariant = 'QUILT') {
    this.id = id;
    this.variant = variant;
  }

  // ---- helpers -------------------------------------------------------------

  private editMesh(ctx: AppCtx): TGPolyMesh | null {
    return ctx.scene.polyMeshes.find((p) => p.id === polyOverlay.editMeshId) ?? null;
  }

  /** The quilt needs a target mesh. Outside POLY mode (the tools also live
   *  in the EDIT toolbar, using the pencil/objects as snap basis) pick the
   *  selected/first editable mesh, or create one on first use. */
  private ensureEditMesh(ctx: AppCtx): TGPolyMesh | null {
    let pm = this.editMesh(ctx);
    if (pm) return pm;
    const scene = ctx.scene;
    pm = scene.polyMeshes.find((p) => p.select) ?? scene.polyMeshes[0] ?? null;
    if (!pm) {
      ctx.pushUndo();
      pm = createPolyMesh(Date.now() % 1e9, `PolyMesh ${scene.polyMeshes.length + 1}`, [...scene.cursor]);
      scene.polyMeshes.push(pm);
      deselectAllObjects(scene);
      pm.select = true;
      ctx.refreshUI();
    }
    polyOverlay.editMeshId = pm.id;
    return pm;
  }

  private worldToLocal(ctx: AppCtx, pm: TGPolyMesh, world: Vec3): Vec3 {
    const inv = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id }).invert();
    const v = new THREE.Vector3(...world).applyMatrix4(inv);
    return [v.x, v.y, v.z];
  }

  private localToWorld(ctx: AppCtx, pm: TGPolyMesh, co: Vec3): Vec3 {
    const v = new THREE.Vector3(...co)
      .applyMatrix4(worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id }));
    return [v.x, v.y, v.z];
  }

  /** One coherent undo step: before -> pushUndo -> after. */
  private commit(ctx: AppCtx, pm: TGPolyMesh, before: string): void {
    const after = takeSnapshot(pm);
    restoreSnapshot(pm, before);
    ctx.pushUndo();
    restoreSnapshot(pm, after);
    ctx.refreshUI();
  }

  private pick(ctx: AppCtx, e: ToolEvent, excludeVertexIds?: number[]): ConstructionHit {
    const plane = this.state.kind === 'BUILD' ? this.state.plane : null;
    // same Guide options as the pencil: constrain the pointer through the
    // active guide (circular/radial/parallel/grid/iso) before picking —
    // center anchored at the 3D cursor, "stroke start" = the previous
    // chain vertex so circular/parallel guides behave like drawing
    let gx = e.x, gy = e.y;
    if (ctx.settings.guide.type !== 'NONE') {
      const pm = this.editMesh(ctx);
      let start: THREE.Vector2 | null = null;
      if (pm && this.state.kind === 'BUILD') {
        const prev = getVertex(pm, this.state.vertexIds[this.state.vertexIds.length - 1]);
        if (prev) start = this.screenOf(ctx, this.localToWorld(ctx, pm, prev.co));
      }
      const center = this.screenOf(ctx, [...ctx.scene.cursor] as Vec3)
        ?? new THREE.Vector2(e.x, e.y);
      const g = applyGuide(ctx, new THREE.Vector2(e.x, e.y), start, center);
      gx = g.x; gy = g.y;
    }
    return pickConstruction(ctx, gx, gy, {
      editMeshId: polyOverlay.editMeshId,
      excludeVertexIds,
      noSnap: e.ctrl,
      planeOverride: plane,
      vertexPx: VERTEX_PX,
      edgePx: EDGE_PX,
    });
  }

  /** Resolve a construction hit into a vertex id on the edit mesh —
   *  reusing hit vertices, splitting hit edges (endpoint-snapped), or
   *  creating a fresh bound vertex. */
  private vertexFromHit(ctx: AppCtx, pm: TGPolyMesh, hit: ConstructionHit): number | null {
    const src = hit.source;
    if (src.kind === 'POLY_VERTEX' && src.meshId === pm.id) return src.vertexId;
    if (src.kind === 'POLY_EDGE' && src.meshId === pm.id) {
      const e = getEdge(pm, src.edgeId);
      if (!e) return null;
      if (src.t < ENDPOINT_SNAP_T) return e.v[0];
      if (src.t > 1 - ENDPOINT_SNAP_T) return e.v[1];
      return splitEdge(pm, src.edgeId, src.t)?.id ?? null;
    }
    if (src.kind === 'POLY_FACE' && src.meshId === pm.id) {
      // POKE it (fan-triangulate from the new point) — a plain addVertex
      // here would put a point that LOOKS like it is on the face without
      // ever joining its topology; see pokeFace's own doc for what that
      // silently broke.
      const v = addVertex(pm, this.worldToLocal(ctx, pm, hit.world), bindingFor(src));
      pokeFace(pm, src.faceId, v.id);
      return v.id;
    }
    return addVertex(pm, this.worldToLocal(ctx, pm, hit.world), bindingFor(src)).id;
  }

  private camPlaneThrough(ctx: AppCtx, world: THREE.Vector3): THREE.Plane {
    const normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
  }

  private planePoint(ctx: AppCtx, plane: THREE.Plane, x: number, y: number): THREE.Vector3 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.camera);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }

  /** Rigid moves (edge/face drag, boundary extrusion) compute a raw plane
   *  delta with no source to snap to — round it to the Increment/Grid
   *  lattice (in LOCAL space, so it lines up with everything else the
   *  magnet drives) when the global magnet is on in a lattice mode. */
  private snapLocalDelta(ctx: AppCtx, d: THREE.Vector3): THREE.Vector3 {
    const snap = ctx.settings.snap;
    if (!snap.enabled || (snap.mode !== 'INCREMENT' && snap.mode !== 'GRID')) return d;
    const g = snapIncrement(ctx.settings);
    return new THREE.Vector3(
      Math.round(d.x / g) * g, Math.round(d.y / g) * g, Math.round(d.z / g) * g);
  }

  private screenOf(ctx: AppCtx, world: Vec3): THREE.Vector2 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const p = new THREE.Vector3(...world).project(ctx.camera);
    if (p.z > 1) return null;
    return new THREE.Vector2((p.x * 0.5 + 0.5) * rect.width, (-p.y * 0.5 + 0.5) * rect.height);
  }

  // ---- pointer -------------------------------------------------------------

  onDown(ctx: AppCtx, e: ToolEvent): void {
    this.axisLock = null;
    this.lockOrigin = null;
    const pm = this.ensureEditMesh(ctx);
    if (!pm || pm.lock) return;
    const hit = this.pick(ctx, e);
    this.pending = {
      x: e.x, y: e.y, downAt: performance.now(), hit,
      dragged: false, shift: e.shift, ctrl: e.ctrl, alt: e.alt, meta: e.meta,
    };
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    const pm = this.editMesh(ctx);
    if (!pm) { clearPolyOverlay(); return; }
    polyOverlay.editMeshId = pm.id;
    this.lastEvent = e;

    switch (this.state.kind) {
      case 'MOVE': this.updateMove(ctx, e, pm); return;
      case 'MOVE_ELEMS': this.updateMoveElems(ctx, e, pm); return;
      case 'EXTRUDE': this.updateExtrude(ctx, e, pm); return;
      case 'VERT_EXTRUDE': this.updateVertExtrude(ctx, e, pm); return;
      case 'LOOPCUT': this.updateLoopCut(ctx, e, pm); return;
      case 'KNIFE': this.state.b.set(e.x, e.y); ctx.requestRender(); return;
      default: break;
    }

    // promote a pending press: drag distance decides drag; elapsed time
    // (or Alt, PolyQuilt's hold-equivalent modifier) decides hold
    const p = this.pending;
    if (p && !p.dragged && Math.hypot(e.x - p.x, e.y - p.y) > DRAG_PX) {
      p.dragged = true;
      const held = p.alt || performance.now() - p.downAt > HOLD_MS;
      this.beginDragOp(ctx, pm, p, held);
      return;
    }

    this.updateHover(ctx, e);
  }

  /** Drag start: pick the modal operation from target x hold state x
   *  grab position (PolyQuilt: edge grabbed in its CENTER band extrudes/
   *  loop-cuts from there; grabbed off-center it moves). */
  private beginDragOp(ctx: AppCtx, pm: TGPolyMesh, p: Pending, held: boolean): void {
    if (this.state.kind !== 'IDLE') return; // BUILD ignores drags
    this.axisLock = null;
    this.lockOrigin = null;
    const src = p.hit.source;
    if (src.kind === 'POLY_VERTEX' && src.meshId === pm.id) {
      if (held) {
        // hold+drag on vertex: extrude a new edge out of it
        const from = getVertex(pm, src.vertexId);
        if (!from) return;
        const before = takeSnapshot(pm);
        const nv = addVertex(pm, [...from.co], from.binding);
        addEdge(pm, src.vertexId, nv.id);
        this.state = { kind: 'VERT_EXTRUDE', meshId: pm.id, fromId: src.vertexId, newId: nv.id, before };
      } else {
        this.state = { kind: 'MOVE', meshId: pm.id, vertexId: src.vertexId, before: takeSnapshot(pm), moved: false };
      }
      const from = getVertex(pm, src.vertexId);
      if (from) this.lockOrigin = new THREE.Vector3(...this.localToWorld(ctx, pm, from.co));
      return;
    }
    if (src.kind === 'POLY_EDGE' && src.meshId === pm.id) {
      const edge = getEdge(pm, src.edgeId);
      if (!edge) return;
      const boundary = isBoundaryEdge(pm, src.edgeId);
      const center = src.t >= EDGE_CENTER_T[0] && src.t <= EDGE_CENTER_T[1];
      // BUILD (Blender Poly Build): dragging a boundary edge extrudes from
      // anywhere along it; QUILT/PATCH: center band extrudes/loop-cuts,
      // off-center (or hold) keeps the richer PolyQuilt behaviors
      const extrudeZone = this.variant === 'BUILD' ? boundary : center;
      if (held || extrudeZone) {
        if (boundary) this.beginExtrude(ctx, pm, src.edgeId);
        else if (held || center) this.beginLoopCut(ctx, pm, src.edgeId, src.t);
        else this.beginMoveElems(ctx, pm, [...edge.v]);
      } else {
        this.beginMoveElems(ctx, pm, [...edge.v]);
      }
      this.defaultLock(ctx);
      return;
    }
    if (src.kind === 'POLY_FACE' && src.meshId === pm.id) {
      const face = getFace(pm, src.faceId);
      if (face) this.beginMoveElems(ctx, pm, [...face.vertices]);
      this.defaultLock(ctx);
      return;
    }
    if (held) {
      // hold+drag in empty space: knife
      this.state = {
        kind: 'KNIFE', meshId: pm.id, before: takeSnapshot(pm),
        a: new THREE.Vector2(p.x, p.y), b: new THREE.Vector2(p.x, p.y),
      };
    }
  }

  /** Up from Ground lifts: an edge/face drag starts locked to the up axis. */
  private defaultLock(ctx: AppCtx): void {
    if (ctx.settings.plane !== 'UPRIGHT') return;
    if (this.state.kind !== 'EXTRUDE' && this.state.kind !== 'MOVE_ELEMS') return;
    this.axisLock = { kind: 'AXIS', axis: ctx.settings.upAxis === 'Z' ? 'z' : 'y' };
  }

  /**
   * Where the pointer puts a locked drag, in WORLD space: the point on the
   * lock axis through `origin` nearest the pointer's ray, or where the ray
   * meets the lock plane. Null when unlocked (or the ray runs parallel).
   */
  private lockedPoint(ctx: AppCtx, e: ToolEvent, origin: THREE.Vector3): THREE.Vector3 | null {
    const lock = this.axisLock;
    if (!lock) return null;
    const rect = ctx.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.x / rect.width) * 2 - 1, -(e.y / rect.height) * 2 + 1), ctx.camera);
    const dir = AXIS_DIR[lock.axis];
    if (lock.kind === 'PLANE') {
      const out = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(dir, origin), out) ? out : null;
    }
    // closest point on the axis line to the ray (skew-line solve)
    const r = ray.ray;
    const w0 = origin.clone().sub(r.origin);
    const b = dir.dot(r.direction);
    const den = 1 - b * b;
    if (den < 1e-6) return null;                      // looking straight down the axis
    const t = (b * r.direction.dot(w0) - dir.dot(w0)) / den;
    return origin.clone().addScaledVector(dir, t);
  }

  /** A locked delta, in the mesh's LOCAL space. The grid rounding is done in
   *  WORLD space along the lock (the axes you locked to are world axes, and
   *  on a rotated mesh its local ones point elsewhere), so the components
   *  across the lock stay exactly zero. Ctrl skips the rounding. */
  private lockedLocalDelta(ctx: AppCtx, pm: TGPolyMesh, e: ToolEvent, origin: THREE.Vector3): THREE.Vector3 | null {
    const cur = this.lockedPoint(ctx, e, origin);
    if (!cur) return null;
    const snap = ctx.settings.snap;
    if (!e.ctrl && snap.enabled && (snap.mode === 'INCREMENT' || snap.mode === 'GRID')) {
      const g = snapIncrement(ctx.settings);
      const d = cur.clone().sub(origin);
      const n = 'xyz'.indexOf(this.axisLock!.axis);
      for (let i = 0; i < 3; i++) {
        const along = this.axisLock!.kind === 'AXIS' ? i === n : i !== n;
        d.setComponent(i, along ? Math.round(d.getComponent(i) / g) * g : 0);
      }
      cur.copy(origin).add(d);
    }
    const inv = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id }).invert();
    return cur.applyMatrix4(inv).sub(origin.clone().applyMatrix4(inv));
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    const pm = this.editMesh(ctx);
    if (!pm) { this.pending = null; return; }

    switch (this.state.kind) {
      case 'MOVE': {
        const st = this.state;
        this.state = { kind: 'IDLE' };
        this.pending = null;
        if (!st.moved) return;
        // PolyQuilt move(merge): dropping onto another vertex fuses them
        const target = pickPolyVertex(ctx, e.x, e.y, VERTEX_PX, pm.id, [st.vertexId]);
        if (target && target.meshId === pm.id) mergeVertices(pm, st.vertexId, target.vertexId);
        this.commit(ctx, pm, st.before);
        return;
      }
      case 'MOVE_ELEMS': {
        const st = this.state;
        this.state = { kind: 'IDLE' };
        this.pending = null;
        this.commit(ctx, pm, st.before);
        return;
      }
      case 'EXTRUDE': this.finishExtrude(ctx, pm); return;
      case 'VERT_EXTRUDE': {
        const st = this.state;
        this.state = { kind: 'IDLE' };
        this.pending = null;
        const target = pickPolyVertex(ctx, e.x, e.y, VERTEX_PX, pm.id, [st.newId]);
        if (target && target.meshId === pm.id) mergeVertices(pm, st.newId, target.vertexId);
        cleanupDegenerateFaces(pm);
        this.commit(ctx, pm, st.before);
        return;
      }
      case 'LOOPCUT': this.finishLoopCut(ctx, pm); return;
      case 'KNIFE': this.finishKnife(ctx, pm); return;
      default: break;
    }

    const pending = this.pending;
    this.pending = null;
    if (!pending) return;

    if (!pending.dragged) {
      const held = pending.alt || performance.now() - pending.downAt > HOLD_MS;
      if (held && this.state.kind === 'IDLE') { this.holdAction(ctx, pm, pending); return; }
      if (this.state.kind === 'IDLE') {
        const fill = () => {
          const before = takeSnapshot(pm);
          if (autoQuad(ctx, pm, pending.x, pending.y)) this.commit(ctx, pm, before);
        };
        if (this.variant === 'BUILD') {
          // Blender Poly Build mapping: Shift+LMB deletes the element,
          // Ctrl/Cmd+LMB (and plain click) adds geometry
          if (pending.shift) { this.holdAction(ctx, pm, pending); return; }
        } else if (this.variant === 'PATCH') {
          // Quad Patch: clicking fills the inferred patch
          if (pending.meta) { this.toggleSelect(ctx, pm, pending); return; }
          fill();
          return;
        } else {
          if (pending.shift) { fill(); return; }          // AutoQuad
          // Cmd, not Ctrl: Ctrl already means "disable snapping" for a
          // click here (`noSnap: e.ctrl` in `pick()`), and aliasing it to
          // select too meant every Ctrl+click to pick an existing vertex
          // also suppressed the very snap that would have found it.
          if (pending.meta) { this.toggleSelect(ctx, pm, pending); return; }
        }
      }
      this.clickAction(ctx, pm, pending);
    }
  }

  /** Long-press release without drag: delete/dissolve the element. */
  private holdAction(ctx: AppCtx, pm: TGPolyMesh, p: Pending): void {
    const src = p.hit.source;
    const apply = (fn: () => void) => { ctx.pushUndo(); fn(); ctx.refreshUI(); };
    if (src.kind === 'POLY_VERTEX' && src.meshId === pm.id) {
      apply(() => { if (!dissolveVertex(pm, src.vertexId)) removeVertex(pm, src.vertexId); });
    } else if (src.kind === 'POLY_EDGE' && src.meshId === pm.id) {
      apply(() => { if (!dissolveEdge(pm, src.edgeId)) removeEdge(pm, src.edgeId); });
    } else if (src.kind === 'POLY_FACE' && src.meshId === pm.id) {
      // face deletion cascades to topology that only existed for it:
      // sole-face boundary edges and now-unreferenced boundary vertices
      apply(() => removeFaceCascade(pm, src.faceId));
    }
  }

  /** Plain click: face-fill construction chain. */
  private clickAction(ctx: AppCtx, pm: TGPolyMesh, pending: Pending): void {
    if (this.state.kind === 'IDLE') {
      const before = takeSnapshot(pm);
      const id = this.vertexFromHit(ctx, pm, pending.hit);
      if (id === null) { restoreSnapshot(pm, before); return; }
      // Surface ⊥ placement: the chain STARTS on the surface it hit, then
      // grows on the standing plane through that point (contains the
      // surface normal, faces the view) — same semantics as pen strokes
      const perp = ctx.settings.placement === 'SURFACE_PERP' && pending.hit.normal
        ? perpendicularPlaneAt(ctx,
            new THREE.Vector3(...pending.hit.world),
            new THREE.Vector3(...pending.hit.normal))
        : null;
      this.state = {
        kind: 'BUILD', meshId: pm.id, vertexIds: [id],
        before, plane: perp ?? drawingPlane(ctx).clone(),
      };
      polyOverlay.activeVertexIds = [id];
      return;
    }
    if (this.state.kind === 'BUILD') {
      const st = this.state;
      const chain = st.vertexIds;
      const src = pending.hit.source;
      // PolyQuilt finalize: clicking the LAST placed vertex ends the chain
      if (src.kind === 'POLY_VERTEX' && src.meshId === pm.id
        && src.vertexId === chain[chain.length - 1]) {
        this.state = { kind: 'IDLE' };
        this.commit(ctx, pm, st.before);
        clearPolyOverlay();
        polyOverlay.editMeshId = pm.id;
        return;
      }
      const id = this.vertexFromHit(ctx, pm, pending.hit);
      if (id === null) return;
      if (id === chain[0] && chain.length >= 3) {
        const face = addFace(pm, chain);
        if (!face) cleanupDegenerateFaces(pm);
        this.state = { kind: 'IDLE' };
        this.commit(ctx, pm, st.before);
        clearPolyOverlay();
        polyOverlay.editMeshId = pm.id;
        return;
      }
      addEdge(pm, chain[chain.length - 1], id);
      chain.push(id);
      polyOverlay.activeVertexIds = [...chain];
    }
  }

  onCancel(ctx: AppCtx): void {
    this.cancelModal(ctx);
  }

  // ---- vertex move ---------------------------------------------------------

  private updateMove(ctx: AppCtx, e: ToolEvent, pm: TGPolyMesh): void {
    if (this.state.kind !== 'MOVE') return;
    if (this.axisLock && this.lockOrigin && this.lockedVertex(ctx, pm, e, this.state.vertexId, this.state.before)) {
      this.state.moved = true;
      return;
    }
    const hit = this.pick(ctx, e, [this.state.vertexId]);
    const v = getVertex(pm, this.state.vertexId);
    if (v) {
      v.co = this.worldToLocal(ctx, pm, hit.world);
      v.binding = bindingFor(hit.source);
      this.state.moved = true;
      touchPolyMesh(pm);
    }
    this.updateHover(ctx, e, hit);
  }

  /** A locked single-vertex drag: its rest position plus the locked delta. */
  private lockedVertex(ctx: AppCtx, pm: TGPolyMesh, e: ToolEvent, id: number, before: string): boolean {
    const d = this.lockedLocalDelta(ctx, pm, e, this.lockOrigin!);
    const orig = (JSON.parse(before) as Pick<TGPolyMesh, 'vertices'>).vertices.find((v) => v.id === id);
    const v = getVertex(pm, id);
    if (!d || !orig || !v) return false;
    v.co = [orig.co[0] + d.x, orig.co[1] + d.y, orig.co[2] + d.z];
    touchPolyMesh(pm);
    return true;
  }

  // ---- edge / face move (rigid, on a camera plane) --------------------------

  private beginMoveElems(ctx: AppCtx, pm: TGPolyMesh, vertexIds: number[]): void {
    const verts = vertexIds.map((id) => getVertex(pm, id)).filter((v): v is NonNullable<typeof v> => !!v);
    if (!verts.length) return;
    const centroid: Vec3 = [0, 0, 0];
    for (const v of verts) { centroid[0] += v.co[0]; centroid[1] += v.co[1]; centroid[2] += v.co[2]; }
    const world = new THREE.Vector3(...this.localToWorld(ctx, pm, [
      centroid[0] / verts.length, centroid[1] / verts.length, centroid[2] / verts.length]));
    this.state = {
      kind: 'MOVE_ELEMS', meshId: pm.id, vertexIds: [...vertexIds],
      before: takeSnapshot(pm),
      plane: this.camPlaneThrough(ctx, world), startWorld: world,
    };
  }

  private updateMoveElems(ctx: AppCtx, e: ToolEvent, pm: TGPolyMesh): void {
    if (this.state.kind !== 'MOVE_ELEMS') return;
    const st = this.state;
    const d = this.axisLock ? this.lockedLocalDelta(ctx, pm, e, st.startWorld) : this.planeDelta(ctx, pm, e, st.plane, st.startWorld);
    if (!d) return;
    const snap = JSON.parse(st.before) as Pick<TGPolyMesh, 'vertices'>;
    for (const id of st.vertexIds) {
      const orig = snap.vertices.find((v) => v.id === id);
      const v = getVertex(pm, id);
      if (orig && v) v.co = [orig.co[0] + d.x, orig.co[1] + d.y, orig.co[2] + d.z];
    }
    touchPolyMesh(pm);
  }

  /** The unlocked rigid delta: on the camera plane through the element. */
  private planeDelta(ctx: AppCtx, pm: TGPolyMesh, e: ToolEvent, plane: THREE.Plane, start: THREE.Vector3): THREE.Vector3 | null {
    const cur = this.planePoint(ctx, plane, e.x, e.y);
    if (!cur) return null;
    const inv = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id }).invert();
    const p0 = start.clone().applyMatrix4(inv);
    const d = cur.applyMatrix4(inv).sub(p0);
    return e.ctrl ? d : this.snapLocalDelta(ctx, d);
  }

  // ---- vertex-drag edge extrusion (hold+drag on vertex) ---------------------

  private updateVertExtrude(ctx: AppCtx, e: ToolEvent, pm: TGPolyMesh): void {
    if (this.state.kind !== 'VERT_EXTRUDE') return;
    if (this.axisLock && this.lockOrigin) {
      // the new vertex starts where the one it grows from is
      const from = getVertex(pm, this.state.fromId);
      const v = getVertex(pm, this.state.newId);
      const d = this.lockedLocalDelta(ctx, pm, e, this.lockOrigin);
      if (from && v && d) { v.co = [from.co[0] + d.x, from.co[1] + d.y, from.co[2] + d.z]; touchPolyMesh(pm); }
      return;
    }
    const hit = this.pick(ctx, e, [this.state.newId]);
    const v = getVertex(pm, this.state.newId);
    if (v) {
      v.co = this.worldToLocal(ctx, pm, hit.world);
      v.binding = bindingFor(hit.source);
      touchPolyMesh(pm);
    }
    this.updateHover(ctx, e, hit);
  }

  // ---- boundary-edge quad extrusion ----------------------------------------

  private beginExtrude(ctx: AppCtx, pm: TGPolyMesh, edgeId: number): void {
    const e = getEdge(pm, edgeId);
    if (!e) return;
    const va = getVertex(pm, e.v[0]), vb = getVertex(pm, e.v[1]);
    if (!va || !vb) return;
    const before = takeSnapshot(pm);
    const na = addVertex(pm, [...va.co], va.binding);
    const nb = addVertex(pm, [...vb.co], vb.binding);
    addEdge(pm, na.id, nb.id);
    addEdge(pm, va.id, na.id);
    addEdge(pm, vb.id, nb.id);
    addFace(pm, [va.id, vb.id, nb.id, na.id]);
    const mid = new THREE.Vector3(...this.localToWorld(ctx, pm, [
      (va.co[0] + vb.co[0]) / 2, (va.co[1] + vb.co[1]) / 2, (va.co[2] + vb.co[2]) / 2,
    ]));
    this.state = {
      kind: 'EXTRUDE', meshId: pm.id, srcEdgeId: edgeId,
      newVa: na.id, newVb: nb.id, before,
      plane: this.camPlaneThrough(ctx, mid), startWorld: mid,
    };
  }

  private updateExtrude(ctx: AppCtx, e: ToolEvent, pm: TGPolyMesh): void {
    if (this.state.kind !== 'EXTRUDE') return;
    const st = this.state;
    const d = this.axisLock ? this.lockedLocalDelta(ctx, pm, e, st.startWorld) : this.planeDelta(ctx, pm, e, st.plane, st.startWorld);
    if (!d) return;
    const snap = JSON.parse(st.before) as Pick<TGPolyMesh, 'vertices' | 'edges'>;
    const srcEdge = getEdge(pm, st.srcEdgeId) ?? null;
    const origA = snap.vertices.find((v) => v.id === srcEdge?.v[0]);
    const origB = snap.vertices.find((v) => v.id === srcEdge?.v[1]);
    const na = getVertex(pm, st.newVa), nb = getVertex(pm, st.newVb);
    if (!origA || !origB || !na || !nb) return;
    na.co = [origA.co[0] + d.x, origA.co[1] + d.y, origA.co[2] + d.z];
    nb.co = [origB.co[0] + d.x, origB.co[1] + d.y, origB.co[2] + d.z];
    touchPolyMesh(pm);
    polyOverlay.previewPoint = null;
    polyOverlay.previewLine = null;
  }

  private finishExtrude(ctx: AppCtx, pm: TGPolyMesh): void {
    if (this.state.kind !== 'EXTRUDE') return;
    const st = this.state;
    this.state = { kind: 'IDLE' };
    this.pending = null;
    for (const newId of [st.newVa, st.newVb]) {
      const v = getVertex(pm, newId);
      if (!v) continue;
      const s = this.screenOf(ctx, this.localToWorld(ctx, pm, v.co));
      if (!s) continue;
      const target = pickPolyVertex(ctx, s.x, s.y, VERTEX_PX, pm.id, [st.newVa, st.newVb]);
      if (target && target.meshId === pm.id) mergeVertices(pm, newId, target.vertexId);
    }
    cleanupDegenerateFaces(pm);
    this.commit(ctx, pm, st.before);
  }

  // ---- loop cut (hold+drag on an interior edge, quad strips) ----------------

  private beginLoopCut(ctx: AppCtx, pm: TGPolyMesh, edgeId: number, t: number): void {
    const plan = walkQuadLoop(pm, edgeId);
    if (!plan) return;
    this.state = {
      kind: 'LOOPCUT', meshId: pm.id, plan,
      before: takeSnapshot(pm), hoverEdgeId: edgeId, t: Math.max(0.05, Math.min(0.95, t)),
    };
    this.previewLoopCut(ctx, pm);
  }

  private loopCutT(ctx: AppCtx, e: ToolEvent, pm: TGPolyMesh): number | null {
    if (this.state.kind !== 'LOOPCUT') return null;
    const edge = getEdge(pm, this.state.hoverEdgeId);
    if (!edge) return null;
    const va = getVertex(pm, edge.v[0]), vb = getVertex(pm, edge.v[1]);
    if (!va || !vb) return null;
    const sa = this.screenOf(ctx, this.localToWorld(ctx, pm, va.co));
    const sb = this.screenOf(ctx, this.localToWorld(ctx, pm, vb.co));
    if (!sa || !sb) return null;
    const ab = sb.clone().sub(sa);
    const len2 = ab.lengthSq();
    if (len2 < 1e-6) return null;
    const raw = new THREE.Vector2(e.x, e.y).sub(sa).dot(ab) / len2;
    return Math.max(0.05, Math.min(0.95, raw));
  }

  private updateLoopCut(ctx: AppCtx, e: ToolEvent, pm: TGPolyMesh): void {
    if (this.state.kind !== 'LOOPCUT') return;
    const t = this.loopCutT(ctx, e, pm);
    if (t !== null) this.state.t = t;
    this.previewLoopCut(ctx, pm);
  }

  /** t on a stop's edge, expressed in that edge's stored v[0]->v[1] space. */
  private stopParam(pm: TGPolyMesh, stop: { edgeId: number; fromVertex: number }, t: number): number {
    const e = getEdge(pm, stop.edgeId);
    return e && e.v[0] === stop.fromVertex ? t : 1 - t;
  }

  private previewLoopCut(ctx: AppCtx, pm: TGPolyMesh): void {
    if (this.state.kind !== 'LOOPCUT') return;
    const { plan, t } = this.state;
    const pts: Vec3[] = [];
    for (const stop of plan.stops) {
      const e = getEdge(pm, stop.edgeId);
      if (!e) continue;
      const a = getVertex(pm, e.v[0]), b = getVertex(pm, e.v[1]);
      if (!a || !b) continue;
      const k = this.stopParam(pm, stop, t);
      pts.push(this.localToWorld(ctx, pm, [
        a.co[0] + (b.co[0] - a.co[0]) * k,
        a.co[1] + (b.co[1] - a.co[1]) * k,
        a.co[2] + (b.co[2] - a.co[2]) * k,
      ]));
    }
    polyOverlay.previewLine = pts.length >= 2 ? pts : null;
    polyOverlay.previewLoop = plan.closed;
    polyOverlay.previewInvalid = false;
    polyOverlay.previewPoint = null;
  }

  private finishLoopCut(ctx: AppCtx, pm: TGPolyMesh): void {
    if (this.state.kind !== 'LOOPCUT') return;
    const st = this.state;
    this.state = { kind: 'IDLE' };
    this.pending = null;
    const newIds: number[] = [];
    for (const stop of st.plan.stops) {
      const v = splitEdge(pm, stop.edgeId, this.stopParam(pm, stop, st.t));
      if (!v) { restoreSnapshot(pm, st.before); clearPolyOverlay(); polyOverlay.editMeshId = pm.id; return; }
      newIds.push(v.id);
    }
    // connect across each quad in the plan: faces[i] sits between stop i
    // and stop i+1 (wrapping when the loop is closed)
    for (let i = 0; i < st.plan.faces.length; i++) {
      const a = newIds[i], b = newIds[(i + 1) % newIds.length];
      if (a === undefined || b === undefined || a === b) continue;
      splitFace(pm, st.plan.faces[i], a, b);
    }
    this.commit(ctx, pm, st.before);
    clearPolyOverlay();
    polyOverlay.editMeshId = pm.id;
  }

  // ---- knife (hold+drag in empty space) -------------------------------------

  private finishKnife(ctx: AppCtx, pm: TGPolyMesh): void {
    if (this.state.kind !== 'KNIFE') return;
    const st = this.state;
    this.state = { kind: 'IDLE' };
    this.pending = null;
    if (st.a.distanceTo(st.b) < DRAG_PX * 2) { clearPolyOverlay(); polyOverlay.editMeshId = pm.id; return; }
    // split every edge whose screen segment crosses the knife line
    const cuts: { edgeId: number; t: number }[] = [];
    for (const e of pm.edges) {
      const va = getVertex(pm, e.v[0]), vb = getVertex(pm, e.v[1]);
      if (!va || !vb) continue;
      const sa = this.screenOf(ctx, this.localToWorld(ctx, pm, va.co));
      const sb = this.screenOf(ctx, this.localToWorld(ctx, pm, vb.co));
      if (!sa || !sb) continue;
      const t = segmentIntersectParam(sa, sb, st.a, st.b);
      if (t !== null && t > 0.02 && t < 0.98) cuts.push({ edgeId: e.id, t });
    }
    if (!cuts.length) { clearPolyOverlay(); polyOverlay.editMeshId = pm.id; return; }
    const newIds: number[] = [];
    for (const cut of cuts) {
      const v = splitEdge(pm, cut.edgeId, cut.t);
      if (v) newIds.push(v.id);
    }
    // connect the cut through faces: any face now containing exactly two of
    // the new vertices gets split between them
    for (const f of [...pm.faces]) {
      const inFace = f.vertices.filter((id) => newIds.includes(id));
      if (inFace.length === 2) splitFace(pm, f.id, inFace[0], inFace[1]);
    }
    this.commit(ctx, pm, st.before);
    clearPolyOverlay();
    polyOverlay.editMeshId = pm.id;
  }

  // ---- selection + deletion ------------------------------------------------

  private toggleSelect(ctx: AppCtx, pm: TGPolyMesh, pending: Pending): void {
    const v = pickPolyVertex(ctx, pending.x, pending.y, VERTEX_PX, pm.id);
    if (v && v.meshId === pm.id) {
      const vert = getVertex(pm, v.vertexId);
      if (vert) { vert.select = !vert.select; touchPolyMesh(pm); }
      return;
    }
    const ed = pickPolyEdge(ctx, pending.x, pending.y, EDGE_PX, pm.id);
    if (ed && ed.meshId === pm.id) {
      const edge = getEdge(pm, ed.edgeId);
      if (edge) { edge.select = !edge.select; touchPolyMesh(pm); }
      return;
    }
    const f = pickPolyFace(ctx, pending.x, pending.y);
    if (f && f.meshId === pm.id) {
      const face = getFace(pm, f.faceId);
      if (face) { face.select = !face.select; touchPolyMesh(pm); }
    }
  }

  /** Delete selected elements: faces alone; edges take dependent faces;
   *  vertices take connected edges + faces (utility semantics). */
  deleteSelected(ctx: AppCtx): boolean {
    const pm = this.editMesh(ctx);
    if (!pm) return false;
    const faces = pm.faces.filter((f) => f.select).map((f) => f.id);
    const edges = pm.edges.filter((e) => e.select).map((e) => e.id);
    const verts = pm.vertices.filter((v) => v.select).map((v) => v.id);
    if (!faces.length && !edges.length && !verts.length) return false;
    ctx.pushUndo();
    for (const id of faces) removeFaceCascade(pm, id);
    for (const id of edges) removeEdge(pm, id);
    for (const id of verts) removeVertex(pm, id);
    ctx.refreshUI();
    return true;
  }

  /**
   * MERGE (weld) the Cmd+click-selected vertices into one, at their
   * centre — the way to REJOIN parts that only look connected: a base
   * built as several separate chains (Poly Build has no "click the
   * existing corner" memory across chains) leaves each corner a distinct,
   * merely coincident vertex, and nothing before this could rejoin them
   * short of dragging one exactly onto the other by hand, repeatedly.
   * `mergeVertices` folds every OTHER selected vertex onto the first
   * (rewiring their edges and face boundaries, dropping degenerate
   * results), then the survivor is moved to the group's average position.
   */
  mergeSelected(ctx: AppCtx): boolean {
    const pm = this.editMesh(ctx);
    if (!pm) return false;
    const ids = pm.vertices.filter((v) => v.select).map((v) => v.id);
    if (ids.length < 2) return false;
    ctx.pushUndo();
    const center: Vec3 = [0, 0, 0];
    for (const id of ids) {
      const v = getVertex(pm, id);
      if (v) { center[0] += v.co[0]; center[1] += v.co[1]; center[2] += v.co[2]; }
    }
    center[0] /= ids.length; center[1] /= ids.length; center[2] /= ids.length;
    const into = ids[0];
    for (let i = 1; i < ids.length; i++) mergeVertices(pm, ids[i], into);
    const survivor = getVertex(pm, into);
    if (survivor) { survivor.co = center; survivor.select = true; }
    cleanupDegenerateFaces(pm);
    touchPolyMesh(pm);
    ctx.refreshUI();
    return true;
  }

  /**
   * WELD BY DISTANCE (Blender's "Merge — By Distance"): every group of
   * vertices sitting close together on screen is folded into one, group by
   * group — unlike `mergeSelected`, which always collapses the WHOLE
   * selection to a single point. This is the one to reach for after
   * box-selecting a whole seam between chains built separately: each
   * corner pair welds independently instead of the seam collapsing into
   * one vertex. Scoped to the selection when anything is selected (so a
   * stray near-coincidence elsewhere on the mesh is never touched by
   * accident), else the whole mesh. Screen-space, like every other pick
   * here — a fixed WORLD epsilon has no one right value across a scan's
   * scale, but "close enough to click as the same point" is what the
   * threshold already means everywhere else in this tool.
   */
  weldByDistance(ctx: AppCtx): boolean {
    const pm = this.editMesh(ctx);
    if (!pm) return false;
    const selected = pm.vertices.filter((v) => v.select);
    const pool = selected.length >= 2 ? selected : pm.vertices;
    if (pool.length < 2) return false;
    const pts = pool.map((v) => ({ id: v.id, s: this.screenOf(ctx, this.localToWorld(ctx, pm, v.co)) }))
      .filter((p): p is { id: number; s: THREE.Vector2 } => !!p.s);
    // union-find over screen-close pairs
    const parent = new Map(pts.map((p) => [p.id, p.id]));
    const find = (id: number): number => { let r = id; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const THRESHOLD_PX = 18;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (pts[i].s.distanceTo(pts[j].s) <= THRESHOLD_PX) union(pts[i].id, pts[j].id);
      }
    }
    const groups = new Map<number, number[]>();
    for (const p of pts) {
      const r = find(p.id);
      (groups.get(r) ?? groups.set(r, []).get(r)!).push(p.id);
    }
    const multi = [...groups.values()].filter((g) => g.length >= 2);
    if (!multi.length) return false;
    ctx.pushUndo();
    let welded = 0;
    for (const ids of multi) {
      const center: Vec3 = [0, 0, 0];
      for (const id of ids) {
        const v = getVertex(pm, id);
        if (v) { center[0] += v.co[0]; center[1] += v.co[1]; center[2] += v.co[2]; }
      }
      center[0] /= ids.length; center[1] /= ids.length; center[2] /= ids.length;
      const into = ids[0];
      for (let i = 1; i < ids.length; i++) mergeVertices(pm, ids[i], into);
      const survivor = getVertex(pm, into);
      if (survivor) { survivor.co = center; survivor.select = true; }
      welded += ids.length - 1;
    }
    cleanupDegenerateFaces(pm);
    touchPolyMesh(pm);
    ctx.setStatus(`welded ${welded} ${welded === 1 ? 'vertex' : 'vertices'} into ${multi.length} ${multi.length === 1 ? 'point' : 'points'}`, 2500);
    ctx.refreshUI();
    return true;
  }

  // ---- keys ----------------------------------------------------------------

  onKey(ctx: AppCtx, key: string, e: KeyboardEvent): boolean {
    const k = key.toLowerCase();
    const dragging = this.state.kind === 'MOVE' || this.state.kind === 'MOVE_ELEMS'
      || this.state.kind === 'EXTRUDE' || this.state.kind === 'VERT_EXTRUDE';
    if (dragging && (k === 'x' || k === 'y' || k === 'z') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const next: AxisLock = { kind: e.shiftKey ? 'PLANE' : 'AXIS', axis: k };
      const same = this.axisLock && this.axisLock.kind === next.kind && this.axisLock.axis === next.axis;
      this.axisLock = same ? null : next;
      if (!this.lockOrigin && (this.state.kind === 'MOVE_ELEMS' || this.state.kind === 'EXTRUDE')) {
        this.lockOrigin = this.state.startWorld.clone();
      }
      const pm = this.editMesh(ctx);
      if (pm && this.lastEvent) this.onMove(ctx, this.lastEvent);
      ctx.requestRender();
      return true;
    }
    if (key === 'Escape') {
      if (this.state.kind === 'IDLE') return false;
      this.cancelModal(ctx);
      return true;
    }
    if (key === 'Enter') {
      if (this.state.kind !== 'BUILD') return false;
      const pm = this.editMesh(ctx);
      const st = this.state;
      this.state = { kind: 'IDLE' };
      if (pm) this.commit(ctx, pm, st.before);
      clearPolyOverlay();
      if (pm) polyOverlay.editMeshId = pm.id;
      return true;
    }
    if (key === 'm' || key === 'M') {
      if (this.state.kind !== 'IDLE') return false;
      return e.shiftKey ? this.weldByDistance(ctx) : this.mergeSelected(ctx);
    }
    if (key === 'Delete' || key === 'Backspace' || key === 'x' || key === 'X') {
      if (this.state.kind !== 'IDLE') return false;
      return this.deleteSelected(ctx);
    }
    void e;
    return false;
  }

  /** The lock, drawn: the axis as a coloured line through the dragged
   *  element (or, for a plane lock, its two in-plane axes), plus a label. */
  private drawLock(ctx: AppCtx, hud: CanvasRenderingContext2D, at: THREE.Vector3): void {
    const lock = this.axisLock!;
    const axes = lock.kind === 'AXIS' ? [lock.axis] : (['x', 'y', 'z'] as const).filter((a) => a !== lock.axis);
    hud.save();
    hud.lineWidth = 1.5;
    for (const a of axes) {
      const s0 = this.screenOf(ctx, [at.x - AXIS_DIR[a].x * 50, at.y - AXIS_DIR[a].y * 50, at.z - AXIS_DIR[a].z * 50]);
      const s1 = this.screenOf(ctx, [at.x + AXIS_DIR[a].x * 50, at.y + AXIS_DIR[a].y * 50, at.z + AXIS_DIR[a].z * 50]);
      const c = this.screenOf(ctx, [at.x, at.y, at.z]);
      if (!c) continue;
      hud.strokeStyle = AXIS_COLOR[a];
      hud.beginPath();
      // a far end behind the camera cannot be projected; run from the centre
      hud.moveTo((s0 ?? c).x, (s0 ?? c).y);
      hud.lineTo((s1 ?? c).x, (s1 ?? c).y);
      hud.stroke();
    }
    const c = this.screenOf(ctx, [at.x, at.y, at.z]);
    if (c) {
      hud.font = '11px ui-monospace, monospace';
      hud.fillStyle = AXIS_COLOR[lock.axis];
      hud.fillText(lock.kind === 'AXIS' ? `along ${lock.axis.toUpperCase()}`
        : `in ${axes.join('').toUpperCase()}`, c.x + 12, c.y - 10);
    }
    hud.restore();
  }

  private cancelModal(ctx: AppCtx): void {
    const pm = this.editMesh(ctx);
    if (pm && this.state.kind !== 'IDLE') restoreSnapshot(pm, this.state.before);
    this.state = { kind: 'IDLE' };
    this.pending = null;
    clearPolyOverlay();
    if (pm) polyOverlay.editMeshId = pm.id;
    ctx.requestRender();
  }

  // ---- hover / preview -----------------------------------------------------

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    const lockAt = this.state.kind === 'MOVE_ELEMS' || this.state.kind === 'EXTRUDE'
      ? this.state.startWorld : this.state.kind !== 'IDLE' ? this.lockOrigin : null;
    if (this.axisLock && lockAt) this.drawLock(ctx, hud, lockAt);
    if (this.state.kind === 'KNIFE') {
      hud.beginPath();
      hud.moveTo(this.state.a.x, this.state.a.y);
      hud.lineTo(this.state.b.x, this.state.b.y);
      hud.strokeStyle = 'rgba(80,220,255,0.9)';
      hud.setLineDash([6, 4]);
      hud.lineWidth = 1.5;
      hud.stroke();
      hud.setLineDash([]);
      return;
    }
    const pm = this.editMesh(ctx);
    if (!pm) return;

    const edgeScreen = (edgeId: number): [THREE.Vector2, THREE.Vector2] | null => {
      const e = getEdge(pm, edgeId);
      if (!e) return null;
      const a = getVertex(pm, e.v[0]), b = getVertex(pm, e.v[1]);
      if (!a || !b) return null;
      const sa = this.screenOf(ctx, this.localToWorld(ctx, pm, a.co));
      const sb = this.screenOf(ctx, this.localToWorld(ctx, pm, b.co));
      return sa && sb ? [sa, sb] : null;
    };
    const strokeSeg = (seg: [THREE.Vector2, THREE.Vector2], color: string, width: number) => {
      hud.beginPath();
      hud.moveTo(seg[0].x, seg[0].y);
      hud.lineTo(seg[1].x, seg[1].y);
      hud.strokeStyle = color;
      hud.lineWidth = width;
      hud.stroke();
    };

    // -- delete-armed: element under a matured long-press turns RED --
    const p = this.pending;
    const armed = p && !p.dragged && this.state.kind === 'IDLE'
      && (p.alt || performance.now() - p.downAt > HOLD_MS);
    if (armed && p) {
      const src = p.hit.source;
      hud.save();
      if (src.kind === 'POLY_EDGE' && src.meshId === pm.id) {
        const seg = edgeScreen(src.edgeId);
        if (seg) strokeSeg(seg, 'rgba(255,64,64,0.95)', 4);
      } else if (src.kind === 'POLY_VERTEX' && src.meshId === pm.id) {
        const v = getVertex(pm, src.vertexId);
        const s = v && this.screenOf(ctx, this.localToWorld(ctx, pm, v.co));
        if (s) {
          hud.beginPath();
          hud.arc(s.x, s.y, 9, 0, Math.PI * 2);
          hud.strokeStyle = 'rgba(255,64,64,0.95)';
          hud.lineWidth = 3;
          hud.stroke();
        }
      } else if (src.kind === 'POLY_FACE' && src.meshId === pm.id) {
        const f = getFace(pm, src.faceId);
        if (f) {
          hud.beginPath();
          let started = false;
          for (const vid of f.vertices) {
            const v = getVertex(pm, vid);
            const s = v && this.screenOf(ctx, this.localToWorld(ctx, pm, v.co));
            if (!s) continue;
            if (!started) { hud.moveTo(s.x, s.y); started = true; }
            else hud.lineTo(s.x, s.y);
          }
          hud.closePath();
          hud.strokeStyle = 'rgba(255,64,64,0.95)';
          hud.lineWidth = 3;
          hud.stroke();
          hud.fillStyle = 'rgba(255,64,64,0.18)';
          hud.fill();
        }
      }
      hud.restore();
      return;
    }

    // -- extrude intent: hovered edge in its extrude zone goes YELLOW and
    //    thicker (center band for QUILT/PATCH, whole boundary for BUILD) --
    if (!p && this.state.kind === 'IDLE' && this.edgeHover) {
      const h = this.edgeHover;
      const center = h.t >= EDGE_CENTER_T[0] && h.t <= EDGE_CENTER_T[1];
      const zone = this.variant === 'BUILD' ? h.boundary : center;
      if (zone) {
        const seg = edgeScreen(h.edgeId);
        if (seg) {
          const color = h.boundary ? 'rgba(255,215,64,0.95)' : 'rgba(255,215,64,0.75)';
          strokeSeg(seg, color, h.boundary ? 4 : 3);
          // tick mark at the grab point: extrusion starts HERE
          const mid = seg[0].clone().lerp(seg[1], h.t);
          hud.beginPath();
          hud.arc(mid.x, mid.y, 4, 0, Math.PI * 2);
          hud.fillStyle = 'rgba(255,215,64,0.95)';
          hud.fill();
        }
      }
    }
  }

  private updateHover(ctx: AppCtx, e: ToolEvent, precomputed?: ConstructionHit): void {
    const pm = this.editMesh(ctx);
    if (!pm) return;
    const hit = precomputed ?? this.pick(ctx, e);
    const src = hit.source;
    polyOverlay.hover =
      src.kind === 'POLY_VERTEX' ? { meshId: src.meshId, dim: 0, id: src.vertexId }
      : src.kind === 'POLY_EDGE' ? { meshId: src.meshId, dim: 1, id: src.edgeId }
      : src.kind === 'POLY_FACE' ? { meshId: src.meshId, dim: 2, id: src.faceId }
      : null;
    this.edgeHover = src.kind === 'POLY_EDGE' && src.meshId === pm.id
      ? { edgeId: src.edgeId, t: src.t, boundary: isBoundaryEdge(pm, src.edgeId) }
      : null;
    polyOverlay.previewPoint = hit.world;
    if (this.state.kind === 'BUILD') {
      const chain = this.state.vertexIds;
      const coords = chain
        .map((id) => getVertex(pm, id))
        .filter((v): v is NonNullable<typeof v> => !!v)
        .map((v) => this.localToWorld(ctx, pm, v.co));
      const closing = src.kind === 'POLY_VERTEX' && src.meshId === pm.id
        && src.vertexId === chain[0];
      polyOverlay.previewLine = [...coords, hit.world];
      polyOverlay.previewLoop = closing && chain.length >= 3;
      polyOverlay.previewInvalid = closing && chain.length < 3;
    } else {
      polyOverlay.previewLine = null;
      polyOverlay.previewLoop = false;
      polyOverlay.previewInvalid = false;
    }
  }
}

/** Parameter of the intersection of segment (a1,a2) with segment (b1,b2),
 *  measured along (a1,a2); null when they don't cross. */
function segmentIntersectParam(
  a1: THREE.Vector2, a2: THREE.Vector2, b1: THREE.Vector2, b2: THREE.Vector2,
): number | null {
  const r = a2.clone().sub(a1);
  const s = b2.clone().sub(b1);
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const qp = b1.clone().sub(a1);
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  const u = (qp.x * r.y - qp.y * r.x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
