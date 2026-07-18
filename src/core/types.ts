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
  /** event identity: shown in the Stroke panel, used as the default
   *  message address prefix for cursors/triggers assigned to this stroke */
  name?: string;
  address?: string;
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

export interface ParentRef { kind: 'GP' | 'CANVAS' | 'SPLAT' | 'MESH' | 'TRIGGER' | 'STREAM'; id: number }

// ---- object constraints (Blender-style stack, evaluated every frame) ----

export type ConstraintType =
  | 'FOLLOW_PATH'      // traveler: ride a GP stroke on its own clock
  | 'FOLLOW_STREAM'    // driver: ride a live MediaMime stream landmark
  | 'TRIGGER'          // proximity trigger: fires when a traveler enters
  | 'COPY_LOCATION' | 'COPY_ROTATION' | 'COPY_SCALE'
  | 'TRACK_TO'         // aim at a target object
  | 'LIMIT_DISTANCE'   // clamp within a radius of a target
  | 'SHRINKWRAP'       // project onto the nearest draw-target surface
  | 'FLOOR'            // don't sink below the ground plane
  | 'SPRING';          // damped spring toward a target (physics-lite)

export interface TGConstraint {
  id: number;
  type: ConstraintType;
  name: string;
  enabled: boolean;
  influence: number;             // 0..1 blend for transform constraints
  target?: ParentRef | null;     // COPY_* / TRACK_TO / LIMIT_DISTANCE / SPRING
  path?: PathRef | null;         // FOLLOW_PATH
  // FOLLOW_PATH clock
  phase?: number;
  speed?: number;
  loop?: LoopMode;
  running?: boolean;
  orient?: boolean;              // align to path tangent
  // FOLLOW_STREAM
  streamId?: number | null;
  landmark?: number;
  // TRIGGER — zone SHAPE comes from the carrier object: BOX/SPHERE/CYLINDER
  // primitives test their actual volume, PLANE fires on crossing, everything
  // else uses the radius sphere. leaveMessages fire when a probe exits.
  radius?: number;
  retrigger?: boolean;
  messages?: MsgTemplate[];
  leaveMessages?: MsgTemplate[];
  // LIMIT_DISTANCE / SPRING / FLOOR / SHRINKWRAP
  distance?: number;
  stiffness?: number;
  damping?: number;
  offset?: number;
}

export interface GPObject {
  id: number;              // stable id (parenting, object refs)
  name: string;
  constraints?: TGConstraint[];
  select?: boolean;        // object-mode selection
  /** object-level visibility/lock (outliner eye/lock icons), independent
   *  of any per-layer hide/lock — hides/locks every layer at once. */
  hide?: boolean;
  lock?: boolean;
  parent?: ParentRef | null;
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
  parent?: ParentRef | null;
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
  /** wire-art target drawing for this viewpoint (dataURL), P6 */
  target?: string;
  targetOpacity?: number;  // assist overlay opacity in camera view
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
  /** track this object's world origin every frame (collider-style triggers) */
  follow?: ParentRef | null;
  /** stroke-as-trigger-zone: inside = within radius of ANY point of this
   *  stroke (overrides position when set) */
  zone?: PathRef | null;
  /** hierarchy/object-mode: triggers are selectable, transformable,
   *  parentable primitives (see tools/objects.ts ObjKind 'TRIGGER') */
  select?: boolean;
  hide?: boolean;
  lock?: boolean;
  parent?: ParentRef | null;
  constraints?: TGConstraint[];
}

/** Native MediaMime: a live landmark stream (pose/hands/face) captured
 *  in-app (webcam + MediaPipe) or fed from event-bus addresses, represented
 *  as a first-class 3D point cloud in the scene. Only the CONFIG persists —
 *  live frames are runtime data (see src/mm/streams.ts StreamStore). */
export interface MMStream {
  id: number;
  name: string;
  /** semantic channel; IRIS = the 10 iris points of the face model
   *  (their own stream so an eye can drive a cursor); CUSTOM = arbitrary
   *  bus-fed point set */
  kind: 'POSE' | 'HAND_LEFT' | 'HAND_RIGHT' | 'FACE' | 'IRIS' | 'CUSTOM';
  /** CLIP = replays a recorded TGClip through the same live-frame store */
  source: 'CAMERA' | 'BUS' | 'CLIP';
  /** BUS source: address prefix whose numeric-suffixed children are point
   *  indices, e.g. '/mm/pose' consumes '/mm/pose/0'..'/mm/pose/32' with
   *  args x,y[,z[,confidence]] */
  busAddress?: string;
  // ---- CLIP source: traveler-style clock over the recorded frames ----
  clipId?: number | null;
  playing?: boolean;
  loop?: LoopMode;
  speed?: number;          // playback rate multiplier (1 = realtime)
  phase?: number;          // 0..1 through the clip
  visible: boolean;
  select?: boolean;
  lock?: boolean;
  /** streams are full scene objects: constraint stack + trigger probing */
  constraints?: TGConstraint[];
  /** landmarks act as probes for TRIGGER zones (default on; FACE off —
   *  478 probes per frame is rarely what you want) */
  probeEvents?: boolean;
  /** live pen: one landmark draws strokes into the active GP object while
   *  armed — confidence gates pen-down (below minConf = pen up, stroke
   *  ends) and becomes pressure, like baked clips */
  pen?: { active: boolean; landmarks: number[]; minConf: number };
  parent?: ParentRef | null;
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** flip X for webcam selfie view */
  mirror: boolean;
  /** scale on the landmark z axis: MediaPipe's normalized-space depth is
   *  noisy for POSE (hip-relative guesses — default 0 = flat) but genuinely
   *  useful relative depth for hands/face/iris (default 1) */
  depthScale: number;
  // ---- splat look ----
  /** world-space splat radius at scale 1 */
  pointSize: number;
  color: Vec3;
  /** per-point confidence modulates splat opacity */
  confidenceAlpha: boolean;
  /** per-point confidence modulates splat size */
  confidenceSize: boolean;
  /** CAMERA streams: re-emit world-space landmarks onto the event bus
   *  ('<prefix>/pose/0' …) so rigs/routes/triggers can consume them —
   *  streams become pens/cursors/travelers via the existing machinery. */
  emitBus: boolean;
}

