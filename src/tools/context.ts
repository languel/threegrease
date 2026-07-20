import type * as THREE from 'three';
import type { GPScene, GPStroke, StrokeStyle, Vec3 } from '../core/types';
import { defaultStyle } from '../core/brushes';
import type { History } from '../core/history';
import type { EditorMode, GPSceneRenderer } from '../render/GPSceneRenderer';

/** SURFACE_PERP = "Surface ⊥": the stroke/quilt STARTS on the surface
 *  under the first point, then grows on the plane that stands
 *  perpendicular to that surface (contains the hit normal) while facing
 *  the camera as much as possible — drawing grass on a patch, fins off
 *  a wall. The plane is sticky for the whole stroke/chain. */
export type PlacementMode =
  | 'ORIGIN' | 'CURSOR' | 'SURFACE' | 'SURFACE_PERP' | 'STROKE'
  | 'STROKE_PERP' | 'SPLAT' | 'NEAREST';
export type StrokeTarget = 'ALL' | 'ENDS' | 'FIRST';
export type PlaneMode = 'VIEW' | 'FRONT' | 'SIDE' | 'TOP' | 'CURSOR' | 'VIEW_ORIGIN';
export type GuideType = 'NONE' | 'CIRCULAR' | 'RADIAL' | 'PARALLEL' | 'GRID' | 'ISO';
export type EraserMode = 'POINT' | 'STROKE' | 'SOFT';
export type SculptBrush =
  | 'SMOOTH' | 'THICKNESS' | 'STRENGTH' | 'RANDOMIZE' | 'GRAB' | 'PUSH' | 'TWIST' | 'PINCH' | 'CLONE';
export type PaintBrush = 'DRAW' | 'BLUR' | 'AVERAGE' | 'SMEAR';

