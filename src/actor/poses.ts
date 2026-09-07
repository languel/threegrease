// Named poses: the two standards, and a library of your own.
//
// A pose here is what this skeleton already is — named joint POSITIONS —
// stored actor-local and divided by the actor's own scale, so a pose taken
// from a 1.8 m figure lands correctly on a 1.2 m one. Nothing about a pose
// is a rotation, which is why capturing one is a copy and applying one is a
// write: there is no rig to solve against, no retarget, no bind pose.
//
// T and A are DERIVED from the rest stance rather than authored as tables of
// numbers. The skeleton's proportions are allowed to change (they have), and
// a hand-written T-pose would silently stop matching the figure it claims to
// describe. Rotating the arm chain about the shoulder cannot drift: it keeps
// every bone length exactly, and it reads the arm's current angle rather
// than assuming the rest arm hangs straight down.
import type { GPScene, TGActor, TGPose, Vec3 } from '../core/types';
import { actorMixer } from './mixer';
import { actorSolver } from './solver';

/** The reference figure's head radius, the one number the skeleton scales
 *  everything else from — see SPINE_SPECS. */
const HEAD_R = 0.067;

/**
 * How hard a held pose pulls.
 *
 * `applyTargets` CLAMPS a weight to 1 and treats 1 as a hard pin, so asking
 * for more is not "stronger" — it is the same pin, and the extra was
 * arithmetic that never happened. Slightly under 1 leaves the bone pass room
 * to keep its lengths, which is what stops a held arm from settling short.
 */
const HOLD_PULL = 0.85;

/**
 * How big this actor is relative to the authored skeleton.
 *
 * Taken from the HEAD's radius rather than from a height measured out of the
 * rest positions, because it is one multiplication away from the spec and
 * does not care which axis is up.
 */
export function actorScale(actor: TGActor): number {
  const head = actor.joints.find((j) => j.name === 'head');
  return head && head.radius > 0 ? head.radius / HEAD_R : 1;
}

/** Rest positions — the natural stance the skeleton was authored in. */
export function restPositions(actor: TGActor): Vec3[] {
  return actor.joints.map((j) => [...j.rest] as Vec3);
}

/**
 * The rest stance with both arms swung out to a given angle from straight
 * down: 90 degrees is a T, 45 an A.
 *
 * The chain rotates about the SHOULDER in the plane the arm already hangs
 * in, so bone lengths survive exactly and the elbow keeps whatever natural
 * offset the skeleton gives it — an arm that is subtly bent stays subtly
 * bent, which is what makes an A-pose look like a person rather than a
 * diagram.
 */
export function armsAt(actor: TGActor, degrees: number, upZ: boolean): Vec3[] {
  const out = restPositions(actor);
  const up = upZ ? 2 : 1;
  const idx = (name: string) => actor.joints.findIndex((j) => j.name === name);
  const target = (degrees * Math.PI) / 180;

  for (const side of ['L', 'R'] as const) {
    const iShoulder = idx(`shoulder.${side}`);
    const chain = [`elbow.${side}`, `wrist.${side}`, `hand.${side}`].map(idx);
    const iHand = chain[chain.length - 1];
    if (iShoulder < 0 || iHand < 0) continue;
    // This skeleton's `.L` is the +X side (see the retargeting notes), so
    // "outward" is +X for L and -X for R.
    const sgn = side === 'L' ? 1 : -1;
    const o0 = (out[iHand][0] - out[iShoulder][0]) * sgn;
    const d0 = -(out[iHand][up] - out[iShoulder][up]);
    const current = Math.atan2(o0, d0);
    const delta = target - current;
    if (Math.abs(delta) < 1e-6) continue;
    const cos = Math.cos(delta); const sin = Math.sin(delta);
    for (const i of chain) {
      if (i < 0) continue;
      const o = (out[i][0] - out[iShoulder][0]) * sgn;
      const d = -(out[i][up] - out[iShoulder][up]);
      // rotate (outward, down) by delta — a pure rotation, so the distance
      // from the shoulder is untouched and every bone keeps its length
      const o2 = o * cos + d * sin;
      const d2 = d * cos - o * sin;
      const p = [...out[i]] as Vec3;
      p[0] = out[iShoulder][0] + o2 * sgn;
      p[up] = out[iShoulder][up] - d2;
      out[i] = p;
    }
  }
  return out;
}

export const tPosePositions = (a: TGActor, upZ: boolean): Vec3[] => armsAt(a, 90, upZ);
export const aPosePositions = (a: TGActor, upZ: boolean): Vec3[] => armsAt(a, 45, upZ);

