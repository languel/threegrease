// Blender-parity Object menu operators (right-click context menu): Set
// Origin, Mirror, Clear, Apply, Snap. Generic ops work across every
// ObjKind via getObjectTransform/setObjectTransform; origin/geometry ops
// are GP-only (other kinds have no local-space geometry independent of
// their translation, so "moving the origin" would just move the object).
import * as THREE from 'three';
import type { GPObject, GPScene, GPStroke, Vec3 } from '../core/types';
import { createFrame, createLayer, createObject, frameAt } from '../core/gpdata';
import {
  applyObjectTransform, getObjectTransform, listSelected, parentWorldMatrixOf, setObjectTransform,
  type ObjRef,
} from './objects';

// ------------------------------------------------------------- mirror

export function mirrorObject(scene: GPScene, ref: ObjRef, axis: 0 | 1 | 2): void {
  const t = getObjectTransform(scene, ref);
  if (!t) return;
  t.scale[axis] *= -1;
  setObjectTransform(scene, ref, t);
}

// -------------------------------------------------------------- clear

export type ClearWhich = 'LOC' | 'ROT' | 'SCALE' | 'ALL';

export function clearObjectTransform(scene: GPScene, ref: ObjRef, which: ClearWhich): void {
  const t = getObjectTransform(scene, ref);
  if (!t) return;
  if (which === 'LOC' || which === 'ALL') t.translation = [0, 0, 0];
  if (which === 'ROT' || which === 'ALL') t.rotation = [0, 0, 0];
  if (which === 'SCALE' || which === 'ALL') t.scale = [1, 1, 1];
  setObjectTransform(scene, ref, t);
}

// -------------------------------------------------------------- snap

export function snapSelectionToCursor(scene: GPScene): void {
  const cursor = new THREE.Vector3(...scene.cursor);
  for (const ref of listSelected(scene)) {
    const t = getObjectTransform(scene, ref);
    if (!t) continue;
    const local = cursor.clone().applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
    t.translation = [local.x, local.y, local.z];
    setObjectTransform(scene, ref, t);
  }
}

export function snapCursorToSelectionMedian(scene: GPScene, pivot: THREE.Vector3 | null): void {
  if (pivot) scene.cursor = [pivot.x, pivot.y, pivot.z];
}

// -------------------------------------------------------- GP origin ops

/** R*S only (no translation) — the linear map from object-local point
 *  space to parent-local space, used to keep world-space geometry fixed
 *  while the origin (translation) moves. */
function rsMatrix(ob: GPObject): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation));
  return new THREE.Matrix4().compose(new THREE.Vector3(), q, new THREE.Vector3(...ob.scale));
}

function forEachPoint(ob: GPObject, fn: (p: { co: Vec3 }) => void): void {
  for (const layer of ob.layers) for (const frame of layer.frames) for (const s of frame.strokes) {
    for (const p of s.points) fn(p);
  }
}

/** Move the origin (translation) to `newTranslation` (parent-local space)
 *  while shifting every point so the geometry doesn't move in world space. */
function retargetOrigin(ob: GPObject, newTranslation: Vec3): void {
  const rsInv = rsMatrix(ob).invert();
  const oldT = new THREE.Vector3(...ob.translation);
  const newT = new THREE.Vector3(...newTranslation);
  const deltaLocal = oldT.clone().sub(newT).applyMatrix4(rsInv);
  forEachPoint(ob, (p) => {
    const v = new THREE.Vector3(...p.co).add(deltaLocal);
    p.co = [v.x, v.y, v.z];
  });
  ob.translation = [...newTranslation];
}

function localCentroid(ob: GPObject): THREE.Vector3 | null {
  const c = new THREE.Vector3();
  let n = 0;
  forEachPoint(ob, (p) => { c.add(new THREE.Vector3(...p.co)); n++; });
  return n ? c.divideScalar(n) : null;
}

/** Blender "Origin to Geometry": origin moves to the object's geometric
 *  median; geometry doesn't move in world space. */
