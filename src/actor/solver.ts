// The actor solver: one position-based loop that is simultaneously the
// ragdoll physics and the kinematics.
//
// Everything here operates on joint POSITIONS (see TGActor's comment for
// why). A step is the standard PBD shape:
//
//   1. integrate      verlet: implicit velocity from (pos - prev)
//   2. apply targets  whatever the rig produced this frame — pins, IK goals
//   3. project        distance / angle-limit / floor constraints, N passes
//
// Targets are just extra constraints, which is the whole point: a captured
// wrist and a mouse-dragged wrist and a MIDI-driven wrist all enter the
// solver the same way, and the rest of the body reacts to them with real
// physics rather than snapping.
import * as THREE from 'three';
import type { GPScene, TGActor, Vec3 } from '../core/types';
import { boneRestLength } from './skeleton';
import { worldMatrixOf } from '../tools/objects';

/** Fixed timestep. A ragdoll integrated on a variable frame time changes
 *  stiffness whenever the frame rate does — the same actor would behave
 *  differently on a fast machine. Accumulate and step in fixed slices. */
const FIXED_DT = 1 / 120;
/** Never spiral: if the tab was backgrounded, drop the backlog. */
const MAX_STEPS = 8;

/** A goal the rig wants a joint to reach this frame, in actor-local space.
 *  `weight` 1 is a hard pin; lower blends it against the simulation. */
export interface JointTarget {
  index: number;
  pos: Vec3;
  weight: number;
}

interface ActorState {
  /** previous positions, for verlet velocity */
  prev: Float32Array;
  /** cached rest lengths, index-aligned with actor.bones */
  restLen: Float32Array;
  /** what the pose array looked like when we last synced, so an external
   *  edit (undo, reset, the transform widget) re-seeds `prev` instead of
   *  being read as an enormous velocity */
  count: number;
  accum: number;
}

export class ActorSolver {
  private states = new Map<number, ActorState>();
  /** targets pushed by rigs/tools before update(), consumed by it */
  private targets = new Map<number, JointTarget[]>();

  reset(actorId?: number): void {
    if (actorId === undefined) this.states.clear();
    else this.states.delete(actorId);
  }

  /** Queue a goal for this frame. Rigs, the drag tool and route drivers all
   *  come in through here, so none of them can fight over the pose. */
  addTarget(actorId: number, t: JointTarget): void {
    const list = this.targets.get(actorId);
    if (list) list.push(t);
    else this.targets.set(actorId, [t]);
  }

  private stateFor(actor: TGActor): ActorState {
    let st = this.states.get(actor.id);
    if (!st || st.count !== actor.joints.length) {
      st = {
        prev: new Float32Array(actor.joints.length * 3),
        restLen: new Float32Array(actor.bones.length),
        count: actor.joints.length,
        accum: 0,
      };
      for (let i = 0; i < actor.joints.length; i++) {
        const p = actor.pose[i] ?? actor.joints[i].rest;
        st.prev[i * 3] = p[0]; st.prev[i * 3 + 1] = p[1]; st.prev[i * 3 + 2] = p[2];
      }
      this.states.set(actor.id, st);
    }
    if (st.restLen.length !== actor.bones.length) st.restLen = new Float32Array(actor.bones.length);
    for (let i = 0; i < actor.bones.length; i++) st.restLen[i] = boneRestLength(actor, actor.bones[i]);
    return st;
  }

  /**
   * Advance every actor. Called once per frame from the App loop; internally
   * it runs a fixed number of FIXED_DT slices.
   *
   * Note the order relative to the rest of the frame: rigs must have pushed
   * their targets already (they read this frame's capture data), and object
   * constraints run afterwards, so a constraint can still move the actor as
   * a whole without the solver undoing it.
   */
  update(scene: GPScene, dt: number, upZ: boolean): boolean {
    let moved = false;
    for (const actor of scene.actors) {
      const queued = this.targets.get(actor.id) ?? [];
      const active = actor.physics.enabled || queued.length > 0;
      if (!active || !actor.joints.length) { this.targets.delete(actor.id); continue; }
      const st = this.stateFor(actor);

      // Gravity is a WORLD direction, but we solve in actor-local space so
      // the actor's own transform can carry the ragdoll around. Rotate it in.
      const rot = new THREE.Quaternion().setFromRotationMatrix(worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id }));
      const g = new THREE.Vector3(0, upZ ? 0 : -1, upZ ? -1 : 0)
        .multiplyScalar(actor.physics.enabled ? actor.physics.gravity : 0)
        .applyQuaternion(rot.invert());

