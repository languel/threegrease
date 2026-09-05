// Direct tool: click the world and tell a character to go there.
//
// The point of a click-to-command mode in an installation tool is not
// convenience — it is that the thing you are staging is a person moving
// through a space, and the fastest way to say "stand there, then cross to
// the plinth" is to point at the floor twice. Every command routes through
// the same scene state a typed or agent-issued one does
// (`actor/commands.ts`), so nothing about the character depends on which
// way you asked.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { Tool, ToolEvent } from './toolsys';
import { MOVE_ACTIONS, runMoveAction } from '../actor/commands';
import { raycastSurfaces } from './projection';

export class DirectTool implements Tool {
  id = 'direct';
  cursor = 'crosshair';
  /** last clicked point, drawn as a marker until the next click */
  private mark: { at: THREE.Vector3; t: number } | null = null;

  /** Which actor the commands apply to: the selected one, else the only
   *  one. Staging usually means one character at a time. */
  private targetActor(ctx: AppCtx): number | null {
    const sel = ctx.scene.actors.find((a) => a.select);
    return (sel ?? ctx.scene.actors[0])?.id ?? null;
  }

  /**
   * Where in the world the click landed. Scene geometry first, so clicking
   * a pedestal top means the top; otherwise the ground plane, so clicking
   * empty floor in a room with no floor mesh still works.
   */
  private worldAt(ctx: AppCtx, x: number, y: number): THREE.Vector3 | null {
    const hit = raycastSurfaces(ctx, x, y);
    if (hit) return hit;
    const upZ = ctx.settings.upAxis === 'Z';
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, ctx.camera);
    const plane = new THREE.Plane(
      new THREE.Vector3(0, upZ ? 0 : 1, upZ ? 1 : 0), 0);
    const out = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, out) ? out : null;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    // Disarmed is the DEFAULT and it is not a nicety: staging means looking
    // around the space at least as often as directing someone through it,
    // and a mode where every click sends the visitor somewhere makes the
    // scene hostile to inspect. Arm a verb in the HUD to command.
    if (!ctx.settings.directAction) return;
    const actorId = this.targetActor(ctx);
    if (actorId == null) { ctx.setStatus?.('Direct: no actor in the scene'); return; }
    const action = MOVE_ACTIONS.find((a) => a.id === ctx.settings.directAction)
      ?? MOVE_ACTIONS[0];
    const at = action.kind === 'STOP' ? null : this.worldAt(ctx, e.x, e.y);
    if (action.kind !== 'STOP' && !at) return;
    // Goals are RUNTIME intent, not document edits — no undo snapshot for
    // pointing at the floor, or a session of staging fills the undo stack
    // with places you asked someone to stand.
    const msg = runMoveAction(
      ctx.scene, actorId, action, at ? [at.x, at.y, at.z] : null,
      ctx.settings.upAxis === 'Z');
    if (at) this.mark = { at, t: performance.now() };
    if (msg) ctx.setStatus?.(msg);
    ctx.requestRender();
  }

  onKey(ctx: AppCtx, key: string): boolean {
    // Esc disarms rather than leaving the tool: you almost always want to
    // keep pointing at the scene, just not to command with the next click.
    if (key === 'Escape' && ctx.settings.directAction) {
      ctx.settings.directAction = '';
      ctx.refreshUI();
      ctx.setStatus('Direct: disarmed — clicks navigate');
      return true;
    }
    return false;
  }

  onMove(): void { /* commands fire on press */ }
  onUp(): void { /* nothing to finish */ }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    if (!this.mark) return;
    const age = (performance.now() - this.mark.t) / 900;
    if (age > 1) { this.mark = null; return; }
    const v = this.mark.at.clone().project(ctx.camera);
    const w = hud.canvas.width; const h = hud.canvas.height;
    const x = (v.x * 0.5 + 0.5) * w; const y = (-v.y * 0.5 + 0.5) * h;
    const r = 6 + age * 26;
    hud.save();
    hud.globalAlpha = 1 - age;
    hud.strokeStyle = '#7fd0ff';
    hud.lineWidth = 2;
    hud.beginPath();
    hud.arc(x, y, r, 0, Math.PI * 2);
    hud.stroke();
    hud.restore();
  }
}
