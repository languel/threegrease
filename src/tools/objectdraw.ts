// Draw an OBJECT where it goes, instead of adding one at the origin and
// then moving it.
//
// Blocking out a set is the same gesture as drawing it: you point at the
// floor and drag out the footprint, at a wall and drag out the panel. Add ▸
// Box gives you a cube at the 3D cursor that then has to be moved, turned
// and scaled into place — three operations to say one thing. These tools
// resolve every point through the SAME chain a stroke does (Placement,
// Plane, Guide, the magnet), so a wall drawn with Plane: Up from Ground
// stands on the floor, a panel drawn under Placement: Surface lies on the
// scan, and a box drawn with the grid magnet on lands on the grid.
//
// Three gestures, by what the thing is:
//   PLANE / RECT / TRIANGLE / POLYGON — one drag, flat in the drawing plane
//   BOX / CYLINDER / PYRAMID          — drag the base, then move away from
//                                       the plane to raise the height
//   SPHERE and the platonic solids    — one drag from the centre: a radius
//
// The flat n-gons (triangle, rect, polygon) are EDITABLE meshes rather than
// primitives, because the next thing you do to a blockout panel is drag one
// of its corners onto the real corner of the room.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { TGMesh, TGPolyMesh, Vec3 } from '../core/types';
import type { Tool, ToolEvent } from './toolsys';
import { addFace, addVertex, createPolyMesh, touchPolyMesh } from '../core/polymesh';
import { currentStickyPlane, drawingPlane, reseatStickyPlane, screenToWorld, setStrokeExclusion } from './projection';
import { magnetPoint } from './snapping';

export type ObjectDrawKind =
  | 'PLANE' | 'BOX' | 'CYLINDER' | 'PYRAMID' | 'SPHERE'
  | 'TETRA' | 'OCTA' | 'DODECA' | 'ICOSA'
  | 'TRIANGLE' | 'RECT' | 'POLYGON';

/** Drawn from the centre outward as a radius (one drag), and set down ON the
 *  drawing plane rather than sunk half-way into it. */
const RADIAL = new Set<ObjectDrawKind>(['SPHERE', 'TETRA', 'OCTA', 'DODECA', 'ICOSA']);
/** Base drag, then a second move that raises the height along the normal. */
const RAISED = new Set<ObjectDrawKind>(['BOX', 'CYLINDER', 'PYRAMID']);
/** An editable mesh (a flat face), not a primitive. */
const NGON = new Set<ObjectDrawKind>(['TRIANGLE', 'RECT', 'POLYGON']);

/** What the App has to do for the tool: the scene's ids, the renderers and
 *  the outliner all belong to it. */
export interface ObjectDrawHost {
  addMesh(m: TGMesh): TGMesh;
  addPoly(p: TGPolyMesh): TGPolyMesh;
  /** geometry changed mid-drag: re-sync the renderers */
  changed(): void;
  /** finished (or cancelled with `null`): select it, refresh, one undo step */
  finished(made: { kind: 'MESH' | 'POLY'; id: number } | null): void;
}

/** The plane's own axes: `v` is the up axis laid into it (so on a wall it is
 *  straight up), `u` runs across, `n` is its normal. The same basis the
 *  shape tools build a rectangle in, so a drawn plane and a drawn box agree. */
function planeAxes(ctx: AppCtx, plane: THREE.Plane): { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3 } {
  const n = plane.normal.clone().normalize();
  const up = ctx.settings.upAxis === 'Z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const v = up.clone().addScaledVector(n, -up.dot(n));
  if (v.lengthSq() < 1e-6) {
    const u = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x).normalize();
    return { u, v: new THREE.Vector3().crossVectors(n, u).normalize(), n };
  }
  v.normalize();
  return { u: new THREE.Vector3().crossVectors(v, n).normalize(), v, n };
}

interface Draft {
  mesh: TGMesh | null;
  poly: TGPolyMesh | null;
  origin: THREE.Vector3;
  axes: { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3 };
  /** half-extents across the plane (a radius, for the radial kinds) */
  du: number;
  dv: number;
  corner: THREE.Vector3 | null;
  raising: boolean;
  height: number;
}

export class ObjectDrawTool implements Tool {
  id: string;
  cursor = 'crosshair';
  readonly kind: ObjectDrawKind;
  private draft: Draft | null = null;
  private shift = false;
  host: ObjectDrawHost | null = null;

  constructor(kind: ObjectDrawKind) {
    this.kind = kind;
    this.id = `draw-${kind.toLowerCase()}`;
  }

