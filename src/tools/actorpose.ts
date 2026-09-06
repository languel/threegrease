// Pose tool: grab a joint and drag it — or grab a loose prop and throw it.
//
// The two share this tool on purpose. Posing a character and staging the
// room are the same gesture ("put that there, and let the world argue with
// me about it"), and both are done by ASKING rather than by setting: a joint
// gets a solver target, a prop gets a velocity toward the cursor. Neither
// writes a position, so in both cases the physics still has the last word —
// the body follows through its bones, and the ball still hits the wall.
//
// The drag does NOT write the pose. It pushes a JointTarget into the solver
// every frame, exactly like a capture rig does, so the rest of the body
// follows through the bones instead of the grabbed joint tearing free. That
// is the whole reason targets exist as a concept: one door for capture,
// mouse and MIDI, and physics answers all three the same way.
//
// The joint moves in the plane through it that faces the camera, which is
// the only interpretation of a 2D drag that keeps the joint under the
// cursor from every viewing angle.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { Tool, ToolEvent } from './toolsys';
import type { TGActor, TGMesh } from '../core/types';
import { objectToScreen } from './projection';
import { actorMixer } from '../actor/mixer';
import { actorSolver } from '../actor/solver';
import { defaultBody, propRadius } from '../actor/props';
import { holdProp, releaseProp } from '../actor/physics';
import { meshLocalBounds, worldAABB } from './objectops';
import { worldMatrixOf } from '../tools/objects';

/** screen-space grab radius, px */
const GRAB_PX = 22;
/** a prop is grabbable anywhere over its own silhouette, plus this much
 *  slack, so a marble is not a pixel hunt */
const PROP_SLACK_PX = 10;
/** how big a STATIC mesh may be before Alt-drag stops offering to make it a
 *  loose prop. Dropping the floor into the simulation is not a feature. */
const STATIC_GRAB_MAX_R = 1.5;

/**
 * A prop's shape on screen.
 *
 * A SPHERE gets an exact circle. Nothing else can: every primitive's local
 * bounds are the same unit box (`meshLocalBounds`), so a tetrahedron's
 * "radius" is its box's, more than twice the silhouette it actually draws —
 * a circle there always looks like the highlight missed. Those get the
 * projected bounds RECTANGLE instead, which reads as bounds rather than as a
 * badly fitted ring, and is honest about being generous.
 */
interface Disc { x: number; y: number; r: number; rect?: { w: number; h: number } }

interface PropHit {
  meshId: number;
  world: THREE.Vector3;
  /** the prop's silhouette on screen: where to draw the ring, and the
   *  area the grab covers */
  disc: Disc;
  /** true when this mesh has no `body` yet — hoverable, but it takes a
   *  modifier to turn it into something the world can push around */
  static: boolean;
}

interface Grab {
  actorId: number;
  index: number;
  /** camera-facing plane through the joint at grab time */
  plane: THREE.Plane;
  /** where in the joint the cursor landed, so it does not jump on grab */
  offset: THREE.Vector3;
  /** joints we pinned for the duration of the drag, to restore on release */
  wasPinned: boolean;
}

export class ActorPoseTool implements Tool {
  id = 'actorpose';
  cursor = 'grab';
  private grab: Grab | null = null;
  /** hover feedback for the HUD */
  private hover: { actorId: number; index: number } | null = null;
  private propGrab: { meshId: number; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;
  private propHover: PropHit | null = null;

  /** World position of one joint (pose is actor-local). */
  private jointWorld(ctx: AppCtx, actor: TGActor, i: number): THREE.Vector3 {
    return new THREE.Vector3(...actor.pose[i])
      .applyMatrix4(worldMatrixOf(ctx.scene, { kind: 'ACTOR', id: actor.id }));
  }

  /** Nearest joint to a screen point, within GRAB_PX. */
  private pick(ctx: AppCtx, x: number, y: number): { actorId: number; index: number } | null {
    let best: { actorId: number; index: number } | null = null;
    let bestD = GRAB_PX * GRAB_PX;
    for (const actor of ctx.scene.actors) {
      if (!actor.visible || actor.lock) continue;
      for (let i = 0; i < actor.joints.length; i++) {
        const w = this.jointWorld(ctx, actor, i);
        const s = objectToScreen(ctx, [w.x, w.y, w.z]);
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < bestD) { bestD = d; best = { actorId: actor.id, index: i }; }
      }
    }
    return best;
  }

