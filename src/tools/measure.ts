// Measure tool: rulers over the scene, in real units.
//
// This exists for blockout work. You bring in reference photographs of a
// room, build geometry against them by eye, and then need to know whether
// what you built is actually the size of the room — and, more often, to make
// it so. So the tool does two jobs:
//
//   1. report distances (and the angle at interior corners)
//   2. serve as the reference for "this segment is really 4.2 m", which
//      rescales the whole scene onto real units — see App.scaleSceneToMeasure
//
// Points snap through the shared magnet (tools/snapping.ts), so a ruler can
// land exactly on a vertex, an edge midpoint or the floor grid rather than
// wherever the pointer happened to be.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { Tool, ToolEvent } from './toolsys';
import type { LengthUnit, TGMeasure, Vec3 } from '../core/types';
import { objectToScreen } from './projection';
import { snapWorldPoint, SNAP_LABEL, type SnapKind } from './snapping';

/** grab radius for picking an existing measurement point, px */
const HANDLE_PX = 12;

/** How many world units one display unit is. The scene is metres. */
const PER_UNIT: Record<LengthUnit, number> = {
  M: 1, CM: 0.01, MM: 0.001, FT: 0.3048, IN: 0.0254,
};
const SUFFIX: Record<LengthUnit, string> = {
  M: 'm', CM: 'cm', MM: 'mm', FT: 'ft', IN: 'in',
};

/** World length -> display string. Precision follows the unit: millimetres
 *  never want decimals, metres usually want two. */
export function formatLength(world: number, unit: LengthUnit): string {
  const v = world / PER_UNIT[unit];
  const dp = unit === 'MM' ? 0 : unit === 'CM' || unit === 'IN' ? 1 : 2;
  return `${v.toFixed(dp)} ${SUFFIX[unit]}`;
}

/** Display value -> world length, for typed input. */
export function toWorldLength(value: number, unit: LengthUnit): number {
  return value * PER_UNIT[unit];
}

export function measureLength(m: TGMeasure): number {
  let total = 0;
  for (let i = 0; i < m.points.length - 1; i++) {
    total += new THREE.Vector3(...m.points[i]).distanceTo(new THREE.Vector3(...m.points[i + 1]));
  }
  return total;
}

let nextMeasureId = 1;
export function createMeasure(existing: TGMeasure[], points: Vec3[]): TGMeasure {
  nextMeasureId = Math.max(nextMeasureId, ...existing.map((m) => m.id), 0) + 1;
  return {
    id: nextMeasureId,
    name: `Measure ${existing.length + 1}`,
    points: points.map((p) => [...p] as Vec3),
    visible: true,
  };
}

export class MeasureTool implements Tool {
  id = 'measure';
  cursor = 'crosshair';

  /** the ruler being drawn, before it is committed to the scene */
  private draft: Vec3[] = [];
  /** live pointer position while drafting, so the last leg rubber-bands */
  private preview: THREE.Vector3 | null = null;
  private previewKind: SnapKind = 'FREE';
  /** dragging an existing point: [measureId, pointIndex] */
  private drag: { id: number; index: number } | null = null;

