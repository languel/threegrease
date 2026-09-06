// "Go there": a character that walks itself somewhere.
//
// This is the third way an actor's root can move, and it is deliberately
// the same shape as the other two. A FOLLOW_PATH constraint puts the root
// on a curve; possession puts it under your hands; steering gives it a
// DESTINATION and lets it find its own way. In every case nothing here
// touches the pose — the gait sees the root move and produces the walking,
// so all three read as the same character.
//
// Why a goal rather than a path is the thing worth having: a path is a
// recording of a route, and an installation is full of routes that depend
// on what happened ("meet the visitor", "return to the plinth", "leave").
// A goal is also the interface a generative motion model wants — you tell
// it where, not how — so the steering layer is what a Kimodo-style
// generator would eventually replace the gait underneath, not something it
// would sit beside.
//
// Deliberately steering, not pathfinding. There is no navmesh and no A*:
// the character seeks its goal, slows into it, and slides along whatever it
// bumps into, with a short look-ahead that pushes it around an obstacle it
// is walking straight at. That handles a room with furniture in it, which
// is the room these pieces are staged in. It will not solve a maze, and
// when it wedges in a concave corner it says so (`stuck`) rather than
// vibrating there forever pretending to walk.
import * as THREE from 'three';
import type { GPScene, TGActor, TGActorSteer, Vec3 } from '../core/types';
import { worldMatrixOf, type ObjRef } from '../tools/objects';
import {
  actorHeight, angleDelta, headingBasis, headingEuler, headingOf, walkVolume,
} from './locomotion';
import { actorMixer } from './mixer';
import { actorLog } from '../app/actorlog';

/** How long a character may make no progress before it tries something. */
const STUCK_SECONDS = 1.2;
const STUCK_METRES = 0.05;
/** How many sideways escapes to attempt before admitting defeat. */
const MAX_ESCAPES = 3;
/** How long to commit to an escape before re-aiming at the real goal. */
const DETOUR_SECONDS = 2.2;
/** how wide the "which way round?" probes fan out */
const PROBE_ANGLE = Math.PI / 3;

/** Rotate a horizontal direction about the world up axis. */
function rotateAboutUp(dir: THREE.Vector3, angle: number, upAxis: number): THREE.Vector3 {
  const axis = new THREE.Vector3();
  axis.setComponent(upAxis, 1);
  return dir.clone().applyAxisAngle(axis, angle);
}

interface Hop {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  height: number;
}

interface SteerState {
  vel: THREE.Vector3;
  /** distance to the goal when we last saw progress */
  bestDist: number;
  stalled: number;
  /** which way we committed to go round the current obstacle, 0 = clear */
  dodge: number;
  /** a temporary goal we are using to escape a wedge, and its clock */
  detour: THREE.Vector3 | null;
  detourT: number;
  /** how many escapes we have already tried for the CURRENT goal */
  attempts: number;
}

export class SteerEngine {
  private states = new Map<number, SteerState>();
  /** actors whose root another system owns this frame (possession) */
  suppressed = new Set<number>();
  private frame = 0;

  reset(actorId?: number): void {
    if (actorId === undefined) this.states.clear();
    else this.states.delete(actorId);
  }

  /**
   * Does this actor have a destination at all? This — not `active` — is
   * what suppresses its FOLLOW_PATH, and it stays true AFTER arrival on
   * purpose: otherwise the moment a character reached where you sent it,
   * its old path would grab it back and drag it off, which looks like the
   * goal was ignored. Clearing the goal (mode NONE) hands it back.
   */
  hasGoal(actor: TGActor): boolean {
    if (this.hops.has(actor.id)) return true;   // a jump owns the root too
    const st = actor.steer;
    return !!st && st.mode !== 'NONE' && !this.suppressed.has(actor.id);
  }

  /** Is this actor still walking toward its destination? */
  active(actor: TGActor): boolean {
    return this.hasGoal(actor) && !actor.steer!.arrived;
  }

  private hops = new Map<number, Hop>();

  /** Is this actor in the air right now? */
  airborne(actorId: number): boolean { return this.hops.has(actorId); }

