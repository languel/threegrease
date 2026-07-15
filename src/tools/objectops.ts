// Blender-parity Object menu operators (right-click context menu): Set
// Origin, Mirror, Clear, Apply, Snap. Generic ops work across every
// ObjKind via getObjectTransform/setObjectTransform; origin/geometry ops
// are GP-only (other kinds have no local-space geometry independent of
// their translation, so "moving the origin" would just move the object).
import * as THREE from 'three';
import type { GPObject, GPScene, GPStroke, TGMesh, Vec3 } from '../core/types';
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

function localBoundsGP(ob: GPObject): THREE.Box3 | null {
  const box = new THREE.Box3();
  let any = false;
  forEachPoint(ob, (p) => { box.expandByPoint(new THREE.Vector3(...p.co)); any = true; });
  return any ? box : null;
}

/** Canonical local-space bounds of the procedural primitive geometries
 *  built in render/meshes.ts (primitiveGeometry) — kept in sync with those
 *  constructors since we compute origin targets without touching three.js
 *  here (tools stay scene-only). MODEL geometry is arbitrary/loaded async,
 *  so it isn't supported by the origin-to-geometry ops. */
function primitiveLocalBounds(kind: TGMesh['kind']): THREE.Box3 | null {
  switch (kind) {
    case 'PLANE': return new THREE.Box3(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 0));
    case 'BOX': return new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
    case 'SPHERE': return new THREE.Box3(new THREE.Vector3(-0.6, -0.6, -0.6), new THREE.Vector3(0.6, 0.6, 0.6));
    case 'CYLINDER': return new THREE.Box3(new THREE.Vector3(-0.5, -0.6, -0.5), new THREE.Vector3(0.5, 0.6, 0.5));
    default: return null; // MODEL
  }
}

function meshLocalBounds(m: TGMesh): THREE.Box3 | null {
  const base = primitiveLocalBounds(m.kind);
  if (!base) return null;
  const off = new THREE.Vector3(...(m.originOffset ?? [0, 0, 0]));
  return base.translate(off);
}

/** World-space AABB of a local-space box under a transform: transforms all
 *  8 corners, not just min/max, so rotation is handled correctly — a
 *  rotated box's world-lowest point is generally NOT the world-transform
 *  of its local-min corner (that corner stops being the extremal one once
 *  rotated). Used by originToGeometryBase so "Base" means the rotated
 *  object's actual lowest point, not the unrotated local min. */
function worldAABB(localBox: THREE.Box3, matrix: THREE.Matrix4): THREE.Box3 {
  const { min, max } = localBox;
  const corners = [
    [min.x, min.y, min.z], [max.x, min.y, min.z], [min.x, max.y, min.z], [min.x, min.y, max.z],
    [max.x, max.y, min.z], [max.x, min.y, max.z], [min.x, max.y, max.z], [max.x, max.y, max.z],
  ];
  const box = new THREE.Box3();
  for (const [x, y, z] of corners) box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(matrix));
  return box;
}

/** Move a mesh's translation to `worldPoint`, compensating with
 *  originOffset (baked into the primitive's geometry by MeshManager) so the
 *  geometry doesn't move in world space — the MESH-kind analog of GP's
 *  retargetOrigin, since primitive geometry has no persisted vertex data of
 *  its own to shift directly. */
function retargetMeshOrigin(scene: GPScene, ref: ObjRef, m: TGMesh, worldPoint: THREE.Vector3): void {
  const newT = worldPoint.clone().applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
  const rsInv = new THREE.Matrix4().compose(
    new THREE.Vector3(), new THREE.Quaternion().setFromEuler(new THREE.Euler(...m.rotation)), new THREE.Vector3(...m.scale),
  ).invert();
  const oldT = new THREE.Vector3(...m.translation);
  const deltaLocal = oldT.clone().sub(newT).applyMatrix4(rsInv);
  const newOffset = new THREE.Vector3(...(m.originOffset ?? [0, 0, 0])).add(deltaLocal);
  m.originOffset = [newOffset.x, newOffset.y, newOffset.z];
  m.translation = [newT.x, newT.y, newT.z];
}

function meshWorldMatrix(m: TGMesh): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...m.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...m.rotation)),
    new THREE.Vector3(...m.scale),
  );
}

/** Blender "Origin to Geometry": origin moves to the object's geometric
 *  median; geometry doesn't move in world space. GP + primitive MESH kinds
 *  (image planes included — they're PLANE mesh objects, see HANDOFF). */
export function originToGeometry(scene: GPScene, ref: ObjRef): boolean {
  if (ref.kind === 'GP') {
    const ob = scene.objects.find((o) => o.id === ref.id);
    if (!ob) return false;
    const c = localCentroid(ob);
    if (!c) return false;
    const worldC = c.clone().applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    ));
    const newT = worldC.applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
    retargetOrigin(ob, [newT.x, newT.y, newT.z]);
    return true;
  }
  if (ref.kind === 'MESH') {
    const m = scene.meshes.find((mm) => mm.id === ref.id);
    if (!m) return false;
    const bounds = meshLocalBounds(m);
    if (!bounds) return false;
    const center = bounds.getCenter(new THREE.Vector3());
    retargetMeshOrigin(scene, ref, m, center.applyMatrix4(meshWorldMatrix(m)));
    return true;
  }
  return false;
}

/** New: "Origin to Geometry (Base)" — origin moves to the XY-center of the
 *  object's bottom face (min along the up axis), a natural pivot for
 *  staging/floor-placement. GP + primitive MESH kinds. */
export function originToGeometryBase(scene: GPScene, ref: ObjRef, upAxis: 'Y' | 'Z' = 'Z'): boolean {
  const axis = upAxis === 'Y' ? 1 : 2;
  if (ref.kind === 'GP') {
    const ob = scene.objects.find((o) => o.id === ref.id);
    if (!ob) return false;
    const box = localBoundsGP(ob);
    if (!box) return false;
    const worldMat = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    const wbox = worldAABB(box, worldMat);
    const worldBase = wbox.getCenter(new THREE.Vector3());
    worldBase.setComponent(axis, wbox.min.getComponent(axis));
    const newT = worldBase.applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
    retargetOrigin(ob, [newT.x, newT.y, newT.z]);
    return true;
  }
  if (ref.kind === 'MESH') {
    const m = scene.meshes.find((mm) => mm.id === ref.id);
    if (!m) return false;
    const bounds = meshLocalBounds(m);
    if (!bounds) return false;
    const wbox = worldAABB(bounds, meshWorldMatrix(m));
    const worldBase = wbox.getCenter(new THREE.Vector3());
    worldBase.setComponent(axis, wbox.min.getComponent(axis));
    retargetMeshOrigin(scene, ref, m, worldBase);
    return true;
  }
  return false;
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
 *  doesn't move in world space. GP + primitive MESH kinds. */
export function originToCursor(scene: GPScene, ref: ObjRef): boolean {
  if (ref.kind === 'GP') {
    const ob = scene.objects.find((o) => o.id === ref.id);
    if (!ob) return false;
    const cursor = new THREE.Vector3(...scene.cursor);
    const newT = cursor.clone().applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
    retargetOrigin(ob, [newT.x, newT.y, newT.z]);
    return true;
  }
  if (ref.kind === 'MESH') {
    const m = scene.meshes.find((mm) => mm.id === ref.id);
    if (!m) return false;
    retargetMeshOrigin(scene, ref, m, new THREE.Vector3(...scene.cursor));
    return true;
  }
  return false;
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
