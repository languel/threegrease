// Rapier: the OTHER physics backend.
//
// `props.ts` is ours — spheres, no rotation, no resting contact — and it is
// the right size for "a character kicks a ball". This one is for everything
// that answer cannot give: a crate that topples onto a face, a stack that
// holds, real convex shapes, and above all DETERMINISM. Rapier steps a fixed
// timestep over an explicit island solver, so the same scene and the same
// inputs give the same result on every machine and every run — which is what
// an installation that has to behave the same on opening night needs.
//
// The seam is deliberately narrow and the two backends answer the same three
// questions: step the world, hold a prop under the cursor, and let it go.
// `scene.physicsEngine` picks one. Nothing else in the app knows which is
// running.
//
// WHAT IS MIRRORED. Rapier owns a world built FROM `GPScene`, never the other
// way round: scene data is still the document, and every step writes back
// into it. So undo, save, load and the outliner all keep working, and a
// scene authored with the simple engine opens here unchanged.
//   - no `body`          -> fixed (the room: floors, walls, plinths, stairs)
//   - `body.type` DYNAMIC   -> dynamic
//   - `body.type` KINEMATIC -> kinematicPositionBased, driven from the data
//   - every actor JOINT  -> a kinematic ball, so kicking still works and
//     still needs no special case
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { GPScene, TGMesh, Vec3 } from '../core/types';
import { meshLocalBounds, worldAABB } from '../tools/objectops';
import { parentWorldMatrixOf, worldMatrixOf } from '../tools/objects';
import { primitiveGeometry } from '../render/meshes';
import { propRadius } from './props';

type Rapier = typeof RAPIER_NS;

/** Rapier's own default, and the step everything here assumes. */
const STEP = 1 / 60;
/** never spend more than this many substeps catching up after a stall */
const MAX_SUBSTEPS = 5;
/** how fast a held prop chases the cursor (metres/second) */
const HOLD_SPEED = 14;
/** scene data moved by something other than us by more than this = a teleport */
const TELEPORT_EPS = 1e-4;

interface Entry {
  body: RAPIER_NS.RigidBody;
  collider: RAPIER_NS.Collider;
  /** what the shape was built from, so a resize or a kind change rebuilds it */
  shapeKey: string;
  /** rigid-body kind currently in the world */
  bodyKind: 'fixed' | 'dynamic' | 'kinematic';
  /** the last transform WE wrote into the scene, to tell our own writes
   *  apart from an edit made by the user, a constraint or an undo */
  wrote: { t: Vec3; r: Vec3 } | null;
}

export class RapierPhysics {
  private R: Rapier | null = null;
  private world: RAPIER_NS.World | null = null;
  private entries = new Map<number, Entry>();
  private joints = new Map<string, RAPIER_NS.RigidBody>();
  private held = new Map<number, THREE.Vector3>();
  private accum = 0;
  private upZ = true;
  private loading: Promise<void> | null = null;

  get ready(): boolean { return !!this.world; }

