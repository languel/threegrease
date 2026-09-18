import type * as THREE from 'three';
import type { GPScene, GPStroke, StrokeStyle, Vec3 } from '../core/types';
import { defaultStyle } from '../core/brushes';
import type { History } from '../core/history';
import type { EditorMode, GPSceneRenderer } from '../render/GPSceneRenderer';
import type { ObjRef } from './objects';

/** SURFACE_PERP = "Surface ⊥": the stroke/quilt STARTS on the surface
 *  under the first point, then grows on the plane that stands
 *  perpendicular to that surface (contains the hit normal) while facing
 *  the camera as much as possible — drawing grass on a patch, fins off
 *  a wall. The plane is sticky for the whole stroke/chain. */
export type PlacementMode =
  | 'ORIGIN' | 'CURSOR' | 'SURFACE' | 'SURFACE_PERP' | 'STROKE'
  | 'STROKE_PERP' | 'SPLAT' | 'NEAREST';
export type StrokeTarget = 'ALL' | 'ENDS' | 'FIRST';
/** which kind of element Placement: Nearest lands on */
export type NearestTarget = 'ELEMENT' | 'VERTEX' | 'EDGE' | 'FACE';
/** UPRIGHT: start on the GROUND, then grow straight up — the first point
 *  lands on the floor (or on whatever the Placement snaps it to), and the
 *  rest of the stroke lives on the VERTICAL plane through it that faces the
 *  camera as much as a vertical plane can. Floor plan first, then walls. */
/** NONE: no plane of its own — the Placement, the magnet and the guide
 *  decide; a point none of them catches falls back to facing the camera. */
export type PlaneMode = 'NONE' | 'VIEW' | 'FRONT' | 'SIDE' | 'TOP' | 'CURSOR' | 'VIEW_ORIGIN' | 'UPRIGHT';
export type GuideType = 'NONE' | 'CIRCULAR' | 'RADIAL' | 'PARALLEL' | 'GRID' | 'ISO';
export type EraserMode = 'POINT' | 'STROKE' | 'SOFT';
export type SculptBrush =
  | 'SMOOTH' | 'THICKNESS' | 'STRENGTH' | 'RANDOMIZE' | 'GRAB' | 'PUSH' | 'TWIST' | 'PINCH' | 'CLONE';
export type PaintBrush = 'DRAW' | 'BLUR' | 'AVERAGE' | 'SMEAR';

