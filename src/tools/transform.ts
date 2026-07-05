import * as THREE from 'three';
import type { GPPoint, Vec3 } from '../core/types';
import { falloff } from '../core/mathutil';
import type { AppCtx } from './context';
import { forEachEditableStroke, selectedPoints } from './select';
import { objectToScreen, objectToWorld, screenToWorld, worldToObject } from './projection';

type TransformKind = 'move' | 'rotate' | 'scale' | 'shear';
type AxisLock = 'none' | 'x' | 'y' | 'z';

interface Affected { p: GPPoint; orig: Vec3; weight: number }

/**
 * Blender-style modal transform (G/R/S). Started from a keypress; pointer
 * moves apply, click/Enter confirms, Esc/right-click cancels. Axis keys lock,
 * wheel adjusts proportional-editing radius.
 */
export class ModalTransform {
  private kind: TransformKind = 'move';
  private affected: Affected[] = [];
  private center = new THREE.Vector2();   // screen px pivot
  private centerLocal: Vec3 = [0, 0, 0];
  private startPointer = new THREE.Vector2();
  private axis: AxisLock = 'none';
  active = false;

  begin(ctx: AppCtx, kind: TransformKind, pointer: { x: number; y: number }): boolean {
    const sel = selectedPoints(ctx);
    if (!sel.length) return false;
    ctx.pushUndo();
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

  update(ctx: AppCtx, pointer: { x: number; y: number }): void {
    if (!this.active) return;
    const cur = new THREE.Vector2(pointer.x, pointer.y);
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
    ctx.requestRender();
  }

  cancel(ctx: AppCtx): void {
    for (const a of this.affected) a.p.co = a.orig;
    this.active = false;
    this.affected = [];
    ctx.requestRender();
  }
}
