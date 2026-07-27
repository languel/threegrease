import * as THREE from 'three';
import { activeObject, frameAt, visibleEditableLayers } from '../core/gpdata';
import { clamp, falloff } from '../core/mathutil';
import type { GPPoint, Vec4 } from '../core/types';
import type { AppCtx } from './context';
import { objectToScreen } from './projection';
import type { Tool, ToolEvent } from './toolsys';
import { drawBrushCircle, mixVertexColor } from './draw';
import { stencilMask } from './stencil';

/** Vertex-paint mode brushes: Draw / Blur / Average / Smear. */
export class VertexPaintTool implements Tool {
  id = 'vertexpaint';
  cursor = 'none';
  private active = false;
  private last = new THREE.Vector2();
  private smearColor: Vec4 | null = null;

  onDown(ctx: AppCtx, e: ToolEvent): void {
    ctx.pushUndo();
    this.active = true;
    this.last.set(e.x, e.y);
    this.smearColor = null;
    stencilMask.begin(ctx); // one mask build per stroke
    this.apply(ctx, e);
  }
  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (this.active) { this.apply(ctx, e); this.last.set(e.x, e.y); }
  }
  onUp(): void { this.active = false; }
  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    stencilMask.drawHud(ctx, hud);
    drawBrushCircle(hud, ctx.settings.paint.radius, ctx.settings.brush.vertexColor);
  }

  private forPoints(
    ctx: AppCtx, cursor: THREE.Vector2, radius: number,
    cb: (p: GPPoint, w: number, pts: GPPoint[], i: number) => void,
  ): void {
    const ob = activeObject(ctx.scene);
    for (const layer of visibleEditableLayers(ob)) {
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        s.points.forEach((p, i) => {
          const at = objectToScreen(ctx, p.co);
          // stencil scales the brush weight per POINT (each is already
          // projected to screen here, which is exactly where the mask lives)
          const w = falloff(at.distanceTo(cursor), radius) * stencilMask.maskAt(ctx, at.x, at.y);
          if (w > 0) cb(p, w, s.points, i);
        });
      }
    }
  }

  private apply(ctx: AppCtx, e: ToolEvent): void {
    const { brush, radius, strength } = ctx.settings.paint;
    const color = ctx.settings.brush.vertexColor;
    const press = (e.pressure || 0.7) * strength;
    const cursor = new THREE.Vector2(e.x, e.y);

    if (brush === 'DRAW') {
      this.forPoints(ctx, cursor, radius, (p, w) => mixVertexColor(p.vertexColor, color, w * press * 0.35));
    } else if (brush === 'BLUR') {
      this.forPoints(ctx, cursor, radius, (p, w, pts, i) => {
        const a = pts[Math.max(0, i - 1)].vertexColor;
        const b = pts[Math.min(pts.length - 1, i + 1)].vertexColor;
        const f = w * press * 0.4;
        for (let k = 0; k < 4; k++) p.vertexColor[k] += ((a[k] + b[k]) / 2 - p.vertexColor[k]) * f;
      });
    } else if (brush === 'AVERAGE') {
      const acc: Vec4 = [0, 0, 0, 0];
      let n = 0;
      this.forPoints(ctx, cursor, radius, (p) => {
        if (p.vertexColor[3] > 0) { for (let k = 0; k < 4; k++) acc[k] += p.vertexColor[k]; n++; }
      });
      if (n > 0) {
        const avg = acc.map((v) => v / n) as Vec4;
        this.forPoints(ctx, cursor, radius, (p, w) => mixVertexColor(p.vertexColor, avg, w * press * 0.35));
      }
    } else if (brush === 'SMEAR') {
      // pick up color at the previous position, drag it forward
      if (!this.smearColor) {
        let best: { d: number; c: Vec4 } | null = null;
        this.forPoints(ctx, this.last, radius, (p) => {
          const d = objectToScreen(ctx, p.co).distanceTo(this.last);
          if ((!best || d < best.d) && p.vertexColor[3] > 0) best = { d, c: [...p.vertexColor] as Vec4 };
        });
        this.smearColor = best ? (best as { d: number; c: Vec4 }).c : null;
      }
      if (this.smearColor) {
        const sc = this.smearColor;
        this.forPoints(ctx, cursor, radius, (p, w) => mixVertexColor(p.vertexColor, sc, w * press * 0.3));
      }
    }
    ctx.requestRender();
  }
}

/** Weight-paint mode: paints the single "softness" vertex group. */
export class WeightPaintTool implements Tool {
  id = 'weightpaint';
  cursor = 'none';
  private active = false;

  onDown(ctx: AppCtx, e: ToolEvent): void {
    ctx.pushUndo();
    this.active = true;
    stencilMask.begin(ctx);
    this.apply(ctx, e);
  }
  onMove(ctx: AppCtx, e: ToolEvent): void { if (this.active) this.apply(ctx, e); }
  onUp(): void { this.active = false; }
  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    stencilMask.drawHud(ctx, hud);
    drawBrushCircle(hud, ctx.settings.weight.radius, [0.3, 0.6, 1]);
  }

  private apply(ctx: AppCtx, e: ToolEvent): void {
    const { radius, strength, target } = ctx.settings.weight;
    const press = (e.pressure || 0.7) * strength;
    const cursor = new THREE.Vector2(e.x, e.y);
    const goal = e.ctrl ? 0 : target;
    const ob = activeObject(ctx.scene);
    for (const layer of visibleEditableLayers(ob)) {
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        for (const p of s.points) {
          const at = objectToScreen(ctx, p.co);
          const w = falloff(at.distanceTo(cursor), radius) * stencilMask.maskAt(ctx, at.x, at.y);
          if (w > 0) p.weight = clamp(p.weight + (goal - p.weight) * w * press * 0.3, 0, 1);
        }
      }
    }
    ctx.requestRender();
  }
}