export function originToGeometry(scene: GPScene, ref: ObjRef): boolean {
  if (ref.kind !== 'GP') return false;
  const ob = scene.objects.find((o) => o.id === ref.id);
  if (!ob) return false;
  const c = localCentroid(ob);
  if (!c) return false;
  // world position of the local centroid, converted back to parent-local
  const worldC = c.clone().applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(...ob.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
    new THREE.Vector3(...ob.scale),
  ));
  const newT = worldC.applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
  retargetOrigin(ob, [newT.x, newT.y, newT.z]);
  return true;
}

/** Blender "Geometry to Origin": geometry shifts so its median lands on
 *  the (unmoved) origin. */
export function geometryToOrigin(scene: GPScene, ref: ObjRef): boolean {
  if (ref.kind !== 'GP') return false;
  const ob = scene.objects.find((o) => o.id === ref.id);
  if (!ob) return false;
  const c = localCentroid(ob);
  if (!c) return false;
  forEachPoint(ob, (p) => {
    const v = new THREE.Vector3(...p.co).sub(c);
    p.co = [v.x, v.y, v.z];
  });
  return true;
}

/** Blender "Origin to 3D Cursor": origin moves to the cursor; geometry
 *  doesn't move in world space. */
export function originToCursor(scene: GPScene, ref: ObjRef): boolean {
  if (ref.kind !== 'GP') return false;
  const ob = scene.objects.find((o) => o.id === ref.id);
  if (!ob) return false;
  const cursor = new THREE.Vector3(...scene.cursor);
  const newT = cursor.clone().applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
  retargetOrigin(ob, [newT.x, newT.y, newT.z]);
  return true;
}

/** Origin to the first point of the first stroke (layer/frame order) —
 *  a natural pivot for a traveler/path object. */
export function originToFirstPoint(scene: GPScene, ref: ObjRef): boolean {
  if (ref.kind !== 'GP') return false;
  const ob = scene.objects.find((o) => o.id === ref.id);
  if (!ob) return false;
  let firstPt: Vec3 | null = null;
  outer: for (const layer of ob.layers) {
    for (const frame of layer.frames) {
      for (const s of frame.strokes) {
        if (s.points.length) { firstPt = s.points[0].co; break outer; }
      }
    }
  }
  if (!firstPt) return false;
  const world = new THREE.Vector3(...firstPt).applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(...ob.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
    new THREE.Vector3(...ob.scale),
  ));
  const newT = world.applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
  retargetOrigin(ob, [newT.x, newT.y, newT.z]);
  return true;
}

/**
 * Blender "Separate by Loose Parts", GP-flavored: partitions the CURRENT
 * FRAME's strokes (across every layer of the object) into connected
 * components by endpoint proximity — the same graph selectConnected (Ctrl+L)
 * grows from a seed, but here every stroke is a seed, partitioning the
 * whole object. Each component beyond the first becomes a new GP object
 * (world transform + materials preserved); every resulting object
 * (original included) gets its origin set to the first point of its own
 * first stroke via originToFirstPoint.
 *
 * Scoped to the current frame only: strokes on other keyframes of the
 * same layers are untouched and stay on the original object — GP
 * connectivity can change over time, and splitting that consistently
 * across every keyframe is a separate, harder problem.
 */
