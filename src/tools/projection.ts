import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { activeObject, frameAt } from '../core/gpdata';
import type { AppCtx } from './context';
import { pickPaintCloudPoint, pickSplatPoint } from './splatpick';
import { pickConstruction } from './polypick';

const raycaster = new THREE.Raycaster();

/** SPLAT/NEAREST "clay" release radius, in screen px: how far the cursor
 *  can drift from the last real snap hit before the stroke detaches from
 *  the sticky accretion depth and resumes following the normal drawing
 *  plane (see stickyAnchorPx below). */
const STICKY_RELEASE_PX = 120;

/**
 * Stroke id excluded from STROKE-placement depth sampling — set by drawing
 * tools so the in-progress stroke doesn't attract its own points.
 */
let excludedStrokeId: number | null = null;
let stickyDepth: number | null = null;
let drawingSurface: THREE.Object3D | null = null;
let perpPlane: THREE.Plane | null = null;
/** Screen px where SPLAT/NEAREST last actually snapped to something — the
 *  "clay" anchor: pulling the cursor away from it beyond STICKY_RELEASE_PX
 *  detaches the stroke back to the normal drawing plane instead of keeping
 *  it glued to the accretion depth forever. */
let stickyAnchorPx: { x: number; y: number } | null = null;
/**
 * The normal of a VERTICAL plane that faces the camera as squarely as a
 * vertical plane can: the view direction with its up component removed.
 *
 * VIEW_ORIGIN's plane faces the camera outright, so from any raised
 * viewpoint it leans back and a line drawn "up" from the floor goes up AND
 * away — a wall that tilts. Dropping the up component is what keeps it
 * plumb. Looking straight down there is no horizontal part left to keep, so
 * the camera's own up vector (which then points across the floor) stands
 * in; the plane is edge-on from there and nobody draws a wall from above.
 */
function uprightNormal(ctx: AppCtx): THREE.Vector3 {
  const up = ctx.settings.upAxis === 'Z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const flat = (v: THREE.Vector3) => v.addScaledVector(up, -v.dot(up));
  let n = flat(ctx.camera.getWorldDirection(new THREE.Vector3()).negate());
  if (n.lengthSq() < 1e-6) n = flat(new THREE.Vector3(0, 1, 0).applyQuaternion(ctx.camera.quaternion));
  if (n.lengthSq() < 1e-6) n = new THREE.Vector3(1, 0, 0);
  return n.normalize();
}

/** Plane.VIEW_ORIGIN's sticky standing plane: view-aligned, through
 *  wherever THIS stroke's first point actually landed (whatever the
 *  active Placement resolved it to), instead of a fixed cursor/object
 *  anchor — captured once per stroke, reused for every later point. */
let viewOriginPlane: THREE.Plane | null = null;
/** placementLock's frozen depth for STROKE/SPLAT/NEAREST — captured from
 *  whatever the stroke's first point resolved to (target or plane
 *  fallback alike) and reused unchanged for the rest of the stroke. */
let lockedDepth: number | null = null;
/** placementSmooth's eased depth for STROKE/SPLAT/NEAREST — chases each
 *  newly-resolved depth instead of snapping straight to it. */
let smoothedDepth: number | null = null;
export function setStrokeExclusion(id: number | null): void {
  excludedStrokeId = id;
  stickyDepth = null;     // each new stroke re-acquires its depth anchor
  stickyAnchorPx = null;  // ...and its clay-accretion anchor
  drawingSurface = null;  // ...and its surface
  perpPlane = null;       // ...and its Surface-⊥ / Stroke-⊥ standing plane
  viewOriginPlane = null; // ...and its View-at-Origin standing plane
  lockedDepth = null;     // ...and its placementLock freeze
  smoothedDepth = null;   // ...and its placementSmooth chase
}

/** How fast placementSmooth's eased depth chases a newly-resolved target,
 *  per point (0 = never moves, 1 = instant snap = same as off). */
const DEPTH_SMOOTH_FACTOR = 0.25;