  /**
   * Leave the ground and land on a point. A jump is not walking, so it does
   * not go through the seek loop at all — the root follows a ballistic arc
   * and the WALK IS FADED OUT for the duration, through the mixer, because
   * a gait that keeps cycling in mid-air is the tell that a character is
   * being slid rather than thrown.
   */
  hopTo(actor: TGActor, to: Vec3, upZ: boolean): void {
    const upAxis = upZ ? 2 : 1;
    const from = new THREE.Vector3(...actor.translation);
    const dest = new THREE.Vector3(...to);
    const flat = dest.clone().sub(from);
    flat.setComponent(upAxis, 0);
    const dist = flat.length();
    // Long jumps take longer and go higher, but both saturate: without a
    // cap, clicking across the room launches the character into orbit.
    const dur = Math.min(1.6, 0.45 + dist * 0.22);
    const height = Math.min(1.1, 0.35 + dist * 0.18);
    this.hops.set(actor.id, { from, to: dest, t: 0, dur, height });
    // stop steering while airborne; the goal is the landing spot
    if (actor.steer) { actor.steer.arrived = true; actor.steer.stuck = false; }
    const gait = actorMixer.layerFor(actor, 'GAIT');
    if (gait) actorMixer.fadeTo(actor.id, gait.id, 0, 0.12);
  }

  private hop(actor: TGActor, h: Hop, dt: number, upZ: boolean): void {
    const upAxis = upZ ? 2 : 1;
    h.t += dt;
    const k = Math.min(1, h.t / h.dur);
    const p = h.from.clone().lerp(h.to, k);
    // a parabola on top of the straight line between the two ends
    p.setComponent(upAxis, p.getComponent(upAxis) + Math.sin(Math.PI * k) * h.height);
    actor.translation = [p.x, p.y, p.z];
    // face the way you jumped
    const flat = h.to.clone().sub(h.from);
    flat.setComponent(upAxis, 0);
    if (flat.lengthSq() > 1e-6) {
      actor.rotation = headingEuler(headingOf(flat, upZ), upZ);
    }
    if (k >= 1) {
      this.hops.delete(actor.id);
      const gait = actorMixer.layerFor(actor, 'GAIT');
      if (gait) actorMixer.fadeTo(actor.id, gait.id, 1, 0.18);
    }
  }

  /**
   * Move every steering actor's root one frame. Runs BEFORE the gait, so
   * this frame's motion is this frame's stride, and before the constraint
   * pass, which is told to stand down for anything actually steering.
   */
  update(scene: GPScene, dt: number, upZ: boolean): void {
    this.frame++;
    for (const actor of scene.actors) {
      const h = this.hops.get(actor.id);
      if (h) { this.hop(actor, h, Math.min(0.05, dt), upZ); continue; }
      if (!this.active(actor)) { this.states.delete(actor.id); continue; }
      this.step(scene, actor, Math.min(0.05, dt), upZ);
    }
  }

  /** Where this actor is trying to get to, or null. */
  goalOf(scene: GPScene, actor: TGActor): THREE.Vector3 | null {
    const st = actor.steer;
    if (!st) return null;
    if (st.mode === 'POINT' || st.mode === 'FACE') {
      return new THREE.Vector3(...(st.point ?? [0, 0, 0]));
    }
    if (st.mode === 'OBJECT' && st.target) {
      return new THREE.Vector3().setFromMatrixPosition(
        worldMatrixOf(scene, st.target as ObjRef));
    }
    return null;
  }

