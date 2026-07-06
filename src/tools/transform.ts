import * as THREE from 'three';
import type { CanvasPlane, GPPoint, Vec3 } from '../core/types';
import { falloff } from '../core/mathutil';
import type { AppCtx } from './context';
import { forEachEditableStroke, selectedPoints } from './select';
import { nearestStrokePoint, objectToScreen, objectToWorld, pickCanvas, screenToWorld, worldToObject } from './projection';

type TransformKind = 'move' | 'rotate' | 'scale' | 'shear';
type AxisLock = 'none' | 'x' | 'y' | 'z';

interface Affected { p: GPPoint; orig: Vec3; weight: number }
interface AffectedCanvas {
  c: CanvasPlane;
  origT: Vec3;
  origQ: THREE.Quaternion;
  origSize: [number, number];
}

/**
 * Blender-style modal transform (G/R/S). Started from a keypress; pointer
 * moves apply, click/Enter confirms, Esc/right-click cancels. Axis keys lock,
 * wheel adjusts proportional-editing radius.
 */
export class ModalTransform {
  private kind: TransformKind = 'move';
  private affected: Affected[] = [];
  private canvases: AffectedCanvas[] = [];
  private canvasPivot = new THREE.Vector3(); // world-space pivot for canvas transforms
  private center = new THREE.Vector2();   // screen px pivot
  private centerLocal: Vec3 = [0, 0, 0];
  private startPointer = new THREE.Vector2();
  private axis: AxisLock = 'none';
  active = false;

  begin(ctx: AppCtx, kind: TransformKind, pointer: { x: number; y: number }): boolean {
    const sel = selectedPoints(ctx);
    if (!sel.length) return this.beginCanvases(ctx, kind, pointer);
    ctx.pushUndo();
    this.canvases = [];
    this.kind = kind;
    this.axis = 'none';
    this.startPointer.set(pointer.x, pointer.y);
    this.affected = [];

    // pivot: median of selection
    const median: Vec3 = [0, 0, 0];
    for (const { s, index } of sel) {
      const c = s.points[index].co;
      median[0] += c[0]; median[1] += c[1]; median[2] += c[2];
    }
    median[0] /= sel.length; median[1] /= sel.length; median[2] /= sel.length;
    this.centerLocal = median;
    this.center = objectToScreen(ctx, median);

    const seen = new Set<GPPoint>();
    for (const { s, index } of sel) {
      const p = s.points[index];
      if (seen.has(p)) continue;
      seen.add(p);
      this.affected.push({ p, orig: [...p.co] as Vec3, weight: 1 });
    }
    // proportional editing: pull in unselected points with falloff
    if (ctx.settings.propEdit.enabled) {
      const radius = ctx.settings.propEdit.radius;
      forEachEditableStroke(ctx, (s) => {
        for (const p of s.points) {
          if (seen.has(p)) continue;
          let minD = Infinity;
          const px = objectToScreen(ctx, p.co);
          for (const { s: ss, index } of sel) {
            const d = objectToScreen(ctx, ss.points[index].co).distanceTo(px);
            if (d < minD) minD = d;
          }
          const w = falloff(minD, radius);
          if (w > 0) { seen.add(p); this.affected.push({ p, orig: [...p.co] as Vec3, weight: w }); }
        }
      });
    }
    this.active = true;
    return true;
  }

  /** Transform selected canvas planes (world space) when no points are selected. */
  private beginCanvases(ctx: AppCtx, kind: TransformKind, pointer: { x: number; y: number }): boolean {
    const sel = ctx.scene.canvases.filter((c) => c.select);
    if (!sel.length || kind === 'shear') return false;
    ctx.pushUndo();
    this.kind = kind;
    this.axis = 'none';
    this.affected = [];
    this.startPointer.set(pointer.x, pointer.y);
    this.canvases = sel.map((c) => ({
      c,
      origT: [...c.translation] as Vec3,
      origQ: new THREE.Quaternion().setFromEuler(new THREE.Euler(...c.rotation)),
      origSize: [...c.size] as [number, number],
    }));
    this.canvasPivot.set(0, 0, 0);
    for (const a of this.canvases) this.canvasPivot.add(new THREE.Vector3(...a.origT));
    this.canvasPivot.divideScalar(this.canvases.length);
    const rect = ctx.canvas.getBoundingClientRect();
    const projected = this.canvasPivot.clone().project(ctx.camera);
    this.center.set((projected.x * 0.5 + 0.5) * rect.width, (-projected.y * 0.5 + 0.5) * rect.height);
    this.active = true;
    return true;
  }

