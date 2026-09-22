// Unified construction picking for the editable-mesh (topology pen) tool.
// One query returns a world point + metadata about WHAT was hit, resolved
// in a fixed priority order that the tool never has to know about:
//   1 poly vertex  2 poly edge  3 poly face  4 surface (mesh) raycast
//   5 GP stroke    6 splat center  7 drawing/override plane  8 view plane
// Isolated from tool behavior so priorities/thresholds can change without
// rewriting interactions.
import * as THREE from 'three';
import type { AppCtx } from './context';
import { refOfObject3D, type ObjRef } from './objects';
import type { PathRef, TGVertexBinding, Vec3 } from '../core/types';
import { frameAt } from '../core/gpdata';
import { drawingPlane, nearestStrokePointAll, nearestStrokeSegmentAll, raycastFaceTriangle, ignoredBySnap, raycastSurfaceHit } from './projection';
import { snapIncrement } from './context';
import { worldMatrixOf } from './objects';
import { pickPaintCloudPoint, pickSplatPoint } from './splatpick';

export type ConstructionSource =
  | { kind: 'POLY_VERTEX'; meshId: number; vertexId: number }
  | { kind: 'POLY_EDGE'; meshId: number; edgeId: number; t: number }
  | { kind: 'POLY_FACE'; meshId: number; faceId: number }
  | { kind: 'MESH'; objectId: number }
  | { kind: 'GP_STROKE'; path: PathRef; t: number }
  | { kind: 'SPLAT'; objectId: number; pointIndex?: number }
  | { kind: 'PCLOUD'; cloudId: number; pointIndex?: number }
  | { kind: 'PLANE' }
  /** a vertex/edge/face of something with no finer identity to report
   *  (a stroke point, a triangle corner) — Placement: Nearest's filters */
  | { kind: 'ELEMENT' }
  | { kind: 'FREE' };

export interface ConstructionHit {
  world: Vec3;
  normal?: Vec3;
  source: ConstructionSource;
  distancePx?: number;
  /** the OBJECT the element belongs to, when one does — what a measurement
   *  point binds to, so it rides that object through an alignment */
  ref?: ObjRef | null;
}

export interface ConstructionOpts {
  /** poly elements of this mesh are preferred and pickable */
  editMeshId?: number | null;
  /** vertex ids the query must ignore (the vertex being dragged) */
  excludeVertexIds?: number[];
  /** skip ALL source snapping — straight to the plane (Ctrl modifier) */
  noSnap?: boolean;
  /** sticky plane for the active operation (falls back to drawingPlane) */
  planeOverride?: THREE.Plane | null;
  vertexPx?: number;
  edgePx?: number;
  strokePx?: number;
  splatPx?: number;
  /** only this kind of element (Placement: Nearest's target); ELEMENT or
   *  absent = the full priority chain */
  only?: 'ELEMENT' | 'VERTEX' | 'EDGE' | 'FACE' | 'DRAW';
}

/** Vertex binding matching a construction source (provenance only). */
export function bindingFor(source: ConstructionSource): TGVertexBinding {
  switch (source.kind) {
    case 'GP_STROKE': return { kind: 'GP_STROKE', path: source.path, t: source.t };
    case 'SPLAT': return { kind: 'SPLAT', objectId: source.objectId, pointIndex: source.pointIndex };
    case 'PCLOUD': return { kind: 'PCLOUD', cloudId: source.cloudId, pointIndex: source.pointIndex };
    case 'MESH': return { kind: 'MESH', objectId: source.objectId };
    case 'PLANE': return { kind: 'PLANE' };
    default: return { kind: 'FREE' };
  }
}

function screenOf(ctx: AppCtx, world: THREE.Vector3, rect: DOMRect): THREE.Vector2 | null {
  const p = world.clone().project(ctx.camera);
  if (p.z > 1) return null;
  return new THREE.Vector2((p.x * 0.5 + 0.5) * rect.width, (-p.y * 0.5 + 0.5) * rect.height);
}

// ---- poly element picking (screen-space, sketch scale) ---------------------

