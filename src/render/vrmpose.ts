// Driving a VRM humanoid from our positional skeleton.
//
// This is the INVERSE of everything else in the actor pipeline. A glTF clip
// or an ARDY rollout comes in as rotations and we sample it down to joint
// POSITIONS, because positions are what our solver speaks. A VRM avatar is
// the other way round: it is a rotation rig, and the only way to move it is
// to tell each humanoid bone which way to point.
//
// So: for every bone, work out the direction it points at REST, work out the
// direction the matching pair of our joints points NOW, and rotate the bone
// by the difference. Root-first, so a parent's rotation is already applied
// before its children aim — otherwise every bone below the hips is wrong by
// however much the hips turned.
//
// It runs against `VRMHumanoid.getNormalizedBoneNode`, whose whole purpose
// is this: a parallel hierarchy in a canonical T-pose, Y-up, facing +Z, with
// identity rest rotations, so retargeting does not have to care how the
// artist happened to build the model. The `HumanoidRig` interface is there
// so the maths can be exercised against a synthetic hierarchy without
// needing a .vrm file.
import * as THREE from 'three';
import type { TGActor } from '../core/types';

/** The subset of VRM's humanoid vocabulary we can drive. */
export type HumanBone =
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'leftUpperArm' | 'leftLowerArm' | 'leftHand'
  | 'rightUpperArm' | 'rightLowerArm' | 'rightHand'
  | 'leftUpperLeg' | 'leftLowerLeg' | 'leftFoot' | 'leftToes'
  | 'rightUpperLeg' | 'rightLowerLeg' | 'rightFoot' | 'rightToes';

export interface HumanoidRig {
  getBone(name: HumanBone): THREE.Object3D | null;
}

/**
 * Which of OUR joint pairs aims which bone, in hierarchy order.
 *
 * Note the sides look swapped, and they are — deliberately. This skeleton's
 * `.L` is the +X side, which with its +Y-forward / +Z-up frame is
 * anatomically the character's RIGHT (see CLAUDE.md). VRM's `left*` bones
 * are genuinely on the character's left. Mapping `.L` to `left*` would
 * mirror the avatar. The default below assumes our documented convention;
 * `poseHumanoid` verifies it against the model at bind time and flips if a
 * particular rig disagrees, rather than trusting either of us.
 */
const CHAINS: [HumanBone, string, string][] = [
  ['hips', 'hips', 'spine'],
  ['spine', 'spine', 'chest'],
  ['chest', 'chest', 'neck'],
  ['neck', 'neck', 'head'],
  ['rightUpperArm', 'shoulder.L', 'elbow.L'],
  ['rightLowerArm', 'elbow.L', 'wrist.L'],
  ['rightHand', 'wrist.L', 'hand.L'],
  ['leftUpperArm', 'shoulder.R', 'elbow.R'],
  ['leftLowerArm', 'elbow.R', 'wrist.R'],
  ['leftHand', 'wrist.R', 'hand.R'],
  ['rightUpperLeg', 'hip.L', 'knee.L'],
  ['rightLowerLeg', 'knee.L', 'ankle.L'],
  ['rightFoot', 'ankle.L', 'foot.L'],
  ['leftUpperLeg', 'hip.R', 'knee.R'],
  ['leftLowerLeg', 'knee.R', 'ankle.R'],
  ['leftFoot', 'ankle.R', 'foot.R'],
];

const MIRROR: Record<string, string> = {
  leftUpperArm: 'rightUpperArm', rightUpperArm: 'leftUpperArm',
  leftLowerArm: 'rightLowerArm', rightLowerArm: 'leftLowerArm',
  leftHand: 'rightHand', rightHand: 'leftHand',
  leftUpperLeg: 'rightUpperLeg', rightUpperLeg: 'leftUpperLeg',
  leftLowerLeg: 'rightLowerLeg', rightLowerLeg: 'leftLowerLeg',
  leftFoot: 'rightFoot', rightFoot: 'leftFoot',
  leftToes: 'rightToes', rightToes: 'leftToes',
};

/** Rest directions, captured once per rig — they are what we rotate FROM. */
export interface HumanoidBind {
  /** unit rest direction of each bone, in the normalized rig's world space */
  restDir: Map<HumanBone, THREE.Vector3>;
  /** hips height at rest, for scaling our actor onto this body */
  hipHeight: number;
  /** true when this rig labels its sides the opposite way to our skeleton */
  swapSides: boolean;
}

/**
 * Measure a rig's rest pose. Call once after load, before posing it.
 */