/** placementLock/placementSmooth: STROKE/SPLAT/NEAREST placement re-query
 *  their target continuously and can otherwise jump discontinuously
 *  between two valid targets as the pointer drifts (e.g. from one nearby
 *  stroke to another) — almost never what you want mid-stroke. Both
 *  operate purely on DEPTH (distance along the view ray), so screen-space
 *  XY still tracks the pointer exactly; only "which target is supplying
 *  depth" is frozen/softened. Applied as a post-process over whatever
 *  resolvePlacement() already returned (target hit, clay-release point,
 *  or its own plane fallback alike), so none of that logic needs to know
 *  about locking/smoothing at all. */
function applyDepthPolicy(ctx: AppCtx, ray: THREE.Ray, raw: THREE.Vector3): THREE.Vector3 {
  const rawDepth = depthAlongView(ctx, ray, raw);
  if (ctx.settings.placementLock) {
    if (lockedDepth === null) lockedDepth = rawDepth;
    return pointAtViewDepth(ctx, ray, lockedDepth) ?? raw;
  }
  smoothedDepth = smoothedDepth === null ? rawDepth : smoothedDepth + (rawDepth - smoothedDepth) * DEPTH_SMOOTH_FACTOR;
  return pointAtViewDepth(ctx, ray, smoothedDepth) ?? raw;
}

/** The sticky standing plane actually in effect for the in-progress
 *  stroke, if any (Surface ⊥ / Stroke ⊥ / View at Origin) — used by the
 *  Plane Helper to show what strokes are REALLY landing on mid-draw,
 *  not just the idle Plane setting's default resolution. Null when
 *  nothing is sticky yet (no stroke in progress, or its first point
 *  hasn't resolved one), in which case drawingPlane(ctx) is the right
 *  thing to visualize instead. */
export function currentStickyPlane(): THREE.Plane | null {
  return perpPlane ?? viewOriginPlane;
}

/** SURFACE_PERP: the plane the stroke grows on — through the surface hit
 *  point, CONTAINING the surface normal ("grows perpendicular to the
 *  reference"), oriented to face the camera as much as possible. Its
 *  normal is the view direction with the surface-normal component
 *  removed; when looking straight down the normal that degenerates, so
 *  fall back to a camera-facing plane through the hit. */
export function perpendicularPlaneAt(
  ctx: AppCtx, point: THREE.Vector3, surfaceNormal: THREE.Vector3,
): THREE.Plane {
  const view = ctx.camera.getWorldDirection(new THREE.Vector3());
  const n = surfaceNormal.clone().normalize();
  const planeNormal = view.clone().sub(n.clone().multiplyScalar(view.dot(n)));
  if (planeNormal.lengthSq() < 1e-6) planeNormal.copy(view);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.normalize().negate(), point);
}

/** Signed distance of `point` from the ray origin along the camera's view
 *  direction — the depth of a plane parallel to the view plane through
 *  that point. Paired with pointAtViewDepth() below to build a sticky
 *  "hold the depth of the stroke's first snapped point" fallback for
 *  placement modes whose snap source (a single point/vertex, not a
 *  continuous surface) can go out of range mid-stroke. */
function depthAlongView(ctx: AppCtx, ray: THREE.Ray, point: THREE.Vector3): number {
  const camDir = ctx.camera.getWorldDirection(new THREE.Vector3());
  return camDir.dot(point.clone().sub(ray.origin));
}

/** Inverse of depthAlongView: where the ray crosses the view-parallel plane
 *  at that depth. Null when the ray is ~parallel to the view plane. */
function pointAtViewDepth(ctx: AppCtx, ray: THREE.Ray, depth: number): THREE.Vector3 | null {
  const camDir = ctx.camera.getWorldDirection(new THREE.Vector3());
  const cos = camDir.dot(ray.direction);
  if (Math.abs(cos) < 1e-6) return null;
  return ray.origin.clone().addScaledVector(ray.direction, depth / cos);
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

/**
 * HUD preview for NEAREST placement: whichever snap source (poly element,
 * mesh, GP stroke, splat) pickConstruction would resolve right now, or null
 * when nothing is close enough (i.e. it would only land on the bare plane).
 */
export function nearestConstructionPreview(ctx: AppCtx, screenX: number, screenY: number): { x: number; y: number } | null {
  const hit = pickConstruction(ctx, screenX, screenY, {});
  if (hit.source.kind === 'PLANE' || hit.source.kind === 'FREE') return null;
  const p = new THREE.Vector3(...hit.world).project(ctx.camera);
  if (p.z > 1) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height };
}

