import * as THREE from 'three';
import type { GPStroke } from '../core/types';
import {
  activeLayer, activeObject, createPoint, createStroke, ensureFrame,
} from '../core/gpdata';
import type { AppCtx } from './context';
import { screenToWorld, worldToObject } from './projection';
import type { Tool, ToolEvent } from './toolsys';

type PrimKind = 'line' | 'polyline' | 'arc' | 'curve' | 'box' | 'circle';

/**
 * Primitive tools (Line/Polyline/Arc/Curve/Box/Circle), Blender-style:
 * drag the base shape; Arc and Curve get a second "adjust" phase where the
 * pointer bends the shape — click to commit, Esc/Enter also commits/cancels.
 */
export class PrimitiveTool implements Tool {
  id: string;
  cursor = 'crosshair';
  private kind: PrimKind;
  private phase: 'idle' | 'drag' | 'adjust' | 'poly' = 'idle';
  private anchors: THREE.Vector2[] = [];   // canvas px
  private current = new THREE.Vector2();
  private stroke: GPStroke | null = null;
  private shiftHeld = false;

  constructor(kind: PrimKind) {
    this.kind = kind;
    this.id = kind;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    this.shiftHeld = e.shift;
    this.current.set(e.x, e.y);
    if (this.phase === 'idle') {
      const ob = activeObject(ctx.scene);
      const layer = activeLayer(ob);
      if (!layer || layer.lock || layer.hide) return;
      ctx.pushUndo();
      const frame = ensureFrame(layer, ctx.scene.frame, ctx.settings.autoKey);
      this.stroke = createStroke(ob.activeMaterial, ctx.settings.brush.size);
      this.stroke.hardness = ctx.settings.brush.hardness;
      frame.strokes.push(this.stroke);
      this.anchors = [new THREE.Vector2(e.x, e.y)];
      this.phase = this.kind === 'polyline' ? 'poly' : 'drag';
      this.rebuild(ctx);
    } else if (this.phase === 'poly') {
      this.anchors.push(new THREE.Vector2(e.x, e.y));
      this.rebuild(ctx);
    } else if (this.phase === 'adjust') {
      this.commit(ctx);
    }
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (this.phase === 'idle') return;
    this.shiftHeld = e.shift;
    this.current.set(e.x, e.y);
    this.rebuild(ctx);
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    if (this.phase === 'drag') {
      this.current.set(e.x, e.y);
      if ((this.kind === 'arc' || this.kind === 'curve')) {
        this.anchors.push(this.current.clone());
        this.phase = 'adjust';
        this.rebuild(ctx);
      } else {
        this.commit(ctx);
      }
    }
  }

  onKey(ctx: AppCtx, key: string): boolean {
    if (this.phase === 'idle') return false;
    if (key === 'Enter') { this.commit(ctx); return true; }
    if (key === 'Escape') { this.cancel(ctx); return true; }
    return false;
  }

  onCancel(ctx: AppCtx): void {
    // pointer cancelled mid-gesture (e.g. tool switch)
    if (this.phase === 'drag') this.cancel(ctx);
  }

  private cancel(ctx: AppCtx): void {
    if (this.stroke) removeStroke(ctx, this.stroke);
    this.reset(ctx);
  }

  private commit(ctx: AppCtx): void {
    if (this.stroke && this.stroke.points.length < 2) removeStroke(ctx, this.stroke);
    this.reset(ctx);
    ctx.refreshUI();
  }

  private reset(ctx: AppCtx): void {
    this.stroke = null;
    this.anchors = [];
    this.phase = 'idle';
    ctx.requestRender();
  }

  private rebuild(ctx: AppCtx): void {
    if (!this.stroke) return;
    const pts2d = this.shape2D();
    const rect = ctx.canvas.getBoundingClientRect();
    this.stroke.points = [];
    for (const p of pts2d) {
      const world = screenToWorld(ctx, p.x + rect.left, p.y + rect.top);
      if (world) this.stroke.points.push(createPoint(worldToObject(ctx, world)));
    }
    this.stroke.cyclic = this.kind === 'box' || this.kind === 'circle';
    ctx.requestRender();
  }