/** A recorded point-set-over-time ("splats × time"): frames of packed
 *  WORLD-space [x,y,z,confidence] samples. Sources: a whole MM stream, or
 *  any object's origin (travelers, followers — count=1). Playback goes
 *  through a CLIP-source MMStream (same rendering/constraints/events as
 *  live data); bake turns a landmark's trajectory into a GP stroke with
 *  confidence→pressure. */
export interface TGClip {
  id: number;
  name: string;
  /** provenance label, e.g. 'stream:Pose' or 'object:box' */
  source: string;
  /** points per frame (1 for object recordings) */
  count: number;
  /** total duration in ms (t of the last frame) */
  duration: number;
  /** non-destructive trim window, 0..1 of duration — playback and bake
   *  honor it; "crop" makes it permanent */
  trimStart?: number;
  trimEnd?: number;
  frames: { t: number; data: number[] }[];
}

/** MediaMime (P11): binds a live tracked-landmark address (x,y,z over the
 *  event bus, e.g. '/mm/pose/16') to any scene object's translation — the
 *  mapping/rigging system for attaching objects to MediaPipe markers. */
export interface MMRig {
  id: number;
  name: string;
  address: string;
  target: ParentRef;
  offset: Vec3;
  scale: number;
  enabled: boolean;
  /** Every frame, force rotation to 0 and scale to 1 on the target
   *  instead of preserving whatever it's currently at — keeps the rig
   *  driving from a clean base so it can't drift. Defaults true
   *  (including for scenes serialized before this field existed). */
  resetTransform?: boolean;
}

/** A scene object riding a path on its own clock. */
export interface TGAttachment {
  id: number;
  target: { kind: 'CANVAS' | 'CAMERA' | 'SPLAT' | 'MESH'; id: number };
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

// ---- Property routing (P4, the routional layer) ---------------------------

/** A Gaussian splat scene object, rendered via the Spark adapter (P7). */
export interface TGSplat {
  id: number;
  name: string;
  src: string;             // URL (object URLs are session-only, warned in UI)
  translation: Vec3;
  rotation: Vec3;
  scale: number;
  visible: boolean;
  select: boolean;
  lock?: boolean;
  parent?: ParentRef | null;
  /** applied ("baked") transform, column-major 4x4 — composed after the
   *  live TRS so Apply Transform can reset TRS without moving the object */
  baked?: number[];
  /** raycast target for SURFACE stroke placement (draw on the splat) */
  drawTarget?: boolean;
  constraints?: TGConstraint[];
}

/** A mesh scene object: primitive solid, plane, or imported model —
 *  usable as a reference or as a Surface-placement draw target. */
export interface TGMesh {
  id: number;
  name: string;
  kind: 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER' | 'MODEL';
  src?: string;            // MODEL only: .glb/.gltf/.obj URL (blob = session)
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  select: boolean;
  lock?: boolean;
  drawTarget: boolean;     // raycast target for Surface placement
  wireframe: boolean;      // reference look
  color: Vec3;
  opacity: number;
  parent?: ParentRef | null;
  constraints?: TGConstraint[];
  // ---- material (Blender-lite, the parts we need) ----
  /** image map (dataURL persists in the scene; URLs allowed) */
  texture?: string | null;
  /** ignore scene lights (flat/reference look) */
  unlit?: boolean;
  doubleSided?: boolean;
  /** NONE = world; FACE_VIEW = always face the viewport (billboard);
   *  CAMERA = locked to the view — transform becomes a camera-space offset */
  billboard?: 'NONE' | 'FACE_VIEW' | 'CAMERA';
  /** Local-space offset baked into the (procedural, primitive-only)
   *  geometry so "Set Origin" can move the translation pivot without the
   *  geometry moving in world space — mirrors GP's point-shift trick since
   *  primitive geometry has no persisted vertex data of its own. */
  originOffset?: Vec3;
}

/** Point force for the dynamic string simulation (P5). */
export interface TGAttractor {
  id: number;
  name: string;
  position: Vec3;      // world space
  strength: number;    // negative repels
  radius: number;
  /** track this object's world origin every frame (moving attractor) */
  follow?: ParentRef | null;
}

export type RouteMapMode = 'RAW' | 'SCALE' | 'CLAMP' | 'WRAP';

/** Bind incoming events to a scene/settings property. */
export interface TGRoute {
  id: number;
  enabled: boolean;
  match: { source: 'MIDI' | 'WS' | 'ANY'; address: string }; // glob address
  /** whitelisted dot-path, e.g. 'brush.size', 'layer.3.opacity',
   *  'cursor.2.speed', 'camera.0.fov', 'modifier.9.factor' */
  target: string;
  mapping: { inMin: number; inMax: number; outMin: number; outMax: number; mode: RouteMapMode };
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
  routes: TGRoute[];
  splats: TGSplat[];
  meshes: TGMesh[];
  attractors: TGAttractor[];
  mediamime: { prefix: string; rigs: MMRig[] };
  /** native MediaMime landmark streams (config; frames are runtime-only) */
  mmStreams: MMStream[];
  /** recorded point clips (mm streams / object trajectories) */
  clips: TGClip[];
}
