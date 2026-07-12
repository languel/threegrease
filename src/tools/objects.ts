// Object mode (unified): one selection/transform model over GP objects,
// canvas planes, splats, and mesh objects — now with parenting.
// ObjRef.id is STABLE for every kind (GPObject.id, not its array index).
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { GPScene, ParentRef, Vec3 } from '../core/types';
import { frameAt } from '../core/gpdata';
import { objectToScreen, pickCanvas } from './projection';
import type { Tool, ToolEvent } from './toolsys';
import { drawLasso } from './draw';

export type ObjKind = 'GP' | 'CANVAS' | 'SPLAT' | 'MESH' | 'TRIGGER';
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
  return out;
}

export function deselectAllObjects(scene: GPScene): void {
  for (const ob of scene.objects) ob.select = false;
  for (const c of scene.canvases) c.select = false;
  for (const s of scene.splats) s.select = false;
  for (const m of scene.meshes) m.select = false;
  for (const t of scene.score.triggers) t.select = false;
}

function entityOf(scene: GPScene, ref: ObjRef):
  | { select?: boolean; parent?: ParentRef | null; name: string } | undefined {
  if (ref.kind === 'GP') return scene.objects.find((o) => o.id === ref.id);
  if (ref.kind === 'CANVAS') return scene.canvases.find((c) => c.id === ref.id);
  if (ref.kind === 'SPLAT') return scene.splats.find((s) => s.id === ref.id);
  if (ref.kind === 'TRIGGER') return scene.score.triggers.find((t) => t.id === ref.id);
  return scene.meshes.find((m) => m.id === ref.id);
}

export function setObjectSelected(scene: GPScene, ref: ObjRef, v: boolean): void {
  const e = entityOf(scene, ref);
  if (e) e.select = v;
}

export function isObjectSelected(scene: GPScene, ref: ObjRef): boolean {
  return !!entityOf(scene, ref)?.select;
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
    if (i >= 0 && scene.objects.length > 1) {
      scene.objects.splice(i, 1);
      scene.activeObject = Math.min(scene.activeObject, scene.objects.length - 1);
    }
  } else if (ref.kind === 'CANVAS') {
    scene.canvases = scene.canvases.filter((c) => c.id !== ref.id);
  } else if (ref.kind === 'SPLAT') {
    scene.splats = scene.splats.filter((s) => s.id !== ref.id);
  } else if (ref.kind === 'TRIGGER') {
    scene.score.triggers = scene.score.triggers.filter((t) => t.id !== ref.id);
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

/**
 * Object-mode select: click picks (mesh/canvas raycast, GP stroke
 * proximity, splat centers; Shift toggles), drag = box select.
 */
export class ObjectSelectTool implements Tool {
  id = 'object-select';
  cursor = 'default';
  onSelectionChange: ((ctx: AppCtx) => void) | null = null;
  /** most recently picked object = the "active" object for Ctrl+P */
  lastPicked: ObjRef | null = null;
  private start = new THREE.Vector2();
  private cur = new THREE.Vector2();
  private dragging = false;
  private down = false;

  onDown(_ctx: AppCtx, e: ToolEvent): void {
    this.start.set(e.x, e.y);
    this.cur.set(e.x, e.y);
    this.down = true;
    this.dragging = false;
  }

  onMove(_ctx: AppCtx, e: ToolEvent): void {
    if (!this.down) return;
    this.cur.set(e.x, e.y);
    if (this.cur.distanceTo(this.start) > 5) this.dragging = true;
  }

  onUp(ctx: AppCtx, e: ToolEvent): void {
    this.down = false;
    const scene = ctx.scene;
    ctx.pushUndo();
    if (this.dragging) {
      const min = new THREE.Vector2(Math.min(this.start.x, e.x), Math.min(this.start.y, e.y));
      const max = new THREE.Vector2(Math.max(this.start.x, e.x), Math.max(this.start.y, e.y));
      if (!e.shift) deselectAllObjects(scene);
      for (const ref of allRefs(scene)) {
        if (this.refInRect(ctx, ref, min, max)) setObjectSelected(scene, ref, true);
      }
    } else {
      const hit = this.pick(ctx, e);
      if (!e.shift) deselectAllObjects(scene);
      if (hit) {
        setObjectSelected(scene, hit, e.shift ? !isObjectSelected(scene, hit) : true);
        this.lastPicked = hit;
        if (hit.kind === 'GP') {
          const i = gpIndexOf(scene, hit.id);
          if (i >= 0) scene.activeObject = i;
        }
      }
    }
    this.dragging = false;
    ctx.syncCanvases();
    ctx.requestRender();
    ctx.refreshUI();
    this.onSelectionChange?.(ctx);
  }

  onCancel(): void { this.down = false; this.dragging = false; }

  drawHud(_ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    if (!this.dragging) return;
    hud.strokeStyle = 'rgba(255,255,255,0.8)';
    hud.setLineDash([4, 4]);
    hud.strokeRect(this.start.x, this.start.y, this.cur.x - this.start.x, this.cur.y - this.start.y);
    hud.setLineDash([]);
    void drawLasso; // (lasso variant reserved)
  }

  private projectWorld(ctx: AppCtx, m: THREE.Matrix4): THREE.Vector2 | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const pos = new THREE.Vector3().setFromMatrixPosition(m).project(ctx.camera);
    if (pos.z > 1) return null;
    return new THREE.Vector2((pos.x * 0.5 + 0.5) * rect.width, (-pos.y * 0.5 + 0.5) * rect.height);
  }

  private refInRect(ctx: AppCtx, ref: ObjRef, min: THREE.Vector2, max: THREE.Vector2): boolean {
    if (ref.kind === 'GP') {
      // any sampled stroke point inside the rect
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
              const p = objectToScreen(ctx, s.points[k].co);
              if (p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y) return true;
            }
          }
        }
      } finally {
        ctx.scene.activeObject = save;
      }
      return false;
    }
    const p = this.projectWorld(ctx, worldMatrixOf(ctx.scene, ref));
    return !!p && p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
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
    const canvasHit = pickCanvas(ctx, e.x, e.y);
    if (canvasHit) return { kind: 'CANVAS', id: canvasHit.id };
    return null;
  }
}