  private step(scene: GPScene, actor: TGActor, dt: number, upZ: boolean): void {
    const st = actor.steer!;
    const upAxis = upZ ? 2 : 1;
    const goal = this.goalOf(scene, actor);
    if (!goal) return;

    let state = this.states.get(actor.id);
    if (!state) {
      state = {
        vel: new THREE.Vector3(), bestDist: Infinity, stalled: 0, dodge: 0,
        detour: null, detourT: 0, attempts: 0,
      };
      this.states.set(actor.id, state);
    }

    const pos = new THREE.Vector3(...actor.translation);

    // ---- escape in progress: aim at the detour, not at the goal ---------
    if (state.detour) {
      state.detourT += dt;
      const reached = state.detour.distanceTo(pos) < 0.45;
      if (reached || state.detourT > DETOUR_SECONDS) {
        state.detour = null;
        // start the progress accounting over: the point of the detour was
        // to reach somewhere the old "best distance" no longer describes
        state.bestDist = Infinity;
        state.stalled = 0;
      }
    }
    const aim = state.detour ?? goal;

    const to = aim.clone().sub(pos);
    to.setComponent(upAxis, 0);          // walking is a horizontal problem
    const dist = to.length();
    const goalDist = state.detour
      ? goal.clone().sub(pos).setComponent(upAxis, 0).length() : dist;

    // ---- FACE: turn on the spot, do not travel -------------------------
    if (st.mode === 'FACE') {
      state.vel.set(0, 0, 0);
      if (dist < 1e-4) { st.arrived = true; return; }
      const target = headingOf(to.clone().divideScalar(dist), upZ);
      const curH = upZ ? actor.rotation[2] : actor.rotation[1];
      const maxTurn = THREE.MathUtils.degToRad(st.turnRate) * dt;
      const delta = THREE.MathUtils.clamp(angleDelta(curH, target), -maxTurn, maxTurn);
      actor.rotation = headingEuler(curH + delta, upZ);
      // done once we are pointing at it, within a couple of degrees
      if (Math.abs(angleDelta(curH + delta, target)) < 0.03) st.arrived = true;
      return;
    }

    // ---- arrival ------------------------------------------------------
    const stop = Math.max(0.05, st.stopDistance);
    if (goalDist <= stop) {
      state.vel.multiplyScalar(Math.max(0, 1 - dt * 8));
      actor.translation = [
        pos.x + state.vel.x * dt, pos.y + state.vel.y * dt, pos.z + state.vel.z * dt,
      ];
      st.arrived = true;
      return;
    }

    // ---- seek, with an arrival ramp ------------------------------------
    // Slowing INTO the goal rather than stopping dead at it matters more
    // than it sounds: the gait is phased by distance, so a velocity that
    // falls off smoothly spends its last stride shortening, which is what
    // arriving looks like. A hard stop leaves a foot in the air.
    const dir = to.clone().divideScalar(dist);
    const slow = Math.max(0.25, Math.min(1, dist / Math.max(0.01, st.slowRadius)));
    let want = dir.clone().multiplyScalar(st.speed * slow);

    // ---- look-ahead: go AROUND what is in the way ----------------------
    // Push-out alone makes a character grind along a wall it is aimed at.
    // A short probe ahead, and a nudge toward whichever side is more open,
    // is enough to walk around the furniture in a room. It is not
    // pathfinding and does not pretend to be.
    if (st.avoid && dist > stop * 1.5) {
      walkVolume.gather(scene, this.frame);
      const eye = pos.clone();
      eye.setComponent(upAxis, pos.getComponent(upAxis) + actorHeight(actor, upAxis) * 0.5);
      const look = Math.max(0.4, st.lookAhead);
      const { right } = headingBasis(headingOf(dir, upZ), upZ);

      // Only steer around what would actually BLOCK this body from where it
      // is standing. A ramp, a step or a platform edge is something you walk
      // onto; treating it as an obstacle makes the character circle the very
      // thing it was sent to climb, and then declare itself stuck.
      const body = {
        radius: st.radius, stepHeight: st.stepHeight, height: actorHeight(actor, upAxis),
      };
      const ground = walkVolume.groundAt(pos, upAxis, body);
      // Loose props are not obstacles to plan around — walking into them is
      // the point — so the whiskers ignore anything the body would not be
      // stopped by either.
      const wall = (b: THREE.Box3): boolean => {
        const i = walkVolume.boxes.indexOf(b);
        if (i >= 0 && walkVolume.loose[i]) return false;
        return walkVolume.blocks(b, ground, upAxis, body);
      };

      // THREE parallel whiskers, not one ray. A single ray from the centre
      // slips past the corner of a box the shoulders would still hit, and
      // the character then walks confidently into it.
      const ahead = Math.min(
        walkVolume.castDistance(eye, dir, look, wall),
        walkVolume.castDistance(eye.clone().addScaledVector(right, st.radius), dir, look, wall),
        walkVolume.castDistance(eye.clone().addScaledVector(right, -st.radius), dir, look, wall),
      );

      if (ahead < look) {
        if (!state.dodge) {
          // Pick a side ONCE and stay committed until the way is clear.
          // Re-deciding every frame is its own wedge: at a box dead ahead
          // the two sides measure almost the same, the choice flickers, and
          // the character shuffles into the corner it was avoiding.
          const probeL = walkVolume.castDistance(
            eye, rotateAboutUp(dir, -PROBE_ANGLE, upAxis), look, wall);
          const probeR = walkVolume.castDistance(
            eye, rotateAboutUp(dir, PROBE_ANGLE, upAxis), look, wall);
          state.dodge = probeR >= probeL ? 1 : -1;
        }
        // TURN the desired direction rather than adding a sideways force to
        // it. Adding leaves the seek term still pointing at the goal, so at
        // an obstacle sitting on the straight line the two cancel and the
        // character grinds into it at walking pace. Rotating means the
        // forward component falls away as the obstacle closes, until at
        // point blank it is travelling purely sideways — around.
        const urgency = 1 - ahead / look;
        const turn = state.dodge * (Math.PI / 2) * Math.min(1, urgency * 1.4);
        want = rotateAboutUp(dir, turn, upAxis).multiplyScalar(st.speed * slow);
      } else {
        state.dodge = 0;
      }
    }

    want.setComponent(upAxis, 0);
    state.vel.lerp(want, Math.min(1, dt * st.accel));

    // ---- heading: turn toward travel at a bounded rate ------------------
    // Snapping the heading to the velocity is what makes a character pivot
    // on the spot at every corner and pops the hips. A turn RATE also means
    // a tight corner is taken as a curve, which is what the gait wants: it
    // world-locks a stance foot, so a body that spins under it visibly
    // scuffs.
    const speed = state.vel.length();
    if (speed > 0.05) {
      const target = headingOf(state.vel, upZ);
      const cur = upZ ? actor.rotation[2] : actor.rotation[1];
      const maxTurn = THREE.MathUtils.degToRad(st.turnRate) * dt;
      const delta = THREE.MathUtils.clamp(angleDelta(cur, target), -maxTurn, maxTurn);
      actor.rotation = headingEuler(cur + delta, upZ);
    }

    const want2 = pos.clone().addScaledVector(state.vel, dt);
    const next = walkVolume.gather(scene, this.frame).stepTo(pos, want2, upAxis, {
      radius: st.radius,
      stepHeight: st.stepHeight,
      height: actorHeight(actor, upAxis),
    });
    actor.translation = [next.x, next.y, next.z];

    // ---- stuck detection ------------------------------------------------
    // A steering character with no pathfinder WILL wedge in a concave
    // corner. Saying so is much better than shuffling in place forever
    // while the gait dutifully animates a walk that goes nowhere.
    if (goalDist < state.bestDist - STUCK_METRES) {
      state.bestDist = goalDist;
      state.stalled = 0;
    } else if (!state.detour) {
      state.stalled += dt;
      if (state.stalled > STUCK_SECONDS) {
        if (state.attempts < MAX_ESCAPES) {
          // A reactive steerer WILL find local minima — an inside corner, a
          // gap it keeps re-entering — and the way out of one is not to push
          // harder but to go somewhere else briefly and re-approach. Sides
          // alternate so a failed escape is not simply repeated, and the
          // detour is biased BACKWARD because the wedge is in front.
          state.attempts += 1;
          const side = state.attempts % 2 === 1 ? 1 : -1;
          const dirNow = to.clone().divideScalar(Math.max(0.001, dist));
          const { right } = headingBasis(headingOf(dirNow, upZ), upZ);
          const away = pos.clone()
            .addScaledVector(right, side * (1.4 + state.attempts * 0.4))
            .addScaledVector(dirNow, -0.7);
          away.setComponent(upAxis, pos.getComponent(upAxis));
          state.detour = away;
          state.detourT = 0;
          state.stalled = 0;
          state.dodge = 0;
          actorLog.say(actor.id, actor.name,
            state.attempts === 1 ? 'That\u2019s blocked \u2014 let me go round.'
              : 'Still blocked. Trying the other side.');
        } else {
          st.stuck = true;
          st.arrived = true;    // stop trying; the caller decides what next
          actorLog.say(actor.id, actor.name,
            'I can\u2019t get through this way. Moving on.');
        }
      }
    }
  }
}

export const steerEngine = new SteerEngine();

export function defaultSteer(): TGActorSteer {
  return {
    mode: 'NONE',
    point: [0, 0, 0],
    target: null,
    speed: 1.3,
    accel: 6,
    turnRate: 200,      // degrees/second
    slowRadius: 1.2,
    stopDistance: 0.35,
    radius: 0.28,
    stepHeight: 0.45,
    avoid: true,
    lookAhead: 1.4,
    arrived: false,
    stuck: false,
  };
}