export function separateConnectedIntoObjects(scene: GPScene, ref: ObjRef, tol = 0.05): number {
  if (ref.kind !== 'GP') return 0;
  const ob = scene.objects.find((o) => o.id === ref.id);
  if (!ob) return 0;

  interface Entry { layer: import('../core/types').GPLayer; stroke: GPStroke }
  const entries: Entry[] = [];
  for (const layer of ob.layers) {
    const frame = frameAt(layer, scene.frame);
    if (!frame) continue;
    for (const stroke of frame.strokes) entries.push({ layer, stroke });
  }
  if (entries.length < 2) { originToFirstPoint(scene, ref); return 0; }

  const tol2 = tol * tol;
  const d2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const ends = (s: GPStroke): Vec3[] => (s.cyclic || s.points.length < 2)
    ? s.points.map((p) => p.co)
    : [s.points[0].co, s.points[s.points.length - 1].co];

  const visited = new Set<Entry>();
  const groups: Entry[][] = [];
  for (const seed of entries) {
    if (visited.has(seed)) continue;
    const group = [seed];
    visited.add(seed);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of entries) {
        if (visited.has(e)) continue;
        const se = ends(e.stroke);
        for (const g of group) {
          if (se.some((a) => ends(g.stroke).some((b) => d2(a, b) < tol2))) {
            group.push(e); visited.add(e); grew = true; break;
          }
        }
      }
    }
    groups.push(group);
  }

  if (groups.length < 2) { originToFirstPoint(scene, ref); return 0; }

  let created = 0;
  for (let gi = 1; gi < groups.length; gi++) {
    const group = groups[gi];
    const newOb = createObject(`${ob.name} ${gi + 1}`);
    newOb.translation = [...ob.translation];
    newOb.rotation = [...ob.rotation];
    newOb.scale = [...ob.scale];
    newOb.materials = ob.materials.map((m) => ({ ...m }));
    newOb.activeMaterial = ob.activeMaterial;
    newOb.layers = [];
    const layerMap = new Map<number, import('../core/types').GPLayer>();
    for (const { layer, stroke } of group) {
      const frame = layer.frames.find((f) => f.strokes.includes(stroke));
      if (frame) frame.strokes.splice(frame.strokes.indexOf(stroke), 1);
      let newLayer = layerMap.get(layer.id);
      if (!newLayer) { newLayer = createLayer(layer.name); layerMap.set(layer.id, newLayer); newOb.layers.push(newLayer); }
      let newFrame = newLayer.frames.find((f) => f.frameNumber === scene.frame);
      if (!newFrame) { newFrame = createFrame(scene.frame); newLayer.frames.push(newFrame); }
      newFrame.strokes.push(stroke);
    }
    if (!newOb.layers.length) continue;
    newOb.activeLayerId = newOb.layers[0].id;
    const newRef: ObjRef = { kind: 'GP', id: newOb.id };
    const insertAt = scene.objects.indexOf(ob) + created + 1;
    scene.objects.splice(insertAt, 0, newOb);
    originToFirstPoint(scene, newRef);
    created++;
  }
  originToFirstPoint(scene, ref);
  return created;
}

// ------------------------------------------------------------- apply

export type ApplyWhich = 'LOC' | 'ROT' | 'SCALE' | 'ALL';

/** Blender Apply ▶ Location/Rotation/Scale/All Transforms. Only GP has a
 *  separate local geometry to bake into (see the origin ops above) — for
 *  mesh/splat/trigger, 'ALL' folds into the baked matrix (objects.ts) and
 *  partial LOC/ROT/SCALE isn't offered. */
export function applyObjectTransformPartial(scene: GPScene, ref: ObjRef, which: ApplyWhich): boolean {
  if (which === 'ALL') return applyObjectTransform(scene, ref);
  if (ref.kind !== 'GP') return false;
  const ob = scene.objects.find((o) => o.id === ref.id);
  if (!ob) return false;

  if (which === 'LOC') {
    retargetOrigin(ob, [0, 0, 0]);
    return true;
  }
  const S = new THREE.Vector3(...ob.scale);
  if (which === 'ROT') {
    const Sm = new THREE.Matrix4().makeScale(S.x, S.y, S.z);
    const M = Sm.clone().invert()
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation))))
      .multiply(Sm);
    forEachPoint(ob, (p) => {
      const v = new THREE.Vector3(...p.co).applyMatrix4(M);
      p.co = [v.x, v.y, v.z];
    });
    ob.rotation = [0, 0, 0];
    return true;
  }
  if (which === 'SCALE') {
    const meanScale = (Math.abs(S.x) + Math.abs(S.y) + Math.abs(S.z)) / 3;
    for (const layer of ob.layers) for (const frame of layer.frames) for (const s of frame.strokes) {
      for (const p of s.points) p.co = [p.co[0] * S.x, p.co[1] * S.y, p.co[2] * S.z];
      if (s.style.unit === 'SCENE') s.lineWidth *= meanScale;
    }
    ob.scale = [1, 1, 1];
    return true;
  }
  return false;
}
