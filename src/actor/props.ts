// Loose props: things in the room a character can push, kick and climb on.
//
// This is a SMALL, honest simulation, and the shape of it follows from one
// observation: an actor here is already a set of joint spheres with radii
// and a solved position every frame. So contact between a prop and a
// character needs no new representation at all — sphere against sphere, with
// the impulse taken from how fast that joint happens to be moving. Walking
// into a ball nudges it; a swinging foot kicks it; a hand bats it. None of
// those are special cases, they are the same test at different speeds.
//
// WHAT IT IS NOT. There is no rotational dynamics, no friction cone, no
// resting-contact solver, and every prop collides as a SPHERE whatever it
// is drawn as. A cube shoved across the floor will roll a little too
// willingly and will not topple onto a face. That is the same fidelity the
// character's own collision has (world AABBs), and picking a matching one
// deliberately is better than pairing a rigid-body engine with a capsule
// that pushes out of boxes.
//
// Props collide with: the static world (the same AABBs the walking body
// uses), each other, and every actor's joints. They are also fed back INTO
// the walking body, so a big enough crate is something to stand on.
import * as THREE from 'three';
import type { GPScene, TGMesh, Vec3 } from '../core/types';
import { meshLocalBounds, worldAABB } from '../tools/objectops';
import { parentWorldMatrixOf, worldMatrixOf } from '../tools/objects';

/** Below this speed a prop is treated as parked, so a room full of them
 *  does not shimmer forever. */
const SLEEP = 0.035;
const MAX_STEP = 1 / 60;
/** How fast a HELD prop is allowed to chase the cursor. Bounded because the
 *  hold is a velocity, not a teleport: at any speed the prop still resolves
 *  against walls, and a flick that outran the collision pass would post a
 *  ball through the gallery wall. It is also the throw speed, since letting
 *  go simply stops steering it. */
const HOLD_SPEED = 14;

interface Live {
  mesh: TGMesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  invMass: number;
  /** world -> the space `mesh.translation` is written in (identity unless
   *  the prop is parented — grouping props under an empty is one click away) */
  toLocal: THREE.Matrix4;
  /** where a hand is dragging it this frame, in world space */
  hold: THREE.Vector3 | null;
}

/** A prop's collision radius: the largest half-extent it is drawn with. */
export function propRadius(m: TGMesh): number {
  return Math.max(0.05,
    Math.max(Math.abs(m.scale[0]), Math.abs(m.scale[1]), Math.abs(m.scale[2])) * 0.5);
}

export class PropEngine {
  /** joint world positions from the previous frame, for contact velocity */
  private lastJoints = new Map<string, THREE.Vector3>();
  private accum = 0;
  /** props under a cursor right now: mesh id -> world target */
  private held = new Map<number, THREE.Vector3>();

  reset(): void { this.lastJoints.clear(); this.held.clear(); this.accum = 0; }

  /**
   * Drag a prop by steering it, never by placing it.
   *
   * The whole point of dragging a ball rather than typing its coordinates is
   * to see it meet the room, so a held prop is driven by a VELOCITY toward
   * the cursor and then goes through the same collision pass as everything
   * else: it stops at walls, shoulders other props aside, and shoves a
   * character it is pushed into. Setting `translation` from the tool would
   * skip all of that and put the ball inside the wall.
   */
  hold(id: number, target: THREE.Vector3): void { this.held.set(id, target.clone()); }
  /** Let go. Whatever velocity the chase built up is the throw. */
  release(id: number): void { this.held.delete(id); }
  isHeld(id: number): boolean { return this.held.has(id); }

  /** Every dynamic prop's world AABB, so the walking body can stand on them. */
  dynamicBoxes(scene: GPScene): THREE.Box3[] {
    const out: THREE.Box3[] = [];
    for (const m of scene.meshes) {
      if (!m.body || m.visible === false) continue;
      const local = meshLocalBounds(m);
      if (local) out.push(worldAABB(local, worldMatrixOf(scene, { kind: 'MESH', id: m.id })));
    }
    return out;
  }