  private shape2D(): THREE.Vector2[] {
    const a = this.anchors[0];
    const cur = this.current;
    switch (this.kind) {
      case 'line': {
        const end = this.constrain(a, cur);
        return sample((t) => a.clone().lerp(end, t), 8);
      }
      case 'polyline': {
        const out = [...this.anchors, cur];
        // densify segments a bit for later editing
        const dense: THREE.Vector2[] = [];
        for (let i = 0; i < out.length - 1; i++) {
          for (let k = 0; k < 4; k++) dense.push(out[i].clone().lerp(out[i + 1], k / 4));
        }
        dense.push(out[out.length - 1]);
        return dense;
      }
      case 'arc': {
        const end = this.phase === 'adjust' ? this.anchors[1] : cur;
        const bulge = this.phase === 'adjust' ? cur : defaultBulge(a, end);
        return sample((t) => quadBezier(a, bulge, end, t), 32);
      }
      case 'curve': {
        const end = this.phase === 'adjust' ? this.anchors[1] : cur;
        const ctrl = this.phase === 'adjust' ? cur : a.clone().lerp(end, 0.5);
        return sample((t) => quadBezier(a, ctrl, end, t), 32);
      }
      case 'box': {
        const c = this.constrain(a, cur);
        const corners = [a, new THREE.Vector2(c.x, a.y), c, new THREE.Vector2(a.x, c.y)];
        const dense: THREE.Vector2[] = [];
        for (let i = 0; i < 4; i++) {
          for (let k = 0; k < 6; k++) dense.push(corners[i].clone().lerp(corners[(i + 1) % 4], k / 6));
        }
        return dense;
      }
      case 'circle': {
        const c = this.constrain(a, cur);
        const cx = (a.x + c.x) / 2, cy = (a.y + c.y) / 2;
        const rx = Math.abs(c.x - a.x) / 2, ry = Math.abs(c.y - a.y) / 2;
        return sample((t) => new THREE.Vector2(
          cx + Math.cos(t * Math.PI * 2) * rx, cy + Math.sin(t * Math.PI * 2) * ry,
        ), 48, false);
      }
    }
  }

  /** Shift constrains box→square, circle→circle, line→45° increments. */
  private constrain(a: THREE.Vector2, b: THREE.Vector2): THREE.Vector2 {
    if (!this.shiftHeld) return b.clone();
    if (this.kind === 'line') {
      const d = b.clone().sub(a);
      const angle = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = d.length();
      return a.clone().add(new THREE.Vector2(Math.cos(angle) * len, Math.sin(angle) * len));
    }
    const d = b.clone().sub(a);
    const m = Math.max(Math.abs(d.x), Math.abs(d.y));
    return a.clone().add(new THREE.Vector2(Math.sign(d.x) * m, Math.sign(d.y) * m));
  }
}

function sample(fn: (t: number) => THREE.Vector2, n: number, inclusive = true): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const count = inclusive ? n + 1 : n;
  for (let i = 0; i < count; i++) out.push(fn(i / n));
  return out;
}

function quadBezier(a: THREE.Vector2, c: THREE.Vector2, b: THREE.Vector2, t: number): THREE.Vector2 {
  const u = 1 - t;
  return new THREE.Vector2(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  );
}

function defaultBulge(a: THREE.Vector2, b: THREE.Vector2): THREE.Vector2 {
  const mid = a.clone().lerp(b, 0.5);
  const d = b.clone().sub(a);
  return mid.add(new THREE.Vector2(-d.y, d.x).multiplyScalar(0.35));
}

function removeStroke(ctx: AppCtx, stroke: GPStroke): void {
  const ob = activeObject(ctx.scene);
  for (const layer of ob.layers) {
    for (const f of layer.frames) {
      const i = f.strokes.indexOf(stroke);
      if (i >= 0) { f.strokes.splice(i, 1); return; }
    }
  }
}
