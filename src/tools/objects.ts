// Object mode (unified): one selection/transform model over GP objects,
// canvas planes, splats, and mesh objects — now with parenting.
// ObjRef.id is STABLE for every kind (GPObject.id, not its array index).
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { GPScene, ParentRef, Vec3 } from '../core/types';
import { frameAt } from '../core/gpdata';
import { objectToScreen, pickCanvas } from './projection';
import type { Tool, ToolEvent } from './toolsys';
import { drawLasso, pointInPolygon } from './draw';

export type ObjKind = 'GP' | 'CANVAS' | 'SPLAT' | 'MESH' | 'TRIGGER' | 'STREAM' | 'POLY' | 'PCLOUD' | 'LIGHT' | 'ACTOR';
export interface ObjRef { kind: ObjKind; id: number }

export function gpIndexOf(scene: GPScene, id: number): number {
  return scene.objects.findIndex((o) => o.id === id);
}

export function listSelected(scene: GPScene): ObjRef[] {
  const out: ObjRef[] = [];
  for (const ob of scene.objects) if (ob.select) out.push({ kind: 'GP', id: ob.id });
  for (const c of scene.canvases) if (c.select) out.push({ kind: 'CANVAS', id: c.id });
  for (const s of scene.splats) if (s.select) out.push({ kind: 'SPLAT', id: s.id });
  for (const m of scene.meshes) if (m.select) out.push({ kind: 'MESH', id: m.id });
  for (const t of scene.score.triggers) if (t.select) out.push({ kind: 'TRIGGER', id: t.id });
  for (const st of scene.mmStreams) if (st.select) out.push({ kind: 'STREAM', id: st.id });
  for (const p of scene.polyMeshes) if (p.select) out.push({ kind: 'POLY', id: p.id });
  for (const pc of scene.paintClouds) if (pc.select) out.push({ kind: 'PCLOUD', id: pc.id });
  for (const l of scene.lights) if (l.select) out.push({ kind: 'LIGHT', id: l.id });
  for (const a of scene.actors) if (a.select) out.push({ kind: 'ACTOR', id: a.id });
  return out;
}

export function deselectAllObjects(scene: GPScene): void {
  for (const ob of scene.objects) ob.select = false;
  for (const c of scene.canvases) c.select = false;
  for (const s of scene.splats) s.select = false;
  for (const m of scene.meshes) m.select = false;
  for (const t of scene.score.triggers) t.select = false;
  for (const st of scene.mmStreams) st.select = false;
  for (const p of scene.polyMeshes) p.select = false;
  for (const pc of scene.paintClouds) pc.select = false;
  for (const l of scene.lights) l.select = false;
  for (const a of scene.actors) a.select = false;
}

function entityOf(scene: GPScene, ref: ObjRef):
  | { select?: boolean; parent?: ParentRef | null; name: string } | undefined {
  if (ref.kind === 'GP') return scene.objects.find((o) => o.id === ref.id);
  if (ref.kind === 'CANVAS') return scene.canvases.find((c) => c.id === ref.id);
  if (ref.kind === 'SPLAT') return scene.splats.find((s) => s.id === ref.id);
  if (ref.kind === 'TRIGGER') return scene.score.triggers.find((t) => t.id === ref.id);
  if (ref.kind === 'STREAM') return scene.mmStreams.find((st) => st.id === ref.id);
  if (ref.kind === 'POLY') return scene.polyMeshes.find((p) => p.id === ref.id);
  if (ref.kind === 'PCLOUD') return scene.paintClouds.find((pc) => pc.id === ref.id);
  if (ref.kind === 'LIGHT') return scene.lights.find((l) => l.id === ref.id);
  if (ref.kind === 'ACTOR') return scene.actors.find((a) => a.id === ref.id);
  return scene.meshes.find((m) => m.id === ref.id);
}

export function setObjectSelected(scene: GPScene, ref: ObjRef, v: boolean): void {
  const e = entityOf(scene, ref);
  if (e) e.select = v;
}

export function isObjectSelected(scene: GPScene, ref: ObjRef): boolean {
  return !!entityOf(scene, ref)?.select;
}

/** Outliner lock icon: blocks viewport click/box-select (still selectable
 *  from the outliner row itself, Blender-style — lock guards against
 *  accidental clicks, not against every path to selection). */
export function isObjectLocked(scene: GPScene, ref: ObjRef): boolean {
  return !!(entityOf(scene, ref) as { lock?: boolean } | undefined)?.lock;
}