  update(scene: GPScene, dt: number, upZ: boolean, staticBoxes: THREE.Box3[]): boolean {
    const live: Live[] = [];
    for (const m of scene.meshes) {
      if (!m.body || m.visible === false || m.lock) continue;
      m.body.vel ??= [0, 0, 0];
      const parent = parentWorldMatrixOf(scene, { kind: 'MESH', id: m.id });
      live.push({
        mesh: m,
        pos: new THREE.Vector3(...m.translation).applyMatrix4(parent),
        vel: new THREE.Vector3(...m.body.vel),
        radius: propRadius(m),
        invMass: m.body.mass > 0 ? 1 / m.body.mass : 0,
        toLocal: parent.clone().invert(),
        hold: this.held.get(m.id) ?? null,
      });
    }
    if (!live.length) return false;

    // Fixed slices, so a stutter does not launch everything through a wall.
    this.accum = Math.min(this.accum + dt, MAX_STEP * 5);
    let stepped = false;
    while (this.accum >= MAX_STEP) {
      this.step(scene, live, MAX_STEP, upZ, staticBoxes);
      this.accum -= MAX_STEP;
      stepped = true;
    }
    if (!stepped) return false;

    for (const b of live) {
      const local = b.pos.clone().applyMatrix4(b.toLocal);
      b.mesh.translation = [local.x, local.y, local.z];
      b.mesh.body!.vel = [b.vel.x, b.vel.y, b.vel.z];
    }
    return true;
  }

