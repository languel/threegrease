import * as THREE from 'three';
import type { GPLayer, GPObject, GPScene, GPStroke, Vec3 } from '../core/types';
import { frameAt, keyframeIndexAt } from '../core/gpdata';
import { evaluateModifiers, remapTime } from '../modifiers/index';
import { buildFillGeometry, buildStrokeGeometry, type BuildOptions } from './geometry';
import { makeFillMaterial, makeStrokeMaterial } from './materials';

export type EditorMode = 'OBJECT' | 'DRAW' | 'EDIT' | 'SCULPT' | 'VERTEX' | 'WEIGHT' | 'POLY';

export interface RenderState {
  mode: EditorMode;
  background: Vec3;
  playing: boolean;
  selectMode: 'POINT' | 'STROKE';
}

interface LayerCacheEntry {
  group: THREE.Group;
  disposables: { dispose(): void }[];
}

/**
 * Syncs GPScene data -> three.js meshes with per-layer granularity (P10):
 * markDirty() rebuilds everything, markDirty(layerId) rebuilds only that
 * layer's cached group — the hot path while drawing/simulating.
 */
export class GPSceneRenderer {
  readonly root = new THREE.Group();
  readonly resolution = new THREE.Vector2(1, 1);
  private dirtyAll = true;
  private dirtyLayers = new Set<number>();
  /** Groups per GP object, exposed for the effects pipeline. */
  readonly objectGroups: THREE.Group[] = [];
  private layerCache = new Map<number, LayerCacheEntry>();

  markDirty(layerId?: number): void {
    if (layerId === undefined) this.dirtyAll = true;
    else this.dirtyLayers.add(layerId);
  }

  get needsRebuild(): boolean { return this.dirtyAll || this.dirtyLayers.size > 0; }

  setSize(w: number, h: number): void { this.resolution.set(w, h); }

  private disposeEntry(entry: LayerCacheEntry): void {
    for (const d of entry.disposables) d.dispose();
    entry.group.removeFromParent();
    entry.group.clear();
  }

  update(scene: GPScene, state: RenderState): void {
    if (!this.needsRebuild) return;

    // masked layers depend on their mask sources
    if (!this.dirtyAll && this.dirtyLayers.size) {
      for (const ob of scene.objects) {
        for (const layer of ob.layers) {
          if (layer.useMask && layer.maskLayerIds.some((id) => this.dirtyLayers.has(id))) {
            this.dirtyLayers.add(layer.id);
          }
        }
      }
    }

    if (this.dirtyAll) {
      for (const entry of this.layerCache.values()) this.disposeEntry(entry);
      this.layerCache.clear();
      this.root.clear();
      this.objectGroups.length = 0;
    }

    scene.objects.forEach((ob, obIndex) => {
      let group = this.objectGroups[obIndex];
      if (!group) {
        group = new THREE.Group();
        group.userData.gpObject = obIndex;
        this.root.add(group);
        this.objectGroups[obIndex] = group;
      }
      group.position.set(...ob.translation);
      group.rotation.set(...ob.rotation);
      group.scale.set(...ob.scale);
      group.visible = !ob.hide;

      ob.layers.forEach((layer, li) => {
        const cached = this.layerCache.get(layer.id);
        const needsBuild = this.dirtyAll || !cached || this.dirtyLayers.has(layer.id);
        if (!needsBuild) return;
        if (cached) {
          this.disposeEntry(cached);
          this.layerCache.delete(layer.id);
        }
        const entry: LayerCacheEntry = { group: new THREE.Group(), disposables: [] };
        entry.group.userData.layerId = layer.id;
        if (!layer.hide) {
          this.buildLayer(ob, scene, state, obIndex, layer, li, entry);
        }
        group.add(entry.group);
        this.layerCache.set(layer.id, entry);
      });
    });

    // drop cache for layers that no longer exist
    const liveIds = new Set(scene.objects.flatMap((o) => o.layers.map((l) => l.id)));
    for (const [id, entry] of this.layerCache) {
      if (!liveIds.has(id)) {
        this.disposeEntry(entry);
        this.layerCache.delete(id);
      }
    }

    this.dirtyAll = false;
    this.dirtyLayers.clear();
  }

