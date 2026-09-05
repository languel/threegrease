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
//  - COLLISION and GROUND come from the shared walking body
//    (actor/locomotion.ts), which is the same one a self-steering character
//    uses — a character should not collide differently depending on who is
//    driving it.
//
// Recording follows from this without any new machinery: the actor is an
// ObjRef, `clipRecorder` already records an ObjRef's world origin, and
// `bakeClipToStrokes` turns the clip into a GP stroke — which is a path,
// which FOLLOW_PATH replays. Walk it, bake it, smooth it, loop it.
import * as THREE from 'three';
import type { GPScene, TGActor } from '../core/types';
import {
  actorHeight, headingBasis, headingEuler, restHeightOf, walkVolume,
  type WalkBody,
} from '../actor/locomotion';
import { worldMatrixOf } from '../tools/objects';
import type { WalkInput } from './nav';

export type PossessView = 'FIRST' | 'THIRD';

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

  get active(): boolean { return this.actorId != null; }

  begin(actorId: number): void {
    this.actorId = actorId;
    this.vel.set(0, 0, 0);
  }

  end(): void {
    this.actorId = null;
    this.vel.set(0, 0, 0);
  }

  private bodyOf(actor: TGActor, upAxis: number): WalkBody {
    return {
      radius: this.radius,
      stepHeight: this.stepHeight,
      height: actorHeight(actor, upAxis),
    };
  }

  /** Drive the actor for one frame. Call from `Navigation.walkDriver`. */
  update(scene: GPScene, input: WalkInput, upZ: boolean): void {
    const actor = this.actorOf(scene);
    if (!actor) { this.end(); return; }
    const upAxis = upZ ? 2 : 1;
    const dt = Math.min(0.05, input.dt);

    // Heading IS the look yaw: the character faces where you look, and WASD
    // moves in that frame.
    const yaw = input.yaw;
    actor.rotation = headingEuler(yaw, upZ);
    const { fwd, right } = headingBasis(yaw, upZ);

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
      walkVolume.gather(scene).resolve(pos, upAxis, this.bodyOf(actor, upAxis));
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
      // pull the boom in rather than letting the camera sit inside a wall
      walkVolume.gather(scene);
      dist = Math.max(0.4,
        walkVolume.castDistance(focus, fwd.clone().negate(), dist) - 0.15);
    }
    cam.position.copy(focus).addScaledVector(fwd, -dist);
  }

  private actorOf(scene: GPScene): TGActor | null {
    if (this.actorId == null) return null;
    return scene.actors.find((a) => a.id === this.actorId) ?? null;
  }

  /** Read-only blockers, for debugging a scene where the character stops
   *  somewhere unexpected. */
  debugBoxes(): { min: number[]; max: number[] }[] { return walkVolume.debugBoxes(); }
}

export const possession = new Possession();