export function objectName(scene: GPScene, ref: ObjRef): string {
  return entityOf(scene, ref)?.name ?? `${ref.kind} ${ref.id}`;
}

export interface ObjTransform { translation: Vec3; rotation: Vec3; scale: Vec3 }

export function getObjectTransform(scene: GPScene, ref: ObjRef): ObjTransform | null {
  if (ref.kind === 'GP') {
    const ob = scene.objects.find((o) => o.id === ref.id);
    return ob ? { translation: [...ob.translation], rotation: [...ob.rotation], scale: [...ob.scale] } : null;
  }
  if (ref.kind === 'CANVAS') {
    const c = scene.canvases.find((x) => x.id === ref.id);
    return c ? { translation: [...c.translation], rotation: [...c.rotation], scale: [c.size[0], c.size[1], 1] } : null;
  }
  if (ref.kind === 'SPLAT') {
    const s = scene.splats.find((x) => x.id === ref.id);
    return s ? { translation: [...s.translation], rotation: [...s.rotation], scale: [s.scale, s.scale, s.scale] } : null;
  }
  if (ref.kind === 'TRIGGER') {
    const t = scene.score.triggers.find((x) => x.id === ref.id);
    return t ? { translation: [...t.position], rotation: [0, 0, 0], scale: [t.radius, t.radius, t.radius] } : null;
  }
  if (ref.kind === 'STREAM') {
    const st = scene.mmStreams.find((x) => x.id === ref.id);
    return st ? { translation: [...st.translation], rotation: [...st.rotation], scale: [...st.scale] } : null;
  }
  if (ref.kind === 'POLY') {
    const p = scene.polyMeshes.find((x) => x.id === ref.id);
    return p ? { translation: [...p.translation], rotation: [...p.rotation], scale: [...p.scale] } : null;
  }
  if (ref.kind === 'PCLOUD') {
    const pc = scene.paintClouds.find((x) => x.id === ref.id);
    return pc ? { translation: [...pc.translation], rotation: [...pc.rotation], scale: [...pc.scale] } : null;
  }
  if (ref.kind === 'LIGHT') {
    // lights have no scale; report unit so the transform UI/gizmo behaves
    const l = scene.lights.find((x) => x.id === ref.id);
    return l ? { translation: [...l.translation], rotation: [...l.rotation], scale: [1, 1, 1] } : null;
  }
  if (ref.kind === 'ACTOR') {
    const a = scene.actors.find((x) => x.id === ref.id);
    return a ? { translation: [...a.translation], rotation: [...a.rotation], scale: [...a.scale] } : null;
  }
  const m = scene.meshes.find((x) => x.id === ref.id);
  return m ? { translation: [...m.translation], rotation: [...m.rotation], scale: [...m.scale] } : null;
}

export function setObjectTransform(scene: GPScene, ref: ObjRef, t: ObjTransform): void {
  if (ref.kind === 'GP') {
    const ob = scene.objects.find((o) => o.id === ref.id);
    if (ob) { ob.translation = [...t.translation]; ob.rotation = [...t.rotation]; ob.scale = [...t.scale]; }
  } else if (ref.kind === 'CANVAS') {
    const c = scene.canvases.find((x) => x.id === ref.id);
    if (c) {
      c.translation = [...t.translation];
      c.rotation = [...t.rotation];
      c.size = [Math.max(0.05, Math.abs(t.scale[0])), Math.max(0.05, Math.abs(t.scale[1]))];
    }
  } else if (ref.kind === 'SPLAT') {
    const s = scene.splats.find((x) => x.id === ref.id);
    if (s) {
      s.translation = [...t.translation];
      s.rotation = [...t.rotation];
      s.scale = Math.max(0.001, (Math.abs(t.scale[0]) + Math.abs(t.scale[1]) + Math.abs(t.scale[2])) / 3);
    }
  } else if (ref.kind === 'TRIGGER') {
    const tr = scene.score.triggers.find((x) => x.id === ref.id);
    if (tr) {
      tr.position = [...t.translation];
      tr.radius = Math.max(0.01, (Math.abs(t.scale[0]) + Math.abs(t.scale[1]) + Math.abs(t.scale[2])) / 3);
    }
  } else if (ref.kind === 'STREAM') {
    const st = scene.mmStreams.find((x) => x.id === ref.id);
    if (st) { st.translation = [...t.translation]; st.rotation = [...t.rotation]; st.scale = [...t.scale]; }
  } else if (ref.kind === 'POLY') {
    const p = scene.polyMeshes.find((x) => x.id === ref.id);
    if (p) { p.translation = [...t.translation]; p.rotation = [...t.rotation]; p.scale = [...t.scale]; }
  } else if (ref.kind === 'PCLOUD') {
    const pc = scene.paintClouds.find((x) => x.id === ref.id);
    if (pc) { pc.translation = [...t.translation]; pc.rotation = [...t.rotation]; pc.scale = [...t.scale]; }
  } else if (ref.kind === 'LIGHT') {
    const l = scene.lights.find((x) => x.id === ref.id);
    if (l) { l.translation = [...t.translation]; l.rotation = [...t.rotation]; } // scale ignored
  } else if (ref.kind === 'ACTOR') {
    // The pose is actor-LOCAL, so moving the actor carries the whole
    // ragdoll with it and the solver never sees the move at all.
    const a = scene.actors.find((x) => x.id === ref.id);
    if (a) { a.translation = [...t.translation]; a.rotation = [...t.rotation]; a.scale = [...t.scale]; }
  } else {
    const m = scene.meshes.find((x) => x.id === ref.id);
    if (m) { m.translation = [...t.translation]; m.rotation = [...t.rotation]; m.scale = [...t.scale]; }
  }
}

