// Spark adapter (P7). This is the ONLY file that imports @sparkjsdev/spark —
// keep the dependency isolated so version churn stays contained.
// SplatMesh is a THREE.Object3D: it renders alongside our stroke meshes and
// participates in depth, so strokes occlude with splats naturally.
//
// LOADED LAZILY. Spark is ~4.9MB of the bundle (80% of it) and is dead
// weight for every session that never opens a splat, so ./index.ts is a
// facade that dynamic-imports this module the first time a scene actually
// has splats in it. Nothing outside ./index.ts may import this file
// statically or that saving is silently undone — import the facade.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { resolveSrc, sourceName } from '../io/blobstore';
import type { GPScene, TGSplat } from '../core/types';
import { worldMatrixOf } from '../tools/objects';

export class SparkSplats {
  /** The facade owns the group (it's already parented into scene3 before
   *  this module exists), so meshes are added into the group we're given
   *  rather than one of our own. */
  private readonly group: THREE.Group;
  private readonly errors: Map<number, string>;

  constructor(group: THREE.Group, errors: Map<number, string>) {
    this.group = group;
    this.errors = errors;
  }

  private meshes = new Map<number, { mesh: SplatMesh; src: string }>();
  /** splats whose source is still being resolved to a URL */
  private pending = new Set<number>();
  private lastScene: GPScene | null = null;
  private spark: SparkRenderer | null = null;

  /** Must be called once with the app's WebGLRenderer before any splat loads. */
  init(renderer: THREE.WebGLRenderer): void {
    if (this.spark) return;
    this.spark = new SparkRenderer({ renderer });
    // the selection outline isolates objects by hiding everything else; the
    // one renderer that draws EVERY splat must survive that (render/outline.ts)
    this.spark.userData.splatRenderer = true;
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
      if (!this.meshes.has(data.id) && !this.pending.has(data.id)) {
        // A stored file has to be turned into a URL first (asynchronously),
        // so the mesh arrives a moment later; `pending` stops the next sync
        // from starting a second load of the same splat meanwhile. The
        // fileName goes along because Spark, like three, picks its parser by
        // extension, and an object URL has none.
        const src = data.src;
        this.pending.add(data.id);
        void resolveSrc(src).then((url) => {
          this.pending.delete(data.id);
          if (this.meshes.has(data.id)) return;
          // only a name WITH an extension helps; an old blob: URL's "name"
          // is a uuid, and Spark does better sniffing the bytes than trusting it
          const name = sourceName(src);
          const mesh = new SplatMesh(name.includes('.') ? { url, fileName: name } : { url });
          mesh.userData.splatId = data.id;
          this.group.add(mesh);
          this.meshes.set(data.id, { mesh, src });
          const now = this.lastScene?.splats.find((s) => s.id === data.id);
          if (now && this.lastScene) this.applyTransform(mesh, now, this.lastScene);
          void Promise.resolve((mesh as unknown as { initialized?: Promise<unknown> }).initialized)
            .catch((err) => this.errors.set(data.id, String(err)));
        }).catch((err) => {
          this.pending.delete(data.id);
          this.errors.set(data.id, String(err));
        });
      }
      const entry = this.meshes.get(data.id);
      if (entry) this.applyTransform(entry.mesh, data, scene);
    }
    this.lastScene = scene;
    void wanted;
  }

  private applyTransform(mesh: SplatMesh, data: TGSplat, scene: GPScene): void {
    // parent-aware world placement (matrix, so baked shear survives)
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(worldMatrixOf(scene, { kind: 'SPLAT', id: data.id }));
    mesh.visible = data.visible;
  }

  meshFor(id: number): SplatMesh | null { return this.meshes.get(id)?.mesh ?? null; }

  /** Splats flagged as draw targets, for ctx.surfaces (SURFACE placement). */
  drawTargets(scene: GPScene): THREE.Object3D[] {
    return scene.splats
      .filter((s) => s.visible && s.drawTarget)
      .map((s) => this.meshes.get(s.id)?.mesh)
      .filter((m): m is SplatMesh => !!m);
  }

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
