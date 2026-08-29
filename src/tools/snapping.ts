// The magnet, as a function.
//
// This logic used to live inline in App.placeCursor, which meant the 3D
// cursor was the only thing in the app that could snap to a vertex, an edge,
// a face or an object origin. Anything else that wants a precise world point
// — the measure tool, and the blockout tools after it — needs exactly the
// same behaviour, so it is a function now and `placeCursor` is one of its
// callers rather than its owner.
//
// The ONE settings cluster (`settings.snap`) still drives it, so the magnet
// button in the topbar governs every consumer at once, which is the whole
// point of Blender's single magnet.
import * as THREE from 'three';
import type { AppCtx } from './context';
import { snapIncrement } from './context';
import {
  drawingPlane, nearestStrokePointAll, nearestStrokeSegmentAll, perpendicularFoot,
  raycastFaceTriangle, raycastSurfaces, screenToWorld,
} from './projection';
import { allRefs, worldMatrixOf } from './objects';

/** What the returned point actually landed on — for HUD feedback, so the
 *  user can tell a real vertex hit from a fallback onto the drawing plane. */
export type SnapKind =
  | 'FREE' | 'VERTEX' | 'EDGE' | 'EDGE_CENTER' | 'EDGE_PERP'
  | 'SURFACE' | 'FACE_CENTER' | 'FACE_NEAREST' | 'OBJECT' | 'GRID';

export interface SnapHit {
  point: THREE.Vector3;
  kind: SnapKind;
}

/** Screen-space search radius for the point/segment magnets, px. */
const PICK_PX = 60;
/** Object origins are sparser, so they get a wider grab than vertices. */
const OBJECT_PX = 80;

/**
 * Resolve a pointer position to a world point, honouring the global magnet.
 *
 * `reference` is the point being MOVED — EDGE_PERP drops a perpendicular
 * from it and FACE_NEAREST finds the closest point on a face to it, so both
 * are meaningless without knowing where you started. Callers that have no
 * such position (placing a brand-new point) can omit it; those two modes
 * then fall through to their non-relative behaviour.
 *
 * Returns null only when the pointer misses every surface AND the drawing
 * plane, which happens when the plane is exactly edge-on.
 */
export function snapWorldPoint(
  ctx: AppCtx, clientX: number, clientY: number, reference?: THREE.Vector3,
): SnapHit | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const snap = ctx.settings.snap;
  const scope = snap.strokeScope ?? 'ANY';

  if (snap.enabled) {
    if (snap.mode === 'POINT') {
      const hit = nearestStrokePointAll(ctx, x, y, PICK_PX, scope);
      // no stroke nearby: fall through to plane placement rather than
      // refusing to place anything
      if (hit) return { point: new THREE.Vector3(hit.x, hit.y, hit.z), kind: 'VERTEX' };
    }

    if (snap.mode === 'EDGE' || snap.mode === 'EDGE_CENTER' || snap.mode === 'EDGE_PERP') {
      // continuous along the path — this is how a point rides a stroke
      // freely instead of jumping vertex to vertex
      const seg = nearestStrokeSegmentAll(ctx, x, y, PICK_PX, scope);
      if (seg) {
        const point = snap.mode === 'EDGE_CENTER'
          ? seg.a.clone().lerp(seg.b, 0.5)
          : snap.mode === 'EDGE_PERP' && reference
            ? perpendicularFoot(seg.a, seg.b, reference)
            : seg.a.clone().lerp(seg.b, seg.t);
        const kind: SnapKind = snap.mode === 'EDGE_CENTER' ? 'EDGE_CENTER'
          : snap.mode === 'EDGE_PERP' && reference ? 'EDGE_PERP' : 'EDGE';
        return { point, kind };
      }
    }

    if (snap.mode === 'FACE_CENTER' || snap.mode === 'FACE_NEAREST') {
      const hit = raycastFaceTriangle(ctx, clientX, clientY);
      if (hit) {
        const p = new THREE.Vector3();
        if (snap.mode === 'FACE_CENTER' || !reference) hit.tri.getMidpoint(p);
        else hit.tri.closestPointToPoint(reference, p);
        return { point: p, kind: snap.mode === 'FACE_CENTER' ? 'FACE_CENTER' : 'FACE_NEAREST' };
      }
    }

    if (snap.mode === 'SURFACE' || snap.mode === 'CANVAS') {
      const hit = raycastSurfaces(ctx, clientX, clientY);
      if (hit) return { point: hit.clone(), kind: 'SURFACE' };
      // nothing under the pointer: fall through to plane placement
    }

    if (snap.mode === 'OBJECT') {
      const origin = nearestObjectOrigin(ctx, x, y, rect.width, rect.height);
      if (origin) return { point: origin, kind: 'OBJECT' };
    }
  }

  const world = screenToWorld(ctx, clientX, clientY);
  if (!world) return null;

  if (snap.enabled && (snap.mode === 'INCREMENT' || snap.mode === 'GRID')) {
    return { point: snapToLattice(ctx, world, clientX, clientY, rect), kind: 'GRID' };
  }
  return { point: world, kind: 'FREE' };
}

