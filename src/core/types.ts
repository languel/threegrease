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
  /** 0..1 input-sample density at this point, baked while drawing: 1 where
   *  the pointer moved slowly and left dense samples, 0 where it was flung.
   *  Baked because simplifyStroke deletes the points that carry the
   *  evidence — it cannot be recovered from the stroke afterwards. */
  density?: number;
}

export type LineMode = 'LINE' | 'DOTS' | 'SQUARES';

/**
 * What drives a brush's variation ALONG the stroke. This is the difference
 * between a dead uniform ribbon and something with handwriting in it.
 * - RANDOM     seeded noise along the arc — grit, dry media
 * - CURVATURE  how hard the stroke turns here — ink pooling in the corners
 * - DENSITY    how densely the INPUT was sampled before simplification,
 *              i.e. how slowly it was drawn. Must be baked at draw time:
 *              simplifyStroke throws the evidence away.
 * - ARC        plain position along the stroke, for deliberate ramps
 */
export type VaryMode = 'NONE' | 'RANDOM' | 'CURVATURE' | 'DENSITY' | 'ARC';

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
  // ---- variation along the stroke (optional; absent = the old uniform
  //      ribbon, so every existing stroke renders unchanged) -----------
  varyMode?: VaryMode;
  varyRadius?: number;      // 0..1 how much the signal thins the width
  varyStrength?: number;    // 0..1 how much it fades the alpha
  varyScale?: number;       // RANDOM frequency, in cycles along the stroke
  /** Fraction of the stroke over which width ramps up from the start /
   *  down into the end. A real brush lifts off; a straight ribbon doesn't. */
  taperIn?: number;
  taperOut?: number;
}
export type FillStyle = 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'TEXTURE';
/** How a stroke's ribbon is coloured. Blender GP offers Solid|Texture here;
 *  GRADIENT_* are ours — they ramp along the stroke's arc length (LINEAR)
 *  or across its width (RADIAL), which is what makes a pencil read as
 *  pressed-hard-in-the-middle rather than a flat band.
 *  NB: `StrokeStyle` is already taken by the baked per-stroke brush record
 *  above — this is the MATERIAL's shading mode, hence the different name. */
export type StrokeShade = 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'TEXTURE';

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
  // ---- NPR stroke shading (all optional: absent = plain SOLID, the
  //      look every pre-existing material had) --------------------------
  strokeShade?: StrokeShade;
  strokeColor2?: Vec4;      // gradient secondary, along/across the stroke
  strokeImageId?: number | null;
  /** Texture repeats along the stroke's arc length. 1 = stretch the image
   *  once end to end; higher tiles it, which is what gives a dry pencil its
   *  repeating tooth instead of one smeared copy. */
  strokeUvFactor?: number;
  /** 0 = texture replaces the colour, 1 = colour untouched. Blender's
   *  "Blend" slider on a textured stroke. */
  strokeTexBlend?: number;
  fillImageId?: number | null;
  fillUvFactor?: number;
  fillTexBlend?: number;
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

export interface ParentRef { kind: 'GP' | 'CANVAS' | 'SPLAT' | 'MESH' | 'TRIGGER' | 'STREAM' | 'POLY' | 'PCLOUD' | 'LIGHT' | 'ACTOR'; id: number }

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
  /** COPY_LOCATION / COPY_ROTATION / TRACK_TO / LIMIT_DISTANCE / SPRING,
   *  when `target.kind === 'ACTOR'`: ride that joint's live pose instead
   *  of the actor's root transform — a joint NAME, matching TGJoint.name */
  targetJoint?: string | null;
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
  kind: 'POSE' | 'HAND_LEFT' | 'HAND_RIGHT' | 'FACE' | 'IRIS' | 'CUSTOM' | 'DETECT';
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
  /** DETECT kind: open-vocabulary detection config. One point per hit, at
   *  the box centre, so detections probe zones like any other landmark. */
  detect?: DetectConfig;
  /** last frame's detections, runtime-only — the labels the UI shows and
   *  the message templates substitute. Never serialized. */
  detectHits?: DetectHit[];
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
  /**
   * WORLD (default) is a recording of where something WAS — landmarks, an
   * object's path — and replays in place. ACTOR_LOCAL is a recording of a
   * POSE: joint positions in the actor's own frame, so it replays on the
   * character wherever it happens to be standing rather than dragging it
   * back to where it was performed.
   */
  space?: 'WORLD' | 'ACTOR_LOCAL';
  /** ACTOR_LOCAL only: joint NAME per point, index-aligned with each
   *  frame's data. Names rather than indices so a performance recorded on
   *  one actor plays on another with the same vocabulary. */
  joints?: string[];
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

