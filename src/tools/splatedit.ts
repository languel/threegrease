// EDIT MODE ON A SPLAT: pick splats by box, lasso or circle, then delete
// them. The cloud is a million points with no topology, so selection is
// purely screen-space — every shown centre is projected once per gesture
// (not per pointer move) and tested against the shape — and it goes
// THROUGH the cloud, the way Blender's X-ray box select does: a scan's
// floaters are exactly the splats hiding behind the surface you can see.
//
// Selection is RUNTIME state (SplatEditState.sel), like a mesh's. Deletion
// is scene data (TGSplat.removed, see splats/edit.ts) and goes through
// undo like any other edit.
import * as THREE from 'three';
import type { Tool, ToolEvent } from './toolsys';
import type { AppCtx } from './context';
import type { TGSplat } from '../core/types';
import type { SplatManager, SplatEditState } from '../splats/index';
import { decodeRemoved, encodeRemoved } from '../splats/edit';
import { worldMatrixOf } from './objects';
import { drawLasso, pointInPolygon } from './draw';

let source: SplatManager | null = null;
/** Wired once from App init, like splatpick's source. */
export function setSplatEditSource(mgr: SplatManager): void { source = mgr; }

export type SplatSelectKind = 'BOX' | 'LASSO' | 'CIRCLE';
type Op = 'SET' | 'EXTEND' | 'SUBTRACT' | 'DIFFERENCE' | 'INTERSECT';

export class SplatEditTool implements Tool {
  id: string;
  cursor = 'crosshair';
  /** the splat being edited (App sets it on entering Edit mode) */
  targetId: number | null = null;
  private kind: SplatSelectKind;
  private mode: 'none' | 'box' | 'lasso' | 'circle' = 'none';
  private start = new THREE.Vector2();
  private lasso: THREE.Vector2[] = [];
  private radius = 40;
  private dragged = false;
  private op: Op = 'SET';

  constructor(id: string, kind: SplatSelectKind) {
    this.id = id;
    this.kind = kind;
  }