export interface Settings {
  mode: EditorMode;
  activeTool: string;
  brush: {
    preset: string;
    size: number;            // px (VIEW) or world*100 (SCENE), see sizeToWidth()
    strength: number;
    hardness: number;
    style: StrokeStyle;      // baked onto each new stroke
    pressureSize: boolean;
    pressureStrength: boolean;
    stabilize: boolean;
    stabilizeRadius: number; // px
    stabilizeFactor: number;
    activeSmooth: number;
    postSmooth: number;      // factor
    postSmoothSteps: number;
    simplify: number;        // epsilon world units
    vertexColor: Vec3;
    vertexColorFactor: number; // 0 = material color, >0 mixes vertex color while drawing
  };
  eraser: { mode: EraserMode; radius: number };
  fill: { simplify: number; scale: number };
  placement: PlacementMode;
  strokeTarget: StrokeTarget;  // which points of existing strokes anchor depth
  surfaceOffset: number;       // world units above the surface hit (along normal)
  plane: PlaneMode;
  /** STROKE/SPLAT/NEAREST placement continuously re-resolve their target as
   *  the pointer moves and can jump discontinuously between two valid
   *  targets (e.g. drifting from one nearby stroke to another) — almost
   *  never what you want mid-stroke. placementLock freezes whatever the
   *  stroke's first point resolved to (depth only — screen-space XY still
   *  tracks the pointer exactly) for the rest of that stroke.
   *  placementSmooth eases toward each newly-resolved depth instead of
   *  snapping to it. Both no-ops for placements that already have their
   *  own permanent lock (SURFACE_PERP/STROKE_PERP) or no target concept
   *  (ORIGIN/CURSOR/SURFACE). Lock wins if both are on. */
  placementLock: boolean;
  placementSmooth: boolean;
  guide: { type: GuideType; angle: number; spacing: number };
  selectMode: 'POINT' | 'STROKE';
  autoKey: boolean;
  additiveDraw: boolean;     // draw on new keyframes keeps previous strokes
  propEdit: { enabled: boolean; radius: number };
  multiframe: boolean;
  sculpt: { brush: SculptBrush; radius: number; strength: number };
  paint: { brush: PaintBrush; radius: number; strength: number };
  weight: { radius: number; strength: number; target: number };
  background: Vec3;
  emulateNumpad: boolean;   // 1..9 become view keys instead of mode switching
  emulate3Button: boolean;  // Alt+LMB orbits (Shift pan, Ctrl zoom) for trackpads
  gridStep: number;
  /** minor grid lines per major gridStep cell. Also the magnet's INCREMENT
   *  unit: snapping targets the finer subdivision lines (gridStep /
   *  gridSubdivisions), not the major step — see snapIncrement() below. */
  gridSubdivisions: number;
  /** minor (subdivision) grid line style — dashed by default so major
   *  steps stay visually dominant */
  gridSubdivStyle: 'dashed' | 'solid';
  trackpadNav: boolean;     // two-finger orbit, shift pan, ctrl/pinch zoom
  invertTrackpadOrbit: boolean; // false = Blender direction (default)
  /** show the transform gizmo widget (hidden by default — G/R/S modal is
   *  the primary transform interface, Blender-style) */
  showGizmo: boolean;
  /** UI theme colors: accent (menu highlights/active states) and
   *  highlight (selection outlines) drive both CSS custom properties and
   *  three.js selection glyph colors. gridColor null = auto-contrast
   *  against `background`. */
  uiAccent: Vec3;
  uiHighlight: Vec3;
  gridColor: Vec3 | null;
  upAxis: 'Z' | 'Y';        // world up convention: Z-up (Blender) or Y-up (three.js)
  showAxes: boolean;
  /** debug aid: a wireframe unit square + normal tick showing the plane
   *  strokes/splats/etc. actually land on right now (the active sticky
   *  standing plane while mid-stroke, else the plain Plane setting's
   *  resolution) — see App.updatePlaneHelper. */
  showPlaneHelper: boolean;
  /** debug aid: a yellow line dropping straight from the CURRENT
   *  placement point (wherever a stroke point would actually land if
   *  you moused down right now — the plane helper's own anchor) down to
   *  its footprint on the ground plane, plus a small ring marking it,
   *  so its depth/height reads clearly against the grid. See
   *  App.updateDepthHelper. */
  showDepthHelper: boolean;
  /** Blender-style magnet: one snap setting for transforms AND the 3D
   *  cursor (Shift+RMB drag). 'CANVAS' is a legacy alias for 'SURFACE'.
   *  strokeScope limits POINT snapping to selected strokes only.
   *  Blender-parity targets: INCREMENT rounds transform DELTAS to step
   *  multiples (relative); GRID snaps to the absolute grid lattice;
   *  EDGE_CENTER = segment midpoints; EDGE_PERP = foot of perpendicular
   *  from the pre-move position onto the nearest segment; SURFACE = Face
   *  Project (along the view ray); FACE_CENTER = hit triangle centroid;
   *  FACE_NEAREST = closest point on the hit face to the pre-move
   *  position. */
  snap: {
    enabled: boolean;
    mode: 'INCREMENT' | 'GRID' | 'POINT' | 'EDGE' | 'EDGE_CENTER' | 'EDGE_PERP'
      | 'CANVAS' | 'OBJECT' | 'SURFACE' | 'FACE_CENTER' | 'FACE_NEAREST';
    strokeScope?: 'ANY' | 'SELECTED';
  };
}

/** The INCREMENT magnet's unit: the finer SUBDIVISION line spacing, not the
 *  major grid step — snapping to the visible minor grid, Blender-style. */
export function snapIncrement(s: Settings): number {
  return s.gridStep / Math.max(1, s.gridSubdivisions || 1);
}

// ---- preference persistence (localStorage) --------------------------------

