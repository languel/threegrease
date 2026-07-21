import * as THREE from 'three';
import type { GPPoint, GPStroke, TGPaintCloud, Vec3, Vec4 } from '../core/types';
import {
  activeLayer, activeObject, createPoint, createStroke, ensureFrame, frameAt,
  genId, visibleEditableLayers,
} from '../core/gpdata';
import { simplifyStroke, smoothAttr, smoothPoints, clamp, falloff } from '../core/mathutil';
import type { AppCtx } from './context';
import { applyGuide, eventToCanvas, objectToScreen, screenToWorld, setStrokeExclusion, worldToObject } from './projection';
import { listSelected, worldMatrixOf } from './objects';
import { PAINT_STRIDE } from '../render/paintclouds';
import type { Tool, ToolEvent } from './toolsys';

/** Brush size → stroke lineWidth: px for VIEW, world units (size/100) for SCENE. */
export function brushWidth(b: AppCtx['settings']['brush']): number {
  return b.style.unit === 'SCENE' ? b.size / 100 : b.size;
}

function drawTarget(ctx: AppCtx) {
  const ob = activeObject(ctx.scene);
  const layer = activeLayer(ob);
  if (!layer || layer.lock || layer.hide) return null;
  const frame = ensureFrame(layer, ctx.scene.frame, ctx.settings.autoKey);
  return { ob, layer, frame };
}

// ---------------------------------------------------------------- Draw tool

export class DrawTool implements Tool {
  id = 'draw';
  cursor = 'crosshair';
  private stroke: GPStroke | null = null;
  private layerId: number | null = null;
  private stabPos: THREE.Vector2 | null = null;
  private startScreen: THREE.Vector2 | null = null;
  private guideCenter = new THREE.Vector2();

  onDown(ctx: AppCtx, e: ToolEvent): void {
    const target = drawTarget(ctx);
    if (!target) return;
    ctx.pushUndo();
    const b = ctx.settings.brush;
    const s = createStroke(target.ob.activeMaterial, brushWidth(b));
    s.hardness = b.hardness;
    s.style = { ...b.style };
    target.frame.strokes.push(s);
    this.stroke = s;
    this.layerId = target.layer.id;
    setStrokeExclusion(s.id);
    this.stabPos = new THREE.Vector2(e.x, e.y);
    this.startScreen = null;
    const c = objectToScreen(ctx, [ctx.scene.cursor[0], ctx.scene.cursor[1], ctx.scene.cursor[2]]);
    this.guideCenter.copy(c);
    this.addPoint(ctx, e);
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (!this.stroke) return;
    this.addPoint(ctx, e);
    ctx.requestRender(this.layerId ?? undefined); // hot path: this layer only
  }

  onUp(ctx: AppCtx): void {
    if (!this.stroke) return;
    const b = ctx.settings.brush;
    if (this.stroke.points.length < 2) {
      // keep single dots — Blender does
    } else {
      smoothPoints(this.stroke.points, b.postSmooth, b.postSmoothSteps);
      smoothAttr(this.stroke.points, 'pressure', b.postSmooth * 0.5);
      if (b.simplify > 0) simplifyStroke(this.stroke, b.simplify);
    }
    this.stroke = null;
    setStrokeExclusion(null);
    ctx.requestRender();
    ctx.refreshUI();
  }

  onCancel(ctx: AppCtx): void { this.stroke = null; setStrokeExclusion(null); }