/** Snapshot the live pose, keyed by joint NAME and scale-free. */
export function capturePose(actor: TGActor, id: number, name: string): TGPose {
  const s = actorScale(actor) || 1;
  const joints: Record<string, Vec3> = {};
  for (let i = 0; i < actor.joints.length; i++) {
    const p = actor.pose[i];
    if (!p) continue;
    joints[actor.joints[i].name] = [p[0] / s, p[1] / s, p[2] / s];
  }
  return { id, name, joints };
}

/**
 * Write a stored pose onto an actor.
 *
 * Joints the pose does not mention keep what they have, so a pose captured
 * from a figure with extra joints (or missing ones) still applies as far as
 * it goes rather than tearing the skeleton apart.
 */
export function applyPose(actor: TGActor, pose: TGPose): void {
  const s = actorScale(actor) || 1;
  for (let i = 0; i < actor.joints.length; i++) {
    const src = pose.joints[actor.joints[i].name];
    if (!src) continue;
    actor.pose[i] = [src[0] * s, src[1] * s, src[2] * s];
  }
}

/**
 * A pose flattened to 2D line segments for a thumbnail, seen from the front
 * and fitted to a unit box.
 *
 * The BONES come from the actor being edited, not from the pose: a pose is
 * joint names and says nothing about topology, and drawing it against the
 * skeleton it is about to be applied to is what makes the thumbnail a
 * preview rather than a picture of something else.
 */
export function poseSegments(
  pose: TGPose, actor: TGActor, upZ: boolean,
): { lines: [number, number, number, number][]; dots: [number, number][] } {
  const up = upZ ? 2 : 1;
  const at = (name: string): [number, number] | null => {
    const p = pose.joints[name];
    return p ? [p[0], p[up]] : null;
  };
  const pts: [number, number][] = [];
  const lines: [number, number, number, number][] = [];
  const byId = new Map(actor.joints.map((j, i) => [j.id, i]));
  for (const b of actor.bones) {
    if (b.radius <= 0) continue; // braces are simulation-only
    const ia = byId.get(b.a); const ib = byId.get(b.b);
    if (ia === undefined || ib === undefined) continue;
    const p = at(actor.joints[ia].name); const q = at(actor.joints[ib].name);
    if (!p || !q) continue;
    lines.push([p[0], p[1], q[0], q[1]]);
    pts.push(p, q);
  }
  for (const j of actor.joints) { const p = at(j.name); if (p) pts.push(p); }
  if (!pts.length) return { lines: [], dots: [] };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // one scale for both axes, or a wide pose (a T) comes out squashed into a
  // tall box and stops being recognisable at 40 px
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const ox = (minX + maxX) / 2; const oy = (minY + maxY) / 2;
  const nx = (x: number) => 0.5 + (x - ox) / span;
  const ny = (y: number) => 0.5 - (y - oy) / span; // SVG y grows downward
  return {
    lines: lines.map(([x1, y1, x2, y2]) => [nx(x1), ny(y1), nx(x2), ny(y2)]),
    dots: [{ name: 'head' }, { name: 'hand.L' }, { name: 'hand.R' }]
      .map((d) => at(d.name)).filter((p): p is [number, number] => !!p)
      .map(([x, y]) => [nx(x), ny(y)] as [number, number]),
  };
}

/**
 * Feed every held pose into the solver, once per frame.
 *
 * Deliberately a TARGET rather than a write: a written pose is overruled by
 * tone within a few frames, while a target is weighed against the gait, a
 * capture rig or your own dragging exactly like any other source. Held under
 * MANUAL, so the mixer's existing weight and body mask apply — masking the
 * hold to the upper body and letting the legs walk is then free.
 */
export function pushHeldPoses(scene: GPScene): void {
  for (const actor of scene.actors) {
    if (!actor.hold || !actor.visible) continue;
    const s = actorScale(actor) || 1;
    for (let i = 0; i < actor.joints.length; i++) {
      const src = actor.hold[actor.joints[i].name];
      if (!src) continue;
      const w = actorMixer.gain(actor, 'MANUAL', actor.joints[i].name);
      if (w <= 0.001) continue;
      actorSolver.addTarget(actor.id, {
        index: i, pos: [src[0] * s, src[1] * s, src[2] * s], weight: w * HOLD_PULL,
      });
    }
  }
}

/** The hold form of a set of positions, by name and scale-free. */
export function holdFrom(actor: TGActor, positions: Vec3[]): Record<string, Vec3> {
  const s = actorScale(actor) || 1;
  const out: Record<string, Vec3> = {};
  for (let i = 0; i < actor.joints.length; i++) {
    const p = positions[i];
    if (p) out[actor.joints[i].name] = [p[0] / s, p[1] / s, p[2] / s];
  }
  return out;
}
