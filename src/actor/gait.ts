// Procedural walking: a gait that follows wherever the root goes.
//
// This is what turns an actor from something that GLIDES along a path into
// something that walks. It produces JointTargets exactly like a capture rig
// does — feet, pelvis and hands — so the solver answers with the same
// physics and nothing downstream needs to know a gait exists.
//
// The one decision that makes or breaks procedural locomotion: the cycle is
// phased by DISTANCE TRAVELLED, not by time. Time-phased gaits slide their
// feet the moment speed changes, which is the immediate tell that something
// is animated rather than walking. Distance-phasing couples stride to speed
// by construction: move twice as fast and you take steps twice as often,
// each covering the same ground.
//
// The second decision follows from it: a planted foot is stored in WORLD
// space and converted to actor-local every frame. That is what "planted"
// means — the body advances, the foot does not, so the local target slides
// backwards under the actor on its own. Storing the plant in local space
// would drag the foot along with the body, which is precisely the sliding
// the whole design exists to avoid.
import * as THREE from 'three';
import type { GPScene, TGActor, Vec3 } from '../core/types';
import { actorSolver } from './solver';
import { actorMixer } from './mixer';
import { worldMatrixOf } from '../tools/objects';

/** Joints the gait drives. Anything not listed is left to the solver. */
const FOOT = ['ankle.L', 'ankle.R'] as const;
const HAND = ['wrist.L', 'wrist.R'] as const;

interface FootState {
  /** where this foot is currently planted, WORLD space */
  plant: THREE.Vector3;
  /** where it is heading during a swing, WORLD space */
  next: THREE.Vector3;
  /** was it in stance last frame — used to latch a new target once per step */
  wasStance: boolean;
}

interface GaitState {
  /** 0..1 through one full stride (two steps) */
  phase: number;
  /** actor world position last frame, for the distance delta */
  lastPos: THREE.Vector3 | null;
  feet: [FootState, FootState];
  /** smoothed speed, for blending the gait out when standing still */
  speed: number;
}

/** Beyond this the actor was teleported (scene load, undo, drag) rather than
 *  walking, so the plants are meaningless and get re-seeded. */
const TELEPORT_M = 1.5;

export class GaitEngine {
  private states = new Map<number, GaitState>();

  reset(actorId?: number): void {
    if (actorId === undefined) this.states.clear();
    else this.states.delete(actorId);
  }

  update(scene: GPScene, dt: number, upZ: boolean): void {
    for (const actor of scene.actors) {
      if (!actor.gait?.enabled) { this.states.delete(actor.id); continue; }
      this.step(scene, actor, dt, upZ);
    }
  }