  /** Existing measurement point under the pointer, if any. */
  private pick(ctx: AppCtx, x: number, y: number): { id: number; index: number } | null {
    let best: { id: number; index: number } | null = null;
    let bestD = HANDLE_PX * HANDLE_PX;
    for (const m of ctx.scene.measures) {
      if (!m.visible || m.locked) continue;
      for (let i = 0; i < m.points.length; i++) {
        const s = objectToScreen(ctx, m.points[i]);
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < bestD) { bestD = d; best = { id: m.id, index: i }; }
      }
    }
    return best;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    // grab an existing point first — adjusting a ruler you already placed is
    // far more common than starting another one on top of it
    const hit = this.pick(ctx, e.x, e.y);
    if (hit && !this.draft.length) {
      ctx.pushUndo();
      this.drag = hit;
      return;
    }
    const snapped = snapWorldPoint(ctx, e.clientX, e.clientY);
    if (!snapped) return;
    this.draft.push([snapped.point.x, snapped.point.y, snapped.point.z]);
    ctx.requestRender();
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    const snapped = snapWorldPoint(ctx, e.clientX, e.clientY,
      this.drag ? new THREE.Vector3(...(
        ctx.scene.measures.find((m) => m.id === this.drag!.id)?.points[this.drag!.index] ?? [0, 0, 0]
      )) : undefined);
    if (!snapped) return;
    this.preview = snapped.point;
    this.previewKind = snapped.kind;
    if (this.drag) {
      const m = ctx.scene.measures.find((x) => x.id === this.drag!.id);
      if (m) {
        m.points[this.drag.index] = [snapped.point.x, snapped.point.y, snapped.point.z];
        ctx.requestRender();
      }
    }
  }

  onUp(_ctx: AppCtx, _e: ToolEvent): void { this.drag = null; }

  onKey(ctx: AppCtx, key: string): boolean {
    if (key === 'Escape') { this.cancel(ctx); return true; }
    if (key === 'Enter') { this.commit(ctx); return true; }
    // Backspace drops the last point rather than the whole ruler — a
    // three-point measurement is a lot of aiming to throw away over one miss
    if (key === 'Backspace' && this.draft.length) {
      this.draft.pop();
      ctx.requestRender();
      return true;
    }
    return false;
  }

  onCancel(ctx: AppCtx): void { this.cancel(ctx); }

  private cancel(ctx: AppCtx): void {
    this.draft = [];
    this.drag = null;
    ctx.requestRender();
  }

  /** Commit the draft. A single point is not a measurement, so it is
   *  discarded rather than saved as a degenerate one. */
  private commit(ctx: AppCtx): void {
    if (this.draft.length >= 2) {
      ctx.pushUndo();
      ctx.scene.measures.push(createMeasure(ctx.scene.measures, this.draft));
      ctx.refreshUI();
    }
    this.draft = [];
    ctx.requestRender();
  }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    const unit = ctx.settings.lengthUnit;
    hud.save();
    hud.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    hud.lineWidth = 1.5;
    hud.textBaseline = 'middle';

    for (const m of ctx.scene.measures) {
      if (m.visible) this.drawRuler(ctx, hud, m.points, unit, m.locked ? '#7f8c9a' : '#4dd0c7', false);
    }

    // the in-progress ruler, with the leg that follows the pointer
    if (this.draft.length) {
      const live = this.preview
        ? [...this.draft, [this.preview.x, this.preview.y, this.preview.z] as Vec3]
        : this.draft;
      this.drawRuler(ctx, hud, live, unit, '#ffc84d', true);
    }

    // name what the pointer is currently catching, so a snap is never a
    // silent surprise
    if (this.preview && (this.draft.length || this.drag)) {
      const label = SNAP_LABEL[this.previewKind];
      if (label) {
        const s = objectToScreen(ctx, [this.preview.x, this.preview.y, this.preview.z]);
        hud.fillStyle = '#ffc84d';
        hud.fillText(label, s.x + 12, s.y + 14);
      }
    }
    hud.restore();
  }

  private drawRuler(
    ctx: AppCtx, hud: CanvasRenderingContext2D, pts: Vec3[],
    unit: LengthUnit, color: string, dashed: boolean,
  ): void {
    if (pts.length < 2) {
      if (pts.length === 1) {
        const s = objectToScreen(ctx, pts[0]);
        hud.strokeStyle = color;
        hud.beginPath();
        hud.arc(s.x, s.y, 4, 0, Math.PI * 2);
        hud.stroke();
      }
      return;
    }
    const screen = pts.map((p) => objectToScreen(ctx, p));

    hud.strokeStyle = color;
    hud.setLineDash(dashed ? [5, 4] : []);
    hud.beginPath();
    hud.moveTo(screen[0].x, screen[0].y);
    for (let i = 1; i < screen.length; i++) hud.lineTo(screen[i].x, screen[i].y);
    hud.stroke();
    hud.setLineDash([]);

    for (const s of screen) {
      hud.beginPath();
      hud.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
      hud.stroke();
    }

    // per-segment length, written along the segment's midpoint
    for (let i = 0; i < pts.length - 1; i++) {
      const a = new THREE.Vector3(...pts[i]);
      const b = new THREE.Vector3(...pts[i + 1]);
      const mid = { x: (screen[i].x + screen[i + 1].x) / 2, y: (screen[i].y + screen[i + 1].y) / 2 };
      label(hud, formatLength(a.distanceTo(b), unit), mid.x, mid.y - 9, color);
    }

    // interior angles — squaring a room off photographs is mostly a question
    // of whether the corners are actually 90
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = new THREE.Vector3(...pts[i - 1]);
      const here = new THREE.Vector3(...pts[i]);
      const next = new THREE.Vector3(...pts[i + 1]);
      const u = prev.clone().sub(here);
      const v = next.clone().sub(here);
      if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) continue;
      const deg = THREE.MathUtils.radToDeg(u.angleTo(v));
      label(hud, `${deg.toFixed(1)}°`, screen[i].x + 10, screen[i].y - 10, color);
    }

    // running total, once it is actually a path rather than one segment
    if (pts.length > 2) {
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        total += new THREE.Vector3(...pts[i]).distanceTo(new THREE.Vector3(...pts[i + 1]));
      }
      const last = screen[screen.length - 1];
      label(hud, `Σ ${formatLength(total, unit)}`, last.x + 10, last.y + 12, color);
    }
  }
}

/** Text with a dark plate behind it, so a measurement stays readable over a
 *  bright reference photograph as well as over the dark viewport. */
function label(
  hud: CanvasRenderingContext2D, text: string, x: number, y: number, color: string,
): void {
  const w = hud.measureText(text).width;
  hud.fillStyle = 'rgba(12,14,18,0.72)';
  hud.fillRect(x - w / 2 - 4, y - 8, w + 8, 16);
  hud.fillStyle = color;
  hud.textAlign = 'center';
  hud.fillText(text, x, y);
  hud.textAlign = 'left';
}
