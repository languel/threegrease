// Blender-style modal transform for OBJECT mode: G/R/S start it, mouse
// drives it, LMB/Enter confirms, RMB/Esc cancels. X/Y/Z lock an axis
// (Shift+axis locks the PLANE, i.e. excludes the axis), pressing G/R/S
// mid-modal switches kind, R while rotating toggles trackball (RR),
// digits type an exact value. Snapping follows the global magnet and
// holding Ctrl INVERTS it (off->on, on->off), like Blender.
//
// The modal only computes a world-space delta matrix; the App applies it
// to every selected object through parent inverses (same path as the
// gizmo widget), so parenting/Follow-Path leashing behave identically.
import * as THREE from 'three';
import type { AppCtx } from './context';
import { getObjectTransform, listSelected, selectionPivot, setObjectTransform, type ObjRef, type ObjTransform } from './objects';
import { nearestStrokePoint, raycastSurfaces } from './projection';
import { allRefs, worldMatrixOf } from './objects';

export type ObjModalKind = 'move' | 'rotate' | 'scale';
type AxisLock = 'none' | 'x' | 'y' | 'z';

const AXES: Record<Exclude<AxisLock, 'none'>, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

export interface ObjModalMods { ctrl: boolean; shift: boolean }

export class ObjectModalTransform {
  active = false;
  kind: ObjModalKind = 'move';
  axis: AxisLock = 'none';
  planeLock = false;
  trackball = false;
  numeric = '';

  refs: ObjRef[] = [];
  base: ObjTransform[] = [];
  private pivot = new THREE.Vector3();
  private pivotScreen = new THREE.Vector2();
  private startPointer = new THREE.Vector2();
  private lastPointer = new THREE.Vector2();
  private startWorld = new THREE.Vector3();   // view-plane hit under the start pointer
  private trackQ = new THREE.Quaternion();    // accumulated trackball rotation
  private mods: ObjModalMods = { ctrl: false, shift: false };
  /** last delta actually applied — for the HUD overlay */
  info = '';

  /** Called by the App with the computed world-space delta matrix. */
  onDelta: ((deltaM: THREE.Matrix4) => void) | null = null;

  begin(ctx: AppCtx, kind: ObjModalKind, pointer: { x: number; y: number }): boolean {
    const refs = listSelected(ctx.scene);
    const pivot = selectionPivot(ctx.scene);
    if (!refs.length || !pivot) return false;
    ctx.pushUndo();
    this.refs = refs;
    this.base = refs.map((r) => getObjectTransform(ctx.scene, r)!);
    this.pivot.copy(pivot);
    this.kind = kind;
    this.axis = 'none';
    this.planeLock = false;
    this.trackball = false;
    this.numeric = '';
    this.trackQ.identity();
    this.startPointer.set(pointer.x, pointer.y);
    this.lastPointer.copy(this.startPointer);
    this.pivotScreen.copy(this.worldToScreen(ctx, this.pivot));
    this.startWorld.copy(this.viewPlaneHit(ctx, pointer.x, pointer.y) ?? this.pivot);
    this.active = true;
    this.apply(ctx);
    return true;
  }

  /** Switch kind mid-modal (Blender: press R during G). R while already
   *  rotating toggles trackball. Restarts the gesture from the current
   *  pointer so there's no jump. */
  switchKind(ctx: AppCtx, kind: ObjModalKind): void {
    if (this.kind === 'rotate' && kind === 'rotate') {
      this.trackball = !this.trackball;
      this.trackQ.identity();
    } else {
      this.kind = kind;
      this.trackball = false;
    }
    // reset the gesture baseline but keep the objects where they are NOW
    this.restore(ctx);
    this.base = this.refs.map((r) => getObjectTransform(ctx.scene, r)!);
    this.startPointer.copy(this.lastPointer);
    this.startWorld.copy(this.viewPlaneHit(ctx, this.lastPointer.x, this.lastPointer.y) ?? this.pivot);
    this.numeric = '';
    this.apply(ctx);
  }