  private addPoint(ctx: AppCtx, e: ToolEvent): void {
    if (!this.stroke) return;
    const b = ctx.settings.brush;
    let px = new THREE.Vector2(e.x, e.y);

    if (b.stabilize && this.stabPos) {
      // lazy mouse: pointer drags a point behind it on a string
      const d = px.clone().sub(this.stabPos);
      const dist = d.length();
      if (dist <= b.stabilizeRadius) return;
      this.stabPos.add(d.normalize().multiplyScalar((dist - b.stabilizeRadius) * b.stabilizeFactor));
      px = this.stabPos.clone();
    }

    px = applyGuide(ctx, px, this.startScreen, this.guideCenter);
    if (!this.startScreen) this.startScreen = px.clone();

    const rect = ctx.canvas.getBoundingClientRect();
    const world = screenToWorld(ctx, px.x + rect.left, px.y + rect.top);
    if (!world) return;
    const co = worldToObject(ctx, world);
    const pressure = b.pressureSize ? Math.max(0.05, e.pressure || 0.5) : 1;
    const strength = b.pressureStrength ? b.strength * Math.max(0.1, e.pressure || 0.5) : b.strength;
    const p = createPoint(co, pressure, clamp(strength, 0, 1));
    if (b.vertexColorFactor > 0) {
      p.vertexColor = [b.vertexColor[0], b.vertexColor[1], b.vertexColor[2], b.vertexColorFactor];
    }
    const pts = this.stroke.points;
    // active smoothing on the tail
    if (pts.length >= 2 && b.activeSmooth > 0) {
      const a = pts[pts.length - 2], m = pts[pts.length - 1];
      for (let k = 0; k < 3; k++) {
        m.co[k] = m.co[k] + ((a.co[k] + p.co[k]) / 2 - m.co[k]) * b.activeSmooth;
      }
    }
    pts.push(p);
  }
}

// --------------------------------------------------------------- Erase tool

/** Local-only GP object transform (matches gatherDepthCandidates/objectToWorld's
 *  convention: GP stroke editing ignores the parent chain, by convention
 *  across the codebase — kept consistent here rather than switching to
 *  worldMatrixOf's parent-aware matrix for just this tool). */
function gpLocalMatrix(ob: { translation: Vec3; rotation: Vec3; scale: Vec3 }): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...ob.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
    new THREE.Vector3(...ob.scale),
  );
}

/** Erases from whatever kind(s) of object the outliner has selected (GP
 *  strokes, painted splat-cloud points), not just a hardcoded GP target.
 *  Falls back to the active GP object when nothing is explicitly selected
 *  (fresh scene / single default object, pre-existing default behavior). */
export class EraseTool implements Tool {
  id = 'erase';
  cursor = 'none';
  private active = false;