/** HUD preview for whichever Placement mode is active — one entry point
 *  so the HUD draw code doesn't need to special-case each mode. Returns
 *  the screen anchor a click would snap to, or null when there's nothing
 *  to preview (ORIGIN/CURSOR/⊥ modes that don't have a discrete "target"
 *  to point at, or a miss for the modes that do). */
export function placementPreview(ctx: AppCtx, screenX: number, screenY: number): { x: number; y: number } | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const toScreen = (world: THREE.Vector3): { x: number; y: number } | null => {
    const p = world.clone().project(ctx.camera);
    if (p.z > 1) return null;
    return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height };
  };
  switch (ctx.settings.placement) {
    case 'STROKE':
      return strokeSnapPreview(ctx, screenX, screenY);
    case 'NEAREST':
      return nearestConstructionPreview(ctx, screenX, screenY);
    case 'SURFACE':
    case 'SURFACE_PERP': {
      const hit = raycastSurfaces(ctx, screenX + rect.left, screenY + rect.top);
      return hit ? toScreen(hit) : null;
    }
    case 'STROKE_PERP': {
      const seg = nearestStrokeSegmentAll(ctx, screenX, screenY, 80);
      return seg ? toScreen(seg.a.clone().lerp(seg.b, seg.t)) : null;
    }
    case 'SPLAT': {
      const pcp = pickPaintCloudPoint(ctx, screenX, screenY, 40);
      const sp = pickSplatPoint(ctx, screenX, screenY, 40);
      const world = pcp && (!sp || pcp.d <= sp.d) ? pcp.world : sp ? sp.world : null;
      return world ? toScreen(new THREE.Vector3(...world)) : null;
    }
    default:
      return null; // ORIGIN/CURSOR: no discrete snap target to point at
  }
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

/**
 * Nearest stroke point across EVERY GP object (gatherDepthCandidates only
 * looks at the ACTIVE object — right for draw-time depth, wrong for
 * magnet snapping, where it made snap-to-stroke ignore all other GPs).
 * scope 'SELECTED' restricts to selected strokes (stroke or any point
 * selected — set in EDIT mode), so you can mark the path you want first.
 */
export function nearestStrokePointAll(
  ctx: AppCtx, screenX: number, screenY: number, radius = 40,
  scope: 'ANY' | 'SELECTED' = 'ANY',
  /** which points of a stroke count: all of them, its two ends, or its first */
  which: 'ALL' | 'ENDS' | 'FIRST' = 'ALL',
): THREE.Vector3 | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const projected = new THREE.Vector3();
  let best: { d: number; world: THREE.Vector3 } | null = null;
  for (const ob of ctx.scene.objects) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        if (s.id === excludedStrokeId) continue; // never snap a stroke onto itself
        if (scope === 'SELECTED' && !s.select && !s.points.some((p) => p.select)) continue;
        const pts = which === 'FIRST' ? s.points.slice(0, 1)
          : which === 'ENDS' ? [s.points[0], s.points[s.points.length - 1]] : s.points;
        for (const p of pts) {
          if (!p) continue;
          const world = new THREE.Vector3(...p.co).applyMatrix4(matrix);
          projected.copy(world).project(ctx.camera);
          if (projected.z > 1) continue;
          const dx = (projected.x * 0.5 + 0.5) * rect.width - screenX;
          const dy = (-projected.y * 0.5 + 0.5) * rect.height - screenY;
          const d = Math.hypot(dx, dy);
          if (d < radius && (!best || d < best.d)) best = { d, world };
        }
      }
    }
  }
  return best?.world ?? null;
}

/**
 * Nearest point ANYWHERE along a stroke's line (Blender "Edge" snap target,
 * as opposed to "Vertex"), across every GP object — the closest point on
 * each screen-projected segment, unprojected by lerping the segment's two
 * endpoint world positions. This is what lets a traveler or a dragged
 * object slide continuously along a path instead of jumping vertex to
 * vertex.
 */
export function nearestStrokeEdgeAll(
  ctx: AppCtx, screenX: number, screenY: number, radius = 40,
  scope: 'ANY' | 'SELECTED' = 'ANY',
): THREE.Vector3 | null {
  const seg = nearestStrokeSegmentAll(ctx, screenX, screenY, radius, scope);
  return seg ? seg.a.clone().lerp(seg.b, seg.t) : null;
}

