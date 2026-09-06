// Mesh scene objects (object mode): primitive solids/planes and imported
// models, mirroring scene.meshes — reference geometry or Surface-placement
// draw targets. Same lifecycle pattern as SplatManager.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { GPScene, TGMesh, Vec3 } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import { materialManager } from './materialmgr';
import { VrmManager, vrmManager } from './vrm';

function vec3Eq(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function primitiveGeometry(kind: TGMesh['kind']): THREE.BufferGeometry {
  switch (kind) {
    case 'PLANE': return new THREE.PlaneGeometry(2, 2);
    case 'BOX': return new THREE.BoxGeometry(1, 1, 1);
    // radius 0.5 = diameter 1, matching BOX's 1-unit edge and CYLINDER's
    // 1-unit diameter (radius 0.5 below) — a "unit sphere" here means
    // matching its sibling primitives' default footprint, not literally
    // radius 1 (which made it visibly 2x the size of the default box).
    case 'SPHERE': return new THREE.SphereGeometry(0.5, 32, 24);
    case 'CYLINDER': return new THREE.CylinderGeometry(0.5, 0.5, 1.2, 24);
    // a cone with four sides is a pyramid, and it needs no new geometry
    // path — flat-shaded so the four faces read as facets, not as a cone
    case 'PYRAMID': return new THREE.ConeGeometry(0.5, 1, 4, 1);
    // the remaining platonic solids, all unit-diameter like SPHERE so
    // "scale is size" keeps holding across the whole primitive family
    case 'TETRA': return new THREE.TetrahedronGeometry(0.5);
    case 'OCTA': return new THREE.OctahedronGeometry(0.5);
    case 'DODECA': return new THREE.DodecahedronGeometry(0.5);
    case 'ICOSA': return new THREE.IcosahedronGeometry(0.5);
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

export class MeshManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, { root: THREE.Object3D; src?: string; kind: string; unlit?: boolean; originOffset: Vec3; live?: boolean }>();
  readonly errors = new Map<number, string>();
  /**
   * Animation that came in with a MODEL. RUNTIME state, not scene data: the
   * clips belong to the file, and what the document keeps is whatever you
   * retargeted OUT of them (a TGClip). Keyed by mesh id.
   */
  readonly modelAnimations = new Map<number, {
    root: THREE.Object3D; clips: THREE.AnimationClip[];
  }>();

  /** Rebuild/update mesh objects to mirror scene.meshes (camera for view locks). */
  sync(scene: GPScene, camera?: THREE.Camera): void {
    for (const [id, entry] of this.entries) {
      const data = scene.meshes.find((m) => m.id === id);
      if (!data || data.src !== entry.src || data.kind !== entry.kind) {
        this.group.remove(entry.root);
        this.disposeTree(entry.root);
        this.entries.delete(id);
        this.errors.delete(id);
        this.modelAnimations.delete(id);
        vrmManager.forget(id);
      }
    }
    for (const data of scene.meshes) {
      let entry = this.entries.get(data.id);
      if (!entry) {
        // build() always makes a Standard material; unlit:false so the
        // first sync swaps it when the data says unlit
        entry = { root: this.build(data), src: data.src, kind: data.kind, unlit: false, originOffset: [0, 0, 0] };
        entry.root.userData.meshId = data.id;
        entry.root.traverse((o) => { o.userData.meshId = data.id; });
        this.group.add(entry.root);
        this.entries.set(data.id, entry);
      }
      // unlit toggles swap the material class on primitives (the flag comes
      // from the material datablock when assigned, else the legacy field)
      const wantUnlit = materialManager.wantsUnlit(scene, data.materialId, {
        color: data.color, opacity: data.opacity, texture: data.texture,
        unlit: data.unlit, doubleSided: data.doubleSided, wireframe: data.wireframe,
      });
      if (data.kind !== 'MODEL' && data.kind !== 'EMPTY' && entry.unlit !== wantUnlit) {
        const mesh = entry.root as THREE.Mesh;
        (mesh.material as THREE.Material)?.dispose?.();
        mesh.material = wantUnlit
          ? new THREE.MeshBasicMaterial()
          : new THREE.MeshStandardMaterial();
        entry.unlit = wantUnlit;
      }
      // Set Origin (primitives only, see objectops.ts meshLocalBounds): the
      // origin op writes translation + originOffset together so world-space
      // geometry doesn't jump; bake the offset DELTA into the procedural
      // geometry's vertex positions (it has no other persisted shape data).
      const off = data.originOffset ?? [0, 0, 0];
      if (data.kind !== 'MODEL' && data.kind !== 'EMPTY' && !vec3Eq(off, entry.originOffset)) {
        const geo = (entry.root as THREE.Mesh).geometry;
        geo.translate(off[0] - entry.originOffset[0], off[1] - entry.originOffset[1], off[2] - entry.originOffset[2]);
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        entry.originOffset = [...off];
      }
      this.apply(entry.root, data, scene, camera, entry.live);
    }
  }

  private build(data: TGMesh): THREE.Object3D {
    if (data.kind === 'EMPTY') {
      // Blender "Plain Axes": six half-axes from the origin, plus an
      // invisible-but-raycastable sphere so it stays clickable
      const group = new THREE.Group();
      const r = 0.35;
      const pos = [
        -r, 0, 0, r, 0, 0,
        0, -r, 0, 0, r, 0,
        0, 0, -r, 0, 0, r,
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const axes = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbbbbc4 }));
      axes.userData.emptyHelper = true;
      const pick = new THREE.Mesh(
        new THREE.SphereGeometry(r * 0.5, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      pick.userData.emptyHelper = true;
      group.add(axes, pick);
      return group;
    }
    if (data.kind === 'MODEL' && data.src) {
      const holder = new THREE.Group();
      const ext = data.src.split('?')[0].split('.').pop()?.toLowerCase();
      const onLoad = (obj: THREE.Object3D) => {
        obj.traverse((o) => { o.userData.meshId = data.id; });
        holder.add(obj);
      };
      const onErr = (err: unknown) => this.errors.set(data.id, String(err));
      try {
        if (ext === 'obj') new OBJLoader().load(data.src, onLoad, undefined, onErr);
        else {
          const loader = new GLTFLoader();
          // Always registered: a VRM IS a glTF, so rather than sniffing the
          // extension (blob: URLs have none anyway) we let the plugin decide
          // and check whether it produced a humanoid.
          VrmManager.prepare(loader);
          loader.load(data.src, (g) => {
            onLoad(g.scene);
            vrmManager.adopt(data.id, g as unknown as { scene: THREE.Object3D });
            // Keep the animation. It used to be dropped here, which is why
            // a Mixamo export imported as a statue: the geometry arrived
            // and the motion was thrown away in the same line.
            if (g.animations?.length) {
              this.modelAnimations.set(data.id, { root: g.scene, clips: g.animations });
            }
          }, undefined, onErr);
        }
      } catch (err) { onErr(err); }
      return holder;
    }
    const mesh = new THREE.Mesh(
      primitiveGeometry(data.kind),
      new THREE.MeshStandardMaterial(),
    );
    return mesh;
  }

  private apply(root: THREE.Object3D, data: TGMesh, scene: GPScene, camera?: THREE.Camera, live?: boolean): void {
    if (data.billboard === 'CAMERA' && camera) {
      // locked to the view: local transform is a camera-space offset
      camera.updateMatrixWorld();
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(...data.translation),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...data.rotation)),
        new THREE.Vector3(...data.scale),
      );
      root.matrixAutoUpdate = false;
      root.matrix.copy(camera.matrixWorld).multiply(local);
    } else if (data.billboard === 'FACE_VIEW' && camera) {
      root.matrixAutoUpdate = true;
      worldMatrixOf(scene, { kind: 'MESH', id: data.id })
        .decompose(root.position, root.quaternion, root.scale);
      root.quaternion.copy((camera as THREE.PerspectiveCamera).quaternion);
    } else {
      root.matrixAutoUpdate = false;
      root.matrix.copy(worldMatrixOf(scene, { kind: 'MESH', id: data.id }));
    }
    root.visible = data.visible;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.emptyHelper) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat || Array.isArray(mat)) return;
      // shadows are per-light opt-in; meshes always participate so turning
      // a light's castShadow on Just Works with no per-object setup
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (data.kind !== 'MODEL') {
        // shared material datablock, falling back to this object's own
        // legacy flattened fields when it has no materialId yet
        materialManager.apply(mat, scene, data.materialId, {
          color: data.color, opacity: data.opacity, texture: data.texture,
          unlit: data.unlit, doubleSided: data.doubleSided, wireframe: data.wireframe,
        }, !!live);
      } else {
        // MODEL imports own their materials (from the GLTF/OBJ); only the
        // non-color display props are ours to set
        if (live) mat.color.setRGB(1, 1, 1);
        mat.wireframe = data.wireframe;
        mat.side = data.doubleSided !== false ? THREE.DoubleSide : THREE.FrontSide;
        mat.transparent = data.opacity < 1 || !!(mat.map);
        mat.opacity = data.opacity;
        mat.depthWrite = data.opacity >= 0.99;
      }
      // selection feedback is the Box3Helper outline (App.syncSelectionGlyphs)
      // only, Blender-style — no whole-object color wash here.
    });
  }

  rootFor(id: number): THREE.Object3D | null { return this.entries.get(id)?.root ?? null; }

  /** Meshes flagged as draw targets, for ctx.surfaces (empties never). */
  drawTargets(scene: GPScene): THREE.Object3D[] {
    return scene.meshes
      .filter((m) => m.visible && m.drawTarget && m.kind !== 'EMPTY')
      .map((m) => this.entries.get(m.id)?.root)
      .filter((r): r is THREE.Object3D => !!r);
  }

  /** Texture painting: while a stroke is in flight the tool paints into
   *  an offscreen canvas and we show it live as a CanvasTexture; apply()
   *  leaves the map alone until endLiveTexture(). */
  beginLiveTexture(id: number, canvas: HTMLCanvasElement): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.live = true;
    const mesh = entry.root as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat || Array.isArray(mat)) return;
    if (!(mat.map instanceof THREE.CanvasTexture) || mat.map.image !== canvas) {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.transparent = true;
      mat.needsUpdate = true;
    }
  }

  /** Repaint after new stamps landed on the live canvas. */
  refreshLiveTexture(id: number): void {
    const mesh = this.entries.get(id)?.root as THREE.Mesh | undefined;
    const mat = mesh?.material as THREE.MeshStandardMaterial | undefined;
    if (mat?.map) mat.map.needsUpdate = true;
  }

  endLiveTexture(id: number): void {
    const entry = this.entries.get(id);
    if (entry) entry.live = false; // next sync re-applies data.texture
  }

  private disposeTree(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material;
      if (mat && !Array.isArray(mat)) mat.dispose?.();
    });
  }
}

export function createMeshObject(id: number, kind: TGMesh['kind'], at: [number, number, number], src?: string): TGMesh {
  return {
    id, name: src ? (src.split('/').pop() ?? 'model') : kind.toLowerCase(),
    kind, src,
    translation: [...at], rotation: [0, 0, 0], scale: [1, 1, 1],
    visible: true, select: false, drawTarget: kind !== 'EMPTY', wireframe: false,
    color: [0.62, 0.65, 0.72], opacity: 1,
    parent: null, texture: null, unlit: false, doubleSided: true, billboard: 'NONE',
    originOffset: [0, 0, 0],
  };
}
