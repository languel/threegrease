// THE BASIS A TRANSFORM HAPPENS IN, and the point it happens about.
//
// Blender's transform header carries two settings that decide what an axis
// lock MEANS (Global / Local / Normal / Gimbal / View / Cursor / Parent) and
// what a rotation or scale turns about (Median / Bounding box / Cursor /
// Individual origins / Active). They are not about where a point lands —
// that is the Placement cluster — so they live here rather than in
// projection.ts, and BOTH modals (object G/R/S and the stroke / mesh-vertex
// one) read this file so the two cannot drift apart.
//
// Everything is returned as a world-space basis: three orthonormal columns,
// X, Y and Z of whatever "X, Y and Z" currently means. A lock then works in
// exactly one way everywhere — project the world delta onto the basis, keep
// the components the lock allows, and rebuild — and GLOBAL, the default, is
// simply the identity, so the old behaviour falls out of the general case.
import * as THREE from 'three';
import type { GPScene } from '../core/types';
import type { AppCtx } from './context';
import { parentWorldMatrixOf, worldMatrixOf, type ObjRef } from './objects';

/** A world-space orthonormal basis. Columns are the transform's X, Y, Z. */
export type Basis = THREE.Matrix4;

export const GLOBAL_BASIS: Basis = new THREE.Matrix4();

/** Orthonormalise, dropping any scale a matrix carries — a lock along a
 *  squashed object's X must still be a unit direction, or typed values and
 *  snap increments come out scaled by whatever the object happens to be. */
function basisOf(m: THREE.Matrix4): Basis {
  const q = new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return new THREE.Matrix4().makeRotationFromQuaternion(q);
}

/** A basis whose Z is `n` — for NORMAL orientation, and for N / Shift+N. */
export function basisFromNormal(n: THREE.Vector3): Basis {
  const z = n.clone().normalize();
  if (!z.lengthSq()) return GLOBAL_BASIS.clone();
  // any stable perpendicular: take the world axis the normal leans on least
  const seed = Math.abs(z.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(seed, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

/**
 * The basis for the current setting. `ref` is the object being transformed
 * (for LOCAL / GIMBAL / PARENT) and `normal` the element's own normal, which
 * only the caller knows — a face under the pointer, a stroke's plane, the
 * average of a vertex selection. Anything it cannot answer falls back to
 * GLOBAL rather than to something arbitrary: an axis lock that silently
 * means a different axis is worse than one that means the world's.
 */
export function transformBasis(
  ctx: AppCtx, ref?: ObjRef | null, normal?: THREE.Vector3 | null,
): Basis {
  const scene = ctx.scene;
  switch (ctx.settings.transformOrientation) {
    case 'LOCAL':
    case 'GIMBAL':
      // GIMBAL is the euler axes; ours are stored as XYZ eulers, whose first
      // axis IS the local X, so for a single rotation they agree. Keeping it
      // as an alias is honest about that rather than pretending to a
      // decomposition we do not have.
      return ref ? basisOf(worldMatrixOf(scene, ref)) : GLOBAL_BASIS.clone();
    case 'NORMAL':
      return normal && normal.lengthSq() ? basisFromNormal(normal)
        : ref ? basisOf(worldMatrixOf(scene, ref)) : GLOBAL_BASIS.clone();
    case 'VIEW': {
      // the screen: X right, Y up, Z toward the viewer
      return new THREE.Matrix4().makeRotationFromQuaternion(ctx.camera.quaternion);
    }
    case 'CURSOR':
      // our 3D cursor is a POINT (`scene.cursor` is a Vec3) — it carries no
      // rotation of its own to orient by, so this is the world's basis AT
      // the cursor. It still differs from GLOBAL as a PIVOT, which is the
      // half of the cursor people actually reach for.
      return GLOBAL_BASIS.clone();
    case 'PARENT':
      return ref ? basisOf(parentWorldMatrixOf(scene, ref)) : GLOBAL_BASIS.clone();
    case 'GLOBAL':
    default:
      return GLOBAL_BASIS.clone();
  }
}

/** The axis direction a lock means, in world space. */
export function axisVector(basis: Basis, axis: 'x' | 'y' | 'z'): THREE.Vector3 {
  const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const cols = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  basis.extractBasis(cols[0], cols[1], cols[2]);
  return cols[i].normalize();
}

/**
 * Constrain a world delta to a lock, IN the basis. One function for every
 * caller: take the delta into the basis, keep what the lock allows, take it
 * back. With the identity basis this is the component masking the modals
 * used to do by hand, so GLOBAL behaves exactly as before.
 */
export function constrainDelta(
  d: THREE.Vector3, basis: Basis, axis: 'none' | 'x' | 'y' | 'z', planeLock: boolean,
): THREE.Vector3 {
  if (axis === 'none') return d.clone();
  const inv = new THREE.Matrix4().copy(basis).invert();
  const local = d.clone().applyMatrix4(inv);
  const keep = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  for (let i = 0; i < 3; i++) {
    if ((i === keep) === planeLock) local.setComponent(i, 0);
  }
  return local.applyMatrix4(basis);
}

/**
 * Where a rotation or scale happens. MEDIAN is the average of the objects'
 * origins (what the app always did); BOUNDING_BOX the centre of everything
 * they span, which is a different point whenever the selection is lopsided;
 * CURSOR the 3D cursor; ACTIVE the last-picked object, so a ring of objects
 * turns about the one you are looking at. INDIVIDUAL has no single point —
 * each object turns about its own — so it answers null and the caller
 * transforms each object about its own origin instead.
 */
export function transformPivotPoint(
  ctx: AppCtx, refs: ObjRef[], active: ObjRef | null,
  boundsOf?: (ref: ObjRef) => THREE.Box3 | null,
): THREE.Vector3 | null {
  const scene = ctx.scene;
  if (!refs.length) return null;
  const originOfRef = (r: ObjRef) => new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(scene, r));
  switch (ctx.settings.transformPivot) {
    case 'CURSOR':
      return new THREE.Vector3(...scene.cursor);
    case 'ACTIVE': {
      const a = active && refs.some((r) => r.kind === active.kind && r.id === active.id)
        ? active : refs[refs.length - 1];
      return originOfRef(a);
    }
    case 'INDIVIDUAL':
      return null;
    case 'BOUNDING_BOX': {
      const box = new THREE.Box3();
      for (const r of refs) {
        const b = boundsOf?.(r);
        if (b && !b.isEmpty()) box.union(b);
        else box.expandByPoint(originOfRef(r));
      }
      return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
    }
    case 'MEDIAN':
    default: {
      const p = new THREE.Vector3();
      for (const r of refs) p.add(originOfRef(r));
      return p.divideScalar(refs.length);
    }
  }
}

/** An object's own origin, for INDIVIDUAL. */
export function originOf(scene: GPScene, ref: ObjRef): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(scene, ref));
}