export function pickPolyVertex(
  ctx: AppCtx, x: number, y: number, thresholdPx: number,
  preferMeshId?: number | null, excludeIds?: number[],
): { meshId: number; vertexId: number; world: THREE.Vector3; d: number } | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const excl = new Set(excludeIds ?? []);
  let best: { meshId: number; vertexId: number; world: THREE.Vector3; d: number } | null = null;
  for (const pm of ctx.scene.polyMeshes) {
    if (!pm.visible || pm.lock) continue;
    const world = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id });
    const prefer = pm.id === preferMeshId;
    for (const v of pm.vertices) {
      if (prefer && excl.has(v.id)) continue;
      const wp = new THREE.Vector3(...v.co).applyMatrix4(world);
      const s = screenOf(ctx, wp, rect);
      if (!s) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      // active-mesh vertices win ties (score bias, not a hard filter)
      const score = d - (prefer ? 2 : 0);
      if (d < thresholdPx && (!best || score < best.d)) {
        best = { meshId: pm.id, vertexId: v.id, world: wp, d: score };
      }
    }
  }
  return best;
}

export function pickPolyEdge(
  ctx: AppCtx, x: number, y: number, thresholdPx: number, preferMeshId?: number | null,
): { meshId: number; edgeId: number; t: number; world: THREE.Vector3; d: number } | null {
  const rect = ctx.canvas.getBoundingClientRect();
  let best: { meshId: number; edgeId: number; t: number; world: THREE.Vector3; d: number } | null = null;
  for (const pm of ctx.scene.polyMeshes) {
    if (!pm.visible || pm.lock) continue;
    const world = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id });
    const prefer = pm.id === preferMeshId;
    const co = new Map(pm.vertices.map((v) => [v.id, v.co] as const));
    for (const e of pm.edges) {
      const a = co.get(e.v[0]), b = co.get(e.v[1]);
      if (!a || !b) continue;
      const wa = new THREE.Vector3(...a).applyMatrix4(world);
      const wb = new THREE.Vector3(...b).applyMatrix4(world);
      const sa = screenOf(ctx, wa, rect), sb = screenOf(ctx, wb, rect);
      if (!sa || !sb) continue;
      const abx = sb.x - sa.x, aby = sb.y - sa.y;
      const len2 = abx * abx + aby * aby;
      const t = len2 < 1e-9 ? 0 : THREE.MathUtils.clamp(((x - sa.x) * abx + (y - sa.y) * aby) / len2, 0, 1);
      const d = Math.hypot(sa.x + abx * t - x, sa.y + aby * t - y);
      const score = d - (prefer ? 2 : 0);
      if (d < thresholdPx && (!best || score < best.d)) {
        best = { meshId: pm.id, edgeId: e.id, t, world: wa.clone().lerp(wb, t), d: score };
      }
    }
  }
  return best;
}

const raycaster = new THREE.Raycaster();

export function pickPolyFace(
  ctx: AppCtx, x: number, y: number,
): { meshId: number; faceId: number; world: THREE.Vector3; normal?: THREE.Vector3 } | null {
  if (!ctx.polyPick) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, ctx.camera);
  for (const h of raycaster.intersectObjects(ctx.polyPick.faceMeshes(), false)) {
    if (ignoredBySnap(h.object)) continue;
    const polyId = h.object.userData.polyId as number | undefined;
    if (polyId === undefined || h.faceIndex === undefined || h.faceIndex === null) continue;
    const pm = ctx.scene.polyMeshes.find((p) => p.id === polyId);
    if (!pm || pm.lock) continue;
    const faceId = ctx.polyPick.faceIdAt(polyId, h.faceIndex);
    if (faceId === null) continue;
    const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : undefined;
    return { meshId: polyId, faceId, world: h.point.clone(), normal };
  }
  return null;
}

// ---- GP stroke snapping (3D polyline, path identity preserved) -------------