export interface Settings {
  mode: EditorMode;
  activeTool: string;
  /** which "walk here / jump there" verb the Direct tool fires. EMPTY means
   *  disarmed: clicks do nothing, so you can look around a scene without
   *  every click sending the visitor somewhere. */
  directAction: string;
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
    /** Texture-paint brush tip: an image datablock (scene.images) stamped
     *  as the dab instead of the built-in soft radial gradient. Its
     *  luminance is the alpha, so a grayscale tip works as-is. */
    tipImageId?: number | null;
  };
  eraser: { mode: EraserMode; radius: number };
  /** Blender-style stencil masking for the paint tools: paint only lands
   *  where a screen-space mask passes. The mask comes from an image, the
   *  live camera, or the rendered silhouette of chosen scene objects —
   *  all three reduce to one screen-space mask (see tools/stencil.ts). */
  stencil: {
    enabled: boolean;
    source: 'IMAGE' | 'OBJECTS' | 'VIDEO';
    /** IMAGE source: which image datablock (scene.images) to mask with */
    imageId: number | null;
    /** OBJECTS source: paint only over (or, inverted, only off) these */
    refs: { kind: string; id: number }[];
    /** screen placement for IMAGE/VIDEO, in viewport fractions */
    offset: [number, number];
    scale: number;
    rotation: number;
    invert: boolean;
    /** luminance/alpha cutoff below which the mask blocks paint */
    threshold: number;
  };
  fill: { simplify: number; scale: number };
  placement: PlacementMode;
  strokeTarget: StrokeTarget;  // which points of existing strokes anchor depth
  nearestTarget: NearestTarget;
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
  /**
   * Which points of a SHAPE (line, polyline, box, arc, curve, circle) go
   * through the Placement.
   *
   * ENDS: only the points you actually place — a line's two ends, a
   * polyline's clicks, a box's corners — and everything between them is
   * built in 3D from those. A shape is a thing you aim at its ENDPOINTS;
   * resolving every sample along it means a line dragged across a
   * wireframe snaps its middle onto whatever strokes happen to lie behind
   * it on screen, and breaks into a zigzag through depth.
   * EVERY: the old behaviour, every sample resolved on its own. Kept on
   * purpose — a line that drapes itself over whatever it crosses is an
   * optical effect worth having, just not the default.
   */
  shapeSnap: 'ENDS' | 'EVERY';
  guide: { type: GuideType; angle: number; spacing: number };
  selectMode: 'POINT' | 'STROKE';
  /** Edit mode on a mesh: which element a click selects (Blender 1/2/3) */
  meshSelectMode: 'VERTEX' | 'EDGE' | 'FACE';
  /** what a box select does to the selection (Blender's five): replace,
   *  add, take away, flip, keep only the overlap. Shift/Ctrl still add /
   *  take away for one drag whatever this says. */
  selectOp: 'SET' | 'EXTEND' | 'SUBTRACT' | 'DIFFERENCE' | 'INTERSECT';
  autoKey: boolean;
  additiveDraw: boolean;     // draw on new keyframes keeps previous strokes
  propEdit: { enabled: boolean; radius: number };
  multiframe: boolean;
  sculpt: { brush: SculptBrush; radius: number; strength: number };
  paint: { brush: PaintBrush; radius: number; strength: number };
  weight: { radius: number; strength: number; target: number };
  emulateNumpad: boolean;   // 1..9 become view keys instead of mode switching
  /** floor grid visible in the viewport (a VIEW pref, like shading) */
  showGrid: boolean;
  /** the actors' first-person monologue and their state badges */
  showActorOverlay: boolean;
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
  /** Viewport shading mode (Blender's four buttons). Affects mesh-family
   *  objects; GP strokes are unlit by design and only change in WIREFRAME. */
  shading: import('../core/types').ViewportShading;
  /** How lengths are WRITTEN (measure tool, extents readout). The scene is
   *  unitless with 1 unit = 1 metre by convention; this never moves
   *  anything, so it is safe to flip mid-session. */
  lengthUnit: import('../core/types').LengthUnit;
  uiAccent: Vec3;
  /** accent opacity 0..1 — --accent (CSS) is emitted as rgba() using this. */
  uiAccentAlpha: number;
  uiHighlight: Vec3;
  /** highlight opacity 0..1 — applied to both --accent2 (CSS, as rgba) and
   *  the three.js selection outline/dot materials, which are already
   *  transparent:true for exactly this. */
  uiHighlightAlpha: number;
  /** selection tint for the ACTIVE (last-picked) object — a distinct color,
   *  not a lerp of uiHighlight: THREE.Color.lerp interpolates in linear
   *  light and visibly over-brightens midtones, so the active object needs
   *  its own authored color rather than a brightened highlight. Shares
   *  uiHighlightAlpha (opacity stays the same; only the hue shifts). */
  uiHighlightActive: Vec3;
  gridColor: Vec3 | null;
  upAxis: 'Z' | 'Y';        // world up convention: Z-up (Blender) or Y-up (three.js)
  showAxes: boolean;
  /** debug aid: a wireframe unit square + normal tick showing the plane
   *  strokes/splats/etc. actually land on right now (the active sticky
   *  standing plane while mid-stroke, else the plain Plane setting's
   *  resolution) — see App.updatePlaneHelper. */
  /** GP strokes/fills occlude light from shadow-casting lamps. Only has an
   *  effect when some light actually casts (off by default), so leaving this
   *  on costs nothing until you ask for shadows. */
  gpCastShadows: boolean;
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
  'emulateNumpad', 'emulate3Button', 'showGrid', 'showActorOverlay', 'gridStep', 'gridSubdivisions', 'gridSubdivStyle', 'showGizmo',
  'trackpadNav', 'invertTrackpadOrbit', 'upAxis', 'showAxes', 'gpCastShadows', 'showPlaneHelper', 'showDepthHelper', 'snap',
  'shading', 'shapeSnap', 'lengthUnit', 'uiAccent', 'uiAccentAlpha', 'uiHighlight', 'uiHighlightAlpha', 'uiHighlightActive', 'gridColor',
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
  /**
   * The actors' rendered bodies.
   *
   * An actor's geometry exists ONLY in the render tree — the document holds
   * joints, bones and a look, and the capsules, beads, carved head and clay
   * surface are all derived from those every frame. So anything that needs
   * the actual triangles (the 3D exporters) has to be handed them rather
   * than rebuilding a second copy that would drift.
   */
  actorRoots(selectedOnly?: boolean): THREE.Object3D[];
  syncCanvases(): void;
  copyBuffer: GPStroke[];
  /** mark for rebuild; pass a layerId for the cheap single-layer path (P10) */
  requestRender(layerId?: number): void;
  pushUndo(): void;
  replaceScene(s: GPScene): void;
  refreshUI(): void;
  /** transient one-line message in the viewport status area */
  setStatus(text: string, ms?: number): void;
  /**
   * Light one object up in the viewport itself (a silhouette drawn around
   * the real geometry), or clear it with null.
   *
   * A 3D outline rather than a 2D marker on the HUD, because the shape is
   * already there: a ring or a box has to RE-DERIVE the silhouette by
   * projection and gets it wrong the moment the object is not a sphere.
   */
  highlightObject(ref: ObjRef | null, color?: string): void;
}

