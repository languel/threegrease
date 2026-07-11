// Plain-JSON data model. Mirrors Blender Grease Pencil:
// GPObject -> GPLayer[] -> GPFrame[] (keyframes) -> GPStroke[] -> GPPoint[]

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number]; // rgba 0..1

export interface GPPoint {
  co: Vec3;            // position in object space
  pressure: number;    // radius factor (multiplies stroke lineWidth)
  strength: number;    // opacity 0..1
  vertexColor: Vec4;   // alpha 0 = "use material color"
  select: boolean;
  weight: number;      // single vertex-group weight (softness)
}

export type LineMode = 'LINE' | 'DOTS' | 'SQUARES';

/** Baked per-stroke brush appearance (NPR engine). Never read live brush settings at render time. */
export interface StrokeStyle {
  unit: 'VIEW' | 'SCENE';   // px width vs world-space width
  stamp: boolean;           // false = solid ribbon
  spacing: number;          // stamp interval as fraction of width
  angle: number;            // stamp rotation offset (rad), added to path direction
  aspect: number;           // stamp squash (0.1..1)
  jitter: number;           // 0..1 positional/rotational randomness
  grain: number;            // 0..1 procedural noise masking
  grainScale: number;       // noise frequency
}
export type FillStyle = 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL';

export interface GPStroke {
  id: number;
  points: GPPoint[];
  cyclic: boolean;
  materialIndex: number;
  lineWidth: number;       // thickness: px when style.unit=VIEW, world units when SCENE
  hardness: number;        // 0..1 edge softness
  fillVertexColor: Vec4;   // alpha 0 = use material fill
  select: boolean;
  style: StrokeStyle;
}

export type KeyframeType = 'KEYFRAME' | 'BREAKDOWN' | 'EXTREME' | 'JITTER' | 'MOVING_HOLD';

export interface GPFrame {
  frameNumber: number;
  keyframeType: KeyframeType;
  strokes: GPStroke[];
  select: boolean;
}

export type BlendMode = 'REGULAR' | 'ADD' | 'MULTIPLY';

export interface GPLayer {
  id: number;
  name: string;
  frames: GPFrame[];       // sorted by frameNumber
  opacity: number;
  hide: boolean;
  lock: boolean;
  useOnion: boolean;
  blendMode: BlendMode;
  tint: Vec4;              // rgb + factor in [3]
  thicknessOffset: number; // px added to stroke widths
  translation: Vec3;
  rotation: Vec3;          // euler radians
  scale: Vec3;
  useMask: boolean;
  maskLayerIds: number[];  // layers whose fills clip this layer (approx)
}

export interface GPMaterial {
  name: string;
  showStroke: boolean;
  strokeColor: Vec4;
  lineMode: LineMode;
  showFill: boolean;
  fillColor: Vec4;
  fillStyle: FillStyle;
  fillColor2: Vec4;        // gradient secondary
  gradientAngle: number;   // radians, linear gradient direction
  holdout: boolean;
}

// ---- Modifiers ----------------------------------------------------------

export type ModifierType =
  | 'NOISE' | 'SMOOTH' | 'SUBDIVIDE' | 'SIMPLIFY' | 'THICKNESS' | 'OFFSET'
  | 'ARRAY' | 'MIRROR' | 'BUILD' | 'TINT' | 'OPACITY' | 'LENGTH' | 'TIME' | 'WAVE';

export interface GPModifier {
  id: number;
  type: ModifierType;
  name: string;
  enabled: boolean;
  layerFilter: number | null;    // layer id or null = all
  materialFilter: number | null; // material index or null = all
  // type-specific params, kept loose for JSON friendliness
  params: Record<string, number | boolean | number[]>;
}

// ---- Visual effects (screen-space) --------------------------------------

export type EffectType =
  | 'BLUR' | 'GLOW' | 'PIXELATE' | 'RIM' | 'SHADOW' | 'COLORIZE' | 'FLIP' | 'SWIRL' | 'WAVE_FX';

export interface GPEffect {
  id: number;
  type: EffectType;
  name: string;
  enabled: boolean;
  params: Record<string, number | boolean | number[]>;
}

// ---- Object --------------------------------------------------------------

export interface GPObject {
  name: string;
  layers: GPLayer[];       // index 0 = bottom
  activeLayerId: number;
  materials: GPMaterial[];
  activeMaterial: number;
  modifiers: GPModifier[];
  effects: GPEffect[];
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  // onion skin settings (per object, like Blender's data panel)
  onion: {
    enabled: boolean;
    mode: 'FRAMES' | 'KEYFRAMES';
    before: number;
    after: number;
    colorBefore: Vec3;
    colorAfter: Vec3;
    opacity: number;
  };
}

/** A quad object in the scene: drawing surface and/or reference plane. */
export interface CanvasPlane {
  id: number;
  name: string;
  translation: Vec3;
  rotation: Vec3;          // euler radians
  size: [number, number];
  visible: boolean;
  select: boolean;
  drawTarget: boolean;     // false = reference plane only (not a Surface target)
}

export interface GPCameraKey {
  frame: number;
  translation: Vec3;
  rotation: Vec3;          // euler radians (interpolated via quaternion slerp)
  fov: number;
}

/** A scene camera: transformable, keyframable, viewable (numpad 0). */
export interface GPCamera {
  name: string;
  translation: Vec3;
  rotation: Vec3;
  fov: number;
  keys: GPCameraKey[];     // sorted by frame
}

// ---- Score system (P3): strokes as playable paths -------------------------

export interface PathRef {
  objectIndex: number;
  layerId: number;
  strokeId: number;
}

/** Message template: {x} {y} {z} {t} {id} {name} substitute at fire time. */
export interface MsgTemplate {
  address: string;
  argExprs: string[];
}

export type LoopMode = 'LOOP' | 'PINGPONG' | 'ONCE';

/** A playhead riding a stroke on its own clock (IanniX cursor). */
export interface TGCursor {
  id: number;
  name: string;
  path: PathRef;
  speed: number;           // path lengths per second (negative = reverse)
  phase: number;           // 0..1 position along the path
  loop: LoopMode;
  running: boolean;
  rate: number;            // message emissions per second
  messages: MsgTemplate[];
  color: Vec3;
}

/** Fires when a cursor enters its radius (IanniX trigger). */
export interface TGTrigger {
  id: number;
  name: string;
  position: Vec3;          // world space
  radius: number;
  retrigger: boolean;      // false = fire once per cursor until scene reload
  messages: MsgTemplate[];
}

/** A scene object riding a path on its own clock. */
export interface TGAttachment {
  id: number;
  target: { kind: 'CANVAS' | 'CAMERA'; id: number }; // canvas id / camera index
  path: PathRef;
  speed: number;
  phase: number;
  loop: LoopMode;
  running: boolean;
  orient: 'NONE' | 'TANGENT';
  offset: Vec3;
}

export interface TGScore {
  cursors: TGCursor[];
  triggers: TGTrigger[];
  attachments: TGAttachment[];
}

export interface GPScene {
  objects: GPObject[];
  activeObject: number;
  frame: number;
  frameStart: number;
  frameEnd: number;
  fps: number;
  cursor: Vec3;            // 3D cursor
  canvases: CanvasPlane[];
  cameras: GPCamera[];
  activeCamera: number;
  /** event IO endpoints (P2) */
  io: { wsUrl: string; midiInId: string | null; midiOutId: string | null };
  score: TGScore;
}