export function bindHumanoid(rig: HumanoidRig, actor: TGActor): HumanoidBind {
  const restDir = new Map<HumanBone, THREE.Vector3>();
  const world = (o: THREE.Object3D): THREE.Vector3 => {
    o.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
  };
  // A bone's rest direction is toward the next bone down its own chain.
  const NEXT: Partial<Record<HumanBone, HumanBone>> = {
    hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head',
    leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand',
    rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
    leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
    rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes',
  };
  for (const [bone, next] of Object.entries(NEXT) as [HumanBone, HumanBone][]) {
    const a = rig.getBone(bone); const b = rig.getBone(next);
    if (!a || !b) continue;
    const d = world(b).sub(world(a));
    if (d.lengthSq() > 1e-10) restDir.set(bone, d.normalize());
  }
  // hands and feet have no child bone in the map; aim them along their parent
  for (const [leaf, parent] of [
    ['leftHand', 'leftLowerArm'], ['rightHand', 'rightLowerArm'],
  ] as [HumanBone, HumanBone][]) {
    if (!restDir.has(leaf) && restDir.has(parent)) {
      restDir.set(leaf, restDir.get(parent)!.clone());
    }
  }

  const hips = rig.getBone('hips');
  const hipHeight = hips ? world(hips).y : 1;

  // Handedness, checked rather than assumed: compare the rig's own
  // foot-to-foot direction against ours, both expressed with +X to one side.
  let swapSides = false;
  const lf = rig.getBone('leftFoot'); const rf = rig.getBone('rightFoot');
  const ourL = actor.joints.find((j) => j.name === 'ankle.L')?.rest;
  const ourR = actor.joints.find((j) => j.name === 'ankle.R')?.rest;
  if (lf && rf && ourL && ourR) {
    // Our `.L` drives the rig's RIGHT by default. Our lateral axis is
    // NEGATED on the way into the rig's frame (see `toRig`), so a rig that
    // agrees with us has our (L - R) and its (left - right) pointing the
    // SAME way once that negation is applied — i.e. opposite before it.
    const rigLateral = world(lf).x - world(rf).x;
    const ourLateral = -(ourL[0] - ourR[0]);
    if (rigLateral * ourLateral > 0) swapSides = true;
  }
  return { restDir, hipHeight, swapSides };
}

/**
 * Aim every mapped bone at the direction our actor's joints imply.
 *
 * `toRig` converts a direction from the ACTOR's frame into the rig's
 * normalized frame (Y-up, +Z forward).
 */
export function poseHumanoid(
  rig: HumanoidRig, bind: HumanoidBind, actor: TGActor, upZ: boolean,
): void {
  const idx = new Map(actor.joints.map((j, i) => [j.name, i]));
  const pose = actor.pose;

  // Actor frame -> VRM normalized frame. Ours is +Y forward / +Z up in a
  // Z-up scene; VRM is +Z forward / +Y up.
  //
  // The X flip is NOT optional and is easy to get wrong: mapping
  // (x, y, z) -> (x, z, y) sends forward and up to the right places, but it
  // SWAPS TWO AXES, so its determinant is -1 and it is a reflection. Feed an
  // avatar a mirrored skeleton and every limb still lands somewhere
  // plausible — it is simply the wrong arm, which reads as a rig that is
  // subtly, unfixably wrong rather than as a bad transform. Negating x makes
  // it a proper rotation, and then our `.L` (the +X side, anatomically the
  // character's RIGHT) drives VRM's `right*`, which is what CHAINS assumes.
  const toRig = (v: THREE.Vector3): THREE.Vector3 => (upZ
    ? new THREE.Vector3(-v.x, v.z, v.y)
    : new THREE.Vector3(-v.x, v.y, -v.z));

  const dirOf = (from: string, to: string): THREE.Vector3 | null => {
    const a = idx.get(from); const b = idx.get(to);
    if (a === undefined || b === undefined) return null;
    const d = new THREE.Vector3(
      pose[b][0] - pose[a][0], pose[b][1] - pose[a][1], pose[b][2] - pose[a][2],
    );
    if (d.lengthSq() < 1e-10) return null;
    return toRig(d.normalize());
  };

  const q = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();
  const cur = new THREE.Vector3();

  for (const [boneName, from, to] of CHAINS) {
    const name = (bind.swapSides ? (MIRROR[boneName] ?? boneName) : boneName) as HumanBone;
    const bone = rig.getBone(name);
    const rest = bind.restDir.get(name);
    const target = dirOf(from, to);
    if (!bone || !rest || !target) continue;

    // Where this bone points RIGHT NOW, with its parents already posed. The
    // root-first order is what makes this valid: read the world rotation
    // after the chain above has been set, never before.
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(q);
    cur.copy(rest).applyQuaternion(q).normalize();

    const delta = new THREE.Quaternion().setFromUnitVectors(cur, target);
    const world = delta.multiply(q);

    if (bone.parent) {
      bone.parent.updateWorldMatrix(true, false);
      bone.parent.getWorldQuaternion(parentQ);
      bone.quaternion.copy(parentQ.invert().multiply(world));
    } else {
      bone.quaternion.copy(world);
    }
    bone.updateMatrixWorld(true);
  }
}

/** How much to scale a rig so its hips sit at our actor's hip height. */
export function humanoidScale(bind: HumanoidBind, actor: TGActor, upZ: boolean): number {
  const upAxis = upZ ? 2 : 1;
  const hips = actor.joints.find((j) => j.name === 'hips')?.rest;
  const ankle = actor.joints.find((j) => j.name === 'ankle.L')?.rest;
  if (!hips || !ankle || bind.hipHeight <= 0.01) return 1;
  // measure OUR hips above the ground the same way the rig measures its own
  return (hips[upAxis]) / bind.hipHeight;
}
