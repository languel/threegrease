import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { activeObject, frameAt } from '../core/gpdata';
import type { AppCtx } from './context';

const raycaster = new THREE.Raycaster();

/**
 * Stroke id excluded from STROKE-placement depth sampling — set by drawing
 * tools so the in-progress stroke doesn't attract its own points.
 */
let excludedStrokeId: number | null = null;
let stickyDepth: number | null = null;
export function setStrokeExclusion(id: number | null): void {
  excludedStrokeId = id;
  stickyDepth = null; // each new stroke re-acquires its depth anchor
}

interface DepthCandidate { d: number; depth: number; strokeId: number; world: THREE.Vector3 }

/** Project stroke points near a screen position; shared by STROKE placement and cursor snapping. */
function gatherDepthCandidates(
  ctx: AppCtx, screenX: number, screenY: number, radius: number,
  target: 'ALL' | 'ENDS' | 'FIRST',
): DepthCandidate[] {
  const ob = activeObject(ctx.scene);
  const rect = ctx.canvas.getBoundingClientRect();
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...ob.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
    new THREE.Vector3(...ob.scale),
  );
  const camDir = ctx.camera.getWorldDirection(new THREE.Vector3());
  const camPos = ctx.camera.position;
  const out: DepthCandidate[] = [];
  const projected = new THREE.Vector3();

  for (const layer of ob.layers) {
    if (layer.hide) continue;
    const frame = frameAt(layer, ctx.scene.frame);
    if (!frame) continue;
    for (const s of frame.strokes) {
      if (s.id === excludedStrokeId || s.points.length === 0) continue;
      const picks =
        target === 'FIRST' ? [s.points[0]] :
        target === 'ENDS' ? (s.points.length > 1 ? [s.points[0], s.points[s.points.length - 1]] : [s.points[0]]) :
        s.points;
      for (const p of picks) {
        const world = new THREE.Vector3(p.co[0], p.co[1], p.co[2]).applyMatrix4(matrix);
        projected.copy(world).project(ctx.camera);
        if (projected.z > 1) continue; // behind camera
        const sx = (projected.x * 0.5 + 0.5) * rect.width;
        const sy = (-projected.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - screenX, sy - screenY);
        if (d > radius) continue;
        out.push({ d, depth: camDir.dot(world.clone().sub(camPos)), strokeId: s.id, world });
      }
    }
  }
  return out;
}

/** Nearest existing stroke point (world space) within `radius` px, or null. */
export function nearestStrokePoint(ctx: AppCtx, screenX: number, screenY: number, radius = 40): THREE.Vector3 | null {
  const candidates = gatherDepthCandidates(ctx, screenX, screenY, radius, 'ALL');
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.d < a.d ? b : a)).world;
}

/**
 * STROKE placement: snap depth to the nearest existing stroke. Depth is
 * blended only along the stroke that owns the nearest point (no cross-stroke
 * averaging), and while a stroke is being drawn the last good depth is kept
 * when the cursor leaves the snap radius — no fallback jumps to the origin
 * plane mid-stroke.
 */
function strokeDepthPoint(ctx: AppCtx, ray: THREE.Ray, screenX: number, screenY: number): THREE.Vector3 | null {
  const SNAP = 80; // px
  const camDir = ctx.camera.getWorldDirection(new THREE.Vector3());
  const cos = camDir.dot(ray.direction);
  if (Math.abs(cos) < 1e-6) return null;
  const pointAtDepth = (depth: number) =>
    ray.origin.clone().addScaledVector(ray.direction, depth / cos);

  const candidates = gatherDepthCandidates(ctx, screenX, screenY, SNAP, ctx.settings.strokeTarget);
  if (!candidates.length) {
    // sticky depth only while actively drawing a stroke
    if (excludedStrokeId !== null && stickyDepth !== null) return pointAtDepth(stickyDepth);
    return null;
  }
  const nearest = candidates.reduce((a, b) => (b.d < a.d ? b : a));
  // smooth depth along the owning stroke only
  let wSum = 0, depthSum = 0;
  for (const c of candidates) {
    if (c.strokeId !== nearest.strokeId) continue;
    const w = 1 / (c.d * c.d + 4);
    wSum += w;
    depthSum += w * c.depth;
  }
  const depth = depthSum / wSum;
  if (excludedStrokeId !== null) stickyDepth = depth;
  return pointAtDepth(depth);
}

