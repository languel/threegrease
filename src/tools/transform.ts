import * as THREE from 'three';
import type { CanvasPlane, GPPoint, Vec3 } from '../core/types';
import { falloff } from '../core/mathutil';
import { snapIncrement, type AppCtx } from './context';
import { forEachEditableStroke, selectedPoints } from './select';
import { nearestStrokeEdgeAll, nearestStrokePointAll, nearestStrokeSegmentAll, objectToScreen, objectToWorld, perpendicularFoot, pickCanvas, raycastFaceTriangle, raycastSurfaces, screenToWorld, worldToObject } from './projection';
import { allRefs, worldMatrixOf, type ObjRef } from './objects';
import { basisFromNormal, constrainDelta, transformBasis, type Basis } from './orientation';

type TransformKind = 'move' | 'rotate' | 'scale' | 'shear';
type AxisLock = 'none' | 'x' | 'y' | 'z';

/** anything with a position: a GP point, or a poly-mesh vertex */
interface Affected { p: { co: Vec3 }; orig: Vec3; weight: number }
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
  /** Shift+axis: lock to the PLANE square to the axis instead of the axis */
  private axisPlane = false;
  /**
   * The basis a lock resolves in (tools/orientation.ts), frozen when the
   * gesture starts. GLOBAL — the default — is the identity, so the plain
   * world-axis behaviour this modal always had falls out unchanged.
   */
  private basis: Basis = new THREE.Matrix4();
  /** N / Shift+N: along, or square to, the ELEMENT's own normal */
  private normalLock: 'off' | 'axis' | 'plane' = 'off';
  /** what is being edited, and the normal of what is selected on it —
   *  supplied by the caller, which is the only one that knows (a mesh's
   *  selected faces, a stroke's plane) */
  editRef: ObjRef | null = null;
  editNormal: THREE.Vector3 | null = null;
  /** Ctrl held during the drag INVERTS the magnet, as everywhere else */
  snapInvert = false;
  /**
   * The space the affected points live in, local -> world. Null means the
   * active GP object's (a stroke edit); a mesh edit hands in the mesh's own
   * matrix, so the same modal moves, turns and scales mesh vertices.
   */
  private space: THREE.Matrix4 | null = null;
  /** called after every change (a poly mesh must bump its rev to redraw) */
  private onChange: (() => void) | null = null;
  active = false;

  private toWorld(ctx: AppCtx, co: Vec3): THREE.Vector3 {
    return this.space ? new THREE.Vector3(...co).applyMatrix4(this.space) : objectToWorld(ctx, co);
  }
  private toLocal(ctx: AppCtx, w: THREE.Vector3): Vec3 {
    if (!this.space) return worldToObject(ctx, w);
    const v = w.clone().applyMatrix4(this.space.clone().invert());
    return [v.x, v.y, v.z];
  }
  private toScreen(ctx: AppCtx, co: Vec3): THREE.Vector2 {
    if (!this.space) return objectToScreen(ctx, co);
    const rect = ctx.canvas.getBoundingClientRect();
    const v = this.toWorld(ctx, co).project(ctx.camera);
    return new THREE.Vector2((v.x * 0.5 + 0.5) * rect.width, (-v.y * 0.5 + 0.5) * rect.height);
  }

  /**
   * G / R / S on poly-mesh vertices: `verts` move, `others` are the rest of
   * the mesh (proportional editing pulls them in with falloff), `matrix` is
   * the mesh's local -> world. `undo: false` when the caller already pushed
   * one (extrude pushes before it builds, so extrude + grab is ONE step).
   */
  beginMesh(
    ctx: AppCtx, kind: TransformKind, pointer: { x: number; y: number },
    verts: { co: Vec3 }[], others: { co: Vec3 }[], matrix: THREE.Matrix4,
    onChange: () => void, undo = true,
  ): boolean {
    if (!verts.length) return false;
    if (undo) ctx.pushUndo();
    this.space = matrix.clone();
    this.onChange = onChange;
    this.canvases = [];
    this.kind = kind;
    this.axis = 'none';
    this.axisPlane = false;
    this.normalLock = 'off';
    this.basis = transformBasis(ctx, this.editRef, this.editNormal);
    this.startPointer.set(pointer.x, pointer.y);
    const median: Vec3 = [0, 0, 0];
    for (const v of verts) { median[0] += v.co[0]; median[1] += v.co[1]; median[2] += v.co[2]; }
    this.centerLocal = median.map((x) => x / verts.length) as Vec3;
    this.center = this.toScreen(ctx, this.centerLocal);
    this.affected = verts.map((v) => ({ p: v, orig: [...v.co] as Vec3, weight: 1 }));
    if (ctx.settings.propEdit.enabled) {
      const radius = ctx.settings.propEdit.radius;
      const sel = verts.map((v) => this.toScreen(ctx, v.co));
      for (const o of others) {
        const px = this.toScreen(ctx, o.co);
        const w = falloff(Math.min(...sel.map((q) => q.distanceTo(px))), radius);
        if (w > 0) this.affected.push({ p: o, orig: [...o.co] as Vec3, weight: w });
      }
    }
    this.active = true;
    return true;
  }

  begin(ctx: AppCtx, kind: TransformKind, pointer: { x: number; y: number }): boolean {
    this.space = null;
    this.onChange = null;
    this.axisPlane = false;
    const sel = selectedPoints(ctx);
    if (!sel.length) return this.beginCanvases(ctx, kind, pointer);
    ctx.pushUndo();
    this.canvases = [];
    this.kind = kind;
    this.axis = 'none';
    this.normalLock = 'off';
    this.basis = transformBasis(ctx, this.editRef, this.editNormal);
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
    this.center = this.toScreen(ctx, median);

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
          const px = this.toScreen(ctx, p.co);
          for (const { s: ss, index } of sel) {
            const d = this.toScreen(ctx, ss.points[index].co).distanceTo(px);
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
    if (!this.snapOn(ctx)) return delta;
    const moved: Vec3 = [
      this.centerLocal[0] + delta[0], this.centerLocal[1] + delta[1], this.centerLocal[2] + delta[2],
    ];
    let target: Vec3 | null = null;
    if (snap.mode === 'INCREMENT') {
      // relative: the delta itself moves in step multiples
      const g = snapIncrement(ctx.settings);
      return delta.map((v) => Math.round(v / g) * g) as Vec3;
    } else if (snap.mode === 'GRID') {
      const g = snapIncrement(ctx.settings);
      target = moved.map((v) => Math.round(v / g) * g) as Vec3;
    } else if (snap.mode === 'POINT') {
      const world = nearestStrokePointAll(ctx, pointer.x, pointer.y, 40, ctx.settings.snap.strokeScope ?? 'ANY');
      if (world) target = this.toLocal(ctx, world);
    } else if (snap.mode === 'EDGE' || snap.mode === 'EDGE_CENTER' || snap.mode === 'EDGE_PERP') {
      const seg = nearestStrokeSegmentAll(ctx, pointer.x, pointer.y, 40, ctx.settings.snap.strokeScope ?? 'ANY');
      if (seg) {
        const world = snap.mode === 'EDGE_CENTER' ? seg.a.clone().lerp(seg.b, 0.5)
          : snap.mode === 'EDGE_PERP' ? perpendicularFoot(seg.a, seg.b, this.toWorld(ctx, this.centerLocal))
          : seg.a.clone().lerp(seg.b, seg.t);
        target = this.toLocal(ctx, world);
      }
    } else if (snap.mode === 'FACE_CENTER' || snap.mode === 'FACE_NEAREST') {
      const rect = ctx.canvas.getBoundingClientRect();
      const hit = raycastFaceTriangle(ctx, pointer.x + rect.left, pointer.y + rect.top);
      if (hit) {
        const p = new THREE.Vector3();
        if (snap.mode === 'FACE_CENTER') hit.tri.getMidpoint(p);
        else hit.tri.closestPointToPoint(this.toWorld(ctx, this.centerLocal), p);
        target = this.toLocal(ctx, p);
      }
    } else if (snap.mode === 'SURFACE' || snap.mode === 'CANVAS') {
      const rect = ctx.canvas.getBoundingClientRect();
      const hit = raycastSurfaces(ctx, pointer.x + rect.left, pointer.y + rect.top)
        ?? pickCanvas(ctx, pointer.x, pointer.y)?.point;
      if (hit) target = this.toLocal(ctx, hit);
    } else if (snap.mode === 'OBJECT') {
      const rect = ctx.canvas.getBoundingClientRect();
      let best: THREE.Vector3 | null = null;
      let bestD = 40; // px
      for (const ref of allRefs(ctx.scene)) {
        const pos = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(ctx.scene, ref));
        const ndc = pos.clone().project(ctx.camera);
        if (ndc.z > 1) continue;
        const screen = new THREE.Vector2((ndc.x * 0.5 + 0.5) * rect.width, (-ndc.y * 0.5 + 0.5) * rect.height);
        const d = screen.distanceTo(pointer);
        if (d < bestD) { bestD = d; best = pos; }
      }
      if (best) target = this.toLocal(ctx, best);
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
      if (this.axis !== 'none') {
        // A lock is applied in WORLD space, through the current basis
        // (tools/orientation.ts): Global is the identity, so this is the
        // world-axis masking a mesh edit always did; Local, Normal, View,
        // Cursor and Parent are the same arithmetic in another frame, and
        // N / Shift+N is the element's own normal. Constraining the world
        // delta rather than the local one is what makes a stood-up
        // cylinder's Z still mean Z.
        const dw = constrainDelta(w1.clone().sub(w0), this.basis, this.axis, this.axisPlane);
        const c = this.toWorld(ctx, this.centerLocal);
        w0.copy(c.clone());
        w1.copy(c.add(dw));
      }
      const d0 = this.toLocal(ctx, w0), d1 = this.toLocal(ctx, w1);
      let delta: Vec3 = [d1[0] - d0[0], d1[1] - d0[1], d1[2] - d0[2]];
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
        const on = (k: AxisLock) => this.axis === 'none' || ((this.axis === k) !== this.axisPlane);
        if (on('x')) co[0] = this.centerLocal[0] + (a.orig[0] - this.centerLocal[0]) * s;
        if (on('y')) co[1] = this.centerLocal[1] + (a.orig[1] - this.centerLocal[1]) * s;
        if (on('z')) co[2] = this.centerLocal[2] + (a.orig[2] - this.centerLocal[2]) * s;
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
    this.onChange?.();
    ctx.requestRender();
  }

  /** Rotate around the view axis through the pivot. */
  private applyViewPlaneRotation(ctx: AppCtx, angle: number): void {
    const viewDir = ctx.camera.getWorldDirection(new THREE.Vector3());
    const pivotWorld = this.toWorld(ctx, this.centerLocal);
    const q = new THREE.Quaternion().setFromAxisAngle(viewDir, angle);
    for (const a of this.affected) {
      const w = this.toWorld(ctx, a.orig);
      const v = w.sub(pivotWorld).applyQuaternion(
        a.weight === 1 ? q : new THREE.Quaternion().setFromAxisAngle(viewDir, angle * a.weight),
      ).add(pivotWorld);
      a.p.co = this.toLocal(ctx, v);
    }
  }

  /** X / Y / Z lock to that axis, Shift+ to the plane square to it; the same
   *  key again frees it. */
  setAxis(axis: AxisLock, ctx: AppCtx, pointer: { x: number; y: number }, plane = false): void {
    if (!this.active) return;
    if (this.normalLock !== 'off') {
      // an axis key leaves the normal lock — they are the same slot
      this.normalLock = 'off';
      this.basis = transformBasis(ctx, this.editRef, this.editNormal);
    }
    const same = this.axis === axis && this.axisPlane === plane;
    this.axis = same ? 'none' : axis;
    this.axisPlane = same ? false : plane;
    this.update(ctx, pointer);
  }

  /** N / Shift+N: along the selected element's own NORMAL, or in the plane
   *  square to it. The same key again frees it. Pulling a face straight out
   *  of a surface is the move an axis lock cannot name once the surface is
   *  turned — and it is most of what blocking out a room consists of. */
  setNormal(ctx: AppCtx, pointer: { x: number; y: number }, plane = false): void {
    if (!this.active) return;
    const want = plane ? 'plane' : 'axis';
    if (this.normalLock === want) {
      this.normalLock = 'off';
      this.axis = 'none';
      this.axisPlane = false;
      this.basis = transformBasis(ctx, this.editRef, this.editNormal);
    } else {
      this.normalLock = want;
      const n = this.editNormal?.clone()
        // no element normal (a stroke selection): the space's own +Z, which
        // for a mesh is its local up and for a GP object its drawing plane
        ?? (this.space
          ? new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().extractRotation(this.space))
          : ctx.camera.getWorldDirection(new THREE.Vector3()).negate());
      this.basis = basisFromNormal(n);
      this.axis = 'z';
      this.axisPlane = plane;
    }
    this.update(ctx, pointer);
  }

  /** Is the magnet on for this gesture? Ctrl inverts it, the way it already
   *  does in the object modal — the same key doing the same thing in the
   *  other editor. */
  private snapOn(ctx: AppCtx): boolean {
    return ctx.settings.snap.enabled !== this.snapInvert;
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
    this.onChange?.();
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