  setAxis(ctx: AppCtx, axis: Exclude<AxisLock, 'none'>, plane: boolean): void {
    if (this.axis === axis && this.planeLock === plane) {
      this.axis = 'none'; // same key again clears the lock
      this.planeLock = false;
    } else {
      this.axis = axis;
      this.planeLock = plane;
    }
    this.apply(ctx);
  }

  /** Digits/./-/backspace build a typed exact value (Blender numeric input). */
  handleNumeric(ctx: AppCtx, key: string): boolean {
    if (/^[0-9]$/.test(key) || key === '.' || key === '-') {
      this.numeric = key === '-'
        ? (this.numeric.startsWith('-') ? this.numeric.slice(1) : `-${this.numeric}`)
        : this.numeric + key;
      this.apply(ctx);
      return true;
    }
    if (key === 'Backspace' && this.numeric) {
      this.numeric = this.numeric.slice(0, -1);
      this.apply(ctx);
      return true;
    }
    return false;
  }

  update(ctx: AppCtx, pointer: { x: number; y: number }, mods: ObjModalMods): void {
    if (!this.active) return;
    const prev = this.lastPointer.clone();
    this.lastPointer.set(pointer.x, pointer.y);
    this.mods = mods;
    if (this.kind === 'rotate' && this.trackball) {
      // incremental: accumulate view-space rotation from pointer motion
      const cam = ctx.camera;
      const upAx = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const rightAx = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const dx = (pointer.x - prev.x) * 0.008;
      const dy = (pointer.y - prev.y) * 0.008;
      this.trackQ.premultiply(new THREE.Quaternion().setFromAxisAngle(upAx, dx))
        .premultiply(new THREE.Quaternion().setFromAxisAngle(rightAx, dy));
    }
    this.apply(ctx);
  }

