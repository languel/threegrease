// Approximate splat-point picking adapter for the editable-mesh tool.
// The ONLY poly-system code that knows about the Spark splat integration.
//
// Method (coarse by design, documented in docs/design/polymesh.md):
// Spark exposes no hit-testing API here, so we enumerate splat centers via
// packedSplats.forEachSplat ONCE per splat (cached, sampled with a stride
// so at most SAMPLE_CAP local centers are kept), then per query project the
// cached centers of each visible splat to screen space and take the
// nearest inside the pixel threshold. Precision = "nearest sampled center",
// not a surface hit; large clouds are subsampled, so the picked point may
// skip fine detail. No unbounded full-cloud scan happens on pointer moves.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { Vec3 } from '../core/types';
import { worldMatrixOf } from './objects';
import type { SplatManager } from '../splats/index';

const SAMPLE_CAP = 5000;

let source: SplatManager | null = null;
/** Wired once from App init (keeps the manager out of AppCtx). */
export function setSplatPickSource(mgr: SplatManager): void { source = mgr; }

interface Cache { src: string; centers: Float32Array; indices: Uint32Array }
const caches = new Map<number, Cache>();

function centersFor(splatId: number, src: string): Cache | null {
  const hit = caches.get(splatId);
  if (hit && hit.src === src) return hit;
  const mesh = source?.meshFor(splatId);
  const packed = (mesh as unknown as {
    packedSplats?: {
      getNumSplats(): number;
      forEachSplat(cb: (index: number, center: THREE.Vector3) => void): void;
    };
  } | null)?.packedSplats;
  if (!packed) return null;
  const n = packed.getNumSplats();
  if (!n) return null;
  const stride = Math.max(1, Math.ceil(n / SAMPLE_CAP));
  const kept = Math.ceil(n / stride);
  const centers = new Float32Array(kept * 3);
  const indices = new Uint32Array(kept);
  let w = 0;
  packed.forEachSplat((i, center) => {
    if (i % stride !== 0 || w >= kept) return;
    centers[w * 3] = center.x;
    centers[w * 3 + 1] = center.y;
    centers[w * 3 + 2] = center.z;
    indices[w] = i;
    w++;
  });
  const cache = { src, centers: centers.subarray(0, w * 3), indices: indices.subarray(0, w) };
  caches.set(splatId, cache);
  return cache;
}

export function pickSplatPoint(
  ctx: AppCtx, x: number, y: number, thresholdPx: number,
): { objectId: number; pointIndex: number; world: Vec3; d: number } | null {
  if (!source) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  const wp = new THREE.Vector3();
  let best: { objectId: number; pointIndex: number; world: Vec3; d: number } | null = null;
  for (const s of ctx.scene.splats) {
    if (!s.visible) continue;
    const cache = centersFor(s.id, s.src);
    if (!cache) continue;
    const world = worldMatrixOf(ctx.scene, { kind: 'SPLAT', id: s.id });
    for (let i = 0; i < cache.indices.length; i++) {
      wp.set(cache.centers[i * 3], cache.centers[i * 3 + 1], cache.centers[i * 3 + 2]).applyMatrix4(world);
      const p = wp.clone().project(ctx.camera);
      if (p.z > 1) continue;
      const sx = (p.x * 0.5 + 0.5) * rect.width, sy = (-p.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < thresholdPx && (!best || d < best.d)) {
        best = { objectId: s.id, pointIndex: cache.indices[i], world: [wp.x, wp.y, wp.z], d };
      }
    }
  }
  return best;
}