export function pickStrokePoint(
  ctx: AppCtx, x: number, y: number, thresholdPx: number,
): { path: PathRef; t: number; world: THREE.Vector3; d: number } | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const projected = new THREE.Vector3();
  let best: { path: PathRef; t: number; world: THREE.Vector3; d: number } | null = null;
  ctx.scene.objects.forEach((ob, objectIndex) => {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        if (s.points.length < 2) continue;
        const proj = s.points.map((p) => {
          const world = new THREE.Vector3(...p.co).applyMatrix4(matrix);
          projected.copy(world).project(ctx.camera);
          if (projected.z > 1) return null;
          return { world, sx: (projected.x * 0.5 + 0.5) * rect.width, sy: (-projected.y * 0.5 + 0.5) * rect.height };
        });
        const segCount = s.cyclic ? s.points.length : s.points.length - 1;
        for (let i = 0; i < segCount; i++) {
          const a = proj[i], b = proj[(i + 1) % s.points.length];
          if (!a || !b) continue;
          const abx = b.sx - a.sx, aby = b.sy - a.sy;
          const len2 = abx * abx + aby * aby;
          const t = len2 < 1e-9 ? 0 :
            THREE.MathUtils.clamp(((x - a.sx) * abx + (y - a.sy) * aby) / len2, 0, 1);
          const d = Math.hypot(a.sx + abx * t - x, a.sy + aby * t - y);
          if (d < thresholdPx && (!best || d < best.d)) {
            best = {
              path: { objectIndex, layerId: layer.id, strokeId: s.id },
              t: (i + t) / Math.max(1, segCount),
              world: a.world.clone().lerp(b.world, t),
              d,
            };
          }
        }
      }
    }
  });
  return best;
}

// ---- one kind of element ----------------------------------------------------

/** Screen radius for Placement: Nearest's element filters — wider than the
 *  full chain's, since asking for "a vertex" means you want one found. */
const ELEMENT_PX = 24;

/**
 * The nearest element of ONE kind, across everything that has that kind:
 * a VERTEX is a poly vertex, a stroke point, a splat centre, or the corner of
 * the mesh triangle under the pointer; an EDGE is a poly edge, anywhere along
 * a stroke, or the nearest side of that triangle; a FACE is a poly face or a
 * mesh surface. Candidates compete on screen distance. The triangle is the
 * renderer's, so a box's face diagonal counts as an edge — a mesh has no
 * other record of which of its edges are "real".
 */
/**
 * A CONVENTIONAL MESH'S OWN VERTICES AND EDGES, in screen space.
 *
 * Vertex and edge snapping used to reach poly meshes, strokes, splats and
 * paint clouds — everything whose points live in `GPScene` — plus the
 * corners of whichever triangle happened to be UNDER the pointer. A box, a
 * cylinder or an imported model has its geometry only in the render tree,
 * so snapping to the corner of a plinth meant hovering one of its faces
 * first, and a corner approached through empty space offered nothing at
 * all. These are the objects a blockout is mostly made of.
 *
 * THE BUDGET IS THE WHOLE DESIGN. Walking a geometry per pointer-move is
 * fine for the primitives (a box is 24 vertices, a UV sphere 561) and
 * absurd for a room scan (162k, on every mouse move, while dragging). So a
 * mesh over `VERT_BUDGET` is skipped here and keeps the triangle-under-the-
 * pointer answer, which is exact where you are actually pointing and costs
 * one raycast. Small things you can snap to from anywhere; enormous things
 * you snap to by pointing at them.
 */
const VERT_BUDGET = 3000;

function meshElements(
  ctx: AppCtx, x: number, y: number, px: number, want: 'VERTEX' | 'EDGE',
): { world: THREE.Vector3; d: number; object: THREE.Object3D } | null {
  const rect = ctx.canvas.getBoundingClientRect();
  let best: { world: THREE.Vector3; d: number; object: THREE.Object3D } | null = null;
  const v = new THREE.Vector3();
  const project = (p: THREE.Vector3): { x: number; y: number; ok: boolean } => {
    const q = p.clone().project(ctx.camera);
    return { x: (q.x * 0.5 + 0.5) * rect.width, y: (-q.y * 0.5 + 0.5) * rect.height, ok: q.z <= 1 };
  };
  for (const root of ctx.pickableMeshes) {
    if (!root.visible || ignoredBySnap(root)) continue;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || !mesh.visible || ignoredBySnap(mesh)) return;
      const pos = mesh.geometry.getAttribute('position');
      if (!pos || pos.count > VERT_BUDGET) return;
      mesh.updateWorldMatrix(true, false);
      // project once, then work in 2D — the alternative is a projection per
      // edge test, three times over
      const screen: { x: number; y: number; ok: boolean }[] = [];
      const world: THREE.Vector3[] = [];
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        world.push(v.clone());
        screen.push(project(v));
      }
      if (want === 'VERTEX') {
        for (let i = 0; i < screen.length; i++) {
          if (!screen[i].ok) continue;
          const d = Math.hypot(screen[i].x - x, screen[i].y - y);
          if (d < px && (!best || d < best.d)) best = { world: world[i], d, object: mesh };
        }
        return;
      }
      const index = mesh.geometry.getIndex();
      const tris = index ? index.count / 3 : pos.count / 3;
      for (let t = 0; t < tris; t++) {
        const a = index ? index.getX(t * 3) : t * 3;
        const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        for (const [i, j] of [[a, b], [b, c], [c, a]] as const) {
          if (!screen[i]?.ok || !screen[j]?.ok) continue;
          const d = segmentDistPx(screen[i], screen[j], x, y);
          if (d.px < px && (!best || d.px < best.d)) {
            best = { world: world[i].clone().lerp(world[j], d.t), d: d.px, object: mesh };
          }
        }
      }
    });
  }
  return best;
}