  private point(ctx: AppCtx, e: ToolEvent, first = false): THREE.Vector3 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const w = screenToWorld(ctx, e.x + rect.left, e.y + rect.top);
    if (!w) return null;
    if (e.ctrl) return w;                      // Cmd/Ctrl: no magnet, as on a shape
    const m = magnetPoint(ctx, e.x + rect.left, e.y + rect.top, w, first);
    if (m && first) reseatStickyPlane(m);      // Up from Ground stands on where it landed
    return m ?? w;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    this.shift = e.shift;
    if (this.draft?.raising) { this.finish(ctx); return; }   // a second click ends a height
    // a sticky-plane session, so Up from Ground / View at Origin capture
    // their plane from this first point (the same one a stroke opens)
    setStrokeExclusion(-1);
    const origin = this.point(ctx, e, true);
    if (!origin) { setStrokeExclusion(null); return; }
    const axes = planeAxes(ctx, currentStickyPlane() ?? drawingPlane(ctx));
    const d: Draft = { mesh: null, poly: null, origin, axes, du: 0, dv: 0, corner: null, raising: false, height: 0 };
    if (NGON.has(this.kind)) {
      const pm = createPolyMesh(0, this.kind.toLowerCase(), [origin.x, origin.y, origin.z]);
      const e2 = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(axes.u, axes.v, axes.n));
      pm.rotation = [e2.x, e2.y, e2.z];
      d.poly = this.host?.addPoly(pm) ?? pm;
    } else {
      d.mesh = this.host?.addMesh(this.makeMesh(origin, axes)) ?? null;
    }
    this.draft = d;
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    const d = this.draft;
    if (!d) return;
    this.shift = e.shift;
    if (d.raising) {
      const h = this.heightAt(ctx, e, d);
      if (h !== null) { d.height = h; this.shape(ctx, d); this.host?.changed(); }
      return;
    }
    const p = this.point(ctx, e);
    if (!p) return;
    const rel = p.clone().sub(d.origin);
    d.du = Math.abs(rel.dot(d.axes.u));
    d.dv = Math.abs(rel.dot(d.axes.v));
    if (RADIAL.has(this.kind) || this.kind === 'TRIANGLE' || this.kind === 'POLYGON') {
      // drawn from the centre: one radius
      d.du = d.dv = Math.max(Math.hypot(d.du, d.dv), 1e-4);
    } else if (this.shift) {
      d.du = d.dv = Math.max(d.du, d.dv);
    }
    d.corner = p;
    this.shape(ctx, d);
    this.host?.changed();
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    void e;
    const d = this.draft;
    if (!d || d.raising) return;
    if (d.du < 1e-3 && d.dv < 1e-3) { this.cancel(ctx); return; }   // a click, not a drag
    if (RAISED.has(this.kind)) { d.raising = true; return; }
    this.finish(ctx);
  }

  onKey(ctx: AppCtx, key: string): boolean {
    if (!this.draft) return false;
    if (key === 'Escape') { this.cancel(ctx); return true; }
    if (key === 'Enter') { this.finish(ctx); return true; }
    return false;
  }

  onCancel(ctx: AppCtx): void { if (this.draft && !this.draft.raising) this.cancel(ctx); }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    const d = this.draft;
    if (!d) return;
    const size = RADIAL.has(this.kind) || this.kind === 'TRIANGLE' || this.kind === 'POLYGON'
      ? `r ${d.du.toFixed(2)} m`
      : `${(d.du * 2).toFixed(2)} × ${(d.dv * 2).toFixed(2)} m`
        + (RAISED.has(this.kind) ? ` × ${Math.abs(d.height).toFixed(2)}` : '');
    const text = d.raising ? `${size} · move to raise, click to finish` : size;
    const { x, y } = (hud.canvas as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer ?? { x: 0, y: 0 };
    hud.save();
    hud.font = '11px ui-monospace, monospace';
    const w = hud.measureText(text).width + 12;
    hud.fillStyle = 'rgba(20,20,22,0.85)';
    hud.fillRect(x + 14, y - 26, w, 18);
    hud.fillStyle = '#e8e8ec';
    hud.fillText(text, x + 20, y - 13);
    hud.restore();
  }

  // ---- geometry ------------------------------------------------------------

  private makeMesh(at: THREE.Vector3, axes: { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3 }): TGMesh {
    const { u, v, n } = axes;
    // CYLINDER and PYRAMID are built Y-UP (their axis is their own Y), so
    // they stand their Y on the plane's normal; everything else keeps the
    // plane's own basis, which puts a PLANE's +Z normal on it
    const m = this.kind === 'CYLINDER' || this.kind === 'PYRAMID'
      ? new THREE.Matrix4().makeBasis(u, n, new THREE.Vector3().crossVectors(u, n))
      : new THREE.Matrix4().makeBasis(u, v, n);
    const e = new THREE.Euler().setFromRotationMatrix(m);
    return {
      id: 0, name: this.kind.toLowerCase(), kind: this.kind as TGMesh['kind'],
      translation: [at.x, at.y, at.z], rotation: [e.x, e.y, e.z], scale: [0.001, 0.001, 0.001],
      visible: true, select: false, drawTarget: true, wireframe: false,
      color: [0.62, 0.65, 0.72], opacity: 1,
      parent: null, texture: null, unlit: false, doubleSided: true, billboard: 'NONE',
      originOffset: [0, 0, 0],
    };
  }

  /** Where the thing sits: between the two dragged corners for a footprint,
   *  at the centre for a radius — and never sunk into the plane, so a solid
   *  rests ON it. */
  private centreOf(d: Draft): THREE.Vector3 {
    const { u, v, n } = d.axes;
    const c = d.origin.clone();
    if (!RADIAL.has(this.kind) && this.kind !== 'TRIANGLE' && this.kind !== 'POLYGON' && d.corner) {
      const rel = d.corner.clone().sub(d.origin);
      c.addScaledVector(u, Math.sign(rel.dot(u) || 1) * d.du);
      c.addScaledVector(v, Math.sign(rel.dot(v) || 1) * d.dv);
    }
    if (RADIAL.has(this.kind)) c.addScaledVector(n, d.du);              // resting on it
    else if (RAISED.has(this.kind)) c.addScaledVector(n, d.height / 2); // base on it
    return c;
  }

  private shape(ctx: AppCtx, d: Draft): void {
    if (d.poly) { this.shapeNgon(ctx, d); return; }
    const mesh = d.mesh;
    if (!mesh) return;
    const c = this.centreOf(d);
    mesh.translation = [c.x, c.y, c.z];
    const h = Math.max(Math.abs(d.height), 1e-3);
    const w = Math.max(d.du * 2, 1e-3), t = Math.max(d.dv * 2, 1e-3);
    switch (this.kind) {
      // PLANE spans -1..1, so its scale IS its half size
      case 'PLANE': mesh.scale = [Math.max(d.du, 1e-3), Math.max(d.dv, 1e-3), 1]; break;
      case 'BOX': mesh.scale = [w, t, h]; break;
      // built Y-up: 1 across, 1.2 tall for a cylinder, 1 tall for a pyramid
      case 'CYLINDER': mesh.scale = [w, h / 1.2, t]; break;
      case 'PYRAMID': mesh.scale = [w, h, t]; break;
      // unit-diameter solids: the drag is a radius
      default: mesh.scale = [d.du * 2, d.du * 2, d.du * 2];
    }
  }

  /** A flat face as an editable mesh: its corners in the plane, in the
   *  mesh's own space (which the plane's basis already carries). */
  private shapeNgon(ctx: AppCtx, d: Draft): void {
    const pm = d.poly!;
    const c = this.centreOf(d);
    pm.translation = [c.x, c.y, c.z];
    const sides = this.kind === 'TRIANGLE' ? 3
      : this.kind === 'RECT' ? 4
      : Math.max(3, Math.round(ctx.settings.polygonSides ?? 6));
    const pts: [number, number][] = [];
    if (this.kind === 'RECT') {
      pts.push([-d.du, -d.dv], [d.du, -d.dv], [d.du, d.dv], [-d.du, d.dv]);
    } else {
      // a regular n-gon in the circle the drag swept, flat side down so a
      // triangle reads as a triangle rather than as a tipped-over one
      const turn = Math.PI / 2 + (sides % 2 ? 0 : Math.PI / sides);
      for (let i = 0; i < sides; i++) {
        const a = turn + (i / sides) * Math.PI * 2;
        pts.push([Math.cos(a) * d.du, Math.sin(a) * d.du]);
      }
    }
    pm.vertices = []; pm.edges = []; pm.faces = []; pm.nextElemId = 1;
    const ids = pts.map(([x, y]) => addVertex(pm, [x, y, 0] as Vec3).id);
    addFace(pm, ids);
    touchPolyMesh(pm);
  }

  /**
   * How far the pointer is from the drawing plane, along its normal: the
   * closest point on the line through the base to the pointer's ray (the
   * skew-line solve the axis locks use). A plane hit cannot answer this —
   * the height runs along the view as often as across it.
   */
  private heightAt(ctx: AppCtx, e: ToolEvent, d: Draft): number | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.x / rect.width) * 2 - 1, -(e.y / rect.height) * 2 + 1), ctx.camera);
    const base = this.centreOf({ ...d, height: 0 });
    const dir = d.axes.n;
    const w0 = base.clone().sub(ray.ray.origin);
    const b = dir.dot(ray.ray.direction);
    const den = 1 - b * b;
    if (den < 1e-6) return null;
    let t = (b * ray.ray.direction.dot(w0) - dir.dot(w0)) / den;
    const snap = ctx.settings.snap;
    if (snap.enabled && (snap.mode === 'INCREMENT' || snap.mode === 'GRID')) {
      const g = ctx.settings.gridStep / Math.max(1, ctx.settings.gridSubdivisions);
      t = Math.round(t / g) * g;
    }
    return t;
  }

  private finish(ctx: AppCtx): void {
    const d = this.draft;
    this.draft = null;
    setStrokeExclusion(null);
    if (!d) return;
    this.host?.finished(d.poly ? { kind: 'POLY', id: d.poly.id } : d.mesh ? { kind: 'MESH', id: d.mesh.id } : null);
    ctx.refreshUI();
  }

  private cancel(ctx: AppCtx): void {
    const d = this.draft;
    this.draft = null;
    setStrokeExclusion(null);
    if (!d) return;
    if (d.mesh) ctx.scene.meshes = ctx.scene.meshes.filter((m) => m.id !== d.mesh!.id);
    if (d.poly) ctx.scene.polyMeshes = ctx.scene.polyMeshes.filter((p) => p.id !== d.poly!.id);
    this.host?.finished(null);
    ctx.refreshUI();
  }
}