// ---- Materials & images (shared datablocks) -------------------------------
// Blender-style: images and materials are SCENE-level datablocks referenced
// by id, so one material can drive many objects and one image can feed many
// slots. Objects previously carried flattened `color/opacity/texture/...`
// fields directly; those are migrated into materials on load (serialize.ts)
// and kept readable for one version so old saves don't change appearance.

/** An image datablock. `src` is a dataURL (persists with the scene) or a
 *  URL. This is also where bake results land — see `baked`. */
export interface TGImage {
  id: number;
  name: string;
  src: string;
  width?: number;
  height?: number;
  /** produced by a bake rather than authored/imported — regenerable */
  baked?: boolean;
}

/** Which channel a texture slot drives. Maps 1:1 onto three.js
 *  MeshStandardMaterial's map slots (and onto glTF on export). */
export type TextureSlotName =
  | 'base' | 'roughness' | 'metallic' | 'normal' | 'emission' | 'alpha' | 'ao';

/** One image bound into one channel, with a Blender-style UV mapping. */
export interface TGTextureSlot {
  imageId: number;
  offset: [number, number];
  scale: [number, number];
  rotation: number;        // radians
  /** blend against the channel's flat value (1 = image only) */
  factor: number;
  enabled: boolean;
}

export type MaterialBlend = 'OPAQUE' | 'BLEND' | 'ADD' | 'MULTIPLY';

/** A material datablock, shared by reference across mesh-family objects.
 *  PBR channels are authored now even though they only become meaningful
 *  once real lights exist, so the model doesn't need reworking later. */
export interface TGMaterial {
  id: number;
  name: string;
  baseColor: Vec3;
  opacity: number;
  roughness: number;
  metallic: number;
  emission: Vec3;
  emissionStrength: number;
  /** ignore scene lights (flat/reference look) */
  unlit: boolean;
  doubleSided: boolean;
  wireframe: boolean;
  blend: MaterialBlend;
  slots: Partial<Record<TextureSlotName, TGTextureSlot>>;
}

// ---- Lights ---------------------------------------------------------------
// Lighting used to be two hardcoded objects in the App constructor, which
// meant the PBR material channels (roughness/metallic/emission) had nothing
// meaningful to respond to and shadows were impossible. Lights are now
// ordinary scene objects: selectable, transformable, parentable, and
// constrainable through the same ObjKind machinery as everything else.

export interface TGLight {
  id: number;
  name: string;
  /** AMBIENT ignores transform (it's uniform); SUN is directional and uses
   *  only rotation; POINT/SPOT use translation. */
  kind: 'AMBIENT' | 'SUN' | 'POINT' | 'SPOT';
  color: Vec3;
  intensity: number;
  translation: Vec3;
  rotation: Vec3;
  /** POINT/SPOT falloff distance (0 = never falls off) */
  distance?: number;
  decay?: number;
  /** SPOT cone */
  angle?: number;
  penumbra?: number;
  castShadow: boolean;
  shadowBias?: number;
  shadowRadius?: number;
  /** shadow map resolution (square); bigger = crisper but costlier */
  shadowMapSize?: number;
  visible: boolean;
  select: boolean;
  lock?: boolean;
  parent?: ParentRef | null;
  constraints?: TGConstraint[];
}

/** A mesh scene object: primitive solid, plane, or imported model —
 *  usable as a reference or as a Surface-placement draw target. */