/** Like nearestStrokeEdgeAll, but returns the winning SEGMENT (world-space
 *  endpoints + the parametric t of the nearest point) so callers can derive
 *  midpoints (Edge Center snap) or perpendicular feet (Edge Perpendicular
 *  snap) instead of just the nearest point. */
export function nearestStrokeSegmentAll(
  ctx: AppCtx, screenX: number, screenY: number, radius = 40,
  scope: 'ANY' | 'SELECTED' = 'ANY',
): { a: THREE.Vector3; b: THREE.Vector3; t: number } | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const projected = new THREE.Vector3();
  let best: { d: number; a: THREE.Vector3; b: THREE.Vector3; t: number } | null = null;
  for (const ob of ctx.scene.objects) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        if (s.id === excludedStrokeId) continue; // the in-progress stroke isn't a valid anchor
        if (scope === 'SELECTED' && !s.select && !s.points.some((p) => p.select)) continue;
        if (s.points.length < 2) continue;
        const proj = s.points.map((p) => {
          const world = new THREE.Vector3(...p.co).applyMatrix4(matrix);
          projected.copy(world).project(ctx.camera);
          if (projected.z > 1) return null;
          return { world, sx: (projected.x * 0.5 + 0.5) * rect.width, sy: (-projected.y * 0.5 + 0.5) * rect.height };
        });
        const segCount = s.cyclic ? s.points.length : s.points.length - 1;
        for (let i = 0; i < segCount; i++) {
          const a = proj[i], b = proj[(i + 1) % s.points.length];
          if (!a || !b) continue;
          const abx = b.sx - a.sx, aby = b.sy - a.sy;
          const len2 = abx * abx + aby * aby;
          const t = len2 < 1e-9 ? 0 :
            THREE.MathUtils.clamp(((screenX - a.sx) * abx + (screenY - a.sy) * aby) / len2, 0, 1);
          const sx = a.sx + abx * t, sy = a.sy + aby * t;
          const d = Math.hypot(sx - screenX, sy - screenY);
          if (d < radius && (!best || d < best.d)) {
            best = { d, a: a.world, b: b.world, t };
          }
        }
      }
    }
  }
  return best ? { a: best.a, b: best.b, t: best.t } : null;
}

/**
 * Where a PLACED point should land when it is released near a stroke: on
 * the stroke, at the nearest point (or the nearest end / first point, per
 * `which`).
 *
 * The one judgement here is the tie-break. Screen distance alone picks
 * whatever line happens to pass closest to the pointer, and in a wireframe
 * the strokes BEHIND the one you are aiming at peek out right beside it —
 * measured: an end released 15 px short of a near wall edge landed on a
 * stroke 5 m behind it. So every stroke within `radius` offers its best
 * point, and among those within `TIE_PX` of the closest, the one nearest the
 * CAMERA wins. Aim precisely at a far stroke and it is still yours; aim
 * roughly and you get the thing in front, which is the thing you can see.
 */