export function deleteObject(scene: GPScene, ref: ObjRef): void {
  // orphan any children first (keep their world pose)
  for (const child of allRefs(scene)) {
    const p = getParent(scene, child);
    if (p && p.kind === ref.kind && p.id === ref.id) setParentKeepWorld(scene, child, null);
  }
  if (ref.kind === 'GP') {
    const i = gpIndexOf(scene, ref.id);
    if (i >= 0) {
      scene.objects.splice(i, 1);
      // OBJECT mode + the outliner tolerate zero GP objects; the modes
      // that actually need an active one (DRAW/EDIT/SCULPT/...) create a
      // blank on entry instead — see App.setMode. Just keep the index in
      // range (harmless out-of-bounds when the array is now empty).
      scene.activeObject = Math.max(0, Math.min(scene.activeObject, scene.objects.length - 1));
    }
  } else if (ref.kind === 'CANVAS') {
    scene.canvases = scene.canvases.filter((c) => c.id !== ref.id);
  } else if (ref.kind === 'SPLAT') {
    scene.splats = scene.splats.filter((s) => s.id !== ref.id);
  } else if (ref.kind === 'TRIGGER') {
    scene.score.triggers = scene.score.triggers.filter((t) => t.id !== ref.id);
  } else if (ref.kind === 'STREAM') {
    scene.mmStreams = scene.mmStreams.filter((st) => st.id !== ref.id);
  } else if (ref.kind === 'POLY') {
    scene.polyMeshes = scene.polyMeshes.filter((p) => p.id !== ref.id);
  } else if (ref.kind === 'PCLOUD') {
    scene.paintClouds = scene.paintClouds.filter((pc) => pc.id !== ref.id);
  } else if (ref.kind === 'LIGHT') {
    scene.lights = scene.lights.filter((l) => l.id !== ref.id);
  } else if (ref.kind === 'ACTOR') {
    scene.actors = scene.actors.filter((a) => a.id !== ref.id);
  } else {
    scene.meshes = scene.meshes.filter((m) => m.id !== ref.id);
  }
}

export function allRefs(scene: GPScene): ObjRef[] {
  return [
    ...scene.objects.map((o) => ({ kind: 'GP' as const, id: o.id })),
    ...scene.canvases.map((c) => ({ kind: 'CANVAS' as const, id: c.id })),
    ...scene.splats.map((s) => ({ kind: 'SPLAT' as const, id: s.id })),
    ...scene.meshes.map((m) => ({ kind: 'MESH' as const, id: m.id })),
    ...scene.score.triggers.map((t) => ({ kind: 'TRIGGER' as const, id: t.id })),
    ...scene.mmStreams.map((st) => ({ kind: 'STREAM' as const, id: st.id })),
    ...scene.polyMeshes.map((p) => ({ kind: 'POLY' as const, id: p.id })),
    ...scene.paintClouds.map((pc) => ({ kind: 'PCLOUD' as const, id: pc.id })),
    ...scene.lights.map((l) => ({ kind: 'LIGHT' as const, id: l.id })),
    ...scene.actors.map((a) => ({ kind: 'ACTOR' as const, id: a.id })),
  ];
}

