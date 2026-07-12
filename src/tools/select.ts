import * as THREE from 'three';
import type { GPFrame, GPLayer, GPStroke } from '../core/types';
import { activeObject, frameAt, visibleEditableLayers } from '../core/gpdata';
import type { AppCtx } from './context';
import { objectToScreen, pickCanvas } from './projection';
import type { Tool, ToolEvent } from './toolsys';
import { drawLasso, pointInPolygon } from './draw';

/** Frames affected by edit operations (multiframe editing). */
export function editableFrames(ctx: AppCtx, layer: GPLayer): GPFrame[] {
  const cur = frameAt(layer, ctx.scene.frame);
  if (!ctx.settings.multiframe) return cur ? [cur] : [];
  const out = layer.frames.filter((f) => f.select || f === cur);
  return out.length ? out : cur ? [cur] : [];
}

export function forEachEditableStroke(
  ctx: AppCtx, cb: (s: GPStroke, layer: GPLayer, frame: GPFrame) => void,
): void {
  const ob = activeObject(ctx.scene);
  for (const layer of visibleEditableLayers(ob)) {
    for (const frame of editableFrames(ctx, layer)) {
      for (const s of [...frame.strokes]) cb(s, layer, frame);
    }
  }
}

export function selectedPoints(ctx: AppCtx): { s: GPStroke; index: number }[] {
  const out: { s: GPStroke; index: number }[] = [];
  forEachEditableStroke(ctx, (s) => {
    s.points.forEach((p, i) => {
      if (p.select || (ctx.settings.selectMode === 'STROKE' && s.select)) out.push({ s, index: i });
    });
  });
  return out;
}

export function deselectAll(ctx: AppCtx): void {
  forEachEditableStroke(ctx, (s) => {
    s.select = false;
    for (const p of s.points) p.select = false;
  });
  let hadCanvas = false;
  for (const c of ctx.scene.canvases) {
    if (c.select) hadCanvas = true;
    c.select = false;
  }
  if (hadCanvas) ctx.syncCanvases();
}

export function selectAll(ctx: AppCtx, action: 'all' | 'none' | 'invert'): void {
  forEachEditableStroke(ctx, (s) => {
    if (action === 'invert') {
      for (const p of s.points) p.select = !p.select;
      s.select = s.points.some((p) => p.select);
    } else {
      const v = action === 'all';
      s.select = v;
      for (const p of s.points) p.select = v;
    }
  });
}

export function selectLinked(ctx: AppCtx): void {
  forEachEditableStroke(ctx, (s) => {
    if (s.points.some((p) => p.select)) {
      s.select = true;
      for (const p of s.points) p.select = true;
    }
  });
}

/**
 * Select strokes CONNECTED to the current selection: flood over strokes
 * whose endpoints touch (within `tol`, object space) an endpoint of an
 * already-selected stroke — chains like wire-art pieces select as one.
 */
export function selectConnected(ctx: AppCtx, tol = 0.05): void {
  const tol2 = tol * tol;
  const d2 = (a: number[], b: number[]) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const ends = (s: GPStroke) => s.cyclic || s.points.length < 2
    ? s.points.map((p) => p.co)                     // cyclic: every point can connect
    : [s.points[0].co, s.points[s.points.length - 1].co];

  // per frame: flood the endpoint-proximity graph
  const frames = new Map<GPFrame, GPStroke[]>();
  forEachEditableStroke(ctx, (s, _l, f) => {
    const arr = frames.get(f) ?? [];
    arr.push(s);
    frames.set(f, arr);
  });
  for (const strokes of frames.values()) {
    const selected = new Set(strokes.filter((s) => s.select || s.points.some((p) => p.select)));
    if (!selected.size) continue;
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of strokes) {
        if (selected.has(s)) continue;
        const se = ends(s);
        for (const t of selected) {
          const te = ends(t);
          if (se.some((a) => te.some((b) => d2(a, b) < tol2))) {
            selected.add(s);
            grew = true;
            break;
          }
        }
      }
    }
    for (const s of selected) {
      s.select = true;
      for (const p of s.points) p.select = true;
    }
  }
}

export function selectMoreLess(ctx: AppCtx, more: boolean): void {
  forEachEditableStroke(ctx, (s) => {
    const sel = s.points.map((p) => p.select);
    s.points.forEach((p, i) => {
      const nb = (i > 0 && sel[i - 1]) || (i < sel.length - 1 && sel[i + 1]);
      if (more && !sel[i] && nb) p.select = true;
      if (!more && sel[i] && !((i === 0 || sel[i - 1]) && (i === sel.length - 1 || sel[i + 1]))) p.select = false;
    });
    s.select = s.points.some((p) => p.select);
  });
}

export type SelectKind = 'BOX' | 'LASSO' | 'CIRCLE';

/**
 * Select tool family (Blender-style): click picks the nearest point/stroke
 * or canvas plane (Shift extends). Drag behavior depends on the variant:
 * box, lasso, or circle brush. The box variant keeps Ctrl-drag = lasso and
 * C = toggle circle mode as shortcuts.
 */
export class SelectTool implements Tool {
  id: string;
  cursor = 'default';
  private kind: SelectKind;
  private mode: 'none' | 'box' | 'lasso' | 'circle' = 'none';
  private start = new THREE.Vector2();
  private lasso: THREE.Vector2[] = [];
  private circleMode = false;
  private circleRadius = 40;
  private extend = false;
  private dragged = false;