export interface TGMesh {
  id: number;
  name: string;
  /** EMPTY = Blender-style null object: an axes tripod with no surface —
   *  a parenting/grouping anchor and constraint target, never a draw
   *  target or export geometry. */
  kind: 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER' | 'MODEL' | 'EMPTY';
  src?: string;            // MODEL only: .glb/.gltf/.obj URL (blob = session)
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  select: boolean;
  lock?: boolean;
  drawTarget: boolean;     // raycast target for Surface placement
  /** blocks a possessed character (walls, furniture) and supports it as
   *  ground. Undefined means yes — collision is the default, opt out for
   *  ghost geometry, glass, and reference planes you want to walk through. */
  collide?: boolean;
  wireframe: boolean;      // reference look
  color: Vec3;
  opacity: number;
  parent?: ParentRef | null;
  constraints?: TGConstraint[];
  /** shared TGMaterial datablock (scene.materials). Authoritative when set;
   *  the legacy flattened fields below are migrated into one on load. */
  materialId?: number | null;
  // ---- legacy material fields (pre-datablock; kept for migration) ----
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

// ---- Editable generalized mesh (TGPolyMesh) -------------------------------
// Persistent authored topology: 0D vertices + 1D edges + 2D faces in ONE
// object, deliberately non-manifold-tolerant (isolated vertices, dangling
// edges, open chains, disconnected components are all valid). Faces store
// ordered polygon BOUNDARIES; triangulation is derived for render/export/
// queries and never written back. See docs/design/polymesh.md.

/** Where a vertex came from — provenance only in this phase: the explicit
 *  `co` is always authoritative and bindings are never re-evaluated when
 *  the source moves or disappears. */
export type TGVertexBinding =
  | { kind: 'FREE' }
  | { kind: 'PLANE' }
  | { kind: 'GP_STROKE'; path: PathRef; t: number }
  | { kind: 'SPLAT'; objectId: number; pointIndex?: number }
  | { kind: 'PCLOUD'; cloudId: number; pointIndex?: number }
  | { kind: 'MESH'; objectId: number };

export interface TGPolyVertex {
  id: number;
  co: Vec3;                 // object-local
  select?: boolean;
  binding?: TGVertexBinding | null;
}

/** Identity is the UNORDERED vertex pair; `v` order is storage only. */
export interface TGPolyEdge {
  id: number;
  v: [number, number];
  select?: boolean;
}

export interface TGPolyFace {
  id: number;
  vertices: number[];       // ordered boundary, >= 3 unique vertex ids
  select?: boolean;
  /** Persisted UVs, one per boundary corner (parallel to `vertices`).
   *  Per-CORNER rather than per-vertex so a vertex can carry different
   *  UVs on either side of a seam. Absent = fall back to the dynamic
   *  planar auto-projection (polyAutoUV), which is what every mesh used
   *  before unwrapping existed. See core/uvunwrap.ts. */
  uv?: [number, number][];
}

export interface TGPolyMesh {
  id: number;
  name: string;
  vertices: TGPolyVertex[];
  edges: TGPolyEdge[];
  faces: TGPolyFace[];
  /** monotonic per-mesh element-id counter (shared across v/e/f) */
  nextElemId: number;
  /** bumped by every topology/geometry mutation — renderer cache key */
  rev: number;
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  select: boolean;
  lock?: boolean;
  parent?: ParentRef | null;
  constraints?: TGConstraint[];
  // mesh-look fields, matching TGMesh conventions
  drawTarget: boolean;      // faces join ctx.surfaces for Surface placement
  /** shared TGMaterial datablock (scene.materials). Authoritative when set;
   *  the legacy flattened fields below are migrated into one on load. */
  materialId?: number | null;
  // ---- legacy material fields (pre-datablock; kept for migration) ----
  wireframe: boolean;
  color: Vec3;
  opacity: number;
  unlit?: boolean;
  doubleSided?: boolean;
  /** texture-paint target (dataURL persists; UVs come from persisted
   *  per-face UVs when present, else planar auto-projection) */
  texture?: string | null;
}

/** 3DGS painting: a gaussian-splat cloud AUTHORED with the Splat Paint
 *  brush (vs TGSplat, which is a URL-loaded asset). Plain JSON — points
 *  are packed stride 8: x,y,z (object-local), radius (world units at
 *  scale 1), r,g,b, alpha. Rendered as soft gaussian sprites; exportable
 *  as a standard 3DGS PLY. */
export interface TGPaintCloud {
  id: number;
  name: string;
  /** packed [x,y,z, radius, r,g,b, a] * N */
  points: number[];
  /** bumped on every paint/erase — renderer cache key */
  rev: number;
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  select: boolean;
  lock?: boolean;
  parent?: ParentRef | null;
  constraints?: TGConstraint[];
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
// ---- Actors: rigged characters (ragdoll / mannequin) ----------------------
//
// The skeleton is POSITIONAL, not rotational: a joint is a particle with a
// position, a bone is a distance constraint between two of them. That one
// choice is what lets a single solver serve all four things an actor has to
// do — ragdoll physics (verlet + PBD projection), 1:1 marker capture (pin a
// particle straight to a landmark), angle retargeting (set bone DIRECTIONS,
// keep our own limb lengths), and IK (FABRIK works on joint positions
// directly). A rotational skeleton would need a conversion for three of the
// four. Bone rotations are DERIVED for display, never stored.
//
// Positions live in ACTOR-LOCAL space so the actor's own transform (and any
// parent's) moves the whole character without disturbing the simulation —
// attach an actor to a moving platform and the ragdoll rides it. Gravity is
// rotated into that space each step.

export interface TGJoint {
  id: number;
  name: string;
  /** rest ("T-pose") position, actor-local */
  rest: Vec3;
  /** heavier joints win a distance projection against lighter ones; 0 = */
  /** immovable (the classic PBD infinite-mass pin) */
  mass: number;
  /** held at its driven/rest position instead of simulated */
  pin: boolean;
  /** display + collision radius */
  radius: number;
  select?: boolean;
}

export interface TGBone {
  id: number;
  name: string;
  /** joint ids; `a` is the parent end for display and angle limits */
  a: number;
  b: number;
  /** 0..1 — how hard the distance constraint pulls back to rest length */
  stiffness: number;
  /** limb thickness for the mannequin capsule (0 = no visible limb) */
  radius: number;
}

/** Angular limit at the joint shared by two bones, in degrees. Keeps a
 *  ragdoll from folding an elbow backwards without needing full rotational
 *  joints: it is projected as a positional correction on the far ends. */
export interface TGJointLimit {
  bone: number;      // the child bone
  parent: number;    // the bone it hinges off
  min: number;       // smallest allowed angle between them (degrees)
  max: number;
}

/** How incoming data becomes a pose. Each mode is a different answer to
 *  "the performer is not the same shape as the character". */
export type RigMode =
  /** free ragdoll — physics only */
  | 'NONE'
  /** 1:1 — every mapped joint is pinned straight to its landmark. Exact,
   *  but inherits the performer's proportions and any capture jitter. */
  | 'MARKERS'
  /** directions only — each bone points the way the captured limb points,
   *  but keeps the ACTOR's length. Retargets across body shapes. */
  | 'ANGLES'
  /** a few landmarks (hands/feet/head) as IK goals; the rest is solved */
  | 'IK'
  /** no automatic input — drag joints, or drive them from routes */
  | 'MANUAL';

/** One joint's input binding: which stream landmark drives it.
 *  `landmark2` averages two landmarks, which is how the joints a capture
 *  model does not actually have (hips, chest, neck — all midpoints between
 *  a left/right pair) get bound without a special case per joint. */
export interface TGRigBinding {
  joint: number;
  streamId: number | null;
  landmark: number;
  landmark2?: number | null;
  /** 0..1 blend toward the captured value */
  weight: number;
}

export interface TGRig {
  mode: RigMode;
  /** default stream for bindings that don't name their own */
  streamId: number | null;
  bindings: TGRigBinding[];
  /** MARKERS/IK: how hard a pinned joint is pulled to its target (0..1) */
  strength: number;
  /** exponential smoothing on captured targets, 0 = raw, 1 = frozen */
  smoothing: number;
  /** ANGLES: scale the actor to the performer's overall size */
  matchScale: boolean;
  /** joints whose captured landmark is missing/low-confidence fall back to
   *  simulation rather than snapping to the origin */
  minConfidence: number;
}

export interface TGActorPhysics {
  enabled: boolean;
  /** world units/s^2 along -up */
  gravity: number;
  /** velocity retained per step (verlet drag) */
  damping: number;
  /** PBD projection passes — more = stiffer, slower */
  iterations: number;
  /** pull unpinned joints back toward the rest pose; this is what keeps a
   *  ragdoll from collapsing into a heap and reads as muscle tone */
  tone: number;
  /** collide joints with the z=0 (or y=0) ground plane */
  floor: boolean;
  /** keep bones from passing through each other */
  selfCollide: boolean;
}

/** Where one mixer layer gets its motion. */
export type ActorLayerSource = 'RIG' | 'GAIT' | 'CLIP' | 'MANUAL';

/**
 * One layer of the actor's animation mixer (see actor/mixer.ts). Authorship,
 * so it is scene data and it undoes; the live crossfade multiplier that
 * scales `weight` during a performance is runtime and deliberately is not.
 */
export interface TGActorLayer {
  id: number;                    // actor-local, like joints and bones
  name: string;
  enabled: boolean;
  /** authored blend weight, 0..1 */
  weight: number;
  /** which part of the body this layer is allowed to move */
  mask: 'ALL' | 'UPPER' | 'LOWER' | 'ARMS' | 'LEGS' | 'SPINE' | 'HEAD';
  source: ActorLayerSource;
  // ---- CLIP source ----
  clipId?: number | null;
  /** playback head, 0..1 of the clip */
  phase?: number;
  /** cycles per second */
  speed?: number;
  loop?: LoopMode;
  playing?: boolean;
}

export interface TGActor {
  id: number;
  name: string;
  joints: TGJoint[];
  bones: TGBone[];
  limits: TGJointLimit[];
  /** current pose: actor-local joint positions, index-aligned with joints.
   *  Persisted (this IS the character's pose); velocity is not. */
  pose: Vec3[];
  rig: TGRig;
  /** mixer stack — every source of motion, weighed and masked in one place */
  layers?: TGActorLayer[];
  physics: TGActorPhysics;
  /** draw solid limb capsules, or just the stick skeleton */
  /** Procedural walk cycle. Phased by DISTANCE travelled, not time, so
   *  stride couples to speed and feet do not slide — see actor/gait.ts. */
  gait?: {
    enabled: boolean;
    /** metres of ground covered per full cycle (two steps) */
    strideLength: number;
    stepHeight: number;
    /** lateral separation between the feet */
    stanceWidth: number;
    /** fraction of the cycle a foot is planted; >0.5 walks, <0.5 runs */
    dutyFactor: number;
    /** pelvis drop per step */
    bob: number;
    armSwing: number;
    /** speed the gait is tuned around, m/s — also the fade-in threshold */
    walkSpeed: number;
    /** how hard the gait pulls the feet, 0..1 */
    strength: number;
  };
  shape: 'CAPSULE' | 'STICK' | 'BOTH';
  color: Vec3;
  opacity: number;
  visible: boolean;
  select: boolean;
  lock?: boolean;
  parent?: ParentRef | null;
  constraints?: TGConstraint[];
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
  materialId?: number | null;
}

/**
 * A persisted measurement: a polyline whose segment lengths are drawn in the
 * viewport. Two points is a ruler; three or more also reports the angle at
 * each interior vertex, which is what you need when squaring up a room from
 * photographs.
 *
 * This is scene data rather than a transient overlay because a blockout is
 * built over days — "that doorway is 900" has to survive a save, and the
 * measurement that established the scene's scale has to stay auditable.
 */
export interface TGMeasure {
  id: number;
  name: string;
  /** world-space points, in order */
  points: Vec3[];
  visible: boolean;
  select?: boolean;
  lock?: boolean;
  /** freeze it once it has served its purpose, so a stray drag can't move
   *  the reference the whole scene was scaled from */
  locked?: boolean;
}

/** One open-vocabulary detection: what matched, how strongly, and where.
 *  Box is [x0,y0,x1,y1] as 0..1 fractions of the source frame. */
export interface DetectHit {
  label: string;
  score: number;
  box: [number, number, number, number];
}

/** Semantic detection config on a stream. The queries ARE the classes —
 *  free text, matched by CLIP's text tower, so "a person wearing a hat" is
 *  as valid a class as "dog". */
export interface DetectConfig {
  /** transformers.js model id (see DETECT_MODELS) */
  model: string;
  /** one phrase per class to look for */
  queries: string[];
  /** 0..1 confidence floor */
  threshold: number;
  /** cap on detections per frame — also the stream's point count ceiling */
  maxResults: number;
  /** ms between inferences. Open-vocabulary detection is not frame-rate
   *  work, so this is a real dial, not a formality. */
  intervalMs: number;
  /** try WebGPU first — the loader falls back to WASM if it fails */
  webgpu: boolean;
}

/** Display units. The scene itself is unitless — one world unit is one
 *  METRE by convention (the actor mannequin is 1.8 tall, gravity is 9.81),
 *  and this only decides how lengths are WRITTEN. Changing it never moves
 *  anything, which is what keeps it safe to flip while working. */
export type LengthUnit = 'M' | 'CM' | 'MM' | 'FT' | 'IN';

export interface TGRoute {
  id: number;
  enabled: boolean;
  match: { source: 'MIDI' | 'WS' | 'ANY'; address: string }; // glob address
  /** whitelisted dot-path, e.g. 'brush.size', 'layer.3.opacity',
   *  'cursor.2.speed', 'camera.0.fov', 'modifier.9.factor' */
  target: string;
  mapping: { inMin: number; inMax: number; outMin: number; outMax: number; mode: RouteMapMode };
}

/** How the viewport shades mesh-family objects. GP strokes are unlit by
 *  design and look the same in every mode except WIREFRAME. Mirrors
 *  Blender's four viewport shading buttons. */
export type ViewportShading = 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED';

/** Where the world's environment image comes from.
 *  EQUIRECT/VIDEO both expect an EQUIRECTANGULAR (2:1 lat-long) projection —
 *  the format 360 cameras and drones export. */
export type WorldMode = 'SOLID' | 'GRADIENT' | 'EQUIRECT' | 'VIDEO' | 'SKY';

/** Scene world: what you see behind everything, and what lights it (IBL).
 *  One equirect texture drives both, which is why every mode ultimately
 *  renders to that shape — see render/world.ts. */
export interface TGWorld {
  mode: WorldMode;
  /** SOLID, and the fallback whenever a source is missing or still loading */
  color: Vec3;
  /** GRADIENT: up and down colours */
  skyColor: Vec3;
  groundColor: Vec3;
  /** EQUIRECT: an image datablock (scene.images) holding a lat-long map */
  imageId: number | null;
  /** VIDEO: live capture, or a file/URL the browser can play */
  videoSource: 'CAMERA' | 'URL';
  videoUrl: string;
  /** SKY (three.js physical sky) */
  sunElevation: number;   // degrees above the horizon
  sunAzimuth: number;     // degrees
  turbidity: number;
  rayleigh: number;
  /** shared controls */
  rotation: number;            // radians about the world up axis
  strength: number;            // IBL intensity
  backgroundVisible: boolean;  // false = light the scene but keep the flat bg
  backgroundIntensity: number;
  blur: number;                // 0..1 background blur
  /** Light objects from the world. Off = background only, no IBL. */
  lighting: boolean;
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
  /** scene lights (migrated from the old hardcoded ambient + sun) */
  lights: TGLight[];
  /** shared image datablocks (textures, brush tips, stencils, bake results) */
  images: TGImage[];
  /** environment: background + image-based lighting */
  world: TGWorld;
  /** shared material datablocks, referenced by mesh-family objects */
  materials: TGMaterial[];
  splats: TGSplat[];
  meshes: TGMesh[];
  /** editable generalized meshes (authored topology) */
  polyMeshes: TGPolyMesh[];
  /** painted gaussian-splat clouds (3DGS painting) */
  paintClouds: TGPaintCloud[];
  attractors: TGAttractor[];
  mediamime: { prefix: string; rigs: MMRig[] };
  /** native MediaMime landmark streams (config; frames are runtime-only) */
  mmStreams: MMStream[];
  /** recorded point clips (mm streams / object trajectories) */
  clips: TGClip[];
  /** rigged characters (ragdoll / mannequin), see actor/ */
  actors: TGActor[];
  /** persisted rulers / annotations for real-world blockout */
  measures: TGMeasure[];
}
