// Mesh Edit: Blender's edit mode for meshes — select vertices, edges or
// faces (click, Shift-click, drag a box), then G / R / S them through the
// same modal transform the stroke editor uses, E to extrude, F to fill, X to
// delete, A / Alt+A to select all / none. Works on a TGPolyMesh; a primitive
// (box, sphere, ...) is converted to one when Edit mode is entered on it.
//
// Selection is flushed between the three element kinds after every change
// (core/polyedit.ts), so a transform only ever has to read vertices.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { TGPolyMesh, Vec3 } from '../core/types';
import type { Tool, ToolEvent } from './toolsys';
import { getEdge, getFace, getVertex } from '../core/polymesh';
import {
  deleteSelection, extrudeSelection, fillSelection, flushSelection, selectAllElems, touchPolyMesh,
  type MeshSelectMode,
} from '../core/polyedit';
import { pickPolyEdge, pickPolyFace, pickPolyVertex } from './polypick';
import { worldMatrixOf } from './objects';
import { polyOverlay } from '../render/polymesh';

const VERTEX_PX = 14;
const EDGE_PX = 10;
const DRAG_PX = 4;

export class MeshEditTool implements Tool {
  id = 'meshedit';
  cursor = 'default';
  private down: { x: number; y: number; shift: boolean; ctrl: boolean } | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /**
   * Starts a G / R / S on the selection. The App owns the modal transform,
   * so it hands this in; `undo: false` when the caller has just pushed one
   * (E pushes before building, so extrude + grab is ONE undo step).
   */
  beginTransform: ((kind: 'move' | 'rotate' | 'scale', undo: boolean) => void) | null = null;

  editMesh(ctx: AppCtx): TGPolyMesh | null {
    return ctx.scene.polyMeshes.find((p) => p.id === polyOverlay.editMeshId) ?? null;
  }

  private mode(ctx: AppCtx): MeshSelectMode { return ctx.settings.meshSelectMode; }