export function strokeAnchorPoint(
  ctx: AppCtx, screenX: number, screenY: number, radius: number,
  which: 'ALL' | 'ENDS' | 'FIRST' = 'ALL',
): THREE.Vector3 | null {
  const TIE_PX = 10;
  const rect = ctx.canvas.getBoundingClientRect();
  const camPos = ctx.camera.getWorldPosition(new THREE.Vector3());
  const view = ctx.camera.getWorldDirection(new THREE.Vector3());
  const tmp = new THREE.Vector3();
  const toScreen = (w: THREE.Vector3) => {
    tmp.copy(w).project(ctx.camera);
    return tmp.z > 1 ? null
      : { sx: (tmp.x * 0.5 + 0.5) * rect.width, sy: (-tmp.y * 0.5 + 0.5) * rect.height };
  };
  const cands: { d: number; depth: number; world: THREE.Vector3 }[] = [];
  for (const ob of ctx.scene.objects) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const frame = frameAt(layer, ctx.scene.frame);
      if (!frame) continue;
      for (const s of frame.strokes) {
        if (s.id === excludedStrokeId || !s.points.length) continue;
        const world = s.points.map((p) => new THREE.Vector3(...p.co).applyMatrix4(matrix));
        const scr = world.map(toScreen);
        let best: { d: number; world: THREE.Vector3 } | null = null;
        if (which === 'ALL' && world.length > 1) {
          const n = s.cyclic ? world.length : world.length - 1;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % world.length;
            const a = scr[i], b = scr[j];
            if (!a || !b) continue;
            const abx = b.sx - a.sx, aby = b.sy - a.sy;
            const len2 = abx * abx + aby * aby;
            const t = len2 < 1e-9 ? 0
              : THREE.MathUtils.clamp(((screenX - a.sx) * abx + (screenY - a.sy) * aby) / len2, 0, 1);
            const d = Math.hypot(a.sx + abx * t - screenX, a.sy + aby * t - screenY);
            if (!best || d < best.d) best = { d, world: world[i].clone().lerp(world[j], t) };
          }
        } else {
          const idx = which === 'FIRST' ? [0] : which === 'ENDS' ? [0, world.length - 1]
            : world.map((_, i) => i);
          for (const i of idx) {
            const q = scr[i];
            if (!q) continue;
            const d = Math.hypot(q.sx - screenX, q.sy - screenY);
            if (!best || d < best.d) best = { d, world: world[i] };
          }
        }
        if (best && best.d < radius) {
          cands.push({ ...best, depth: best.world.clone().sub(camPos).dot(view) });
        }
      }
    }
  }
  if (!cands.length) return null;
  const closest = Math.min(...cands.map((c) => c.d));
  const near = cands.filter((c) => c.d <= closest + TIE_PX);
  near.sort((x, y) => x.depth - y.depth);
  return near[0].world.clone();
}

/** Foot of the perpendicular from `from` onto the segment [a,b] (clamped) —
 *  the Edge Perpendicular snap target: the landing point depends on where
 *  the element STARTED, not where the pointer is. */
export function perpendicularFoot(a: THREE.Vector3, b: THREE.Vector3, from: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  const t = len2 < 1e-12 ? 0 : THREE.MathUtils.clamp(from.clone().sub(a).dot(ab) / len2, 0, 1);
  return a.clone().addScaledVector(ab, t);
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
    // no active GP object (e.g. Object mode with an empty scene) — the
    // world origin is as good a default anchor as any active object's own
    : ctx.scene.objects.length
      ? new THREE.Vector3(...activeObject(ctx.scene).translation)
      : new THREE.Vector3();
  let normal: THREE.Vector3;
  const zUp = s.upAxis === 'Z';
  switch (s.plane) {
    // Z-up (Blender): Front = X·Z, Side = Y·Z, Top = X·Y
    // Y-up (three.js): Front = X·Y, Side = Z·Y, Top = X·Z
    case 'FRONT': normal = zUp ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1); break;
    case 'SIDE': normal = new THREE.Vector3(1, 0, 0); break;
    case 'TOP': normal = zUp ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0); break;
    // UPRIGHT's resting plane is the FLOOR itself — the grid you can see, at
    // height zero, not a plane through the active object — because that is
    // where a stroke's first point has to land. The upright part only exists
    // once a stroke has started (see screenToWorld).
    case 'UPRIGHT':
      return new THREE.Plane(zUp ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0), 0);
    default: // VIEW and CURSOR: view-aligned (CURSOR differs only by anchor)
      normal = ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
  }
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
}

/** Screen px -> nearest point on any mesh/splat/canvas surface, regardless
 *  of the current draw-placement mode. Used by 3D-cursor SURFACE snap. */
export function raycastSurfaces(ctx: AppCtx, x: number, y: number): THREE.Vector3 | null {
  return raycastSurfaceHit(ctx, x, y)?.point ?? null;
}

/** The same cast, keeping WHICH object was hit — a measurement point that
 *  wants to stay on the wall has to know which wall it landed on, and the
 *  point alone cannot say. */
export function raycastSurfaceHit(
  ctx: AppCtx, x: number, y: number,
): { point: THREE.Vector3; object: THREE.Object3D } | null {
  if (!ctx.surfaces.length) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, ctx.camera);
  const hits = raycaster.intersectObjects(ctx.surfaces, true);
  return hits.length ? { point: hits[0].point.clone(), object: hits[0].object } : null;
}

/** Screen px -> the mesh TRIANGLE under the pointer (world-space), for the
 *  Face Center / Face Nearest snap targets. Falls back to null when the hit
 *  has no face (splats, points). */
