// Imported motion: a glTF animation, retargeted onto the positional rig.
//
// The shape of the answer matters more than the code. A glTF clip is
// rotation curves on a bone hierarchy; our skeleton has no rotations at all
// (a joint is a particle, a bone is a distance constraint). So rather than
// keeping a parallel three.js animation system alive in the frame loop and
// converting every frame, this SAMPLES the clip once at import into a pose
// TGClip — named joint positions in the actor's own frame, exactly what the
// mixer's CLIP layer already plays.
//
// That buys more than simplicity. The result is an ordinary clip: it trims,
// it crops, it blends against the gait on a masked layer, it bakes to GP
// strokes, and it survives a save. And there is no second animation system
// to keep in sync with the first — imported motion and a walk you performed
// yourself are the same kind of thing, which is the whole point of having a
// mixer.
//
// Three conversions have to happen and each one is a way to get a character
// that "imports fine" and then moves wrong:
//
//  - NAMING. Mixamo's vocabulary is not ours. `LeftArm` is the upper arm,
//    so it maps to our `shoulder.L`, while Mixamo's `LeftShoulder` is the
//    clavicle and has no home here. Getting this off by one bone gives a
//    figure with its elbows where its shoulders should be.
//  - SCALE. A source rig is not the actor's size. Everything is rescaled
//    about the FEET, the same rule live capture uses (rig.matchScale) —
//    scaling about the origin instead leaves the character floating or
//    buried depending on which is taller.
//  - FRAME. glTF is Y-up and its characters face whatever they face. Both
//    are recovered from the skeleton itself rather than assumed: the toe
//    ahead of the ankle gives forward, so a source facing +Z and one facing
//    -X both land the same way round.
//
// Horizontal root travel is REMOVED. A walk clip that moves forward would
// otherwise translate the whole body sideways out of the actor, because
// this is an actor-local pose — and travel is already somebody else's job
// (the gait's root, a path, steering, your hands). Vertical motion is kept:
// that is the bob, and it belongs to the pose.
import * as THREE from 'three';
import type { TGActor, TGClip, Vec3 } from '../core/types';
import { genId } from '../core/gpdata';

/** Our joint <- source bone. First match wins, so put the specific first. */
const NAME_MAP: [string, string[]][] = [
  ['hips', ['hips', 'pelvis', 'root']],
  ['spine', ['spine', 'spine01', 'spine1']],
  ['chest', ['spine2', 'spine3', 'chest', 'upperchest', 'spine1']],
  ['neck', ['neck']],
  ['head', ['head']],
  // Mixamo's `LeftArm` IS the upper arm, i.e. our shoulder joint.
  // `LeftShoulder` is the clavicle and deliberately has no mapping.
  ['shoulder.L', ['leftarm', 'upperarml', 'arml', 'shoulderl']],
  ['elbow.L', ['leftforearm', 'lowerarml', 'forearml', 'elbowl']],
  ['wrist.L', ['lefthand', 'handl', 'wristl']],
  ['hand.L', ['lefthandmiddle1', 'lefthandindex1', 'handmiddlel']],
  ['shoulder.R', ['rightarm', 'upperarmr', 'armr', 'shoulderr']],
  ['elbow.R', ['rightforearm', 'lowerarmr', 'forearmr', 'elbowr']],
  ['wrist.R', ['righthand', 'handr', 'wristr']],
  ['hand.R', ['righthandmiddle1', 'righthandindex1', 'handmiddler']],
  ['hip.L', ['leftupleg', 'thighl', 'upperlegl', 'hipl']],
  ['knee.L', ['leftleg', 'calfl', 'lowerlegl', 'kneel']],
  ['ankle.L', ['leftfoot', 'footl', 'anklel']],
  ['foot.L', ['lefttoebase', 'toebasel', 'toel', 'balll']],
  ['hip.R', ['rightupleg', 'thighr', 'upperlegr', 'hipr']],
  ['knee.R', ['rightleg', 'calfr', 'lowerlegr', 'kneer']],
  ['ankle.R', ['rightfoot', 'footr', 'ankler']],
  ['foot.R', ['righttoebase', 'toebaser', 'toer', 'ballr']],
];

/** Strip the decoration rigs carry so `mixamorig:LeftArm`, `mixamorigLeftArm`
 *  and `Left_Arm` all reduce to the same key. */
