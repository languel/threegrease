// Actors (scene.actors) -> three.js mannequin meshes + joint handles.
//
// Same lifecycle as MeshManager/LightManager: sync() reconciles entries
// against the data every frame and only rebuilds when the SKELETON changes
// (joint/bone counts), because the pose changes constantly and rebuilding
// geometry per frame for that would be absurd. Posing is therefore pure
// transform updates on pre-built unit primitives:
//
//   - a limb is a unit cylinder scaled to the bone's length and oriented
//     along it, so a pose costs one quaternion per bone
//   - a joint is a unit sphere, translated only
//
// The stick overlay and the joint handles are drawn unlit and on top, so a
// rig stays visible and clickable while you are working inside a solid
// mannequin.
import * as THREE from 'three';
import type { GPScene, TGActor } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import { materialManager } from './materialmgr';
import { jointEmphasis, limbEmphasis, lookSpec, type LookSpec } from './actorlooks';
import { actorHasAvatar } from './vrm';

/** Which local axis the actor stands up along, from its own rest skeleton. */
/**
 * Two brow arcs and a nose ridge, built in HEAD-RADIUS units.
 *
 * Brancusi rather than anatomy: the whole point is to say which way the head
 * is pointing with as little as possible. Everything sits just proud of the
 * sphere so it reads as carved into the head rather than stuck onto it, and
 * the geometry is shared — one arc, one ridge, three instances.
 */
function buildFace(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b2723, roughness: 0.6, metalness: 0,
  });
  // a half-torus, opening downward: the brow over an eye
  // The head is a UNIT sphere scaled to its radius (jointGeo), so 1.0 here
  // is the surface — features go just outside it, not at some fraction of
  // the way in, or they are simply buried and nothing draws.
  const arc = new THREE.TorusGeometry(0.30, 0.045, 6, 18, Math.PI);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(arc, mat);
    m.position.set(s * 0.34, 0.08, 0.90);
    // A half-torus sweeps the UPPER half in its own XY, and the face's +Y
    // is the head's up — but the arc has to ARCH OVER the eye, so it is
    // turned to bring the dome down over it. Tilted slightly outward too,
    // or the pair reads as a pair of spectacles.
    m.rotation.set(0, 0, Math.PI + s * 0.14);
    m.scale.set(1, 0.78, 1);
    g.add(m);
  }
  // the ridge: a thin wedge down the middle, meeting the arcs at the top
  // the ridge runs down from where the two arcs meet, which is what ties
  // them together into a face rather than two marks and a line
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.40, 0.10), mat);
  nose.position.set(0, -0.12, 0.96);
  g.add(nose);
  for (const child of g.children) {
    (child as THREE.Mesh).castShadow = false;
    (child as THREE.Mesh).receiveShadow = false;
  }
  return g;
}

function actorUpAxis(actor: TGActor): number {
  const head = actor.joints.find((j) => j.name === 'head')?.rest;
  const hips = actor.joints.find((j) => j.name === 'hips')?.rest;
  if (!head || !hips) return 2;
  let best = 2; let mag = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(head[i] - hips[i]);
    if (d > mag) { mag = d; best = i; }
  }
  return best;
}

/** unit cylinder along +Y, which is what setFromUnitVectors expects to
 *  rotate onto an arbitrary bone direction */
const UP = new THREE.Vector3(0, 1, 0);

interface Entry {
  root: THREE.Group;
  limbs: THREE.Mesh[];
  joints: THREE.Mesh[];
  /** the minimal face, oriented from the shoulder line each frame */
  face: THREE.Group;
  sticks: THREE.LineSegments;
  jointCount: number;
  boneCount: number;
  unlit: boolean;
  /** which look the built meshes are currently wearing */
  look: string;
}

