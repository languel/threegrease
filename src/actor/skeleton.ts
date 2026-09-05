// The default mannequin, and the helpers for building any actor skeleton.
//
// Proportions are canonical-figure (roughly 7.5 heads), authored Z-UP with
// the origin BETWEEN THE FEET so a fresh actor stands on the ground plane
// instead of sinking half-way through it. `upAxis` is a setting, so
// createHumanoid() mirrors the layout into Y-up on request rather than
// leaving the character lying on its back.
//
// Joint names deliberately match the MediaPipe pose vocabulary where they
// overlap (shoulder/elbow/wrist/hip/knee/ankle, .L/.R suffixes) — that is
// what lets autoRig() bind a capture stream without a hand-written table.
import * as THREE from 'three';
import type { GPScene, TGActor, TGBone, TGJoint, TGJointLimit, Vec3 } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import { defaultGait } from './gait';
import { defaultLayers } from './mixer';

/** height, in world units, of the default figure */
export const ACTOR_HEIGHT = 1.8;

interface JointSpec {
  name: string;
  /** [right, forward, up] at rest, in units of total height */
  at: [number, number, number];
  radius: number;
  mass?: number;
}

/** One side's limbs are authored once and mirrored, so left and right can
 *  never drift apart. `s` is +1 for the left side, -1 for the right. */
function limbSpecs(s: number, side: string): JointSpec[] {
  return [
    // Arms HANG: the x barely grows down the chain. Fanning them outward
    // (which is what a naive T-pose does) reads as a scarecrow, and worse,
    // gives the angle rig a rest direction nothing like the captured one.
    { name: `shoulder.${side}`, at: [0.105 * s, 0, 0.806], radius: 0.042 },
    { name: `elbow.${side}`, at: [0.116 * s, 0, 0.644], radius: 0.034 },
    { name: `wrist.${side}`, at: [0.124 * s, 0, 0.500], radius: 0.026 },
    { name: `hand.${side}`, at: [0.127 * s, 0.012, 0.444], radius: 0.030 },
    { name: `hip.${side}`, at: [0.055 * s, 0, 0.528], radius: 0.048 },
    { name: `knee.${side}`, at: [0.058 * s, 0, 0.285], radius: 0.042 },
    { name: `ankle.${side}`, at: [0.058 * s, 0, 0.045], radius: 0.034 },
    { name: `foot.${side}`, at: [0.058 * s, 0.075, 0.012], radius: 0.030 },
  ];
}

const SPINE_SPECS: JointSpec[] = [
  { name: 'hips', at: [0, 0, 0.530], radius: 0.075, mass: 3 },
  { name: 'spine', at: [0, 0, 0.665], radius: 0.070, mass: 2 },
  // `chest` sits ON the shoulder line, not below it. Anatomically it is
  // the sternum/clavicle level rather than the mid-chest, and that is
  // deliberate: capture models have no chest point, so it binds to the
  // MIDPOINT OF THE SHOULDERS. If the rest position were lower, the
  // captured chest->shoulder direction would be horizontal while ours
  // pointed up, and angle retargeting would shorten the figure every
  // frame — it measurably did, costing ~0.5 units of height.
  { name: 'chest', at: [0, 0, 0.806], radius: 0.072, mass: 2.5 },
  { name: 'neck', at: [0, 0, 0.851], radius: 0.038 },
  { name: 'head', at: [0, 0, 0.900], radius: 0.078, mass: 1.2 },
];

/** bones as name pairs — resolved to ids once the joints exist */
const SPINE_BONES: [string, string, number][] = [
  ['hips', 'spine', 0.070], ['spine', 'chest', 0.075],
  ['chest', 'neck', 0.045], ['neck', 'head', 0.050],
];
function limbBones(side: string): [string, string, number][] {
  return [
    ['chest', `shoulder.${side}`, 0.050],
    [`shoulder.${side}`, `elbow.${side}`, 0.040],
    [`elbow.${side}`, `wrist.${side}`, 0.032],
    [`wrist.${side}`, `hand.${side}`, 0.028],
    ['hips', `hip.${side}`, 0.055],
    [`hip.${side}`, `knee.${side}`, 0.052],
    [`knee.${side}`, `ankle.${side}`, 0.042],
    [`ankle.${side}`, `foot.${side}`, 0.030],
  ];
}