function norm(name: string): string {
  return name.toLowerCase()
    .replace(/^mixamorig[:_]?/, '')
    .replace(/[\s_.:-]/g, '');
}

export interface BoneMatch { joint: string; bone: THREE.Object3D }

/** Match a source hierarchy's bones onto our joint names. */
export function matchBones(root: THREE.Object3D): BoneMatch[] {
  const byNorm = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    const k = norm(o.name);
    if (k && !byNorm.has(k)) byNorm.set(k, o);
  });
  const out: BoneMatch[] = [];
  for (const [joint, aliases] of NAME_MAP) {
    // a rig already speaking our vocabulary matches directly
    const direct = byNorm.get(norm(joint));
    const bone = direct ?? aliases.map((a) => byNorm.get(a)).find(Boolean);
    if (bone) out.push({ joint, bone });
  }
  return out;
}

export interface RetargetOptions {
  /** samples per second; 30 is plenty for a positional rig */
  fps?: number;
  /** scene up axis */
  upZ: boolean;
  /** keep the source's horizontal travel instead of stripping it */
  keepTravel?: boolean;
  name?: string;
}

export interface RetargetReport {
  clip: TGClip | null;
  matched: string[];
  missing: string[];
  /** how much the source was scaled to fit the actor */
  scale: number;
  /** the two rigs label their sides oppositely, so the names were swapped */
  swapSides?: boolean;
  /** yaw applied to face the source the way the actor faces, degrees */
  yaw?: number;
  /** source bone actually used for each output joint, for debugging */
  bones?: Record<string, string>;
  frames: number;
  error?: string;
}

/**
 * Sample a glTF AnimationClip into a pose TGClip on `actor`'s skeleton.
 * `root` is the loaded gltf.scene (the mixer's target); it is left at the
 * clip's end time, so re-sampling is safe but the object is not restored.
 */