export class ActorManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, Entry>();
  /** shared geometry: every limb/joint is the same unit primitive */
  private limbGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  /** capped tubes, cached per taper ratio. The cylinder's +Y end is the
   *  CHILD joint (setFromUnitVectors maps +Y onto a->b), so a radiusTop
   *  below 1 narrows the limb INTO the joint it points at — a forearm
   *  thinning into a wrist, which is the whole silhouette of a lay figure. */
  private limbSolid = new Map<number, THREE.CylinderGeometry>();
  private jointGeo = new THREE.SphereGeometry(1, 16, 12);
  /** tint applied to selected actors, set by the App like LightManager's */
  selectionColor: THREE.Color | null = null;
  /** joint handles are hidden in presentation mode along with other gizmos */
  handlesVisible = true;

  sync(scene: GPScene): void {
    for (const [id, entry] of this.entries) {
      const data = scene.actors.find((a) => a.id === id);
      if (!data || data.joints.length !== entry.jointCount || data.bones.length !== entry.boneCount) {
        this.group.remove(entry.root);
        this.dispose(entry);
        this.entries.delete(id);
      }
    }
    for (const actor of scene.actors) {
      let entry = this.entries.get(actor.id);
      if (!entry) {
        entry = this.build(actor);
        this.group.add(entry.root);
        this.entries.set(actor.id, entry);
      }
      this.pose(scene, actor, entry);
    }
  }

  private build(actor: TGActor): Entry {
    const root = new THREE.Group();
    root.userData.actorId = actor.id;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 });
    const limbs: THREE.Mesh[] = [];
    for (const bone of actor.bones) {
      const m = new THREE.Mesh(this.limbGeo, mat);
      m.visible = bone.radius > 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.actorId = actor.id;
      m.userData.boneId = bone.id;
      root.add(m);
      limbs.push(m);
    }
    const joints: THREE.Mesh[] = [];
    for (const j of actor.joints) {
      const m = new THREE.Mesh(this.jointGeo, mat);
      m.castShadow = true;
      m.userData.actorId = actor.id;
      m.userData.jointId = j.id;
      root.add(m);
      joints.push(m);
    }
    // stick overlay: one segment per bone, depth-tested off so the rig
    // reads through the body it drives
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(actor.bones.length * 6), 3));
    const sticks = new THREE.LineSegments(
      geo, new THREE.LineBasicMaterial({ color: 0xffb24d, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    sticks.renderOrder = 900;
    root.add(sticks);
    const face = buildFace();
    root.add(face);
    return {
      root, limbs, joints, sticks, face,
      jointCount: actor.joints.length, boneCount: actor.bones.length, unlit: false,
      look: '',
    };
  }

  private pose(scene: GPScene, actor: TGActor, entry: Entry): void {
    const { root } = entry;
    root.visible = actor.visible;
    root.matrixAutoUpdate = false;
    root.matrix.copy(worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id }));
    root.matrixWorldNeedsUpdate = true;
    if (!actor.visible) return;

    const spec = lookSpec(actor.look);
    // Geometry only changes when the LOOK changes, not per frame — a look
    // is a rebuild-class decision the same way the skeleton is.
    if (entry.look !== (actor.look ?? 'DEFAULT')) {
      entry.look = actor.look ?? 'DEFAULT';
      const geo = spec.capped ? this.taperedGeo(spec.taper) : this.limbGeo;
      for (const m of entry.limbs) m.geometry = geo;
    }

    const wantUnlit = spec.unlit || materialManager.wantsUnlit(scene, actor.materialId, {
      color: actor.color, opacity: actor.opacity, wireframe: false,
    });
    if (entry.unlit !== wantUnlit) {
      const old = entry.limbs[0]?.material as THREE.Material | undefined;
      const next = wantUnlit ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial();
      for (const m of entry.limbs) m.material = next;
      for (const m of entry.joints) m.material = next;
      old?.dispose();
      entry.unlit = wantUnlit;
    }
    const mat = entry.limbs[0]?.material as THREE.MeshStandardMaterial | undefined;
    if (mat) {
      materialManager.apply(mat, scene, actor.materialId, {
        color: actor.color, opacity: actor.opacity, wireframe: false,
      });
      if (this.selectionColor && actor.select) mat.color.copy(this.selectionColor);
      const std = mat as THREE.MeshStandardMaterial;
      if (std.roughness !== undefined) {
        std.roughness = spec.roughness;
        std.metalness = spec.metalness;
      }
      if (std.flatShading !== spec.flat) {
        std.flatShading = spec.flat;
        std.needsUpdate = true;
      }
    }

    // While a VRM wears this actor's motion the mannequin gets out of the
    // way — two bodies in the same place is never what anyone wants — but
    // the RIG overlay stays available, because that is how you see what is
    // actually driving the avatar.
    const wearing = actorHasAvatar(actor);
    const showLimbs = !wearing && (actor.shape === 'CAPSULE' || actor.shape === 'BOTH');
    const showSticks = actor.shape === 'STICK' || actor.shape === 'BOTH';
    const idx = new Map(actor.joints.map((j, i) => [j.id, i]));
    const a = new THREE.Vector3(); const b = new THREE.Vector3(); const dir = new THREE.Vector3();
    const stick = entry.sticks.geometry.getAttribute('position') as THREE.BufferAttribute;

    for (let i = 0; i < actor.bones.length; i++) {
      const bone = actor.bones[i];
      const ia = idx.get(bone.a); const ib = idx.get(bone.b);
      const mesh = entry.limbs[i];
      if (ia === undefined || ib === undefined) { mesh.visible = false; continue; }
      a.fromArray(actor.pose[ia]); b.fromArray(actor.pose[ib]);
      dir.subVectors(b, a);
      const len = dir.length();
      mesh.visible = showLimbs && bone.radius > 0 && len > 1e-6;
      if (mesh.visible) {
        mesh.position.copy(a).addScaledVector(dir, 0.5);
        // taper narrows the tube toward the CHILD joint, which is the end
        // the bone points at — a limb thinning into a wrist, not out of it
        // the taper is in the GEOMETRY (see taperedGeo), so the scale is
        // just the bone's own radius under the look's multiplier
        const r = bone.radius * spec.limb
          * limbEmphasis(spec, actor.joints[ib].name);
        mesh.scale.set(r, len, r);
        mesh.quaternion.setFromUnitVectors(UP, dir.clone().divideScalar(len));
      }
      // braces (radius 0) are simulation-only and stay out of the overlay
      const on = showSticks && bone.radius > 0;
      stick.setXYZ(i * 2, a.x, a.y, a.z);
      stick.setXYZ(i * 2 + 1, on ? b.x : a.x, on ? b.y : a.y, on ? b.z : a.z);
    }
    stick.needsUpdate = true;
    entry.sticks.geometry.computeBoundingSphere();
    entry.sticks.visible = showSticks && this.handlesVisible;

    for (let i = 0; i < actor.joints.length; i++) {
      const j = actor.joints[i];
      const mesh = entry.joints[i];
      mesh.position.fromArray(actor.pose[i]);
      // A pinned joint reads bigger: that is the one bit of rig state you
      // need to see at a glance while performing. In stick mode the handles
      // shrink hard — at body scale they swallow the very lines they are
      // supposed to annotate.
      const base = showLimbs ? spec.joint : 0.3;
      const emph = jointEmphasis(spec, j.name);
      const r = j.radius * emph * (j.pin ? base * 1.7 : base);
      mesh.scale.setScalar(r);
      // the head is an ovoid, stretched along the actor's own up axis —
      // read off the skeleton (head above hips) rather than from the scene
      // setting, so it is right for an actor built in either convention
      if (j.name === 'head' && spec.headOvoid !== 1) {
        mesh.scale.setComponent(actorUpAxis(actor), r * spec.headOvoid);
      }
      mesh.visible = showLimbs || showSticks;
    }
    this.poseFace(actor, entry, spec, showLimbs && !wearing);
  }

  /**
   * Put the face on the head and turn it the way the body is facing.
   *
   * A head joint is a BALL with no rotation of its own — this skeleton
   * stores no rotations anywhere — so "which way is it looking" has to be
   * derived. The shoulder line gives the side axis and the skeleton gives
   * up; their cross product is the direction the figure faces, and it
   * follows the body for free: turn the shoulders and the face turns.
   */
  private poseFace(
    actor: TGActor, entry: Entry, spec: LookSpec, show: boolean,
  ): void {
    const face = entry.face;
    const iHead = actor.joints.findIndex((j) => j.name === 'head');
    face.visible = show && spec.face && iHead >= 0;
    if (!face.visible) return;
    const iL = actor.joints.findIndex((j) => j.name === 'shoulder.L');
    const iR = actor.joints.findIndex((j) => j.name === 'shoulder.R');
    const upAxis = actorUpAxis(actor);
    const up = new THREE.Vector3(); up.setComponent(upAxis, 1);
    const side = new THREE.Vector3(1, 0, 0);
    if (iL >= 0 && iR >= 0) {
      side.fromArray(actor.pose[iL]).sub(new THREE.Vector3().fromArray(actor.pose[iR]));
      if (side.lengthSq() < 1e-9) side.set(1, 0, 0);
    }
    side.normalize();
    // up from the neck if we have one, so a bowed head takes the face with it
    const iNeck = actor.joints.findIndex((j) => j.name === 'neck');
    if (iNeck >= 0) {
      const u = new THREE.Vector3().fromArray(actor.pose[iHead])
        .sub(new THREE.Vector3().fromArray(actor.pose[iNeck]));
      if (u.lengthSq() > 1e-9) up.copy(u.normalize());
    }
    const fwd = new THREE.Vector3().crossVectors(up, side).normalize();
    // Re-square the basis as x = y CROSS z, not the other way round. The
    // shoulder line and the neck are not exactly perpendicular once a
    // character is moving, and picking the wrong order gives a basis with
    // determinant -1 — a REFLECTION, which setFromRotationMatrix cannot
    // express, so it silently returns something near identity and the face
    // ends up on top of the head instead of on the front of it.
    side.crossVectors(up, fwd).normalize();
    face.position.fromArray(actor.pose[iHead]);
    face.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(side, up, fwd));
    const head = actor.joints[iHead];
    const r = head.radius * jointEmphasis(spec, 'head') * spec.joint;
    face.scale.setScalar(r);
  }

  private taperedGeo(taper: number): THREE.CylinderGeometry {
    const key = Math.round(taper * 100) / 100;
    let g = this.limbSolid.get(key);
    if (!g) {
      g = new THREE.CylinderGeometry(key, 1, 1, 16, 1, false);
      this.limbSolid.set(key, g);
    }
    return g;
  }

  /** Root object for an actor, so picking can map a hit back to it. */
  rootFor(id: number): THREE.Object3D | null { return this.entries.get(id)?.root ?? null; }

  /** Every actor's meshes, for viewport picking. */
  pickTargets(scene: GPScene): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const a of scene.actors) {
      const e = this.entries.get(a.id);
      if (e && a.visible && !a.lock) out.push(e.root);
    }
    return out;
  }

  private dispose(entry: Entry): void {
    (entry.limbs[0]?.material as THREE.Material | undefined)?.dispose?.();
    entry.sticks.geometry.dispose();
    (entry.sticks.material as THREE.Material).dispose();
  }
}