  private updateCanvases(ctx: AppCtx, cur: THREE.Vector2): void {
    if (this.kind === 'move') {
      const rect = ctx.canvas.getBoundingClientRect();
      const w0 = screenToWorld(ctx, this.startPointer.x + rect.left, this.startPointer.y + rect.top);
      const w1 = screenToWorld(ctx, cur.x + rect.left, cur.y + rect.top);
      if (!w0 || !w1) return;
      let delta = w1.clone().sub(w0);
      if (this.axis !== 'none') {
        const keep = this.axis === 'x' ? 'x' : this.axis === 'y' ? 'y' : 'z';
        delta = new THREE.Vector3(
          keep === 'x' ? delta.x : 0, keep === 'y' ? delta.y : 0, keep === 'z' ? delta.z : 0,
        );
      }
      for (const a of this.canvases) {
        a.c.translation = [a.origT[0] + delta.x, a.origT[1] + delta.y, a.origT[2] + delta.z];
      }
    } else if (this.kind === 'rotate') {
      const a0 = Math.atan2(this.startPointer.y - this.center.y, this.startPointer.x - this.center.x);
      const a1 = Math.atan2(cur.y - this.center.y, cur.x - this.center.x);
      const viewDir = ctx.camera.getWorldDirection(new THREE.Vector3());
      const qd = new THREE.Quaternion().setFromAxisAngle(viewDir, -(a1 - a0));
      for (const a of this.canvases) {
        const pos = new THREE.Vector3(...a.origT).sub(this.canvasPivot).applyQuaternion(qd).add(this.canvasPivot);
        a.c.translation = [pos.x, pos.y, pos.z];
        const e = new THREE.Euler().setFromQuaternion(qd.clone().multiply(a.origQ));
        a.c.rotation = [e.x, e.y, e.z];
      }
    } else if (this.kind === 'scale') {
      const d0 = Math.max(4, this.startPointer.distanceTo(this.center));
      const f = cur.distanceTo(this.center) / d0;
      for (const a of this.canvases) {
        const pos = new THREE.Vector3(...a.origT).sub(this.canvasPivot).multiplyScalar(f).add(this.canvasPivot);
        a.c.translation = [pos.x, pos.y, pos.z];
        a.c.size = [Math.max(0.05, a.origSize[0] * f), Math.max(0.05, a.origSize[1] * f)];
      }
    }
    ctx.syncCanvases();
  }

  /** Magnet snapping for point moves: adjusts the delta so the selection median lands on the target. */
  private snapDelta(ctx: AppCtx, delta: Vec3, pointer: THREE.Vector2): Vec3 {
    const snap = ctx.settings.snap;
    if (!snap.enabled) return delta;
    const moved: Vec3 = [
      this.centerLocal[0] + delta[0], this.centerLocal[1] + delta[1], this.centerLocal[2] + delta[2],
    ];
    let target: Vec3 | null = null;
    if (snap.mode === 'INCREMENT') {
      const g = ctx.settings.gridStep;
      target = moved.map((v) => Math.round(v / g) * g) as Vec3;
    } else if (snap.mode === 'POINT') {
      const world = nearestStrokePoint(ctx, pointer.x, pointer.y, 40);
      if (world) target = worldToObject(ctx, world);
    } else if (snap.mode === 'CANVAS') {
      const hit = pickCanvas(ctx, pointer.x, pointer.y);
      if (hit) target = worldToObject(ctx, hit.point);
    }
    if (!target) return delta;
    return [
      delta[0] + target[0] - moved[0],
      delta[1] + target[1] - moved[1],
      delta[2] + target[2] - moved[2],
    ];
  }