      st.accum = Math.min(st.accum + dt, FIXED_DT * MAX_STEPS);
      let steps = 0;
      while (st.accum >= FIXED_DT && steps < MAX_STEPS) {
        this.step(actor, st, g, queued, upZ);
        st.accum -= FIXED_DT;
        steps++;
        moved = true;
      }
      // Targets with no physics still need to land: if the accumulator has
      // not filled a slice yet, apply them directly so a paused ragdoll can
      // still be posed by hand or by capture.
      if (!steps && queued.length) {
        this.applyTargets(actor, queued);
        this.project(actor, st, upZ);
        moved = true;
      }
      this.targets.delete(actor.id);
    }
    return moved;
  }

  private step(
    actor: TGActor, st: ActorState, g: THREE.Vector3, targets: JointTarget[], upZ: boolean,
  ): void {
    const { pose, joints } = actor;
    const damp = actor.physics.enabled ? actor.physics.damping : 0;
    const dt2 = FIXED_DT * FIXED_DT;
    for (let i = 0; i < joints.length; i++) {
      const p = pose[i];
      if (!p) continue;
      if (joints[i].pin || joints[i].mass <= 0) {
        st.prev[i * 3] = p[0]; st.prev[i * 3 + 1] = p[1]; st.prev[i * 3 + 2] = p[2];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v = (p[c] - st.prev[i * 3 + c]) * damp;
        st.prev[i * 3 + c] = p[c];
        p[c] += v + (c === 0 ? g.x : c === 1 ? g.y : g.z) * dt2;
      }
    }
    this.applyTargets(actor, targets);
    this.project(actor, st, upZ);
  }

  /**
   * Blend joints toward this frame's goals. Weight 1 is a hard pin.
   *
   * One joint is routinely claimed by several sources at once — a capture
   * rig and the procedural gait both want the ankles, a route pins a wrist
   * the walk is swinging. Applying the goals in sequence made each one lerp
   * the pose toward its own answer, so the LAST source to run won in
   * proportion to its weight and the result depended on which engine
   * happened to be called first in the frame. That is a race, not a blend.
   *
   * So resolve first: the goal is the weight-weighted MEAN of every
   * contribution, and the pull toward it is the summed weight clamped to 1.
   * A lone source at 0.9 therefore behaves exactly as it always did, two
   * sources that agree pull harder than either alone, and two that disagree
   * meet in between instead of one silently erasing the other. How loudly
   * each source is allowed to ask is the mixer's job (actor/mixer.ts).
   */
  private applyTargets(actor: TGActor, targets: JointTarget[]): void {
    if (!targets.length) return;
    const acc = new Map<number, { x: number; y: number; z: number; w: number }>();
    for (const t of targets) {
      const w = Math.max(0, Math.min(1, t.weight));
      if (w <= 0 || !actor.pose[t.index]) continue;
      const a = acc.get(t.index);
      if (a) {
        a.x += t.pos[0] * w; a.y += t.pos[1] * w; a.z += t.pos[2] * w; a.w += w;
      } else {
        acc.set(t.index, { x: t.pos[0] * w, y: t.pos[1] * w, z: t.pos[2] * w, w });
      }
    }
    for (const [index, a] of acc) {
      if (a.w <= 1e-6) continue;
      const p = actor.pose[index];
      const w = Math.min(1, a.w);
      p[0] += (a.x / a.w - p[0]) * w;
      p[1] += (a.y / a.w - p[1]) * w;
      p[2] += (a.z / a.w - p[2]) * w;
    }
  }

  /** The constraint passes: bones, angle limits, muscle tone, floor. */
  private project(actor: TGActor, st: ActorState, upZ: boolean): void {
    const iters = Math.max(1, Math.round(actor.physics.iterations));
    const pose = actor.pose;
    const idx = new Map(actor.joints.map((j, i) => [j.id, i]));
    const upC = upZ ? 2 : 1;

    for (let k = 0; k < iters; k++) {
      // --- bones: hold rest length -------------------------------------
      for (let bi = 0; bi < actor.bones.length; bi++) {
        const bone = actor.bones[bi];
        const ia = idx.get(bone.a); const ib = idx.get(bone.b);
        if (ia === undefined || ib === undefined) continue;
        const pa = pose[ia]; const pb = pose[ib];
        const ja = actor.joints[ia]; const jb = actor.joints[ib];
        let dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        const rest = st.restLen[bi];
        // inverse-mass weighting: a pinned joint has 0 inverse mass, so all
        // of the correction lands on the other end — that is what makes a
        // pinned wrist drag the arm instead of the arm dragging the wrist
        const wa = ja.pin || ja.mass <= 0 ? 0 : 1 / ja.mass;
        const wb = jb.pin || jb.mass <= 0 ? 0 : 1 / jb.mass;
        const wsum = wa + wb;
        if (wsum <= 0) continue;
        const corr = ((d - rest) / d) * bone.stiffness;
        dx *= corr; dy *= corr; dz *= corr;
        pa[0] += dx * (wa / wsum); pa[1] += dy * (wa / wsum); pa[2] += dz * (wa / wsum);
        pb[0] -= dx * (wb / wsum); pb[1] -= dy * (wb / wsum); pb[2] -= dz * (wb / wsum);
      }

      // --- hinge poles: decide WHICH WAY a knee or elbow bends ----------
      // The angle limits below cannot do this. The angle between two bones
      // is unsigned, so a knee bent 40 degrees forward and one bent 40
      // degrees backward both measure 140 and both pass — the two are
      // mirror images of each other about the hip-to-ankle line and the
      // solver has no reason to prefer either. That is exactly what a
      // double-jointed limb flipping 180 degrees on every step looks like.
      //
      // The fix is a pole: reflect the middle joint across the root-to-tip
      // line whenever it has drifted to the wrong side. Reflection about a
      // line through the two endpoints is an isometry that fixes them, so
      // BOTH bone lengths survive it exactly — no fighting with the
      // distance pass — and the correction shrinks to nothing as the limb
      // straightens, so there is no pop at full extension.
      if (actor.physics.hinges !== false) {
        for (const lim of actor.limits) {
          if (!lim.pole) continue;
          const child = actor.bones.find((b) => b.id === lim.bone);
          const parent = actor.bones.find((b) => b.id === lim.parent);
          if (!child || !parent) continue;
          const iRoot = idx.get(parent.a);
          const iHinge = idx.get(child.a);
          const iTip = idx.get(child.b);
          if (iRoot === undefined || iHinge === undefined || iTip === undefined) continue;
          const jHinge = actor.joints[iHinge];
          if (jHinge.pin || jHinge.mass <= 0) continue;
          const root = pose[iRoot]; const hinge = pose[iHinge]; const tip = pose[iTip];
          const axis = new THREE.Vector3(
            tip[0] - root[0], tip[1] - root[1], tip[2] - root[2]);
          const len = axis.length();
          if (len < 1e-6) continue;
          axis.divideScalar(len);
          const rel = new THREE.Vector3(
            hinge[0] - root[0], hinge[1] - root[1], hinge[2] - root[2]);
          // component of the hinge off the root->tip line
          const perp = rel.clone().addScaledVector(axis, -rel.dot(axis));
          if (perp.lengthSq() < 1e-10) continue;   // straight: nothing to mirror
          // the pole, with any along-axis part removed — only the sideways
          // half of it says which way is "front" for THIS limb pose
          const pole = new THREE.Vector3(...lim.pole);
          pole.addScaledVector(axis, -pole.dot(axis));
          if (pole.lengthSq() < 1e-10) continue;   // limb aimed along the pole
          if (perp.dot(pole) >= 0) continue;       // already bending correctly
          hinge[0] -= 2 * perp.x;
          hinge[1] -= 2 * perp.y;
          hinge[2] -= 2 * perp.z;
        }
      }

      // --- angle limits: stop elbows and knees folding too far ----------
      for (const lim of actor.limits) {
        const child = actor.bones.find((b) => b.id === lim.bone);
        const parent = actor.bones.find((b) => b.id === lim.parent);
        if (!child || !parent) continue;
        const iPa = idx.get(parent.a); const iHinge = idx.get(child.a); const iTip = idx.get(child.b);
        if (iPa === undefined || iHinge === undefined || iTip === undefined) continue;
        const root = pose[iPa]; const hinge = pose[iHinge]; const tip = pose[iTip];
        const u = new THREE.Vector3(hinge[0] - root[0], hinge[1] - root[1], hinge[2] - root[2]);
        const v = new THREE.Vector3(tip[0] - hinge[0], tip[1] - hinge[1], tip[2] - hinge[2]);
        const lu = u.length(); const lv = v.length();
        if (lu < 1e-9 || lv < 1e-9) continue;
        // angle measured between the bones as drawn: 180 = straight
        const ang = 180 - THREE.MathUtils.radToDeg(u.angleTo(v));
        const clamped = Math.min(lim.max, Math.max(lim.min, ang));
        if (Math.abs(clamped - ang) < 1e-4) continue;
        // rotate the tip about the hinge, in the plane the two bones span
        let axis = new THREE.Vector3().crossVectors(u, v);
        if (axis.lengthSq() < 1e-12) {
          // exactly straight: any perpendicular will do to break the tie
          axis = new THREE.Vector3(1, 0, 0).cross(u);
          if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0).cross(u);
        }
        axis.normalize();
        const delta = THREE.MathUtils.degToRad(ang - clamped);
        const jTip = actor.joints[iTip];
        if (jTip.pin || jTip.mass <= 0) continue;
        v.applyAxisAngle(axis, delta);
        tip[0] = hinge[0] + v.x; tip[1] = hinge[1] + v.y; tip[2] = hinge[2] + v.z;
      }
    }

    // --- muscle tone: a gentle pull back toward the rest pose -----------
    // Without this a ragdoll is a bag of bones; with it the character holds
    // a readable silhouette and returns to a stance when you let go.
    const tone = actor.physics.enabled ? actor.physics.tone : 0;
    if (tone > 0) {
      for (let i = 0; i < actor.joints.length; i++) {
        const j = actor.joints[i];
        if (j.pin || j.mass <= 0) continue;
        const p = pose[i]; const r = j.rest;
        p[0] += (r[0] - p[0]) * tone;
        p[1] += (r[1] - p[1]) * tone;
        p[2] += (r[2] - p[2]) * tone;
      }
    }

    // --- floor ---------------------------------------------------------
    if (actor.physics.enabled && actor.physics.floor) {
      for (let i = 0; i < actor.joints.length; i++) {
        const j = actor.joints[i];
        if (j.pin || j.mass <= 0) continue;
        const p = pose[i];
        if (p[upC] < j.radius) {
          p[upC] = j.radius;
          // kill the normal velocity so it settles instead of jittering
          st.prev[i * 3 + upC] = p[upC];
        }
      }
    }
  }
}

