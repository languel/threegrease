import * as THREE from 'three';
import { activeObject, cloneStroke, frameAt, visibleEditableLayers, ensureFrame, activeLayer } from '../core/gpdata';
import { clamp, falloff, seededRandom } from '../core/mathutil';
import type { GPPoint, Vec3 } from '../core/types';
import type { AppCtx } from './context';
import { objectToScreen, objectToWorld, screenToWorld, worldToObject } from './projection';
import type { Tool, ToolEvent } from './toolsys';
import { drawBrushCircle } from './draw';

interface GrabState { p: GPPoint; orig: Vec3; weight: number }

/** All Blender GP sculpt brushes in one tool; brush picked from settings. */
export class SculptTool implements Tool {
  id = 'sculpt';
  cursor = 'none';
  private active = false;
  private last = new THREE.Vector2();
  private grab: GrabState[] = [];
  private grabStart = new THREE.Vector2();

  onDown(ctx: AppCtx, e: ToolEvent): void {
    ctx.pushUndo();
    this.active = true;
    this.last.set(e.x, e.y);
    const brush = ctx.settings.sculpt.brush;
    if (brush === 'GRAB') {
      this.grab = [];
      this.grabStart.set(e.x, e.y);
      const cursor = new THREE.Vector2(e.x, e.y);
      const { radius } = ctx.settings.sculpt;
      this.forPoints(ctx, cursor, radius, (p, w) => {
        this.grab.push({ p, orig: [...p.co] as Vec3, weight: w });
      });
    } else if (brush === 'CLONE') {
      this.pasteClone(ctx, e);
    } else {
      this.apply(ctx, e);
    }
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (!this.active) return;
    const brush = ctx.settings.sculpt.brush;
    if (brush === 'GRAB') this.applyGrab(ctx, e);
    else if (brush !== 'CLONE') this.apply(ctx, e);
    this.last.set(e.x, e.y);
  }

