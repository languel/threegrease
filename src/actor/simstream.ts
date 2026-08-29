// Turn a scene object into a fake camera feed: sample its live world
// position (or, for an actor, its whole pose) into a synthetic MMStream
// frame, in the exact packing MMCapture.pack() writes.
//
// This is the missing link for a virtual demo. Every consumer downstream of
// a stream — trigger zones, routes, clips, the semantic-detection UI, the
// combined body-map picker — reads streamStore and has no idea whether the
// numbers came from a webcam or a simulated visitor walking a GP path. So a
// simulated tracking source is not a special case anywhere else in the app:
// it is one function that writes to the same store MediaPipe writes to,
// once a frame, for as long as the driven stream exists.
//
// Two source shapes, because two different things are being simulated:
//   ACTOR   a full 33-point POSE, so pose-shaped consumers (the auto-rig,
//           the body-map picker) see a real skeleton. The map is the
//           INVERSE of rig.ts's POSE_MAP — joint name -> landmark index,
//           since the actor is the source of truth here.
//   OBJECT  ANY object (mesh, GP, another actor, a light) as ONE tracked
//           point — a stand-in for "a person", "a pet", "a dropped bag",
//           whatever a single moving thing needs to be. This is what makes
//           "any object is a tracking source" literal rather than actor-only:
//           set a box on a FOLLOW_PATH and it IS a visitor as far as a zone
//           is concerned.
import * as THREE from 'three';
import type { GPCamera, GPScene, TGActor } from '../core/types';
import { streamStore } from '../mm/streams';
import { worldMatrixOf, type ObjRef } from '../tools/objects';
import { evalCamera } from '../anim/camera';

/** joint name -> landmark index, mirroring rig.ts's POSE_MAP in reverse.
 *  Joints with no counterpart (spine, neck, hand.*) are simply absent —
 *  the synthetic frame leaves those indices at zero/low-confidence rather
 *  than inventing a position a real detector would never report. */
const JOINT_TO_LANDMARK: Record<string, number> = {
  head: 0,
  'shoulder.L': 11, 'shoulder.R': 12,
  'elbow.L': 13, 'elbow.R': 14,
  'wrist.L': 15, 'wrist.R': 16,
  'hip.L': 23, 'hip.R': 24,
  'knee.L': 25, 'knee.R': 26,
  'ankle.L': 27, 'ankle.R': 28,
  'foot.L': 31, 'foot.R': 32,
};

export type SimSource =
  | { kind: 'ACTOR'; actorId: number }
  | { kind: 'OBJECT'; ref: ObjRef };

/** Streams currently driven from a scene source, keyed by stream id.
 *  `cameraIndex` is which of the scene's cameras stands in for the (virtual)
 *  webcam — deliberately a SCENE camera, not the app's viewport camera, so
 *  the synthetic feed represents "what a fixed camera in the room would
 *  see" regardless of where the user happens to be looking while authoring. */
export interface SimDriver { source: SimSource; cameraIndex: number; }
const drivers = new Map<number, SimDriver>();

export function driveStreamFromActor(streamId: number, actorId: number, cameraIndex: number): void {
  drivers.set(streamId, { source: { kind: 'ACTOR', actorId }, cameraIndex });
}
export function driveStreamFromObject(streamId: number, ref: ObjRef, cameraIndex: number): void {
  drivers.set(streamId, { source: { kind: 'OBJECT', ref }, cameraIndex });
}
export function stopDrivingStream(streamId: number): void {
  drivers.delete(streamId);
}
export function isDriven(streamId: number): boolean {
  return drivers.has(streamId);
}
export function driverOf(streamId: number): SimDriver | null {
  return drivers.get(streamId) ?? null;
}

/** aspect ratio scene cameras are evaluated at for this synthetic feed —
 *  fixed rather than read from the live renderer, so this module stays
 *  independent of whatever canvas size the app happens to be at */
const SIM_ASPECT = 16 / 9;

/** Behind-camera or wildly-out-of-frame landmarks report LOW confidence at
 *  wherever they projected, rather than being silently wrong — the same
 *  contract a real detector's low-confidence points already carry. */
const OUT_OF_FRAME_CONF = 0.05;

export function tickSimStreams(scene: GPScene, frame: number): void {
  if (!drivers.size) return;
  for (const [streamId, driver] of drivers) {
    const stream = scene.mmStreams.find((s) => s.id === streamId);
    const gpCam = scene.cameras[driver.cameraIndex];
    if (!stream || !gpCam) { drivers.delete(streamId); continue; }
    const camera = buildCamera(gpCam, frame);

    const source = driver.source;
    if (source.kind === 'ACTOR') {
      const actor = scene.actors.find((a) => a.id === source.actorId);
      if (!actor) { drivers.delete(streamId); continue; }
      streamStore.push(streamId, sampleActorAsPose(scene, actor, camera), 33);
    } else {
      const w = worldMatrixOf(scene, source.ref);
      const pos = new THREE.Vector3().setFromMatrixPosition(w);
      streamStore.push(streamId, samplePointAsSingle(pos, camera), 1);
    }
  }
}

/** Evaluate the scene camera at `frame` (position/rotation/fov, keyframed or
 *  static) and build a throwaway THREE camera projecting through it — the
 *  same eval the app's own camera-view mode uses, so a synthetic feed
 *  matches what a real camera at that transform would actually see. */
function buildCamera(gpCam: GPCamera, frame: number): THREE.PerspectiveCamera {
  const pose = evalCamera(gpCam, frame);
  const camera = new THREE.PerspectiveCamera(pose.fov, SIM_ASPECT, 0.05, 500);
  camera.position.copy(pose.position);
  camera.quaternion.copy(pose.quaternion);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/** World point -> one MMCapture-convention landmark: x/y centred and
 *  aspect-scaled the way a 0..1 UV maps to normalized landmark space,
 *  z as (fake) relative depth, confidence 1 while in view. */
function project(w: THREE.Vector3, camera: THREE.PerspectiveCamera, out: Float32Array, i: number): void {
  const ndc = w.clone().project(camera);
  out[i * 4] = (ndc.x * 0.5) * SIM_ASPECT;
  out[i * 4 + 1] = ndc.y * 0.5;
  out[i * 4 + 2] = -ndc.z * SIM_ASPECT;
  const inFrame = ndc.z < 1 && Math.abs(ndc.x) < 1.3 && Math.abs(ndc.y) < 1.3;
  out[i * 4 + 3] = inFrame ? 1 : OUT_OF_FRAME_CONF;
}

function sampleActorAsPose(scene: GPScene, actor: TGActor, camera: THREE.PerspectiveCamera): Float32Array {
  const toWorld = worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id });
  const idxByName = new Map(actor.joints.map((j, i) => [j.name, i]));
  const data = new Float32Array(33 * 4);
  const w = new THREE.Vector3();
  for (const [joint, landmark] of Object.entries(JOINT_TO_LANDMARK)) {
    const idx = idxByName.get(joint);
    const pos = idx !== undefined ? actor.pose[idx] : null;
    if (!pos) continue;                    // stays zero/zero-confidence
    w.set(...pos).applyMatrix4(toWorld);
    project(w, camera, data, landmark);
  }
  return data;
}

function samplePointAsSingle(worldPos: THREE.Vector3, camera: THREE.PerspectiveCamera): Float32Array {
  const data = new Float32Array(4);
  project(worldPos, camera, data, 0);
  return data;
}