/** Nearest object origin in SCREEN space, so picking behaves the same at
 *  every zoom level rather than getting harder as you zoom out. */
function nearestObjectOrigin(
  ctx: AppCtx, x: number, y: number, w: number, h: number,
): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestD = OBJECT_PX;
  for (const ref of allRefs(ctx.scene)) {
    const pos = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(ctx.scene, ref));
    const ndc = pos.clone().project(ctx.camera);
    if (ndc.z > 1) continue;             // behind the camera
    const d = Math.hypot((ndc.x * 0.5 + 0.5) * w - x, (-ndc.y * 0.5 + 0.5) * h - y);
    if (d < bestD) { bestD = d; best = pos; }
  }
  return best;
}

/**
 * Round onto the increment lattice.
 *
 * Blender semantics: "grid" means the VISIBLE FLOOR grid, not a lattice on
 * whatever drawing plane happens to be active — so this raycasts the ground
 * and rounds the two in-plane coordinates. When the view is grazing enough
 * that the floor is edge-on (front/side ortho), that raycast is useless and
 * it falls back to the drawing plane's own lattice.
 */
function snapToLattice(
  ctx: AppCtx, world: THREE.Vector3, clientX: number, clientY: number, rect: DOMRect,
): THREE.Vector3 {
  const g = snapIncrement(ctx.settings);
  const zUp = ctx.settings.upAxis === 'Z';
  const groundNormal = zUp ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);

  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, ctx.camera);
  const hit = new THREE.Vector3();
  if (Math.abs(ray.ray.direction.dot(groundNormal)) > 0.05
    && ray.ray.intersectPlane(new THREE.Plane(groundNormal, 0), hit)) {
    return zUp
      ? new THREE.Vector3(Math.round(hit.x / g) * g, Math.round(hit.y / g) * g, 0)
      : new THREE.Vector3(Math.round(hit.x / g) * g, 0, Math.round(hit.z / g) * g);
  }

  const plane = drawingPlane(ctx);
  const anchor = plane.normal.clone().multiplyScalar(-plane.constant);
  const tmp = Math.abs(plane.normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(tmp, plane.normal).normalize();
  const v = new THREE.Vector3().crossVectors(plane.normal, u);
  const d = world.clone().sub(anchor);
  return anchor.clone()
    .addScaledVector(u, Math.round(d.dot(u) / g) * g)
    .addScaledVector(v, Math.round(d.dot(v) / g) * g);
}

/** Short label for the HUD, so a snapped point says what it caught. */
export const SNAP_LABEL: Record<SnapKind, string> = {
  FREE: '', VERTEX: 'vertex', EDGE: 'edge', EDGE_CENTER: 'midpoint',
  EDGE_PERP: 'perpendicular', SURFACE: 'surface', FACE_CENTER: 'face center',
  FACE_NEAREST: 'face', OBJECT: 'origin', GRID: 'grid',
};