  onDown(ctx: AppCtx, e: ToolEvent): void {
    ctx.pushUndo();
    this.active = true;
    this.erase(ctx, e);
  }
  onMove(ctx: AppCtx, e: ToolEvent): void { if (this.active) this.erase(ctx, e); }
  onUp(ctx: AppCtx): void { this.active = false; ctx.refreshUI(); }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    drawBrushCircle(hud, ctx.settings.eraser.radius);
  }

  private erase(ctx: AppCtx, e: ToolEvent): void {
    const cursor = new THREE.Vector2(e.x, e.y);
    let changed = false;

    const selected = listSelected(ctx.scene);
    const selectedGPIds = new Set(selected.filter((r) => r.kind === 'GP').map((r) => r.id));
    const selectedCloudIds = new Set(selected.filter((r) => r.kind === 'PCLOUD').map((r) => r.id));

    const gpTargets = selectedGPIds.size
      ? ctx.scene.objects.filter((o) => selectedGPIds.has(o.id))
      : (selected.length === 0 ? [activeObject(ctx.scene)] : []);
    for (const ob of gpTargets) {
      if (ob.lock || ob.hide) continue;
      if (this.eraseGP(ctx, ob, cursor, e.pressure || 1)) changed = true;
    }

    for (const pc of ctx.scene.paintClouds) {
      if (!selectedCloudIds.has(pc.id) || pc.lock || !pc.visible || !pc.points.length) continue;
      if (this.erasePaintCloud(ctx, pc, cursor)) changed = true;
    }

    if (changed) ctx.requestRender();
  }

  private eraseGP(ctx: AppCtx, ob: ReturnType<typeof activeObject>, cursor: THREE.Vector2, pressure: number): boolean {
    const { mode, radius } = ctx.settings.eraser;
    const rect = ctx.canvas.getBoundingClientRect();
    const m = gpLocalMatrix(ob);
    const toScreen = (co: Vec3) => {
      const v = new THREE.Vector3(...co).applyMatrix4(m).project(ctx.camera);
      return new THREE.Vector2((v.x * 0.5 + 0.5) * rect.width, (-v.y * 0.5 + 0.5) * rect.height);
    };
    let changed = false;
    for (const layer of visibleEditableLayers(ob)) {
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      const keep: GPStroke[] = [];
      for (const s of frame.strokes) {
        const dists = s.points.map((p) => toScreen(p.co).distanceTo(cursor));
        const anyHit = dists.some((d) => d < radius);
        if (!anyHit) { keep.push(s); continue; }
        changed = true;
        if (mode === 'STROKE') continue; // drop whole stroke
        if (mode === 'SOFT') {
          s.points.forEach((p, i) => {
            if (dists[i] < radius) {
              p.strength -= 0.15 * (1 - dists[i] / radius) * pressure;
            }
          });
          s.points = s.points.filter((p) => p.strength > 0.02);
          if (s.points.length) keep.push(s);
          continue;
        }
        // POINT: remove hit points, split into runs
        for (const run of splitRuns(s, dists.map((d) => d >= radius))) keep.push(run);
      }
      frame.strokes = keep;
    }
    return changed;
  }

  /** Delete painted splat points under the brush (POINT-style; mirrors
   *  SplatPaintTool's Ctrl+drag erase, scoped to the selected cloud). */
  private erasePaintCloud(ctx: AppCtx, pc: TGPaintCloud, cursor: THREE.Vector2): boolean {
    const { radius } = ctx.settings.eraser;
    const rect = ctx.canvas.getBoundingClientRect();
    const world = worldMatrixOf(ctx.scene, { kind: 'PCLOUD', id: pc.id });
    const v = new THREE.Vector3();
    const keep: number[] = [];
    let touched = false;
    for (let o = 0; o < pc.points.length; o += PAINT_STRIDE) {
      v.set(pc.points[o], pc.points[o + 1], pc.points[o + 2]).applyMatrix4(world).project(ctx.camera);
      const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
      if (v.z <= 1 && Math.hypot(sx - cursor.x, sy - cursor.y) < radius) { touched = true; continue; }
      for (let k = 0; k < PAINT_STRIDE; k++) keep.push(pc.points[o + k]);
    }
    if (keep.length !== pc.points.length) {
      pc.points = keep;
      pc.rev = (pc.rev + 1) % 1e9;
    }
    return touched;
  }
}

/** Split a stroke into new strokes from consecutive kept points. */
export function splitRuns(s: GPStroke, keepMask: boolean[]): GPStroke[] {
  const out: GPStroke[] = [];
  let run: GPPoint[] = [];
  const flush = () => {
    if (run.length >= 1) {
      out.push({ ...s, id: genId(), points: run, cyclic: false });
    }
    run = [];
  };
  s.points.forEach((p, i) => { if (keepMask[i]) run.push(p); else flush(); });
  flush();
  return out;
}

// -------------------------------------------------------------- Smooth tool

/** A copy of Sculpt mode's SMOOTH brush usable directly from DRAW mode (no
 *  mode switch needed) — sits right after Erase in the toolbar, defaults to
 *  smoothing (there's no other brush to pick, unlike SculptTool which reads
 *  ctx.settings.sculpt.brush). Scoped to the active GP object by default,
 *  matching Sculpt mode's own scope; holding Shift broadens the brush to
 *  every visible, unlocked GP object it passes over, not just the active
 *  one (mirrors EraseTool's per-object local-matrix generalization above).
 *  Mesh/splat smoothing is a natural extension of the same per-object-kind
 *  loop pattern but isn't implemented yet — GP strokes only for now. */
