// The seam between the two physics backends.
//
// Everything outside `props.ts` and `rapierphys.ts` goes through here, so no
// tool, panel or frame-loop line has to know which engine is running. Both
// answer the same three questions — step the world, hold a prop under the
// cursor, let it go — and `scene.physicsEngine` picks one.
import type * as THREE from 'three';
import type { GPScene } from '../core/types';
import { propEngine } from './props';
import { rapierPhysics } from './rapierphys';

export type PhysicsEngine = 'SIMPLE' | 'RAPIER';

export function engineOf(scene: GPScene): PhysicsEngine {
  return scene.physicsEngine === 'RAPIER' ? 'RAPIER' : 'SIMPLE';
}

/** Drag a prop by steering it. Both backends chase, never teleport. */
export function holdProp(scene: GPScene, id: number, target: THREE.Vector3): void {
  if (engineOf(scene) === 'RAPIER') rapierPhysics.hold(id, target);
  else propEngine.hold(id, target);
}

export function releaseProp(scene: GPScene, id: number): void {
  // released in BOTH, so a backend swap mid-drag cannot strand a held body
  rapierPhysics.release(id);
  propEngine.release(id);
}

/** Drop both worlds — a scene load, an up-axis change, a backend swap. */
export function resetPhysics(): void {
  propEngine.reset();
  rapierPhysics.reset();
}