  constructor(id = 'select', kind: SelectKind = 'BOX') {
    this.id = id;
    this.kind = kind;
    this.circleMode = kind === 'CIRCLE';
  }

  onKey(ctx: AppCtx, key: string): boolean {
    if (this.kind === 'BOX' && (key === 'c' || key === 'C')) {
      this.circleMode = !this.circleMode;
      return true;
    }
    if (this.circleMode && (key === '[' || key === ']')) {
      this.circleRadius = Math.max(8, this.circleRadius + (key === ']' ? 8 : -8));
      return true;
    }
    return false;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    this.start.set(e.x, e.y);
    this.extend = e.shift;
    this.dragged = false;
    if (this.circleMode) {
      this.mode = 'circle';
      ctx.pushUndo();
      this.circleSelect(ctx, e);
    } else if (this.kind === 'LASSO' || e.ctrl) {
      this.mode = 'lasso';
      this.lasso = [new THREE.Vector2(e.x, e.y)];
    } else {
      this.mode = 'box';
    }
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (this.mode === 'none') return;
    const d = Math.hypot(e.x - this.start.x, e.y - this.start.y);
    if (d > 4) this.dragged = true;
    if (this.mode === 'lasso') this.lasso.push(new THREE.Vector2(e.x, e.y));
    if (this.mode === 'circle') this.circleSelect(ctx, e);
    this.start.x === e.x; // no-op to appease linters
    ctx.requestRender();
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    const mode = this.mode;
    this.mode = 'none';
    if (mode === 'circle') { ctx.refreshUI(); return; }
    ctx.pushUndo();
    if (!this.dragged) {
      this.clickSelect(ctx, e);
    } else if (mode === 'box') {
      const min = new THREE.Vector2(Math.min(this.start.x, e.x), Math.min(this.start.y, e.y));
      const max = new THREE.Vector2(Math.max(this.start.x, e.x), Math.max(this.start.y, e.y));
      if (!this.extend) deselectAll(ctx);
      this.applyRegion(ctx, (px) => px.x >= min.x && px.x <= max.x && px.y >= min.y && px.y <= max.y);
    } else if (mode === 'lasso' && this.lasso.length > 2) {
      if (!this.extend) deselectAll(ctx);
      this.applyRegion(ctx, (px) => pointInPolygon(px, this.lasso));
    }
    this.lasso = [];
    ctx.requestRender();
    ctx.refreshUI();
  }

  onCancel(): void { this.mode = 'none'; this.lasso = []; }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    if (this.mode === 'lasso') drawLasso(hud, this.lasso);
    if (this.mode === 'box' && this.dragged) {
      const { x, y } = (hud.canvas as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer ?? { x: 0, y: 0 };
      hud.strokeStyle = 'rgba(255,255,255,0.8)';
      hud.setLineDash([4, 4]);
      hud.strokeRect(this.start.x, this.start.y, x - this.start.x, y - this.start.y);
      hud.setLineDash([]);
    }
    if (this.circleMode) {
      const { x, y } = (hud.canvas as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer ?? { x: -100, y: -100 };
      hud.beginPath();
      hud.arc(x, y, this.circleRadius, 0, Math.PI * 2);
      hud.strokeStyle = 'rgba(255,255,255,0.6)';
      hud.stroke();
    }
  }

  private applyRegion(ctx: AppCtx, test: (px: THREE.Vector2) => boolean): void {
    forEachEditableStroke(ctx, (s) => {
      let any = false;
      for (const p of s.points) {
        if (test(objectToScreen(ctx, p.co))) { p.select = true; any = true; }
      }
      if (ctx.settings.selectMode === 'STROKE' && any) {
        s.select = true;
        for (const p of s.points) p.select = true;
      } else if (any) s.select = true;
    });
  }

  private circleSelect(ctx: AppCtx, e: ToolEvent): void {
    const cursor = new THREE.Vector2(e.x, e.y);
    const deselect = e.ctrl;
    forEachEditableStroke(ctx, (s) => {
      for (const p of s.points) {
        if (objectToScreen(ctx, p.co).distanceTo(cursor) < this.circleRadius) p.select = !deselect;
      }
      s.select = s.points.some((p) => p.select);
    });
    ctx.requestRender();
  }

  private clickSelect(ctx: AppCtx, e: ToolEvent): void {
    const cursor = new THREE.Vector2(e.x, e.y);
    let best: { s: GPStroke; index: number; d: number } | null = null;
    forEachEditableStroke(ctx, (s) => {
      s.points.forEach((p, i) => {
        const d = objectToScreen(ctx, p.co).distanceTo(cursor);
        if (d < 14 && (!best || d < best.d)) best = { s, index: i, d };
      });
    });
    if (!this.extend) deselectAll(ctx);
    if (best !== null) {
      const b = best as { s: GPStroke; index: number; d: number };
      if (ctx.settings.selectMode === 'STROKE') {
        b.s.select = true;
        for (const p of b.s.points) p.select = true;
      } else {
        b.s.points[b.index].select = true;
        b.s.select = true;
      }
      return;
    }
    // no stroke under the cursor: try canvas planes (objects)
    const hit = pickCanvas(ctx, e.x, e.y);
    if (hit) {
      const canvas = ctx.scene.canvases.find((c) => c.id === hit.id);
      if (canvas) {
        canvas.select = this.extend ? !canvas.select : true;
        ctx.syncCanvases();
        ctx.refreshUI();
      }
    }
  }
}
