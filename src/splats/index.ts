// Spark adapter (P7). This is the ONLY file that imports @sparkjsdev/spark —
// keep the dependency isolated so version churn stays contained.
// SplatMesh is a THREE.Object3D: it renders alongside our stroke meshes and
// participates in depth, so strokes occlude with splats naturally.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { GPScene, TGSplat } from '../core/types';

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
      if (entry) this.applyTransform(entry.mesh, data);
    }
    void wanted;
  }

  private applyTransform(mesh: SplatMesh, data: TGSplat): void {
    mesh.position.set(...data.translation);
    mesh.rotation.set(...data.rotation);
    mesh.scale.setScalar(data.scale);
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
}
