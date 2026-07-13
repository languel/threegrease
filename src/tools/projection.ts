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
let drawingSurface: THREE.Object3D | null = null;
export function setStrokeExclusion(id: number | null): void {
  excludedStrokeId = id;
  stickyDepth = null;     // each new stroke re-acquires its depth anchor
  drawingSurface = null;  // ...and its surface
}

function ownedBy(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = object;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

/** Infinite plane through a surface object (canvas planes face local +Z). */
function surfacePlane(surface: THREE.Object3D): THREE.Plane {
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(
    surface.getWorldQuaternion(new THREE.Quaternion()),
  );
  return new THREE.Plane().setFromNormalAndCoplanarPoint(
    normal, surface.getWorldPosition(new THREE.Vector3()),
  );
}

interface DepthCandidate {
  d: number; depth: number; strokeId: number; world: THREE.Vector3;
  sx: number; sy: number; // screen position of the snap anchor
}

/**
 * Project stroke geometry near a screen position; shared by STROKE placement
 * and cursor snapping. With target ALL, snapping is against stroke *segments*
 * (closest point on each projected segment), so sparse simplified strokes
 * snap smoothly; ENDS/FIRST snap against those specific points.
 */
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

  const projectPoint = (co: Vec3) => {
    const world = new THREE.Vector3(co[0], co[1], co[2]).applyMatrix4(matrix);
    projected.copy(world).project(ctx.camera);
    if (projected.z > 1) return null; // behind camera
    return {
      world,
      sx: (projected.x * 0.5 + 0.5) * rect.width,
      sy: (-projected.y * 0.5 + 0.5) * rect.height,
      depth: camDir.dot(world.clone().sub(camPos)),
    };
  };

  for (const layer of ob.layers) {
    if (layer.hide) continue;
    const frame = frameAt(layer, ctx.scene.frame);
    if (!frame) continue;
    for (const s of frame.strokes) {
      if (s.id === excludedStrokeId || s.points.length === 0) continue;

      if (target !== 'ALL' || s.points.length === 1) {
        const picks =
          target === 'FIRST' || s.points.length === 1 ? [s.points[0]] :
          target === 'ENDS' ? [s.points[0], s.points[s.points.length - 1]] :
          s.points;
        for (const p of picks) {
          const pr = projectPoint(p.co);
          if (!pr) continue;
          const d = Math.hypot(pr.sx - screenX, pr.sy - screenY);
          if (d <= radius) out.push({ d, depth: pr.depth, strokeId: s.id, world: pr.world, sx: pr.sx, sy: pr.sy });
        }
        continue;
      }

      // segment snapping: closest point on each projected segment
      const prs = s.points.map((p) => projectPoint(p.co));
      const segCount = s.cyclic ? s.points.length : s.points.length - 1;
      for (let i = 0; i < segCount; i++) {
        const a = prs[i], b = prs[(i + 1) % s.points.length];
        if (!a || !b) continue;
        const abx = b.sx - a.sx, aby = b.sy - a.sy;
        const len2 = abx * abx + aby * aby;
        const t = len2 < 1e-9 ? 0 :
          Math.max(0, Math.min(1, ((screenX - a.sx) * abx + (screenY - a.sy) * aby) / len2));
        const sx = a.sx + abx * t, sy = a.sy + aby * t;
        const d = Math.hypot(sx - screenX, sy - screenY);
        if (d > radius) continue;
        out.push({
          d,
          depth: a.depth + (b.depth - a.depth) * t,
          strokeId: s.id,
          world: a.world.clone().lerp(b.world, t),
          sx, sy,
        });
      }
    }
  }
  return out;
}

/**
 * HUD preview: where STROKE placement would anchor right now. Returns the
 * screen position of the snap anchor on the target stroke, or null.
 */
export function strokeSnapPreview(ctx: AppCtx, screenX: number, screenY: number): { x: number; y: number } | null {
  const candidates = gatherDepthCandidates(ctx, screenX, screenY, 80, ctx.settings.strokeTarget);
  if (!candidates.length) return null;
  const nearest = candidates.reduce((a, b) => (b.d < a.d ? b : a));
  return { x: nearest.sx, y: nearest.sy };
}

/** Canvas plane under a canvas-local screen point, or null. */
export function pickCanvas(ctx: AppCtx, x: number, y: number): { id: number; point: THREE.Vector3 } | null {
  if (!ctx.canvasMeshes.length) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, ctx.camera);
  const hits = raycaster.intersectObjects(ctx.canvasMeshes, true);
  for (const h of hits) {
    let cur: THREE.Object3D | null = h.object;
    while (cur) {
      if (cur.userData.canvasId !== undefined) return { id: cur.userData.canvasId, point: h.point.clone() };
      cur = cur.parent;
    }
  }
  return null;
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
  const anchor = s.placement === 'CURSOR' || s.plane === 'CURSOR'
    ? new THREE.Vector3(...ctx.scene.cursor)
    : new THREE.Vector3(...activeObject(ctx.scene).translation);
  let normal: THREE.Vector3;
  const zUp = s.upAxis === 'Z';
  switch (s.plane) {
    // Z-up (Blender): Front = X·Z, Side = Y·Z, Top = X·Y
    // Y-up (three.js): Front = X·Y, Side = Z·Y, Top = X·Z
    case 'FRONT': normal = zUp ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1); break;
    case 'SIDE': normal = new THREE.Vector3(1, 0, 0); break;
    case 'TOP': normal = zUp ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0); break;
    default: // VIEW and CURSOR: view-aligned (CURSOR differs only by anchor)
      normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
  }
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
}

/** Screen px -> nearest point on any mesh/splat/canvas surface, regardless
 *  of the current draw-placement mode. Used by 3D-cursor SURFACE snap. */
export function raycastSurfaces(ctx: AppCtx, x: number, y: number): THREE.Vector3 | null {
  if (!ctx.surfaces.length) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, ctx.camera);
  const hits = raycaster.intersectObjects(ctx.surfaces, true);
  return hits.length ? hits[0].point.clone() : null;
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
    const lift = (point: THREE.Vector3, normal: THREE.Vector3) => {
      const off = ctx.settings.surfaceOffset;
      if (!off) return point;
      const n = normal.clone();
      if (n.dot(raycaster.ray.direction) > 0) n.negate(); // toward the camera
      return point.addScaledVector(n, off);
    };
    const hitNormal = (h: THREE.Intersection) =>
      (h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
        : raycaster.ray.direction.clone().negate());
    const hits = raycaster.intersectObjects(ctx.surfaces, true);
    if (excludedStrokeId !== null && drawingSurface) {
      // sticky: the stroke stays on the surface it started on; when the
      // pointer leaves its bounds, extend along that surface's plane
      const hit = hits.find((h) => ownedBy(h.object, drawingSurface!));
      if (hit) return lift(hit.point.clone(), hitNormal(hit));
      const plane = surfacePlane(drawingSurface);
      const out = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(plane, out)) return lift(out, plane.normal);
    } else if (hits.length) {
      if (excludedStrokeId !== null) {
        // remember the top-level surface this stroke started on
        drawingSurface = ctx.surfaces.find((s) => ownedBy(hits[0].object, s)) ?? hits[0].object;
      }
      return lift(hits[0].point.clone(), hitNormal(hits[0]));
    }
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
