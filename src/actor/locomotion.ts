// The walking body: what stops a character, and what holds it up.
//
// Shared by everything that moves an actor's ROOT — you driving it
// (app/possess.ts) and it walking itself somewhere (actor/steering.ts) —
// because a character should not collide differently depending on who is
// steering. Nothing here touches the pose: it moves the root, and the gait
// answers, exactly as it does for a path traveler.
//
// Collision is world-AABB push-out over the same `meshLocalBounds` the
// TRIGGER zones use, deliberately rather than a physics engine: it is
// conservative for rotated geometry, exact for the axis-aligned rooms
// people actually block out, and it costs nothing to reason about when a
// character stops somewhere surprising. The one rule that carries most of
// the weight is that anything whose top is within a STEP HEIGHT counts as
// ground rather than as a wall, which makes floors, pedestals and steps one
// case instead of three.
import * as THREE from 'three';
import type { GPScene, TGActor } from '../core/types';
import { meshLocalBounds, worldAABB } from '../tools/objectops';
import { worldMatrixOf } from '../tools/objects';

/** A degenerate (zero-thickness) AABB has no inside to push out of, so
 *  PLANE walls get a nominal thickness. It grows DOWNWARD only (min, never
 *  max) so a floor plane keeps its surface exactly where it is — inflating
 *  symmetrically would stand everybody a centimetre above the ground. */
const MIN_THICK = 0.02;

export interface WalkBody {
  /** body radius used for wall push-out */
  radius: number;
  /** how tall a ledge may be and still count as ground rather than a wall */
  stepHeight: number;
  /** standing height, for deciding what is overhead */
  height: number;
}

export class WalkVolume {
  boxes: THREE.Box3[] = [];
  private stamp = -1;

  /**
   * World AABBs of every mesh that can be walked into or stood on.
   * `frame` is any per-frame counter: passing the same one twice reuses the
   * gather, so several characters in a scene pay for it once.
   */
  gather(scene: GPScene, frame = -1): this {
    if (frame >= 0 && frame === this.stamp) return this;
    this.stamp = frame;
    this.boxes.length = 0;
    for (const m of scene.meshes) {
      if (m.visible === false || m.collide === false) continue;
      const local = meshLocalBounds(m);
      if (!local) continue; // MODEL: arbitrary loaded geometry, no bounds here
      const box = worldAABB(local, worldMatrixOf(scene, { kind: 'MESH', id: m.id }));
      for (const ax of ['x', 'y', 'z'] as const) {
        if (box.max[ax] - box.min[ax] < MIN_THICK) box.min[ax] = box.max[ax] - MIN_THICK;
      }
      this.boxes.push(box);
    }
    return this;
  }

  /** Ground snap + horizontal push-out, in that order. Mutates `pos`. */
  resolve(pos: THREE.Vector3, upAxis: number, body: WalkBody): void {
    const ax = (['x', 'y', 'z'] as const)[upAxis];
    const flat = (['x', 'y', 'z'] as const).filter((_, i) => i !== upAxis);
    const feet = pos.getComponent(upAxis);

    // ground: the highest surface under us that we could step onto
    let ground = 0;
    for (const b of this.boxes) {
      if (b.max[ax] > feet + body.stepHeight || b.max[ax] < ground) continue;
      if (pos[flat[0]] < b.min[flat[0]] || pos[flat[0]] > b.max[flat[0]]) continue;
      if (pos[flat[1]] < b.min[flat[1]] || pos[flat[1]] > b.max[flat[1]]) continue;
      ground = b.max[ax];
    }
    pos.setComponent(upAxis, ground);

    // walls: anything spanning the body's height band, pushed out along its
    // axis of LEAST penetration — which for a room is always the wall normal
    for (const b of this.boxes) {
      if (b.max[ax] <= ground + body.stepHeight) continue;  // ground or a step
      if (b.min[ax] >= ground + body.height) continue;      // overhead
      let bestAxis: 'x' | 'y' | 'z' | null = null;
      let bestPush = Infinity;
      let bestSign = 1;
      for (const f of flat) {
        const lo = b.min[f] - body.radius;
        const hi = b.max[f] + body.radius;
        const v = pos[f];
        if (v <= lo || v >= hi) { bestAxis = null; break; }  // outside: no contact
        const outLo = v - lo;
        const outHi = hi - v;
        const pen = Math.min(outLo, outHi);
        if (pen < bestPush) { bestPush = pen; bestAxis = f; bestSign = outLo < outHi ? -1 : 1; }
      }
      if (bestAxis) pos[bestAxis] += bestPush * bestSign;
    }
  }

  /**
   * How far a ray gets before it enters something, up to `max`. Used for
   * the third-person boom (pull in rather than sit inside a wall) and for
   * steering's look-ahead.
   */
  castDistance(from: THREE.Vector3, dir: THREE.Vector3, max: number): number {
    const ray = new THREE.Raycaster(from, dir, 0, max);
    const hit = new THREE.Vector3();
    let best = max;
    for (const b of this.boxes) {
      if (ray.ray.intersectBox(b, hit)) best = Math.min(best, from.distanceTo(hit));
    }
    return best;
  }

  /** Read-only, for debugging a scene where a character stops unexpectedly. */
  debugBoxes(): { min: number[]; max: number[] }[] {
    return this.boxes.map((b) => ({ min: b.min.toArray(), max: b.max.toArray() }));
  }
}

export const walkVolume = new WalkVolume();

/** Standing height from the rest skeleton (feet are at the origin). */
export function actorHeight(actor: TGActor, upAxis: number): number {
  let h = 0;
  for (const j of actor.joints) h = Math.max(h, j.rest[upAxis]);
  return h || 1.8;
}

export function restHeightOf(actor: TGActor, name: string, upAxis: number): number {
  return actor.joints.find((j) => j.name === name)?.rest[upAxis] ?? 0;
}

/**
 * The actor's forward and right in WORLD space for a given heading.
 *
 * The skeleton is authored +Y forward in Z-up and -Z forward in Y-up
 * (skeleton.ts `place`), and both are what a yaw about the up axis maps
 * onto for the SAME angle — which is why a heading is just the nav yaw with
 * no offset anywhere, and why this is the one place that knows it.
 */
export function headingBasis(yaw: number, upZ: boolean): {
  fwd: THREE.Vector3; right: THREE.Vector3;
} {
  return upZ
    ? {
      fwd: new THREE.Vector3(-Math.sin(yaw), Math.cos(yaw), 0),
      right: new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0),
    }
    : {
      fwd: new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)),
      right: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
    };
}

/** Heading (nav yaw) that faces a horizontal world direction. */
export function headingOf(dir: THREE.Vector3, upZ: boolean): number {
  return upZ ? Math.atan2(-dir.x, dir.y) : Math.atan2(-dir.x, -dir.z);
}

/** Shortest signed turn from `a` to `b`, radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Euler an actor needs to face `yaw`. */
export function headingEuler(yaw: number, upZ: boolean): [number, number, number] {
  return upZ ? [0, 0, yaw] : [0, yaw, 0];
}
