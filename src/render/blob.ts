// A body as ONE surface, not as parts.
//
// Every other look draws a capsule per bone and a bead per joint, which is
// honest about the rig and looks it: you can see the seams, and a shoulder
// is two shapes overlapping rather than a shoulder. A clay figure should be
// one continuous thing that swells where the body is thick and necks where
// it is thin — and it should do that WITHOUT skinning, which this project
// has none of (there is no bind pose, no weights, and the skeleton stores no
// rotations to skin against).
//
// So the surface is implicit: field sources at every joint and along every
// bone, polygonised each frame. That gives limbs that MERGE where they meet
// — the thing skinning is usually for — from the positional skeleton exactly
// as it already is, with no rigging step and nothing to keep in sync.
//
// The cost is a full polygonisation per frame, so it is opt-in per look and
// deliberately modest in resolution: this is a stop-motion figure, and a
// slightly lumpy surface is the point rather than an artefact.
import * as THREE from 'three';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';
import type { TGActor } from '../core/types';

/** grid resolution per axis — 48 costs ~110k cells and still shows knuckles */
const RES = 48;
/**
 * How sharply a field source falls off.
 *
 * A source reaches sqrt((isolation + subtract) / subtract) times its own
 * radius, and every source inside that reach ADDS. At 10 the reach is three
 * radii, two hundred sources pile up on each other and the figure inflates
 * into a snowman with its arms absorbed. At 64 the reach is 1.5 radii: limbs
 * stay limbs and the merging is confined to where parts actually meet, which
 * is the only place it was wanted.
 */
const SUBTRACT = 64;
/** field sources along a bone are spaced by a FRACTION OF THE RADIUS, not by
 *  a fixed count: a fixed count leaves a long thin limb as a string of
 *  pearls (each source's influence ends before the next begins) while
 *  over-sampling a short fat one for nothing. */
const SPACING = 0.45;
const MAX_PER_BONE = 40;
/** the field spills past its sources, so the box has to be roomier than the
 *  body or the surface gets clipped flat at the edges */
const PAD = 1.35;

export class BlobBody {
  readonly mesh: MarchingCubes;

  constructor(material: THREE.Material) {
    this.mesh = new MarchingCubes(RES, material, true, false, 90000);
    this.mesh.isolation = 80;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  setMaterial(material: THREE.Material): void {
    this.mesh.material = material;
  }

  /**
   * Rebuild the surface from this frame's pose.
   *
   * Field positions are normalised into the marching-cubes unit cube, so the
   * box is fitted to the body each frame — a figure reaching upward gets the
   * same surface quality as one curled up, instead of wasting half the grid
   * on empty space.
   */
  update(actor: TGActor, limbScale: number, jointScale: number): void {
    const pose = actor.pose;
    if (!pose.length) { this.mesh.visible = false; return; }

    // fit the box to the pose plus the fattest thing in it
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    let widest = 0;
    for (let i = 0; i < pose.length; i++) {
      const p = pose[i];
      const r = (actor.joints[i]?.radius ?? 0) * jointScale;
      widest = Math.max(widest, r);
      for (let c = 0; c < 3; c++) {
        min.setComponent(c, Math.min(min.getComponent(c), p[c] - r));
        max.setComponent(c, Math.max(max.getComponent(c), p[c] + r));
      }
    }
    const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) * PAD
      + widest * 2;
    if (!(size > 0)) { this.mesh.visible = false; return; }
    const centre = min.clone().add(max).multiplyScalar(0.5);

    this.mesh.position.copy(centre);
    this.mesh.scale.setScalar(size / 2);
    this.mesh.reset();

    // marching cubes addresses its grid in 0..1, and the object's own scale
    // maps that onto the box we just fitted
    const toCube = (p: readonly number[], out: THREE.Vector3) => out.set(
      (p[0] - centre.x) / size + 0.5,
      (p[1] - centre.y) / size + 0.5,
      (p[2] - centre.z) / size + 0.5,
    );
    const v = new THREE.Vector3();
    // A ball's field is strength / distance^2 - subtract, and the surface is
    // drawn where that equals ISOLATION — so a lone ball's radius is
    // sqrt(strength / (isolation + subtract)), and the strength for a radius
    // is that solved backwards. Leaving isolation out of it (the obvious
    // mistake) draws every limb at a THIRD of its thickness while the joints,
    // where several fields overlap and sum, still bulge — a stick figure with
    // knobbles, which is exactly what the first attempt looked like.
    const ISO = this.mesh.isolation;
    const ball = (x: number, y: number, z: number, radius: number) => {
      const rn = radius / size;
      if (rn <= 0.001) return;
      this.mesh.addBall(x, y, z, (ISO + SUBTRACT) * rn * rn, SUBTRACT);
    };

    for (let i = 0; i < pose.length; i++) {
      // The HEAD keeps its own carved mesh (that is where the face is), so
      // its field source is set slightly inside it: at full radius the two
      // surfaces are coincident and z-fight, and dropping it entirely leaves
      // the neck ending in mid-air.
      const shrink = actor.joints[i]?.name === 'head' ? 0.86 : 1;
      const r = (actor.joints[i]?.radius ?? 0) * jointScale * shrink;
      toCube(pose[i], v);
      ball(v.x, v.y, v.z, r);
    }
    const byId = new Map(actor.joints.map((j, i) => [j.id, i]));
    const a = new THREE.Vector3(); const b = new THREE.Vector3();
    for (const bone of actor.bones) {
      const r = bone.radius * limbScale;
      if (r <= 0) continue;
      const ia = byId.get(bone.a); const ib = byId.get(bone.b);
      if (ia === undefined || ib === undefined) continue;
      toCube(pose[ia], a); toCube(pose[ib], b);
      const steps = Math.min(MAX_PER_BONE,
        Math.max(2, Math.ceil(a.distanceTo(b) / Math.max(1e-4, (r / size) * SPACING))));
      for (let s = 1; s < steps; s++) {
        v.lerpVectors(a, b, s / steps);
        ball(v.x, v.y, v.z, r);
      }
    }
    this.mesh.update();
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