/**
 * Bones that must not fold the wrong way, rebuilt from joint NAMES.
 *
 * Two things were wrong with the table this replaces, and they compounded:
 *
 *  - It named the wrong bones. A limit names its bones by the joint they
 *    END at, so `(knee, hip)` resolved to the bones `hip->knee` and
 *    `hips->hip` — which measures the HIP's abduction, not the knee's bend.
 *    The knee and the elbow were never constrained by anything. To limit a
 *    knee you name the bone below it: `(ankle, knee)`.
 *  - Even correctly aimed, an angle limit cannot express a hinge. The angle
 *    between two bones is UNSIGNED, so a knee bent 40 degrees forward and
 *    one bent 40 degrees backward both measure 140 and both pass. The two
 *    are mirror images about the hip-to-ankle line and nothing preferred
 *    either, which is why a limb would sit double-jointed and snap between
 *    the two on every step. The `pole` says which side is the right one.
 *
 * Forward is read off the SKELETON (the foot sits ahead of the ankle, the
 * head above the hips) rather than off the up-axis setting, so this works
 * in either convention, at any scale, and on a loaded actor whose
 * authoring frame is no longer known.
 */
export function rebuildLimbRules(actor: TGActor): void {
  const forward = forwardOf(actor);
  if (!forward) return;
  const back: Vec3 = [-forward[0], -forward[1], -forward[2]];
  const byName = new Map(actor.joints.map((j) => [j.name, j.id]));
  const boneBetween = (a: string, b: string): TGBone | undefined =>
    actor.bones.find((bo) => bo.a === byName.get(a) && bo.b === byName.get(b));

  const limits: TGJointLimit[] = [];
  for (const side of ['L', 'R']) {
    const hinges: [string, string, string, Vec3][] = [
      // [root, hinge, tip, which way the hinge is allowed to stick out]
      [`hip.${side}`, `knee.${side}`, `ankle.${side}`, forward],
      [`shoulder.${side}`, `elbow.${side}`, `wrist.${side}`, back],
    ];
    for (const [root, hinge, tip, pole] of hinges) {
      const parent = boneBetween(root, hinge);
      const child = boneBetween(hinge, tip);
      // 180 is straight through, 0 is folded flat against itself
      if (parent && child) {
        limits.push({ bone: child.id, parent: parent.id, min: 15, max: 178, pole: [...pole] as Vec3 });
      }
    }
  }
  actor.limits = limits;

  // Leaf bones have nothing below them to hold their direction, so they are
  // tracked to their rest direction instead. Strong enough to keep a foot
  // pointing forward through a stride; not a pin, so the ankle still leads.
  const leaf: [string, string][] = [];
  for (const side of ['L', 'R']) {
    leaf.push([`ankle.${side}`, `foot.${side}`], [`wrist.${side}`, `hand.${side}`]);
  }
  for (const [a, b] of leaf) {
    const bone = boneBetween(a, b);
    if (bone) bone.trackRest = 0.5;
  }
}

/** The actor's own forward direction, recovered from its rest skeleton. */
function forwardOf(actor: TGActor): Vec3 | null {
  const rest = (name: string): Vec3 | undefined =>
    actor.joints.find((j) => j.name === name)?.rest;
  const head = rest('head'); const hips = rest('hips');
  const ankle = rest('ankle.L'); const foot = rest('foot.L');
  if (!head || !hips || !ankle || !foot) return null;
  const dominant = (v: number[], skip = -1): number => {
    let best = -1; let mag = 0;
    for (let i = 0; i < 3; i++) {
      if (i === skip) continue;
      if (Math.abs(v[i]) > mag) { mag = Math.abs(v[i]); best = i; }
    }
    return best;
  };
  const upAxis = dominant([head[0] - hips[0], head[1] - hips[1], head[2] - hips[2]]);
  if (upAxis < 0) return null;
  const d = [foot[0] - ankle[0], foot[1] - ankle[1], foot[2] - ankle[2]];
  const fwdAxis = dominant(d, upAxis);
  if (fwdAxis < 0) return null;
  const forward: Vec3 = [0, 0, 0];
  forward[fwdAxis] = Math.sign(d[fwdAxis]) || 1;
  return forward;
}

/** Cross-braces: without them a chain of distance constraints has no
 *  resistance to shear and the torso shrugs itself inside out. These are
 *  ordinary bones with radius 0, so they simulate but never draw. */
function braceBones(): [string, string, number][] {
  return [
    ['shoulder.L', 'shoulder.R', 0], ['hip.L', 'hip.R', 0],
    ['shoulder.L', 'hips', 0], ['shoulder.R', 'hips', 0],
    ['chest', 'hip.L', 0], ['chest', 'hip.R', 0],
    ['neck', 'shoulder.L', 0], ['neck', 'shoulder.R', 0],
  ];
}

/** Map an authored [right, forward, up] triple into the scene's up axis. */
function place(at: [number, number, number], h: number, upZ: boolean): Vec3 {
  const [r, f, u] = at;
  return upZ ? [r * h, f * h, u * h] : [r * h, u * h, -f * h];
}