export function defaultSettings(): Settings {
  return {
    mode: 'DRAW',
    activeTool: 'draw',
    directAction: '',
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
    stencil: {
      enabled: false, source: 'IMAGE', imageId: null, refs: [],
      offset: [0, 0], scale: 1, rotation: 0, invert: false, threshold: 0.5,
    },
    fill: { simplify: 1.5, scale: 1 },
    placement: 'ORIGIN',
    strokeTarget: 'ALL',
    nearestTarget: 'ELEMENT',
    surfaceOffset: 0,
    plane: 'VIEW',
    placementLock: false,
    placementSmooth: false,
    shapeSnap: 'ENDS',
    guide: { type: 'NONE', angle: 0, spacing: 40 },
    selectMode: 'POINT',
    meshSelectMode: 'VERTEX',
    selectOp: 'SET',
    autoKey: false,
    additiveDraw: false,
    propEdit: { enabled: false, radius: 120 },
    multiframe: false,
    sculpt: { brush: 'SMOOTH', radius: 50, strength: 0.5 },
    paint: { brush: 'DRAW', radius: 40, strength: 0.6 },
    weight: { radius: 40, strength: 0.5, target: 1 },
    emulateNumpad: true,
    showGrid: true,
    showActorOverlay: true,
    emulate3Button: true,
    gridStep: 1,
    gridSubdivisions: 10,
    gridSubdivStyle: 'dashed',
    trackpadNav: true,
    invertTrackpadOrbit: false,
    showGizmo: false,
    shading: 'RENDERED',
    lengthUnit: 'M',
    uiAccent: [0.522, 0.522, 0.522],           // gray(133)
    uiAccentAlpha: 0.5,
    uiHighlight: [1, 0.502, 0],                // rgb(255,128,0)
    uiHighlightAlpha: 0.5,
    uiHighlightActive: [1, 0.784, 0],          // rgb(255,200,0) — a touch more yellow
    gridColor: null,
    upAxis: 'Z',
    showAxes: false,
    gpCastShadows: true,
    showPlaneHelper: false,
    showDepthHelper: false,
    snap: { enabled: false, mode: 'INCREMENT', strokeScope: 'ANY' },
  };
}
