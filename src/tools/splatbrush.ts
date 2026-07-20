// Splat Paint (3DGS painting): a DRAW-toolbar brush that deposits soft
// gaussian splats along the pointer path into a TGPaintCloud. Placement
// follows the SAME projection rules as the pencil (screenToWorld:
// Origin/Cursor/Surface/Surface ⊥/Stroke placement + drawing plane), so
// you can paint splats in free space, onto surfaces, or standing off a
// reference. Brush mappings: Size = stamp diameter in px (converted to a
// world radius at the deposit depth), Strength = splat alpha, vertex
// color = splat color, style.spacing = stamp interval, style.jitter =
// positional scatter. Ctrl+drag ERASES splats under the brush. One undo
// step per stroke (pushUndo at stroke start).
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { TGPaintCloud } from '../core/types';
import type { Tool, ToolEvent } from './toolsys';
import { screenToWorld } from './projection';
import { worldMatrixOf, deselectAllObjects } from './objects';
import { createPaintCloud, PAINT_STRIDE } from '../render/paintclouds';

export class SplatPaintTool implements Tool {
  id = 'splatpaint';
  cursor = 'crosshair';
  private painting = false;
  private erasing = false;
  private lastPx: THREE.Vector2 | null = null;

  /** Selected cloud, else first, else a fresh one at the 3D cursor.
   *  Creation joins the stroke's undo step (pushUndo happens first). */
  private targetCloud(ctx: AppCtx): TGPaintCloud {
    let pc = ctx.scene.paintClouds.find((c) => c.select && !c.lock)
      ?? ctx.scene.paintClouds.find((c) => !c.lock);
    if (!pc) {
      pc = createPaintCloud(Date.now() % 1e9, `Splats ${ctx.scene.paintClouds.length + 1}`, [...ctx.scene.cursor]);
      ctx.scene.paintClouds.push(pc);
      deselectAllObjects(ctx.scene);
      pc.select = true;
      ctx.refreshUI();
    }
    return pc;
  }

  /** px -> world size at a given world point (persp and ortho). */
  private worldPerPixel(ctx: AppCtx, at: THREE.Vector3): number {
    const rect = ctx.canvas.getBoundingClientRect();
    const cam = ctx.camera as THREE.PerspectiveCamera & THREE.OrthographicCamera;
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const dist = at.distanceTo(cam.getWorldPosition(new THREE.Vector3()));
      return (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / rect.height;
    }
    return (cam.top - cam.bottom) / (cam.zoom || 1) / rect.height;
  }

  private deposit(ctx: AppCtx, e: ToolEvent): void {
    const world = screenToWorld(ctx, e.clientX, e.clientY);
    if (!world) return;
    const pc = this.targetCloud(ctx);
    const b = ctx.settings.brush;
    const radius = Math.max(1e-4, (b.size / 2) * this.worldPerPixel(ctx, world));
    const jitter = (b.style.jitter ?? 0) * radius * 2;
    const p = world.clone();
    if (jitter > 0) {
      p.x += (Math.random() - 0.5) * jitter;
      p.y += (Math.random() - 0.5) * jitter;
      p.z += (Math.random() - 0.5) * jitter;
    }
    const inv = worldMatrixOf(ctx.scene, { kind: 'PCLOUD', id: pc.id }).invert();
    p.applyMatrix4(inv);
    const [r, g, bl] = b.vertexColor;
    pc.points.push(p.x, p.y, p.z, radius, r, g, bl, Math.max(0.02, b.strength));
    pc.rev = (pc.rev + 1) % 1e9;
  }

  /** Ctrl+drag: delete splats whose projection falls under the brush. */
  private erase(ctx: AppCtx, e: ToolEvent): void {
    const rect = ctx.canvas.getBoundingClientRect();
    const rad = Math.max(4, ctx.settings.brush.size / 2);
    let touched = false;
    for (const pc of ctx.scene.paintClouds) {
      if (pc.lock || !pc.visible || !pc.points.length) continue;
      const world = worldMatrixOf(ctx.scene, { kind: 'PCLOUD', id: pc.id });
      const keep: number[] = [];
      const v = new THREE.Vector3();
      for (let o = 0; o < pc.points.length; o += PAINT_STRIDE) {
        v.set(pc.points[o], pc.points[o + 1], pc.points[o + 2]).applyMatrix4(world).project(ctx.camera);
        const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
        if (v.z <= 1 && Math.hypot(sx - e.x, sy - e.y) < rad) { touched = true; continue; }
        for (let k = 0; k < PAINT_STRIDE; k++) keep.push(pc.points[o + k]);
      }
      if (keep.length !== pc.points.length) {
        pc.points = keep;
        pc.rev = (pc.rev + 1) % 1e9;
      }
    }
    void touched;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    ctx.pushUndo(); // one undo step per stroke (paint or erase)
    this.painting = true;
    this.erasing = e.ctrl;
    this.lastPx = new THREE.Vector2(e.x, e.y);
    if (this.erasing) this.erase(ctx, e);
    else this.deposit(ctx, e);
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (!this.painting) return;
    if (this.erasing) { this.erase(ctx, e); return; }
    const b = ctx.settings.brush;
    const spacingPx = Math.max(2, b.size * (b.style.spacing || 0.12));
    if (this.lastPx && Math.hypot(e.x - this.lastPx.x, e.y - this.lastPx.y) < spacingPx) return;
    this.lastPx = new THREE.Vector2(e.x, e.y);
    this.deposit(ctx, e);
  }

  onUp(ctx: AppCtx): void {
    this.painting = false;
    this.lastPx = null;
    ctx.refreshUI(); // splat count in the outliner
  }

  onCancel(): void {
    this.painting = false;
    this.lastPx = null;
  }
}