// ------------------------------------------------------------- parenting

export function getParent(scene: GPScene, ref: ObjRef): ParentRef | null {
  return entityOf(scene, ref)?.parent ?? null;
}

function composeLocal(t: ObjTransform, kind: ObjKind): THREE.Matrix4 {
  // canvas "scale" is its quad size (geometry), never applied as a matrix
  // scale nor inherited by children
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...t.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotation)),
    kind === 'CANVAS' ? new THREE.Vector3(1, 1, 1) : new THREE.Vector3(...t.scale),
  );
}

/** World matrix through the parent chain (cycle-guarded, depth <= 8). */
export function worldMatrixOf(scene: GPScene, ref: ObjRef, depth = 0): THREE.Matrix4 {
  const t = getObjectTransform(scene, ref);
  if (!t) return new THREE.Matrix4();
  const local = composeLocal(t, ref.kind);
  const baked = (entityOf(scene, ref) as { baked?: number[] } | null)?.baked;
  if (baked?.length === 16) local.multiply(new THREE.Matrix4().fromArray(baked));
  const parent = getParent(scene, ref);
  if (!parent || depth > 8) return local;
  return worldMatrixOf(scene, parent as ObjRef, depth + 1).multiply(local);
}

export function parentWorldMatrixOf(scene: GPScene, ref: ObjRef): THREE.Matrix4 {
  const parent = getParent(scene, ref);
  return parent ? worldMatrixOf(scene, parent as ObjRef, 1) : new THREE.Matrix4();
}

function wouldCycle(scene: GPScene, child: ObjRef, parent: ObjRef): boolean {
  let cur: ParentRef | null = parent;
  for (let i = 0; i < 16 && cur; i++) {
    if (cur.kind === child.kind && cur.id === child.id) return true;
    cur = getParent(scene, cur as ObjRef);
  }
  return false;
}

/** Blender-style parenting: reparent while preserving the world pose. */
export function setParentKeepWorld(scene: GPScene, child: ObjRef, parent: ObjRef | null): boolean {
  if (parent && (wouldCycle(scene, child, parent)
    || (parent.kind === child.kind && parent.id === child.id))) return false;
  const world = worldMatrixOf(scene, child);
  const e = entityOf(scene, child);
  if (!e) return false;
  e.parent = parent ? { kind: parent.kind, id: parent.id } : null;
  const newLocal = parentWorldMatrixOf(scene, child).invert().multiply(world);
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  newLocal.decompose(pos, quat, scl);
  const eul = new THREE.Euler().setFromQuaternion(quat);
  const old = getObjectTransform(scene, child)!;
  setObjectTransform(scene, child, {
    translation: [pos.x, pos.y, pos.z],
    rotation: [eul.x, eul.y, eul.z],
    // canvases keep their size; others take the decomposed scale
    scale: child.kind === 'CANVAS' ? old.scale : [scl.x, scl.y, scl.z],
  });
  return true;
}

/**
 * Blender Ctrl+A: fold the local TRS into the object data so the transform
 * resets to identity while the object stays put. GP bakes into stroke
 * points (+ scales SCENE-unit widths); mesh/splat fold into `baked`.
 */
export function applyObjectTransform(scene: GPScene, ref: ObjRef): boolean {
  const t = getObjectTransform(scene, ref);
  if (!t || ref.kind === 'CANVAS' || ref.kind === 'TRIGGER') return false;
  const local = composeLocal(t, ref.kind);
  if (ref.kind === 'GP') {
    const ob = scene.objects.find((x) => x.id === ref.id);
    if (!ob) return false;
    const wScale = (Math.abs(t.scale[0]) + Math.abs(t.scale[1]) + Math.abs(t.scale[2])) / 3;
    const v = new THREE.Vector3();
    for (const layer of ob.layers) for (const f of layer.frames) for (const s of f.strokes) {
      for (const p of s.points) {
        v.set(...p.co).applyMatrix4(local);
        p.co = [v.x, v.y, v.z];
      }
      if (s.style.unit === 'SCENE') s.lineWidth *= wScale;
    }
    ob.translation = [0, 0, 0]; ob.rotation = [0, 0, 0]; ob.scale = [1, 1, 1];
    return true;
  }
  const e = entityOf(scene, ref) as { baked?: number[] } | null;
  if (!e) return false;
  // world = parent · local · baked  →  fold local into baked, TRS ← identity
  const prev = e.baked?.length === 16
    ? new THREE.Matrix4().fromArray(e.baked) : new THREE.Matrix4();
  e.baked = local.multiply(prev).toArray();
  setObjectTransform(scene, ref, {
    translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  });
  return true;
}