  /**
   * Load the wasm and build an empty world.
   *
   * Deliberately lazy and idempotent: the compat build carries ~1 MB of wasm
   * inlined, and a scene that never asks for Rapier should never pay for it.
   */
  init(upZ: boolean): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const mod = await import('@dimforge/rapier3d-compat');
      const R = (mod.default ?? mod) as unknown as Rapier;
      await R.init();
      this.R = R;
      this.upZ = upZ;
      this.world = new R.World(gravityFor(R, upZ));
      this.world.timestep = STEP;
    })();
    return this.loading;
  }

  /** Throw the world away — a scene load, an up-axis change, a backend swap. */
  reset(): void {
    this.world?.free();
    this.world = null;
    this.entries.clear();
    this.joints.clear();
    this.held.clear();
    this.accum = 0;
    this.loading = null;
  }

  hold(id: number, target: THREE.Vector3): void { this.held.set(id, target.clone()); }
  release(id: number): void { this.held.delete(id); }
  isHeld(id: number): boolean { return this.held.has(id); }

  /**
   * One frame: mirror the scene in, step, write the results back.
   *
   * Returns whether anything moved, so the caller can skip a mesh resync in
   * a scene where nothing is falling.
   */
  update(scene: GPScene, dt: number, upZ: boolean): boolean {
    const R = this.R; const world = this.world;
    if (!R || !world) return false;
    if (upZ !== this.upZ) {
      // gravity is the only thing the up axis changes here, and it changes
      // for every body at once
      this.upZ = upZ;
      world.gravity = gravityFor(R, upZ);
    }
    this.syncBodies(R, world, scene);
    this.syncJoints(R, world, scene);

    this.accum = Math.min(this.accum + dt, STEP * MAX_SUBSTEPS);
    let stepped = false;
    while (this.accum >= STEP) {
      this.driveHeld(scene);
      world.step();
      this.accum -= STEP;
      stepped = true;
    }
    if (!stepped) return false;
    return this.writeBack(scene);
  }

  // ---------------------------------------------------------------- bodies

  private syncBodies(R: Rapier, world: RAPIER_NS.World, scene: GPScene): void {
    const seen = new Set<number>();
    for (const m of scene.meshes) {
      if (m.kind === 'EMPTY' || m.visible === false || m.collide === false) continue;
      const want = m.lock ? 'fixed'
        : !m.body ? 'fixed'
          : m.body.type === 'KINEMATIC' ? 'kinematic' : 'dynamic';
      const key = shapeKey(m);
      let e = this.entries.get(m.id);
      if (e && (e.shapeKey !== key || e.bodyKind !== want)) {
        world.removeRigidBody(e.body);
        this.entries.delete(m.id);
        e = undefined;
      }
      if (!e) {
        const made = this.build(R, world, scene, m, want);
        if (!made) continue;
        this.entries.set(m.id, made);
        e = made;
      } else {
        this.pushTransform(R, scene, m, e);
      }
      seen.add(m.id);
    }
    for (const [id, e] of this.entries) {
      if (seen.has(id)) continue;
      world.removeRigidBody(e.body);
      this.entries.delete(id);
    }
  }

  private build(
    R: Rapier, world: RAPIER_NS.World, scene: GPScene, m: TGMesh,
    kind: Entry['bodyKind'],
  ): Entry | null {
    const { pos, quat, scale } = worldTRS(scene, m);
    const desc = kind === 'dynamic' ? R.RigidBodyDesc.dynamic()
      : kind === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased()
        : R.RigidBodyDesc.fixed();
    desc.setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
    if (m.body?.vel) desc.setLinvel(m.body.vel[0], m.body.vel[1], m.body.vel[2]);
    const body = world.createRigidBody(desc);
    const cd = colliderDesc(R, m, scale);
    if (!cd) { world.removeRigidBody(body); return null; }
    if (m.body) {
      // Our own field names are the physical ones, so they carry over: mass
      // is a mass, bounce is restitution, friction is friction. The one
      // translation is that Rapier wants a DENSITY or an explicit mass, and
      // an explicit mass is what the panel has always shown.
      cd.setRestitution(m.body.bounce).setFriction(Math.max(0.05, m.body.friction * 8));
      cd.setMass(Math.max(0.01, m.body.mass));
    } else {
      cd.setRestitution(0.2).setFriction(0.8);
    }
    const collider = world.createCollider(cd, body);
    return { body, collider, shapeKey: shapeKey(m), bodyKind: kind, wrote: null };
  }

  /**
   * Carry an EXTERNAL edit into the world.
   *
   * The test is against what we last wrote, not against the previous frame:
   * a dynamic body writes its own translation every step, so "changed since
   * last frame" is true of everything that is falling. Anything that differs
   * from OUR value came from somewhere else — the transform widget, a
   * constraint, an undo, a scene load — and has to be a teleport, velocity
   * included, or the body springs back to where the simulation left it.
   */
  private pushTransform(R: Rapier, scene: GPScene, m: TGMesh, e: Entry): void {
    const moved = !e.wrote
      || !near(e.wrote.t, m.translation) || !near(e.wrote.r, m.rotation);
    if (e.bodyKind === 'kinematic') {
      const { pos, quat } = worldTRS(scene, m);
      e.body.setNextKinematicTranslation(pos);
      e.body.setNextKinematicRotation(quat);
      return;
    }
    if (!moved) return;
    const { pos, quat } = worldTRS(scene, m);
    e.body.setTranslation(pos, true);
    e.body.setRotation(quat, true);
    if (e.bodyKind === 'dynamic') {
      e.body.setLinvel(new R.Vector3(0, 0, 0), true);
      e.body.setAngvel(new R.Vector3(0, 0, 0), true);
    }
    e.wrote = { t: [...m.translation], r: [...m.rotation] };
  }

  // ---------------------------------------------------------------- joints

  /**
   * Every actor joint as a kinematic ball.
   *
   * The same idea as the simple engine's: a joint is already a sphere with a
   * radius and a solved position every frame, so contact needs no new
   * representation. Here Rapier derives the contact velocity from the
   * kinematic motion itself, so a planted foot nudges and a swinging one
   * launches without anything modelling "a kick".
   */
  private syncJoints(R: Rapier, world: RAPIER_NS.World, scene: GPScene): void {
    const seen = new Set<string>();
    for (const actor of scene.actors) {
      if (!actor.visible) continue;
      const mat = worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id });
      for (let i = 0; i < actor.joints.length; i++) {
        const key = `${actor.id}:${i}`;
        seen.add(key);
        const w = new THREE.Vector3(...actor.pose[i]).applyMatrix4(mat);
        let body = this.joints.get(key);
        if (!body) {
          body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased()
            .setTranslation(w.x, w.y, w.z));
          world.createCollider(
            R.ColliderDesc.ball(Math.max(0.02, actor.joints[i].radius)).setFriction(0.9),
            body);
          this.joints.set(key, body);
        }
        body.setNextKinematicTranslation(w);
      }
    }
    for (const [key, body] of this.joints) {
      if (seen.has(key)) continue;
      world.removeRigidBody(body);
      this.joints.delete(key);
    }
  }

  // ------------------------------------------------------------------ hold

  /**
   * A dragged prop stays DYNAMIC and is steered by its velocity.
   *
   * Making it kinematic instead would be the obvious move and is wrong: a
   * kinematic body passes through walls, so the ball you are dragging ends
   * up inside the gallery. Steering a dynamic body means the drag still
   * argues with the room — and letting go needs no code at all, because the
   * chase velocity IS the throw.
   */
  private driveHeld(scene: GPScene): void {
    for (const [id, target] of this.held) {
      const e = this.entries.get(id);
      if (!e || e.bodyKind !== 'dynamic') continue;
      const p = e.body.translation();
      const want = target.clone().sub(new THREE.Vector3(p.x, p.y, p.z)).divideScalar(STEP);
      if (want.length() > HOLD_SPEED) want.setLength(HOLD_SPEED);
      e.body.setGravityScale(0, true);
      e.body.setLinvel(want, true);
    }
    for (const [id, e] of this.entries) {
      if (e.bodyKind === 'dynamic' && !this.held.has(id) && e.body.gravityScale() !== 1) {
        e.body.setGravityScale(1, true);
      }
      void id;
    }
  }

  // -------------------------------------------------------------- results

  private writeBack(scene: GPScene): boolean {
    let moved = false;
    for (const m of scene.meshes) {
      const e = this.entries.get(m.id);
      if (!e || e.bodyKind !== 'dynamic') continue;
      if (e.body.isSleeping()) continue;
      const p = e.body.translation();
      const q = e.body.rotation();
      // Back into the object's own frame: `translation`/`rotation` are
      // parent-LOCAL and one Cmd-G puts every ball under an empty, while the
      // simulation is entirely in world space.
      const parent = parentWorldMatrixOf(scene, { kind: 'MESH', id: m.id });
      const inv = parent.clone().invert();
      const local = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(inv);
      const pq = new THREE.Quaternion().setFromRotationMatrix(parent).invert()
        .multiply(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      const euler = new THREE.Euler().setFromQuaternion(pq);
      m.translation = [local.x, local.y, local.z];
      // ROTATION is the whole reason this backend exists: a crate can land
      // on a face. The simple engine has no angular state to write at all.
      m.rotation = [euler.x, euler.y, euler.z];
      const v = e.body.linvel();
      if (m.body) m.body.vel = [v.x, v.y, v.z];
      e.wrote = { t: [...m.translation], r: [...m.rotation] };
      moved = true;
    }
    return moved;
  }
}