  /** Everything one layer contributes: onion ghosts, meshes, masks, overlay. */
  private buildLayer(
    ob: GPObject, scene: GPScene, state: RenderState,
    obIndex: number, layer: GPLayer, li: number, entry: LayerCacheEntry,
  ): void {
    const isActive = obIndex === scene.activeObject;
    const order = obIndex * 1000 + li * 8;

    if (ob.onion.enabled && layer.useOnion && isActive && !state.playing) {
      this.buildOnion(ob, layer, scene.frame, entry, order);
    }

    const sampleFrame = remapTime(ob, layer, scene.frame);
    const kf = frameAt(layer, sampleFrame);
    if (!kf) return;
    const strokes = evaluateModifiers(kf.strokes, ob, layer, scene.frame, kf.frameNumber);
    const opts: BuildOptions = {
      layerOpacity: layer.opacity,
      tint: layer.tint,
      thicknessOffset: layer.thicknessOffset,
      background: state.background,
    };
    const meshes = this.buildLayerMeshes(strokes, ob, layer, opts, order + 4, entry);
    if (layer.useMask && layer.maskLayerIds.length) {
      // stable stencil ref per layer (cached rebuilds must not collide)
      const ref = (layer.id % 250) + 1;
      const wrote = this.buildMaskWriters(ob, layer, scene, state, entry, order + 2, ref);
      if (wrote) {
        for (const m of meshes) {
          const mat = m.material as THREE.Material;
          mat.stencilWrite = true;
          mat.stencilRef = ref;
          mat.stencilFunc = THREE.EqualStencilFunc;
          mat.stencilZPass = THREE.KeepStencilOp;
        }
      }
    }
    for (const m of meshes) entry.group.add(m);

    if (isActive && state.mode !== 'DRAW' && state.mode !== 'OBJECT' && !layer.lock) {
      const overlay = this.buildOverlay(kf.strokes, layer, state, order + 7, entry);
      if (overlay) entry.group.add(overlay);
    }
  }