export function retargetGltfClip(
  root: THREE.Object3D, source: THREE.AnimationClip, actor: TGActor,
  opts: RetargetOptions,
): RetargetReport {
  const matches = matchBones(root);
  const matched = matches.map((m) => m.joint);
  const missing = NAME_MAP.map(([j]) => j).filter((j) => !matched.includes(j));
  const base: RetargetReport = { clip: null, matched, missing, scale: 1, frames: 0 };
  if (matches.length < 6) {
    return { ...base, error: `only ${matches.length} bones matched — is this a character rig?` };
  }

  const upAxis = opts.upZ ? 2 : 1;
  const fps = Math.max(5, Math.min(120, opts.fps ?? 30));

  const at = (name: string): THREE.Object3D | undefined =>
    matches.find((m) => m.joint === name)?.bone;
  const world = (o: THREE.Object3D): THREE.Vector3 =>
    new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);

  // ---- the BIND pose establishes the source's frame ---------------------
  // Measured before any mixer exists, and averaged across both sides. Both
  // matter: sampling the clip's first frame instead reads whatever pose the
  // animation happens to start in, and a clip that opens mid-stride then
  // hands you a "forward" taken from a leg that is swung 30 degrees out.
  // The character imports rotated, and every joint is subtly wrong in a way
  // that looks like bad retargeting rather than a bad measurement.
  root.updateWorldMatrix(true, true);

  const srcHips = at('hips');
  if (!srcHips) return { ...base, error: 'no hips in the source rig' };
  const ankleBones = [at('ankle.L'), at('ankle.R')].filter(Boolean) as THREE.Object3D[];
  const toeBones = [at('foot.L'), at('foot.R')].filter(Boolean) as THREE.Object3D[];
  if (!ankleBones.length) return { ...base, error: 'no ankles in the source rig' };

  const mid = (list: THREE.Object3D[]): THREE.Vector3 => {
    const v = new THREE.Vector3();
    for (const o of list) v.add(world(o));
    return v.divideScalar(list.length);
  };
  // glTF is Y-up. Everything here works in that source frame and is mapped
  // into the scene's convention at the very end.
  const hips0 = world(srcHips);
  const ankle0 = mid(ankleBones);
  const srcHeight = Math.max(0.01, hips0.y - ankle0.y);

  // Scale about the FEET, the same rule live capture uses (rig.matchScale).
  // About the origin instead leaves a short source floating and a tall one
  // buried.
  const restOf = (n: string): Vec3 | undefined =>
    actor.joints.find((j) => j.name === n)?.rest;
  const aHips = restOf('hips'); const aAnkle = restOf('ankle.L');
  const dstHeight = aHips && aAnkle
    ? Math.max(0.01, aHips[upAxis] - aAnkle[upAxis]) : 1;
  const scale = dstHeight / srcHeight;

  // Facing from the skeleton, not assumed: the toes sit ahead of the ankles
  // in every humanoid rig, so a source facing +Z and one facing -X both land
  // the same way round.
  let yaw = 0;
  if (toeBones.length) {
    const toe = mid(toeBones);
    const fwd = new THREE.Vector2(toe.x - ankle0.x, toe.z - ankle0.z);
    // our target forward, expressed in the source's Y-up frame, is -Z:
    // it becomes +Y once mapped to a Z-up scene, which is the actor's own
    if (fwd.lengthSq() > 1e-8) yaw = Math.atan2(fwd.x, fwd.y) - Math.atan2(0, -1);
  }
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);

  // The actor's ankle is not on the floor — the joint sits above the sole.
  // Grounding the source at zero instead sinks the whole figure by exactly
  // that much, the same trap the gait hit when it planted feet on the floor
  // plane rather than at the ankle's rest height.
  const groundUp = aAnkle ? aAnkle[upAxis] : 0;

  // ---- which side is which ---------------------------------------------
  // A rig's idea of "Left" is a LABEL, and this skeleton's is its own (see
  // skeleton.ts: `.L` is the +X side). Turning a character round to face the
  // way ours faces must not mirror it, so handedness is checked rather than
  // assumed: compare the source's ankle-to-ankle direction, once spun into
  // our frame, against the actor's own. If they disagree the two rigs label
  // their sides oppositely, and the fix is to swap the NAMES — mirroring the
  // geometry instead would give a character whose knees bend outward.
  let swapSides = false;
  const srcL = at('ankle.L'); const srcR = at('ankle.R');
  const aAnkleR = restOf('ankle.R');
  if (srcL && srcR && aAnkle && aAnkleR) {
    const d = world(srcL).sub(world(srcR)).applyQuaternion(spin);
    if (d.x * (aAnkle[0] - aAnkleR[0]) < 0) swapSides = true;
  }
  const flip = (n: string): string =>
    !swapSides ? n : n.endsWith('.L') ? `${n.slice(0, -2)}.R`
      : n.endsWith('.R') ? `${n.slice(0, -2)}.L` : n;

  // ---- now, and only now, drive the clip --------------------------------
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(source);
  action.play();

  // ---- sample ----------------------------------------------------------
  const names = matches.map((m) => flip(m.joint));
  const dur = Math.max(1 / fps, source.duration);
  const count = Math.max(2, Math.round(dur * fps) + 1);
  const frames: { t: number; data: number[] }[] = [];
  const v = new THREE.Vector3();

  for (let f = 0; f < count; f++) {
    const t = (f / (count - 1)) * dur;
    mixer.setTime(t);
    root.updateWorldMatrix(true, true);
    const hips = world(srcHips);
    const data = new Array<number>(names.length * 4);
    for (let i = 0; i < matches.length; i++) {
      v.copy(world(matches[i].bone));
      // origin: under the hips (travel removed) and on the ground plane
      v.x -= opts.keepTravel ? 0 : hips.x;
      v.z -= opts.keepTravel ? 0 : hips.z;
      v.y -= ankle0.y;
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
    frames.push({ t: Math.round(t * 1000), data });
  }
  action.stop();
  mixer.uncacheClip(source);

  const clip: TGClip = {
    id: genId(),
    name: opts.name ?? source.name ?? 'imported motion',
    source: `gltf:${source.name || 'clip'}`,
    count: names.length,
    duration: frames[frames.length - 1].t,
    frames,
    space: 'ACTOR_LOCAL',
    joints: names,
  };
  const bones: Record<string, string> = {};
  matches.forEach((m, i) => { bones[names[i]] = m.bone.name; });
  return {
    clip, matched, missing, scale: +scale.toFixed(4), frames: frames.length,
    swapSides, yaw: +THREE.MathUtils.radToDeg(yaw).toFixed(1), bones,
  };
}
