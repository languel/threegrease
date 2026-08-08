// Lazy facade over the Spark splat adapter (./spark.ts).
//
// Spark is ~4.9MB — 80% of the production bundle — and a session that never
// opens a .ply/.spz never needs a byte of it. This keeps the same public API
// SplatManager always had, but defers importing ./spark.ts until a scene
// actually contains splats, which cuts first load from ~2.0MB gzipped to
// ~0.33MB for everyone who is just drawing.
//
// The scene-graph group is owned HERE, not by the Spark module: it is
// parented into scene3 during App construction, long before the dynamic
// import can resolve, so it has to exist synchronously from the start.
import * as THREE from 'three';
import type { GPScene } from '../core/types';
import type { SparkSplats } from './spark';

export class SplatManager {
  readonly group = new THREE.Group();
  /** load errors by splat id, surfaced in the UI */
  readonly errors = new Map<number, string>();

  private impl: SparkSplats | null = null;
  private loading: Promise<void> | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  /** Called after a lazy load finishes, so the frame loop repaints — the
   *  import resolves between frames and nothing else would mark dirty. */
  onLoaded: (() => void) | null = null;

  /** Must be called once with the app's WebGLRenderer before any splat loads. */
  init(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    this.impl?.init(renderer);
  }

  /** Create/dispose/transform splat meshes to mirror scene.splats.
   *  Called every frame: the no-splats path must stay allocation-free and
   *  must not touch the Spark module at all. */
  sync(scene: GPScene): void {
    if (!this.impl) {
      if (scene.splats.length) void this.load(scene);
      return;
    }
    this.impl.sync(scene);
  }

  /** Import ./spark.ts once, then hand it the group/errors it renders into. */
  private load(scene: GPScene): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = import('./spark')
      .then(({ SparkSplats }) => {
        this.impl = new SparkSplats(this.group, this.errors);
        if (this.renderer) this.impl.init(this.renderer);
        this.impl.sync(scene);
        this.onLoaded?.();
      })
      .catch((err) => {
        // surface against every splat that asked for it, rather than
        // failing silently with an empty viewport
        for (const s of scene.splats) this.errors.set(s.id, `splat engine failed to load: ${err}`);
      });
    return this.loading;
  }

  meshFor(id: number): THREE.Object3D | null { return this.impl?.meshFor(id) ?? null; }

  /** Splats flagged as draw targets, for ctx.surfaces (SURFACE placement). */
  drawTargets(scene: GPScene): THREE.Object3D[] {
    return this.impl?.drawTargets(scene) ?? [];
  }

  dispose(): void { this.impl?.dispose(); }

  /** Serialize a loaded splat to a standard (uncompressed) 3DGS PLY.
   *  Null when nothing is loaded — which is also the no-Spark case. */
  exportPly(id: number): ArrayBuffer | null { return this.impl?.exportPly(id) ?? null; }
}