export function selectionPivot(scene: GPScene): THREE.Vector3 | null {
  const refs = listSelected(scene);
  if (!refs.length) return null;
  const pivot = new THREE.Vector3();
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (const ref of refs) {
    worldMatrixOf(scene, ref).decompose(pos, q, s);
    pivot.add(pos);
  }
  return pivot.divideScalar(refs.length);
}

// ------------------------------------------------------------- pick tool

export type ObjectSelectKind = 'BOX' | 'LASSO' | 'CIRCLE';

/**
 * Object-mode select (Blender-style family, mirrors tools/select.ts's
 * EDIT-mode SelectTool): click picks (mesh/canvas raycast, GP stroke
 * proximity, splat centers; Shift toggles). Drag behavior depends on the
 * variant: box, lasso, or circle brush. The box variant keeps Ctrl-drag =
 * lasso and C = toggle circle mode as shortcuts, same as EDIT mode.
 */
export class ObjectSelectTool implements Tool {
  id: string;
  cursor = 'default';
  onSelectionChange: ((ctx: AppCtx) => void) | null = null;
  /** most recently picked object = the "active" object for Ctrl+P */
  lastPicked: ObjRef | null = null;
  private kind: ObjectSelectKind;
  private mode: 'none' | 'box' | 'lasso' | 'circle' = 'none';
  private start = new THREE.Vector2();
  private cur = new THREE.Vector2();
  private lasso: THREE.Vector2[] = [];
  private circleMode = false;
  private circleRadius = 40;
  private dragging = false;
  private down = false;

  constructor(id = 'object-select', kind: ObjectSelectKind = 'BOX') {
    this.id = id;
    this.kind = kind;
    this.circleMode = kind === 'CIRCLE';
  }

  onKey(_ctx: AppCtx, key: string): boolean {
    if (this.kind === 'BOX' && (key === 'c' || key === 'C')) {
      this.circleMode = !this.circleMode;
      return true;
    }
    if (this.circleMode && (key === '[' || key === ']')) {
      this.circleRadius = Math.max(8, this.circleRadius + (key === ']' ? 8 : -8));
      return true;
    }
    return false;
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    this.start.set(e.x, e.y);
    this.cur.set(e.x, e.y);
    this.down = true;
    this.dragging = false;
    if (this.circleMode) {
      this.mode = 'circle';
      this.circleSelectAt(ctx, e);
    } else if (this.kind === 'LASSO' || e.ctrl) {
      this.mode = 'lasso';
      this.lasso = [new THREE.Vector2(e.x, e.y)];
    } else {
      this.mode = 'box';
    }
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (!this.down) return;
    this.cur.set(e.x, e.y);
    if (this.cur.distanceTo(this.start) > 5) this.dragging = true;
    if (this.mode === 'lasso') this.lasso.push(new THREE.Vector2(e.x, e.y));
    if (this.mode === 'circle') this.circleSelectAt(ctx, e);
    ctx.requestRender();
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    this.down = false;
    const mode = this.mode;
    this.mode = 'none';
    if (mode === 'circle') { this.dragging = false; ctx.refreshUI(); return; }
    const scene = ctx.scene;
    ctx.pushUndo();
    const multi = e.shift || e.ctrl; // Shift or Cmd/Ctrl adds to the selection
    if (this.dragging && mode === 'box') {
      const min = new THREE.Vector2(Math.min(this.start.x, e.x), Math.min(this.start.y, e.y));
      const max = new THREE.Vector2(Math.max(this.start.x, e.x), Math.max(this.start.y, e.y));
      this.selectByRegion(ctx, multi, (p) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y);
    } else if (this.dragging && mode === 'lasso' && this.lasso.length > 2) {
      this.selectByRegion(ctx, multi, (p) => pointInPolygon(p, this.lasso));
    } else {
      const hit = this.pick(ctx, e);
      if (!multi) deselectAllObjects(scene);
      if (hit && !isObjectLocked(scene, hit)) {
        setObjectSelected(scene, hit, multi ? !isObjectSelected(scene, hit) : true);
        this.lastPicked = hit;
        if (hit.kind === 'GP') {
          const i = gpIndexOf(scene, hit.id);
          if (i >= 0) scene.activeObject = i;
        }
      }
    }
    this.dragging = false;
    this.lasso = [];
    ctx.syncCanvases();
    ctx.requestRender();
    ctx.refreshUI();
    this.onSelectionChange?.(ctx);
  }