  /** Recompute the delta from the current gesture state and hand it to the App. */
  private apply(ctx: AppCtx): void {
    if (!this.active) return;
    const snapOn = ctx.settings.snap.enabled !== this.mods.ctrl; // Ctrl inverts
    const typed = this.numeric !== '' && this.numeric !== '-' ? Number(this.numeric) : null;
    const P = this.pivot;
    let deltaM: THREE.Matrix4;

    if (this.kind === 'move') {
      let d = new THREE.Vector3();
      if (typed !== null && this.axis !== 'none' && !this.planeLock) {
        d.copy(AXES[this.axis]).multiplyScalar(typed);
      } else {
        const hit = this.viewPlaneHit(ctx, this.lastPointer.x, this.lastPointer.y);
        if (hit) d.copy(hit).sub(this.startWorld);
        if (this.mods.shift) d.multiplyScalar(0.1); // precision
        if (this.axis !== 'none') {
          if (this.planeLock) d.sub(AXES[this.axis].clone().multiplyScalar(d.dot(AXES[this.axis])));
          else d = AXES[this.axis].clone().multiplyScalar(d.dot(AXES[this.axis]));
        }
        if (snapOn) d = this.snapMoveDelta(ctx, d);
      }
      this.info = `Dx: ${d.x.toFixed(3)}  Dy: ${d.y.toFixed(3)}  Dz: ${d.z.toFixed(3)}  (${d.length().toFixed(3)})`;
      deltaM = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z);
    } else if (this.kind === 'rotate') {
      let q: THREE.Quaternion;
      if (this.trackball) {
        q = this.trackQ.clone();
        this.info = 'Trackball';
      } else {
        let angle: number;
        if (typed !== null) {
          angle = THREE.MathUtils.degToRad(typed);
        } else {
          const a0 = Math.atan2(this.startPointer.y - this.pivotScreen.y, this.startPointer.x - this.pivotScreen.x);
          const a1 = Math.atan2(this.lastPointer.y - this.pivotScreen.y, this.lastPointer.x - this.pivotScreen.x);
          angle = -(a1 - a0); // screen y is down
          if (this.mods.shift) angle *= 0.1;
          if (snapOn) angle = Math.round(angle / (Math.PI / 36)) * (Math.PI / 36); // 5°
        }
        const axis = this.axis !== 'none'
          ? AXES[this.axis].clone()
          : ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
        q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
        this.info = `Rot: ${THREE.MathUtils.radToDeg(angle).toFixed(1)}°${this.axis !== 'none' ? ` along ${this.axis.toUpperCase()}` : ''}`;
      }
      deltaM = new THREE.Matrix4()
        .makeTranslation(P.x, P.y, P.z)
        .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
        .multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
    } else {
      let f: number;
      if (typed !== null) {
        f = typed;
      } else {
        const d0 = Math.max(4, this.startPointer.distanceTo(this.pivotScreen));
        f = this.lastPointer.distanceTo(this.pivotScreen) / d0;
        if (this.mods.shift) f = 1 + (f - 1) * 0.1;
        if (snapOn) f = Math.round(f * 10) / 10; // 0.1 steps
      }
      const s = new THREE.Vector3(1, 1, 1);
      if (this.axis === 'none') s.setScalar(f);
      else if (this.planeLock) { s.setScalar(f); s[this.axis] = 1; }
      else s[this.axis] = f;
      this.info = `Scale: ${s.x.toFixed(2)} ${s.y.toFixed(2)} ${s.z.toFixed(2)}`;
      deltaM = new THREE.Matrix4()
        .makeTranslation(P.x, P.y, P.z)
        .multiply(new THREE.Matrix4().makeScale(Math.max(1e-4, Math.abs(s.x)) * Math.sign(s.x || 1),
          Math.max(1e-4, Math.abs(s.y)) * Math.sign(s.y || 1),
          Math.max(1e-4, Math.abs(s.z)) * Math.sign(s.z || 1)))
        .multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
    }
    if (this.numeric) this.info += `  [${this.numeric}]`;
    if (snapOn) this.info += '  🧲';
    this.onDelta?.(deltaM);
  }

  /** Magnet for moves: snap the moved pivot per the global snap mode. */
  private snapMoveDelta(ctx: AppCtx, d: THREE.Vector3): THREE.Vector3 {
    const mode = ctx.settings.snap.mode;
    const moved = this.pivot.clone().add(d);
    let target: THREE.Vector3 | null = null;
    if (mode === 'INCREMENT') {
      const g = ctx.settings.gridStep;
      target = new THREE.Vector3(
        Math.round(moved.x / g) * g, Math.round(moved.y / g) * g, Math.round(moved.z / g) * g);
    } else if (mode === 'POINT') {
      target = nearestStrokePoint(ctx, this.lastPointer.x, this.lastPointer.y, 40);
    } else if (mode === 'SURFACE' || mode === 'CANVAS') {
      const rect = ctx.canvas.getBoundingClientRect();
      target = raycastSurfaces(ctx, this.lastPointer.x + rect.left, this.lastPointer.y + rect.top);
    } else if (mode === 'OBJECT') {
      const dragging = new Set(this.refs.map((r) => `${r.kind}:${r.id}`));
      let bestD = Infinity;
      for (const ref of allRefs(ctx.scene)) {
        if (dragging.has(`${ref.kind}:${ref.id}`)) continue;
        const pos = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(ctx.scene, ref));
        const dist = pos.distanceTo(moved);
        if (dist < bestD && dist < 1.5) { bestD = dist; target = pos; }
      }
    }
    return target ? target.clone().sub(this.pivot) : d;
  }

  confirm(): void {
    this.active = false;
    this.info = '';
  }

  /** Esc/RMB: put every object back where it started. */
  restore(ctx: AppCtx): void {
    this.refs.forEach((ref, i) => {
      const t = this.base[i];
      if (t) setObjectTransform(ctx.scene, ref, t);
    });
  }

  cancel(ctx: AppCtx): void {
    this.restore(ctx);
    this.active = false;
    this.info = '';
  }

  private worldToScreen(ctx: AppCtx, v: THREE.Vector3): THREE.Vector2 {
    const rect = ctx.canvas.getBoundingClientRect();
    const p = v.clone().project(ctx.camera);
    return new THREE.Vector2((p.x * 0.5 + 0.5) * rect.width, (-p.y * 0.5 + 0.5) * rect.height);
  }

  /** Pointer ray ∩ the view-aligned plane through the pivot. */
  private viewPlaneHit(ctx: AppCtx, x: number, y: number): THREE.Vector3 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.camera);
    const n = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.pivot);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }
}
