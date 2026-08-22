// Rigging: turning inputs into joint goals.
//
// A rig never writes the pose directly. It pushes JointTargets into the
// solver, which means capture, mouse dragging and MIDI all arrive through
// one door and the body still responds with physics — a captured wrist
// drags the arm, it does not teleport it. The rig modes differ only in how
// many goals they produce and how they derive them:
//
//   MARKERS  every bound joint gets a goal at its landmark. Exact, and
//            inherits the performer's proportions and jitter wholesale.
//   ANGLES   only bone DIRECTIONS are taken; lengths stay the actor's own.
//            This is the mode that retargets a tall performer onto a short
//            character without stretching it.
//   IK       a handful of end effectors (wrists, ankles, head) become
//            FABRIK goals and the limbs in between are solved.
//   MANUAL   nothing automatic; drag tools and routes only.
//
// Everything is computed in ACTOR-LOCAL space, because that is the space
// the solver works in and the space the pose is stored in.
import * as THREE from 'three';
import type { GPScene, TGActor, TGRigBinding, Vec3 } from '../core/types';
import { actorSolver, solveFabrik } from './solver';
import { streamLandmarkWorld } from '../mm/streams';
import { worldMatrixOf } from '../tools/objects';

/**
 * Default joint -> MediaPipe pose landmark map. Indices are the standard
 * 33-point pose model. The midpoint entries are what make a capture model
 * with no spine usable as a spine: MediaPipe has no hips/chest/neck point,
 * only left/right pairs to average.
 */
const POSE_MAP: Record<string, [number, number | null]> = {
  hips: [23, 24],
  chest: [11, 12],
  neck: [11, 12],
  head: [0, null],
  'shoulder.L': [11, null], 'shoulder.R': [12, null],
  'elbow.L': [13, null], 'elbow.R': [14, null],
  'wrist.L': [15, null], 'wrist.R': [16, null],
  'hand.L': [19, null], 'hand.R': [20, null],
  'hip.L': [23, null], 'hip.R': [24, null],
  'knee.L': [25, null], 'knee.R': [26, null],
  'ankle.L': [27, null], 'ankle.R': [28, null],
  'foot.L': [31, null], 'foot.R': [32, null],
};

/** Joints that IK mode treats as end effectors, with the chain that
 *  reaches each. Everything else is left to physics. */
const IK_CHAINS: [string, string[]][] = [
  ['wrist.L', ['chest', 'shoulder.L', 'elbow.L', 'wrist.L']],
  ['wrist.R', ['chest', 'shoulder.R', 'elbow.R', 'wrist.R']],
  ['ankle.L', ['hips', 'hip.L', 'knee.L', 'ankle.L']],
  ['ankle.R', ['hips', 'hip.R', 'knee.R', 'ankle.R']],
];

/**
 * Build bindings for every joint whose name is in the pose map. Named
 * "auto" because it needs nothing from the user but a stream — the joint
 * names in skeleton.ts were chosen to make this table possible.
 */
export function autoRig(actor: TGActor, streamId: number | null): TGRigBinding[] {
  const out: TGRigBinding[] = [];
  for (const j of actor.joints) {
    const m = POSE_MAP[j.name];
    if (!m) continue;
    out.push({ joint: j.id, streamId, landmark: m[0], landmark2: m[1], weight: 1 });
  }
  return out;
}

/** Chains IK mode drives, resolved to joint indices for this actor. */
function ikChains(actor: TGActor): { tip: number; chain: number[] }[] {
  const index = (name: string) => actor.joints.findIndex((j) => j.name === name);
  const out: { tip: number; chain: number[] }[] = [];
  for (const [tipName, names] of IK_CHAINS) {
    const chain = names.map(index);
    if (chain.some((i) => i < 0)) continue;
    out.push({ tip: index(tipName), chain });
  }
  return out;
}

export class ActorRig {
  /** smoothed targets per actor, keyed by joint id — capture is noisy and
   *  an unsmoothed pin makes the whole body buzz */
  private smoothed = new Map<number, Map<number, Vec3>>();

  reset(actorId?: number): void {
    if (actorId === undefined) this.smoothed.clear();
    else this.smoothed.delete(actorId);
  }

