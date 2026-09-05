// Possession: take the controls of an actor.
//
// This is the character half of fly mode. Fly mode already owns pointer
// lock, mouse-look in the up-frame, the WASD key set and the
// Esc-through-pointer-lock cancel; possession borrows all of it through
// `Navigation.walkDriver` and replaces only the final step — instead of
// translating the camera, it walks a body and then decides where the
// camera sits relative to that body (first or third person).
//
// Three deliberately small pieces, because this is an installation sim and
// not a game engine:
//
//  - MOVEMENT writes the actor's translation + heading only. Nothing here
//    touches `actor.pose`: the gait engine sees the root move and produces
//    the walk cycle on its own, exactly as it does for a FOLLOW_PATH
//    traveler. Driving and path-following are therefore the same animation.
//  - COLLISION is world-AABB push-out against mesh objects, reusing the
//    same `meshLocalBounds` the TRIGGER zones use rather than introducing a
//    physics engine. Conservative for rotated boxes (an AABB is bigger than
//    the box) and exact for the axis-aligned rooms people actually build.
//  - GROUND is the top of whatever AABB you are standing over, so pedestals
//    and steps work for free. There is no gravity: you are placed on the
//    support surface, never falling off it.
//
// Recording follows from this without any new machinery: the actor is an
// ObjRef, `clipRecorder` already records an ObjRef's world origin, and
// `bakeClipToStrokes` turns the clip into a GP stroke — which is a path,
// which FOLLOW_PATH replays. Walk it, bake it, smooth it, loop it.
import * as THREE from 'three';
import type { GPScene, TGActor } from '../core/types';
import { meshLocalBounds, worldAABB } from '../tools/objectops';
import { worldMatrixOf } from '../tools/objects';
import type { WalkInput } from './nav';

export type PossessView = 'FIRST' | 'THIRD';

/** A degenerate (zero-thickness) AABB has no inside to push out of, so
 *  PLANE walls get a nominal thickness. Small enough not to shift where the
 *  wall is, large enough that the push-out axis never flip-flops. It grows
 *  DOWNWARD only (min, never max) so that a floor plane keeps its surface
 *  exactly where it is — inflating symmetrically would stand everybody a
 *  centimetre above the ground. */
const MIN_THICK = 0.02;

export class Possession {
  /** actor being driven, or null when nobody is possessed */
  actorId: number | null = null;
  view: PossessView = 'THIRD';
  /** third-person camera boom length, metres */
  distance = 3;
  /** walk speed, m/s — the gait is distance-phased so this IS the cadence */
  speed = 1.35;
  runMul = 2.2;
  /** velocity smoothing, 1/s: low values give a heavier, more filmic start */
  accel = 9;
  /** body radius used for wall push-out */
  radius = 0.28;
  /** how tall a ledge may be and still count as ground rather than a wall */
  stepHeight = 0.35;
  collide = true;

  private vel = new THREE.Vector3();
  /** cached blockers, rebuilt each frame (scene-scale, not perf-critical) */
  private boxes: THREE.Box3[] = [];

  get active(): boolean { return this.actorId != null; }

  begin(actorId: number): void {
    this.actorId = actorId;
    this.vel.set(0, 0, 0);
  }

  end(): void {
    this.actorId = null;
    this.vel.set(0, 0, 0);
  }

  /** Drive the actor for one frame. Call from `Navigation.walkDriver`. */
  update(scene: GPScene, input: WalkInput, upZ: boolean): void {
    const actor = this.actorOf(scene);
    if (!actor) { this.end(); return; }
    const upAxis = upZ ? 2 : 1;
    const dt = Math.min(0.05, input.dt);

    // Heading IS the look yaw: the character faces where you look, and WASD
    // moves in that frame. The skeleton is authored +Y forward in Z-up and
    // -Z forward in Y-up (skeleton.ts `place`), and both of those are what
    // a yaw about the up axis maps onto for the same angle — so the actor's
    // euler is just the nav yaw on the up axis, with no offset.
    const yaw = input.yaw;
    actor.rotation = upZ ? [0, 0, yaw] : [0, yaw, 0];

    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    if (upZ) {
      fwd.set(-Math.sin(yaw), Math.cos(yaw), 0);
      right.set(Math.cos(yaw), Math.sin(yaw), 0);
    } else {
      fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    }

    const k = input.keys;
    const want = new THREE.Vector3();
    if (k.has('w')) want.add(fwd);
    if (k.has('s')) want.sub(fwd);
    if (k.has('d')) want.add(right);
    if (k.has('a')) want.sub(right);
    if (want.lengthSq() > 1e-6) {
      want.normalize().multiplyScalar(this.speed * (k.has('shift') ? this.runMul : 1));
    }
    // Smooth toward the wanted velocity rather than snapping to it. The
    // gait phases on distance travelled, so an instant velocity step reads
    // as the legs teleporting into cadence; a ramp reads as setting off.
    this.vel.lerp(want, Math.min(1, dt * this.accel));

    const pos = new THREE.Vector3(...actor.translation).addScaledVector(this.vel, dt);

    if (this.collide) {
      this.gather(scene);
      const height = actorHeight(actor, upAxis);
      this.resolve(pos, upAxis, height);
    }
    actor.translation = [pos.x, pos.y, pos.z];
  }