  private step(scene: GPScene, actor: TGActor, dt: number, upZ: boolean): void {
    const g = actor.gait!;
    const m = worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id });
    const toLocal = m.clone().invert();
    const pos = new THREE.Vector3().setFromMatrixPosition(m);

    // Body axes in WORLD space. The skeleton is authored +Y forward in Z-up
    // (see skeleton.ts `place`), which becomes -Z forward in a Y-up scene.
    const fwd = (upZ ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1))
      .transformDirection(m).normalize();
    const right = (upZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(1, 0, 0))
      .transformDirection(m).normalize();
    const upAxis = upZ ? 2 : 1;

    let st = this.states.get(actor.id);
    const teleported = st?.lastPos ? st.lastPos.distanceTo(pos) > TELEPORT_M : false;
    if (!st || teleported) {
      st = this.seed(actor, pos, fwd, right, upAxis, g.stanceWidth);
      this.states.set(actor.id, st);
    }

    // ---- advance the cycle by GROUND distance covered -------------------
    const delta = st.lastPos ? pos.clone().sub(st.lastPos) : new THREE.Vector3();
    delta.setComponent(upAxis, 0);            // vertical motion is not stride
    const dist = delta.length();
    st.lastPos = pos.clone();

    const instant = dt > 1e-5 ? dist / dt : 0;
    // light smoothing so a single stuttery frame doesn't jolt the legs
    st.speed += (instant - st.speed) * Math.min(1, dt * 8);

    const stride = Math.max(0.05, g.strideLength);
    st.phase = (st.phase + dist / stride) % 1;

    // Standing still: fade the gait out rather than freezing mid-step, so a
    // stopped actor settles onto both feet instead of holding one aloft.
    const moving = Math.min(1, st.speed / Math.max(0.05, g.walkSpeed * 0.25));
    const w = g.strength * moving;
    if (w < 0.01) return;

    // Plant at the ankle's REST height, not at zero: the ankle joint sits
    // above the sole, so targeting the floor plane drags the whole leg
    // short and the actor sinks.
    const ankleRest = actor.joints.find((j) => j.name === 'ankle.L')?.rest;
    const groundY = ankleRest ? ankleRest[upAxis] : 0;

    const duty = Math.min(0.9, Math.max(0.5, g.dutyFactor));
    // Symmetric footfall: plant `lead` ahead of the root so that after a
    // stance's worth of travel the foot sits equally far behind it.
    const lead = (duty * stride) / 2;
    // LOCAL axis indices, for building body-relative targets. Z-up authors
    // the skeleton +Y forward; Y-up mirrors that onto -Z (skeleton.ts).
    const fwdAxis = upZ ? 1 : 2;
    const fwdSign = upZ ? 1 : -1;
    const rightAxis = 0;

    const idxOf = (name: string) => actor.joints.findIndex((j) => j.name === name);
    // The mixer's say on this layer, per joint — a stack can hand the legs
    // to the walk and the arms to a capture without the gait knowing. The
    // cycle above still advanced while muted, deliberately: unmuting picks
    // up mid-stride instead of restarting from a standstill.
    const gain = (name: string): number => actorMixer.gain(actor, 'GAIT', name);

    for (let f = 0; f < 2; f++) {
      const foot = st.feet[f];
      const side = f === 0 ? 1 : -1;                    // L = +right
      const fp = (st.phase + (f === 0 ? 0 : 0.5)) % 1;
      const stance = fp < duty;

      // Where the foot should land, expressed relative to the BODY: half a
      // stance's travel ahead, out at the stance width. Body-relative on
      // purpose — see the swing branch below.
      const aheadLocal = new THREE.Vector3();
      aheadLocal.setComponent(fwdAxis, lead * fwdSign);
      aheadLocal.setComponent(rightAxis, side * g.stanceWidth * 0.5);
      aheadLocal.setComponent(upAxis, groundY);

      // Latch on the TRANSITIONS, never on a sampled value reaching an
      // exact bound: phase is sampled at whatever rate the frame ran, so a
      // test like `t >= 1` is essentially never true and the plant would
      // silently never advance — the foot would stay where it was seeded
      // and the body would walk away from it.
      if (stance && !foot.wasStance) {
        // touch-down: freeze the landing spot in WORLD space, which is what
        // makes the stance foot stay put while the body moves over it
        foot.plant.copy(aheadLocal).applyMatrix4(m);
      }
      foot.wasStance = stance;

      const local = new THREE.Vector3();
      if (stance) {
        // world-locked: converting the frozen plant back each frame is what
        // slides it backwards under the actor, i.e. no foot sliding
        local.copy(foot.plant).applyMatrix4(toLocal);
      } else {
        // SWING IS BODY-RELATIVE, and that is not a shortcut. Interpolating
        // in world space toward a fixed landing spot puts the target up to
        // (swing travel + lead) ahead of the root at the START of the swing
        // — further than the leg is long — so the solver maxes the leg out
        // extended forward for the whole swing and the foot never comes
        // back under the body. Lerping the CURRENT (already sliding back)
        // local plant toward the body-relative landing spot keeps every
        // intermediate target inside the leg's reach by construction.
        const t = smoothstep((fp - duty) / (1 - duty));
        local.copy(foot.plant).applyMatrix4(toLocal).lerp(aheadLocal, t);
        local.setComponent(upAxis,
          local.getComponent(upAxis) + Math.sin(Math.PI * t) * g.stepHeight);
      }

      const ai = idxOf(FOOT[f]);
      const footW = w * gain(FOOT[f]);
      if (ai >= 0 && footW > 0.001) {
        actorSolver.addTarget(actor.id,
          { index: ai, pos: [local.x, local.y, local.z], weight: footW });
      }

      // Arms counter-swing against the opposite leg — the single cheapest
      // cue that reads as walking rather than shuffling.
      if (g.armSwing > 0.001) {
        const hi = idxOf(HAND[1 - f]);
        const handW = w * 0.6 * gain(HAND[1 - f]);
        if (hi >= 0 && handW > 0.001) {
          const rest = actor.joints[hi].rest;
          const swing = Math.cos(fp * Math.PI * 2) * g.armSwing;
          const localTarget: Vec3 = upZ
            ? [rest[0], rest[1] + swing, rest[2]]
            : [rest[0], rest[1], rest[2] - swing];
          actorSolver.addTarget(actor.id, { index: hi, pos: localTarget, weight: handW });
        }
      }
    }

    // ---- pelvis bob: twice per stride, since each step drops the hips ----
    if (g.bob > 0.0001) {
      const hi = idxOf('hips');
      const hipW = w * 0.5 * gain('hips');
      if (hi >= 0 && hipW > 0.001) {
        const rest = actor.joints[hi].rest;
        const bob = -Math.abs(Math.sin(st.phase * Math.PI * 2)) * g.bob;
        const p: Vec3 = [...rest] as Vec3;
        p[upAxis] += bob;
        actorSolver.addTarget(actor.id, { index: hi, pos: p, weight: hipW });
      }
    }
  }

  /** Plant both feet either side of the actor's current position. */
  private seed(
    actor: TGActor, pos: THREE.Vector3, fwd: THREE.Vector3, right: THREE.Vector3,
    upAxis: number, width: number,
  ): GaitState {
    const ankleRest = actor.joints.find((j) => j.name === 'ankle.L')?.rest;
    const groundY = ankleRest ? ankleRest[upAxis] : 0;
    const mk = (side: number): FootState => {
      const p = pos.clone().addScaledVector(right, side * width * 0.5);
      p.setComponent(upAxis, groundY);
      return { plant: p, next: p.clone(), wasStance: true };
    };
    void fwd;
    return { phase: 0, lastPos: pos.clone(), feet: [mk(1), mk(-1)], speed: 0 };
  }

  /** Current stride phase, for UI/debug readouts. */
  phaseOf(actorId: number): number { return this.states.get(actorId)?.phase ?? 0; }
  speedOf(actorId: number): number { return this.states.get(actorId)?.speed ?? 0; }
}

/** Ease the swing so the foot leaves and arrives without a velocity step. */
function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export const gaitEngine = new GaitEngine();

/** Sensible defaults for a 1.8 m figure walking at a normal pace. */
export function defaultGait(): NonNullable<TGActor['gait']> {
  return {
    enabled: false,
    strideLength: 1.4,   // metres per full cycle (two steps)
    stepHeight: 0.12,
    stanceWidth: 0.22,
    dutyFactor: 0.62,    // >0.5 = both feet down briefly, i.e. a walk not a run
    bob: 0.035,
    armSwing: 0.16,
    walkSpeed: 1.3,      // m/s the gait is tuned around
    strength: 0.9,
  };
}