export function createHumanoid(
  id: number, name: string, upZ: boolean, height = ACTOR_HEIGHT,
): TGActor {
  const specs = [...SPINE_SPECS, ...limbSpecs(1, 'L'), ...limbSpecs(-1, 'R')];
  const joints: TGJoint[] = specs.map((sp, i) => ({
    id: i + 1,
    name: sp.name,
    rest: place(sp.at, height, upZ),
    mass: sp.mass ?? 1,
    pin: false,
    radius: sp.radius * height,
  }));
  const byName = new Map(joints.map((j) => [j.name, j.id]));

  const bonePairs = [...SPINE_BONES, ...limbBones('L'), ...limbBones('R'), ...braceBones()];
  const bones: TGBone[] = bonePairs.map(([a, b, r], i) => ({
    id: i + 1,
    name: `${a}→${b}`,
    a: byName.get(a)!,
    b: byName.get(b)!,
    stiffness: 1,
    radius: r * height,
  }));
  const boneByName = new Map(bones.map((b) => [b.name, b.id]));

  void boneByName;

  const actor: TGActor = {
    id,
    name,
    joints,
    bones,
    limits: [],
    pose: joints.map((j) => [...j.rest] as Vec3),
    rig: {
      mode: 'NONE', streamId: null, bindings: [], strength: 1,
      smoothing: 0.35, matchScale: true, minConfidence: 0.25,
    },
    physics: {
      enabled: false, gravity: 9.81, damping: 0.98, iterations: 8,
      tone: 0.06, floor: true, selfCollide: false, hinges: true,
    },
    layers: defaultLayers(),
    gait: defaultGait(),
    shape: 'BOTH',
    color: [0.72, 0.74, 0.80],
    opacity: 1,
    visible: true,
    select: false,
    parent: null,
    constraints: [],
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  rebuildLimbRules(actor);
  return actor;
}

export function jointByName(actor: TGActor, name: string): TGJoint | undefined {
  return actor.joints.find((j) => j.name === name);
}

export function jointIndex(actor: TGActor, id: number): number {
  return actor.joints.findIndex((j) => j.id === id);
}

/** Rest length of a bone, from the rest pose (never from the live one —
 *  measuring the live pose would let the skeleton creep). */
export function boneRestLength(actor: TGActor, bone: TGBone): number {
  const a = actor.joints.find((j) => j.id === bone.a);
  const b = actor.joints.find((j) => j.id === bone.b);
  if (!a || !b) return 0;
  return Math.hypot(b.rest[0] - a.rest[0], b.rest[1] - a.rest[1], b.rest[2] - a.rest[2]);
}

/** Drop the actor back into its T-pose. */
export function resetPose(actor: TGActor): void {
  actor.pose = actor.joints.map((j) => [...j.rest] as Vec3);
}

const JOINT_UP = new THREE.Vector3(0, 1, 0);

/**
 * World-space position + orientation of one joint, for attaching other
 * scene objects to a rig control — a camera on the head, a sword in a
 * hand. Position comes straight from the live pose; orientation is
 * DERIVED, since joints store no rotation of their own, from the bone
 * leading INTO the joint (same convention render/actors.ts uses to orient
 * a limb capsule: UP maps onto the bone direction). The root joint has no
 * incoming bone and reports the actor's own orientation instead.
 */
export function jointWorldMatrix(
  scene: GPScene, actor: TGActor, jointName: string,
): THREE.Matrix4 | null {
  const idx = actor.joints.findIndex((j) => j.name === jointName);
  if (idx < 0 || !actor.pose[idx]) return null;
  const joint = actor.joints[idx];
  const pos = new THREE.Vector3(...actor.pose[idx]);

  // prefer a REAL (drawn) bone ending at this joint over a zero-radius
  // brace, which exists only for simulation and points somewhere the
  // viewer never sees
  const inBone = actor.bones.find((b) => b.b === joint.id && b.radius > 0)
    ?? actor.bones.find((b) => b.a === joint.id && b.radius > 0);
  const quat = new THREE.Quaternion();
  if (inBone) {
    const aIdx = actor.joints.findIndex((j) => j.id === inBone.a);
    const bIdx = actor.joints.findIndex((j) => j.id === inBone.b);
    if (aIdx >= 0 && bIdx >= 0) {
      const a = actor.pose[aIdx]; const b = actor.pose[bIdx];
      const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (dir.lengthSq() > 1e-9) quat.setFromUnitVectors(JOINT_UP, dir.normalize());
    }
  }

  const local = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
  return local.premultiply(worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id }));
}