  private target(ctx: AppCtx): { data: TGSplat; st: SplatEditState } | null {
    if (this.targetId === null || !source) return null;
    const data = ctx.scene.splats.find((s) => s.id === this.targetId);
    const st = data ? source.editState(data.id) : null;
    return data && st ? { data, st } : null;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    this.start.set(e.x, e.y);
    this.dragged = false;
    // Shift / Ctrl force Extend / Subtract for one drag, as everywhere else
    this.op = e.shift ? 'EXTEND' : e.ctrl ? 'SUBTRACT' : ctx.settings.selectOp;
    if (this.kind === 'CIRCLE') {
      this.mode = 'circle';
      if (this.op === 'SET') this.clear(ctx);
      this.paintCircle(ctx, e);
    } else if (this.kind === 'LASSO') {
      this.mode = 'lasso';
      this.lasso = [new THREE.Vector2(e.x, e.y)];
    } else {
      this.mode = 'box';
    }
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (this.mode === 'none') return;
    if (Math.hypot(e.x - this.start.x, e.y - this.start.y) > 4) this.dragged = true;
    if (this.mode === 'lasso') this.lasso.push(new THREE.Vector2(e.x, e.y));
    if (this.mode === 'circle') this.paintCircle(ctx, e);
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    const mode = this.mode;
    this.mode = 'none';
    if (mode === 'none' || mode === 'circle') { ctx.refreshUI(); return; }
    if (!this.dragged) {
      this.clickSelect(ctx, e);
    } else if (mode === 'box') {
      const x0 = Math.min(this.start.x, e.x), x1 = Math.max(this.start.x, e.x);
      const y0 = Math.min(this.start.y, e.y), y1 = Math.max(this.start.y, e.y);
      this.region(ctx, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    } else if (mode === 'lasso' && this.lasso.length > 2) {
      const poly = this.lasso;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      const v = new THREE.Vector2();
      // bounds first: the polygon test is the expensive half
      this.region(ctx, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && pointInPolygon(v.set(x, y), poly));
    }
    this.lasso = [];
    ctx.refreshUI();
  }

  onCancel(): void { this.mode = 'none'; this.lasso = []; }

  onKey(ctx: AppCtx, key: string, e: KeyboardEvent): boolean {
    const t = this.target(ctx);
    if (!t) return false;
    const k = key.toLowerCase();
    if (k === 'a' && !e.metaKey && !e.ctrlKey) {
      this.setAll(ctx, e.altKey ? 0 : 1);
      return true;
    }
    if (k === 'i' && (e.metaKey || e.ctrlKey)) { this.invert(ctx); return true; }
    if (k === 'x' || key === 'Delete' || key === 'Backspace') { this.deleteSelected(ctx); return true; }
    if (this.kind === 'CIRCLE' && (key === '[' || key === ']')) {
      this.radius = Math.max(6, this.radius + (key === ']' ? 8 : -8));
      return true;
    }
    return false;
  }

  drawHud(_ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    const ptr = (hud.canvas as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer;
    if (this.mode === 'lasso') drawLasso(hud, this.lasso);
    if (this.mode === 'box' && this.dragged && ptr) {
      hud.strokeStyle = 'rgba(255,255,255,0.8)';
      hud.setLineDash([4, 4]);
      hud.strokeRect(this.start.x, this.start.y, ptr.x - this.start.x, ptr.y - this.start.y);
      hud.setLineDash([]);
    }
    if (this.kind === 'CIRCLE' && ptr) {
      hud.beginPath();
      hud.arc(ptr.x, ptr.y, this.radius, 0, Math.PI * 2);
      hud.strokeStyle = 'rgba(255,255,255,0.6)';
      hud.stroke();
    }
  }

  // ---------------------------------------------------------------- ops

  /** Select everything shown (1) or nothing (0). */
  setAll(ctx: AppCtx, v: 0 | 1): void {
    const t = this.target(ctx);
    if (!t) return;
    for (let i = 0; i < t.st.n; i++) t.st.sel[i] = v && t.st.alive[i] ? 1 : 0;
    this.commit(ctx);
  }

  invert(ctx: AppCtx): void {
    const t = this.target(ctx);
    if (!t) return;
    for (let i = 0; i < t.st.n; i++) t.st.sel[i] = t.st.alive[i] && !t.st.sel[i] ? 1 : 0;
    this.commit(ctx);
  }

  /** Remove the selected splats from the cloud (undoable). */
  deleteSelected(ctx: AppCtx): number {
    const t = this.target(ctx);
    if (!t || !t.st.selCount) return 0;
    ctx.pushUndo();
    const mask = decodeRemoved(t.data.removed, t.st.n);
    let c = 0;
    for (let i = 0; i < t.st.n; i++) {
      // shown OR hidden by a filter — Select filtered picks the hidden ones
      if (t.st.sel[i] && !mask[i]) { mask[i] = 1; c++; }
      t.st.sel[i] = 0;
    }
    t.data.removed = encodeRemoved(mask);
    this.commit(ctx);
    return c;
  }

  private commit(ctx: AppCtx): void {
    if (this.targetId !== null) source?.touchSelection(this.targetId);
    ctx.refreshUI();
  }

  private clear(ctx: AppCtx): void {
    const t = this.target(ctx);
    if (t) t.st.sel.fill(0);
  }

  /**
   * Project every shown centre once and hand the pixel to `test`. A plain
   * loop over one composed matrix, not Vector3.project per point: at a
   * million splats the allocation alone would be the gesture's whole cost.
   */
  private project(ctx: AppCtx, t: { data: TGSplat; st: SplatEditState },
    each: (i: number, x: number, y: number, depth: number) => void): void {
    const rect = ctx.canvas.getBoundingClientRect();
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const m = new THREE.Matrix4()
      .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      .multiply(worldMatrixOf(ctx.scene, { kind: 'SPLAT', id: t.data.id }));
    const e = m.elements;
    const c = t.st.centers;
    const hw = rect.width / 2, hh = rect.height / 2;
    for (let i = 0; i < t.st.n; i++) {
      if (!t.st.alive[i]) continue;
      const x = c[i * 3], y = c[i * 3 + 1], z = c[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-6) continue; // behind the eye
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      const nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
      if (nz > 1 || nz < -1) continue;
      each(i, (nx + 1) * hw, (1 - ny) * hh, nz);
    }
  }

  private region(ctx: AppCtx, inside: (x: number, y: number) => boolean): void {
    const t = this.target(ctx);
    if (!t) return;
    const hit = new Uint8Array(t.st.n);
    this.project(ctx, t, (i, x, y) => { if (inside(x, y)) hit[i] = 1; });
    this.combine(t.st, hit);
    this.commit(ctx);
  }

  private combine(st: SplatEditState, hit: Uint8Array): void {
    const s = st.sel;
    for (let i = 0; i < st.n; i++) {
      switch (this.op) {
        case 'SET': s[i] = hit[i]; break;
        case 'EXTEND': s[i] = s[i] | hit[i]; break;
        case 'SUBTRACT': s[i] = s[i] & (hit[i] ^ 1); break;
        case 'DIFFERENCE': s[i] = s[i] ^ hit[i]; break;
        case 'INTERSECT': s[i] = s[i] & hit[i]; break;
      }
    }
  }

  /** A click takes the nearest shown splat within 12 px — the FRONT one
   *  when several are that close, since a click means what you can see. */
  private clickSelect(ctx: AppCtx, e: ToolEvent): void {
    const t = this.target(ctx);
    if (!t) return;
    let best = -1, bestD = 12, bestZ = Infinity;
    this.project(ctx, t, (i, x, y, z) => {
      const d = Math.hypot(x - e.x, y - e.y);
      if (d < bestD - 3 || (d < 12 && Math.abs(d - bestD) <= 3 && z < bestZ)) { best = i; bestD = d; bestZ = z; }
    });
    const hit = new Uint8Array(t.st.n);
    if (best >= 0) hit[best] = 1;
    // a click with nothing under it and no modifier clears, as in Blender
    this.combine(t.st, hit);
    this.commit(ctx);
  }

  private paintCircle(ctx: AppCtx, e: ToolEvent): void {
    const t = this.target(ctx);
    if (!t) return;
    const r2 = this.radius * this.radius;
    const v = this.op === 'SUBTRACT' ? 0 : 1;
    this.project(ctx, t, (i, x, y) => {
      if ((x - e.x) ** 2 + (y - e.y) ** 2 <= r2) t.st.sel[i] = v;
    });
    if (this.targetId !== null) source?.touchSelection(this.targetId);
  }
}