  /**
   * Place the viewport camera. Called after `update`, with the camera's
   * orientation already set by fly mode — so the boom direction is simply
   * the camera's own forward, and pitch orbits the character for free.
   */
  placeCamera(scene: GPScene, cam: THREE.PerspectiveCamera, upZ: boolean): void {
    const actor = this.actorOf(scene);
    if (!actor) return;
    const upAxis = upZ ? 2 : 1;
    const up = new THREE.Vector3(0, upZ ? 0 : 1, upZ ? 1 : 0);
    const base = new THREE.Vector3().setFromMatrixPosition(
      worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id }));
    // Eye height comes from the REST skeleton, not the solved pose: the
    // gait bobs the hips every step and a camera that inherits that bob is
    // motion sickness, not immersion.
    const eyeH = restHeightOf(actor, 'head', upAxis) || actorHeight(actor, upAxis) * 0.94;
    const fwd = cam.getWorldDirection(new THREE.Vector3());

    if (this.view === 'FIRST') {
      // Clear the actor's OWN head, or the view is a solid wall of skull.
      // The offset is horizontal, from the heading rather than the look
      // direction: offsetting along `fwd` would slide the eye down through
      // the body the moment you looked at your feet.
      const headR = actor.joints.find((j) => j.name === 'head')?.radius ?? 0.14;
      const flat = fwd.clone();
      flat.setComponent(upAxis, 0);
      if (flat.lengthSq() > 1e-6) flat.normalize(); else flat.set(0, 0, 0);
      cam.position.copy(base).addScaledVector(up, eyeH).addScaledVector(flat, headR + 0.06);
      return;
    }
    const focus = base.clone().addScaledVector(up, eyeH * 0.85);
    let dist = this.distance;
    if (this.collide) {
      this.gather(scene);
      // pull the boom in rather than letting the camera sit inside a wall
      const ray = new THREE.Raycaster(focus, fwd.clone().negate(), 0, dist);
      const hit = new THREE.Vector3();
      for (const b of this.boxes) {
        if (ray.ray.intersectBox(b, hit)) dist = Math.min(dist, focus.distanceTo(hit) - 0.15);
      }
      dist = Math.max(0.4, dist);
    }
    cam.position.copy(focus).addScaledVector(fwd, -dist);
  }

  private actorOf(scene: GPScene): TGActor | null {
    if (this.actorId == null) return null;
    return scene.actors.find((a) => a.id === this.actorId) ?? null;
  }

  /** Blockers as of the last update — read-only, for debugging a scene
   *  where the character stops somewhere unexpected. */
  debugBoxes(): { min: number[]; max: number[] }[] {
    return this.boxes.map((b) => ({ min: b.min.toArray(), max: b.max.toArray() }));
  }

  /** World AABBs of every mesh that can be walked into or stood on. */
  private gather(scene: GPScene): void {
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
  }

  /** Ground snap + horizontal push-out, in that order. */
  private resolve(pos: THREE.Vector3, upAxis: number, height: number): void {
    const ax = (['x', 'y', 'z'] as const)[upAxis];
    const flat = (['x', 'y', 'z'] as const).filter((_, i) => i !== upAxis);
    const feet = pos.getComponent(upAxis);

    // ground: the highest surface under us that we could step onto
    let ground = 0;
    for (const b of this.boxes) {
      if (b.max[ax] > feet + this.stepHeight || b.max[ax] < ground) continue;
      if (pos[flat[0]] < b.min[flat[0]] || pos[flat[0]] > b.max[flat[0]]) continue;
      if (pos[flat[1]] < b.min[flat[1]] || pos[flat[1]] > b.max[flat[1]]) continue;
      ground = b.max[ax];
    }
    pos.setComponent(upAxis, ground);

    // walls: anything spanning the body's height band, pushed out along its
    // axis of LEAST penetration — which for a room is always the wall normal
    for (const b of this.boxes) {
      if (b.max[ax] <= ground + this.stepHeight) continue;   // ground or a step
      if (b.min[ax] >= ground + height) continue;            // overhead
      let bestAxis: 'x' | 'y' | 'z' | null = null;
      let bestPush = Infinity;
      let bestSign = 1;
      for (const f of flat) {
        const lo = b.min[f] - this.radius;
        const hi = b.max[f] + this.radius;
        const v = pos[f];
        if (v <= lo || v >= hi) { bestAxis = null; break; } // outside: no contact
        const outLo = v - lo;   // distance to escape past the low face
        const outHi = hi - v;
        const pen = Math.min(outLo, outHi);
        if (pen < bestPush) { bestPush = pen; bestAxis = f; bestSign = outLo < outHi ? -1 : 1; }
      }
      if (bestAxis) pos[bestAxis] += bestPush * bestSign;
    }
  }
}

/** Standing height from the rest skeleton (feet are at the origin). */
function actorHeight(actor: TGActor, upAxis: number): number {
  let h = 0;
  for (const j of actor.joints) h = Math.max(h, j.rest[upAxis]);
  return h || 1.8;
}

function restHeightOf(actor: TGActor, name: string, upAxis: number): number {
  return actor.joints.find((j) => j.name === name)?.rest[upAxis] ?? 0;
}

export const possession = new Possession();
