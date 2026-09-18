import * as THREE from 'three';
import type { GPStroke } from '../core/types';
import {
  activeLayer, activeObject, createPoint, createStroke, ensureFrame,
} from '../core/gpdata';
import type { AppCtx } from './context';
import { brushWidth } from './draw';
import { screenToWorld, setStrokeExclusion, worldToObject } from './projection';
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
      this.stroke = createStroke(ob.activeMaterial, brushWidth(ctx.settings.brush));
      this.stroke.hardness = ctx.settings.brush.hardness;
      this.stroke.style = { ...ctx.settings.brush.style };
      frame.strokes.push(this.stroke);
      setStrokeExclusion(this.stroke.id);
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
    setStrokeExclusion(null);
    ctx.requestRender();
  }

  private rebuild(ctx: AppCtx): void {
    if (!this.stroke) return;
    const rect = ctx.canvas.getBoundingClientRect();
    const world = ctx.settings.shapeSnap === 'EVERY'
      ? this.shape2D().map((p) => screenToWorld(ctx, p.x + rect.left, p.y + rect.top))
      : this.shapeFromEnds(ctx, rect);
    this.stroke.points = [];
    for (const w of world) if (w) this.stroke.points.push(createPoint(worldToObject(ctx, w)));
    this.stroke.cyclic = this.kind === 'box' || this.kind === 'circle';
    ctx.requestRender();
  }

  /**
   * The shape built from the points you actually PLACE.
   *
   * Only those go through the Placement; everything between them is made in
   * 3D. Straight edges are a world-space lerp between their resolved ends,
   * which is exactly the straight line in space (and still projects to the
   * straight line you dragged). A curve's interior is cast at a depth that
   * runs smoothly from one end's depth to the other's. Neither can snap onto
   * something it merely crosses on screen — which is the whole point: a
   * ceiling edge dragged between two wall tops used to hop onto every
   * stroke behind it and break into a zigzag through depth.
   */
  private shapeFromEnds(ctx: AppCtx, rect: DOMRect): (THREE.Vector3 | null)[] {
    const at = (p: THREE.Vector2) => screenToWorld(ctx, p.x + rect.left, p.y + rect.top);
    const s = ctx.settings;
    // After the first point, a sticky-plane mode already puts every point on
    // one plane, and Origin/Cursor never snap to anything — so those can
    // resolve interior points normally. Only the TARGET-seeking placements
    // need the depth interpolation to stop them hopping between targets.
    const seeking = (s.placement === 'SURFACE' || s.placement === 'STROKE'
      || s.placement === 'SPLAT' || s.placement === 'NEAREST')
      && s.plane !== 'VIEW_ORIGIN' && s.plane !== 'UPRIGHT';
    const between = (p: THREE.Vector2, depth: number) =>
      seeking ? pointAtDepth(ctx, p, rect, depth) : at(p);
    const straight = (corners: (THREE.Vector3 | null)[], steps: number, closed: boolean) => {
      const out: (THREE.Vector3 | null)[] = [];
      const n = closed ? corners.length : corners.length - 1;
      for (let i = 0; i < n; i++) {
        const a = corners[i], b = corners[(i + 1) % corners.length];
        if (!a || !b) continue;
        for (let k = 0; k < steps; k++) out.push(a.clone().lerp(b, k / steps));
      }
      if (!closed && corners.length) out.push(corners[corners.length - 1]);
      return out;
    };

    const a = this.anchors[0];
    const cur = this.current;
    switch (this.kind) {
      case 'line': {
        const A = at(a); const B = at(this.constrain(a, cur));
        return straight([A, B], 8, false);
      }
      case 'polyline':
        return straight([...this.anchors, cur].map(at), 4, false);
      case 'box': {
        const c = this.constrain(a, cur);
        const A = at(a); const C = at(c);
        // the two corners you did not place sit between the two you did
        const d = A && C ? (viewDepth(ctx, A) + viewDepth(ctx, C)) / 2 : 0;
        const B = A && C ? between(new THREE.Vector2(c.x, a.y), d) : null;
        const D = A && C ? between(new THREE.Vector2(a.x, c.y), d) : null;
        return straight([A, B, C, D], 6, true);
      }
      case 'arc':
      case 'curve': {
        const pts = this.shape2D();
        const A = at(pts[0]); const B = at(pts[pts.length - 1]);
        if (!A || !B) return [];
        const dA = viewDepth(ctx, A), dB = viewDepth(ctx, B);
        return pts.map((p, i) => (i === 0 ? A : i === pts.length - 1 ? B
          : between(p, dA + (dB - dA) * (i / (pts.length - 1)))));
      }
      case 'circle': {
        // a circle has no placed point ON it, so it lies flat at the depth
        // of the corner you started the drag from
        const A = at(a);
        if (!A) return [];
        const d = viewDepth(ctx, A);
        return this.shape2D().map((p) => between(p, d));
      }
    }
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

const ray = new THREE.Raycaster();

/** Distance of a world point in front of the camera, along the view axis. */
function viewDepth(ctx: AppCtx, p: THREE.Vector3): number {
  const dir = ctx.camera.getWorldDirection(new THREE.Vector3());
  return p.clone().sub(ctx.camera.getWorldPosition(new THREE.Vector3())).dot(dir);
}

/** Where the ray through a canvas pixel reaches a given view depth. */
function pointAtDepth(
  ctx: AppCtx, p: THREE.Vector2, rect: DOMRect, depth: number,
): THREE.Vector3 | null {
  ray.setFromCamera(new THREE.Vector2((p.x / rect.width) * 2 - 1, -(p.y / rect.height) * 2 + 1), ctx.camera);
  const view = ctx.camera.getWorldDirection(new THREE.Vector3());
  const cos = ray.ray.direction.dot(view);
  if (Math.abs(cos) < 1e-6) return null;
  // measured from the camera, like viewDepth — an ORTHO ray starts on the
  // near plane, not at the camera, and would otherwise land short by it
  const start = ray.ray.origin.clone().sub(ctx.camera.getWorldPosition(new THREE.Vector3())).dot(view);
  return ray.ray.origin.clone().addScaledVector(ray.ray.direction, (depth - start) / cos);
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
