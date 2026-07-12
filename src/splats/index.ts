// Spark adapter (P7). This is the ONLY file that imports @sparkjsdev/spark —
// keep the dependency isolated so version churn stays contained.
// SplatMesh is a THREE.Object3D: it renders alongside our stroke meshes and
// participates in depth, so strokes occlude with splats naturally.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { GPScene, TGSplat } from '../core/types';
import { worldMatrixOf } from '../tools/objects';

export class SplatManager {
  readonly group = new THREE.Group();
  private meshes = new Map<number, { mesh: SplatMesh; src: string }>();
  private spark: SparkRenderer | null = null;
  /** load errors by splat id, surfaced in the UI */
  readonly errors = new Map<number, string>();

  /** Must be called once with the app's WebGLRenderer before any splat loads. */
  init(renderer: THREE.WebGLRenderer): void {
    if (this.spark) return;
    this.spark = new SparkRenderer({ renderer });
    this.group.add(this.spark);
  }

  /** Create/dispose/transform splat meshes to mirror scene.splats. */
  sync(scene: GPScene): void {
    const wanted = new Set(scene.splats.map((s) => s.id));
    for (const [id, entry] of this.meshes) {
      const data = scene.splats.find((s) => s.id === id);
      if (!data || data.src !== entry.src) {
        this.group.remove(entry.mesh);
        entry.mesh.dispose?.();
        this.meshes.delete(id);
        this.errors.delete(id);
      }
    }
    for (const data of scene.splats) {
      if (!this.meshes.has(data.id)) {
        try {
          const mesh = new SplatMesh({ url: data.src });
          mesh.userData.splatId = data.id;
          this.group.add(mesh);
          this.meshes.set(data.id, { mesh, src: data.src });
          void Promise.resolve((mesh as unknown as { initialized?: Promise<unknown> }).initialized)
            .catch((err) => this.errors.set(data.id, String(err)));
        } catch (err) {
          this.errors.set(data.id, String(err));
        }
      }
      const entry = this.meshes.get(data.id);
      if (entry) this.applyTransform(entry.mesh, data, scene);
    }
    void wanted;
  }

  private applyTransform(mesh: SplatMesh, data: TGSplat, scene: GPScene): void {
    // parent-aware world placement
    worldMatrixOf(scene, { kind: 'SPLAT', id: data.id })
      .decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.visible = data.visible;
  }

  meshFor(id: number): SplatMesh | null { return this.meshes.get(id)?.mesh ?? null; }

  dispose(): void {
    for (const { mesh } of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.dispose?.();
    }
    this.meshes.clear();
  }

  /**
   * Serialize a loaded splat to a standard (uncompressed) 3DGS PLY —
   * the interchange format every splat tool reads. Inverse of the usual
   * reader transforms: opacity -> logit, scale -> log, color -> f_dc.
   */
  exportPly(id: number): ArrayBuffer | null {
    const mesh = this.meshFor(id);
    const packed = (mesh as unknown as { packedSplats?: {
      getNumSplats(): number;
      forEachSplat(cb: (index: number, center: THREE.Vector3, scales: THREE.Vector3,
        quaternion: THREE.Quaternion, opacity: number, color: THREE.Color) => void): void;
    } })?.packedSplats;
    if (!packed) return null;
    const n = packed.getNumSplats();
    if (!n) return null;

    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
      'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n`
      + props.map((p) => `property float ${p}`).join('\n') + '\nend_header\n';
    const headerBytes = new TextEncoder().encode(header);
    const buffer = new ArrayBuffer(headerBytes.length + n * props.length * 4);
    new Uint8Array(buffer).set(headerBytes);
    const view = new DataView(buffer, headerBytes.length);
    const SH_C0 = 0.28209479177387814;
    const logit = (v: number) => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, v)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, v))));
    let off = 0;
    const put = (v: number) => { view.setFloat32(off, v, true); off += 4; };
    packed.forEachSplat((_i, center, scales, quat, opacity, color) => {
      put(center.x); put(center.y); put(center.z);
      put((color.r - 0.5) / SH_C0); put((color.g - 0.5) / SH_C0); put((color.b - 0.5) / SH_C0);
      put(logit(opacity));
      put(Math.log(Math.max(1e-9, scales.x)));
      put(Math.log(Math.max(1e-9, scales.y)));
      put(Math.log(Math.max(1e-9, scales.z)));
      put(quat.w); put(quat.x); put(quat.y); put(quat.z);
    });
    return buffer;
  }
}