  private buildLayerMeshes(
    strokes: GPStroke[], ob: GPObject, layer: GPLayer, opts: BuildOptions,
    order: number, entry: LayerCacheEntry,
  ): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    const layerMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...layer.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...layer.rotation)),
      new THREE.Vector3(...layer.scale),
    );

    const fillGeom = buildFillGeometry(strokes, ob.materials, opts);
    if (fillGeom) {
      const mat = makeFillMaterial(layer.blendMode);
      const mesh = new THREE.Mesh(fillGeom, mat);
      mesh.renderOrder = order;
      mesh.applyMatrix4(layerMatrix);
      mesh.frustumCulled = false;
      entry.disposables.push(fillGeom, mat);
      meshes.push(mesh);
    }
    const strokeGeom = buildStrokeGeometry(strokes, ob.materials, opts);
    if (strokeGeom) {
      const mat = makeStrokeMaterial(this.resolution, layer.blendMode);
      const mesh = new THREE.Mesh(strokeGeom, mat);
      mesh.renderOrder = order + 1;
      mesh.applyMatrix4(layerMatrix);
      mesh.frustumCulled = false;
      entry.disposables.push(strokeGeom, mat);
      meshes.push(mesh);
    }
    return meshes;
  }

  /** Renders mask layers' geometry into the stencil buffer (color off). */
  private buildMaskWriters(
    ob: GPObject, layer: GPLayer, scene: GPScene, state: RenderState,
    entry: LayerCacheEntry, order: number, ref: number,
  ): boolean {
    let wrote = false;
    for (const maskId of layer.maskLayerIds) {
      const maskLayer = ob.layers.find((l) => l.id === maskId);
      if (!maskLayer) continue;
      const kf = frameAt(maskLayer, remapTime(ob, maskLayer, scene.frame));
      if (!kf) continue;
      const strokes = evaluateModifiers(kf.strokes, ob, maskLayer, scene.frame, kf.frameNumber);
      const opts: BuildOptions = {
        layerOpacity: 1, tint: [0, 0, 0, 0], thicknessOffset: 0, background: state.background,
      };
      for (const geomBuilder of [buildFillGeometry, buildStrokeGeometry]) {
        const geom = geomBuilder(strokes, ob.materials, opts);
        if (!geom) continue;
        const mat = geomBuilder === buildStrokeGeometry
          ? makeStrokeMaterial(this.resolution, 'REGULAR')
          : makeFillMaterial('REGULAR');
        mat.colorWrite = false;
        mat.depthWrite = false;
        mat.stencilWrite = true;
        mat.stencilRef = ref;
        mat.stencilFunc = THREE.AlwaysStencilFunc;
        mat.stencilZPass = THREE.ReplaceStencilOp;
        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = order;
        mesh.frustumCulled = false;
        entry.disposables.push(geom, mat);
        entry.group.add(mesh);
        wrote = true;
      }
    }
    return wrote;
  }

  private buildOnion(
    ob: GPObject, layer: GPLayer, frame: number, entry: LayerCacheEntry, order: number,
  ): void {
    const { mode, before, after, colorBefore, colorAfter, opacity } = ob.onion;
    const ghosts: { kfIndex: number; dist: number; isBefore: boolean }[] = [];
    const curIdx = keyframeIndexAt(layer, frame);
    if (mode === 'KEYFRAMES') {
      for (let i = 1; i <= before; i++) {
        const idx = curIdx - i;
        if (idx >= 0) ghosts.push({ kfIndex: idx, dist: i, isBefore: true });
      }
      for (let i = 1; i <= after; i++) {
        const idx = curIdx + i;
        if (idx < layer.frames.length) ghosts.push({ kfIndex: idx, dist: i, isBefore: false });
      }
    } else {
      const seen = new Set<number>([curIdx]);
      for (let i = 1; i <= Math.max(before, after); i++) {
        for (const [target, isBefore, limit] of [[frame - i, true, before], [frame + i, false, after]] as const) {
          if (i > limit) continue;
          const idx = keyframeIndexAt(layer, target);
          if (idx >= 0 && !seen.has(idx)) { seen.add(idx); ghosts.push({ kfIndex: idx, dist: i, isBefore }); }
        }
      }
    }
    for (const g of ghosts) {
      const kf = layer.frames[g.kfIndex];
      if (!kf) continue;
      const fade = Math.max(0.1, 1 - (g.dist - 1) * 0.3);
      const opts: BuildOptions = {
        layerOpacity: layer.opacity,
        tint: [0, 0, 0, 0],
        thicknessOffset: layer.thicknessOffset,
        background: [0, 0, 0],
        colorOverride: { color: g.isBefore ? colorBefore : colorAfter, opacity: opacity * fade },
      };
      const meshes = this.buildLayerMeshes(kf.strokes, ob, layer, opts, order, entry);
      for (const m of meshes) entry.group.add(m);
    }
  }

  /** Point/selection overlay for edit-family modes. */
  private buildOverlay(
    strokes: GPStroke[], layer: GPLayer, state: RenderState, order: number,
    entry: LayerCacheEntry,
  ): THREE.Points | null {
    const pos: number[] = [], col: number[] = [];
    for (const s of strokes) {
      for (const p of s.points) {
        pos.push(...p.co);
        if (state.mode === 'WEIGHT') {
          const w = p.weight;
          col.push(Math.min(1, w * 2), 1 - Math.abs(w - 0.5) * 2 < 0 ? 0 : 1 - Math.abs(w - 0.5) * 2, Math.min(1, (1 - w) * 2));
        } else if (p.select || (state.selectMode === 'STROKE' && s.select)) {
          col.push(1, 0.62, 0.1);
        } else {
          col.push(0.1, 0.1, 0.1);
        }
      }
    }
    if (!pos.length) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 6, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true,
    });
    const layerMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...layer.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...layer.rotation)),
      new THREE.Vector3(...layer.scale),
    );
    const points = new THREE.Points(geom, mat);
    points.applyMatrix4(layerMatrix);
    points.renderOrder = order;
    points.frustumCulled = false;
    entry.disposables.push(geom, mat);
    return points;
  }
}
