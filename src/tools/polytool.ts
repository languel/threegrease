// Topology Pen: the context-sensitive editable-mesh tool (POLY mode).
// One tool, PolyQuilt-inspired: what a click/drag does depends on the
// element under the pointer and the active construction state.
//   click empty/source   -> create a vertex, start/extend the chain
//   click a vertex       -> reuse it (start vertex + >=3 -> close a face)
//   click an edge        -> split it and connect to the inserted vertex
//   drag a vertex        -> modal move (Ctrl disables source snapping)
//   drag a boundary edge -> minimal single-edge extrusion (new quad)
//   Shift+click          -> toggle element selection (Delete removes)
//   Enter                -> finish the open chain (keeps verts + edges)
//   Escape               -> cancel the modal op, exact pre-state restored
//
// Undo grouping: modal ops snapshot ONLY the poly mesh locally at start,
// mutate live for preview, and on commit restore-the-before, pushUndo,
// re-apply-the-after — one coherent undo step per operation, none on
// cancel (see docs/design/polymesh.md).
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { TGPolyMesh, Vec3 } from '../core/types';
import type { Tool, ToolEvent } from './toolsys';
import { drawingPlane } from './projection';
import { worldMatrixOf } from './objects';
import {
  addEdge, addFace, addVertex, cleanupDegenerateFaces, findEdge, getEdge, getVertex,
  isBoundaryEdge, mergeVertices, removeEdge, removeFace, removeVertex, splitEdge,
  touchPolyMesh,
} from '../core/polymesh';
import { bindingFor, pickConstruction, pickPolyEdge, pickPolyFace, pickPolyVertex, type ConstructionHit } from './polypick';
import { clearPolyOverlay, polyOverlay } from '../render/polymesh';

const VERTEX_PX = 14;
const EDGE_PX = 10;
const DRAG_PX = 5;
const ENDPOINT_SNAP_T = 0.12; // edge-split clicks this close to an end reuse it

interface PolySnapshot { vertices: string; }

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
  | {
      kind: 'MOVE'; meshId: number; vertexId: number; before: string; plane: THREE.Plane;
      moved: boolean;
    }
  | {
      kind: 'EXTRUDE'; meshId: number; srcEdgeId: number; newVa: number; newVb: number;
      before: string; plane: THREE.Plane; startWorld: THREE.Vector3;
    };

/** Pointer-down intent, resolved into a modal op on drag or a click on up. */
interface Pending { x: number; y: number; hit: ConstructionHit; dragged: boolean }

export class PolyPenTool implements Tool {
  id = 'polypen';
  cursor = 'crosshair';
  private state: ToolState = { kind: 'IDLE' };
  private pending: Pending | null = null;

  // ---- helpers -------------------------------------------------------------

  private editMesh(ctx: AppCtx): TGPolyMesh | null {
    return ctx.scene.polyMeshes.find((p) => p.id === polyOverlay.editMeshId) ?? null;
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
    const plane = this.state.kind === 'IDLE' ? null : this.state.plane;
    return pickConstruction(ctx, e.x, e.y, {
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
    // POLY_FACE / MESH / GP_STROKE / SPLAT / PLANE / FREE: new vertex at the hit
    return addVertex(pm, this.worldToLocal(ctx, pm, hit.world), bindingFor(src)).id;
  }

  private opPlane(ctx: AppCtx): THREE.Plane {
    return drawingPlane(ctx).clone();
  }

  // ---- pointer -------------------------------------------------------------

  onDown(ctx: AppCtx, e: ToolEvent): void {
    const pm = this.editMesh(ctx);
    if (!pm || pm.lock) return;
    const hit = this.pick(ctx, e);
    this.pending = { x: e.x, y: e.y, hit, dragged: false };
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    const pm = this.editMesh(ctx);
    if (!pm) { clearPolyOverlay(); return; }
    polyOverlay.editMeshId = pm.id;

    // -- modal drags in flight --
    if (this.state.kind === 'MOVE') {
      const hit = this.pick(ctx, e, [this.state.vertexId]);
      const v = getVertex(pm, this.state.vertexId);
      if (v) {
        v.co = this.worldToLocal(ctx, pm, hit.world);
        v.binding = bindingFor(hit.source);
        this.state.moved = true;
        touchPolyMesh(pm);
      }
      this.updateHover(ctx, e, hit);
      return;
    }
    if (this.state.kind === 'EXTRUDE') {
      this.updateExtrude(ctx, e, pm);
      return;
    }

    // -- promote a pending press into a modal drag --
    if (this.pending && !this.pending.dragged
      && Math.hypot(e.x - this.pending.x, e.y - this.pending.y) > DRAG_PX) {
      this.pending.dragged = true;
      const src = this.pending.hit.source;
      if (this.state.kind === 'IDLE' && src.kind === 'POLY_VERTEX' && src.meshId === pm.id) {
        this.state = {
          kind: 'MOVE', meshId: pm.id, vertexId: src.vertexId,
          before: takeSnapshot(pm), plane: this.opPlane(ctx), moved: false,
        };
        return;
      }
      if (this.state.kind === 'IDLE' && src.kind === 'POLY_EDGE' && src.meshId === pm.id
        && isBoundaryEdge(pm, src.edgeId)) {
        this.beginExtrude(ctx, pm, src.edgeId);
        return;
      }
      // non-boundary edge, face, or empty-space drags do nothing modal
    }

    this.updateHover(ctx, e);
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    const pm = this.editMesh(ctx);
    if (!pm) { this.pending = null; return; }

    if (this.state.kind === 'MOVE') {
      const st = this.state;
      this.state = { kind: 'IDLE' };
      this.pending = null;
      if (st.moved) this.commit(ctx, pm, st.before);
      return;
    }
    if (this.state.kind === 'EXTRUDE') {
      this.finishExtrude(ctx, pm, e);
      return;
    }

    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.dragged) return;

    // -- Shift+click: element selection (Delete acts on it) --
    if (e.shift && this.state.kind === 'IDLE') {
      this.toggleSelect(ctx, pm, pending);
      return;
    }

    // -- click: construction --
    if (this.state.kind === 'IDLE') {
      const before = takeSnapshot(pm);
      const id = this.vertexFromHit(ctx, pm, pending.hit);
      if (id === null) { restoreSnapshot(pm, before); return; }
      this.state = {
        kind: 'BUILD', meshId: pm.id, vertexIds: [id],
        before, plane: this.opPlane(ctx),
      };
      polyOverlay.activeVertexIds = [id];
      return;
    }

    if (this.state.kind === 'BUILD') {
      const st = this.state;
      const chain = st.vertexIds;
      const id = this.vertexFromHit(ctx, pm, pending.hit);
      if (id === null || id === chain[chain.length - 1]) return;
      if (id === chain[0] && chain.length >= 3) {
        // close the loop -> one face (closing edge added by addFace)
        const face = addFace(pm, chain);
        if (!face) { cleanupDegenerateFaces(pm); }
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

  // ---- extrusion -----------------------------------------------------------

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
    // sticky camera-facing plane through the edge midpoint: the drag delta
    // lives on it, so depth stays stable for the whole operation
    const normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, mid);
    this.state = {
      kind: 'EXTRUDE', meshId: pm.id, srcEdgeId: edgeId,
      newVa: na.id, newVb: nb.id, before, plane, startWorld: mid,
    };
  }

  private planePoint(ctx: AppCtx, plane: THREE.Plane, x: number, y: number): THREE.Vector3 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.camera);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }

  private updateExtrude(ctx: AppCtx, e: ToolEvent, pm: TGPolyMesh): void {
    if (this.state.kind !== 'EXTRUDE') return;
    const st = this.state;
    const cur = this.planePoint(ctx, st.plane, e.x, e.y);
    if (!cur) return;
    const snap = JSON.parse(st.before) as Pick<TGPolyMesh, 'vertices' | 'edges'>;
    const srcEdge = getEdge(pm, st.srcEdgeId) ?? null;
    const origA = snap.vertices.find((v) => v.id === srcEdge?.v[0]);
    const origB = snap.vertices.find((v) => v.id === srcEdge?.v[1]);
    const na = getVertex(pm, st.newVa), nb = getVertex(pm, st.newVb);
    if (!origA || !origB || !na || !nb) return;
    // world delta -> local delta: transform both endpoints, subtract
    const inv = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id }).invert();
    const p0 = new THREE.Vector3().copy(st.startWorld).applyMatrix4(inv);
    const p1 = cur.clone().applyMatrix4(inv);
    const d = p1.sub(p0);
    na.co = [origA.co[0] + d.x, origA.co[1] + d.y, origA.co[2] + d.z];
    nb.co = [origB.co[0] + d.x, origB.co[1] + d.y, origB.co[2] + d.z];
    touchPolyMesh(pm);
    polyOverlay.previewPoint = null;
    polyOverlay.previewLine = null;
  }

  private finishExtrude(ctx: AppCtx, pm: TGPolyMesh, e: ToolEvent): void {
    if (this.state.kind !== 'EXTRUDE') return;
    const st = this.state;
    this.state = { kind: 'IDLE' };
    this.pending = null;
    // release-snap: merge each new endpoint into a nearby existing vertex
    // when that produces valid topology (mergeVertices rejects/cleans the
    // rest); the two new endpoints never merge into each other's quad side
    for (const newId of [st.newVa, st.newVb]) {
      const v = getVertex(pm, newId);
      if (!v) continue;
      const world = this.localToWorld(ctx, pm, v.co);
      const rect = ctx.canvas.getBoundingClientRect();
      const p = new THREE.Vector3(...world).project(ctx.camera);
      const sx = (p.x * 0.5 + 0.5) * rect.width, sy = (-p.y * 0.5 + 0.5) * rect.height;
      const target = pickPolyVertex(ctx, sx, sy, VERTEX_PX, pm.id, [st.newVa, st.newVb]);
      if (target && target.meshId === pm.id) mergeVertices(pm, newId, target.vertexId);
    }
    cleanupDegenerateFaces(pm);
    this.commit(ctx, pm, st.before);
    void e;
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
      const face = pm.faces.find((x) => x.id === f.faceId);
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
    for (const id of faces) removeFace(pm, id);
    for (const id of edges) removeEdge(pm, id);
    for (const id of verts) removeVertex(pm, id);
    ctx.refreshUI();
    return true;
  }

  // ---- keys ----------------------------------------------------------------

  onKey(ctx: AppCtx, key: string, e: KeyboardEvent): boolean {
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
    if (key === 'Delete' || key === 'Backspace' || key === 'x' || key === 'X') {
      if (this.state.kind !== 'IDLE') return false;
      return this.deleteSelected(ctx);
    }
    void e;
    return false;
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
