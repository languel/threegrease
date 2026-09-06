// The one retargeter, for every source of foreign motion.
//
// A glTF import and an on-device generator hand us the same thing in the
// end — frames of NAMED joint positions on somebody else's skeleton — so
// they get the same landing procedure rather than two that drift apart.
// Callers differ only in how they produce those frames, and in where the
// floor is (see `groundRef`). Everything here was learned the hard way on
// the glTF path; each comment marks a way to get motion that "imports fine"
// and moves wrong.
//
// Sources speak Y-UP world space (glTF's convention, and ARDY's). The
// scene's own up axis is a setting, so the conversion happens once, here.
import * as THREE from 'three';
import type { TGActor, TGClip, Vec3 } from '../core/types';
import { genId } from '../core/gpdata';

export interface PoseSource {
  /** joint names in OUR vocabulary, index-aligned with the position arrays */
  names: string[];
  /** the source's BIND pose, Y-up, laid out [j*3] */
  bind: ArrayLike<number>;
  /** frames of Y-up world positions, each laid out [j*3] */
  frames: { t: number; pos: ArrayLike<number> }[];
}

export interface RetargetOptions {
  upZ: boolean;
  /** keep the source's horizontal travel instead of stripping it */
  keepTravel?: boolean;
  /**
   * Where the floor is in the source's data.
   *
   * 'bind' (default) suits a rig whose bind pose lives in the same world as
   * its animation — a glTF character stands on the floor in both. 'frames'
   * suits a source whose bind pose is a hips-centred TEMPLATE while the
   * motion is world-space with the feet on the ground, which is how ARDY
   * ships its neutral skeleton: using the bind ankles there would lift the
   * whole figure by the length of its own legs.
   */
  groundRef?: 'bind' | 'frames';
  name?: string;
  source?: string;
}

export interface RetargetReport {
  clip: TGClip | null;
  matched: string[];
  missing: string[];
  scale: number;
  swapSides?: boolean;
  /** yaw applied to face the source the way the actor faces, degrees */
  yaw?: number;
  frames: number;
  /** source bone actually used for each output joint, for debugging a bad
   *  import — filled in by callers that know their source's own names */
  bones?: Record<string, string>;
  error?: string;
}

const at = (a: ArrayLike<number>, i: number): THREE.Vector3 =>
  new THREE.Vector3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);

/**
 * Land a foreign skeleton's motion on `actor` as a pose clip.
 *
 * Horizontal root travel is stripped by default: the clip is an
 * actor-LOCAL pose, and travel belongs to whatever drives the root (the
 * gait, a path, a steer goal, your hands). Keeping it would slide the whole
 * body out of the character.
 */
