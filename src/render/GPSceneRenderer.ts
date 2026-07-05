import * as THREE from 'three';
import type { GPLayer, GPObject, GPScene, GPStroke, Vec3 } from '../core/types';
import { frameAt, keyframeIndexAt } from '../core/gpdata';
import { evaluateModifiers, remapTime } from '../modifiers/index';
import { buildFillGeometry, buildStrokeGeometry, type BuildOptions } from './geometry';
import { applyBlendMode, makeFillMaterial, makeStrokeMaterial } from './materials';

export type EditorMode = 'DRAW' | 'EDIT' | 'SCULPT' | 'VERTEX' | 'WEIGHT';

export interface RenderState {
  mode: EditorMode;
  background: Vec3;
  playing: boolean;
  selectMode: 'POINT' | 'STROKE';
}

/**
 * Syncs GPScene data -> three.js meshes. Full rebuild on demand (call
 * markDirty() after mutations); geometry is cheap to rebuild at sketch scale.
 */
export class GPSceneRenderer {
  readonly root = new THREE.Group();
  readonly resolution = new THREE.Vector2(1, 1);
  private dirty = true;
  /** Groups per GP object, exposed for the effects pipeline. */
  readonly objectGroups: THREE.Group[] = [];
  private disposables: { dispose(): void }[] = [];
  private stencilCounter = 1;

  markDirty(): void { this.dirty = true; }
  get needsRebuild(): boolean { return this.dirty; }

  setSize(w: number, h: number): void { this.resolution.set(w, h); }

  update(scene: GPScene, state: RenderState): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.stencilCounter = 1;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.root.clear();
    this.objectGroups.length = 0;

    scene.objects.forEach((ob, obIndex) => {
      const group = new THREE.Group();
      group.position.set(...ob.translation);
      group.rotation.set(...ob.rotation);
      group.scale.set(...ob.scale);
      group.userData.gpObject = obIndex;
      this.buildObject(ob, scene, state, group, obIndex);
      this.root.add(group);
      this.objectGroups.push(group);
    });
  }

  private buildObject(
    ob: GPObject, scene: GPScene, state: RenderState, group: THREE.Group, obIndex: number,
  ): void {
    const isActive = obIndex === scene.activeObject;
    const baseOrder = obIndex * 1000;

    ob.layers.forEach((layer, li) => {
      if (layer.hide) return;
      const order = baseOrder + li * 8;

      // --- onion skins (under the real frame) ---
      if (ob.onion.enabled && layer.useOnion && isActive && !state.playing) {
        this.buildOnion(ob, layer, scene.frame, group, order);
      }

      // --- current frame, modifier-evaluated ---
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
      const meshes = this.buildLayerMeshes(strokes, ob, layer, opts, order + 4);
      let stencilRef = 0;
      if (layer.useMask && layer.maskLayerIds.length) {
        stencilRef = this.buildMaskWriters(ob, layer, scene, state, group, order + 2);
        if (stencilRef > 0) {
          for (const m of meshes) {
            const mat = m.material as THREE.Material;
            mat.stencilWrite = true;
            mat.stencilRef = stencilRef;
            mat.stencilFunc = THREE.EqualStencilFunc;
            mat.stencilZPass = THREE.KeepStencilOp;
          }
        }
      }
      for (const m of meshes) group.add(m);

      // --- edit overlays for the active layer set ---
      if (isActive && state.mode !== 'DRAW' && !layer.lock) {
        const overlay = this.buildOverlay(kf.strokes, layer, state, order + 7);
        if (overlay) group.add(overlay);
      }
    });
  }

  private buildLayerMeshes(
    strokes: GPStroke[], ob: GPObject, layer: GPLayer, opts: BuildOptions, order: number,
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
      this.disposables.push(fillGeom, mat);
      meshes.push(mesh);
    }
    const strokeGeom = buildStrokeGeometry(strokes, ob.materials, opts);
    if (strokeGeom) {
      const mat = makeStrokeMaterial(this.resolution, layer.blendMode);
      const mesh = new THREE.Mesh(strokeGeom, mat);
      mesh.renderOrder = order + 1;
      mesh.applyMatrix4(layerMatrix);
      mesh.frustumCulled = false;
      this.disposables.push(strokeGeom, mat);
      meshes.push(mesh);
    }
    return meshes;
  }

  /** Renders mask layers' geometry into the stencil buffer (color off). */
  private buildMaskWriters(
    ob: GPObject, layer: GPLayer, scene: GPScene, state: RenderState,
    group: THREE.Group, order: number,
  ): number {
    const ref = this.stencilCounter++;
    if (ref > 250) return 0;
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
        this.disposables.push(geom, mat);
        group.add(mesh);
        wrote = true;
      }
    }
    return wrote ? ref : 0;
  }

  private buildOnion(
    ob: GPObject, layer: GPLayer, frame: number, group: THREE.Group, order: number,
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
      const meshes = this.buildLayerMeshes(kf.strokes, ob, layer, opts, order);
      for (const m of meshes) group.add(m);
    }
  }

  /** Point/selection overlay for edit-family modes. */
  private buildOverlay(
    strokes: GPStroke[], layer: GPLayer, state: RenderState, order: number,
  ): THREE.Points | null {
    const pos: number[] = [], col: number[] = [];
    for (const s of strokes) {
      for (const p of s.points) {
        pos.push(...p.co);
        if (state.mode === 'WEIGHT') {
          // blue (0) -> green (0.5) -> red (1)
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
    this.disposables.push(geom, mat);
    return points;
  }
}