export class SmoothTool implements Tool {
  id = 'smooth';
  cursor = 'none';
  private active = false;

  onDown(ctx: AppCtx, e: ToolEvent): void {
    ctx.pushUndo();
    this.active = true;
    this.apply(ctx, e);
  }
  onMove(ctx: AppCtx, e: ToolEvent): void { if (this.active) this.apply(ctx, e); }
  onUp(): void { this.active = false; }
  onCancel(): void { this.active = false; }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    drawBrushCircle(hud, ctx.settings.sculpt.radius, [0.55, 0.85, 1]);
  }

  private apply(ctx: AppCtx, e: ToolEvent): void {
    const { radius, strength } = ctx.settings.sculpt;
    const press = (e.pressure || 0.7) * strength * 0.4;
    const cursor = new THREE.Vector2(e.x, e.y);
    const rect = ctx.canvas.getBoundingClientRect();

    const targets = e.shift
      ? ctx.scene.objects.filter((o) => !o.hide && !o.lock)
      : [activeObject(ctx.scene)];

    let changed = false;
    for (const ob of targets) {
      const m = gpLocalMatrix(ob);
      const toScreen = (co: Vec3) => {
        const v = new THREE.Vector3(...co).applyMatrix4(m).project(ctx.camera);
        return new THREE.Vector2((v.x * 0.5 + 0.5) * rect.width, (-v.y * 0.5 + 0.5) * rect.height);
      };
      for (const layer of visibleEditableLayers(ob)) {
        const frame = frameAt(layer, ctx.scene.frame);
        if (!frame) continue;
        for (const s of frame.strokes) {
          const pts = s.points;
          pts.forEach((p, i) => {
            if (i === 0 || i === pts.length - 1) return; // matches SculptTool: endpoints held fixed
            const d = toScreen(p.co).distanceTo(cursor);
            const w = falloff(d, radius);
            if (w <= 0) return;
            const a = pts[i - 1].co, b = pts[i + 1].co;
            const f = w * press;
            p.co = [
              p.co[0] + ((a[0] + b[0]) / 2 - p.co[0]) * f,
              p.co[1] + ((a[1] + b[1]) / 2 - p.co[1]) * f,
              p.co[2] + ((a[2] + b[2]) / 2 - p.co[2]) * f,
            ];
            changed = true;
          });
        }
      }
    }
    if (changed) ctx.requestRender();
  }
}

// ---------------------------------------------------------------- Tint tool

export class TintTool implements Tool {
  id = 'tint';
  cursor = 'none';
  private active = false;

  onDown(ctx: AppCtx, e: ToolEvent): void {
    ctx.pushUndo();
    this.active = true;
    this.tint(ctx, e);
  }
  onMove(ctx: AppCtx, e: ToolEvent): void { if (this.active) this.tint(ctx, e); }
  onUp(ctx: AppCtx): void { this.active = false; }
  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    drawBrushCircle(hud, ctx.settings.paint.radius, ctx.settings.brush.vertexColor);
  }

  private tint(ctx: AppCtx, e: ToolEvent): void {
    const ob = activeObject(ctx.scene);
    const { radius, strength } = ctx.settings.paint;
    const color = ctx.settings.brush.vertexColor;
    const cursor = new THREE.Vector2(e.x, e.y);
    let changed = false;
    for (const layer of visibleEditableLayers(ob)) {
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        let allIn = true;
        for (const p of s.points) {
          const d = objectToScreen(ctx, p.co).distanceTo(cursor);
          if (d < radius) {
            const f = strength * (1 - d / radius) * (e.pressure || 1) * 0.3;
            mixVertexColor(p.vertexColor, color, f);
            changed = true;
          } else allIn = false;
        }
        if (allIn && s.points.length) mixVertexColor(s.fillVertexColor, color, strength * 0.3);
      }
    }
    if (changed) ctx.requestRender();
  }
}

