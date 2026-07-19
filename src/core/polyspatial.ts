// Spatial queries over TGPolyMesh topology — the generalized mesh as a
// durable spatial structure (proximity, trigger zones, future collision/
// simulation), independent of the editing tool and of renderer objects.
// A mesh contributes all three dimensions: every vertex as a point, every
// edge as a segment, every face as derived triangles. Distance queries take
// the true minimum, tie-breaking toward the HIGHER dimension (a point lying
// on a face reports the face, not the coincident corner vertex) so results
// name the most specific containing element.
import * as THREE from 'three';
import type { GPScene, TGPolyMesh, Vec3 } from './types';
import { worldMatrixOf } from '../tools/objects';
import { triangulateFace } from '../render/polymesh';

export interface PolyMeshSpatialPrimitives {
  /** every vertex (isolated or not) */
  points: Array<{ elementId: number; point: Vec3 }>;
  /** every explicit edge */
  segments: Array<{ elementId: number; a: Vec3; b: Vec3 }>;
  /** derived triangles of every face */
  triangles: Array<{ faceId: number; a: Vec3; b: Vec3; c: Vec3 }>;
}

/** World-space primitive soup for one mesh (parent chain applied). */
export function polyMeshWorldPrimitives(scene: GPScene, pm: TGPolyMesh): PolyMeshSpatialPrimitives {
  const world = worldMatrixOf(scene, { kind: 'POLY', id: pm.id });
  const toWorld = (co: Vec3): Vec3 => {
    const v = new THREE.Vector3(...co).applyMatrix4(world);
    return [v.x, v.y, v.z];
  };
  const wco = new Map(pm.vertices.map((v) => [v.id, toWorld(v.co)] as const));
  const points = pm.vertices.map((v) => ({ elementId: v.id, point: wco.get(v.id)! }));
  const segments: PolyMeshSpatialPrimitives['segments'] = [];
  for (const e of pm.edges) {
    const a = wco.get(e.v[0]), b = wco.get(e.v[1]);
    if (a && b) segments.push({ elementId: e.id, a, b });
  }
  const triangles: PolyMeshSpatialPrimitives['triangles'] = [];
  for (const f of pm.faces) {
    const boundary = f.vertices.map((id) => wco.get(id)).filter((c): c is Vec3 => !!c);
    if (boundary.length !== f.vertices.length || boundary.length < 3) continue;
    for (const [a, b, c] of triangulateFace(boundary)) {
      triangles.push({ faceId: f.id, a: boundary[a], b: boundary[b], c: boundary[c] });
    }
  }
  return { points, segments, triangles };
}

export interface PolyDistanceResult {
  distance: number;
  closest: Vec3;
  /** 0 = vertex, 1 = edge, 2 = face */
  dimension: 0 | 1 | 2;
  elementId: number;
  meshId: number;
}

const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _line = new THREE.Line3();
const _tri = new THREE.Triangle();

/** Minimum distance from a world point to the mesh's points, segments, and
 *  triangles. Optional `prims` reuses a precomputed primitive soup (cache
 *  per operation when querying many points against one mesh). */
export function distancePointToPolyMesh(
  scene: GPScene, pm: TGPolyMesh, point: Vec3, prims?: PolyMeshSpatialPrimitives,
): PolyDistanceResult | null {
  const P = prims ?? polyMeshWorldPrimitives(scene, pm);
  _p.set(...point);
  let best: PolyDistanceResult | null = null;
  const EPS = 1e-9;
  const consider = (d: number, closest: THREE.Vector3, dimension: 0 | 1 | 2, elementId: number) => {
    // strict improvement wins; near-ties prefer the higher dimension
    if (!best || d < best.distance - EPS || (d < best.distance + EPS && dimension > best.dimension)) {
      best = { distance: d, closest: [closest.x, closest.y, closest.z], dimension, elementId, meshId: pm.id };
    }
  };
  for (const t of P.triangles) {
    _tri.set(_a.set(...t.a), _b.set(...t.b), _c.set(...t.c));
    _tri.closestPointToPoint(_p, _closest);
    consider(_closest.distanceTo(_p), _closest, 2, t.faceId);
  }
  for (const s of P.segments) {
    _line.set(_a.set(...s.a), _b.set(...s.b));
    _line.closestPointToPoint(_p, true, _closest);
    consider(_closest.distanceTo(_p), _closest, 1, s.elementId);
  }
  for (const pt of P.points) {
    _closest.set(...pt.point);
    consider(_closest.distanceTo(_p), _closest, 0, pt.elementId);
  }
  return best;
}

/** True when a world-space sphere touches ANY vertex, edge segment, or
 *  face triangle of the mesh (early-out on the first hit). */
export function intersectsSpherePolyMesh(
  scene: GPScene, pm: TGPolyMesh, center: Vec3, radius: number,
  prims?: PolyMeshSpatialPrimitives,
): boolean {
  const P = prims ?? polyMeshWorldPrimitives(scene, pm);
  _p.set(...center);
  for (const t of P.triangles) {
    _tri.set(_a.set(...t.a), _b.set(...t.b), _c.set(...t.c));
    _tri.closestPointToPoint(_p, _closest);
    if (_closest.distanceTo(_p) <= radius) return true;
  }
  for (const s of P.segments) {
    _line.set(_a.set(...s.a), _b.set(...s.b));
    _line.closestPointToPoint(_p, true, _closest);
    if (_closest.distanceTo(_p) <= radius) return true;
  }
  for (const pt of P.points) {
    if (_closest.set(...pt.point).distanceTo(_p) <= radius) return true;
  }
  return false;
}
