// Point-cloud picking adapters: nearest-splat-point queries used by
// construction picking and SPLAT placement. Two backing stores, two
// functions:
//  - pickSplatPoint: loaded Spark PLY assets (scene.splats) — the ONLY
//    poly-system code that knows about the Spark splat integration.
//  - pickPaintCloudPoint: painted TGPaintCloud points (scene.paintClouds,
//    from the Splat Paint brush) — plain scene data, no Spark dependency.
//
// Method for pickSplatPoint: Spark exposes no hit-testing API, so the
// cloud's centres (kept by the splat editor's state, src/splats/spark.ts)
// are projected with one composed matrix per query and the nearest SHOWN
// centre inside the pixel threshold wins — the front one among near-equals.
// Precision = "nearest centre", not a surface hit. Clouds above SAMPLE_CAP
// are strided so a pointer move stays a couple of milliseconds.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { Vec3 } from '../core/types';
import { worldMatrixOf } from './objects';
import type { SplatManager } from '../splats/index';
import { PAINT_STRIDE } from '../render/paintclouds';

/** Above this many splats a pick samples every k-th one. 250k projected
 *  with a plain matrix loop is ~2 ms — a pick is a click, and a 5k sample
 *  (what this used to keep) left a scan unclickable anywhere its sampled
 *  centres happened to be more than a few pixels apart. */
const SAMPLE_CAP = 250_000;

let source: SplatManager | null = null;
/** Wired once from App init (keeps the manager out of AppCtx). */
export function setSplatPickSource(mgr: SplatManager): void { source = mgr; }

export function pickSplatPoint(
  ctx: AppCtx, x: number, y: number, thresholdPx: number,
): { objectId: number; pointIndex: number; world: Vec3; d: number } | null {
  if (!source) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  const cam = ctx.camera;
  cam.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const m = new THREE.Matrix4();
  const hw = rect.width / 2, hh = rect.height / 2;
  let best: { objectId: number; index: number; d: number; z: number } | null = null;
  for (const s of ctx.scene.splats) {
    if (!s.visible) continue;
    // the edit state carries every centre and what is shown (deleted and
    // filtered splats are not there to pick or snap to)
    const st = source.editState(s.id);
    if (!st) continue;
    const e = m.multiplyMatrices(vp, worldMatrixOf(ctx.scene, { kind: 'SPLAT', id: s.id })).elements;
    const c = st.centers;
    const stride = Math.max(1, Math.ceil(st.n / SAMPLE_CAP));
    for (let i = 0; i < st.n; i += stride) {
      if (!st.alive[i]) continue;
      const px = c[i * 3], py = c[i * 3 + 1], pz = c[i * 3 + 2];
      const w = e[3] * px + e[7] * py + e[11] * pz + e[15];
      if (w <= 1e-6) continue;
      const nz = (e[2] * px + e[6] * py + e[10] * pz + e[14]) / w;
      if (nz > 1 || nz < -1) continue;
      const sx = ((e[0] * px + e[4] * py + e[8] * pz + e[12]) / w + 1) * hw;
      const sy = (1 - (e[1] * px + e[5] * py + e[9] * pz + e[13]) / w) * hh;
      const d = Math.hypot(sx - x, sy - y);
      if (d >= thresholdPx) continue;
      // among near-equals the FRONT one: a pick means what you can see
      if (!best || d < best.d - 2 || (d <= best.d + 2 && nz < best.z)) best = { objectId: s.id, index: i, d, z: nz };
    }
  }
  if (!best) return null;
  const st = source.editState(best.objectId)!;
  const wp = new THREE.Vector3(st.centers[best.index * 3], st.centers[best.index * 3 + 1], st.centers[best.index * 3 + 2])
    .applyMatrix4(worldMatrixOf(ctx.scene, { kind: 'SPLAT', id: best.objectId }));
  return { objectId: best.objectId, pointIndex: best.index, world: [wp.x, wp.y, wp.z], d: best.d };
}

/** Nearest painted splat point (TGPaintCloud, scene.paintClouds) under a
 *  screen position — the direct, no-caching counterpart to pickSplatPoint
 *  for the app's own paint-brush clouds rather than loaded Spark assets. */
export function pickPaintCloudPoint(
  ctx: AppCtx, x: number, y: number, thresholdPx: number,
): { cloudId: number; pointIndex: number; world: Vec3; d: number } | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const wp = new THREE.Vector3();
  let best: { cloudId: number; pointIndex: number; world: Vec3; d: number } | null = null;
  for (const pc of ctx.scene.paintClouds) {
    if (!pc.visible || !pc.points.length) continue;
    const world = worldMatrixOf(ctx.scene, { kind: 'PCLOUD', id: pc.id });
    const n = pc.points.length / PAINT_STRIDE;
    for (let i = 0; i < n; i++) {
      const o = i * PAINT_STRIDE;
      wp.set(pc.points[o], pc.points[o + 1], pc.points[o + 2]).applyMatrix4(world);
      const p = wp.clone().project(ctx.camera);
      if (p.z > 1) continue;
      const sx = (p.x * 0.5 + 0.5) * rect.width, sy = (-p.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < thresholdPx && (!best || d < best.d)) {
        best = { cloudId: pc.id, pointIndex: i, world: [wp.x, wp.y, wp.z], d };
      }
    }
  }
  return best;
}