export function mixVertexColor(vc: Vec4, color: readonly number[], f: number): void {
  if (vc[3] <= 0) { vc[0] = color[0]; vc[1] = color[1]; vc[2] = color[2]; vc[3] = 0; }
  vc[0] += (color[0] - vc[0]) * f;
  vc[1] += (color[1] - vc[1]) * f;
  vc[2] += (color[2] - vc[2]) * f;
  vc[3] = clamp(vc[3] + f, 0, 1);
}

// -------------------------------------------------------------- Cutter tool

export class CutterTool implements Tool {
  id = 'cutter';
  cursor = 'crosshair';
  private lasso: THREE.Vector2[] = [];

  onDown(ctx: AppCtx, e: ToolEvent): void { this.lasso = [new THREE.Vector2(e.x, e.y)]; }
  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (this.lasso.length) { this.lasso.push(new THREE.Vector2(e.x, e.y)); ctx.requestRender(); }
  }
  onUp(ctx: AppCtx): void {
    if (this.lasso.length > 2) {
      ctx.pushUndo();
      const ob = activeObject(ctx.scene);
      for (const layer of visibleEditableLayers(ob)) {
        const frame = frameAt(layer, ctx.scene.frame);
        if (!frame) continue;
        const keep: GPStroke[] = [];
        for (const s of frame.strokes) {
          const inside = s.points.map((p) => pointInPolygon(objectToScreen(ctx, p.co), this.lasso));
          if (!inside.some(Boolean)) { keep.push(s); continue; }
          for (const run of splitRuns(s, inside.map((v) => !v))) keep.push(run);
        }
        frame.strokes = keep;
      }
    }
    this.lasso = [];
    ctx.requestRender();
    ctx.refreshUI();
  }
  onCancel(): void { this.lasso = []; }

  drawHud(_ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    drawLasso(hud, this.lasso);
  }
}

export function pointInPolygon(p: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// ----------------------------------------------------------- Eyedropper tool

export class EyedropperTool implements Tool {
  id = 'eyedropper';
  cursor = 'crosshair';
  onDown(ctx: AppCtx, e: ToolEvent): void {
    const gl = ctx.gl.getContext();
    const dpr = ctx.gl.getPixelRatio();
    const rect = ctx.canvas.getBoundingClientRect();
    const px = new Uint8Array(4);
    gl.readPixels(
      Math.round(e.x * dpr), Math.round((rect.height - e.y) * dpr),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px,
    );
    const ob = activeObject(ctx.scene);
    ctx.pushUndo();
    const mat = ob.materials[ob.activeMaterial];
    mat.strokeColor = [px[0] / 255, px[1] / 255, px[2] / 255, mat.strokeColor[3]];
    ctx.refreshUI();
    ctx.requestRender();
  }
  onMove(): void {}
  onUp(): void {}
}

// -------------------------------------------------------------- HUD helpers

export function drawBrushCircle(
  hud: CanvasRenderingContext2D, radius: number, color?: readonly number[],
): void {
  const { x, y } = (hud.canvas as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer ?? { x: -100, y: -100 };
  hud.beginPath();
  hud.arc(x, y, radius, 0, Math.PI * 2);
  hud.strokeStyle = color ? `rgba(${color[0] * 255},${color[1] * 255},${color[2] * 255},0.9)` : 'rgba(255,255,255,0.7)';
  hud.lineWidth = 1.5;
  hud.stroke();
}

export function drawLasso(hud: CanvasRenderingContext2D, lasso: THREE.Vector2[]): void {
  if (lasso.length < 2) return;
  hud.beginPath();
  hud.moveTo(lasso[0].x, lasso[0].y);
  for (const p of lasso) hud.lineTo(p.x, p.y);
  hud.closePath();
  hud.strokeStyle = 'rgba(255,255,255,0.8)';
  hud.setLineDash([4, 4]);
  hud.lineWidth = 1;
  hud.stroke();
  hud.setLineDash([]);
}