  update(ctx: AppCtx, pointer: { x: number; y: number }): void {
    if (!this.active) return;
    const cur = new THREE.Vector2(pointer.x, pointer.y);
    if (this.canvases.length) { this.updateCanvases(ctx, cur); return; }
    if (this.kind === 'move') {
      // move along the drawing plane via unprojection of both pointer positions
      const rect = ctx.canvas.getBoundingClientRect();
      const w0 = screenToWorld(ctx, this.startPointer.x + rect.left, this.startPointer.y + rect.top);
      const w1 = screenToWorld(ctx, cur.x + rect.left, cur.y + rect.top);
      if (!w0 || !w1) return;
      const d0 = worldToObject(ctx, w0), d1 = worldToObject(ctx, w1);
      let delta: Vec3 = [d1[0] - d0[0], d1[1] - d0[1], d1[2] - d0[2]];
      if (this.axis !== 'none') {
        const keep = this.axis === 'x' ? 0 : this.axis === 'y' ? 1 : 2;
        delta = delta.map((v, i) => (i === keep ? v : 0)) as Vec3;
      }
      delta = this.snapDelta(ctx, delta, cur);
      for (const a of this.affected) {
        a.p.co = [a.orig[0] + delta[0] * a.weight, a.orig[1] + delta[1] * a.weight, a.orig[2] + delta[2] * a.weight];
      }
    } else if (this.kind === 'rotate') {
      const a0 = Math.atan2(this.startPointer.y - this.center.y, this.startPointer.x - this.center.x);
      const a1 = Math.atan2(cur.y - this.center.y, cur.x - this.center.x);
      const angle = -(a1 - a0); // screen y is down
      this.applyViewPlaneRotation(ctx, angle);
    } else if (this.kind === 'scale') {
      const d0 = Math.max(4, this.startPointer.distanceTo(this.center));
      const d1 = cur.distanceTo(this.center);
      const f = d1 / d0;
      for (const a of this.affected) {
        const s = 1 + (f - 1) * a.weight;
        const co: Vec3 = [...a.orig] as Vec3;
        if (this.axis === 'none' || this.axis === 'x') co[0] = this.centerLocal[0] + (a.orig[0] - this.centerLocal[0]) * s;
        if (this.axis === 'none' || this.axis === 'y') co[1] = this.centerLocal[1] + (a.orig[1] - this.centerLocal[1]) * s;
        if (this.axis === 'none' || this.axis === 'z') co[2] = this.centerLocal[2] + (a.orig[2] - this.centerLocal[2]) * s;
        a.p.co = co;
      }
    } else if (this.kind === 'shear') {
      const dx = (cur.x - this.startPointer.x) / 200;
      for (const a of this.affected) {
        const co: Vec3 = [...a.orig] as Vec3;
        co[0] += (a.orig[1] - this.centerLocal[1]) * dx * a.weight;
        a.p.co = co;
      }
    }
    ctx.requestRender();
  }

  /** Rotate around the view axis through the pivot. */
  private applyViewPlaneRotation(ctx: AppCtx, angle: number): void {
    const viewDir = ctx.camera.getWorldDirection(new THREE.Vector3());
    const pivotWorld = objectToWorld(ctx, this.centerLocal);
    const q = new THREE.Quaternion().setFromAxisAngle(viewDir, angle);
    for (const a of this.affected) {
      const w = objectToWorld(ctx, a.orig);
      const v = w.sub(pivotWorld).applyQuaternion(
        a.weight === 1 ? q : new THREE.Quaternion().setFromAxisAngle(viewDir, angle * a.weight),
      ).add(pivotWorld);
      a.p.co = worldToObject(ctx, v);
    }
  }

  setAxis(axis: AxisLock, ctx: AppCtx, pointer: { x: number; y: number }): void {
    if (!this.active) return;
    this.axis = this.axis === axis ? 'none' : axis;
    this.update(ctx, pointer);
  }

  adjustRadius(ctx: AppCtx, delta: number, pointer: { x: number; y: number }): void {
    if (!ctx.settings.propEdit.enabled) return;
    ctx.settings.propEdit.radius = Math.max(5, ctx.settings.propEdit.radius * (delta > 0 ? 1.1 : 0.9));
  }

  confirm(ctx: AppCtx): void {
    this.active = false;
    this.affected = [];
    this.canvases = [];
    ctx.requestRender();
  }

  cancel(ctx: AppCtx): void {
    for (const a of this.affected) a.p.co = a.orig;
    for (const a of this.canvases) {
      a.c.translation = [...a.origT] as Vec3;
      const e = new THREE.Euler().setFromQuaternion(a.origQ);
      a.c.rotation = [e.x, e.y, e.z];
      a.c.size = [...a.origSize] as [number, number];
    }
    if (this.canvases.length) ctx.syncCanvases();
    this.active = false;
    this.affected = [];
    this.canvases = [];
    ctx.requestRender();
  }
}
