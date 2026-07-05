import * as THREE from 'three';
import {
  activeLayer, activeObject, createPoint, createStroke, ensureFrame, frameAt,
} from '../core/gpdata';
import { rdpIndices } from '../core/mathutil';
import type { Vec3 } from '../core/types';
import type { AppCtx } from './context';
import { objectToScreen, screenToWorld, worldToObject } from './projection';
import type { Tool, ToolEvent } from './toolsys';

/**
 * Bucket fill, Blender-style: rasterize visible strokes to an offscreen mask,
 * flood fill from the click, trace the region boundary, project it back onto
 * the drawing plane as a new cyclic stroke with the active (fill) material.
 */
export class FillTool implements Tool {
  id = 'fill';
  cursor = 'crosshair';

  onDown(ctx: AppCtx, e: ToolEvent): void {
    const rect = ctx.canvas.getBoundingClientRect();
    const scale = ctx.settings.fill.scale * 0.5; // raster at half res for speed
    const W = Math.max(64, Math.round(rect.width * scale));
    const H = Math.max(64, Math.round(rect.height * scale));

    // 1. rasterize boundary strokes
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
    c2d.fillStyle = '#fff';
    c2d.fillRect(0, 0, W, H);
    c2d.strokeStyle = '#000';
    c2d.fillStyle = '#000';
    c2d.lineCap = 'round';
    c2d.lineJoin = 'round';
    const ob = activeObject(ctx.scene);
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        if (s.points.length < 2) continue;
        const pts = s.points.map((p) => objectToScreen(ctx, p.co).multiplyScalar(scale));
        c2d.lineWidth = Math.max(1.5, s.lineWidth * scale);
        c2d.beginPath();
        c2d.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) c2d.lineTo(p.x, p.y);
        if (s.cyclic) c2d.closePath();
        c2d.stroke();
      }
    }

    // 2. flood fill
    const img = c2d.getImageData(0, 0, W, H);
    const isOpen = (x: number, y: number) => img.data[(y * W + x) * 4] > 128;
    const sx = Math.round(e.x * scale), sy = Math.round(e.y * scale);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H || !isOpen(sx, sy)) return;
    const filled = new Uint8Array(W * H);
    const stack = [sy * W + sx];
    filled[sy * W + sx] = 1;
    let leaked = false;
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % W, y = (idx / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { leaked = true; break; }
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        const nidx = ny * W + nx;
        if (!filled[nidx] && isOpen(nx, ny)) { filled[nidx] = 1; stack.push(nidx); }
      }
    }
    if (leaked) return; // unclosed region — Blender shows "fill failed"

    // 3. trace boundary: march along filled/unfilled edges (square tracing)
    const contour = traceContour(filled, W, H, sx, sy);
    if (contour.length < 3) return;

    // 4. simplify + unproject
    const simpleIdx = rdpIndices(contour.map((p) => [p[0], p[1], 0] as Vec3), ctx.settings.fill.simplify);
    const layer = activeLayer(ob);
    if (!layer || layer.lock) return;
    ctx.pushUndo();
    const frame = ensureFrame(layer, ctx.scene.frame, ctx.settings.autoKey);
    const stroke = createStroke(ob.activeMaterial, 1);
    stroke.cyclic = true;
    for (const i of simpleIdx) {
      const [px, py] = contour[i];
      const world = screenToWorld(ctx, px / scale + rect.left, py / scale + rect.top);
      if (world) stroke.points.push(createPoint(worldToObject(ctx, world)));
    }
    if (stroke.points.length >= 3) {
      // fills draw *behind* lines in Blender: insert at start
      frame.strokes.unshift(stroke);
      ctx.requestRender();
      ctx.refreshUI();
    }
  }
  onMove(): void {}
  onUp(): void {}
}

/** Marching-squares boundary walk around the filled region. */
function traceContour(filled: Uint8Array, W: number, H: number, sx: number, sy: number): [number, number][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && filled[y * W + x] === 1;
  // topmost filled pixel above the seed -> guaranteed boundary start cell
  let startX = sx, startY = sy;
  while (startY > 0 && at(startX, startY - 1)) startY--;
  let x = startX, y = startY;
  let pdx = 0, pdy = 0;
  const contour: [number, number][] = [];
  const maxSteps = 4 * (W * H);
  for (let i = 0; i < maxSteps; i++) {
    // cell state from the 4 pixels around corner (x, y)
    const state =
      (at(x - 1, y - 1) ? 1 : 0) | (at(x, y - 1) ? 2 : 0) |
      (at(x - 1, y) ? 4 : 0) | (at(x, y) ? 8 : 0);
    let dx = 0, dy = 0;
    switch (state) {
      case 1: case 5: case 13: dy = -1; break;
      case 2: case 3: case 7: dx = 1; break;
      case 4: case 12: case 14: dx = -1; break;
      case 8: case 10: case 11: dy = 1; break;
      case 6: dx = pdy === -1 ? -1 : 1; break;  // saddle
      case 9: dy = pdx === 1 ? -1 : 1; break;   // saddle
      default: return contour;                   // 0 or 15: done/degenerate
    }
    contour.push([x, y]);
    x += dx; y += dy; pdx = dx; pdy = dy;
    if (x === startX && y === startY) break;
  }
  return contour;
}
