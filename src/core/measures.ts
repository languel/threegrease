// What a measurement IS, separately from the tool that draws one.
//
// A measure is a pen with a readout: the same magnets place its points, and
// like a pen it is an object with a transform, a parent and a place in the
// outliner. The one thing it has that a pen does not is that its points can
// be BOUND — stuck to the vertex, face or object they were snapped to, in
// that target's own local space, and resolved again every frame. A snap puts
// a point where the corner WAS; a bind keeps it on the corner. Dimensioning a
// blockout is worth very little without the second, because the blockout is
// the thing that keeps moving.
//
// Everything here is pure: scene data in, numbers out. The tool
// (`tools/measure.ts`) draws and edits; this file is what everyone else —
// the HUD, the panel, the scene rescale, the exporters — asks.
import * as THREE from 'three';
import type { GPScene, TGMeasure, TGMeasurePoint, Vec3 } from './types';

/** How many world units one display unit is. The scene is metres. */
const PER_UNIT: Record<string, number> = {
  M: 1, CM: 0.01, MM: 0.001, FT: 0.3048, IN: 0.0254,
};
const SUFFIX: Record<string, string> = {
  M: 'm', CM: 'cm', MM: 'mm', FT: 'ft', IN: 'in',
};

/** World length -> display string. Precision follows the unit: millimetres
 *  never want decimals, metres usually want two. */
export function formatLength(world: number, unit: string): string {
  const v = world / (PER_UNIT[unit] ?? 1);
  const dp = unit === 'MM' ? 0 : unit === 'CM' || unit === 'IN' ? 1 : 2;
  return `${v.toFixed(dp)} ${SUFFIX[unit] ?? 'm'}`;
}

/** World area -> display string, in the square of the display unit. */
export function formatArea(world: number, unit: string): string {
  const per = PER_UNIT[unit] ?? 1;
  const v = world / (per * per);
  return `${v.toFixed(unit === 'MM' ? 0 : 2)} ${SUFFIX[unit] ?? 'm'}²`;
}

/** Display value -> world length, for typed input. */
export function toWorldLength(value: number, unit: string): number {
  return value * (PER_UNIT[unit] ?? 1);
}

export function measureLocalMatrix(m: TGMeasure): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...m.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...m.rotation)),
    new THREE.Vector3(...m.scale),
  );
}

/**
 * The world position of one point.
 *
 * A bound point is resolved through its TARGET and ignores the measure's own
 * transform — the target owns it, which is the point of binding. If the
 * target has been deleted the stored `pos` stands in, so a measurement
 * degrades to a plain ruler rather than collapsing to the origin.
 *
 * `matrixOf` and `jointOf` are injected because this file is core data and
 * the object graph lives in `tools/objects.ts`; passing them in keeps the
 * dependency pointing the right way.
 */
export function resolvePoint(
  p: TGMeasurePoint,
  measureWorld: THREE.Matrix4,
  matrixOf: (target: { kind: string; id: number }) => THREE.Matrix4 | null,
  jointOf?: (actorId: number, joint: string) => THREE.Vector3 | null,
): THREE.Vector3 {
  const b = p.bind;
  if (b) {
    if (b.joint && b.target.kind === 'ACTOR' && jointOf) {
      const at = jointOf(b.target.id, b.joint);
      const mat = matrixOf(b.target);
      if (at && mat) {
        // the offset rides the actor's own frame, so it keeps its side of
        // the body when the character turns
        return at.clone().add(new THREE.Vector3(...b.local).applyMatrix4(
          new THREE.Matrix4().extractRotation(mat),
        ));
      }
    }
    const mat = matrixOf(b.target);
    if (mat) return new THREE.Vector3(...b.local).applyMatrix4(mat);
  }
  return new THREE.Vector3(...p.pos).applyMatrix4(measureWorld);
}

export interface MeasureResolvers {
  matrixOf: (target: { kind: string; id: number }) => THREE.Matrix4 | null;
  measureMatrix: (m: TGMeasure) => THREE.Matrix4;
  jointOf?: (actorId: number, joint: string) => THREE.Vector3 | null;
}

/** Every point of a measurement, in world space, in order. */
export function measureWorldPoints(m: TGMeasure, r: MeasureResolvers): THREE.Vector3[] {
  const world = r.measureMatrix(m);
  return m.points.map((p) => resolvePoint(p, world, r.matrixOf, r.jointOf));
}

/** Total length along the path (round trip when it is closed). */
export function pathLength(pts: THREE.Vector3[], closed = false): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += pts[i].distanceTo(pts[i + 1]);
  if (closed && pts.length > 2) total += pts[pts.length - 1].distanceTo(pts[0]);
  return total;
}

/**
 * Area of a closed path, by Newell's method.
 *
 * Newell gives the correct answer for any planar polygon at any orientation
 * — the cross-product sum IS twice the area vector — and a sensible one for
 * a slightly non-planar ring, which is what a measurement traced around a
 * real corner always is. Projecting onto a coordinate plane instead would
 * report a wall's area as zero the moment it stood up.
 */
export function polygonArea(pts: THREE.Vector3[]): number {
  if (pts.length < 3) return 0;
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.length() / 2;
}

let nextMeasureId = 1;
export function createMeasure(
  existing: TGMeasure[], points: TGMeasurePoint[],
): TGMeasure {
  nextMeasureId = Math.max(nextMeasureId, ...existing.map((m) => m.id), 0) + 1;
  return {
    id: nextMeasureId,
    name: `Measure ${existing.length + 1}`,
    points: points.map((p) => ({ pos: [...p.pos] as Vec3, bind: p.bind ?? null })),
    visible: true,
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    parent: null,
  };
}

/** A free point at a world position, expressed in a measure's own space. */
export function localPoint(m: TGMeasure, world: THREE.Vector3): Vec3 {
  const inv = measureLocalMatrix(m).invert();
  const v = world.clone().applyMatrix4(inv);
  return [v.x, v.y, v.z];
}

export function findMeasure(scene: GPScene, id: number): TGMeasure | undefined {
  return scene.measures.find((m) => m.id === id);
}
