// Blender-style Quad View: pane data model. The persp pane reuses the app's
// one real Navigation/OrbitControls untouched; the 3 ortho panes here are
// lightweight, permanently axis-locked state (pan+zoom only, never orbit) —
// NOT full Navigation instances, since most of Navigation's fields (fly,
// gizmo, frameQuat orbit math) don't apply to a locked ortho view.
//
// Step 1 (this file, initially): pane rects + camera/state construction for
// the rendering skeleton. Input routing (pan/zoom/draw per pane) lands in
// later steps and will extend this module as needed.
import * as THREE from 'three';
import type { UpAxis, ViewName } from './nav';
import { viewDirs } from './nav';

export type PaneId = 'persp' | 'front' | 'side' | 'top';
export const PANE_IDS: PaneId[] = ['persp', 'front', 'side', 'top'];

export interface PaneRect { x: number; y: number; w: number; h: number }

/** Fixed 50/50 2x2 split of the viewport, in canvas CSS px (top-left origin,
 *  matching DOM/canvas-2D convention — callers driving WebGL viewport/
 *  scissor rects must flip Y to WebGL's bottom-left origin themselves).
 *  Recomputed fresh from the current viewport size on every call — never
 *  cache across frames, since a resize can land mid-gesture. */
export function computePaneRects(w: number, h: number): Record<PaneId, PaneRect> {
  const hw = w / 2, hh = h / 2;
  return {
    persp: { x: 0, y: 0, w: hw, h: hh },
    front: { x: hw, y: 0, w: w - hw, h: hh },
    side: { x: 0, y: hh, w: hw, h: h - hh },
    top: { x: hw, y: hh, w: w - hw, h: h - hh },
  };
}

export interface OrthoPane {
  id: PaneId;
  view: ViewName;
  label: string;
  camera: THREE.OrthographicCamera;
  /** world-space point the camera looks at; pan moves this + the camera together */
  target: THREE.Vector3;
  zoom: number;
}

const ORTHO_DEFS: { id: PaneId; view: ViewName; label: string }[] = [
  { id: 'front', view: 'FRONT', label: 'Front' },
  { id: 'side', view: 'RIGHT', label: 'Side' },
  { id: 'top', view: 'TOP', label: 'Top' },
];

/** Build the 3 locked ortho panes for the given up-axis convention, framed
 *  at `distance` from the origin — called once at construction and again
 *  whenever quad view is toggled on (reframed from the persp camera's
 *  current distance) or the up axis changes. */
export function createOrthoPanes(upAxis: UpAxis, distance: number): OrthoPane[] {
  const dirs = viewDirs(upAxis);
  return ORTHO_DEFS.map(({ id, view, label }) => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
    const target = new THREE.Vector3();
    const [dir, up] = dirs[view];
    camera.position.copy(dir).multiplyScalar(distance);
    camera.up.copy(up);
    camera.lookAt(target);
    return { id, view, label, camera, target, zoom: 1 };
  });
}

/** Re-lock an already-built ortho pane's orientation to a (possibly new)
 *  up-axis convention, keeping its current target/distance/zoom. */
export function relockOrthoPane(pane: OrthoPane, upAxis: UpAxis): void {
  const [dir, up] = viewDirs(upAxis)[pane.view];
  const dist = pane.camera.position.distanceTo(pane.target);
  pane.camera.position.copy(pane.target).addScaledVector(dir, dist);
  pane.camera.up.copy(up);
  pane.camera.lookAt(pane.target);
}

/** Sync an ortho camera's frustum to its current zoom + pane aspect ratio —
 *  extracted from Navigation.syncOrthoFrustum so the single-camera ortho-
 *  toggle path and quad-view panes share the same math. `halfH` is the
 *  half-height at zoom=1 (distance * tan(fov/2), matching Navigation's
 *  perspective-equivalent framing so apparent size matches on toggle). */
export function syncOrthoFrustum(
  camera: THREE.OrthographicCamera, halfH: number, aspect: number, zoom: number,
): void {
  const h = halfH / Math.max(1e-6, zoom);
  camera.top = h;
  camera.bottom = -h;
  camera.left = -h * aspect;
  camera.right = h * aspect;
  camera.updateProjectionMatrix();
}
