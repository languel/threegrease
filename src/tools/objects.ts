// Object mode (unified): one selection/transform model over GP objects,
// canvas planes, splats, and mesh objects. Cameras keep their own UI.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { GPScene, Vec3 } from '../core/types';
import { frameAt, activeObject } from '../core/gpdata';
import { objectToScreen, pickCanvas } from './projection';
import type { Tool, ToolEvent } from './toolsys';

export type ObjKind = 'GP' | 'CANVAS' | 'SPLAT' | 'MESH';
export interface ObjRef { kind: ObjKind; id: number } // GP: id = object index

export function listSelected(scene: GPScene): ObjRef[] {
  const out: ObjRef[] = [];
  scene.objects.forEach((ob, i) => { if (ob.select) out.push({ kind: 'GP', id: i }); });
  for (const c of scene.canvases) if (c.select) out.push({ kind: 'CANVAS', id: c.id });
  for (const s of scene.splats) if (s.select) out.push({ kind: 'SPLAT', id: s.id });
  for (const m of scene.meshes) if (m.select) out.push({ kind: 'MESH', id: m.id });
  return out;
}

export function deselectAllObjects(scene: GPScene): void {
  for (const ob of scene.objects) ob.select = false;
  for (const c of scene.canvases) c.select = false;
  for (const s of scene.splats) s.select = false;
  for (const m of scene.meshes) m.select = false;
}

export function setObjectSelected(scene: GPScene, ref: ObjRef, v: boolean): void {
  if (ref.kind === 'GP') { const ob = scene.objects[ref.id]; if (ob) ob.select = v; }
  else if (ref.kind === 'CANVAS') { const c = scene.canvases.find((x) => x.id === ref.id); if (c) c.select = v; }
  else if (ref.kind === 'SPLAT') { const s = scene.splats.find((x) => x.id === ref.id); if (s) s.select = v; }
  else { const m = scene.meshes.find((x) => x.id === ref.id); if (m) m.select = v; }
}

export function isObjectSelected(scene: GPScene, ref: ObjRef): boolean {
  if (ref.kind === 'GP') return !!scene.objects[ref.id]?.select;
  if (ref.kind === 'CANVAS') return !!scene.canvases.find((x) => x.id === ref.id)?.select;
  if (ref.kind === 'SPLAT') return !!scene.splats.find((x) => x.id === ref.id)?.select;
  return !!scene.meshes.find((x) => x.id === ref.id)?.select;
}

export interface ObjTransform { translation: Vec3; rotation: Vec3; scale: Vec3 }

export function getObjectTransform(scene: GPScene, ref: ObjRef): ObjTransform | null {
  if (ref.kind === 'GP') {
    const ob = scene.objects[ref.id];
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
  const m = scene.meshes.find((x) => x.id === ref.id);
  return m ? { translation: [...m.translation], rotation: [...m.rotation], scale: [...m.scale] } : null;
}

export function setObjectTransform(scene: GPScene, ref: ObjRef, t: ObjTransform): void {
  if (ref.kind === 'GP') {
    const ob = scene.objects[ref.id];
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
  } else {
    const m = scene.meshes.find((x) => x.id === ref.id);
    if (m) { m.translation = [...t.translation]; m.rotation = [...t.rotation]; m.scale = [...t.scale]; }
  }
}

export function deleteObject(scene: GPScene, ref: ObjRef): void {
  if (ref.kind === 'GP') {
    if (scene.objects.length > 1) {
      scene.objects.splice(ref.id, 1);
      scene.activeObject = Math.min(scene.activeObject, scene.objects.length - 1);
    }
  } else if (ref.kind === 'CANVAS') {
    scene.canvases = scene.canvases.filter((c) => c.id !== ref.id);
  } else if (ref.kind === 'SPLAT') {
    scene.splats = scene.splats.filter((s) => s.id !== ref.id);
  } else {
    scene.meshes = scene.meshes.filter((m) => m.id !== ref.id);
  }
}

export function selectionPivot(scene: GPScene): THREE.Vector3 | null {
  const refs = listSelected(scene);
  if (!refs.length) return null;
  const pivot = new THREE.Vector3();
  for (const ref of refs) {
    const t = getObjectTransform(scene, ref);
    if (t) pivot.add(new THREE.Vector3(...t.translation));
  }
  return pivot.divideScalar(refs.length);
}

/**
 * Click-pick tool for object mode. Priority: mesh/canvas raycast (nearest),
 * then GP strokes (screen-space point distance), then splat centers.
 * Shift toggles; plain click selects exclusively.
 */
export class ObjectSelectTool implements Tool {
  id = 'object-select';
  cursor = 'default';
  /** app hook: refresh widget attachment after selection changes */
  onSelectionChange: ((ctx: AppCtx) => void) | null = null;

  onDown(): void {}
  onMove(): void {}

  onUp(ctx: AppCtx, e: ToolEvent): void {
    const scene = ctx.scene;
    const hit = this.pick(ctx, e);
    ctx.pushUndo();
    if (!e.shift) deselectAllObjects(scene);
    if (hit) {
      setObjectSelected(scene, hit, e.shift ? !isObjectSelected(scene, hit) : true);
      if (hit.kind === 'GP') scene.activeObject = hit.id;
    }
    ctx.syncCanvases();
    ctx.requestRender();
    ctx.refreshUI();
    this.onSelectionChange?.(ctx);
  }

  pick(ctx: AppCtx, e: ToolEvent): ObjRef | null {
    // 1. raycast meshes + canvases together, nearest wins
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
    // 2. GP strokes: nearest projected point within 16px (per object)
    const cursor = new THREE.Vector2(e.x, e.y);
    let best: { d: number; ref: ObjRef } | null = null;
    scene: for (let oi = 0; oi < ctx.scene.objects.length; oi++) {
      const ob = ctx.scene.objects[oi];
      const saveActive = ctx.scene.activeObject;
      ctx.scene.activeObject = oi; // objectToScreen uses the active object matrix
      for (const layer of ob.layers) {
        if (layer.hide) continue;
        const f = frameAt(layer, ctx.scene.frame);
        if (!f) continue;
        for (const s of f.strokes) {
          for (let i = 0; i < s.points.length; i += 2) {
            const d = objectToScreen(ctx, s.points[i].co).distanceTo(cursor);
            if (d < 16 && (!best || d < best.d)) best = { d, ref: { kind: 'GP', id: oi } };
            if (best && best.d < 4) { ctx.scene.activeObject = saveActive; break scene; }
          }
        }
      }
      ctx.scene.activeObject = saveActive;
    }
    if (best) return best.ref;
    // 3. splat centers within 40px
    for (const s of ctx.scene.splats) {
      const p = new THREE.Vector3(...s.translation).project(ctx.camera);
      const sx = (p.x * 0.5 + 0.5) * rect.width;
      const sy = (-p.y * 0.5 + 0.5) * rect.height;
      if (Math.hypot(sx - e.x, sy - e.y) < 40) return { kind: 'SPLAT', id: s.id };
    }
    // canvases via dedicated helper (double-sided quads sometimes missed above)
    const canvasHit = pickCanvas(ctx, e.x, e.y);
    if (canvasHit) return { kind: 'CANVAS', id: canvasHit.id };
    return null;
  }
}

export function ensureActiveGPSelected(ctx: AppCtx): void {
  const ob = activeObject(ctx.scene);
  if (ob) ob.select = true;
}