  onCancel(): void { this.down = false; this.dragging = false; this.mode = 'none'; this.lasso = []; }

  drawHud(_ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    if (this.mode === 'lasso') drawLasso(hud, this.lasso);
    if (this.mode === 'box' && this.dragging) {
      hud.strokeStyle = 'rgba(255,255,255,0.8)';
      hud.setLineDash([4, 4]);
      hud.strokeRect(this.start.x, this.start.y, this.cur.x - this.start.x, this.cur.y - this.start.y);
      hud.setLineDash([]);
    }
    if (this.circleMode) {
      hud.beginPath();
      hud.arc(this.cur.x, this.cur.y, this.circleRadius, 0, Math.PI * 2);
      hud.strokeStyle = 'rgba(255,255,255,0.6)';
      hud.stroke();
    }
  }

  private projectWorld(ctx: AppCtx, m: THREE.Matrix4): THREE.Vector2 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const pos = new THREE.Vector3().setFromMatrixPosition(m).project(ctx.camera);
    if (pos.z > 1) return null;
    return new THREE.Vector2((pos.x * 0.5 + 0.5) * rect.width, (-pos.y * 0.5 + 0.5) * rect.height);
  }

  /** Shared box/lasso region test — any sampled GP stroke point, or the
   *  projected origin for everything else, satisfying `test`. */
  private selectByRegion(ctx: AppCtx, multi: boolean, test: (p: THREE.Vector2) => boolean): void {
    const scene = ctx.scene;
    if (!multi) deselectAllObjects(scene);
    for (const ref of allRefs(scene)) {
      if (isObjectLocked(scene, ref)) continue;
      if (this.refMatches(ctx, ref, test)) {
        setObjectSelected(scene, ref, true);
        this.lastPicked = ref; // Blender: the last one touched becomes active/target
        if (ref.kind === 'GP') {
          const i = gpIndexOf(scene, ref.id);
          if (i >= 0) scene.activeObject = i;
        }
      }
    }
  }

  private refMatches(ctx: AppCtx, ref: ObjRef, test: (p: THREE.Vector2) => boolean): boolean {
    if (ref.kind === 'GP') {
      // any sampled stroke point matches
      const i = gpIndexOf(ctx.scene, ref.id);
      if (i < 0) return false;
      const ob = ctx.scene.objects[i];
      const save = ctx.scene.activeObject;
      ctx.scene.activeObject = i;
      try {
        for (const layer of ob.layers) {
          if (layer.hide) continue;
          const f = frameAt(layer, ctx.scene.frame);
          if (!f) continue;
          for (const s of f.strokes) {
            for (let k = 0; k < s.points.length; k += 3) {
              if (test(objectToScreen(ctx, s.points[k].co))) return true;
            }
          }
        }
      } finally {
        ctx.scene.activeObject = save;
      }
      return false;
    }
    const p = this.projectWorld(ctx, worldMatrixOf(ctx.scene, ref));
    return !!p && test(p);
  }

  private circleSelectAt(ctx: AppCtx, e: ToolEvent): void {
    const scene = ctx.scene;
    const cursor = new THREE.Vector2(e.x, e.y);
    const deselect = e.ctrl;
    const test = (p: THREE.Vector2) => p.distanceTo(cursor) < this.circleRadius;
    for (const ref of allRefs(scene)) {
      if (isObjectLocked(scene, ref)) continue;
      if (this.refMatches(ctx, ref, test)) {
        setObjectSelected(scene, ref, !deselect);
        if (!deselect) {
          this.lastPicked = ref;
          if (ref.kind === 'GP') {
            const i = gpIndexOf(scene, ref.id);
            if (i >= 0) scene.activeObject = i;
          }
        }
      }
    }
    ctx.requestRender();
  }

  pick(ctx: AppCtx, e: ToolEvent): ObjRef | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((e.x / rect.width) * 2 - 1, -(e.y / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.camera);
    const targets = [...ctx.canvasMeshes, ...ctx.pickableMeshes];
    const hits = ray.intersectObjects(targets, true);
    for (const h of hits) {
      let cur: THREE.Object3D | null = h.object;
      while (cur) {
        if (cur.userData.canvasId !== undefined) return { kind: 'CANVAS', id: cur.userData.canvasId };
        if (cur.userData.meshId !== undefined) return { kind: 'MESH', id: cur.userData.meshId };
        if (cur.userData.polyId !== undefined) return { kind: 'POLY', id: cur.userData.polyId };
        cur = cur.parent;
      }
    }
    const cursor = new THREE.Vector2(e.x, e.y);
    let best: { d: number; ref: ObjRef } | null = null;
    for (let oi = 0; oi < ctx.scene.objects.length; oi++) {
      const ob = ctx.scene.objects[oi];
      const saveActive = ctx.scene.activeObject;
      ctx.scene.activeObject = oi;
      try {
        for (const layer of ob.layers) {
          if (layer.hide) continue;
          const f = frameAt(layer, ctx.scene.frame);
          if (!f) continue;
          for (const s of f.strokes) {
            for (let i = 0; i < s.points.length; i += 2) {
              const d = objectToScreen(ctx, s.points[i].co).distanceTo(cursor);
              if (d < 16 && (!best || d < best.d)) best = { d, ref: { kind: 'GP', id: ob.id } };
            }
          }
        }
      } finally {
        ctx.scene.activeObject = saveActive;
      }
    }
    if (best) return best.ref;
    for (const s of ctx.scene.splats) {
      const p = this.projectWorld(ctx, worldMatrixOf(ctx.scene, { kind: 'SPLAT', id: s.id }));
      if (p && Math.hypot(p.x - e.x, p.y - e.y) < 40) return { kind: 'SPLAT', id: s.id };
    }
    for (const t of ctx.scene.score.triggers) {
      const p = this.projectWorld(ctx, worldMatrixOf(ctx.scene, { kind: 'TRIGGER', id: t.id }));
      if (p && Math.hypot(p.x - e.x, p.y - e.y) < 40) return { kind: 'TRIGGER', id: t.id };
    }
    for (const st of ctx.scene.mmStreams) {
      if (!st.visible) continue;
      const p = this.projectWorld(ctx, worldMatrixOf(ctx.scene, { kind: 'STREAM', id: st.id }));
      if (p && Math.hypot(p.x - e.x, p.y - e.y) < 40) return { kind: 'STREAM', id: st.id };
    }
    // painted splat clouds: screen-distance test against sampled points
    for (const pc of ctx.scene.paintClouds) {
      if (!pc.visible) continue;
      const world = worldMatrixOf(ctx.scene, { kind: 'PCLOUD', id: pc.id });
      const rectPc = ctx.canvas.getBoundingClientRect();
      const n = pc.points.length / 8;
      const stride = Math.max(1, Math.floor(n / 400));
      for (let i = 0; i < n; i += stride) {
        const o = i * 8;
        const pr = new THREE.Vector3(pc.points[o], pc.points[o + 1], pc.points[o + 2])
          .applyMatrix4(world).project(ctx.camera);
        if (pr.z > 1) continue;
        const sx = (pr.x * 0.5 + 0.5) * rectPc.width, sy = (-pr.y * 0.5 + 0.5) * rectPc.height;
        if (Math.hypot(sx - e.x, sy - e.y) < 16) return { kind: 'PCLOUD', id: pc.id };
      }
    }
    // faceless poly meshes (points/edge chains) have nothing to raycast —
    // fall back to a screen-distance test against their projected vertices
    for (const pm of ctx.scene.polyMeshes) {
      if (!pm.visible || pm.faces.length) continue;
      const world = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id });
      const rect2 = ctx.canvas.getBoundingClientRect();
      for (const v of pm.vertices) {
        const pr = new THREE.Vector3(...v.co).applyMatrix4(world).project(ctx.camera);
        if (pr.z > 1) continue;
        const sx = (pr.x * 0.5 + 0.5) * rect2.width, sy = (-pr.y * 0.5 + 0.5) * rect2.height;
        if (Math.hypot(sx - e.x, sy - e.y) < 20) return { kind: 'POLY', id: pm.id };
      }
    }
    const canvasHit = pickCanvas(ctx, e.x, e.y);
    if (canvasHit) return { kind: 'CANVAS', id: canvasHit.id };
    return null;
  }
}