export function raycastFaceTriangle(ctx: AppCtx, x: number, y: number): { point: THREE.Vector3; tri: THREE.Triangle; object: THREE.Object3D } | null {
  if (!ctx.surfaces.length) return null;
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, ctx.camera);
  for (const h of raycaster.intersectObjects(ctx.surfaces, true)) {
    const mesh = h.object as THREE.Mesh;
    if (!h.face || !(mesh as { isMesh?: boolean }).isMesh) continue;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) continue;
    const va = new THREE.Vector3().fromBufferAttribute(pos, h.face.a).applyMatrix4(mesh.matrixWorld);
    const vb = new THREE.Vector3().fromBufferAttribute(pos, h.face.b).applyMatrix4(mesh.matrixWorld);
    const vc = new THREE.Vector3().fromBufferAttribute(pos, h.face.c).applyMatrix4(mesh.matrixWorld);
    return { point: h.point.clone(), tri: new THREE.Triangle(va, vb, vc), object: mesh };
  }
  return null;
}

/** Screen px -> point on drawing plane (or surface), in world space.
 *  Plane: View at Origin is a TOP-LEVEL override, not just another
 *  fallback stage: several Placement modes (STROKE/SPLAT/NEAREST/etc.)
 *  have their own persistent sticky fallback that never lets execution
 *  reach the bottom of resolvePlacement(), so hooking in down there
 *  would have no effect for exactly the combinations most likely to use
 *  it (e.g. "start on a stroke, then continue on a flat view plane").
 *  Instead: the FIRST point of a stroke resolves through the normal
 *  Placement chain (resolvePlacement) same as always — whatever it
 *  lands on (a snapped stroke/splat point, a surface hit, or just the
 *  drawing plane) becomes the anchor of a view-facing plane, captured
 *  once and reused directly for every later point, bypassing Placement
 *  entirely so the stroke stops tracking a moving target and just lies
 *  flat from where it started. */
export function screenToWorld(ctx: AppCtx, x: number, y: number): THREE.Vector3 | null {
  const rect = ctx.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, ctx.camera);

  if (ctx.settings.plane === 'VIEW_ORIGIN' || ctx.settings.plane === 'UPRIGHT') {
    if (viewOriginPlane) {
      const out = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(viewOriginPlane, out)) return out;
      // degenerate ray (parallel to the standing plane): fall through
    } else {
      const first = resolvePlacement(ctx, x, y, rect);
      if (first && excludedStrokeId !== null) {
        const normal = ctx.settings.plane === 'UPRIGHT'
          ? uprightNormal(ctx)
          : ctx.camera.getWorldDirection(new THREE.Vector3()).negate();
        viewOriginPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, first);
      }
      return first;
    }
  }
  // STROKE/SPLAT/NEAREST re-query their target continuously and can jump
  // discontinuously between two valid targets as the pointer drifts — see
  // applyDepthPolicy's doc comment. Applied as a post-process over
  // whatever resolvePlacement() returns, so its own target/clay/fallback
  // logic doesn't need to know about locking/smoothing at all. No-op for
  // placements with no target concept (ORIGIN/CURSOR/SURFACE) or that
  // already lock permanently by design (SURFACE_PERP/STROKE_PERP).
  const p = ctx.settings.placement;
  if ((p === 'STROKE' || p === 'SPLAT' || p === 'NEAREST')
    && (ctx.settings.placementLock || ctx.settings.placementSmooth) && excludedStrokeId !== null) {
    const raw = resolvePlacement(ctx, x, y, rect);
    return raw ? applyDepthPolicy(ctx, raycaster.ray, raw) : null;
  }
  return resolvePlacement(ctx, x, y, rect);
}

