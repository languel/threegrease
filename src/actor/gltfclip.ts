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
import { retargetPoseFrames } from './retarget';
import type { RetargetReport } from './retarget';

export type { RetargetReport } from './retarget';

export interface RetargetOptions {
  /** samples per second; 30 is plenty for a positional rig */
  fps?: number;
  upZ: boolean;
  /** keep the source's horizontal travel instead of stripping it */
  keepTravel?: boolean;
  name?: string;
}

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

  const fps = Math.max(5, Math.min(120, opts.fps ?? 30));
  const world = (o: THREE.Object3D, into: Float32Array, i: number): void => {
    into[i * 3] = o.matrixWorld.elements[12];
    into[i * 3 + 1] = o.matrixWorld.elements[13];
    into[i * 3 + 2] = o.matrixWorld.elements[14];
  };

  // ---- the BIND pose, read BEFORE any mixer exists ----------------------
  // Sampling the clip's first frame instead reads whatever pose the
  // animation opens in, and one that starts mid-stride hands the retargeter
  // a "forward" taken from a leg swung 30 degrees out: the character lands
  // rotated, and it looks like bad retargeting rather than a bad
  // measurement. A glTF rig's bind pose shares a world with its animation,
  // so it is also where the floor is (groundRef 'bind' below).
  root.updateWorldMatrix(true, true);
  const bind = new Float32Array(matches.length * 3);
  for (let i = 0; i < matches.length; i++) world(matches[i].bone, bind, i);

  // ---- now, and only now, drive the clip --------------------------------
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(source);
  action.play();

  const dur = Math.max(1 / fps, source.duration);
  const count = Math.max(2, Math.round(dur * fps) + 1);
  const frames: { t: number; pos: Float32Array }[] = [];
  for (let f = 0; f < count; f++) {
    const t = (f / (count - 1)) * dur;
    mixer.setTime(t);
    root.updateWorldMatrix(true, true);
    const pos = new Float32Array(matches.length * 3);
    for (let i = 0; i < matches.length; i++) world(matches[i].bone, pos, i);
    frames.push({ t: Math.round(t * 1000), pos });
  }
  action.stop();
  mixer.uncacheClip(source);

  const report = retargetPoseFrames(
    { names: matched, bind, frames }, actor,
    {
      upZ: opts.upZ,
      keepTravel: opts.keepTravel,
      groundRef: 'bind',
      name: opts.name ?? source.name ?? 'imported motion',
      source: `gltf:${source.name || 'clip'}`,
    },
  );
  if (!report.clip) return { ...base, ...report, matched, missing };

  const bones: Record<string, string> = {};
  report.matched.forEach((n, i) => { bones[n] = matches[i].bone.name; });
  return { ...report, matched, missing, bones };
}