  update(scene: GPScene, _dt: number): void {
    for (const actor of scene.actors) {
      if (actor.rig.mode === 'NONE' || actor.rig.mode === 'MANUAL') continue;
      const toLocal = worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id }).invert();
      const captured = this.sample(scene, actor, toLocal);
      if (!captured.size) continue;
      if (actor.rig.mode === 'MARKERS') this.markers(actor, captured);
      else if (actor.rig.mode === 'ANGLES') this.angles(actor, captured);
      else if (actor.rig.mode === 'IK') this.ik(actor, captured);
    }
  }

  /** Read every binding into actor-local space, smoothed. Keyed by JOINT
   *  INDEX so the solvers below never have to look ids up again. */
  private sample(
    scene: GPScene, actor: TGActor, toLocal: THREE.Matrix4,
  ): Map<number, Vec3> {
    const out = new Map<number, Vec3>();
    let cache = this.smoothed.get(actor.id);
    if (!cache) { cache = new Map(); this.smoothed.set(actor.id, cache); }
    const alpha = 1 - Math.max(0, Math.min(0.99, actor.rig.smoothing));
    const v = new THREE.Vector3();

    for (const b of actor.rig.bindings) {
      const idx = actor.joints.findIndex((j) => j.id === b.joint);
      if (idx < 0) continue;
      const streamId = b.streamId ?? actor.rig.streamId;
      const stream = scene.mmStreams.find((s) => s.id === streamId);
      if (!stream) continue;
      const p1 = streamLandmarkWorld(scene, stream, b.landmark);
      if (!p1) continue;
      let x = p1[0], y = p1[1], z = p1[2];
      if (b.landmark2 != null) {
        const p2 = streamLandmarkWorld(scene, stream, b.landmark2);
        if (!p2) continue;
        x = (x + p2[0]) / 2; y = (y + p2[1]) / 2; z = (z + p2[2]) / 2;
      }
      v.set(x, y, z).applyMatrix4(toLocal);
      const prev = cache.get(b.joint);
      const next: Vec3 = prev
        ? [prev[0] + (v.x - prev[0]) * alpha,
          prev[1] + (v.y - prev[1]) * alpha,
          prev[2] + (v.z - prev[2]) * alpha]
        : [v.x, v.y, v.z];
      cache.set(b.joint, next);
      out.set(idx, next);
    }
    return out;
  }

  /** 1:1 — pin every bound joint to its landmark. */
  private markers(actor: TGActor, captured: Map<number, Vec3>): void {
    const w = actor.rig.strength;
    for (const [index, pos] of captured) {
      const bind = actor.rig.bindings.find((b) => actor.joints[index]?.id === b.joint);
      actorSolver.addTarget(actor.id, { index, pos, weight: w * (bind?.weight ?? 1) });
    }
  }

  /**
   * Directions only. Walk the real bones outward from the root, and place
   * each child at parent + capturedDirection * OUR rest length. The
   * performer's proportions never enter the result — only their angles.
   *
   * Bones are visited in array order, which skeleton.ts authors root-first;
   * a bone whose parent has already been placed therefore builds on the
   * retargeted position rather than the captured one, which is what keeps
   * the limb chain self-consistent.
   */
  private angles(actor: TGActor, captured: Map<number, Vec3>): void {
    const w = actor.rig.strength;
    const idx = new Map(actor.joints.map((j, i) => [j.id, i]));
    const placed = new Map<number, Vec3>();

    // root: follow the performer around the space
    const rootIdx = actor.joints.findIndex((j) => j.name === 'hips');
    if (rootIdx >= 0 && captured.has(rootIdx)) {
      const pos = captured.get(rootIdx)!;
      placed.set(rootIdx, pos);
      actorSolver.addTarget(actor.id, { index: rootIdx, pos, weight: w });
    }

    for (const bone of actor.bones) {
      if (bone.radius <= 0) continue;          // braces carry no direction
      const ia = idx.get(bone.a); const ib = idx.get(bone.b);
      if (ia === undefined || ib === undefined) continue;
      const ca = captured.get(ia); const cb = captured.get(ib);
      if (!ca || !cb) continue;
      const dx = cb[0] - ca[0], dy = cb[1] - ca[1], dz = cb[2] - ca[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-6) continue;
      const restLen = Math.hypot(
        actor.joints[ib].rest[0] - actor.joints[ia].rest[0],
        actor.joints[ib].rest[1] - actor.joints[ia].rest[1],
        actor.joints[ib].rest[2] - actor.joints[ia].rest[2],
      );
      const from = placed.get(ia) ?? actor.pose[ia];
      const pos: Vec3 = [
        from[0] + (dx / d) * restLen,
        from[1] + (dy / d) * restLen,
        from[2] + (dz / d) * restLen,
      ];
      placed.set(ib, pos);
      actorSolver.addTarget(actor.id, { index: ib, pos, weight: w });
    }
  }

  /** A few captured points as IK goals; the limbs between are solved. */
  private ik(actor: TGActor, captured: Map<number, Vec3>): void {
    const w = actor.rig.strength;
    // anchors: the body follows the torso, the limbs reach
    for (const name of ['hips', 'chest', 'head']) {
      const i = actor.joints.findIndex((j) => j.name === name);
      const pos = i >= 0 ? captured.get(i) : undefined;
      if (pos) actorSolver.addTarget(actor.id, { index: i, pos, weight: w });
    }
    for (const { tip, chain } of ikChains(actor)) {
      const goal = captured.get(tip);
      if (!goal) continue;
      // FABRIK writes the pose for the chain directly (it is a kinematic
      // solve, not a force), then the tip is pinned so physics keeps it
      // there while the rest of the body reacts.
      solveFabrik(actor, chain, goal);
      actorSolver.addTarget(actor.id, { index: tip, pos: goal, weight: w });
    }
  }
}

export const actorRig = new ActorRig();