// ------------------------------------------------------------------ helpers

function gravityFor(R: Rapier, upZ: boolean): RAPIER_NS.Vector3 {
  return upZ ? new R.Vector3(0, 0, -9.81) : new R.Vector3(0, -9.81, 0);
}

function near(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) < TELEPORT_EPS
    && Math.abs(a[1] - b[1]) < TELEPORT_EPS
    && Math.abs(a[2] - b[2]) < TELEPORT_EPS;
}

/** What a rebuild depends on: change any of it and the collider is remade. */
function shapeKey(m: TGMesh): string {
  return `${m.kind}|${m.scale.join(',')}|${m.src ?? ''}`;
}

function worldTRS(scene: GPScene, m: TGMesh): {
  pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3;
} {
  const mat = worldMatrixOf(scene, { kind: 'MESH', id: m.id });
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mat.decompose(pos, quat, scale);
  return { pos, quat, scale };
}

/**
 * The primitive's real shape, not its bounding sphere.
 *
 * This is the other half of what Rapier buys: our own engine collides
 * everything as a sphere, so a crate rolls where it should slide and a
 * tetrahedron is a ball. The platonics have no analytic collider, so their
 * geometry — the SAME factory the renderer draws from, so the two can never
 * disagree — becomes a convex hull.
 */