  /**
   * A sphere's SILHOUETTE on screen, which is not the projection of its
   * centre plus a projected radius.
   *
   * Under perspective a sphere off the view axis projects to an ellipse
   * whose centre sits further out than the projected centre, and the visible
   * radius is the TANGENT cone's, always larger than the distance to a point
   * one radius sideways. Measuring it the naive way puts the ring off-centre
   * and slightly small — visible as a highlight that does not sit on the
   * ball, and worse the closer and more off-axis it is. So take the real
   * tangent circle (radius R*sqrt(1-R^2/d^2), at distance d-R^2/d along the
   * eye ray) and project points around IT.
   */
  private screenDisc(ctx: AppCtx, world: THREE.Vector3, radius: number): Disc | null {
    const eye = new THREE.Vector3().setFromMatrixPosition(ctx.camera.matrixWorld);
    const axis = world.clone().sub(eye);
    const d = axis.length();
    // Standing inside a prop, or with one straddling the near plane, has no
    // silhouette to speak of: the projection blows up and a single ball
    // reports a 49,000 px disc that swallows every other pick on screen.
    // Nothing to grab is the honest answer.
    if (d <= radius * 1.2 || d < 1e-6) return null;
    axis.divideScalar(d);
    const k = 1 - (radius * radius) / (d * d);
    const centre = eye.clone().addScaledVector(axis, d * k);
    const r3 = radius * Math.sqrt(k);
    // any two directions perpendicular to the eye ray
    const u = new THREE.Vector3(0, 0, 1).cross(axis);
    if (u.lengthSq() < 1e-8) u.set(1, 0, 0).cross(axis);
    u.normalize();
    const v = axis.clone().cross(u).normalize();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const p = centre.clone()
        .addScaledVector(u, Math.cos(a) * r3)
        .addScaledVector(v, Math.sin(a) * r3);
      // objectToScreen has no opinion about points behind the eye, and a
      // projected one lands mirrored somewhere plausible — so test depth
      // here rather than trusting the screen coordinates.
      if (p.clone().applyMatrix4(ctx.camera.matrixWorldInverse).z > -1e-3) return null;
      const sp = objectToScreen(ctx, [p.x, p.y, p.z]);
      minX = Math.min(minX, sp.x); maxX = Math.max(maxX, sp.x);
      minY = Math.min(minY, sp.y); maxY = Math.max(maxY, sp.y);
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      r: Math.max(maxX - minX, maxY - minY) / 2,
    };
  }

  /** The prop's grab radius in world units: its own drawn bounding sphere. */
  private radiusOf(ctx: AppCtx, m: TGMesh): number {
    const local = meshLocalBounds(m);
    if (!local) return propRadius(m);
    const box = worldAABB(local, worldMatrixOf(ctx.scene, { kind: 'MESH', id: m.id }));
    const size = box.getSize(new THREE.Vector3());
    return Math.max(0.03, Math.max(size.x, size.y, size.z) * 0.5);
  }

  /**
   * The same disc for something that is NOT a sphere.
   *
   * A bounding sphere is the wrong ring for a crate or a tetrahedron: the
   * physics treats every prop as a sphere, but you are pointing at a SHAPE,
   * and a tetra's bounding sphere is more than twice its drawn silhouette
   * (33 px around a 15 px shape) — which looks like the highlight has missed
   * again. Projecting the eight corners of its box is nearly free and lands
   * close to what is actually on screen.
   */
  private boxDisc(ctx: AppCtx, m: TGMesh): Disc | null {
    const local = meshLocalBounds(m);
    if (!local) return null;
    const box = worldAABB(local, worldMatrixOf(ctx.scene, { kind: 'MESH', id: m.id }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      );
      if (p.clone().applyMatrix4(ctx.camera.matrixWorldInverse).z > -1e-3) return null;
      const sp = objectToScreen(ctx, [p.x, p.y, p.z]);
      minX = Math.min(minX, sp.x); maxX = Math.max(maxX, sp.x);
      minY = Math.min(minY, sp.y); maxY = Math.max(maxY, sp.y);
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      r: Math.max(6, Math.max(maxX - minX, maxY - minY) / 2),
      rect: { w: Math.max(12, maxX - minX), h: Math.max(12, maxY - minY) },
    };
  }

  /** The ring for one mesh: exact for a sphere, box-projected otherwise. */
  private discFor(ctx: AppCtx, m: TGMesh, world: THREE.Vector3): Disc | null {
    return m.kind === 'SPHERE'
      ? this.screenDisc(ctx, world, this.radiusOf(ctx, m))
      : this.boxDisc(ctx, m);
  }

  /**
   * The prop under a screen point.
   *
   * Its own drawn silhouette is the grab area, not a fixed radius: a beach
   * ball you have to hit within 22 px of its centre feels broken, and a
   * marble you can grab from 22 px away steals clicks from whatever is
   * behind it.
   *
   * Meshes with no `body` are picked too, and reported as `static`. They are
   * not draggable — but "why can I not grab that ball" is a question the
   * viewport should answer, and Alt turns one into a prop on the spot.
   */
  private pickProp(ctx: AppCtx, x: number, y: number): PropHit | null {
    let best: PropHit | null = null;
    let bestD = Infinity;
    for (const m of ctx.scene.meshes) {
      if (m.visible === false || m.lock) continue;
      const isStatic = !m.body;
      // A wall or a floor is not something to accidentally drop into the
      // simulation, so only bodies already made loose, and small enough
      // objects, are offered at all.
      if (isStatic && (m.kind === 'PLANE' || m.kind === 'EMPTY')) continue;
      const world = new THREE.Vector3()
        .setFromMatrixPosition(worldMatrixOf(ctx.scene, { kind: 'MESH', id: m.id }));
      if (isStatic && this.radiusOf(ctx, m) > STATIC_GRAB_MAX_R) continue;
      const disc = this.discFor(ctx, m, world);
      if (!disc) continue;
      const d = Math.hypot(disc.x - x, disc.y - y);
      if (disc.rect) {
        if (Math.abs(x - disc.x) > disc.rect.w / 2 + PROP_SLACK_PX
          || Math.abs(y - disc.y) > disc.rect.h / 2 + PROP_SLACK_PX) continue;
      } else if (d > disc.r + PROP_SLACK_PX) continue;
      // Live props win over static scenery at any distance, then nearest to
      // the centre — so overlapping props resolve the way they look rather
      // than by scene order.
      const rank = (isStatic ? 1e6 : 0) + d;
      if (rank < bestD) { bestD = rank; best = { meshId: m.id, world, disc, static: isStatic }; }
    }
    return best;
  }

  /** Ray from the cursor, in world space. */
  private ray(ctx: AppCtx, e: ToolEvent): THREE.Ray {
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, ctx.camera);
    return rc.ray;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    const hit = this.pick(ctx, e.x, e.y);
    // Joints win ties: they are small, precise and usually standing in front
    // of the very prop the character is about to kick.
    if (!hit) { this.downProp(ctx, e); return; }
    const actor = ctx.scene.actors.find((a) => a.id === hit.actorId);
    if (!actor) return;

    // Shift-click toggles a pin rather than dragging: pinning is the other
    // thing you constantly want while posing, and it needs no drag.
    if (e.shift) {
      ctx.pushUndo();
      actor.joints[hit.index].pin = !actor.joints[hit.index].pin;
      ctx.requestRender();
      return;
    }
    ctx.pushUndo();
    const world = this.jointWorld(ctx, actor, hit.index);
    const normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, world);
    const at = new THREE.Vector3();
    this.ray(ctx, e).intersectPlane(plane, at);
    this.grab = {
      actorId: actor.id, index: hit.index, plane,
      offset: world.clone().sub(at),
      wasPinned: actor.joints[hit.index].pin,
    };
    // A dragged joint is pinned for the duration: without it the bones pull
    // it back out from under the cursor and the drag feels like elastic.
    actor.joints[hit.index].pin = true;
    ctx.canvas.style.cursor = 'grabbing';
  }

  /** Grab a prop: same camera-facing plane a joint drag uses. */
  private downProp(ctx: AppCtx, e: ToolEvent): void {
    const hit = this.pickProp(ctx, e.x, e.y);
    if (!hit) return;
    const mesh = ctx.scene.meshes.find((m) => m.id === hit.meshId);
    if (!mesh) return;
    // The prop's resting place is scene data, so the drag is undoable even
    // though the motion itself came out of the simulation.
    ctx.pushUndo();
    if (hit.static) {
      // Shift says "make this one loose and grab it now". Without a modifier
      // the answer to a static mesh is nothing at all: quietly dropping the
      // scenery into the simulation on a stray click is how a gallery ends
      // up on the floor. NOT Alt — Alt+LMB is the trackpad orbit
      // (`emulate3Button`, on by default) and never reaches a tool. Shift is
      // free here: on a JOINT it toggles a pin, and a joint is picked first,
      // so the two never contend for the same click.
      if (!e.shift) return;
      mesh.body = defaultBody(this.radiusOf(ctx, mesh));
      hit.static = false;
      // the Physics rows in the properties panel now apply to it
      ctx.refreshUI();
    }
    const normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.world);
    const at = new THREE.Vector3();
    this.ray(ctx, e).intersectPlane(plane, at);
    this.propGrab = { meshId: hit.meshId, plane, offset: hit.world.clone().sub(at) };
    this.propHover = hit;
    ctx.canvas.style.cursor = 'grabbing';
    this.paintHighlight(ctx);
    holdProp(ctx.scene, hit.meshId, hit.world);
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (this.propGrab) {
      const at = new THREE.Vector3();
      if (this.ray(ctx, e).intersectPlane(this.propGrab.plane, at)) {
        at.add(this.propGrab.offset);
        holdProp(ctx.scene, this.propGrab.meshId, at);
      }
      ctx.requestRender();
      return;
    }
    this.hover = this.grab ? { actorId: this.grab.actorId, index: this.grab.index }
      : this.pick(ctx, e.x, e.y);
    this.propHover = this.hover ? null : this.pickProp(ctx, e.x, e.y);
    // A cursor that changes under the pointer is the cheapest way to say
    // "this one is grabbable" — the ring below says which one.
    ctx.canvas.style.cursor =
      (this.hover || (this.propHover && !this.propHover.static)) ? 'grab' : 'default';
    this.paintHighlight(ctx);
    if (!this.grab) return;
    const actor = ctx.scene.actors.find((a) => a.id === this.grab!.actorId);
    if (!actor) return;
    const at = new THREE.Vector3();
    if (!this.ray(ctx, e).intersectPlane(this.grab.plane, at)) return;
    at.add(this.grab.offset);
    // back to actor-local, which is the space the solver works in
    at.applyMatrix4(worldMatrixOf(ctx.scene, { kind: 'ACTOR', id: actor.id }).invert());
    // MANUAL is a mixer layer like any other, so a stack can hold a hand
    // drag under a running clip instead of it always winning outright.
    const w = actorMixer.gain(actor, 'MANUAL', actor.joints[this.grab.index]?.name ?? '');
    if (w > 0.001) {
      actorSolver.addTarget(actor.id, {
        index: this.grab.index, pos: [at.x, at.y, at.z], weight: w,
      });
    }
    ctx.requestRender();
  }

  onUp(ctx: AppCtx, _e: ToolEvent): void {
    if (this.propGrab) {
      // Letting go just stops steering it: the chase velocity IS the throw,
      // and gravity resumes on the next step.
      releaseProp(ctx.scene, this.propGrab.meshId);
      this.propGrab = null;
      ctx.canvas.style.cursor = 'grab';
      this.paintHighlight(ctx);
      ctx.requestRender();
      return;
    }
    if (!this.grab) return;
    const actor = ctx.scene.actors.find((a) => a.id === this.grab!.actorId);
    // Let go and the joint keeps whatever the drag gave it — unless it was
    // pinned before the drag, in which case it stays pinned.
    if (actor) actor.joints[this.grab.index].pin = this.grab.wasPinned;
    this.grab = null;
    ctx.canvas.style.cursor = 'grab';
    ctx.requestRender();
  }

  onCancel(ctx: AppCtx): void {
    this.onUp(ctx, {} as ToolEvent);
    this.propHover = null;
    ctx.highlightObject(null);
  }

  /** Amber while you hold it, blue when it can be grabbed, grey when it has
   *  no physics and Shift would be needed. */
  private paintHighlight(ctx: AppCtx): void {
    const p = this.propHover;
    ctx.highlightObject(
      p ? { kind: 'MESH', id: p.meshId } : null,
      this.propGrab ? '#ffc84d' : p?.static ? '#9aa4ad' : '#7fd4ff',
    );
  }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    const p = this.propHover;
    if (p) {
      // The RING is gone: the silhouette is drawn in 3D around the real
      // geometry (see MeshManager.setHover), which is the one marker that
      // cannot disagree with the shape it is marking. What is left here is
      // the part a silhouette cannot say — the object's name and what the
      // drag will do.
      const mesh = ctx.scene.meshes.find((m) => m.id === p.meshId);
      if (mesh) {
        const w = new THREE.Vector3()
          .setFromMatrixPosition(worldMatrixOf(ctx.scene, { kind: 'MESH', id: p.meshId }));
        const at = objectToScreen(ctx, [w.x, w.y, w.z]);
        const disc = this.discFor(ctx, mesh, w) ?? p.disc;
        const held = !!this.propGrab;
        const tint = held ? '#ffc84d' : p.static ? '#9aa4ad' : '#7fd4ff';
        const label = `${mesh.name || 'prop'} · ${
          held ? 'release to throw'
            : p.static ? 'no physics — Shift-drag to make it a prop'
              : 'drag / throw'}`;
        hud.save();
        hud.font = '11px system-ui, sans-serif';
        const tw = hud.measureText(label).width;
        const half = (disc.rect ? disc.rect.w / 2 : disc.r) + 8;
        const wide = hud.canvas.width / (window.devicePixelRatio || 1);
        const lx = at.x + half + tw < wide ? at.x + half : Math.max(4, at.x - half - tw);
        const ly = disc.rect ? at.y - disc.rect.h / 2 - 6 : at.y - disc.r - 6;
        hud.lineWidth = 3;
        hud.strokeStyle = 'rgba(0,0,0,0.6)';
        hud.strokeText(label, lx, ly);
        hud.fillStyle = tint;
        hud.fillText(label, lx, ly);
        hud.restore();
      }
    }
    const h = this.hover;
    if (!h) return;
    const actor = ctx.scene.actors.find((a) => a.id === h.actorId);
    if (!actor) return;
    const w = this.jointWorld(ctx, actor, h.index);
    const s = objectToScreen(ctx, [w.x, w.y, w.z]);
    hud.save();
    hud.strokeStyle = this.grab ? '#ffc84d' : '#ffffff';
    hud.lineWidth = 1.5;
    hud.beginPath();
    hud.arc(s.x, s.y, 10, 0, Math.PI * 2);
    hud.stroke();
    hud.fillStyle = 'rgba(255,255,255,0.75)';
    hud.font = '11px system-ui, sans-serif';
    hud.fillText(actor.joints[h.index].name + (actor.joints[h.index].pin ? ' · pinned' : ''),
      s.x + 14, s.y + 4);
    hud.restore();
  }
}