export function retargetPoseFrames(
  src: PoseSource, actor: TGActor, opts: RetargetOptions,
): RetargetReport {
  const names = src.names;
  const base: RetargetReport = {
    clip: null, matched: names, missing: [], scale: 1, frames: 0,
  };
  if (!src.frames.length || names.length < 6) {
    return { ...base, error: 'not enough joints or frames to retarget' };
  }
  const upAxis = opts.upZ ? 2 : 1;
  const idxOf = (n: string): number => names.indexOf(n);

  const iHips = idxOf('hips');
  const ankles = [idxOf('ankle.L'), idxOf('ankle.R')].filter((i) => i >= 0);
  const toes = [idxOf('foot.L'), idxOf('foot.R')].filter((i) => i >= 0);
  if (iHips < 0 || !ankles.length) {
    return { ...base, error: 'source has no hips/ankles' };
  }

  // ---- the BIND pose establishes the source's frame ---------------------
  // Measured from the bind pose and averaged across both sides. Both matter:
  // reading the animation's FIRST FRAME instead gives you whatever pose the
  // clip opens in, and a clip that starts mid-stride hands you a "forward"
  // taken from a leg swung 30 degrees out. The character lands rotated, and
  // it looks like bad retargeting rather than a bad measurement.
  const mid = (list: number[], a: ArrayLike<number>): THREE.Vector3 => {
    const v = new THREE.Vector3();
    for (const i of list) v.add(at(a, i));
    return v.divideScalar(list.length);
  };
  const hips0 = at(src.bind, iHips);
  const bindAnkle = mid(ankles, src.bind);
  const srcHeight = Math.max(0.01, hips0.y - bindAnkle.y);

  // The height everything is grounded against. From the frames, it is the
  // LOWEST the feet ever average — the double-support moment of a walk, when
  // the character is most definitely standing on the floor. A minimum rather
  // than a mean so that a jump raises the figure instead of sinking the rest
  // of the clip to compensate for it.
  let ground = bindAnkle.y;
  if (opts.groundRef === 'frames') {
    ground = Infinity;
    for (const f of src.frames) ground = Math.min(ground, mid(ankles, f.pos).y);
    if (!Number.isFinite(ground)) ground = bindAnkle.y;
  }

  // Scale about the FEET, the same rule live capture uses (rig.matchScale).
  // About the origin instead leaves a short source floating and a tall one
  // buried.
  const restOf = (n: string): Vec3 | undefined =>
    actor.joints.find((j) => j.name === n)?.rest;
  const aHips = restOf('hips'); const aAnkle = restOf('ankle.L');
  const aAnkleR = restOf('ankle.R');
  const dstHeight = aHips && aAnkle
    ? Math.max(0.01, aHips[upAxis] - aAnkle[upAxis]) : 1;
  const scale = dstHeight / srcHeight;

  // Facing from the skeleton, not assumed: the toes sit ahead of the ankles
  // in every humanoid rig, so a source facing +Z and one facing -X both land
  // the same way round.
  let yaw = 0;
  if (toes.length) {
    const toe = mid(toes, src.bind);
    const fwd = new THREE.Vector2(toe.x - bindAnkle.x, toe.z - bindAnkle.z);
    // our target forward, in the source's Y-up frame, is -Z: it becomes +Y
    // once mapped into a Z-up scene, which is the actor's own forward
    if (fwd.lengthSq() > 1e-8) yaw = Math.atan2(fwd.x, fwd.y) - Math.atan2(0, -1);
  }
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);

  // The actor's ankle is not on the floor — the joint sits above the sole,
  // so grounding at the floor plane sinks the whole figure by exactly that
  // much (the same trap the gait hit planting feet).
  const groundUp = aAnkle ? aAnkle[upAxis] : 0;

  // ---- which side is which ----------------------------------------------
  // A rig's idea of "Left" is a LABEL, and this skeleton's is its own
  // (`.L` is the +X side). Turning a character round to face the way ours
  // faces must not mirror it, so handedness is checked rather than assumed.
  // If the two rigs label their sides oppositely the fix is to swap the
  // NAMES — mirroring the geometry would give knees that bend outward.
  let swapSides = false;
  const iL = idxOf('ankle.L'); const iR = idxOf('ankle.R');
  if (iL >= 0 && iR >= 0 && aAnkle && aAnkleR) {
    const d = at(src.bind, iL).sub(at(src.bind, iR)).applyQuaternion(spin);
    if (d.x * (aAnkle[0] - aAnkleR[0]) < 0) swapSides = true;
  }
  const flip = (n: string): string =>
    !swapSides ? n : n.endsWith('.L') ? `${n.slice(0, -2)}.R`
      : n.endsWith('.R') ? `${n.slice(0, -2)}.L` : n;
  const outNames = names.map(flip);

  // ---- convert every frame ----------------------------------------------
  const v = new THREE.Vector3();
  const frames: { t: number; data: number[] }[] = [];
  for (const f of src.frames) {
    const hips = at(f.pos, iHips);
    const data = new Array<number>(names.length * 4);
    for (let i = 0; i < names.length; i++) {
      v.copy(at(f.pos, i));
      v.x -= opts.keepTravel ? 0 : hips.x;
      v.z -= opts.keepTravel ? 0 : hips.z;
      v.y -= ground;
      v.multiplyScalar(scale);
      v.applyQuaternion(spin);
      // Y-up source -> the scene's convention. The actor's own skeleton is
      // authored the same way (skeleton.ts `place`), so this is the one
      // place that has to know it.
      const p: Vec3 = opts.upZ ? [v.x, -v.z, v.y] : [v.x, v.y, v.z];
      p[upAxis] += groundUp;
      data[i * 4] = +p[0].toFixed(5);
      data[i * 4 + 1] = +p[1].toFixed(5);
      data[i * 4 + 2] = +p[2].toFixed(5);
      data[i * 4 + 3] = 1;
    }
    frames.push({ t: f.t, data });
  }

  // How fast the SOURCE was travelling, measured before the travel was
  // stripped out. Horizontal only: vertical motion is bob, not progress.
  let path = 0;
  for (let i = 1; i < src.frames.length; i++) {
    const a0 = at(src.frames[i - 1].pos, iHips);
    const b0 = at(src.frames[i].pos, iHips);
    path += Math.hypot(b0.x - a0.x, b0.z - a0.z);
  }
  const spanSec = Math.max(0.001,
    (src.frames[src.frames.length - 1].t - src.frames[0].t) / 1000);
  const impliedSpeed = +((path * scale) / spanSec).toFixed(3);

  const clip: TGClip = {
    id: genId(),
    name: opts.name ?? 'retargeted motion',
    source: opts.source ?? 'retarget',
    count: outNames.length,
    duration: frames[frames.length - 1].t,
    frames,
    space: 'ACTOR_LOCAL',
    joints: outNames,
    impliedSpeed,
  };
  return {
    clip, matched: outNames, missing: [], scale: +scale.toFixed(4),
    swapSides, yaw: +THREE.MathUtils.radToDeg(yaw).toFixed(1),
    frames: frames.length,
  };
}
