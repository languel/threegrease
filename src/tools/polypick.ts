// Unified construction picking for the editable-mesh (topology pen) tool.
// One query returns a world point + metadata about WHAT was hit, resolved
// in a fixed priority order that the tool never has to know about:
//   1 poly vertex  2 poly edge  3 poly face  4 surface (mesh) raycast
//   5 GP stroke    6 splat center  7 drawing/override plane  8 view plane
// Isolated from tool behavior so priorities/thresholds can change without
// rewriting interactions.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { PathRef, TGVertexBinding, Vec3 } from '../core/types';
import { frameAt } from '../core/gpdata';
import { drawingPlane } from './projection';
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
  | { kind: 'FREE' };

export interface ConstructionHit {
  world: Vec3;
  normal?: Vec3;
  source: ConstructionSource;
  distancePx?: number;
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

// ---- unified query ---------------------------------------------------------

export function pickConstruction(ctx: AppCtx, x: number, y: number, opts: ConstructionOpts = {}): ConstructionHit {
  const vertexPx = opts.vertexPx ?? 14;
  const edgePx = opts.edgePx ?? 10;
  const strokePx = opts.strokePx ?? 12;
  const splatPx = opts.splatPx ?? 14;
  const rect = ctx.canvas.getBoundingClientRect();

  if (!opts.noSnap) {
    const v = pickPolyVertex(ctx, x, y, vertexPx, opts.editMeshId, opts.excludeVertexIds);
    if (v) {
      return {
        world: [v.world.x, v.world.y, v.world.z],
        source: { kind: 'POLY_VERTEX', meshId: v.meshId, vertexId: v.vertexId },
        distancePx: v.d,
      };
    }
    const e = pickPolyEdge(ctx, x, y, edgePx, opts.editMeshId);
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