function resolvePlacement(ctx: AppCtx, x: number, y: number, rect: DOMRect): THREE.Vector3 | null {
  // raycaster is already configured by screenToWorld for this query
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
  if (ctx.settings.placement === 'SURFACE_PERP') {
    // stroke in progress: every later point lives on the sticky standing
    // plane captured at the first point (stable depth, no drift)
    if (perpPlane) {
      const out = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(perpPlane, out)) return out;
    }
    if (ctx.surfaces.length) {
      const hits = raycaster.intersectObjects(ctx.surfaces, true);
      if (hits.length) {
        const h = hits[0];
        const n = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
          : raycaster.ray.direction.clone().negate();
        const plane = perpendicularPlaneAt(ctx, h.point, n);
        if (excludedStrokeId !== null) perpPlane = plane; // stick for this stroke
        return h.point.clone();
      }
    }
    // nothing under the first point: fall through to the drawing plane
  }
  if (ctx.settings.placement === 'STROKE') {
    const hit = strokeDepthPoint(ctx, raycaster.ray, x - rect.left, y - rect.top);
    if (hit) return hit;
  }
  if (ctx.settings.placement === 'STROKE_PERP') {
    // stroke in progress: every later point lives on the sticky standing
    // plane captured at the first point (mirrors SURFACE_PERP, but the
    // reference is a GP stroke's local tangent instead of a face normal)
    if (perpPlane) {
      const out = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(perpPlane, out)) return out;
    }
    const seg = nearestStrokeSegmentAll(ctx, x - rect.left, y - rect.top, 80);
    if (seg) {
      const point = seg.a.clone().lerp(seg.b, seg.t);
      const tangent = seg.b.clone().sub(seg.a);
      if (tangent.lengthSq() > 1e-9) {
        const view = ctx.camera.getWorldDirection(new THREE.Vector3());
        let side = new THREE.Vector3().crossVectors(tangent, view);
        if (side.lengthSq() < 1e-9) side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0));
        if (side.lengthSq() < 1e-9) side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(1, 0, 0));
        const plane = perpendicularPlaneAt(ctx, point, side.normalize());
        if (excludedStrokeId !== null) perpPlane = plane; // stick for this stroke
      }
      return point.clone();
    }
    // nothing under the first point: fall through to the drawing plane
  }
  if (ctx.settings.placement === 'SPLAT') {
    // painted clouds (the app's own splat brush) AND loaded Spark assets
    // are both valid "splat" sources; take whichever is nearer on screen
    const px = x - rect.left, py = y - rect.top;
    const pcp = pickPaintCloudPoint(ctx, px, py, 40);
    const sp = pickSplatPoint(ctx, px, py, 40);
    const hit = pcp && (!sp || pcp.d <= sp.d) ? new THREE.Vector3(...pcp.world)
      : sp ? new THREE.Vector3(...sp.world) : null;
    if (hit) {
      if (excludedStrokeId !== null) {
        stickyDepth = depthAlongView(ctx, raycaster.ray, hit);
        stickyAnchorPx = { x: px, y: py };
      }
      return hit;
    }
    // "clay" behavior: near the accretion point (within STICKY_RELEASE_PX
    // of where it last actually hit), keep gluing to its depth so small
    // gaps between splat points don't cause flicker; pull further away and
    // it detaches, falling through to the normal drawing plane below
    if (excludedStrokeId !== null && stickyDepth !== null && stickyAnchorPx
      && Math.hypot(px - stickyAnchorPx.x, py - stickyAnchorPx.y) < STICKY_RELEASE_PX) {
      const p = pointAtViewDepth(ctx, raycaster.ray, stickyDepth);
      if (p) return p;
    }
    // detached (or no hit yet this stroke): fall through to the drawing plane
  }
  if (ctx.settings.placement === 'NEAREST') {
    const px = x - rect.left, py = y - rect.top;
    const hit = pickConstruction(ctx, px, py, {});
    const real = hit.source.kind !== 'PLANE' && hit.source.kind !== 'FREE';
    if (real) {
      const w = new THREE.Vector3(...hit.world);
      if (excludedStrokeId !== null) {
        stickyDepth = depthAlongView(ctx, raycaster.ray, w);
        stickyAnchorPx = { x: px, y: py };
      }
      return w;
    }
    // same "clay" release as SPLAT: only stay glued near the last real hit
    if (excludedStrokeId !== null && stickyDepth !== null && stickyAnchorPx
      && Math.hypot(px - stickyAnchorPx.x, py - stickyAnchorPx.y) < STICKY_RELEASE_PX) {
      const p = pointAtViewDepth(ctx, raycaster.ray, stickyDepth);
      if (p) return p;
    }
    // detached: pickConstruction's own plane fallback is as good as ours
    return new THREE.Vector3(...hit.world);
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
