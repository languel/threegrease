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
  currentStickyPlane, currentStickySeed, drawingPlane, nearestStrokePointAll, nearestStrokeSegmentAll, perpendicularFoot,
  raycastFaceTriangle, raycastSurfaceHit, screenToWorld,
} from './projection';
import { allRefs, refOfObject3D, worldMatrixOf, type ObjRef } from './objects';
import { pickSplatPoint } from './splatpick';
import { pickElement } from './polypick';

/** What the returned point actually landed on — for HUD feedback, so the
 *  user can tell a real vertex hit from a fallback onto the drawing plane. */
export type SnapKind =
  | 'FREE' | 'VERTEX' | 'EDGE' | 'EDGE_CENTER' | 'EDGE_PERP'
  | 'SURFACE' | 'FACE_CENTER' | 'FACE_NEAREST' | 'OBJECT' | 'GRID';

export interface SnapHit {
  point: THREE.Vector3;
  kind: SnapKind;
  /**
   * WHAT the magnet caught, when it can say.
   *
   * A snap is normally a one-shot — the caller wants a world position and
   * nothing else. A measurement point wants to STAY on the thing, so it
   * needs the thing's identity as well; anything that resolves through a
   * raycast or an object origin can supply it, and the modes that work off
   * a plane or a lattice honestly cannot. Callers that don't care ignore
   * the field, which is why it is optional rather than a second function.
   */
  ref?: ObjRef | null;
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
      // EVERY vertex the app knows, nearest on screen wins: poly vertices,
      // stroke points, splat centres, a primitive's corners, and on a mesh
      // too big to walk (a room scan) the corners of the triangle under the
      // pointer. This used to offer stroke points alone (then splat centres),
      // so on a mesh the magnet did nothing and the point simply slid over
      // the surface — useless for picking the corners an alignment pairs.
      // The hit carries the object, so a measurement point BINDS to it.
      const el = pickElement(ctx, x, y, 'VERTEX', rect, {});
      if (el) return { point: new THREE.Vector3(...el.world), kind: 'VERTEX', ref: el.ref ?? undefined };
      if (scope !== 'ANY') {
        const hit = nearestStrokePointAll(ctx, x, y, PICK_PX, scope);
        if (hit) return { point: new THREE.Vector3(hit.x, hit.y, hit.z), kind: 'VERTEX' };
      }
      // nothing nearby: fall through to plane placement rather than refusing
      // to place anything
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
      // and a mesh's edges, for Edge: the same element picker
      if (snap.mode === 'EDGE') {
        const el = pickElement(ctx, x, y, 'EDGE', rect, {});
        if (el) return { point: new THREE.Vector3(...el.world), kind: 'EDGE', ref: el.ref ?? undefined };
      }
    }

    if (snap.mode === 'FACE_CENTER' || snap.mode === 'FACE_NEAREST') {
      const hit = raycastFaceTriangle(ctx, clientX, clientY);
      if (hit) {
        const p = new THREE.Vector3();
        if (snap.mode === 'FACE_CENTER' || !reference) hit.tri.getMidpoint(p);
        else hit.tri.closestPointToPoint(reference, p);
        return {
          point: p, ref: refOfObject3D(hit.object),
          kind: snap.mode === 'FACE_CENTER' ? 'FACE_CENTER' : 'FACE_NEAREST',
        };
      }
    }

    if (snap.mode === 'SURFACE' || snap.mode === 'CANVAS') {
      const hit = raycastSurfaceHit(ctx, clientX, clientY);
      if (hit) return { point: hit.point.clone(), kind: 'SURFACE', ref: refOfObject3D(hit.object) };
      // a scan that is not a draw target has no surface to raycast, but its
      // splat centres are still somewhere to put a point
      const sp = pickSplatPoint(ctx, x, y, 10);
      if (sp) return { point: new THREE.Vector3(...sp.world), kind: 'SURFACE', ref: { kind: 'SPLAT', id: sp.objectId } };
      // nothing under the pointer: fall through to plane placement
    }

    if (snap.mode === 'OBJECT') {
      const origin = nearestObjectOrigin(ctx, x, y, rect.width, rect.height);
      if (origin) return { point: origin.point, kind: 'OBJECT', ref: origin.ref };
    }
  }

  const world = screenToWorld(ctx, clientX, clientY);
  if (!world) return null;

  if (snap.enabled && (snap.mode === 'INCREMENT' || snap.mode === 'GRID')) {
    return { point: snapToLattice(ctx, world), kind: 'GRID' };
  }
  return { point: world, kind: 'FREE' };
}

/** Nearest object origin in SCREEN space, so picking behaves the same at
 *  every zoom level rather than getting harder as you zoom out. */
