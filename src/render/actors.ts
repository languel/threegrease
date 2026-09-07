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
import { BlobBody } from './blob';
import { actorHasAvatar } from './vrm';

/** Which local axis the actor stands up along, from its own rest skeleton. */
/**
 * A head with the face CARVED INTO IT, not stuck onto it.
 *
 * Same sphere, moved: two eye sockets pressed in and a ridge raised between
 * them, by displacing the vertices along their own normals. That is what a
 * modeller would do and what a carver does, and it costs no extra draw, no
 * extra material and nothing to keep aligned — the features cannot drift off
 * the head because they ARE the head. Built once per look and shared.
 *
 * Authored looking down +Z with +Y up, the same frame the facing basis
 * builds, so the head mesh only has to be turned the way the body faces.
 */
function buildFaceHead(strength: number): THREE.SphereGeometry {
  // Low poly ON PURPOSE. The relief needs enough vertices to shape a socket
  // and no more — 96x72 was seven thousand of them for two dishes and a
  // ridge, and the extra resolution buys nothing you can see on a head 40 px
  // tall. This is a sculpture, not a scan.
  const geo = new THREE.SphereGeometry(1, 40, 30);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const eyes = [
    new THREE.Vector3(0.40, 0.10, 0.86).normalize(),
    new THREE.Vector3(-0.40, 0.10, 0.86).normalize(),
  ];
  // The ridge as a short arc of directions, each with its OWN width and
  // rise. A constant-width line running up to the brow reads as a CREST
  // down the skull rather than as a nose — the shape wanted is a soft
  // wedge that starts between the eyes, swells toward the tip and stops
  // well short of the forehead.
  const ridge: { dir: THREE.Vector3; r: number; rise: number }[] = [];
  const from = new THREE.Vector3(0, 0.10, 0.98).normalize();
  const to = new THREE.Vector3(0, -0.30, 0.94).normalize();
  const STEPS = 10;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    ridge.push({
      dir: from.clone().lerp(to, t).normalize(),
      r: 0.09 + 0.08 * t,
      // Prouder toward the TIP, fading in only at the brow so it melts into
      // the forehead rather than starting with a step. Fading at BOTH ends
      // (the obvious symmetric thing) puts a zero exactly where the nose is
      // meant to be strongest, and the whole feature vanishes.
      rise: (0.030 + 0.075 * t) * Math.min(1, t / 0.22),
    });
  }

  const EYE_R = 0.36; const EYE_DEPTH = 0.19;
  const fall = (a: number, r: number) => {
    if (a >= r) return 0;
    const t = 1 - a / r;
    return t * t * (3 - 2 * t); // smoothstep
  };
  const angle = (a: THREE.Vector3, b: THREE.Vector3) =>
    Math.acos(Math.max(-1, Math.min(1, a.dot(b))));

  /**
   * The head's PROFILE, as width against height.
   *
   * A sphere (or an ovoid, which is a sphere with one axis stretched) reads
   * as an egg, and an egg has no chin: the widest point is in the middle and
   * it closes symmetrically at both ends. A carved head is the opposite —
   * broad across the cranium, narrowing through the cheek into a jaw and a
   * chin. Squeezing the horizontal axes by a curve in height is the whole
   * difference, and it costs nothing: the vertices are already there.
   */
  const PROFILE: [number, number][] = [
    [0.00, 0.52], // chin
    [0.18, 0.68],
    [0.35, 0.84], // jaw
    [0.55, 0.97],
    [0.72, 1.05], // cranium, the widest point — high, not central
    [0.88, 1.02],
    [1.00, 0.96], // crown, closing gently rather than to a point
  ];
  const widthAt = (t: number) => {
    for (let i = 1; i < PROFILE.length; i++) {
      const [t1, w1] = PROFILE[i];
      if (t <= t1) {
        const [t0, w0] = PROFILE[i - 1];
        const u = (t - t0) / Math.max(1e-6, t1 - t0);
        return w0 + (w1 - w0) * (u * u * (3 - 2 * u));
      }
    }
    return PROFILE[PROFILE.length - 1][1];
  };

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // profile first, so the features are cut into the shaped head rather
    // than shaped along with it
    const w = widthAt((v.y + 1) / 2);
    v.x *= w; v.z *= w;
    pos.setXYZ(i, v.x, v.y, v.z);
    let d = 0;
    // measured against the DIRECTION the vertex sits in, so the sockets stay
    // round after the profile has squeezed the head narrower at that height
    const dir = v.clone().normalize();
    for (const e of eyes) d -= EYE_DEPTH * strength * fall(angle(dir, e), EYE_R);
    // the STRONGEST sample rather than the sum, or the overlapping ones
    // stack into a hard spine down the middle
    let rise = 0;
    for (const seg of ridge) {
      rise = Math.max(rise, seg.rise * fall(angle(dir, seg.dir), seg.r));
    }
    d += rise * strength;
    if (d !== 0) {
      v.addScaledVector(dir, d);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
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
  /** built lazily, only for looks that ask for one continuous surface */
  blob?: BlobBody;
  limbs: THREE.Mesh[];
  joints: THREE.Mesh[];
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
  private limbGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  /** capped tubes, cached per taper ratio. The cylinder's +Y end is the
   *  CHILD joint (setFromUnitVectors maps +Y onto a->b), so a radiusTop
   *  below 1 narrows the limb INTO the joint it points at — a forearm
   *  thinning into a wrist, which is the whole silhouette of a lay figure. */
  private limbSolid = new Map<number, THREE.CylinderGeometry>();
  private jointGeo = new THREE.SphereGeometry(1, 12, 9);
  /** carved heads, cached per look (they differ only in relief depth) */
  private faceGeo = new Map<number, THREE.SphereGeometry>();
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
    // the stick overlay is an annotation, not a surface: raycasting it would
    // let a drawn stroke land on a debug line rather than on the body
    sticks.raycast = () => {};
    root.add(sticks);
    return {
      root, limbs, joints, sticks,
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
      if (j.name === 'head') {
        const carved = spec.face && showLimbs && !wearing;
        const want = carved ? this.carvedHead(spec.faceRelief) : this.jointGeo;
        if (mesh.geometry !== want) mesh.geometry = want;
        if (carved) {
          // turned to face the way the body does, which also puts the
          // ovoid's stretch on the head's OWN up axis (+Y in that frame)
          this.faceTheHead(actor, mesh, i);
          if (spec.headOvoid !== 1) mesh.scale.y = r * spec.headOvoid;
        } else {
          mesh.quaternion.identity();
          // the head is an ovoid, stretched along the actor's own up axis —
          // read off the skeleton (head above hips) rather than from the
          // scene setting, so it is right for an actor built in either
          // convention
          if (spec.headOvoid !== 1) {
            mesh.scale.setComponent(actorUpAxis(actor), r * spec.headOvoid);
          }
        }
      }
      mesh.visible = showLimbs || showSticks;
    }

    // ---- one continuous surface, for looks that want it ----------------
    if (spec.blob && showLimbs && !wearing) {
      if (!entry.blob) {
        entry.blob = new BlobBody(entry.limbs[0]?.material as THREE.Material);
        root.add(entry.blob.mesh);
      }
      entry.blob.setMaterial(entry.limbs[0]?.material as THREE.Material);
      entry.blob.update(actor, spec.limb, spec.joint);
      // the parts are what the surface is BUILT from, so they stay out of
      // the picture — except the head, which keeps its carved face
      for (const m of entry.limbs) m.visible = false;
      for (let i = 0; i < entry.joints.length; i++) {
        entry.joints[i].visible = showSticks
          || actor.joints[i].name === 'head' || actor.joints[i].pin;
      }
    } else if (entry.blob) {
      entry.blob.mesh.visible = false;
    }
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
  private faceTheHead(
    actor: TGActor, mesh: THREE.Mesh, iHead: number,
  ): void {
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
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(side, up, fwd));
  }

  private carvedHead(relief: number): THREE.SphereGeometry {
    const key = Math.round(relief * 100) / 100;
    let g = this.faceGeo.get(key);
    if (!g) { g = buildFaceHead(key); this.faceGeo.set(key, g); }
    return g;
  }

  private taperedGeo(taper: number): THREE.CylinderGeometry {
    const key = Math.round(taper * 100) / 100;
    let g = this.limbSolid.get(key);
    if (!g) {
      g = new THREE.CylinderGeometry(key, 1, 1, 10, 1, false);
      this.limbSolid.set(key, g);
    }
    return g;
  }

  /** Every visible actor's root, for the 3D exporters. */
  exportRoots(scene: GPScene): THREE.Object3D[] {
    return scene.actors
      .filter((a) => a.visible)
      .map((a) => this.entries.get(a.id)?.root)
      .filter((r): r is THREE.Group => !!r);
  }

  /** Actors flagged as draw targets, for ctx.surfaces. */
  drawTargets(scene: GPScene): THREE.Object3D[] {
    return scene.actors
      .filter((a) => a.visible && a.drawTarget)
      .map((a) => this.entries.get(a.id)?.root)
      .filter((r): r is THREE.Group => !!r);
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
