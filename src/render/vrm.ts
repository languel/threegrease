// VRM avatars: a real character wearing our skeleton's motion.
//
// A VRM is a glTF with a humanoid extension, so it needs no separate loader
// path — the plugin is simply always registered and `gltf.userData.vrm` is
// either there or it isn't. That also means a .glb which happens to be a VRM
// is recognised without anyone having to name the file correctly.
//
// Binding is deliberately one-way and total: while an actor drives an
// avatar, the avatar's transform is the ACTOR's, and its own is not
// authored. That is the same contract a FOLLOW_PATH constraint has with the
// object it drives, and it is why the transform is written into scene data
// rather than pushed onto the three.js object behind the renderer's back.
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GPScene, TGActor } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import {
  bindHumanoid, humanoidScale, poseHumanoid,
  type HumanBone, type HumanoidBind, type HumanoidRig,
} from './vrmpose';

interface Entry {
  vrm: VRM;
  rig: HumanoidRig;
  bind: HumanoidBind | null;
  /** actor this bind was measured against, so a re-bind happens on change */
  boundTo: number | null;
}

export class VrmManager {
  private entries = new Map<number, Entry>();

  /** Register the humanoid plugin on a loader that may or may not get a VRM. */
  static prepare(loader: GLTFLoader): void {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  }

  /** Called by MeshManager after a glTF loads, with whatever came back. */
  adopt(meshId: number, gltf: { userData?: { vrm?: VRM }; scene: THREE.Object3D }): boolean {
    const vrm = gltf.userData?.vrm;
    if (!vrm) return false;
    // VRM 0.x models face -Z; rotate them so every model in the scene agrees
    // with VRM 1.0's +Z and the retargeter only has one convention to know.
    VRMUtils.rotateVRM0(vrm);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    const rig: HumanoidRig = {
      getBone: (name: HumanBone) =>
        vrm.humanoid?.getNormalizedBoneNode(name as never) ?? null,
    };
    this.entries.set(meshId, { vrm, rig, bind: null, boundTo: null });
    return true;
  }

  forget(meshId: number): void { this.entries.delete(meshId); }
  has(meshId: number): boolean { return this.entries.has(meshId); }

  /** Mesh ids of every loaded VRM, for the avatar picker. */
  ids(): number[] { return [...this.entries.keys()]; }

  /**
   * Drive every avatar-bound actor. Runs AFTER the solver, because it reads
   * the finished pose, and after the constraint pass, because the actor's
   * own world transform has to be final before the avatar inherits it.
   */
  update(scene: GPScene, dt: number, upZ: boolean): void {
    for (const actor of scene.actors) {
      const meshId = actor.avatar;
      if (meshId == null) continue;
      const entry = this.entries.get(meshId);
      const mesh = scene.meshes.find((m) => m.id === meshId);
      if (!entry || !mesh) continue;

      if (!entry.bind || entry.boundTo !== actor.id) {
        entry.bind = bindHumanoid(entry.rig, actor);
        entry.boundTo = actor.id;
      }

      // the avatar wears the actor's world transform, scaled so its hips sit
      // at the actor's hip height rather than at whatever the artist chose
      const s = humanoidScale(entry.bind, actor, upZ);
      const m = worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id });
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      m.decompose(pos, quat, scl);
      const e = new THREE.Euler().setFromQuaternion(quat);
      mesh.translation = [pos.x, pos.y, pos.z];
      mesh.rotation = [e.x, e.y, e.z];
      mesh.scale = [s * scl.x, s * scl.y, s * scl.z];
      mesh.visible = actor.visible;

      poseHumanoid(entry.rig, entry.bind, actor, upZ);
      entry.vrm.humanoid?.update();
      entry.vrm.update(dt);
    }
  }
}

export const vrmManager = new VrmManager();

/** Is this actor currently wearing a loaded avatar? */
export function actorHasAvatar(actor: TGActor): boolean {
  return actor.avatar != null && vrmManager.has(actor.avatar);
}
