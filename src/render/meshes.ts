// Mesh scene objects (object mode): primitive solids/planes and imported
// models, mirroring scene.meshes — reference geometry or Surface-placement
// draw targets. Same lifecycle pattern as SplatManager.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { GPScene, TGMesh, Vec3 } from '../core/types';
import { worldMatrixOf } from '../tools/objects';

function vec3Eq(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function primitiveGeometry(kind: TGMesh['kind']): THREE.BufferGeometry {
  switch (kind) {
    case 'PLANE': return new THREE.PlaneGeometry(2, 2);
    case 'BOX': return new THREE.BoxGeometry(1, 1, 1);
    case 'SPHERE': return new THREE.SphereGeometry(0.6, 32, 24);
    case 'CYLINDER': return new THREE.CylinderGeometry(0.5, 0.5, 1.2, 24);
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

export class MeshManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, { root: THREE.Object3D; src?: string; kind: string; unlit?: boolean; originOffset: Vec3; live?: boolean }>();
  private textures = new Map<string, THREE.Texture>();
  readonly errors = new Map<number, string>();

  private textureFor(src: string): THREE.Texture {
    let tex = this.textures.get(src);
    if (!tex) {
      tex = new THREE.TextureLoader().load(src);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(src, tex);
    }
    return tex;
  }

  /** Rebuild/update mesh objects to mirror scene.meshes (camera for view locks). */
  sync(scene: GPScene, camera?: THREE.Camera): void {
    for (const [id, entry] of this.entries) {
      const data = scene.meshes.find((m) => m.id === id);
      if (!data || data.src !== entry.src || data.kind !== entry.kind) {
        this.group.remove(entry.root);
        this.disposeTree(entry.root);
        this.entries.delete(id);
        this.errors.delete(id);
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
      // unlit toggles swap the material class on primitives
      if (data.kind !== 'MODEL' && data.kind !== 'EMPTY' && entry.unlit !== !!data.unlit) {
        const mesh = entry.root as THREE.Mesh;
        (mesh.material as THREE.Material)?.dispose?.();
        mesh.material = data.unlit
          ? new THREE.MeshBasicMaterial()
          : new THREE.MeshStandardMaterial();
        entry.unlit = !!data.unlit;
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
        else new GLTFLoader().load(data.src, (g) => onLoad(g.scene), undefined, onErr);
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
      if (data.kind !== 'MODEL' && !live) {
        mat.color.setRGB(...data.color);
        const tex = data.texture ? this.textureFor(data.texture) : null;
        if (mat.map !== tex) {
          mat.map = tex;
          if (tex) mat.color.setRGB(1, 1, 1); // don't tint the image
          mat.needsUpdate = true;
        }
      } else if (live) {
        // texture-paint stroke in flight: the tool owns the map (a
        // CanvasTexture over its paint canvas) — don't fight it
        mat.color.setRGB(1, 1, 1);
      }
      mat.wireframe = data.wireframe;
      mat.side = data.doubleSided !== false ? THREE.DoubleSide : THREE.FrontSide;
      mat.transparent = data.opacity < 1 || !!(mat.map);
      mat.opacity = data.opacity;
      mat.depthWrite = data.opacity >= 0.99;
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