  onUp(): void { this.active = false; this.grab = []; }
  onCancel(): void { this.active = false; this.grab = []; }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    drawBrushCircle(hud, ctx.settings.sculpt.radius, [1, 0.5, 0.9]);
  }

  private forPoints(
    ctx: AppCtx, cursor: THREE.Vector2, radius: number,
    cb: (p: GPPoint, weightFalloff: number, strokePoints: GPPoint[], index: number) => void,
  ): void {
    const ob = activeObject(ctx.scene);
    for (const layer of visibleEditableLayers(ob)) {
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        s.points.forEach((p, i) => {
          const d = objectToScreen(ctx, p.co).distanceTo(cursor);
          const w = falloff(d, radius);
          if (w > 0) cb(p, w, s.points, i);
        });
      }
    }
  }

  private apply(ctx: AppCtx, e: ToolEvent): void {
    const { brush, radius, strength } = ctx.settings.sculpt;
    const press = (e.pressure || 0.7) * strength;
    const invert = e.ctrl ? -1 : 1;
    const cursor = new THREE.Vector2(e.x, e.y);
    const delta = new THREE.Vector2(e.x - this.last.x, e.y - this.last.y);
    const rnd = seededRandom();

    switch (brush) {
      case 'SMOOTH':
        this.forPoints(ctx, cursor, radius, (p, w, pts, i) => {
          if (i === 0 || i === pts.length - 1) return;
          const a = pts[i - 1].co, b = pts[i + 1].co;
          const f = w * press * 0.4;
          p.co = [
            p.co[0] + ((a[0] + b[0]) / 2 - p.co[0]) * f,
            p.co[1] + ((a[1] + b[1]) / 2 - p.co[1]) * f,
            p.co[2] + ((a[2] + b[2]) / 2 - p.co[2]) * f,
          ];
        });
        break;
      case 'THICKNESS':
        this.forPoints(ctx, cursor, radius, (p, w) => {
          p.pressure = Math.max(0.02, p.pressure + invert * w * press * 0.08);
        });
        break;
      case 'STRENGTH':
        this.forPoints(ctx, cursor, radius, (p, w) => {
          p.strength = clamp(p.strength + invert * w * press * 0.08, 0.02, 1);
        });
        break;
      case 'RANDOMIZE':
        this.forPoints(ctx, cursor, radius, (p, w) => {
          const amt = w * press * 0.01;
          p.co = [p.co[0] + (rnd() - 0.5) * amt, p.co[1] + (rnd() - 0.5) * amt, p.co[2] + (rnd() - 0.5) * amt];
        });
        break;
      case 'PUSH': {
        const moved = this.screenDeltaToLocal(ctx, cursor, delta);
        if (moved) {
          this.forPoints(ctx, cursor, radius, (p, w) => {
            const f = w * press;
            p.co = [p.co[0] + moved[0] * f, p.co[1] + moved[1] * f, p.co[2] + moved[2] * f];
          });
        }
        break;
      }
      case 'PINCH':
        this.forPoints(ctx, cursor, radius, (p, w) => {
          const px = objectToScreen(ctx, p.co);
          const toC = cursor.clone().sub(px).multiplyScalar(invert * w * press * 0.1);
          const moved = this.screenDeltaToLocal(ctx, px, toC);
          if (moved) p.co = [p.co[0] + moved[0], p.co[1] + moved[1], p.co[2] + moved[2]];
        });
        break;
      case 'TWIST': {
        const viewDir = ctx.camera.getWorldDirection(new THREE.Vector3());
        const rect = ctx.canvas.getBoundingClientRect();
        const centerWorld = screenToWorld(ctx, cursor.x + rect.left, cursor.y + rect.top);
        if (!centerWorld) break;
        const angle = invert * press * 0.05 * (delta.length() + 2);
        const q = new THREE.Quaternion().setFromAxisAngle(viewDir, angle);
        this.forPoints(ctx, cursor, radius, (p, w) => {
          const world = objectToWorld(ctx, p.co);
          const qw = new THREE.Quaternion().setFromAxisAngle(viewDir, angle * w);
          world.sub(centerWorld).applyQuaternion(qw).add(centerWorld);
          p.co = worldToObject(ctx, world);
        });
        void q;
        break;
      }
    }
    ctx.requestRender();
  }

  private applyGrab(ctx: AppCtx, e: ToolEvent): void {
    const delta = new THREE.Vector2(e.x - this.grabStart.x, e.y - this.grabStart.y);
    for (const g of this.grab) {
      const px = objectToScreen(ctx, g.orig);
      const moved = this.screenDeltaToLocal(ctx, px, delta.clone().multiplyScalar(g.weight));
      if (moved) g.p.co = [g.orig[0] + moved[0], g.orig[1] + moved[1], g.orig[2] + moved[2]];
    }
    ctx.requestRender();
  }

  /** Clone brush: paste the copy buffer centered at the cursor. */
  private pasteClone(ctx: AppCtx, e: ToolEvent): void {
    if (!ctx.copyBuffer.length) return;
    const ob = activeObject(ctx.scene);
    const layer = activeLayer(ob);
    if (!layer || layer.lock) return;
    const frame = ensureFrame(layer, ctx.scene.frame, ctx.settings.autoKey);
    // buffer median in screen space -> offset to cursor
    const med: Vec3 = [0, 0, 0];
    let n = 0;
    for (const s of ctx.copyBuffer) for (const p of s.points) {
      med[0] += p.co[0]; med[1] += p.co[1]; med[2] += p.co[2]; n++;
    }
    if (!n) return;
    med[0] /= n; med[1] /= n; med[2] /= n;
    const medScreen = objectToScreen(ctx, med);
    const moved = this.screenDeltaToLocal(
      ctx, medScreen, new THREE.Vector2(e.x - medScreen.x, e.y - medScreen.y),
    );
    if (!moved) return;
    for (const s of ctx.copyBuffer) {
      const copy = cloneStroke(s);
      for (const p of copy.points) {
        p.co = [p.co[0] + moved[0], p.co[1] + moved[1], p.co[2] + moved[2]];
      }
      frame.strokes.push(copy);
    }
    ctx.requestRender();
  }

  /** Convert a screen-space delta at a screen position into object-local movement on the view plane. */
  private screenDeltaToLocal(ctx: AppCtx, at: THREE.Vector2, delta: THREE.Vector2): Vec3 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const w0 = screenToWorld(ctx, at.x + rect.left, at.y + rect.top);
    const w1 = screenToWorld(ctx, at.x + delta.x + rect.left, at.y + delta.y + rect.top);
    if (!w0 || !w1) return null;
    const l0 = worldToObject(ctx, w0), l1 = worldToObject(ctx, w1);
    return [l1[0] - l0[0], l1[1] - l0[1], l1[2] - l0[2]];
  }
}
