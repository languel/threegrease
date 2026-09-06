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
import type { TGActor } from '../core/types';
import { objectToScreen } from './projection';
import { actorMixer } from '../actor/mixer';
import { actorSolver } from '../actor/solver';
import { propEngine, propRadius } from '../actor/props';
import { worldMatrixOf } from '../tools/objects';

/** screen-space grab radius, px */
const GRAB_PX = 22;
/** a prop is grabbable anywhere over its own silhouette, but never from
 *  further than this — otherwise a big crate swallows the whole viewport */
const PROP_SLACK_PX = 10;

interface PropHit { meshId: number; world: THREE.Vector3; screenR: number; }

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
   * The loose prop under a screen point.
   *
   * Its own drawn size is the grab area (plus a little slack), not a fixed
   * radius: a beach ball you have to hit within 22 px of its centre feels
   * broken, and a marble you can grab from 22 px away steals clicks from
   * whatever is behind it.
   */
  private pickProp(ctx: AppCtx, x: number, y: number): PropHit | null {
    let best: PropHit | null = null;
    let bestD = Infinity;
    for (const m of ctx.scene.meshes) {
      if (!m.body || m.visible === false || m.lock) continue;
      const world = new THREE.Vector3()
        .setFromMatrixPosition(worldMatrixOf(ctx.scene, { kind: 'MESH', id: m.id }));
      const s0 = objectToScreen(ctx, [world.x, world.y, world.z]);
      // project the radius by measuring a point one radius to the camera's
      // right — the only way to get a screen size that survives perspective
      const right = new THREE.Vector3().setFromMatrixColumn(ctx.camera.matrixWorld, 0);
      const edge = world.clone().addScaledVector(right, propRadius(m));
      const s1 = objectToScreen(ctx, [edge.x, edge.y, edge.z]);
      const screenR = Math.hypot(s1.x - s0.x, s1.y - s0.y);
      const d = Math.hypot(s0.x - x, s0.y - y);
      if (d > screenR + PROP_SLACK_PX) continue;
      // nearest to the CENTRE wins, so overlapping props resolve the way
      // they look rather than by scene order
      if (d < bestD) { bestD = d; best = { meshId: m.id, world, screenR }; }
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
    // The prop's resting place is scene data, so the drag is undoable even
    // though the motion itself came out of the simulation.
    ctx.pushUndo();
    const normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.world);
    const at = new THREE.Vector3();
    this.ray(ctx, e).intersectPlane(plane, at);
    this.propGrab = { meshId: hit.meshId, plane, offset: hit.world.clone().sub(at) };
    this.propHover = hit;
    ctx.canvas.style.cursor = 'grabbing';
    propEngine.hold(hit.meshId, hit.world);
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (this.propGrab) {
      const at = new THREE.Vector3();
      if (this.ray(ctx, e).intersectPlane(this.propGrab.plane, at)) {
        at.add(this.propGrab.offset);
        propEngine.hold(this.propGrab.meshId, at);
      }
      ctx.requestRender();
      return;
    }
    this.hover = this.grab ? { actorId: this.grab.actorId, index: this.grab.index }
      : this.pick(ctx, e.x, e.y);
    this.propHover = this.hover ? null : this.pickProp(ctx, e.x, e.y);
    // A cursor that changes under the pointer is the cheapest way to say
    // "this one is grabbable" — the ring below says which one.
    ctx.canvas.style.cursor = (this.hover || this.propHover) ? 'grab' : 'default';
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
      propEngine.release(this.propGrab.meshId);
      this.propGrab = null;
      ctx.canvas.style.cursor = 'grab';
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

  onCancel(ctx: AppCtx): void { this.onUp(ctx, {} as ToolEvent); }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    const p = this.propHover;
    if (p) {
      // Re-measured every frame rather than cached: the prop is being
      // simulated, so where it was when you started hovering is not where
      // it is now — a stale ring reads as the highlight lagging the ball.
      const mesh = ctx.scene.meshes.find((m) => m.id === p.meshId);
      if (mesh) {
        const w = new THREE.Vector3()
          .setFromMatrixPosition(worldMatrixOf(ctx.scene, { kind: 'MESH', id: p.meshId }));
        const s = objectToScreen(ctx, [w.x, w.y, w.z]);
        const r = Math.max(12, p.screenR + 4);
        const held = !!this.propGrab;
        const tint = held ? '#ffc84d' : '#7fd4ff';
        hud.save();
        // Drawn twice: a dark casing under a bright line. The viewport is a
        // room, so a single thin stroke lands on pale floor as often as on
        // dark wall and disappears against one of them.
        hud.setLineDash(held ? [] : [5, 4]);
        hud.strokeStyle = 'rgba(0,0,0,0.55)';
        hud.lineWidth = held ? 4.5 : 4;
        hud.beginPath(); hud.arc(s.x, s.y, r, 0, Math.PI * 2); hud.stroke();
        hud.strokeStyle = tint;
        hud.lineWidth = held ? 2.2 : 1.8;
        hud.beginPath(); hud.arc(s.x, s.y, r, 0, Math.PI * 2); hud.stroke();
        hud.setLineDash([]);
        // a dot at the centre: the ring says WHERE, the dot says the grab
        // acts on the prop's origin, which is what the drag actually moves
        hud.fillStyle = tint;
        hud.beginPath(); hud.arc(s.x, s.y, held ? 3 : 2, 0, Math.PI * 2); hud.fill();
        hud.font = '11px system-ui, sans-serif';
        const label = `${mesh.name || 'prop'} · ${held ? 'release to throw' : 'drag / throw'}`;
        // A big prop's ring can be wider than the viewport, so the label has
        // to fall back to the inside edge rather than off the canvas.
        const tw = hud.measureText(label).width;
        const right = s.x + r + 6;
        const lx = right + tw < hud.canvas.width / (window.devicePixelRatio || 1)
          ? right
          : Math.max(4, Math.min(s.x - r - 6 - tw, s.x + 8));
        hud.lineWidth = 3;
        hud.strokeStyle = 'rgba(0,0,0,0.6)';
        hud.strokeText(label, lx, s.y + 4);
        hud.fillStyle = tint;
        hud.fillText(label, lx, s.y + 4);
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