/** The plane strokes are placed on, per placement + orientation settings. */
export function drawingPlane(ctx: AppCtx): THREE.Plane {
  const s = ctx.settings;
  const anchor = s.placement === 'CURSOR'
    ? new THREE.Vector3(...ctx.scene.cursor)
    : new THREE.Vector3(...activeObject(ctx.scene).translation);
  let normal: THREE.Vector3;
  switch (s.plane) {
    // three.js is Y-up: Front = X·Y plane, Side = Z·Y plane, Top = X·Z plane
    case 'FRONT': normal = new THREE.Vector3(0, 0, 1); break;
    case 'SIDE': normal = new THREE.Vector3(1, 0, 0); break;
    case 'TOP': normal = new THREE.Vector3(0, 1, 0); break;
    default: normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
  }
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
}

/** Screen px -> point on drawing plane (or surface), in world space. */
export function screenToWorld(ctx: AppCtx, x: number, y: number): THREE.Vector3 | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, ctx.camera);
  if (ctx.settings.placement === 'SURFACE' && ctx.surfaces.length) {
    const hits = raycaster.intersectObjects(ctx.surfaces, true);
    if (hits.length) return hits[0].point.clone();
  }
  if (ctx.settings.placement === 'STROKE') {
    const hit = strokeDepthPoint(ctx, raycaster.ray, x - rect.left, y - rect.top);
    if (hit) return hit;
  }
  const plane = drawingPlane(ctx);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, out) ? out : null;
}

/** World -> object-local coordinates of the active GP object. */
export function worldToObject(ctx: AppCtx, world: THREE.Vector3): Vec3 {
  const ob = activeObject(ctx.scene);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...ob.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
    new THREE.Vector3(...ob.scale),
  ).invert();
  const v = world.clone().applyMatrix4(m);
  return [v.x, v.y, v.z];
}

export function objectToWorld(ctx: AppCtx, co: Vec3): THREE.Vector3 {
  const ob = activeObject(ctx.scene);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...ob.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
    new THREE.Vector3(...ob.scale),
  );
  return new THREE.Vector3(...co).applyMatrix4(m);
}

/** Object-local point -> screen px. */
export function objectToScreen(ctx: AppCtx, co: Vec3): THREE.Vector2 {
  const rect = ctx.canvas.getBoundingClientRect();
  const v = objectToWorld(ctx, co).project(ctx.camera);
  return new THREE.Vector2(
    (v.x * 0.5 + 0.5) * rect.width,
    (-v.y * 0.5 + 0.5) * rect.height,
  );
}

/** Convert client event coords to canvas-local px. */
export function eventToCanvas(ctx: AppCtx, e: { clientX: number; clientY: number }): THREE.Vector2 {
  const rect = ctx.canvas.getBoundingClientRect();
  return new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top);
}

/** Apply drawing guide constraint to a screen-space point. */
export function applyGuide(
  ctx: AppCtx, pt: THREE.Vector2, strokeStart: THREE.Vector2 | null, center: THREE.Vector2,
): THREE.Vector2 {
  const g = ctx.settings.guide;
  if (g.type === 'NONE') return pt;
  const p = pt.clone();
  switch (g.type) {
    case 'CIRCULAR': {
      if (!strokeStart) return p;
      const r = strokeStart.distanceTo(center);
      const d = p.clone().sub(center);
      if (d.length() < 1e-6) return p;
      return center.clone().add(d.normalize().multiplyScalar(r));
    }
    case 'RADIAL': {
      if (!strokeStart) return p;
      const dir = strokeStart.clone().sub(center);
      if (dir.length() < 1e-6) return p;
      dir.normalize();
      const d = p.clone().sub(center);
      return center.clone().add(dir.multiplyScalar(d.dot(dir)));
    }
    case 'PARALLEL': {
      if (!strokeStart) return p;
      const dir = new THREE.Vector2(Math.cos(g.angle), Math.sin(g.angle));
      const d = p.clone().sub(strokeStart);
      return strokeStart.clone().add(dir.multiplyScalar(d.dot(dir)));
    }
    case 'GRID': {
      if (!strokeStart) return p;
      const dx = Math.abs(p.x - strokeStart.x);
      const dy = Math.abs(p.y - strokeStart.y);
      return dx > dy
        ? new THREE.Vector2(p.x, strokeStart.y)
        : new THREE.Vector2(strokeStart.x, p.y);
    }
    case 'ISO': {
      if (!strokeStart) return p;
      const angles = [Math.PI / 6, (5 * Math.PI) / 6, Math.PI / 2, -Math.PI / 6, -(5 * Math.PI) / 6, -Math.PI / 2];
      const d = p.clone().sub(strokeStart);
      let best = angles[0], bestDot = -Infinity;
      for (const a of angles) {
        const dir = new THREE.Vector2(Math.cos(a), Math.sin(a));
        const dot = d.dot(dir);
        if (dot > bestDot) { bestDot = dot; best = a; }
      }
      const dir = new THREE.Vector2(Math.cos(best), Math.sin(best));
      return strokeStart.clone().add(dir.multiplyScalar(Math.max(0, bestDot)));
    }
  }
  return p;
}