/** Point-to-segment distance in screen px, and where along it. */
function segmentDistPx(
  a: { x: number; y: number }, b: { x: number; y: number }, x: number, y: number,
): { px: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
  return { px: Math.hypot(a.x + dx * t - x, a.y + dy * t - y), t };
}

export function pickElement(
  ctx: AppCtx, x: number, y: number, only: 'VERTEX' | 'EDGE' | 'FACE' | 'DRAW', rect: DOMRect, opts: ConstructionOpts,
): ConstructionHit | null {
  if (only === 'DRAW') {
    // ANY DRAW TARGET: the surface under the pointer, whatever it belongs
    // to — a scan, a plinth, a panel, a character. No element identity is
    // offered because none is meant: the question is "what is there", and
    // the answer has to be the same one Surface placement would give.
    const hit = raycastSurfaceHit(ctx, x + rect.left, y + rect.top);
    if (!hit) return null;
    const ref = refOfObject3D(hit.object);
    return {
      world: [hit.point.x, hit.point.y, hit.point.z],
      source: ref?.kind === 'MESH' ? { kind: 'MESH', objectId: ref.id } : { kind: 'ELEMENT' },
    };
  }
  const cands: { world: THREE.Vector3; d: number; source: ConstructionSource; ref?: ObjRef | null }[] = [];
  const dist = (w: THREE.Vector3) => {
    const s = screenOf(ctx, w, rect);
    return s ? Math.hypot(s.x - x, s.y - y) : Infinity;
  };
  const tri = only === 'FACE' ? null : raycastFaceTriangle(ctx, x + rect.left, y + rect.top);
  if (only === 'VERTEX') {
    const v = pickPolyVertex(ctx, x, y, ELEMENT_PX, opts.editMeshId, opts.excludeVertexIds);
    if (v) cands.push({ world: v.world, d: v.d, source: { kind: 'POLY_VERTEX', meshId: v.meshId, vertexId: v.vertexId }, ref: { kind: 'POLY', id: v.meshId } });
    const sp = nearestStrokePointAll(ctx, x, y, ELEMENT_PX);
    if (sp) cands.push({ world: sp, d: dist(sp), source: { kind: 'ELEMENT' } });
    const pc = pickPaintCloudPoint(ctx, x, y, ELEMENT_PX);
    if (pc) cands.push({ world: new THREE.Vector3(...pc.world), d: pc.d, source: { kind: 'PCLOUD', cloudId: pc.cloudId, pointIndex: pc.pointIndex } });
    const sk = pickSplatPoint(ctx, x, y, ELEMENT_PX);
    if (sk) cands.push({ world: new THREE.Vector3(...sk.world), d: sk.d, source: { kind: 'SPLAT', objectId: sk.objectId, pointIndex: sk.pointIndex }, ref: { kind: 'SPLAT', id: sk.objectId } });
    // a box's corner, a cylinder's rim: the geometry a blockout is made of
    const mv = meshElements(ctx, x, y, ELEMENT_PX, 'VERTEX');
    if (mv) cands.push({ world: mv.world, d: mv.d, source: { kind: 'ELEMENT' }, ref: refOfObject3D(mv.object) });
    if (tri) {
      // the corner of the face you are on — offered however far it is,
      // since being ON the face is what makes it the nearest vertex
      const corners = [tri.tri.a, tri.tri.b, tri.tri.c];
      const best = corners.reduce((m, c) => (dist(c) < dist(m) ? c : m));
      cands.push({ world: best.clone(), d: Math.max(dist(best), ELEMENT_PX - 0.01), source: { kind: 'ELEMENT' }, ref: refOfObject3D(tri.object) });
    }
  } else if (only === 'EDGE') {
    const e = pickPolyEdge(ctx, x, y, ELEMENT_PX, opts.editMeshId);
    if (e) cands.push({ world: e.world, d: e.d, source: { kind: 'POLY_EDGE', meshId: e.meshId, edgeId: e.edgeId, t: e.t }, ref: { kind: 'POLY', id: e.meshId } });
    const seg = nearestStrokeSegmentAll(ctx, x, y, ELEMENT_PX);
    if (seg) {
      const w = seg.a.clone().lerp(seg.b, seg.t);
      cands.push({ world: w, d: dist(w), source: { kind: 'ELEMENT' } });
    }
    const me = meshElements(ctx, x, y, ELEMENT_PX, 'EDGE');
    if (me) cands.push({ world: me.world, d: me.d, source: { kind: 'ELEMENT' }, ref: refOfObject3D(me.object) });
    if (tri) {
      const sides = [[tri.tri.a, tri.tri.b], [tri.tri.b, tri.tri.c], [tri.tri.c, tri.tri.a]];
      let best: THREE.Vector3 | null = null;
      for (const [a, b] of sides) {
        const p = new THREE.Line3(a, b).closestPointToPoint(tri.point, true, new THREE.Vector3());
        if (!best || p.distanceTo(tri.point) < best.distanceTo(tri.point)) best = p;
      }
      if (best) cands.push({ world: best, d: Math.max(dist(best), ELEMENT_PX - 0.01), source: { kind: 'ELEMENT' }, ref: refOfObject3D(tri.object) });
    }
  } else {
    const f = pickPolyFace(ctx, x, y);
    if (f) {
      return {
        world: [f.world.x, f.world.y, f.world.z],
        normal: f.normal ? [f.normal.x, f.normal.y, f.normal.z] : undefined,
        source: { kind: 'POLY_FACE', meshId: f.meshId, faceId: f.faceId },
      };
    }
    const hit = raycastFaceTriangle(ctx, x + rect.left, y + rect.top);
    if (hit) return { world: [hit.point.x, hit.point.y, hit.point.z], source: { kind: 'ELEMENT' } };
  }
  if (!cands.length) return null;
  const win = cands.reduce((m, c) => (c.d < m.d ? c : m));
  return { world: [win.world.x, win.world.y, win.world.z], source: win.source, distancePx: win.d, ref: win.ref ?? null };
}

