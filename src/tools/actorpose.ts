// Actor Pose tool: grab a joint and drag it.
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
import { actorSolver } from '../actor/solver';
import { worldMatrixOf } from '../tools/objects';

/** screen-space grab radius, px */
const GRAB_PX = 22;

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
    if (!hit) return;
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
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    this.hover = this.grab ? { actorId: this.grab.actorId, index: this.grab.index }
      : this.pick(ctx, e.x, e.y);
    if (!this.grab) return;
    const actor = ctx.scene.actors.find((a) => a.id === this.grab!.actorId);
    if (!actor) return;
    const at = new THREE.Vector3();
    if (!this.ray(ctx, e).intersectPlane(this.grab.plane, at)) return;
    at.add(this.grab.offset);
    // back to actor-local, which is the space the solver works in
    at.applyMatrix4(worldMatrixOf(ctx.scene, { kind: 'ACTOR', id: actor.id }).invert());
    actorSolver.addTarget(actor.id, {
      index: this.grab.index, pos: [at.x, at.y, at.z], weight: 1,
    });
    ctx.requestRender();
  }

  onUp(ctx: AppCtx, _e: ToolEvent): void {
    if (!this.grab) return;
    const actor = ctx.scene.actors.find((a) => a.id === this.grab!.actorId);
    // Let go and the joint keeps whatever the drag gave it — unless it was
    // pinned before the drag, in which case it stays pinned.
    if (actor) actor.joints[this.grab.index].pin = this.grab.wasPinned;
    this.grab = null;
    ctx.requestRender();
  }

  onCancel(ctx: AppCtx): void { this.onUp(ctx, {} as ToolEvent); }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
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