  private step(
    scene: GPScene, live: Live[], h: number, upZ: boolean, staticBoxes: THREE.Box3[],
  ): void {
    const upAxis = upZ ? 2 : 1;
    const g = -9.81;

    for (const b of live) {
      if (b.hold) {
        // Chase the cursor at a bounded speed and carry no gravity while
        // held, so a prop stays where you put it in mid-air — which is what
        // staging a scene actually needs — and falls the moment you let go.
        const want = b.hold.clone().sub(b.pos).divideScalar(h);
        if (want.length() > HOLD_SPEED) want.setLength(HOLD_SPEED);
        b.vel.copy(want);
      } else {
        b.vel.setComponent(upAxis, b.vel.getComponent(upAxis) + g * h);
      }
      b.pos.addScaledVector(b.vel, h);
    }

    // ---- the static world: the same boxes the characters walk on --------
    for (const b of live) {
      for (const box of staticBoxes) this.hitBox(b, box, upAxis);
    }

    // ---- each other -----------------------------------------------------
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) this.hitProp(live[i], live[j]);
    }

    // ---- characters: every joint is already a sphere ---------------------
    for (const actor of scene.actors) {
      if (!actor.visible) continue;
      const m = worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id });
      for (let i = 0; i < actor.joints.length; i++) {
        const jw = new THREE.Vector3(...actor.pose[i]).applyMatrix4(m);
        const key = `${actor.id}:${i}`;
        const prev = this.lastJoints.get(key);
        // the joint's own velocity IS the kick: a planted foot nudges, a
        // swinging one launches, and nothing had to model "kicking"
        const jv = prev ? jw.clone().sub(prev).divideScalar(h) : new THREE.Vector3();
        this.lastJoints.set(key, jw.clone());
        const jr = actor.joints[i].radius;
        for (const b of live) this.hitJoint(b, jw, jv, jr);
      }
    }

    for (const b of live) {
      if (!b.hold && b.vel.lengthSq() < SLEEP * SLEEP) b.vel.set(0, 0, 0);
    }
  }

  /** Sphere against an axis-aligned box: push out along the shallowest axis. */
  private hitBox(b: Live, box: THREE.Box3, upAxis: number): void {
    const near = new THREE.Vector3(
      Math.max(box.min.x, Math.min(b.pos.x, box.max.x)),
      Math.max(box.min.y, Math.min(b.pos.y, box.max.y)),
      Math.max(box.min.z, Math.min(b.pos.z, box.max.z)),
    );
    const d = b.pos.clone().sub(near);
    const dist = d.length();
    if (dist >= b.radius) return;

    let n: THREE.Vector3;
    if (dist > 1e-6) {
      n = d.divideScalar(dist);
      b.pos.addScaledVector(n, b.radius - dist);
    } else {
      // dead centre inside the box — leave along the nearest face
      const axes: (keyof THREE.Vector3)[] = ['x', 'y', 'z'];
      let best = 0; let bestPen = Infinity; let sign = 1;
      for (let a = 0; a < 3; a++) {
        const k = axes[a] as 'x' | 'y' | 'z';
        const lo = b.pos[k] - box.min[k];
        const hi = box.max[k] - b.pos[k];
        const pen = Math.min(lo, hi);
        if (pen < bestPen) { bestPen = pen; best = a; sign = lo < hi ? -1 : 1; }
      }
      n = new THREE.Vector3();
      n.setComponent(best, sign);
      b.pos.addScaledVector(n, bestPen + b.radius);
    }

    const vn = b.vel.dot(n);
    if (vn < 0) {
      b.vel.addScaledVector(n, -(1 + b.mesh.body!.bounce) * vn);
      // ground friction only where the contact is actually holding it up
      if (n.getComponent(upAxis) > 0.5) {
        const keep = Math.max(0, 1 - b.mesh.body!.friction);
        const up = b.vel.getComponent(upAxis);
        b.vel.multiplyScalar(keep);
        b.vel.setComponent(upAxis, up);
      }
    }
  }

  private hitProp(a: Live, b: Live): void {
    const d = b.pos.clone().sub(a.pos);
    const dist = d.length();
    const sum = a.radius + b.radius;
    if (dist >= sum || dist < 1e-6) return;
    const n = d.divideScalar(dist);
    const push = sum - dist;
    const wA = a.invMass / (a.invMass + b.invMass || 1);
    const wB = 1 - wA;
    a.pos.addScaledVector(n, -push * wA);
    b.pos.addScaledVector(n, push * wB);
    const rel = b.vel.clone().sub(a.vel).dot(n);
    if (rel >= 0) return;
    const e = Math.min(a.mesh.body!.bounce, b.mesh.body!.bounce);
    const jImp = (-(1 + e) * rel) / (a.invMass + b.invMass || 1);
    a.vel.addScaledVector(n, -jImp * a.invMass);
    b.vel.addScaledVector(n, jImp * b.invMass);
  }

  /** A prop against one joint sphere — the whole of push, kick and bat. */
  private hitJoint(
    b: Live, jointPos: THREE.Vector3, jointVel: THREE.Vector3, jointR: number,
  ): void {
    const d = b.pos.clone().sub(jointPos);
    const dist = d.length();
    const sum = b.radius + jointR;
    if (dist >= sum || dist < 1e-6) return;
    const n = d.divideScalar(dist);
    b.pos.addScaledVector(n, sum - dist);
    // Only the part of the joint's motion heading INTO the prop counts, or
    // a foot brushing past would fling things it never really struck.
    const approach = jointVel.dot(n);
    const rel = b.vel.dot(n) - approach;
    if (rel < 0) {
      b.vel.addScaledVector(n, -(1 + b.mesh.body!.bounce) * rel);
    }
  }
}

export const propEngine = new PropEngine();

/** Default body for a loose prop of a given size. */
export function defaultBody(radius: number): NonNullable<TGMesh['body']> {
  return {
    // roughly mass ~ volume, so a big ball shrugs off what a small one does not
    mass: Math.max(0.3, 12 * radius * radius * radius),
    bounce: 0.42,
    friction: 0.06,
    vel: [0, 0, 0] as Vec3,
  };
}