export const actorSolver = new ActorSolver();

/**
 * FABRIK on joint positions — the kinematic half, used by rig modes that
 * supply goals for a chain end rather than every joint.
 *
 * Chain is joint INDICES from root to tip. The root is held; the tip is
 * pulled to `goal`. Runs in the same actor-local space as everything else.
 */
export function solveFabrik(
  actor: TGActor, chain: number[], goal: Vec3, iterations = 10,
): void {
  if (chain.length < 2) return;
  const pts = chain.map((i) => new THREE.Vector3(...actor.pose[i]));
  const lens: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const bone = actor.bones.find(
      (b) => (b.a === actor.joints[chain[i]].id && b.b === actor.joints[chain[i + 1]].id)
        || (b.b === actor.joints[chain[i]].id && b.a === actor.joints[chain[i + 1]].id),
    );
    lens.push(bone ? boneRestLength(actor, bone) : pts[i].distanceTo(pts[i + 1]));
  }
  const reach = lens.reduce((a, b) => a + b, 0);
  const root = pts[0].clone();
  const target = new THREE.Vector3(...goal);

  if (root.distanceTo(target) > reach) {
    // Out of range: the honest answer is a straight line at full stretch,
    // not an infinite loop trying to close a gap that cannot close.
    const dir = target.clone().sub(root).normalize();
    for (let i = 1; i < pts.length; i++) pts[i].copy(pts[i - 1]).addScaledVector(dir, lens[i - 1]);
  } else {
    for (let k = 0; k < iterations; k++) {
      pts[pts.length - 1].copy(target);
      for (let i = pts.length - 2; i >= 0; i--) {
        const d = pts[i].clone().sub(pts[i + 1]);
        const l = d.length() || 1e-9;
        pts[i].copy(pts[i + 1]).addScaledVector(d.divideScalar(l), lens[i]);
      }
      pts[0].copy(root);
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i].clone().sub(pts[i - 1]);
        const l = d.length() || 1e-9;
        pts[i].copy(pts[i - 1]).addScaledVector(d.divideScalar(l), lens[i - 1]);
      }
      if (pts[pts.length - 1].distanceTo(target) < 1e-4) break;
    }
  }
  for (let i = 0; i < chain.length; i++) {
    const j = actor.joints[chain[i]];
    if (j.pin || j.mass <= 0) continue;
    actor.pose[chain[i]] = [pts[i].x, pts[i].y, pts[i].z];
  }
}