  private screen(ctx: AppCtx, pm: TGPolyMesh): (co: Vec3) => THREE.Vector2 | null {
    const m = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id });
    const rect = ctx.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    return (co) => {
      v.set(...co).applyMatrix4(m).project(ctx.camera);
      if (v.z > 1) return null;
      return new THREE.Vector2((v.x * 0.5 + 0.5) * rect.width, (-v.y * 0.5 + 0.5) * rect.height);
    };
  }

  /** The element of the current select mode under (x, y), on the edit mesh. */
  private pick(ctx: AppCtx, pm: TGPolyMesh, x: number, y: number): { dim: 0 | 1 | 2; id: number } | null {
    const mode = this.mode(ctx);
    if (mode === 'VERTEX') {
      const v = pickPolyVertex(ctx, x, y, VERTEX_PX, pm.id);
      return v && v.meshId === pm.id ? { dim: 0, id: v.vertexId } : null;
    }
    if (mode === 'EDGE') {
      const e = pickPolyEdge(ctx, x, y, EDGE_PX, pm.id);
      return e && e.meshId === pm.id ? { dim: 1, id: e.edgeId } : null;
    }
    const f = pickPolyFace(ctx, x, y);
    return f && f.meshId === pm.id ? { dim: 2, id: f.faceId } : null;
  }

  private element(pm: TGPolyMesh, hit: { dim: 0 | 1 | 2; id: number }): { select?: boolean } | undefined {
    return hit.dim === 0 ? getVertex(pm, hit.id) : hit.dim === 1 ? getEdge(pm, hit.id) : getFace(pm, hit.id);
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    this.down = { x: e.x, y: e.y, shift: e.shift, ctrl: e.ctrl };
    this.box = null;
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    const pm = this.editMesh(ctx);
    if (!pm) return;
    if (this.down) {
      if (this.box || Math.hypot(e.x - this.down.x, e.y - this.down.y) > DRAG_PX) {
        this.box = { x0: this.down.x, y0: this.down.y, x1: e.x, y1: e.y };
      }
      return;
    }
    const hit = this.pick(ctx, pm, e.x, e.y);
    const was = polyOverlay.hover;
    polyOverlay.hover = hit ? { meshId: pm.id, ...hit } : null;
    if (was?.id !== polyOverlay.hover?.id || was?.dim !== polyOverlay.hover?.dim) touchPolyMesh(pm);
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    const pm = this.editMesh(ctx);
    const down = this.down;
    this.down = null;
    if (!pm || !down) { this.box = null; return; }
    ctx.pushUndo();
    const mode = this.mode(ctx);
    if (this.box) {
      const b = this.box;
      this.box = null;
      const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
      const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
      const toS = this.screen(ctx, pm);
      const inside = new Set(pm.vertices.filter((v) => {
        const s = toS(v.co);
        return !!s && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
      }).map((v) => v.id));
      // Blender's box-select operation from the top bar; Shift / Ctrl force
      // add / take away for this one drag
      const op = down.ctrl ? 'SUBTRACT' : down.shift ? 'EXTEND' : ctx.settings.selectOp;
      const apply = (el: { select?: boolean }, hit: boolean) => {
        if (op === 'SET') el.select = hit;
        else if (op === 'EXTEND') { if (hit) el.select = true; }
        else if (op === 'SUBTRACT') { if (hit) el.select = false; }
        else if (op === 'DIFFERENCE') { if (hit) el.select = !el.select; }
        else el.select = !!el.select && hit;
      };
      if (mode === 'VERTEX') for (const v of pm.vertices) apply(v, inside.has(v.id));
      else if (mode === 'EDGE') for (const ed of pm.edges) apply(ed, inside.has(ed.v[0]) && inside.has(ed.v[1]));
      else for (const f of pm.faces) apply(f, f.vertices.every((v) => inside.has(v)));
    } else {
      const hit = this.pick(ctx, pm, e.x, e.y);
      const el = hit && this.element(pm, hit);
      if (down.shift) {
        if (el) el.select = !el.select;
      } else {
        selectAllElems(pm, false, mode);
        if (el) el.select = true;
      }
    }
    flushSelection(pm, mode);
    ctx.refreshUI();
  }

  onCancel(): void { this.down = null; this.box = null; }

  onKey(ctx: AppCtx, key: string, e: KeyboardEvent): boolean {
    const pm = this.editMesh(ctx);
    if (!pm) return false;
    const mod = e.ctrlKey || e.metaKey;
    const k = key.toLowerCase();
    const mode = this.mode(ctx);
    const done = () => { touchPolyMesh(pm); ctx.requestRender(); ctx.refreshUI(); };
    if (k === 'a' && !mod) {
      ctx.pushUndo();
      selectAllElems(pm, !e.altKey, mode);
      done();
      return true;
    }
    if (k === 'i' && mod) {
      ctx.pushUndo();
      selectAllElems(pm, 'invert', mode);
      done();
      return true;
    }
    if ((k === 'x' && !mod) || key === 'Delete' || (key === 'Backspace' && !e.shiftKey)) {
      ctx.pushUndo();
      if (deleteSelection(pm, mode)) done();
      return true;
    }
    if (k === 'e' && !mod) {
      ctx.pushUndo();
      if (extrudeSelection(pm, mode)) { done(); this.beginTransform?.('move', false); }
      return true;
    }
    if (k === 'f' && !mod) {
      ctx.pushUndo();
      fillSelection(pm);
      flushSelection(pm, 'VERTEX');
      done();
      return true;
    }
    return false;
  }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    const pm = this.editMesh(ctx);
    if (!pm) return;
    // selected faces: the renderer tints vertices and edges, but a face has
    // no colour channel of its own, so the selection is filled in here
    const toS = this.screen(ctx, pm);
    hud.save();
    hud.fillStyle = 'rgba(255,122,0,0.22)';
    for (const f of pm.faces) {
      if (!f.select) continue;
      const pts = f.vertices.map((id) => { const v = getVertex(pm, id); return v ? toS(v.co) : null; });
      if (pts.some((p) => !p)) continue;
      hud.beginPath();
      pts.forEach((p, i) => (i ? hud.lineTo(p!.x, p!.y) : hud.moveTo(p!.x, p!.y)));
      hud.closePath();
      hud.fill();
    }
    if (this.box) {
      const b = this.box;
      hud.strokeStyle = 'rgba(255,255,255,0.8)';
      hud.setLineDash([4, 3]);
      hud.lineWidth = 1;
      hud.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    hud.restore();
  }
}
