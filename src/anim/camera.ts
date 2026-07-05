import * as THREE from 'three';
import type { GPCamera, GPCameraKey } from '../core/types';
import { lerp } from '../core/mathutil';

export interface CameraPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

/**
 * Evaluate the scene camera at a frame: linear position/fov, slerped
 * rotation between surrounding keys. With no keys, the static transform.
 */
export function evalCamera(cam: GPCamera, frame: number): CameraPose {
  const pose = (t: [number, number, number], r: [number, number, number], fov: number): CameraPose => ({
    position: new THREE.Vector3(...t),
    quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)),
    fov,
  });
  const keys = cam.keys;
  if (!keys.length) return pose(cam.translation, cam.rotation, cam.fov);
  let before: GPCameraKey | null = null, after: GPCameraKey | null = null;
  for (const k of keys) {
    if (k.frame <= frame && (!before || k.frame > before.frame)) before = k;
    if (k.frame > frame && (!after || k.frame < after.frame)) after = k;
  }
  if (!before) return pose(after!.translation, after!.rotation, after!.fov);
  if (!after) return pose(before.translation, before.rotation, before.fov);
  const t = (frame - before.frame) / (after.frame - before.frame);
  const a = pose(before.translation, before.rotation, before.fov);
  const b = pose(after.translation, after.rotation, after.fov);
  return {
    position: a.position.lerp(b.position, t),
    quaternion: a.quaternion.slerp(b.quaternion, t),
    fov: lerp(a.fov, b.fov, t),
  };
}

/** Insert or replace a key at `frame` from the camera's current transform. */
export function insertCameraKey(cam: GPCamera, frame: number): void {
  const key: GPCameraKey = {
    frame,
    translation: [...cam.translation] as [number, number, number],
    rotation: [...cam.rotation] as [number, number, number],
    fov: cam.fov,
  };
  const i = cam.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) cam.keys[i] = key;
  else cam.keys.push(key);
  cam.keys.sort((a, b) => a.frame - b.frame);
}

export function removeCameraKey(cam: GPCamera, frame: number): boolean {
  const i = cam.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) { cam.keys.splice(i, 1); return true; }
  return false;
}