function nearestObjectOrigin(
  ctx: AppCtx, x: number, y: number, w: number, h: number,
): { point: THREE.Vector3; ref: ObjRef } | null {
  let best: { point: THREE.Vector3; ref: ObjRef } | null = null;
  let bestD = OBJECT_PX;
  for (const ref of allRefs(ctx.scene)) {
    // a ruler must not snap to its own origin, and neither should anything
    // else that is only ever an annotation of the scene
    if (ref.kind === 'MEASURE') continue;
    const pos = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(ctx.scene, ref));
    const ndc = pos.clone().project(ctx.camera);
    if (ndc.z > 1) continue;             // behind the camera
    const d = Math.hypot((ndc.x * 0.5 + 0.5) * w - x, (-ndc.y * 0.5 + 0.5) * h - y);
    if (d < bestD) { bestD = d; best = { point: pos, ref }; }
  }
  return best;
}

/**
 * Round onto the increment lattice — IN THE PLANE THE POINT IS BEING PUT ON.
 *
 * This used to raycast the floor and round there whatever the Plane said, so
 * a Top plane through an object standing 1 m up snapped every point down to
 * z = 0, and anything drawn on a wall snapped onto the floor under it. Now
 * the lattice lives in the active plane (the sticky one mid-stroke — Up from
 * Ground's wall, a ⊥ placement's standing plane — else the Plane setting's
 * own): an axis-aligned plane rounds its two in-plane world coordinates and
 * keeps the point's own coordinate across it, so the grid you see is the
 * grid you get; a tilted plane gets a lattice in its own basis (up-in-plane
 * and across), moving the point only WITHIN the plane. Plane: None has no
 * plane to respect and rounds all three coordinates.
 */
export function snapToLattice(ctx: AppCtx, world: THREE.Vector3, resting = false): THREE.Vector3 {
  const g = snapIncrement(ctx.settings);
  const r = (v: number) => Math.round(v / g) * g;
  if (ctx.settings.plane === 'NONE') return new THREE.Vector3(r(world.x), r(world.y), r(world.z));
  // a stroke's FIRST point snaps on the resting plane (Up from Ground's
  // floor), even though its own resolution has already captured the wall
  const sticky = resting ? null : currentStickyPlane();
  const plane = sticky ?? drawingPlane(ctx);
  const n = plane.normal;
  const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
  const k = ax.indexOf(Math.max(...ax));
  if (ax[k] > 0.9999) {
    const out = world.clone();
    for (let i = 0; i < 3; i++) if (i !== k) out.setComponent(i, r(out.getComponent(i)));
    return out;
  }
  const upV = ctx.settings.upAxis === 'Z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  let v = upV.clone().addScaledVector(n, -upV.dot(n));
  if (v.lengthSq() < 1e-6) v = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x);
  v.normalize();
  const u = new THREE.Vector3().crossVectors(v, n).normalize();
  const d = world.clone().sub((sticky && currentStickySeed()) || plane.coplanarPoint(new THREE.Vector3()));
  const du = d.dot(u), dv = d.dot(v);
  return world.clone().addScaledVector(u, r(du) - du).addScaledVector(v, r(dv) - dv);
}

/**
 * The magnet for a PLACED point of a stroke or shape: what the snap target
 * catches, or null when the magnet is off or caught nothing (so the caller's
 * own placement stands). A lattice snap rounds the point the caller's
 * placement already resolved, rather than re-resolving it, so it composes
 * with every Placement instead of overriding it.
 */
export function magnetPoint(
  ctx: AppCtx, clientX: number, clientY: number, resolved: THREE.Vector3 | null,
  /** the stroke's first point: lattice on the resting plane, not the sticky one */
  first = false,
): THREE.Vector3 | null {
  const snap = ctx.settings.snap;
  if (!snap.enabled) return null;
  if (snap.mode === 'INCREMENT' || snap.mode === 'GRID') return resolved ? snapToLattice(ctx, resolved, first) : null;
  const hit = snapWorldPoint(ctx, clientX, clientY, resolved ?? undefined);
  return hit && hit.kind !== 'FREE' ? hit.point : null;
}

/** Short label for the HUD, so a snapped point says what it caught. */
export const SNAP_LABEL: Record<SnapKind, string> = {
  FREE: '', VERTEX: 'vertex', EDGE: 'edge', EDGE_CENTER: 'midpoint',
  EDGE_PERP: 'perpendicular', SURFACE: 'surface', FACE_CENTER: 'face center',
  FACE_NEAREST: 'face', OBJECT: 'origin', GRID: 'grid',
};