function colliderDesc(
  R: Rapier, m: TGMesh, scale: THREE.Vector3,
): RAPIER_NS.ColliderDesc | null {
  const sx = Math.abs(scale.x), sy = Math.abs(scale.y), sz = Math.abs(scale.z);
  switch (m.kind) {
    case 'BOX':
      return R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
    case 'SPHERE':
      return R.ColliderDesc.ball(Math.max(sx, sy, sz) / 2);
    // A PLANE's scale is its HALF size (PlaneGeometry(2,2)), and it is drawn
    // in local XY — so a wall is a thin slab, not a half-space: half-spaces
    // are infinite and a wall you can walk round would seal the room.
    case 'PLANE': {
      // Sunk by its own half-thickness so the TOP FACE lands exactly on the
      // plane you can see. Centring the slab instead leaves everything
      // resting 2 cm in the air, which reads as floaty contact rather than
      // as a collider in the wrong place.
      const t = 0.02;
      return R.ColliderDesc.cuboid(Math.max(0.01, sx), Math.max(0.01, sy), t)
        .setTranslation(0, 0, -t);
    }
    case 'CYLINDER':
      // CylinderGeometry(0.5, 0.5, 1.2) — height 1.2 in the primitive's own Y
      return R.ColliderDesc.cylinder(sy * 0.6, Math.max(sx, sz) / 2);
    case 'PYRAMID':
      return R.ColliderDesc.cone(sy / 2, Math.max(sx, sz) / 2);
    case 'MODEL': {
      // loaded geometry is not in the data layer; its bounds are the honest
      // approximation, and it is nearly always scenery anyway
      const local = meshLocalBounds(m);
      if (!local) return R.ColliderDesc.ball(Math.max(0.05, propRadius(m)));
      const size = worldAABB(local, new THREE.Matrix4().makeScale(sx, sy, sz))
        .getSize(new THREE.Vector3());
      return R.ColliderDesc.cuboid(
        Math.max(0.01, size.x / 2), Math.max(0.01, size.y / 2), Math.max(0.01, size.z / 2));
    }
    default: {
      const geo = primitiveGeometry(m.kind);
      const src = geo.getAttribute('position');
      const pts = new Float32Array(src.count * 3);
      for (let i = 0; i < src.count; i++) {
        pts[i * 3] = src.getX(i) * sx;
        pts[i * 3 + 1] = src.getY(i) * sy;
        pts[i * 3 + 2] = src.getZ(i) * sz;
      }
      geo.dispose();
      return R.ColliderDesc.convexHull(pts)
        ?? R.ColliderDesc.ball(Math.max(0.05, propRadius(m)));
    }
  }
}

export const rapierPhysics = new RapierPhysics();