const PREFS_KEY = 'threegrease.prefs';
const PREF_FIELDS = [
  'emulateNumpad', 'emulate3Button', 'gridStep', 'gridSubdivisions', 'gridSubdivStyle', 'showGizmo',
  'trackpadNav', 'invertTrackpadOrbit', 'upAxis', 'showAxes', 'showPlaneHelper', 'showDepthHelper', 'background', 'snap',
  'uiAccent', 'uiHighlight', 'gridColor',
] as const;

export function loadPrefs(s: Settings): void {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    for (const key of PREF_FIELDS) {
      if (key in saved) (s as unknown as Record<string, unknown>)[key] = saved[key];
    }
  } catch { /* corrupted storage: keep defaults */ }
}

export function savePrefs(s: Settings): void {
  const out: Record<string, unknown> = {};
  for (const key of PREF_FIELDS) out[key] = s[key];
  localStorage.setItem(PREFS_KEY, JSON.stringify(out));
}

export interface AppCtx {
  scene: GPScene;
  history: History;
  settings: Settings;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  gp: GPSceneRenderer;
  gl: THREE.WebGLRenderer;
  scene3: THREE.Scene;
  canvas: HTMLCanvasElement;
  /** meshes eligible for SURFACE placement raycasts */
  surfaces: THREE.Object3D[];
  /** all visible canvas-plane meshes (selection picking, snapping) */
  canvasMeshes: THREE.Object3D[];
  /** mesh-object roots for object-mode picking */
  pickableMeshes: THREE.Object3D[];
  /** editable-mesh render seam: face meshes + triangle->face-id resolution
   *  (set by App; null until the poly manager exists) */
  polyPick: {
    faceMeshes(): THREE.Object3D[];
    faceIdAt(polyId: number, triangleIndex: number): number | null;
  } | null;
  syncCanvases(): void;
  copyBuffer: GPStroke[];
  /** mark for rebuild; pass a layerId for the cheap single-layer path (P10) */
  requestRender(layerId?: number): void;
  pushUndo(): void;
  replaceScene(s: GPScene): void;
  refreshUI(): void;
}

export function defaultSettings(): Settings {
  return {
    mode: 'DRAW',
    activeTool: 'draw',
    brush: {
      preset: 'Pen',
      size: 8, strength: 1, hardness: 1,
      style: defaultStyle(),
      pressureSize: true, pressureStrength: true,
      stabilize: false, stabilizeRadius: 30, stabilizeFactor: 0.6,
      activeSmooth: 0.2, postSmooth: 0.3, postSmoothSteps: 2, simplify: 0.002,
      vertexColor: [1, 0.4, 0.1], vertexColorFactor: 0,
    },
    eraser: { mode: 'POINT', radius: 24 },
    fill: { simplify: 1.5, scale: 1 },
    placement: 'ORIGIN',
    strokeTarget: 'ALL',
    surfaceOffset: 0,
    plane: 'VIEW',
    placementLock: false,
    placementSmooth: false,
    guide: { type: 'NONE', angle: 0, spacing: 40 },
    selectMode: 'POINT',
    autoKey: false,
    additiveDraw: false,
    propEdit: { enabled: false, radius: 120 },
    multiframe: false,
    sculpt: { brush: 'SMOOTH', radius: 50, strength: 0.5 },
    paint: { brush: 'DRAW', radius: 40, strength: 0.6 },
    weight: { radius: 40, strength: 0.5, target: 1 },
    background: [0.11, 0.11, 0.12],
    emulateNumpad: true,
    emulate3Button: true,
    gridStep: 1,
    gridSubdivisions: 10,
    gridSubdivStyle: 'dashed',
    trackpadNav: true,
    invertTrackpadOrbit: false,
    showGizmo: false,
    uiAccent: [0.31, 0.55, 1],
    uiHighlight: [1, 0.48, 0],
    gridColor: null,
    upAxis: 'Z',
    showAxes: false,
    showPlaneHelper: false,
    showDepthHelper: false,
    snap: { enabled: false, mode: 'INCREMENT', strokeScope: 'ANY' },
  };
}