// ---- unified query ---------------------------------------------------------

export function pickConstruction(ctx: AppCtx, x: number, y: number, opts: ConstructionOpts = {}): ConstructionHit {
  const vertexPx = opts.vertexPx ?? 14;
  const edgePx = opts.edgePx ?? 10;
  const strokePx = opts.strokePx ?? 12;
  const splatPx = opts.splatPx ?? 14;
  const rect = ctx.canvas.getBoundingClientRect();

  if (!opts.noSnap && opts.only && opts.only !== 'ELEMENT') {
    const hit = pickElement(ctx, x, y, opts.only, rect, opts);
    if (hit) return hit;
  }
  if (!opts.noSnap && (!opts.only || opts.only === 'ELEMENT')) {
    const v = pickPolyVertex(ctx, x, y, vertexPx, opts.editMeshId, opts.excludeVertexIds);
    const e = pickPolyEdge(ctx, x, y, edgePx, opts.editMeshId);
    // A VERTEX WINS ONLY WHEN IT IS ACTUALLY NEARER. This used to be a fixed
    // priority order — any vertex within threshold, however far, beat any
    // edge — so clicking the middle of a long edge to split it (inserting a
    // point to continue the chain from) could be "stolen" by an unrelated
    // corner elsewhere on the mesh that merely happened to fall within its
    // own 14px circle. The small bias keeps an exact vertex click reliable
    // when the two are genuinely close together.
    if (v && (!e || v.d - 2 <= e.d)) {
      return {
        world: [v.world.x, v.world.y, v.world.z],
        source: { kind: 'POLY_VERTEX', meshId: v.meshId, vertexId: v.vertexId },
        distancePx: v.d,
      };
    }
    if (e) {
      return {
        world: [e.world.x, e.world.y, e.world.z],
        source: { kind: 'POLY_EDGE', meshId: e.meshId, edgeId: e.edgeId, t: e.t },
        distancePx: e.d,
      };
    }
    const f = pickPolyFace(ctx, x, y);
    if (f) {
      return {
        world: [f.world.x, f.world.y, f.world.z],
        normal: f.normal ? [f.normal.x, f.normal.y, f.normal.z] : undefined,
        source: { kind: 'POLY_FACE', meshId: f.meshId, faceId: f.faceId },
      };
    }
    // conventional mesh surfaces (draw targets), skipping poly face meshes
    // (those were already offered above with element identity)
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.camera);
    for (const h of raycaster.intersectObjects(ctx.surfaces, true)) {
      if (ignoredBySnap(h.object)) continue;
      let cur: THREE.Object3D | null = h.object;
      let meshId: number | undefined;
      let isPoly = false;
      while (cur) {
        if (cur.userData.polyId !== undefined) { isPoly = true; break; }
        if (cur.userData.meshId !== undefined) { meshId = cur.userData.meshId; break; }
        cur = cur.parent;
      }
      if (isPoly) continue;
      if (meshId !== undefined) {
        const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : undefined;
        return {
          world: [h.point.x, h.point.y, h.point.z],
          normal: normal ? [normal.x, normal.y, normal.z] : undefined,
          source: { kind: 'MESH', objectId: meshId },
        };
      }
    }
    const s = pickStrokePoint(ctx, x, y, strokePx);
    if (s) {
      return {
        world: [s.world.x, s.world.y, s.world.z],
        source: { kind: 'GP_STROKE', path: s.path, t: s.t },
        distancePx: s.d,
      };
    }
    const pcp = pickPaintCloudPoint(ctx, x, y, splatPx);
    const sp = pickSplatPoint(ctx, x, y, splatPx);
    if (pcp && (!sp || pcp.d <= sp.d)) {
      return {
        world: pcp.world,
        source: { kind: 'PCLOUD', cloudId: pcp.cloudId, pointIndex: pcp.pointIndex },
        distancePx: pcp.d,
      };
    }
    if (sp) {
      return {
        world: sp.world,
        source: { kind: 'SPLAT', objectId: sp.objectId, pointIndex: sp.pointIndex },
        distancePx: sp.d,
      };
    }
  }

  // plane fallback: the operation's sticky plane, else the drawing plane.
  // Placement respects the global magnet: with snapping on in a lattice
  // mode, plane points land on the same Increment/Grid unit every other
  // tool uses (in-plane rounding, so points stay ON the plane).
  const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, ctx.camera);
  const plane = opts.planeOverride ?? drawingPlane(ctx);
  const out = new THREE.Vector3();
  const latticeSnap = (p: THREE.Vector3, pl: THREE.Plane): THREE.Vector3 => {
    const snap = ctx.settings.snap;
    if (!snap.enabled || (snap.mode !== 'INCREMENT' && snap.mode !== 'GRID')) return p;
    const g = snapIncrement(ctx.settings);
    const anchor = pl.normal.clone().multiplyScalar(-pl.constant);
    const tmp = Math.abs(pl.normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(tmp, pl.normal).normalize();
    const v = new THREE.Vector3().crossVectors(pl.normal, u);
    const d = p.clone().sub(anchor);
    return anchor.clone()
      .addScaledVector(u, Math.round(d.dot(u) / g) * g)
      .addScaledVector(v, Math.round(d.dot(v) / g) * g);
  };
  if (raycaster.ray.intersectPlane(plane, out)) {
    const s = latticeSnap(out, plane);
    return { world: [s.x, s.y, s.z], source: { kind: 'PLANE' } };
  }
  // grazing view: camera-facing plane through the 3D cursor never fails
  const normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
  const free = new THREE.Plane().setFromNormalAndCoplanarPoint(
    normal, new THREE.Vector3(...ctx.scene.cursor));
  raycaster.ray.intersectPlane(free, out);
  const s = latticeSnap(out, free);
  return { world: [s.x, s.y, s.z], source: { kind: 'FREE' } };
}
