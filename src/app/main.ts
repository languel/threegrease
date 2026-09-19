import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { genId, createScene, activeObject, activeLayer, activeCam, createDefaultCamera, createLight, createObject, createFrame, cloneFrame, frameAt, keyframeIndexAt, baseTextureSrc, setBaseTexture } from '../core/gpdata';
import { History } from '../core/history';
import type { GPObject, GPScene, TGActor, TGActorLayer, TGLight, TGMesh, Vec3, ViewportShading } from '../core/types';
import { GPSceneRenderer, type EditorMode, type RenderState } from '../render/GPSceneRenderer';
import { EffectsPipeline } from '../fx/effects';
import { ScenePost, postActive } from '../fx/scenefx';
import { defaultSettings, loadPrefs, savePrefs, snapIncrement, type AppCtx } from '../tools/context';
import { ToolManager, type ToolEvent } from '../tools/toolsys';
import { DrawTool, EraseTool, SmoothTool, TintTool, CutterTool, EyedropperTool } from '../tools/draw';
import { FillTool } from '../tools/fill';
import { PrimitiveTool } from '../tools/primitives';
import { SelectTool, selectAll, selectConnected, selectLinked, selectMoreLess, selectedPoints } from '../tools/select';

function hasSelectedPoints(ctx: AppCtx): boolean {
  return selectedPoints(ctx).length > 0;
}

/** Settings color triples are gamma-encoded sRGB (same bytes the color-picker
 *  hex fields use) - THREE.Color's plain constructor/setRGB assume the
 *  working color space (linear) by default, which silently brightens
 *  midtones on round-trip. Route every settings-driven THREE.Color through
 *  this so what's picked is what's rendered. */
function srgbColor(rgb: [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

/** 12 edges (24 endpoints) of a Box3, flattened for LineSegmentsGeometry. */
function boxEdgePositions(box: THREE.Box3): number[] {
  const { min, max } = box;
  const corners = [
    [min.x, min.y, min.z], [max.x, min.y, min.z], [max.x, max.y, min.z], [min.x, max.y, min.z],
    [min.x, min.y, max.z], [max.x, min.y, max.z], [max.x, max.y, max.z], [min.x, max.y, max.z],
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const out: number[] = [];
  for (const [a, b] of edges) out.push(...corners[a], ...corners[b]);
  return out;
}

/** Real per-edge silhouette (Blender-style) for flat-faced primitives:
 *  the mesh's own geometry edges in WORLD space, so a rotated box/plane
 *  outlines its actual rotated corners instead of an axis-aligned bounding
 *  box. Scoped to BOX/PLANE (their edges ARE the visual silhouette from
 *  any angle) — SPHERE/CYLINDER/MODEL fall back to the bounding box since
 *  a literal wireframe of a curved/arbitrary mesh doesn't read as an
 *  outline (true screen-space silhouette detection is a separate, bigger
 *  feature, not attempted here). */
function meshEdgePositions(root: THREE.Object3D, kind: string): number[] | null {
  if (kind !== 'BOX' && kind !== 'PLANE') return null;
  const mesh = root as THREE.Mesh;
  if (!mesh.isMesh || !mesh.geometry) return null;
  root.updateWorldMatrix(true, false);
  const edges = new THREE.EdgesGeometry(mesh.geometry);
  const pos = edges.getAttribute('position');
  const out: number[] = new Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(root.matrixWorld);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  edges.dispose();
  return out;
}
import { ModalTransform } from '../tools/transform';
import { SculptTool } from '../tools/sculpt';
import { VertexPaintTool, WeightPaintTool } from '../tools/paint';
import * as ops from '../tools/editops';
import { Player } from '../anim/player';
import { interpolateFrame } from '../anim/interpolate';
import {
  downloadScene, downloadText, importGPObjects, openSceneFile,
  remapGPObjectIds, serializeGPObject,
} from '../io/serialize';
import { currentStickyPlane, drawingPlane, nearestStrokeEdgeAll, nearestStrokePointAll, objectToScreen, placementPreview, raycastSurfaces, screenToWorld } from '../tools/projection';
import { evalCamera, insertCameraKey, removeCameraKey } from '../anim/camera';
import { ACTIONS, Keymap, comboFromEvent } from './keymap';
import { CommandRegistry } from './commands';
import { BRUSH_PRESETS as BRUSH_PRESETS_CACHE } from '../core/brushes';
import {
  initAssets, listAssets, meshAssetPayload, onAssetsChanged, saveAsset, splatAssetPayload,
  streamAsset, updateAsset, ASSET_MIME, type TGAsset,
  exportLibrary as packLibrary, importLibrary, zipEntries,
} from '../io/assets';
import { LIVE_PREFIX, liveSources, testCardDataUrl } from '../io/livesources';
import { perf, PerfOverlay } from './perf';

function hasLight(o: THREE.Object3D): boolean {
  let found = false;
  o.traverse((c) => { if ((c as THREE.Light).isLight) found = true; });
  return found;
}

/** A Library tile's picture of an image: the image itself, fitted into the
 *  tile's square over the tile's own dark ground. */
function imageThumb(img: HTMLImageElement): string {
  const S = 160;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#202024';
  g.fillRect(0, 0, S, S);
  const k = Math.min(S / img.naturalWidth, S / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}
import { isStoreRef, putFile } from '../io/blobstore';
import { classifyFile, isYUpModel } from '../io/dropfiles';
import { mediamime } from '../io/mediamime';
import { createStream, mmStreamEngine, streamStore } from '../mm/streams';
import { mmCapture } from '../mm/capture';
import { StreamPointsManager } from '../mm/points';
import { bakeClipToStrokes, clipRecorder, cropClip, updateClipStreams, type RecordSource } from '../mm/clips';
import { streamPen } from '../mm/pen';
import type { MMStream } from '../core/types';
import { midi } from '../events/midi';
import { wsLink } from '../events/ws';
import { defaultCursor, ScoreEngine, scoreId } from '../score/engine';
import { constraintEngine, constraintsOf, createConstraint } from '../score/constraints';
import { ObjectModalTransform } from '../tools/objectmodal';
import { routes } from '../events/routes';
import { StringSim } from '../solvers/strings';
import { SplatManager } from '../splats/index';
import { MeshManager, createMeshObject } from '../render/meshes';
import { createPolyMesh, smoothPolyMesh, subdividePolyMesh } from '../core/polymesh';
import type { UnwrapMode } from '../core/uvunwrap';
import { unwrap } from '../core/uvunwrap';
import { PolyMeshManager } from '../render/polymesh';
import { LightManager } from '../render/lights';
import { ActorManager } from '../render/actors';
import { ActorPoseTool } from '../tools/actorpose';
import { snapToLattice, snapWorldPoint } from '../tools/snapping';
import {
  driveStreamFromActor, driveStreamFromObject, driverOf, isDriven,
  stopDrivingStream, tickSimStreams,
} from '../actor/simstream';
import { actorMixer } from '../actor/mixer';
import { steerEngine } from '../actor/steering';
import { behaviourEngine } from '../actor/behaviour';
import { actorState } from '../actor/state';
import {
  aPosePositions, applyPose, capturePose, holdFrom, pushHeldPoses, restPositions,
  tPosePositions,
} from '../actor/poses';
import { actorLog } from './actorlog';
import { retargetGltfClip } from '../actor/gltfclip';
import {
  motionBackends, proceduralBackend, remoteBackend, type MotionRequest,
} from '../actor/generate';
import { ARDY_NOTICES, ardyBackend, ardyDownloadHint } from '../actor/ardy';
import { bindHumanoid, poseHumanoid } from '../render/vrmpose';
import { vrmManager } from '../render/vrm';
import { propEngine } from '../actor/props';
import { rapierPhysics } from '../actor/rapierphys';
import { engineOf, resetPhysics } from '../actor/physics';
import { walkVolume } from '../actor/locomotion';
import { nextLayerId } from '../actor/mixer';
import { gaitEngine } from '../actor/gait';
import { buildDemoScene, buildPlaygroundScene, sketcherScript, wandererScript } from './demoscene';
import { MeasureTool, drawMeasures, measureLength, toWorldLength, worldPointsOf } from '../tools/measure';
import { DirectTool } from '../tools/direct';
import { createHumanoid, resetPose } from '../actor/skeleton';
import { autoRig } from '../actor/rig';
import { actorSolver } from '../actor/solver';
import { actorRig } from '../actor/rig';
import type { BakeSource } from '../render/bake';
import { bakeEngine } from '../render/bake';
import { PaintCloudManager, createPaintCloud } from '../render/paintclouds';
import { setSplatPickSource } from '../tools/splatpick';
import { setStencilObjectResolver, setStencilVideoSource } from '../tools/stencil';
import { SplatPaintTool } from '../tools/splatbrush';
import { TexturePaintTool, setTexPaintMeshManager, setTexPaintPolyManager } from '../tools/texpaint';
import { MeshEditTool } from '../tools/meshedit';
import { primitiveToPoly, isConvertiblePrimitive } from '../render/polyconvert';
import { touchPolyMesh } from '../core/polymesh';
import { separateConnectedIntoObjects } from '../tools/objectops';
import { deleteSelection, extrudeSelection, fillSelection, flushSelection, selectAllElems, separatePoly } from '../core/polyedit';
import { PolyPenTool } from '../tools/polytool';
import { clearPolyOverlay, polyOverlay } from '../render/polymesh';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  ObjectSelectTool, deleteObject, deselectAllObjects, getObjectTransform,
  allRefs, applyObjectTransform, getParent, gpIndexOf, listSelected, parentWorldMatrixOf, selectionPivot,
  setObjectSelected, setObjectTransform, setParentKeepWorld, worldMatrixOf,
  type ObjRef, type ObjTransform,
  refOfObject3D, objectName,
} from '../tools/objects';
import { UI, type AppHandle } from './ui';
import { SilhouetteOutline, type OutlineGroup } from '../render/outline';
import type { Tool } from '../tools/toolsys';
import { Navigation } from './nav';
import { possession, type PossessView } from './possess';
import type { OrthoPane, PaneId, PaneRect } from './quadview';
import { computePaneRects, createOrthoPanes, relockOrthoPane, syncOrthoFrustum } from './quadview';
import type { CanvasPlane } from '../core/types';
import type { AgentHost } from '../agent/types';
import { setAgentCommandLister } from '../agent/tools';
import { AgentRpc } from '../agent/rpc';
import { AgentPanel } from '../agent/panel';
import { webMcp } from '../agent/webmcp';
import { WorldManager } from '../render/world';
import { materialManager } from '../render/materialmgr';

/** tools that work on a poly mesh (they target `polyOverlay.editMeshId`) */
const MESH_TOOLS = new Set(['meshedit', 'polypen', 'polybuild', 'quadpatch']);

const DEFAULT_TOOL: Record<EditorMode, string> = {
  OBJECT: 'object-select', DRAW: 'draw', EDIT: 'select',
  SCULPT: 'sculpt', VERTEX: 'vertexpaint', WEIGHT: 'weightpaint',
};

/** Interpolate tool: horizontal drag picks the breakdown factor; release commits. */
class InterpolateTool implements Tool {
  id = 'interpolate';
  cursor = 'ew-resize';
  private startX = 0;
  private dragging = false;
  factor = 0.5;

  onDown(_ctx: AppCtx, e: ToolEvent): void { this.startX = e.x; this.dragging = true; this.factor = 0.5; }
  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (!this.dragging) return;
    this.factor = Math.min(1, Math.max(0, 0.5 + (e.x - this.startX) / 300));
  }
  onUp(ctx: AppCtx): void {
    if (!this.dragging) return;
    this.dragging = false;
    interpolateFrame(ctx, ctx.scene.frame, this.factor);
    ctx.refreshUI();
  }
  onCancel(): void { this.dragging = false; }
  drawHud(_ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    if (!this.dragging) return;
    hud.fillStyle = '#fff';
    hud.font = '14px sans-serif';
    hud.fillText(`Interpolate: ${(this.factor * 100).toFixed(0)}%`, 16, 40);
  }
}

class App implements AppHandle {
  ctx: AppCtx;
  private glRenderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private scene3 = new THREE.Scene();
  private gp = new GPSceneRenderer();
  private fx: EffectsPipeline;
  /** scene-level look: bloom, duotone, ink lines, grain */
  readonly post = new ScenePost(2, 2);
  private tools = new ToolManager();
  private modal = new ModalTransform();
  private player = new Player();
  private ui!: UI;
  private hud: HTMLCanvasElement;
  private cursorMarker: THREE.Group;
  /** debug aid: wireframe unit square + normal tick showing the current
   *  drawing plane — toggled via settings.showPlaneHelper */
  private planeHelper: THREE.Group;
  private planeHelperRay = new THREE.Raycaster();
  /** debug aid: ground-plane line from the camera's footprint to the
   *  current placement point's footprint — toggled via showDepthHelper */
  private depthHelper: THREE.Group;
  /** N2: Blender-style orange outlines + origin dots for selected objects */
  private selGlyphs = new THREE.Group();
  /** silhouette rims for selections that have no surface to fatten */
  private silhouette = new SilhouetteOutline();
  private silhouetteGroups: OutlineGroup[] = [];
  /** a splat's local bounds, which Spark computes by walking every splat —
   *  once per loaded mesh, not once per frame */
  private splatBounds = new WeakMap<THREE.Object3D, THREE.Box3>();
  private selHelpers = new Map<string, { box: THREE.Box3; helper: LineSegments2; dot: THREE.Points }>();
  private interpTool = new InterpolateTool();
  /** Out-of-process agent link (MCP/ACP relays). Idle until connected. */
  agentRpc!: AgentRpc;
  /** In-app chat session — owns its transcript across UI refreshes. */
  agent!: AgentPanel;
  /** Environment: background + image-based lighting. */
  world!: WorldManager;
  private nav!: Navigation;
  private navDrag: { mode: 'orbit' | 'pan' | 'dolly'; x: number; y: number } | null = null;
  private canvasGroup = new THREE.Group();
  private lastTime = performance.now();
  private grid!: THREE.Group;
  private axes!: THREE.Group;
  private gizmoDrag: { x: number; y: number; startX: number; startY: number; dragged: boolean } | null = null;
  private rmbDown: { x: number; y: number } | null = null;
  private cursorDrag = false;
  private objectPicking: ((ref: ObjRef | null) => void) | null = null;
  /** Blender-style G/R/S modal transform for object mode */
  readonly objModal = new ObjectModalTransform();
  presentation = false;
  cameraView = false;
  lockCamToView = true;
  /** Alt+Shift+Z: hide the floor grid + the bottom-left status/info overlay */
  private infoOverlayHidden = false;
  /** Ctrl+`: transform widget + all mouse-driven camera navigation locked
   *  (orbit/pan/dolly, the emulate-3-button drag, the nav gizmo) — a
   *  "don't let me bump the view" toggle for live performance. */
  private navLocked = false;
  private prevShowGizmo = false;
  private camHelper!: THREE.Group; // root: one frustum child per scene camera
  readonly keymap = new Keymap();
  readonly commands = new CommandRegistry();
  readonly score = new ScoreEngine();
  readonly sim = new StringSim();
  readonly splats = new SplatManager();
  readonly meshes = new MeshManager();
  readonly polys = new PolyMeshManager();
  readonly lights = new LightManager();
  readonly actors = new ActorManager();
  /**
   * The app's OWN module singletons, for browser-eval tests.
   *
   * Importing these from an eval is not reliable: after any HMR update vite
   * serves modules at "?t=..." URLs, so `await import('/src/mm/streams.ts')`
   * hands back a SECOND instance with its own `streamStore`. Frames pushed
   * into it are invisible to the running app, and the symptom is silent —
   * the feature simply does nothing. Reach them through here instead.
   */
  readonly sys = {
    streamStore, mmStreamEngine, actorSolver, actorRig, autoRig, resetPose,
    gaitEngine, possession, actorMixer, steerEngine, ardyBackend,
    behaviourEngine, actorLog, propEngine, rapierPhysics,
    bindHumanoid, poseHumanoid, vrmManager,
    /** the app's own three, so an eval never pulls a second copy in
     *  (importing 'three' makes vite re-optimize and silently reload) */
    THREE,
  };
  readonly paints = new PaintCloudManager();
  readonly mmPoints = new StreamPointsManager();
  /** app-instance store handle — evals/automation must use THIS, not an
   *  import('/src/mm/streams.ts') singleton (vite ?t= gives a second copy) */
  readonly mmStore = streamStore;
  /** same deal: app-instance constraint engine, drivable manually from
   *  headless tests (background tabs throttle rAF to ~0) */
  readonly constraints = constraintEngine;
  readonly mmRecorder = clipRecorder;
  readonly mmPen = streamPen;
  /** manual clip-playback step for headless tests */
  mmClipTick(dt: number): void { updateClipStreams(this.ctx.scene, dt); }
  /** trigger-zone flash glyphs, keyed by ref, fading over FLASH_MS */
  private zoneFlashes = new Map<string, { line: LineSegments2; t0: number; enter: boolean }>();
  private widget!: TransformControls;
  private widgetProxy = new THREE.Object3D();
  private widgetBase: { refs: ObjRef[]; transforms: ObjTransform[]; proxy: ObjTransform } | null = null;
  private canvasSurfaces: THREE.Object3D[] = [];
  private polyPen = new PolyPenTool('polypen', 'QUILT');
  private polyBuild = new PolyPenTool('polybuild', 'BUILD');
  private quadPatch = new PolyPenTool('quadpatch', 'PATCH');
  private meshEdit = new MeshEditTool();
  private objectPick = new ObjectSelectTool('object-select', 'BOX');
  private objectPickLasso = new ObjectSelectTool('object-select-lasso', 'LASSO');
  private objectPickCircle = new ObjectSelectTool('object-select-circle', 'CIRCLE');
  private scoreGroup = new THREE.Group(); // cursor + trigger + attractor glyphs
  private scoreGlyphKey = '';
  /** Blender-style 2x2 Quad View (Ctrl+Alt+Q): view-layout state, not a
   *  scene/Settings field — matches `presentation`'s precedent. */
  private quadView = false;
  private orthoPanes: OrthoPane[] = [];
  private paneRects: Record<PaneId, PaneRect> | null = null;

  constructor() {
    const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
    this.hud = document.getElementById('hud') as HTMLCanvasElement;
    this.glRenderer = new THREE.WebGLRenderer({
      canvas: glCanvas, antialias: true, stencil: true, preserveDrawingBuffer: true,
    });
    this.glRenderer.setPixelRatio(window.devicePixelRatio);
    // shadow maps are only rendered for lights that opt in (castShadow is
    // off by default), so this costs nothing until a light asks for it
    this.glRenderer.shadowMap.enabled = true;
    this.glRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
    this.camera.position.set(0, 0.6, 6);

    this.controls = new OrbitControls(this.camera, glCanvas);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = {
      LEFT: undefined as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.nav = new Navigation(this.camera, this.controls, glCanvas);
    // Possession rides on fly mode, so it ends whenever fly mode does —
    // including the Esc path, which pointer lock swallows and nav detects
    // through pointerlockchange rather than a keydown.
    this.nav.onFlyChange = (flying) => { if (!flying) this.endPossess(); };
    this.nav.onNotice = (text) => this.setStatusHint(text, 2500);

    const settings = defaultSettings();
    loadPrefs(settings);
    const history = new History();
    const scene = createScene();
    const self = this;
    this.ctx = {
      scene, history, settings,
      camera: this.camera,
      gp: this.gp,
      gl: this.glRenderer,
      scene3: this.scene3,
      canvas: glCanvas,
      surfaces: [],
      canvasMeshes: [],
      pickableMeshes: [],
      polyPick: {
        faceMeshes: () => this.polys.pickTargets(self.ctx.scene),
        faceIdAt: (polyId, tri) => this.polys.faceIdAt(polyId, tri),
      },
      actorRoots: (sel) => this.actors.exportRoots(this.ctx.scene, sel),
      syncCanvases: () => this.syncCanvases(),
      copyBuffer: [],
      requestRender: (layerId?: number) => {
        this.gp.markDirty(layerId);
        this.score.invalidate();
      },
      pushUndo: () => history.push(self.ctx.scene),
      replaceScene: (s: GPScene) => {
        const prevWs = self.ctx.scene.io?.wsUrl;
        self.ctx.scene = s;
        this.gp.markDirty();
        this.syncCanvases();
        if (s.io.wsUrl !== prevWs) {
          s.io.wsUrl ? wsLink.connect(s.io.wsUrl) : wsLink.disconnect();
        }
        this.ui?.refresh();
      },
      refreshUI: () => this.ui?.refresh(),
      highlightObject: (ref, color) => {
        // meshes are the only kind with a silhouette to draw so far; a null
        // ref (or any other kind) simply clears it
        this.meshes.setHover(ref && ref.kind === 'MESH' ? ref.id : null, color);
      },
      setStatus: (t: string, ms?: number) => this.setStatusHint(t, ms),
    };

    // scene dressing
    // first frame only; WorldManager owns it from then on
    this.scene3.background = srgbColor(scene.world.color);
    this.grid = this.makeGrid();
    this.grid.position.y = -2;
    this.scene3.add(this.grid);
    this.applyThemeColors();
    this.camHelper = new THREE.Group();
    markOverlay(this.camHelper);
    this.scene3.add(this.camHelper);
    this.scene3.add(this.gp.root);
    this.cursorMarker = this.makeCursorMarker();
    markOverlay(this.cursorMarker);
    this.scene3.add(this.cursorMarker);
    this.planeHelper = this.makePlaneHelper();
    markOverlay(this.planeHelper);
    this.scene3.add(this.planeHelper);
    this.depthHelper = this.makeDepthHelper();
    markOverlay(this.depthHelper);
    this.scene3.add(this.depthHelper);
    // selection outlines and origin dots are editor furniture: the scene
    // look must not ink them, and the dot in particular is a point sprite
    markOverlay(this.selGlyphs);
    this.scene3.add(this.selGlyphs);
    // a ground plane for SURFACE placement demos
    this.scene3.add(this.canvasGroup);
    this.scene3.add(this.scoreGroup);
    this.splats.init(this.glRenderer);
    // the splat engine is imported lazily (see splats/index.ts); it resolves
    // between frames, so nothing else would mark the scene dirty afterwards
    this.splats.onLoaded = () => this.ctx.requestRender();
    setSplatPickSource(this.splats);
    setTexPaintMeshManager(this.meshes);
    setTexPaintPolyManager(this.polys);
    // stencil masking: the live camera frame, and ObjRef -> three.js root
    // (App owns the managers that know that mapping)
    setStencilVideoSource(() => mmCapture.sourceEl ?? null);
    setStencilObjectResolver((refs) => refs
      .map((r) => (r.kind === 'POLY' ? this.polys.rootFor(r.id)
        : r.kind === 'MESH' ? this.meshes.rootFor(r.id)
        : r.kind === 'GP' ? this.gp.objectGroups[gpIndexOf(this.ctx.scene, r.id)] ?? null
        : null))
      .filter((o): o is THREE.Object3D => !!o));
    this.scene3.add(this.splats.group);
    this.scene3.add(this.meshes.group);
    this.scene3.add(this.polys.group);
    this.scene3.add(this.paints.group);
    this.scene3.add(this.mmPoints.group);
    mmCapture.onStatus = () => this.ui?.refresh();
    liveSources.onChange(() => this.ui?.refresh());
    // mesh objects use MeshStandardMaterial — GP shaders ignore lights.
    // Lights are scene data now (scene.lights, migrated from the two that
    // used to be hardcoded here); LightManager mirrors them each frame.
    this.scene3.add(this.lights.group);
    this.scene3.add(this.actors.group);

    // object-mode transform widget
    this.scene3.add(this.widgetProxy);
    this.widget = new TransformControls(this.camera, glCanvas);
    this.widget.setSize(0.8);
    const widgetHelper = this.widget.getHelper();
    // editor furniture, not the world: the scene look's edge prepass must
    // not ink it, and the gizmo hides a 90,000-unit invisible drag plane
    // whose only possible contribution to a line drawing is a wrong one
    markOverlay(widgetHelper);
    this.scene3.add(widgetHelper);
    this.widget.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
      if ((e as unknown as { value: boolean }).value) this.beginWidgetDrag();
      else this.widgetBase = null;
    });
    this.widget.addEventListener('objectChange', () => this.applyWidgetDrag());
    this.widget.enabled = false;
    this.objectPick.onSelectionChange = () => this.refreshWidget();
    // lasso/circle object-select variants share the box variant's
    // lastPicked (Ctrl+P target, "active" selection-outline highlight)
    // so switching select tools mid-workflow doesn't lose the active object
    this.objectPickLasso.onSelectionChange = () => {
      this.objectPick.lastPicked = this.objectPickLasso.lastPicked;
      this.refreshWidget();
    };
    this.objectPickCircle.onSelectionChange = () => {
      this.objectPick.lastPicked = this.objectPickCircle.lastPicked;
      this.refreshWidget();
    };
    this.objModal.onDelta = (deltaM) =>
      this.applyWorldDelta(this.objModal.refs, this.objModal.base, deltaM);
    this.axes = this.makeAxes();
    this.scene3.add(this.axes);
    this.applyUpAxis(true);
    this.axes.visible = settings.showAxes;
    this.orthoPanes = createOrthoPanes(
      this.nav.upAxis, this.camera.position.distanceTo(this.controls.target),
    );

    this.fx = new EffectsPipeline(2, 2);

    // tools
    for (const t of [
      new DrawTool(), new EraseTool(), new SmoothTool(), new FillTool(), new TintTool(), new CutterTool(),
      new EyedropperTool(), new PrimitiveTool('line'), new PrimitiveTool('polyline'),
      new PrimitiveTool('arc'), new PrimitiveTool('curve'), new PrimitiveTool('box'),
      new PrimitiveTool('circle'), this.interpTool,
      new SelectTool('select', 'BOX'), new SelectTool('select-lasso', 'LASSO'),
      new SelectTool('select-circle', 'CIRCLE'), new SculptTool(),
      new VertexPaintTool(), new WeightPaintTool(),
      this.objectPick, this.objectPickLasso, this.objectPickCircle,
      this.polyPen, this.polyBuild, this.quadPatch, this.meshEdit, new SplatPaintTool(), new TexturePaintTool(),
      new ActorPoseTool(), new MeasureTool(), new DirectTool(),
    ]) this.tools.register(t);
    this.tools.setActive(this.ctx, 'draw');
    this.meshEdit.beginTransform = (kind, undo) => this.withPane(this.pointerPane, () => this.beginMeshTransform(kind, undo));

    this.ui = new UI(this);
    // the library lives in IndexedDB, which only answers asynchronously —
    // panels list it from memory and redraw when it arrives or changes
    onAssetsChanged(() => this.ui.refresh());
    void initAssets();
    this.buildCommands();
    const tg = this as unknown as Record<string, unknown>;
    tg.execute = (q: string, args?: string) => this.commands.execute(q, args);
    (window as unknown as Record<string, unknown>).__tg = this; // debug/scripting handle; __tg.execute() = agent API

    // agent interface: tools reach the command palette through this, and the
    // RPC link stays idle until the user points it at a relay (Agent panel).
    setAgentCommandLister(() => this.commands.all().map((c) => ({ id: c.id, title: c.title })));
    this.agentRpc = new AgentRpc(this.agentHost());
    this.agent = new AgentPanel(this.agentHost(), this.agentRpc);
    // WebMCP: the browser's own agent reaches the same registry. Bound here
    // (not auto-enabled) — registering tools is something the user opts into
    // per session, the way the relay link is.
    webMcp.bind(this.agentHost());

    // environment: one equirect source drives background + IBL. The live
    // capture element is injected rather than imported so render/world.ts
    // stays independent of the capture stack.
    this.world = new WorldManager(this.glRenderer);
    this.world.liveSource = () => mmCapture.sourceEl ?? null;
    this.world.onChange = () => this.ui.refresh();

    // event IO (P2): MIDI is async and optional; WS connects if configured
    midi.init().then((ok) => {
      if (ok) {
        if (scene.io.midiInId) midi.setInput(scene.io.midiInId);
        if (scene.io.midiOutId) midi.setOutput(scene.io.midiOutId);
        this.ui.refresh();
      }
    });
    wsLink.onStatus = () => this.ui?.refresh();
    if (scene.io.wsUrl) wsLink.connect(scene.io.wsUrl);
    routes.init(this.ctx);
    routes.onLearned = () => this.ui?.refresh();
    this.bindEvents(glCanvas);
    this.bindSidebarResize();
    this.resize();
    perf.attach(this.glRenderer);
    perf.enabled = !!this.ctx.settings.showPerf;
    this.perfOverlay = new PerfOverlay(document.getElementById('viewport')!);
    requestAnimationFrame(() => this.loop());
  }

  /** Drag #sidebar-resize to resize the properties sidebar; width persists. */
  private bindSidebarResize(): void {
    const handle = document.getElementById('sidebar-resize');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;
    const MIN = 200, MAX = 640;
    const saved = Number(localStorage.getItem('threegrease.sidebarWidth'));
    if (saved) sidebar.style.width = `${Math.min(MAX, Math.max(MIN, saved))}px`;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      const onMove = (me: PointerEvent) => {
        const w = Math.min(MAX, Math.max(MIN, startW - (me.clientX - startX)));
        sidebar.style.width = `${w}px`;
        this.resize();
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        localStorage.setItem('threegrease.sidebarWidth', String(sidebar.getBoundingClientRect().width));
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // ---------------------------------------------------------- AppHandle

  /** [previous, current] — Tab toggles back to `modeHistory[0]`. */
  private modeHistory: EditorMode[] = ['DRAW', 'EDIT'];

  setMode(mode: EditorMode): void {
    // "Edit mode" edits whatever object is active — with a mesh as the
    // selection, EDIT opens the vertex / edge / face editor on it (a
    // primitive is converted to an editable mesh first, as Blender's are
    // just meshes); GP objects keep the GP point editor.
    const meshTarget = mode === 'EDIT' ? this.editableMeshTarget() : null;
    const enterPolyPen = meshTarget !== null;
    this.meshEditId = meshTarget;
    if (mode !== this.ctx.settings.mode) this.modeHistory = [this.ctx.settings.mode, mode];
    // OBJECT mode (and the outliner) tolerate zero GP objects — every
    // other mode edits the active one, so create a blank on entry rather
    // than force one to always exist (lets "delete the last GP object"
    // actually empty the scene while staying in Object mode).
    if (mode !== 'OBJECT' && this.ctx.scene.objects.length === 0) {
      this.ctx.scene.objects.push(this.newPencil('Pencil1'));
      this.ctx.scene.activeObject = 0;
    }
    this.ctx.settings.mode = mode;
    this.setTool(enterPolyPen ? 'meshedit' : DEFAULT_TOOL[mode]);
    this.gp.markDirty();
    this.refreshWidget();
    this.ui.refresh();
  }

  /** The mesh Edit mode is open on (null = the stroke editor). Kept apart
   *  from the overlay's target, which follows the TOOL: picking Measure
   *  mid-edit must not drop you back into the stroke editor's toolbar. */
  private meshEditId: number | null = null;

  /**
   * The mesh Edit mode should open on, or null for the stroke editor: the
   * picked or selected editable mesh, or a selected PRIMITIVE — which is
   * converted to an editable mesh here, in place (same name, transform,
   * material, parent; everything that pointed at it re-pointed). One undo
   * step takes it back to the primitive.
   */
  private editableMeshTarget(): number | null {
    const scene = this.ctx.scene;
    const picked = this.objectPick.lastPicked;
    const gpSelected = scene.objects.some((o) => o.select);
    if (picked?.kind === 'POLY' && scene.polyMeshes.some((p) => p.id === picked.id && p.select)) return picked.id;
    const prim = (picked?.kind === 'MESH' ? scene.meshes.find((m) => m.id === picked.id && m.select) : undefined)
      ?? (gpSelected ? undefined : scene.meshes.find((m) => m.select && isConvertiblePrimitive(m)));
    if (prim && isConvertiblePrimitive(prim)) return this.convertToEditable(prim.id);
    if (!gpSelected) {
      const pm = scene.polyMeshes.find((p) => p.select);
      if (pm) return pm.id;
    }
    return null;
  }

  private convertToEditable(meshId: number): number | null {
    const scene = this.ctx.scene;
    const m = scene.meshes.find((x) => x.id === meshId);
    if (!m) return null;
    this.ctx.pushUndo();
    let id = Date.now() % 1e9;
    while (scene.polyMeshes.some((p) => p.id === id)) id++;
    const pm = primitiveToPoly(m, id);
    pm.select = true;
    scene.meshes = scene.meshes.filter((x) => x !== m);
    scene.polyMeshes.push(pm);
    // re-point every reference to it (parents, constraint targets, routes,
    // score attachments): anything shaped { kind: 'MESH', id } with its id
    const walk = (o: unknown): void => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      const r = o as Record<string, unknown>;
      if (r.kind === 'MESH' && r.id === meshId && Object.keys(r).length <= 3) { r.kind = 'POLY'; r.id = id; return; }
      for (const k in r) walk(r[k]);
    };
    walk(scene);
    this.setLastPicked({ kind: 'POLY', id });
    this.setStatusHint(`${m.name} is an editable mesh now`, 2500);
    return id;
  }

  /** G / R / S on the edit mesh's selected vertices. */
  private beginMeshTransform(kind: 'move' | 'rotate' | 'scale', undo = true): boolean {
    const pm = this.meshEdit.editMesh(this.ctx);
    if (!pm) return false;
    const sel = pm.vertices.filter((v) => v.select);
    const others = pm.vertices.filter((v) => !v.select);
    const matrix = worldMatrixOf(this.ctx.scene, { kind: 'POLY', id: pm.id });
    return this.modal.beginMesh(this.ctx, kind, this.tools.lastPointer, sel, others, matrix,
      () => touchPolyMesh(pm), undo);
  }

  /** Switching vertex / edge / face keeps the selection, re-derived from
   *  the new mode's point of view (Blender does the same). */
  setMeshSelectMode(mode: 'VERTEX' | 'EDGE' | 'FACE'): void {
    this.ctx.settings.meshSelectMode = mode;
    const pm = this.meshEdit.editMesh(this.ctx);
    // derive edges/faces from the vertices, then the new mode's elements
    // are the truth (an edge survives into face mode only inside a face)
    if (pm) { flushSelection(pm, 'VERTEX'); flushSelection(pm, mode); }
    this.ctx.requestRender();
  }

  /** Separate on strokes: the selection, one object per material, or one
   *  per connected piece. Returns how many objects were made. */
  gpSeparate(how: 'SELECTION' | 'MATERIAL' | 'LOOSE'): number {
    const ctx = this.ctx;
    let n = 0;
    if (how === 'SELECTION') n = ops.separateSelected(ctx) > 0 ? 1 : 0;
    else if (how === 'MATERIAL') n = ops.separateByMaterial(ctx);
    else {
      const ob = ctx.scene.objects[ctx.scene.activeObject];
      if (ob) { ctx.pushUndo(); n = separateConnectedIntoObjects(ctx.scene, { kind: 'GP', id: ob.id }); }
    }
    this.setStatusHint(n ? `separated into ${n} new object${n === 1 ? '' : 's'}` : 'nothing to separate', 2500);
    this.gp.markDirty();
    this.ui.refresh();
    return n;
  }

  /** Mesh edit-mode operations, for the right-click menu (the keys do the
   *  same through the tool). */
  meshOp(op: 'extrude' | 'fill' | 'delete' | 'selectAll' | 'selectNone' | 'separateSelection' | 'separateLoose'): void {
    const ctx = this.ctx;
    const pm = this.meshEdit.editMesh(ctx);
    if (!pm) return;
    const mode = ctx.settings.meshSelectMode;
    ctx.pushUndo();
    if (op === 'extrude') { if (extrudeSelection(pm, mode)) this.withPane(this.pointerPane, () => this.beginMeshTransform('move', false)); }
    else if (op === 'fill') { fillSelection(pm); flushSelection(pm, 'VERTEX'); }
    else if (op === 'delete') deleteSelection(pm, mode);
    else if (op === 'selectAll' || op === 'selectNone') selectAllElems(pm, op === 'selectAll', mode);
    else {
      const made = separatePoly(pm, op === 'separateLoose' ? 'LOOSE' : 'SELECTION', () => {
        let id = Date.now() % 1e9;
        while (ctx.scene.polyMeshes.some((p) => p.id === id)) id++;
        return id;
      });
      const at = ctx.scene.polyMeshes.indexOf(pm);
      ctx.scene.polyMeshes.splice(at + 1, 0, ...made);
      this.setStatusHint(made.length ? `separated into ${made.length} new mesh${made.length === 1 ? '' : 'es'}` : 'nothing to separate', 2500);
    }
    touchPolyMesh(pm);
    ctx.requestRender();
    this.ui.refresh();
  }

  /** Edit mode is on a mesh (the vertex / edge / face editor or a poly tool). */
  meshEditing(): boolean {
    return this.ctx.settings.mode === 'EDIT' && this.meshEditId !== null
      && this.ctx.scene.polyMeshes.some((p) => p.id === this.meshEditId);
  }

  /** Tab: swap back to whichever mode you were in before the current one. */
  toggleLastMode(): void {
    const prev = this.modeHistory[0];
    if (prev && prev !== this.ctx.settings.mode) this.setMode(prev);
  }

  setTool(id: string): void {
    this.tools.setActive(this.ctx, id);
    const tool = this.tools.get(id);
    this.ctx.canvas.style.cursor = tool?.cursor ?? 'default';
    // quilt overlays live and die with the quilt tools (no standalone
    // mode): activating one targets the picked/selected/first editable
    // mesh; leaving them hides the topology overlays
    if (MESH_TOOLS.has(id)) {
      const scene = this.ctx.scene;
      const picked = this.objectPick.lastPicked;
      const target = (this.meshEditId !== null ? scene.polyMeshes.find((p) => p.id === this.meshEditId) : undefined)
        ?? (picked?.kind === 'POLY' ? scene.polyMeshes.find((p) => p.id === picked.id) : undefined)
        ?? scene.polyMeshes.find((p) => p.select)
        ?? scene.polyMeshes[0];
      polyOverlay.editMeshId = target?.id ?? null; // else first click creates one
    } else {
      clearPolyOverlay();
      polyOverlay.editMeshId = null;
    }
    this.ui.refresh();
  }

  playToggle(): void { this.player.toggle(); this.gp.markDirty(); }
  isPlaying(): boolean { return this.player.playing; }

  undo(): void {
    const s = this.ctx.history.undo(this.ctx.scene);
    if (s) this.ctx.replaceScene(s);
  }
  redo(): void {
    const s = this.ctx.history.redo(this.ctx.scene);
    if (s) this.ctx.replaceScene(s);
  }

  saveScene(): void { downloadScene(this.ctx.scene); }
  async loadScene(): Promise<void> {
    try {
      const s = await openSceneFile();
      this.ctx.pushUndo();
      this.ctx.replaceScene(s);
    } catch { /* cancelled */ }
  }

  /**
   * The narrow App surface the agent tools are allowed to use. Deliberately
   * a separate object rather than passing `this`: it makes the blast radius
   * of a tool explicit and keeps tools/ from reaching into UI internals.
   */
  agentHost(): AgentHost {
    return {
      ctx: this.ctx,
      execute: (q, args) => this.commands.execute(q, args),
      setMode: (m) => this.setMode(m),
      setShading: (m) => this.setShading(m),
      addActor: (at) => this.addActor(at),
      resetActor: (id) => this.resetActor(id),
      setTool: (id) => this.setTool(id),
      snapView: (v) => this.snapView(v),
      addMeshObject: (kind, src, at) => this.addMeshObject(kind, src, at),
      addGPObject: () => this.addGPObject(),
      addLight: (kind, at) => this.addLight(kind, at),
      screenshot: () => this.screenshotBase64(),
      viewAll: () => this.viewAll(),
      refreshWidget: () => this.refreshWidget(),
    };
  }

  /** RenderState for GPSceneRenderer.update — shared by the frame loop and
   *  the agent screenshot so the two can't drift apart. */
  private renderState(): RenderState {
    const ctx = this.ctx;
    return {
      mode: this.presentation ? 'DRAW' : ctx.settings.mode,
      // what the viewport actually shows behind the strokes, which is what a
      // HOLDOUT material paints. It is the WORLD's colour, not a view pref —
      // those were two names for one thing and could drift apart.
      background: ctx.scene.world.color,
      playing: this.player.playing || this.presentation, // also hides onion in presentation
      selectMode: ctx.settings.selectMode,
      castShadows: ctx.settings.gpCastShadows,
    };
  }

  /** Viewport as a base64 PNG (no data: prefix) — the agent's vision channel.
   *
   *  Draws once before reading. preserveDrawingBuffer makes the backbuffer
   *  readable, but a tool that just mutated the scene returns before the next
   *  rAF, so reading without this would hand the model a frame that predates
   *  its own edit. The tradeoff is that this direct draw skips the per-object
   *  screen-space FX pass (which the rAF loop composites separately), so an
   *  object with effects enabled appears unaffected in the capture. */
  screenshotBase64(): string {
    this.gp.update(this.ctx.scene, this.renderState());
    this.glRenderer.render(this.scene3, this.nav.active);
    return this.ctx.canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  }

  exportPng(): void {
    this.ctx.canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'threegrease.png';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  addKeyframe(duplicate: boolean): void {
    if (!this.ctx.scene.objects.length) return;
    const ob = activeObject(this.ctx.scene);
    const layer = activeLayer(ob);
    if (!layer || layer.lock) return;
    this.ctx.pushUndo();
    const frame = this.ctx.scene.frame;
    const existing = layer.frames.findIndex((f) => f.frameNumber === frame);
    const current = frameAt(layer, frame);
    const nf = duplicate && current ? cloneFrame(current) : createFrame(frame);
    nf.frameNumber = frame;
    if (existing >= 0) layer.frames.splice(existing, 1);
    layer.frames.push(nf);
    layer.frames.sort((a, b) => a.frameNumber - b.frameNumber);
    this.gp.markDirty();
    this.ui.refresh();
  }

  removeKeyframe(): void {
    if (!this.ctx.scene.objects.length) return;
    const ob = activeObject(this.ctx.scene);
    const layer = activeLayer(ob);
    if (!layer || layer.lock) return;
    const idx = keyframeIndexAt(layer, this.ctx.scene.frame);
    if (idx < 0) return;
    this.ctx.pushUndo();
    layer.frames.splice(idx, 1);
    this.gp.markDirty();
    this.ui.refresh();
  }

  /** Place the 3D cursor. Snapping follows the global magnet (Blender
   *  semantics): magnet off = free move on the drawing plane; magnet on =
   *  snap per its mode (grid / stroke point / object origin / surface). */
  /** Move the 3D cursor to a pointer position, through the shared magnet.
   *  The snapping itself lives in tools/snapping.ts so the measure and
   *  blockout tools get identical behaviour from the same settings. */
  private placeCursor(clientX: number, clientY: number): void {
    const ctx = this.ctx;
    // the cursor's CURRENT position is the reference the relative modes
    // (perpendicular, nearest-on-face) measure from
    const hit = snapWorldPoint(ctx, clientX, clientY, new THREE.Vector3(...ctx.scene.cursor));
    if (!hit) return;
    ctx.scene.cursor = [hit.point.x, hit.point.y, hit.point.z];
    this.gp.markDirty();
  }

  /** Add a canvas plane at the 3D cursor, oriented to the current drawing plane. */
  addCanvasPlane(): void {
    const ctx = this.ctx;
    ctx.pushUndo();
    const s = ctx.settings;
    const zUp = s.upAxis === 'Z';
    let rotation: [number, number, number];
    if (s.plane === 'FRONT') rotation = zUp ? [-Math.PI / 2, 0, 0] : [0, 0, 0];
    else if (s.plane === 'SIDE') rotation = [0, Math.PI / 2, 0];
    else if (s.plane === 'TOP') rotation = zUp ? [0, 0, 0] : [-Math.PI / 2, 0, 0];
    else {
      // VIEW: face the camera
      const e = new THREE.Euler().setFromQuaternion(this.nav.active.quaternion, 'XYZ');
      rotation = [e.x, e.y, e.z];
    }
    ctx.scene.canvases.push({
      id: Date.now() % 1e9,
      name: `Canvas ${ctx.scene.canvases.length + 1}`,
      translation: [...ctx.scene.cursor] as [number, number, number],
      rotation,
      size: [3, 3],
      visible: true,
      select: false,
      drawTarget: true,
    });
    this.syncCanvases();
    this.ui.refresh();
  }

  removeCanvasPlane(id: number): void {
    this.ctx.pushUndo();
    this.ctx.scene.canvases = this.ctx.scene.canvases.filter((c) => c.id !== id);
    this.syncCanvases();
    this.ui.refresh();
  }

  /** Rebuild canvas plane meshes + SURFACE raycast targets from scene data. */
  syncCanvases(): void {
    for (const child of [...this.canvasGroup.children]) {
      this.canvasGroup.remove(child);
      (child as THREE.Mesh).geometry?.dispose?.();
      ((child as THREE.Mesh).material as THREE.Material)?.dispose?.();
    }
    this.canvasSurfaces = [];
    this.ctx.canvasMeshes = [];
    for (const c of this.ctx.scene.canvases) {
      if (!c.visible) continue;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(c.size[0], c.size[1]),
        new THREE.MeshBasicMaterial({
          color: c.select ? 0xd8a03c : 0x8899bb, transparent: true, opacity: c.select ? 0.1 : 0.07,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      worldMatrixOf(this.ctx.scene, { kind: 'CANVAS', id: c.id })
        .decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.scale.set(1, 1, 1); // canvas size lives in the geometry
      mesh.renderOrder = -1;
      mesh.userData.canvasId = c.id;
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-c.size[0] / 2, -c.size[1] / 2, 0),
          new THREE.Vector3(c.size[0] / 2, -c.size[1] / 2, 0),
          new THREE.Vector3(c.size[0] / 2, c.size[1] / 2, 0),
          new THREE.Vector3(-c.size[0] / 2, c.size[1] / 2, 0),
        ]),
        new THREE.LineBasicMaterial({
          color: c.select ? 0xff9a3b : c.drawTarget ? 0x55688f : 0x6a5a3a,
          transparent: true, opacity: c.select ? 1 : 0.6,
        }),
      );
      border.raycast = () => {}; // border must never catch surface-placement rays
      mesh.add(border);
      this.canvasGroup.add(mesh);
      this.ctx.canvasMeshes.push(mesh);
      if (c.drawTarget) this.canvasSurfaces.push(mesh); // reference planes are not draw targets
    }
    this.ctx.surfaces = [
      ...this.canvasSurfaces,
      ...this.meshes.drawTargets(this.ctx.scene),
      ...this.actors.drawTargets(this.ctx.scene),
    ];
  }

  snapView(view: 'FRONT' | 'BACK' | 'RIGHT' | 'LEFT' | 'TOP' | 'BOTTOM'): void { this.nav.snapView(view); }

  jumpKey(dir: 1 | -1): void {
    if (!this.ctx.scene.objects.length) return;
    const ob = activeObject(this.ctx.scene);
    const frames = new Set<number>();
    for (const l of ob.layers) for (const f of l.frames) frames.add(f.frameNumber);
    const sorted = [...frames].sort((a, b) => a - b);
    const cur = this.ctx.scene.frame;
    const next = dir > 0 ? sorted.find((f) => f > cur) : [...sorted].reverse().find((f) => f < cur);
    if (next !== undefined) {
      this.ctx.scene.frame = next;
      this.gp.markDirty();
      this.ui.refresh();
    }
  }

  // ------------------------------------------------------------- events

  /** setPointerCapture throws for unknown pointer ids (synthetic events) — never fatal. */
  private capture(e: PointerEvent): void {
    try { this.ctx.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  }

  /** The quad-view pane a pointer gesture started in; it keeps the gesture
   *  until release, so a stroke that wanders over a pane border does not
   *  jump into another camera halfway. */
  private inputPane: PaneId | null = null;
  /** the pane the LAST pointer event was routed through. `tools.lastPointer`
   *  is relative to that pane, so anything that reads it back (the plane and
   *  depth helpers, the placement preview, a tool's HUD) must read it
   *  through the same pane or it lands where the pointer would be in the
   *  full-size view */
  private pointerPane: PaneId | null = null;
  /** the pane the pointer is over right now (null once it leaves the
   *  viewport) — what leaving quad view keeps */
  private hoverPane: PaneId | null = null;

  /** Which quad-view pane a client point is over (null outside quad view). */
  private paneAt(clientX: number, clientY: number): PaneId | null {
    if (!this.quadView || !this.paneRects) return null;
    const r = this.glRenderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    for (const id of ['persp', 'front', 'side', 'top'] as PaneId[]) {
      const p = this.paneRects[id];
      if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return id;
    }
    return null;
  }

  /**
   * Run `fn` as if the viewport WERE one quad-view pane.
   *
   * Every tool measures the pointer against `ctx.canvas`'s bounding rect and
   * unprojects it through `ctx.camera` — 61 places. In quad view both were
   * the WHOLE canvas and the perspective camera whichever pane you touched,
   * so a stroke drawn in the top-left pane landed where the pointer would be
   * if the perspective view filled the window: the cursor here, the mark
   * over there. Rather than teach 61 call sites about panes, this swaps the
   * two things they read, for the duration of one event: the camera becomes
   * the pane's own (perspective, front, side or top), and the canvas reports
   * the pane's rectangle as its bounds (a proxy that forwards everything
   * else to the real element). Outside quad view it simply calls `fn`.
   */
  private withPane<T>(pane: PaneId | null, fn: () => T): T {
    if (!pane || !this.quadView || !this.paneRects) return fn();
    const ctx = this.ctx;
    const real = ctx.canvas;
    const cr = real.getBoundingClientRect();
    const pr = this.paneRects[pane];
    const rect = new DOMRect(cr.left + pr.x, cr.top + pr.y, pr.w, pr.h);
    const proxy = new Proxy(real, {
      get: (t, prop) => {
        if (prop === 'getBoundingClientRect') return () => rect;
        const v = Reflect.get(t, prop, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set: (t, prop, v) => Reflect.set(t, prop, v, t),
    });
    const cam = pane === 'persp' ? this.nav.active : this.orthoPanes.find((p) => p.id === pane)?.camera;
    // an ortho pane's camera is otherwise only brought up to date by the
    // quad render, so a click before its first frame unprojected through an
    // identity matrix and put the point at infinity
    cam?.updateMatrixWorld();
    const savedCam = ctx.camera;
    ctx.canvas = proxy;
    if (cam) ctx.camera = cam;
    try { return fn(); } finally {
      ctx.canvas = real;
      ctx.camera = savedCam;
    }
  }

  /** a pointer went down in the outliner and nowhere else since: keys then
   *  act on its object selection (see onKey) */
  private outlinerFocused = false;

  private deleteSelectedObjects(): void {
    const ctx = this.ctx;
    const refs = listSelected(ctx.scene);
    if (!refs.length) return;
    ctx.pushUndo();
    for (const ref of refs) deleteObject(ctx.scene, ref);
    // every mode but Object edits the active pencil, so one must remain
    if (ctx.settings.mode !== 'OBJECT' && !ctx.scene.objects.length) {
      ctx.scene.objects.push(this.newPencil('Pencil1'));
      ctx.scene.activeObject = 0;
    }
    this.syncCanvases();
    this.gp.markDirty();
    this.refreshWidget();
    this.ui.refresh();
  }

  /** `tools.lastPointer` back in whole-canvas px (it is pane-relative in
   *  quad view), for things placed in the page rather than in a view */
  private canvasPointer(): { x: number; y: number } {
    const p = this.tools.lastPointer;
    const r = this.pointerPane && this.quadView && this.paneRects ? this.paneRects[this.pointerPane] : null;
    return r ? { x: p.x + r.x, y: p.y + r.y } : p;
  }

  private toolEvent(e: PointerEvent): ToolEvent {
    const rect = this.ctx.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left, y: e.clientY - rect.top,
      // A device with NO pressure sensor reports exactly 0.5 while the
      // button is down (Pointer Events spec) — that is "no data", not "half
      // pressure". Passing it through made every mouse stroke draw at half
      // width AND half opacity with Strength at 1.0, which is why opaque
      // strokes looked translucent and piled up visibly where they crossed.
      // Only a pen carries real pressure; everything else means "full".
      pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 1,
      shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
      clientX: e.clientX, clientY: e.clientY,
    };
  }

  private bindEvents(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // DROP: files from the desktop, or a tile dragged out of the Library.
    // On the whole viewport, not the GL canvas — the HUD canvas and the
    // status line sit on top of it and would swallow the drop.
    const vp = document.getElementById('viewport')!;
    vp.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      const t = e.dataTransfer.types;
      if (t.includes('Files') || t.includes(ASSET_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    vp.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      const assetId = e.dataTransfer.getData(ASSET_MIME);
      if (assetId) {
        const asset = listAssets().find((a) => String(a.id) === assetId);
        if (asset) this.addAssetToScene(asset, this.dropTarget(e.clientX, e.clientY));
        return;
      }
      const files = [...e.dataTransfer.files];
      if (files.length) void this.importFiles(files, this.dropTarget(e.clientX, e.clientY));
    });

    // Shift+RMB = drag the 3D cursor. MUST run in the capture phase:
    // OrbitControls registered its own pointerdown first (RIGHT = PAN),
    // so a bubble-phase listener can't stop the camera from panning
    // underneath the cursor drag.
    canvas.addEventListener('pointerdown', (e) => {
      // G/R/S modal owns ALL buttons while active: LMB confirms, RMB/others
      // cancel. Capture phase so OrbitControls (registered first) never pans.
      if (this.objModal.active) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (e.button === 0) this.objModal.confirm(this.ctx);
        else this.objModal.cancel(this.ctx);
        this.refreshWidget();
        this.ui.refresh();
        return;
      }
      if (e.button !== 2 || !e.shiftKey || this.nav.flying) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      this.cursorDrag = true;
      this.pointerPane = this.paneAt(e.clientX, e.clientY);
      this.withPane(this.pointerPane, () => this.placeCursor(e.clientX, e.clientY));
      this.capture(e);
    }, { capture: true });

    canvas.addEventListener('pointerdown', (e) => {
      (this.hud as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer =
        this.withPane(this.paneAt(e.clientX, e.clientY), () => this.toolEvent(e));
      if (this.nav.flying) {
        // possession keeps the mouse for looking around: Enter/Esc exit,
        // a click does not (it is the character's action button)
        if (e.button === 0 && !possession.active) this.nav.stopFly(); // click confirms fly position
        return;
      }
      const te0 = this.toolEvent(e);
      if (e.button === 0 && !this.presentation && !this.navLocked && this.nav.inGizmo(te0.x, te0.y)) {
        // click a ball snaps; dragging the disc orbits like a trackball
        this.gizmoDrag = { x: te0.x, y: te0.y, startX: te0.x, startY: te0.y, dragged: false };
        this.capture(e);
        return;
      }
      if (e.button === 0 && e.altKey && this.ctx.settings.emulate3Button && !this.navLocked) {
        // Blender "Emulate 3 Button Mouse": Alt = orbit, +Shift pan, +Ctrl zoom
        this.navDrag = {
          mode: e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'dolly' : 'orbit',
          x: te0.x, y: te0.y,
        };
        this.capture(e);
        return;
      }
      if (e.button === 2) {
        // plain right-click: track for a context menu on release (a drag
        // means it was a pan, not a click — OrbitControls handles that)
        this.rmbDown = { x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button !== 0) return;
      if (this.objectPicking) {
        const hit = this.withPane(this.paneAt(e.clientX, e.clientY), () => this.objectPick.pick(this.ctx, this.toolEvent(e)));
        const cb = this.objectPicking;
        this.objectPicking = null;
        this.ctx.canvas.style.cursor = 'default';
        cb(hit);
        return;
      }
      if (this.modal.active) { this.modal.confirm(this.ctx); this.ui.refresh(); return; }
      // transform widget owns clicks that land on its gizmo
      if (this.ctx.settings.mode === 'OBJECT' && this.widget.enabled && this.widget.axis) return;
      this.capture(e);
      this.inputPane = this.paneAt(e.clientX, e.clientY);
      this.pointerPane = this.inputPane;
      this.withPane(this.inputPane, () => this.tools.handleDown(this.ctx, this.toolEvent(e)));
    });

    canvas.addEventListener('pointermove', (e) => {
      const te = this.toolEvent(e);
      // brush circles are drawn through the pointer's pane (paneHud), so the
      // position they read must be relative to that pane as well
      (this.hud as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer = this.withPane(
        this.tools.isPointerDown || this.modal.active || this.objModal.active ? this.pointerPane : this.paneAt(e.clientX, e.clientY),
        () => this.toolEvent(e));
      if (this.cursorDrag) {
        this.withPane(this.pointerPane, () => this.placeCursor(e.clientX, e.clientY));
        return;
      }
      if (this.gizmoDrag) {
        const dx = te.x - this.gizmoDrag.x, dy = te.y - this.gizmoDrag.y;
        if (Math.hypot(te.x - this.gizmoDrag.startX, te.y - this.gizmoDrag.startY) > 3) {
          this.gizmoDrag.dragged = true;
        }
        if (this.gizmoDrag.dragged) this.nav.orbitBy(dx * 0.012, dy * 0.012);
        this.gizmoDrag.x = te.x; this.gizmoDrag.y = te.y;
        return;
      }
      if (this.navDrag) {
        const dx = te.x - this.navDrag.x, dy = te.y - this.navDrag.y;
        if (this.navDrag.mode === 'orbit') this.nav.orbitBy(dx * 0.006, dy * 0.006);
        else if (this.navDrag.mode === 'pan') this.nav.panBy(dx, dy);
        else this.nav.dollyBy(Math.exp(dy * 0.005));
        this.navDrag.x = te.x; this.navDrag.y = te.y;
        return;
      }
      if (this.objModal.active) {
        this.withPane(this.pointerPane, () => this.objModal.update(this.ctx, this.toolEvent(e), { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
        return;
      }
      if (this.modal.active) { this.withPane(this.pointerPane, () => this.modal.update(this.ctx, this.toolEvent(e))); return; }
      // coalesced events give smoother strokes
      const coalesced = e.getCoalescedEvents?.();
      const events = coalesced && coalesced.length ? coalesced : [e];
      // a gesture keeps the pane it started in; a hover follows the pointer
      const pane = this.tools.isPointerDown ? this.inputPane : this.paneAt(e.clientX, e.clientY);
      this.pointerPane = pane;
      this.hoverPane = this.paneAt(e.clientX, e.clientY);
      this.withPane(pane, () => {
        for (const ce of events) this.tools.handleMove(this.ctx, this.toolEvent(ce as PointerEvent));
      });
    });

    canvas.addEventListener('pointerleave', () => { this.hoverPane = null; });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 2) {
        if (this.cursorDrag) { this.cursorDrag = false; return; }
        const down = this.rmbDown;
        this.rmbDown = null;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && !this.presentation) {
          if (this.ctx.settings.mode === 'OBJECT') this.ui.openObjectContextMenu(e.clientX, e.clientY);
          else if (this.meshEditing()) this.ui.openMeshOpsContextMenu(e.clientX, e.clientY);
          else if (this.ctx.settings.mode === 'EDIT') this.ui.openStrokeOpsContextMenu(e.clientX, e.clientY);
        }
        return;
      }
      if (e.button !== 0) return;
      if (this.gizmoDrag) {
        if (!this.gizmoDrag.dragged) {
          const ball = this.nav.gizmoBallAt(this.gizmoDrag.startX, this.gizmoDrag.startY);
          if (ball) this.nav.snapView(ball);
        }
        this.gizmoDrag = null;
        return;
      }
      if (this.navDrag) { this.navDrag = null; return; }
      this.withPane(this.inputPane, () => this.tools.handleUp(this.ctx, this.toolEvent(e)));
      this.inputPane = null;
    });

    window.addEventListener('keyup', (e) => { this.nav.handleFlyKey(e, false); });

    canvas.addEventListener('wheel', (e) => {
      if (this.modal.active && this.ctx.settings.propEdit.enabled) {
        this.withPane(this.pointerPane, () => this.modal.adjustRadius(this.ctx, -e.deltaY, this.tools.lastPointer));
        e.preventDefault();
        return;
      }
      if (this.nav.flying) return; // nav's own listener adjusts fly speed
      if (!this.ctx.settings.trackpadNav) return; // classic wheel zoom (OrbitControls)
      // Blender trackpad: two-finger orbit, Shift pan, Ctrl (or pinch) zoom
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.nav.dollyBy(Math.exp(e.deltaY * 0.01));
      else if (e.shiftKey) this.nav.panBy(-e.deltaX, -e.deltaY); // match Alt+Shift-drag direction
      else {
        // Blender orbit direction by default; toggle in settings
        const dir = this.ctx.settings.invertTrackpadOrbit ? 1 : -1;
        this.nav.orbitBy(e.deltaX * 0.005 * dir, e.deltaY * 0.005 * dir);
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.onKey(e));
    // outliner "focus": the rows are plain divs rebuilt on every refresh, so
    // DOM focus cannot say whether you are working in the list — the last
    // pointerdown can
    window.addEventListener('pointerdown', (e) => {
      this.outlinerFocused = !!(e.target as HTMLElement)?.closest?.('.sidebar-outliner');
    }, true);

    // Dropdowns keep keyboard focus after a pick (or after Escape closes
    // the native popup without picking), which silently disables every
    // shortcut until the user clicks back into the viewport — App.onKey
    // bails whenever e.target is a SELECT. Blur it ourselves so the very
    // next keystroke reaches the app again.
    window.addEventListener('change', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'SELECT') (e.target as HTMLElement).blur();
    });
    // ...but re-picking the item that is ALREADY selected fires no `change`
    // at all, so that dropdown kept focus: shortcuts stayed dead and it
    // wore a focus ring its neighbours did not. A native dropdown's popup
    // takes the window's focus while it is open and hands it back when it
    // closes, so the window regaining focus with a SELECT still active is
    // exactly "the popup just closed" — whichever item was picked.
    window.addEventListener('focus', () => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.tagName === 'SELECT') a.blur();
    });

    // General Escape fallback: blur a focused field, else close an open
    // popup menu, else deselect — whichever applies first. Capture phase
    // so it runs before onKey's own INPUT/SELECT bail (below) would
    // otherwise eat the keystroke silently. Dialogs/pies/modals with
    // their own Escape handling (settings, mode pie, G/R/S modal, object
    // picking) run in bubble phase and stopPropagation, so this never
    // fights them — it only fires when nothing more specific claimed it.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const active = document.activeElement as HTMLElement | null;
      // fields with their own keydown handler (e.g. the outliner's
      // inline rename input, which needs Escape to CANCEL rather than
      // commit-on-blur) manage their own Escape — don't blur those out
      // from under them, just let the event continue to their handler.
      if (active && typeof (active as HTMLElement & { onkeydown?: unknown }).onkeydown === 'function') return;
      if (active && (active.tagName === 'SELECT' || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        active.blur();
        return;
      }
      if (document.querySelector('.menu-pop')) { this.ui.closeContextMenu(); return; }
      if (this.ui.settingsOpen || this.objModal.active || this.modal.active || this.nav.flying || this.objectPicking) return;
      if (this.ctx.settings.mode === 'OBJECT') {
        if (listSelected(this.ctx.scene).length) {
          deselectAllObjects(this.ctx.scene);
          this.refreshWidget();
          this.gp.markDirty();
          this.ui.refresh();
        }
      } else if (this.editLike()) {
        selectAll(this.ctx, 'none');
        this.gp.markDirty();
      }
    }, true);
    window.addEventListener('resize', () => this.resize());
    // A window resize is only ONE of the ways the viewport changes size: a
    // panel opening, the sidebar dragging, the timeline growing, or a
    // browser zoom all resize it silently. `setSize(w, h, false)` leaves the
    // canvas ELEMENT at its CSS size while the drawing buffer keeps the old
    // one, so a missed resize does not clip or letterbox — it STRETCHES the
    // render, and the HUD (drawn in buffer px) drifts from the projection
    // (computed from the element's rect) by a factor that grows with the
    // distance from the top-left. The symptom is an overlay that no longer
    // lands on the thing it is marking, while clicking still works, which
    // reads as bad HUD maths rather than as a stale buffer. Observe the
    // element itself and there is nothing left to miss.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(document.getElementById('viewport')!);
    }
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const ctx = this.ctx;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (this.ui.settingsOpen) return; // dialog handles its own keys
    // The OUTLINER has focus: X / Delete / Cmd+Backspace delete the objects
    // selected there, whatever the mode. In Draw or Edit mode X means "delete
    // strokes", which is not what someone who just clicked a row in the
    // object list is asking for.
    if (this.outlinerFocused && !e.repeat
      && ((key === 'x' || key === 'X') && !mod || key === 'Delete' || (key === 'Backspace' && mod))) {
      e.preventDefault();
      this.deleteSelectedObjects();
      return;
    }
    if (this.objectPicking && key === 'Escape') {
      const cb = this.objectPicking;
      this.objectPicking = null;
      this.ctx.canvas.style.cursor = 'default';
      cb(null);
      return;
    }

    // Possession's own keys, ahead of fly mode (which swallows everything
    // it doesn't recognise so stray shortcuts can't fire while driving).
    if (possession.active && !e.repeat) {
      const pk = key.toLowerCase();
      if (pk === 'v') {
        this.setPossessView(possession.view === 'FIRST' ? 'THIRD' : 'FIRST');
        e.preventDefault();
        return;
      }
      if (this.keymap.actionFor(comboFromEvent(e)) === 'possess') {
        this.unpossess();
        e.preventDefault();
        return;
      }
      if (pk === 'r' && possession.actorId != null) {
        this.mmRecordToggle({ kind: 'OBJECT', ref: { kind: 'ACTOR', id: possession.actorId } });
        e.preventDefault();
        return;
      }
    }

    // fly mode swallows its keys (the fly toggle itself is a keymap action)
    if (this.nav.handleFlyKey(e, true)) { e.preventDefault(); return; }
    if (this.keymap.actionFor(comboFromEvent(e)) === 'fly') {
      this.nav.flying ? this.nav.stopFly() : this.nav.startFly();
      e.preventDefault();
      return;
    }

    // object-mode G/R/S modal takes precedence over everything
    if (this.objModal.active) {
      const om = this.objModal;
      if (key === 'Escape') { om.cancel(ctx); this.refreshWidget(); this.ui.refresh(); }
      else if (key === 'Enter') { om.confirm(ctx); this.refreshWidget(); this.ui.refresh(); }
      else if (key === 'g' || key === 'G') om.switchKind(ctx, 'move');
      else if (key === 'r' || key === 'R') om.switchKind(ctx, 'rotate');
      else if (key === 's' || key === 'S') om.switchKind(ctx, 'scale');
      else if (key === 'x' || key === 'X') this.withPane(this.pointerPane, () => om.setAxis(ctx, 'x', e.shiftKey));
      else if (key === 'y' || key === 'Y') this.withPane(this.pointerPane, () => om.setAxis(ctx, 'y', e.shiftKey));
      else if (key === 'z' || key === 'Z') this.withPane(this.pointerPane, () => om.setAxis(ctx, 'z', e.shiftKey));
      else om.handleNumeric(ctx, key);
      e.preventDefault();
      return;
    }

    // numpad view keys — real numpad always, digit row when Emulate Numpad is on
    const isNumpad = e.code.startsWith('Numpad');
    if (isNumpad || ctx.settings.emulateNumpad) {
      const digit = isNumpad ? e.code.slice(6) : key;
      let handled = true;
      switch (digit) {
        case '1': this.nav.snapView(mod ? 'BACK' : 'FRONT'); break;
        case '3': this.nav.snapView(mod ? 'LEFT' : 'RIGHT'); break;
        case '7': this.nav.snapView(mod ? 'BOTTOM' : 'TOP'); break;
        case '9': this.nav.flipView(); break;
        case '5': this.nav.toggleOrtho(); break;
        case '4': this.nav.orbitBy(-Math.PI / 12, 0); break;
        case '6': this.nav.orbitBy(Math.PI / 12, 0); break;
        case '8': this.nav.orbitBy(0, Math.PI / 12); break;
        case '2': this.nav.orbitBy(0, -Math.PI / 12); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); return; }
    }

    // modal transform takes precedence
    if (this.modal.active) {
      if (key === 'Escape') { this.modal.cancel(ctx); }
      else if (key === 'Enter') { this.modal.confirm(ctx); }
      else if (key === 'x' || key === 'X') this.withPane(this.pointerPane, () => this.modal.setAxis('x', ctx, this.tools.lastPointer, e.shiftKey));
      else if (key === 'y' || key === 'Y') this.withPane(this.pointerPane, () => this.modal.setAxis('y', ctx, this.tools.lastPointer, e.shiftKey));
      else if (key === 'z' || key === 'Z') this.withPane(this.pointerPane, () => this.modal.setAxis('z', ctx, this.tools.lastPointer, e.shiftKey));
      e.preventDefault();
      return;
    }

    // a tool's keys can re-run its drag (an axis lock), so through the pane
    if (this.withPane(this.pointerPane, () => this.tools.handleKey(ctx, key, e))) { e.preventDefault(); return; }

    // fixed conveniences alongside the rebindable map
    if (key === 'Delete' || key === 'Backspace') {
      if (this.editLike()) { ops.deleteSelected(ctx, e.shiftKey); this.ui.refresh(); }
      return;
    }
    if (mod && key === 'y') { this.redo(); e.preventDefault(); return; }

    // P is context-dependent, Blender-style: Separate in Edit mode shadows
    // the global Presentation-mode binding (same pattern as Emulate Numpad
    // shadowing 1-9 — see the CLAUDE.md gotcha).
    if (ctx.settings.mode === 'EDIT' && comboFromEvent(e) === 'p') {
      e.preventDefault();
      this.runAction('separate');
      return;
    }

    const action = this.keymap.actionFor(comboFromEvent(e));
    if (!action) return;
    e.preventDefault();
    this.runAction(action);
  }

  private runAction(action: string): void {
    const ctx = this.ctx;
    const stepFrame = (d: number) => {
      ctx.scene.frame = Math.min(ctx.scene.frameEnd, Math.max(ctx.scene.frameStart, ctx.scene.frame + d));
      this.gp.markDirty(); this.ui.refreshTimelineControls(); this.ui.drawTimeline();
    };
    switch (action) {
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'settings': this.ui.openSettings(); break;
      case 'palette': this.ui.openPalette(); break;
      case 'applyTransform': {
        if (ctx.settings.mode !== 'OBJECT') break;
        const refs = listSelected(ctx.scene);
        if (!refs.length) break;
        ctx.pushUndo();
        let n = 0;
        for (const ref of refs) if (applyObjectTransform(ctx.scene, ref)) n++;
        if (n) {
          this.gp.markDirty();
          this.refreshWidget();
          this.ui.refresh();
        }
        break;
      }
      case 'addMenu': this.openAddMenu(); break;
      case 'addTriggerAtCursor': this.addTriggerAtCursor(); break;
      case 'addTravelerNearestStroke': this.addTravelerNearestStroke(); break;
      case 'inspector': this.ui.toggleInspector(); break;
      case 'presentation': this.togglePresentation(); break;
      case 'toggleInfoOverlay': this.toggleInfoOverlay(); break;
      case 'toggleGizmoNav': this.toggleGizmoNav(); break;
      case 'toggleMaximize': this.togglePresentation(); break;
      case 'toggleEdit': this.toggleLastMode(); break;
      case 'modeObject': this.setMode('OBJECT'); break;
      case 'modePie': this.ui.openModePie(this.canvasPointer()); break;
      case 'placementPie': this.ui.openTransformPie('placement', this.canvasPointer()); break;
      case 'planePie': this.ui.openTransformPie('plane', this.canvasPointer()); break;
      case 'guidePie': this.ui.openTransformPie('guide', this.canvasPointer()); break;
      case 'snapPie': this.ui.openTransformPie('snap', this.canvasPointer()); break;
      case 'modeDraw': this.setMode('DRAW'); break;
      case 'modeEdit': this.setMode('EDIT'); break;
      // Sculpt is an Edit-mode tool now, not a mode of its own
      case 'modeSculpt': this.setMode('EDIT'); if (!this.meshEditing()) this.setTool('sculpt'); break;
      case 'modeVertex': this.setMode('VERTEX'); break;
      case 'modeWeight': this.setMode('WEIGHT'); break;
      case 'modePoly':
        // '6': jump to the PolyQuilt tool (in EDIT unless already in a
        // toolbar mode that hosts the trio)
        if (ctx.settings.mode !== 'DRAW' && ctx.settings.mode !== 'EDIT') this.setMode('EDIT');
        this.setTool('polypen');
        break;
      case 'toolDraw': if (ctx.settings.mode === 'DRAW') this.setTool('draw'); break;
      case 'toolErase': if (ctx.settings.mode === 'DRAW') this.setTool('erase'); break;
      case 'toolFill': if (ctx.settings.mode === 'DRAW') this.setTool('fill'); break;
      case 'move':
        this.withPane(this.pointerPane, () => {
          if (ctx.settings.mode === 'OBJECT') this.objModal.begin(ctx, 'move', this.tools.lastPointer);
          else if (this.meshEditing()) this.beginMeshTransform('move');
          else if (this.editLike()) this.modal.begin(ctx, 'move', this.tools.lastPointer);
        });
        break;
      case 'rotate':
        this.withPane(this.pointerPane, () => {
          if (ctx.settings.mode === 'OBJECT') this.objModal.begin(ctx, 'rotate', this.tools.lastPointer);
          else if (this.meshEditing()) this.beginMeshTransform('rotate');
          else if (this.editLike()) this.modal.begin(ctx, 'rotate', this.tools.lastPointer);
        });
        break;
      case 'scale':
        this.withPane(this.pointerPane, () => {
          if (ctx.settings.mode === 'OBJECT') this.objModal.begin(ctx, 'scale', this.tools.lastPointer);
          else if (this.meshEditing()) this.beginMeshTransform('scale');
          else if (this.editLike()) this.modal.begin(ctx, 'scale', this.tools.lastPointer);
        });
        break;
      case 'selectAll': if (this.editLike()) { selectAll(ctx, 'all'); this.gp.markDirty(); } break;
      case 'selectNone': if (this.editLike()) { selectAll(ctx, 'none'); this.gp.markDirty(); } break;
      case 'selectInvert': if (this.editLike()) { selectAll(ctx, 'invert'); this.gp.markDirty(); } break;
      case 'selectLinked': if (this.editLike()) { selectLinked(ctx); this.gp.markDirty(); } break;
      case 'selectConnected': if (this.editLike()) { ctx.pushUndo(); selectConnected(ctx); this.gp.markDirty(); this.ui.refresh(); } break;
      case 'join': if (this.editLike()) { ops.joinSelected(ctx); this.ui.refresh(); } break;
      case 'split': if (this.editLike()) { ops.splitSelected(ctx); this.ui.refresh(); } break;
      // Blender's P: a small menu at the pointer — Selection / By Material /
      // By Loose Parts for strokes, Selection / By Loose Parts for a mesh
      case 'separate': if (this.editLike()) {
        const r = ctx.canvas.getBoundingClientRect();
        const p = this.canvasPointer();
        this.ui.openSeparateMenu(r.left + p.x, r.top + p.y);
      } break;
      case 'renameObject': this.ui.renameActiveObject(); break;
      case 'selectMore': if (this.editLike()) { selectMoreLess(ctx, true); this.gp.markDirty(); } break;
      case 'selectLess': if (this.editLike()) { selectMoreLess(ctx, false); this.gp.markDirty(); } break;
      case 'delete':
        if (ctx.settings.mode === 'OBJECT') { this.deleteSelectedObjects(); break; }
        // DRAW mode shares edit mode's stroke selection (restyling picks
        // strokes there), so X has to delete them too, not silently no-op
        if (this.editLike() || ctx.settings.mode === 'DRAW') {
          const selCanvases = ctx.scene.canvases.filter((c) => c.select);
          if (selCanvases.length && !hasSelectedPoints(ctx)) {
            ctx.pushUndo();
            ctx.scene.canvases = ctx.scene.canvases.filter((c) => !c.select);
            this.syncCanvases();
          } else {
            ops.deleteSelected(ctx, false);
          }
          this.ui.refresh();
        }
        break;
      case 'toggleSnap':
        ctx.settings.snap.enabled = !ctx.settings.snap.enabled;
        this.savePrefs();
        this.ui.refresh();
        break;
      case 'duplicate':
        if (ctx.settings.mode === 'OBJECT') this.duplicateSelectedObjects();
        else if (this.editLike()) {
          ops.duplicateSelected(ctx);
          this.withPane(this.pointerPane, () => this.modal.begin(ctx, 'move', this.tools.lastPointer));
        }
        break;
      case 'copy': ops.copySelected(ctx); break;
      case 'paste': ops.pasteBuffer(ctx); this.ui.refresh(); break;
      case 'play': this.playToggle(); this.ui.refreshTimelineControls(); break;
      case 'insertKey': this.addKeyframe(false); break;
      case 'removeKey': this.removeKeyframe(); break;
      case 'nextKey': this.jumpKey(1); break;
      case 'prevKey': this.jumpKey(-1); break;
      case 'nextFrame': stepFrame(1); break;
      case 'prevFrame': stepFrame(-1); break;
      case 'fly': this.nav.flying ? this.nav.stopFly() : this.nav.startFly(); break;
      case 'possess': {
        if (possession.active) { this.unpossess(); break; }
        const actors = ctx.scene.actors;
        const pick = actors.find((a) => a.select) ?? actors[0];
        if (pick) this.possess(pick.id);
        break;
      }
      case 'cameraView': this.toggleCameraView(); break;
      case 'cycleCamera': this.cycleCamera(); break;
      case 'save': this.saveScene(); break;
      case 'open': void this.loadScene(); break;
      case 'newScene': this.newScene(); break;
      case 'viewAll': this.viewAll(); break;
      case 'viewSelected': this.viewSelected(); break;
      case 'quadView': this.toggleQuadView(); break;
      case 'renderScale': {
        // cycle 100 -> 75 -> 50 %
        const steps = [1, 0.75, 0.5];
        const cur = ctx.settings.renderScale ?? 1;
        this.setRenderScale(steps[(steps.indexOf(cur) + 1) % steps.length] ?? 1);
        break;
      }
      case 'perfOverlay':
        ctx.settings.showPerf = !ctx.settings.showPerf;
        perf.enabled = !!ctx.settings.showPerf;
        this.savePrefs();
        this.ui.refresh();
        break;
      case 'cycleShading': this.cycleShading(1); break;
      case 'cycleShadingBack': this.cycleShading(-1); break;
      case 'parentSet': {
        if (ctx.settings.mode !== 'OBJECT') break;
        const active = this.objectPick.lastPicked;
        const refs = listSelected(ctx.scene).filter((r) =>
          !(active && r.kind === active.kind && r.id === active.id));
        if (!active || !refs.length) break;
        ctx.pushUndo();
        let ok = 0;
        for (const r of refs) if (setParentKeepWorld(ctx.scene, r, active)) ok++;
        console.info(`parented ${ok} object(s) to ${active.kind} ${active.id}`);
        this.syncCanvases();
        this.gp.markDirty();
        this.ui.refresh();
        break;
      }
      case 'groupToEmpty': {
        if (ctx.settings.mode !== 'OBJECT') break;
        const refs = listSelected(ctx.scene);
        if (!refs.length) break;
        // Bounds from the RENDERED objects rather than from the data: the
        // selection can mix GP objects, meshes, splats and editable meshes,
        // and the one thing they all agree on is where they end up on screen.
        const box = new THREE.Box3();
        for (const r of refs) box.union(this.groupBounds(r));
        if (box.isEmpty()) break;
        const upAxis = ctx.settings.upAxis === 'Z' ? 2 : 1;
        const centre = box.getCenter(new THREE.Vector3());
        // Centred horizontally but sitting on the selection's LOWEST point:
        // a group pivot you can drop onto a floor, rotate about, and see —
        // a centroid floating inside the geometry is none of those.
        const at = centre.toArray() as [number, number, number];
        at[upAxis] = box.min.getComponent(upAxis);
        ctx.pushUndo();
        const empty = createMeshObject(genId(), 'EMPTY', at);
        empty.name = `Group (${refs.length})`;
        // Insert where the FIRST selected mesh sits rather than appending.
        // The outliner renders in scene order, so pushing put every new
        // group at the very bottom of the list, miles from the things it
        // contains — you had to go hunting for what you just made.
        const idxs = refs
          .filter((r) => r.kind === 'MESH')
          .map((r) => ctx.scene.meshes.findIndex((m) => m.id === r.id))
          .filter((i) => i >= 0);
        const at0 = idxs.length ? Math.min(...idxs) : ctx.scene.meshes.length;
        ctx.scene.meshes.splice(at0, 0, empty);
        const parent: ObjRef = { kind: 'MESH', id: empty.id };
        let ok = 0;
        for (const r of refs) if (setParentKeepWorld(ctx.scene, r, parent)) ok++;
        // select the new group, so the very next drag moves the whole thing
        deselectAllObjects(ctx.scene);
        setObjectSelected(ctx.scene, parent, true);
        this.setStatusHint(`Grouped ${ok} object(s) under ${empty.name}`);
        this.syncCanvases();
        this.gp.markDirty();
        this.refreshWidget();
        this.ui.refresh();
        break;
      }
      case 'parentClear': {
        if (ctx.settings.mode !== 'OBJECT') break;
        const refs = listSelected(ctx.scene);
        if (!refs.length) break;
        ctx.pushUndo();
        for (const r of refs) setParentKeepWorld(ctx.scene, r, null);
        this.syncCanvases();
        this.gp.markDirty();
        this.ui.refresh();
        break;
      }
      case 'centerCursorViewAll':
        ctx.scene.cursor = [0, 0, 0];
        this.gp.markDirty();
        this.viewAll();
        break;
    }
  }

  private editLike(): boolean {
    return this.ctx.settings.mode === 'EDIT';
  }

  // ------------------------------------------------------------- render

  // ------------------------------------------------------- world convention

  private makeAxes(): THREE.Group {
    const g = new THREE.Group();
    const mk = (dir: THREE.Vector3, color: number) => {
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 });
      const geo = new THREE.BufferGeometry().setFromPoints([
        dir.clone().multiplyScalar(-50), dir.clone().multiplyScalar(50),
      ]);
      g.add(new THREE.Line(geo, mat));
    };
    mk(new THREE.Vector3(1, 0, 0), 0xe5605e);
    mk(new THREE.Vector3(0, 1, 0), 0x7db32b);
    mk(new THREE.Vector3(0, 0, 1), 0x4f8cff);
    return g;
  }

  setShowAxes(v: boolean): void {
    this.ctx.settings.showAxes = v;
    this.axes.visible = v && !this.presentation;
    this.savePrefs();
  }

  setTrackpadNav(v: boolean): void {
    this.ctx.settings.trackpadNav = v;
    this.controls.enableZoom = !v; // classic wheel-zoom only when trackpad nav is off
    this.savePrefs();
  }

  savePrefs(): void { savePrefs(this.ctx.settings); }

  /**
   * Apply the world-up convention. OrbitControls caches its up-frame at
   * construction, so it is recreated here. With resetView, the viewport
   * jumps to that convention's home view.
   */
  applyUpAxis(resetView = false): void {
    const axis = this.ctx.settings.upAxis;
    const target = this.controls.target.clone();
    this.controls.dispose();
    this.controls = new OrbitControls(this.nav.active, this.ctx.canvas);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = {
      LEFT: undefined as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.enableZoom = !this.ctx.settings.trackpadNav;
    this.controls.target.copy(target);
    this.nav.controls = this.controls;
    this.nav.setUpAxis(axis);
    for (const pane of this.orthoPanes) relockOrthoPane(pane, axis);

    // floor grid passes through the origin, Blender-style
    this.grid.rotation.set(axis === 'Z' ? Math.PI / 2 : 0, 0, 0);
    this.grid.position.set(0, 0, 0);
    if (resetView) {
      if (axis === 'Z') this.camera.position.set(0, -6, 2);
      else this.camera.position.set(0, 0.6, 6);
      this.controls.target.set(0, 0, 0);
      this.camera.up.copy(this.nav.up);
      this.camera.lookAt(this.controls.target);
    }
    this.controls.update();
    this.gp.markDirty();
    this.savePrefs();
  }

  // -------------------------------------------------- camera & presentation

  private makeCameraHelper(active: boolean): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({
      color: active ? 0xd8a03c : 0x8a7346,
      transparent: !active, opacity: active ? 1 : 0.6,
    });
    const w = 0.32, h = 0.22, d = 0.5;
    const apex = new THREE.Vector3(0, 0, 0);
    const corners = [
      new THREE.Vector3(-w, -h, -d), new THREE.Vector3(w, -h, -d),
      new THREE.Vector3(w, h, -d), new THREE.Vector3(-w, h, -d),
    ];
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      pts.push(apex.clone(), corners[i].clone());                 // sides
      pts.push(corners[i].clone(), corners[(i + 1) % 4].clone()); // base
    }
    // up-direction triangle
    pts.push(new THREE.Vector3(-w * 0.5, h, -d), new THREE.Vector3(w * 0.5, h, -d));
    pts.push(new THREE.Vector3(w * 0.5, h, -d), new THREE.Vector3(0, h + 0.14, -d));
    pts.push(new THREE.Vector3(0, h + 0.14, -d), new THREE.Vector3(-w * 0.5, h, -d));
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat));
    markOverlay(g);
    return g;
  }

  /** Keep one frustum helper per scene camera, posed at the evaluated frame. */
  private syncCameraHelpers(): void {
    const cams = this.ctx.scene.cameras;
    if (this.camHelper.children.length !== cams.length ||
        this.camHelper.userData.activeIndex !== this.ctx.scene.activeCamera) {
      for (const c of [...this.camHelper.children]) this.camHelper.remove(c);
      cams.forEach((_, i) => this.camHelper.add(this.makeCameraHelper(i === this.ctx.scene.activeCamera)));
      this.camHelper.userData.activeIndex = this.ctx.scene.activeCamera;
    }
    cams.forEach((cam, i) => {
      const helper = this.camHelper.children[i];
      const pose = evalCamera(cam, this.ctx.scene.frame);
      helper.position.copy(pose.position);
      helper.quaternion.copy(pose.quaternion);
      // the camera being looked through hides its own helper
      helper.visible = !(this.cameraView && i === this.ctx.scene.activeCamera);
    });
  }

  toggleCameraView(): void {
    this.cameraView = !this.cameraView;
    if (this.cameraView) {
      if (this.nav.isOrtho) this.nav.toggleOrtho();
      this.applyCameraPose();
    } else {
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
      this.controls.enabled = true;
    }
    this.ui.refreshTimelineControls();
  }

  private applyCameraPose(): void {
    const pose = evalCamera(activeCam(this.ctx.scene), this.ctx.scene.frame);
    this.camera.position.copy(pose.position);
    this.camera.quaternion.copy(pose.quaternion);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    this.controls.target.copy(this.camera.position).addScaledVector(fwd, 4);
    this.controls.update();
  }

  cycleCamera(): void {
    const s = this.ctx.scene;
    if (s.cameras.length < 2 && !this.cameraView) { this.toggleCameraView(); return; }
    s.activeCamera = (s.activeCamera + 1) % s.cameras.length;
    if (this.cameraView) this.applyCameraPose();
    this.ui.refreshTimelineControls();
    this.ui.drawTimeline();
  }

  setActiveCamera(index: number): void {
    this.ctx.scene.activeCamera = Math.max(0, Math.min(this.ctx.scene.cameras.length - 1, index));
    if (this.cameraView) this.applyCameraPose();
    this.ui.refreshTimelineControls();
    this.ui.drawTimeline();
  }

  /** New camera captures the current viewport pose. */
  addCamera(): void {
    const s = this.ctx.scene;
    this.ctx.pushUndo();
    const cam = createDefaultCamera(`Camera ${s.cameras.length + 1}`);
    cam.translation = this.camera.position.toArray() as [number, number, number];
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion);
    cam.rotation = [e.x, e.y, e.z];
    cam.fov = this.cameraView ? this.camera.fov : 50;
    s.cameras.push(cam);
    s.activeCamera = s.cameras.length - 1;
    this.ui.refreshTimelineControls();
  }

  removeCamera(): void {
    const s = this.ctx.scene;
    if (s.cameras.length <= 1) return;
    this.ctx.pushUndo();
    s.cameras.splice(s.activeCamera, 1);
    s.activeCamera = Math.max(0, s.activeCamera - 1);
    if (this.cameraView) this.applyCameraPose();
    this.ui.refreshTimelineControls();
    this.ui.drawTimeline();
  }

  addCameraKey(): void {
    this.ctx.pushUndo();
    insertCameraKey(activeCam(this.ctx.scene), this.ctx.scene.frame);
    this.ui.drawTimeline();
    this.ui.refreshTimelineControls();
  }

  removeCameraKeyAtFrame(): void {
    this.ctx.pushUndo();
    removeCameraKey(activeCam(this.ctx.scene), this.ctx.scene.frame);
    this.ui.drawTimeline();
  }

  togglePresentation(): void {
    this.presentation = !this.presentation;
    document.getElementById('app')!.classList.toggle('presentation', this.presentation);
    this.grid.visible = this.gridVisible();
    this.canvasGroup.visible = !this.presentation;
    this.cursorMarker.visible = !this.presentation;
    this.camHelper.visible = !this.presentation;
    this.axes.visible = this.ctx.settings.showAxes && !this.presentation;
    this.gp.markDirty();
    this.resize();
  }

  /** Ctrl+Alt+Q: Blender-style Quad View — persp pane (unchanged nav) +
   *  3 locked ortho reference panes (Front/Side/Top), pan+zoom only. Step 1:
   *  rendering skeleton only — input routing per pane lands in later steps,
   *  so drawing/navigating currently still targets the single active camera
   *  regardless of which pane it visually renders into. */
  toggleQuadView(): void {
    // leaving the four-up with the pointer over an ortho pane: that view
    // becomes the single view (Maya), rather than always the perspective
    const from = this.quadView && this.hoverPane && this.hoverPane !== 'persp'
      ? this.orthoPanes.find((p) => p.id === this.hoverPane) : undefined;
    if (from) this.nav.adoptOrthoView(from.camera, from.target);
    this.quadView = !this.quadView;
    if (this.quadView) {
      // reframe the 3 ortho panes from the persp camera's CURRENT distance,
      // so quad view opens roughly matching what you were just looking at
      const dist = this.camera.position.distanceTo(this.controls.target);
      this.orthoPanes = createOrthoPanes(this.nav.upAxis, dist);
    } else {
      this.refreshWidget(); // restore selection-driven visibility (step 1 forces it hidden while on)
    }
    // resize() returns early when the window size is unchanged — which it
    // always is on a toggle — so the pane rectangles were never computed and
    // quad view stayed a single view until something else resized the page
    this.sized = { w: 0, h: 0, dpr: 0 };
    this.resize();
  }

  /** Alt+Shift+Z: floor grid + bottom-left status/info overlay. */
  toggleInfoOverlay(): void {
    this.infoOverlayHidden = !this.infoOverlayHidden;
    this.grid.visible = this.gridVisible();
    const status = document.getElementById('status');
    if (status) status.style.display = this.infoOverlayHidden ? 'none' : '';
  }

  /** Ctrl+`: transform widget + all mouse-driven camera navigation. */
  toggleGizmoNav(): void {
    this.navLocked = !this.navLocked;
    if (this.navLocked) {
      this.prevShowGizmo = this.ctx.settings.showGizmo;
      this.ctx.settings.showGizmo = false;
    } else {
      this.ctx.settings.showGizmo = this.prevShowGizmo;
    }
    this.controls.enabled = !this.navLocked;
    this.refreshWidget();
    this.ui.refresh();
  }

  /** Viewport shading (Blender's four header buttons). This is a VIEW
   *  preference, not scene data, so it is not undoable and persists in
   *  prefs — the world it reveals is the scene's, the choice to look at
   *  it is the user's. */
  setShading(mode: ViewportShading): void {
    this.ctx.settings.shading = mode;
    this.savePrefs();
    // meshes swap wireframe/lit state and GP re-evaluates against the new
    // environment, so both halves of the pipeline need a rebuild
    this.gp.markDirty();
    this.ui.refresh();
    this.ctx.requestRender();
  }

  /** Cycle shading forward (Z with no menu — Blender's shortcut). */
  cycleShading(dir: 1 | -1 = 1): void {
    const order: ViewportShading[] = ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED'];
    const i = order.indexOf(this.ctx.settings.shading);
    this.setShading(order[(i + dir + order.length) % order.length]);
  }

  setBackground(rgb: [number, number, number]): void {
    // The world owns scene3.background (it may be an equirect texture, not a
    // Color — the old unconditional `as THREE.Color` cast would throw once a
    // 360 environment is active), so this writes the DATA and lets
    // WorldManager.update apply it on the next frame.
    this.ctx.scene.world.color = [...rgb];
    this.rebuildGrid(); // auto grid color tracks background unless overridden
    this.gp.markDirty();
  }

  // ------------------------------------------------------------- theming

  /** Grid color when settings.gridColor is unset: lighten/darken the
   *  background for contrast, so the grid stays visible against any
   *  background instead of the old hardcoded dark-theme grays. */
  private autoGridColor(bg: [number, number, number]): THREE.Color {
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    const delta = lum < 0.5 ? 0.16 : -0.16;
    return srgbColor([
      Math.min(1, Math.max(0, bg[0] + delta)),
      Math.min(1, Math.max(0, bg[1] + delta)),
      Math.min(1, Math.max(0, bg[2] + delta)),
    ]);
  }

  /** Fixed 20-major-cell footprint; gridStep sets the major cell size (so
   *  the grid always spans gridStep*20 world units) and gridSubdivisions
   *  sets minor lines per major cell. Major lines are always solid; minor
   *  (subdivision) lines get their own style (dashed by default) so the
   *  major step stays visually dominant — two separate LineSegments
   *  objects (dashing needs per-segment computeLineDistances(), which a
   *  single baked GridHelper geometry can't do per-line). Magnet snapping
   *  targets the minor spacing (gridStep/gridSubdivisions) — see
   *  snapIncrement() in tools/context.ts — not this rendering. */
  private makeGrid(): THREE.Group {
    const s = this.ctx.settings;
    const main = s.gridColor
      ? srgbColor(s.gridColor)
      : this.autoGridColor(this.ctx.scene.world.color);
    const sub = main.clone().multiplyScalar(0.6);
    const majorCells = 20;
    const step = s.gridStep;
    const subdiv = Math.max(1, Math.min(20, Math.round(s.gridSubdivisions ?? 1)));
    const half = (majorCells * step) / 2;
    const minorStep = step / subdiv;
    const totalLines = majorCells * subdiv;

    const majorPos: number[] = [];
    const minorPos: number[] = [];
    for (let i = 0; i <= totalLines; i++) {
      const p = -half + i * minorStep;
      const arr = i % subdiv === 0 ? majorPos : minorPos;
      arr.push(-half, 0, p, half, 0, p); // line along X at Z=p
      arr.push(p, 0, -half, p, 0, half); // line along Z at X=p
    }

    const group = new THREE.Group();
    const majorGeo = new THREE.BufferGeometry();
    majorGeo.setAttribute('position', new THREE.Float32BufferAttribute(majorPos, 3));
    group.add(new THREE.LineSegments(majorGeo, new THREE.LineBasicMaterial({ color: main, transparent: true })));

    if (minorPos.length) {
      const minorGeo = new THREE.BufferGeometry();
      minorGeo.setAttribute('position', new THREE.Float32BufferAttribute(minorPos, 3));
      if (s.gridSubdivStyle === 'dashed') {
        // Fixed period (step/16) tiled evenly ONLY at subdiv=2 by
        // coincidence — at any other subdivision count, a minor cell
        // (step/subdiv wide) doesn't hold a whole number of dash+gap
        // periods, so the pattern falls out of phase cell to cell.
        // Target: exactly 2*subdiv dash+gap periods per minor cell, i.e.
        // per-cell period length = (step/subdiv) / (2*subdiv), and each
        // dash/gap is half that: step / (4*subdiv^2). subdiv=2 -> step/16,
        // matching the old constant exactly; subdiv=3 -> step/36, etc.
        const period = step / (4 * subdiv * subdiv);
        const dashMat = new THREE.LineDashedMaterial({
          color: sub, transparent: true, dashSize: period, gapSize: period,
        });
        const minorLines = new THREE.LineSegments(minorGeo, dashMat);
        minorLines.computeLineDistances(); // required per-object for dashing
        group.add(minorLines);
      } else {
        group.add(new THREE.LineSegments(minorGeo, new THREE.LineBasicMaterial({ color: sub, transparent: true })));
      }
    }

    group.rotation.copy(this.grid?.rotation ?? group.rotation);
    group.position.copy(this.grid?.position ?? group.position);
    group.visible = this.grid?.visible ?? true;
    return group;
  }

  /** Rebuild the grid (colors/dash state are baked at construction, so any
   *  change means new geometry/materials). */
  /** The grid answers to three things — the user's own switch, the info
   *  overlay, and presentation mode — and they should be read in ONE place
   *  or a rebuild quietly resurrects a grid someone turned off. */
  private gridVisible(): boolean {
    return this.ctx.settings.showGrid !== false
      && !this.infoOverlayHidden && !this.presentation;
  }

  rebuildGrid(): void {
    const old = this.grid;
    this.grid = this.makeGrid();
    this.grid.visible = this.gridVisible();
    this.scene3.add(this.grid);
    if (old) {
      this.scene3.remove(old);
      old.traverse((o) => {
        const line = o as THREE.LineSegments;
        line.geometry?.dispose?.();
        (line.material as THREE.Material)?.dispose?.();
      });
    }
  }

  /** Push uiAccent/uiHighlight to the CSS custom properties every DOM
   *  panel already styles against, so the whole app re-themes at once.
   *  Both carry real alpha (rgba, not hex) so every existing CSS rule that
   *  reads them — backgrounds, borders, fills — goes translucent for free,
   *  no per-rule changes needed. */
  applyThemeColors(): void {
    const s = this.ctx.settings;
    const clamp255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    const rgba = (c: [number, number, number], a: number) => {
      const [r, g, b] = c.map(clamp255);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    };
    document.documentElement.style.setProperty('--accent', rgba(s.uiAccent, s.uiAccentAlpha));
    document.documentElement.style.setProperty('--accent2', rgba(s.uiHighlight, s.uiHighlightAlpha));
  }

  /** Selection-outline color (three.js side): mirrors uiHighlight, the
   *  ACTIVE (last-picked) object gets a distinct authored color
   *  (uiHighlightActive) rather than a brightened uiHighlight —
   *  THREE.Color.lerp interpolates in linear light and visibly
   *  over-brightens midtones, so active/target objects need their own hue,
   *  not an interpolated one. Opacity is shared (uiHighlightAlpha). */
  highlightColor(active = false): THREE.Color {
    return srgbColor(active ? this.ctx.settings.uiHighlightActive : this.ctx.settings.uiHighlight);
  }

  // --------------------------------------------------------- object mode

  /** Re-attach the transform widget to the current object selection pivot. */
  refreshWidget(): void {
    const inObjectMode = this.ctx.settings.mode === 'OBJECT' && this.ctx.settings.showGizmo;
    const pivot = inObjectMode ? selectionPivot(this.ctx.scene) : null;
    if (pivot) {
      this.widgetProxy.position.copy(pivot);
      this.widgetProxy.rotation.set(0, 0, 0);
      this.widgetProxy.scale.set(1, 1, 1);
      this.widget.attach(this.widgetProxy);
      this.widget.enabled = true;
      this.widget.getHelper().visible = true;
    } else {
      this.widget.detach();
      this.widget.enabled = false;
      this.widget.getHelper().visible = false;
    }
  }

  setWidgetMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.widget.setMode(mode);
    this.ui.refresh();
  }
  get widgetMode(): string { return this.widget?.mode ?? 'translate'; }

  private beginWidgetDrag(): void {
    const refs = listSelected(this.ctx.scene);
    if (!refs.length) return;
    this.ctx.pushUndo();
    this.widgetBase = {
      refs,
      transforms: refs.map((r) => getObjectTransform(this.ctx.scene, r)!),
      proxy: {
        translation: this.widgetProxy.position.toArray() as [number, number, number],
        rotation: [this.widgetProxy.rotation.x, this.widgetProxy.rotation.y, this.widgetProxy.rotation.z],
        scale: this.widgetProxy.scale.toArray() as [number, number, number],
      },
    };
  }

  /** Proxy deltas -> every selected object in WORLD space, written back to
   *  each object's local transform through its parent inverse. */
  /** Magnet snap for the OBJECT-mode translate widget (grid / nearest
   *  object origin) — the same `settings.snap` the EDIT-mode modal
   *  transform uses, so one magnet setting works in both modes. */
  private snapWidgetPosition(): void {
    const snap = this.ctx.settings.snap;
    if (!snap.enabled || this.widget.mode !== 'translate') return;
    const p = this.widgetProxy.position;
    if (snap.mode === 'GRID') {
      const g = snapIncrement(this.ctx.settings);
      p.set(Math.round(p.x / g) * g, Math.round(p.y / g) * g, Math.round(p.z / g) * g);
    } else if (snap.mode === 'INCREMENT') {
      // relative: the DELTA from the drag start moves in step multiples
      const g = snapIncrement(this.ctx.settings);
      const base = this.widgetBase ? new THREE.Vector3(...this.widgetBase.proxy.translation) : new THREE.Vector3();
      p.set(
        base.x + Math.round((p.x - base.x) / g) * g,
        base.y + Math.round((p.y - base.y) / g) * g,
        base.z + Math.round((p.z - base.z) / g) * g,
      );
    } else if (snap.mode === 'OBJECT') {
      const dragging = new Set(this.widgetBase?.refs.map((r) => `${r.kind}:${r.id}`));
      let best: THREE.Vector3 | null = null;
      let bestD = Infinity;
      for (const ref of allRefs(this.ctx.scene)) {
        if (dragging.has(`${ref.kind}:${ref.id}`)) continue; // don't snap to itself
        const pos = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(this.ctx.scene, ref));
        const d = pos.distanceTo(p);
        if (d < bestD) { bestD = d; best = pos; }
      }
      if (best && bestD < 0.5) p.copy(best);
    }
  }

  private applyWidgetDrag(): void {
    const base = this.widgetBase;
    if (!base) return;
    this.snapWidgetPosition();
    const scene = this.ctx.scene;
    const pivot = new THREE.Vector3(...base.proxy.translation);
    const dPos = this.widgetProxy.position.clone().sub(pivot);
    const qDelta = new THREE.Quaternion().setFromEuler(this.widgetProxy.rotation);
    const sDelta = new THREE.Vector3(
      this.widgetProxy.scale.x / base.proxy.scale[0],
      this.widgetProxy.scale.y / base.proxy.scale[1],
      this.widgetProxy.scale.z / base.proxy.scale[2],
    );
    // deltaM = T(pivot + dPos) * R * S * T(-pivot)
    const deltaM = new THREE.Matrix4()
      .makeTranslation(pivot.x + dPos.x, pivot.y + dPos.y, pivot.z + dPos.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(qDelta))
      .multiply(new THREE.Matrix4().makeScale(sDelta.x, sDelta.y, sDelta.z))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));

    this.applyWorldDelta(base.refs, base.transforms, deltaM, sDelta);
  }

  /**
   * Apply a world-space delta matrix to a set of objects through their
   * parent inverses. Shared by the gizmo widget and the G/R/S modal —
   * both get parenting and Follow-Path leashing (drag-as-phase-edit).
   */
  private applyWorldDelta(
    refs: ObjRef[], baseTransforms: ObjTransform[], deltaM: THREE.Matrix4,
    sDelta = new THREE.Vector3(1, 1, 1),
  ): void {
    const scene = this.ctx.scene;
    refs.forEach((ref, i) => {
      const t0 = baseTransforms[i];
      if (!t0) return;
      // world' = deltaM * parentWorld * local0 ; local' = parentWorld^-1 * world'
      const parentM = parentWorldMatrixOf(scene, ref);
      const local0 = new THREE.Matrix4().compose(
        new THREE.Vector3(...t0.translation),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...t0.rotation)),
        ref.kind === 'CANVAS' ? new THREE.Vector3(1, 1, 1) : new THREE.Vector3(...t0.scale),
      );
      const world1 = deltaM.clone().multiply(parentM.clone().multiply(local0));
      const local1 = parentM.clone().invert().multiply(world1);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      local1.decompose(pos, quat, scl);
      // Follow Path travelers are leashed to their stroke: a drag
      // re-projects onto the path and becomes a PHASE edit (timing /
      // relative positioning), not a free move
      const fp = constraintsOf(scene, ref).find((k) => k.enabled && k.type === 'FOLLOW_PATH' && k.path);
      if (fp?.path) {
        const dragWorld = new THREE.Vector3().setFromMatrixPosition(world1);
        const phase = this.score.nearestPhase(scene, fp.path, dragWorld);
        if (phase !== null) {
          fp.phase = phase;
          const st = { position: new THREE.Vector3(), tangent: new THREE.Vector3(), valid: false };
          if (this.score.sample(scene, fp.path, phase, st)) {
            const snapped = st.position.clone().applyMatrix4(parentM.clone().invert());
            pos.copy(snapped);
          }
        }
      }
      const eul = new THREE.Euler().setFromQuaternion(quat);
      setObjectTransform(scene, ref, {
        translation: [pos.x, pos.y, pos.z],
        rotation: [eul.x, eul.y, eul.z],
        // canvases carry size in the scale slots (scaled by the delta);
        // everything else takes the decomposed local scale
        scale: ref.kind === 'CANVAS'
          ? [t0.scale[0] * sDelta.x, t0.scale[1] * sDelta.y, 1]
          : [scl.x, scl.y, scl.z],
      });
    });
    this.syncCanvases();
    this.gp.markDirty(); // GP object transforms live on the object groups
  }

  run(action: string): void { this.runAction(action); }

  /** N1: every capability, one registry (palette + agent API). */
  private buildCommands(): void {
    const reg = this.commands;
    for (const a of ACTIONS) {
      reg.register({
        id: a.id, title: a.label, keywords: a.category,
        key: this.keymap.comboFor(a.id),
        run: () => this.runAction(a.id),
      });
    }
    const add = (id: string, title: string, run: (args?: string) => unknown, keywords = '') =>
      reg.register({ id, title, keywords, run });
    add('addTestCamera', 'Add test camera (generated live stream)', () => this.openTestCamera(), 'library camera stream video test bars');
    add('addTestCard', 'Add test card (still image) to the Library', () => this.addTestCard(), 'library image test card grid');

    for (const kind of ['PLANE', 'BOX', 'SPHERE', 'CYLINDER', 'PYRAMID',
      'TETRA', 'OCTA', 'DODECA', 'ICOSA', 'EMPTY'] as const) {
      add(`add.${kind.toLowerCase()}`, `Add ${kind.toLowerCase()} at cursor`,
        () => this.addMeshObject(kind), 'object primitive mesh');
    }
    add('object.group', 'Group selection under a new empty',
      () => this.runAction('groupToEmpty'), 'object parent empty group pivot');
    add('add.camera', 'Add camera at current view', () => this.addCamera(), 'object');
    add('add.gp', 'Add blank Grease Pencil object', () => this.addGPObject(), 'object grease pencil new');
    add('add.polymesh', 'Add Editable Mesh', () => this.addPolyMeshObject(), 'object topology poly editable mesh');
    add('poly.subdivide', 'Subdivide selected editable meshes', () => {
      const polys = this.ctx.scene.polyMeshes.filter((p) => p.select);
      if (!polys.length) return;
      this.ctx.pushUndo();
      for (const pm of polys) subdividePolyMesh(pm);
      this.ui.refresh();
    }, 'topology quads catmull');
    add('poly.smooth', 'Smooth selected editable meshes', () => {
      const polys = this.ctx.scene.polyMeshes.filter((p) => p.select);
      if (!polys.length) return;
      this.ctx.pushUndo();
      for (const pm of polys) smoothPolyMesh(pm, 0.5, 2);
      this.ui.refresh();
    }, 'topology laplacian relax');
    add('mediamime.panel', 'Open MediaMime panel', () => this.ui.openTab('mediamime'), 'landmarks rig mediapipe');
    add('export.glb', 'Export GLB', async () => (await import('../io/export3d')).exportGLB(this.ctx), 'file');
    add('export.obj', 'Export OBJ', async () => (await import('../io/export3d')).exportOBJ(this.ctx), 'file');
    add('export.stl', 'Export STL', async () => (await import('../io/export3d')).exportSTL(this.ctx), 'file');
    add('export.ply', 'Export PLY geometry', async () => (await import('../io/export3d')).exportPLY(this.ctx), 'file');
    add('export.ply.scene', 'Export PLY full scene (incl. splats)', async () => (await import('../io/export3d')).exportScenePLY(this.ctx), 'file blender splat');
    add('export.png', 'Export PNG snapshot', () => this.exportPng(), 'file render');
    add('export.gp', 'Export active GP object', () => this.exportActiveGP(), 'file json');
    add('view.front', 'View front', () => this.nav.snapView('FRONT'), 'viewpoint');
    add('view.right', 'View right', () => this.nav.snapView('RIGHT'), 'viewpoint');
    add('view.top', 'View top', () => this.nav.snapView('TOP'), 'viewpoint');
    add('view.ortho', 'Toggle orthographic', () => this.nav.toggleOrtho(), 'perspective');
    add('mode.object', 'Object mode', () => this.setMode('OBJECT'));
    add('brush.set', 'Set brush size (args: px)', (args) => {
      const v = Number(args);
      if (Number.isFinite(v)) this.ctx.settings.brush.size = Math.max(1, v);
      return this.ctx.settings.brush.size;
    }, 'radius width');

    // scene-dependent commands, rebuilt on every search/execute
    reg.dynamicSources.push(() => {
      const out = [];
      const scene = this.ctx.scene;
      for (const ob of scene.objects) {
        out.push({
          id: `select.gp.${ob.id}`, title: `Select GP: ${ob.name}`, keywords: 'object',
          run: () => {
            this.setMode('OBJECT');
            deselectAllObjects(scene);
            ob.select = true;
            scene.activeObject = gpIndexOf(scene, ob.id);
            this.refreshWidget(); this.gp.markDirty(); this.ui.refresh();
          },
        });
      }
      for (const m of scene.meshes) {
        out.push({
          id: `select.mesh.${m.id}`, title: `Select mesh: ${m.name}`, keywords: 'object',
          run: () => {
            this.setMode('OBJECT');
            deselectAllObjects(scene);
            m.select = true;
            this.refreshWidget(); this.ui.refresh();
          },
        });
      }
      for (const s of scene.splats) {
        out.push({
          id: `select.splat.${s.id}`, title: `Select splat: ${s.name}`, keywords: 'object',
          run: () => {
            this.setMode('OBJECT');
            deselectAllObjects(scene);
            s.select = true;
            this.refreshWidget(); this.ui.refresh();
          },
        });
      }
      return out;
    });
    // asset library
    reg.dynamicSources.push(() => listAssets().map((a) => ({
      id: `asset.add.${a.id}`, title: `Add asset: ${a.name}`, keywords: 'library',
      run: () => this.addAssetToScene(a),
    })));
    // brush presets
    reg.dynamicSources.push(() => {
      return BRUSH_PRESETS_CACHE.map((p2) => ({
        id: `brush.preset.${p2.name.toLowerCase().replace(/\s+/g, '-')}`,
        title: `Brush: ${p2.name}`, keywords: 'preset',
        run: () => {
          const b = this.ctx.settings.brush;
          b.preset = p2.name; b.size = p2.size; b.strength = p2.strength;
          b.hardness = p2.hardness; b.style = { ...p2.style };
          this.ui.refresh();
        },
      }));
    });
  }

  setLastPicked(ref: ObjRef): void { this.objectPick.lastPicked = ref; }
  getLastPicked(): ObjRef | null { return this.objectPick.lastPicked; }

  /** Blender-style eyedropper: next viewport click resolves the object
   *  (Esc cancels, callback gets null). Used for constraint/rig target
   *  pickers. */
  pickObject(cb: (ref: ObjRef | null) => void): void {
    this.objectPicking = cb;
    this.ctx.canvas.style.cursor = 'crosshair';
  }

  newScene(): void {
    this.ctx.pushUndo();
    this.ctx.replaceScene(createScene());
    this.refreshWidget();
  }

  /**
   * Load the stock demo: a virtual gallery room, two pedestals, a rigged
   * visitor walking a loop, a security camera, and that camera driving both
   * a POSE stream (full skeleton) and a DETECT stream (one tracked point) —
   * see app/demoscene.ts. Meant as a working example of every piece an
   * installation setup touches, testable with nothing plugged in, and a
   * starting point to replace pieces with real inputs one at a time.
   */
  loadDemoScene(playground = false): void {
    this.ctx.pushUndo();
    const upZ = this.ctx.settings.upAxis === 'Z';
    resetPhysics();
    const wiring = playground ? buildPlaygroundScene(upZ) : buildDemoScene(upZ);
    this.ctx.replaceScene(wiring.scene);
    // runtime wiring: which stream reads from which virtual source. This is
    // NOT scene data (see App.setStreamDriver), so it has to be redone here
    // rather than living inside the scene the undo snapshot just captured.
    driveStreamFromActor(wiring.poseStreamId, wiring.actorId, wiring.camIndex);
    driveStreamFromObject(wiring.detectStreamId, { kind: 'ACTOR', id: wiring.actorId }, wiring.camIndex);
    // The second visitor's script is runtime wiring too, for the same reason
    // the stream drivers are: it is not part of the document.
    behaviourEngine.clear();
    behaviourEngine.onPerform = (actorId, prompt, seconds) => {
      // The synthesiser until the on-device model is loaded, ARDY after —
      // so the demo runs the instant it is opened with nothing downloaded,
      // and upgrades itself the moment you load the model in the Motion
      // panel. The badge says which one is playing.
      void this.generateMotion(
        actorId, prompt, seconds, ardyBackend.ready ? 'ardy' : 'local');
    };
    behaviourEngine.onClearMotion = (actorId) => this.clearGeneratedMotion(actorId);
    actorLog.clear();
    if (wiring.wandererId != null) {
      behaviourEngine.run(wiring.wandererId, wandererScript(upZ), true);
    }
    if (wiring.sketcherId != null) {
      behaviourEngine.run(wiring.sketcherId, sketcherScript(upZ), true);
    }
    this.refreshWidget();
    this.viewAll();
    this.ui.refresh();
  }

  /** Frame just what is selected; falls back to framing everything. */
  viewSelected(): void {
    this.ui?.revealSelection();
    const refs = listSelected(this.ctx.scene);
    if (!refs.length) { this.viewAll(); return; }
    const box = new THREE.Box3();
    for (const r of refs) {
      const root = this.objectRoot(r);
      if (!root) continue;
      const b = new THREE.Box3().setFromObject(root);
      if (!b.isEmpty()) box.union(b);
    }
    // a measurement has no mesh at all — it is drawn on the HUD — so its
    // extent is its own points
    for (const m of this.ctx.scene.measures) {
      if (!m.select) continue;
      for (const p of worldPointsOf(this.ctx.scene, m)) box.expandByPoint(p);
    }
    // actors have no entry in objectRoot — they are their own manager
    for (const a of this.ctx.scene.actors) {
      if (!a.select) continue;
      const root = this.actors.rootFor(a.id);
      if (!root) continue;
      const b = new THREE.Box3().setFromObject(root);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) { this.viewAll(); return; }
    this.nav.frameAll(box);
  }

  viewAll(): void {
    const box = new THREE.Box3();
    for (const g of [this.gp.root, this.canvasGroup, this.splats.group, this.meshes.group, this.polys.group, this.paints.group]) {
      const b = new THREE.Box3().setFromObject(g);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-3, -3, -1), new THREE.Vector3(3, 3, 3));
    this.nav.frameAll(box);
  }

  /** Object-mode Shift+D: clone every selected object, select the clones. */
  duplicateSelectedObjects(): void {
    const scene = this.ctx.scene;
    const refs = listSelected(scene);
    if (!refs.length) return;
    this.ctx.pushUndo();
    let n = 1;
    const newId = () => (Date.now() + n++) % 1e9;
    const clones: ObjRef[] = [];
    for (const ref of refs) {
      if (ref.kind === 'GP') {
        const src = scene.objects[gpIndexOf(scene, ref.id)];
        if (!src) continue;
        const copy = remapGPObjectIds(JSON.parse(JSON.stringify(src)));
        copy.name += ' copy';
        copy.translation = [copy.translation[0] + 0.3, copy.translation[1], copy.translation[2]];
        scene.objects.push(copy);
        clones.push({ kind: 'GP', id: copy.id });
      } else if (ref.kind === 'CANVAS') {
        const src = scene.canvases.find((c) => c.id === ref.id);
        if (!src) continue;
        const copy = { ...JSON.parse(JSON.stringify(src)), id: newId() };
        copy.translation[0] += 0.3;
        scene.canvases.push(copy);
        clones.push({ kind: 'CANVAS', id: copy.id });
      } else if (ref.kind === 'SPLAT') {
        const src = scene.splats.find((s) => s.id === ref.id);
        if (!src) continue;
        const copy = { ...JSON.parse(JSON.stringify(src)), id: newId() };
        copy.translation[0] += 0.3;
        scene.splats.push(copy);
        clones.push({ kind: 'SPLAT', id: copy.id });
      } else if (ref.kind === 'POLY') {
        const src = scene.polyMeshes.find((p) => p.id === ref.id);
        if (!src) continue;
        // element ids are per-mesh, so a deep copy keeps them valid
        const copy = { ...JSON.parse(JSON.stringify(src)), id: newId() };
        copy.name += ' copy';
        copy.translation[0] += 0.3;
        scene.polyMeshes.push(copy);
        clones.push({ kind: 'POLY', id: copy.id });
      } else if (ref.kind === 'PCLOUD') {
        const src = scene.paintClouds.find((c) => c.id === ref.id);
        if (!src) continue;
        const copy = { ...JSON.parse(JSON.stringify(src)), id: newId() };
        copy.name += ' copy';
        copy.translation[0] += 0.3;
        scene.paintClouds.push(copy);
        clones.push({ kind: 'PCLOUD', id: copy.id });
      } else if (ref.kind === 'MEASURE') {
        // (the fallthrough below assumes "anything else is a mesh", so a
        // measurement used to vanish from a Shift+D without a word). Free
        // points ride the copy's offset; BOUND points stay on their targets,
        // which is what binding means.
        const src = scene.measures.find((m) => m.id === ref.id);
        if (!src) continue;
        const copy = { ...JSON.parse(JSON.stringify(src)), id: newId(), select: false };
        copy.name += ' copy';
        copy.translation[0] += 0.3;
        scene.measures.push(copy);
        clones.push({ kind: 'MEASURE', id: copy.id });
      } else {
        const src = scene.meshes.find((m) => m.id === ref.id);
        if (!src) continue;
        const copy = { ...JSON.parse(JSON.stringify(src)), id: newId() };
        copy.translation[0] += 0.3;
        scene.meshes.push(copy);
        clones.push({ kind: 'MESH', id: copy.id });
      }
    }
    deselectAllObjects(scene);
    for (const ref of clones) setObjectSelected(scene, ref, true);
    this.syncCanvases();
    this.gp.markDirty();
    this.refreshWidget();
    this.ui.refresh();
  }

  /** Shift+A (Blender): Add menu anchored at the mouse. New objects spawn
   *  at the 3D CURSOR by default (Blender parity) — Traveler/Trigger stay
   *  pointer-relative ("...here") since a traveler must land ON the actual
   *  stroke under the pointer to attach FOLLOW_PATH, and a trigger placed
   *  "here" is a deliberately different action from placing one at the
   *  cursor (already offered via the object Add submenu / cursor moves). */
  openAddMenu(): void {
    const ctx = this.ctx;
    const px = this.tools.lastPointer;
    const rect = ctx.canvas.getBoundingClientRect();
    const clientX = px.x + rect.left, clientY = px.y + rect.top;
    const strokeHit = nearestStrokePointAll(ctx, px.x, px.y, 60, 'ANY');
    const pointerWorld = strokeHit ?? screenToWorld(ctx, clientX, clientY);
    const cursorAt: [number, number, number] = [...ctx.scene.cursor];
    const hereAt: [number, number, number] = pointerWorld ? [pointerWorld.x, pointerWorld.y, pointerWorld.z] : cursorAt;
    this.ui.openContextMenu(clientX, clientY, [
      { header: 'Add — at 3D cursor' },
      { label: 'Grease Pencil (blank)', icon: 'pencil', do: () => this.addGPObject(cursorAt) },
      { label: 'Plane', icon: 'square', do: () => this.addMeshObject('PLANE', undefined, cursorAt) },
      { label: 'Box', icon: 'cube', do: () => this.addMeshObject('BOX', undefined, cursorAt) },
      { label: 'Sphere', icon: 'circle', do: () => this.addMeshObject('SPHERE', undefined, cursorAt) },
      { label: 'Pyramid', icon: 'cube', do: () => this.addMeshObject('PYRAMID', undefined, cursorAt) },
      { label: 'Cylinder', icon: 'cylinder', do: () => this.addMeshObject('CYLINDER', undefined, cursorAt) },
      { label: 'Editable Mesh', icon: 'wireframe', do: () => this.addPolyMeshObject(cursorAt) },
      { label: 'Empty', icon: 'target', do: () => this.addMeshObject('EMPTY', undefined, cursorAt) },
      { label: 'Actor (mannequin)', icon: 'actor', do: () => this.addActor(cursorAt) },
      { sep: true },
      { label: 'Sun light', icon: 'boltCircle', do: () => this.addLight('SUN', cursorAt) },
      { label: 'Point light', icon: 'boltCircle', do: () => this.addLight('POINT', cursorAt) },
      { label: 'Spot light', icon: 'boltCircle', do: () => this.addLight('SPOT', cursorAt) },
      { sep: true },
      { label: 'Traveler here', icon: 'cursorArrow', do: () => this.addTravelerObjectAt(hereAt, px.x, px.y), disabled: !strokeHit },
      { label: 'Trigger here', icon: 'boltCircle', do: () => this.addTriggerAt(hereAt) },
      { sep: true },
      { label: 'Move 3D cursor here', icon: 'target', do: () => { ctx.scene.cursor = hereAt; this.gp.markDirty(); } },
    ]);
  }

  addTriggerAt(pos: [number, number, number]): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const id = scoreId(scene);
    scene.score.triggers.push({
      id, name: `Trigger ${id}`, position: [...pos],
      radius: 0.25, retrigger: true,
      messages: [{ address: `/trigger/${id}`, argExprs: ['1'] }],
    });
    this.ui.refresh();
  }

  /** Constraint-era traveler: a small sphere with FOLLOW_PATH bound to the
   *  stroke under the pointer, phase set to where you clicked. */
  addTravelerObjectAt(at: [number, number, number], screenX: number, screenY: number): void {
    const scene = this.ctx.scene;
    const path = this.pathUnderPointer(screenX, screenY);
    if (!path) return;
    this.ctx.pushUndo();
    const id = Date.now() % 1e9;
    const mesh = createMeshObject(id, 'SPHERE', at);
    mesh.name = `Traveler ${id % 1000}`;
    mesh.scale = [0.12, 0.12, 0.12];
    mesh.color = [1, 0.6, 0.15];
    mesh.unlit = true;
    mesh.drawTarget = false;
    const fp = createConstraint('FOLLOW_PATH');
    fp.path = path;
    fp.phase = this.score.nearestPhase(scene, path, new THREE.Vector3(...at)) ?? 0;
    mesh.constraints = [fp];
    scene.meshes.push(mesh);
    this.meshes.sync(scene);
    this.ui.refresh();
  }

  /** Nearest stroke (as a PathRef) to a canvas-local pointer position. */
  private pathUnderPointer(screenX: number, screenY: number): { objectIndex: number; layerId: number; strokeId: number } | null {
    const scene = this.ctx.scene;
    const cursor = new THREE.Vector2(screenX, screenY);
    type Best = { d: number; path: { objectIndex: number; layerId: number; strokeId: number } };
    let best: Best | null = null as Best | null;
    const saveActive = scene.activeObject;
    try {
      scene.objects.forEach((ob, oi) => {
        scene.activeObject = oi;
        for (const layer of ob.layers) {
          if (layer.hide) continue;
          const f = frameAt(layer, scene.frame);
          if (!f) continue;
          for (const s of f.strokes) {
            // distance to SEGMENTS in screen space, not just sampled points
            // (a 2-point stroke has interior area a point test would miss)
            let prev = objectToScreen(this.ctx, s.points[0].co);
            for (let i = 1; i < s.points.length; i++) {
              const next = objectToScreen(this.ctx, s.points[i].co);
              const ab = next.clone().sub(prev);
              const len2 = ab.lengthSq();
              const k = len2 > 1e-9 ? THREE.MathUtils.clamp(cursor.clone().sub(prev).dot(ab) / len2, 0, 1) : 0;
              const d = prev.clone().addScaledVector(ab, k).distanceTo(cursor);
              if (d < 60 && (!best || d < best.d)) {
                best = { d, path: { objectIndex: oi, layerId: layer.id, strokeId: s.id } };
              }
              prev = next;
            }
          }
        }
      });
    } finally {
      scene.activeObject = saveActive;
    }
    return best?.path ?? null;
  }

  /** Shift+T: drop a trigger sphere at the current 3D cursor. */
  addTriggerAtCursor(): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const id = scoreId(scene);
    scene.score.triggers.push({
      id, name: `Trigger ${id}`, position: [...scene.cursor] as [number, number, number],
      radius: 0.25, retrigger: true,
      messages: [{ address: `/trigger/${id}`, argExprs: ['1'] }],
    });
    this.ui.refresh();
  }

  /** Shift+G: ride a traveler on whichever stroke point is nearest the 3D
   *  cursor — the "drag the cursor along a stroke, then drop a traveler"
   *  workflow (Shift+RMB drag positions the cursor; this places the
   *  traveler where it landed). */
  addTravelerNearestStroke(): void {
    const scene = this.ctx.scene;
    const cursor = new THREE.Vector3(...scene.cursor);
    let best: { d: number; layerId: number; strokeId: number } | null = null;
    const ob = activeObject(scene);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const f = frameAt(layer, scene.frame);
      if (!f) continue;
      for (const s of f.strokes) for (const p of s.points) {
        const d = new THREE.Vector3(...p.co).applyMatrix4(m).distanceTo(cursor);
        if (!best || d < best.d) best = { d, layerId: layer.id, strokeId: s.id };
      }
    }
    if (!best) return;
    this.ctx.pushUndo();
    const path = { objectIndex: scene.activeObject, layerId: best.layerId, strokeId: best.strokeId };
    scene.score.cursors.push(defaultCursor(scene, path));
    this.ui.refresh();
  }

  /**
   * Save every selected object to the Library.
   *
   * A scan or a model whose file only exists as a session `blob:` URL (an
   * import from before files were stored) is copied into the file store
   * first — otherwise the asset would point at nothing after a reload,
   * which is the one thing a library entry must not do.
   */
  async saveSelectedAsAsset(): Promise<void> {
    const scene = this.ctx.scene;
    const refs = listSelected(scene).filter((r) => r.kind === 'GP' || r.kind === 'MESH' || r.kind === 'SPLAT' || r.kind === 'POLY');
    if (!refs.length) { this.setStatusHint('Select a drawing, a mesh, a model or a scan to add it to the Library'); return; }
    for (const ref of refs) {
      const thumb = this.thumbFor(ref) ?? undefined;
      if (ref.kind === 'GP') {
        const ob = scene.objects.find((o) => o.id === ref.id);
        if (ob) saveAsset(ob.name, 'GP', serializeGPObject(ob), thumb);
      } else if (ref.kind === 'POLY') {
        const pm = scene.polyMeshes.find((x) => x.id === ref.id);
        if (!pm) continue;
        const { id, parent, select, ...def } = pm;
        void id; void parent; void select;
        saveAsset(pm.name, 'POLY', JSON.stringify(def), thumb);
      } else if (ref.kind === 'MESH') {
        const m = scene.meshes.find((x) => x.id === ref.id);
        if (!m) continue;
        if (m.src) m.src = await this.ensureStored(m.src, m.name);
        saveAsset(m.name, 'MESH', meshAssetPayload(m), thumb);
      } else {
        const sp = scene.splats.find((x) => x.id === ref.id);
        if (!sp) continue;
        sp.src = await this.ensureStored(sp.src, sp.name);
        saveAsset(sp.name, 'SPLAT', splatAssetPayload(sp), thumb);
      }
    }
    this.setStatusHint(`Added ${refs.length} to the Library`);
  }

  /** A session `blob:` source copied into the file store; anything already
   *  stored, or remote, is returned as it is. */
  private async ensureStored(src: string, name: string): Promise<string> {
    if (!src.startsWith('blob:')) return src;
    try {
      const blob = await (await fetch(src)).blob();
      return await putFile(blob, name.replace(/\s*\(session only\)$/, ''));
    } catch { return src; }
  }

  /**
   * Place a Library asset — at the pointer when it was dragged in, at the 3D
   * cursor when it was clicked.
   */
  addAssetToScene(asset: TGAsset, dropped?: DropTarget): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const at = dropped ?? this.cursorTarget();
    const point = at.point;
    if (asset.kind === 'GP') {
      importGPObjects(scene, asset.payload);
      const ob = scene.objects[scene.objects.length - 1];
      ob.translation = [...point];
      scene.activeObject = scene.objects.length - 1;
      this.gp.markDirty();
    } else if (asset.kind === 'POLY') {
      const def = JSON.parse(asset.payload);
      let id = Date.now() % 1e9;
      while (scene.polyMeshes.some((p) => p.id === id)) id++;
      scene.polyMeshes.push({ ...def, id, parent: null, select: false, translation: [...point], rev: 0 });
    } else if (asset.kind === 'STREAM') {
      // a camera goes on as a picture of itself: an unlit plane whose
      // texture IS the stream, at the camera's own aspect
      const { key, label } = JSON.parse(asset.payload) as { key: string; label: string };
      const src = liveSources.get(key);
      const aspect = src && src.canvas.width > 64 ? src.canvas.width / src.canvas.height : 16 / 9;
      const mesh = createMeshObject(Date.now() % 1e9, 'PLANE', [...point] as Vec3);
      mesh.name = label;
      mesh.texture = `${LIVE_PREFIX}${key}`;
      mesh.unlit = true;
      mesh.drawTarget = false;
      mesh.opacity = 1;
      mesh.scale = [aspect * 0.5, 0.5, 1];
      if (at) this.orientPanel(mesh, at);
      scene.meshes.push(mesh);
      this.meshes.sync(scene, this.nav.active);
    } else if (asset.kind === 'MESH') {
      const def = JSON.parse(asset.payload);
      const id = Date.now() % 1e9;
      const placed = { ...def, id, parent: null, select: false, translation: [...point] };
      // an image hangs on the wall it is dropped on, as a direct drop does
      if (def.kind === 'PLANE' && at) this.orientPanel(placed, at);
      scene.meshes.push(placed);
      this.meshes.sync(scene);
      if (def.kind === 'MODEL') this.placing.push({ ref: { kind: 'MESH', id }, ground: point, since: performance.now() });
    } else {
      const def = JSON.parse(asset.payload);
      scene.splats.push({ ...def, id: Date.now() % 1e9, parent: null, select: false, translation: [...point] });
    }
    this.ui.refresh();
  }

  /**
   * Where a Library asset lands when it is PLACED rather than dragged (a
   * double-click on its tile): at the 3D cursor, resolved through the same
   * settings a drawn point is. The magnet's lattice rounds the position;
   * the PLANE decides how an image faces — Up from Ground stands it
   * upright on the floor facing the view, Top lays it flat, Front / Side
   * hang it on that plane, View (and None) turn it to the camera.
   */
  cursorTarget(): DropTarget {
    const ctx = this.ctx;
    const s = ctx.settings;
    let p = new THREE.Vector3(...ctx.scene.cursor);
    if (s.snap.enabled && (s.snap.mode === 'INCREMENT' || s.snap.mode === 'GRID')) p = snapToLattice(ctx, p);
    const point: Vec3 = [p.x, p.y, p.z];
    const zUp = s.upAxis === 'Z';
    const towardCam = (n: THREE.Vector3) => {
      const toCam = this.nav.active.getWorldPosition(new THREE.Vector3()).sub(p);
      return n.dot(toCam) < 0 ? n.negate() : n;
    };
    switch (s.plane) {
      case 'UPRIGHT':
        return { point, normal: null, onSurface: false };
      case 'TOP':
        return { point, normal: zUp ? [0, 0, 1] : [0, 1, 0], onSurface: false, flat: true };
      case 'FRONT':
      case 'SIDE': {
        const n = towardCam(s.plane === 'SIDE' ? new THREE.Vector3(1, 0, 0)
          : zUp ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
        return { point, normal: [n.x, n.y, n.z], onSurface: true };
      }
      default: {
        const n = this.nav.active.getWorldDirection(new THREE.Vector3()).negate();
        return { point, normal: [n.x, n.y, n.z], onSurface: true };
      }
    }
  }

  /**
   * Where a drop lands: on whatever is under the pointer — a wall, the floor
   * of a scan, a plinth — else on the ground plane, else at the 3D cursor.
   * The NORMAL comes along so an image can hang on the wall it was dropped
   * on rather than lying on the floor in front of it.
   */
  dropTarget(clientX: number, clientY: number): DropTarget {
    const ctx = this.ctx;
    const rect = ctx.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), ctx.camera);
    const targets = [...ctx.pickableMeshes, ...this.splats.group.children.filter((c) => !c.userData.splatRenderer)];
    const hit = ray.intersectObjects(targets, true).find((h) => h.object.visible);
    if (hit) {
      const n = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : null;
      if (n && n.dot(ray.ray.direction) > 0) n.negate();
      return { point: [hit.point.x, hit.point.y, hit.point.z], normal: n ? [n.x, n.y, n.z] : null, onSurface: true };
    }
    const up = ctx.settings.upAxis === 'Z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const out = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(up, 0), out)) {
      return { point: [out.x, out.y, out.z], normal: [up.x, up.y, up.z], onSurface: false };
    }
    return { point: [...ctx.scene.cursor] as Vec3, normal: null, onSurface: false };
  }

  /**
   * Bring files into the scene — dropped on the viewport, or picked from the
   * File menu — each as what it is: a scan, a model, an image, a drawing.
   *
   * The FILE goes into the store first, so the scene refers to something
   * that survives a reload. Several files dropped together are spaced out
   * along the view's right-hand direction instead of landing in one heap.
   */
  async importFiles(files: File[], at?: DropTarget): Promise<void> {
    const scene = this.ctx.scene;
    const target = at ?? { point: [...scene.cursor] as Vec3, normal: null, onSurface: false };
    const right = new THREE.Vector3().setFromMatrixColumn(this.nav.active.matrixWorld, 0);
    const upZ = this.ctx.settings.upAxis === 'Z';
    let placed = 0;
    let pushed = false;
    const skipped: string[] = [];
    for (const file of files) {
      const kind = await classifyFile(file);
      if (!kind) { skipped.push(file.name); continue; }
      if (!pushed) { this.ctx.pushUndo(); pushed = true; }
      const p = new THREE.Vector3(...target.point).addScaledVector(right, placed * 1.5);
      const point: Vec3 = [p.x, p.y, p.z];
      if (kind === 'GP_JSON') {
        await this.importGPFile(file);
        const ob = scene.objects[scene.objects.length - 1];
        if (ob && at) ob.translation = [...point];
      } else if (kind === 'IMAGE') {
        this.importImagePlane(file, { ...target, point });
      } else {
        const ref = await putFile(file);
        const id = Date.now() % 1e9 + placed;
        if (kind === 'SPLAT') {
          scene.splats.push({
            id, name: file.name, src: ref, translation: point, rotation: [0, 0, 0],
            scale: 1, visible: true, select: false, parent: null,
          });
        } else {
          const mesh = createMeshObject(id, 'MODEL', point, ref);
          mesh.name = file.name;
          if (upZ && isYUpModel(file.name)) mesh.rotation = [Math.PI / 2, 0, 0];
          scene.meshes.push(mesh);
          this.placing.push({ ref: { kind: 'MESH', id }, ground: point, since: performance.now() });
        }
      }
      placed++;
    }
    this.meshes.sync(scene, this.nav.active);
    this.ui.refresh();
    if (skipped.length) this.setStatusHint(`Not a format I can open: ${skipped.join(', ')}`, 5000);
    else if (placed) this.setStatusHint(`Placed ${placed} file${placed > 1 ? 's' : ''}`);
  }

  /**
   * Models whose geometry is still loading, waiting to be SET DOWN.
   *
   * A model's origin is wherever its author left it — usually its centre —
   * so placing the origin at the drop point would bury half of it in the
   * floor. Once it has loaded, it is lifted until its lowest point rests on
   * the height it was dropped at, which is what "put this here" means in
   * every level editor.
   */
  private placing: { ref: ObjRef; ground: Vec3; since: number }[] = [];

  private settlePlacements(): void {
    if (!this.placing.length) return;
    const up = this.ctx.settings.upAxis === 'Z' ? 2 : 1;
    const now = performance.now();
    this.placing = this.placing.filter((p) => {
      if (now - p.since > 60000) return false;           // never loaded: give up
      const root = this.meshes.rootFor(p.ref.id);
      if (!root) return true;
      let hasGeo = false;
      root.traverse((o) => { if ((o as THREE.Mesh).geometry) hasGeo = true; });
      if (!hasGeo) return true;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return true;
      const m = this.ctx.scene.meshes.find((x) => x.id === p.ref.id);
      if (m && !m.parent) {
        const t = [...m.translation] as Vec3;
        t[up] += p.ground[up] - box.min.getComponent(up);
        m.translation = t;
      }
      return false;
    });
  }

  /**
   * A small picture of one object, for its Library tile: rendered alone,
   * from a three-quarter view fitted to its bounds, over a dark ground.
   * Isolated by visibility like the selection rims, keeping the lights (a
   * model is black without them) and Spark's renderer (which draws every
   * splat). Null when there is nothing loaded to picture yet.
   */
  private thumbFor(ref: ObjRef): string | null {
    const root = ref.kind === 'SPLAT' ? this.splats.meshFor(ref.id) : this.silhouetteRoot(ref) ?? this.objectRoot(ref);
    const box = ref.kind === 'SPLAT' ? this.splatCore(ref) : this.computeObjectBox(ref);
    if (!root || !box || box.isEmpty()) return null;
    const keep = root;
    const path = new Set<THREE.Object3D>();
    for (let p = root.parent; p; p = p.parent) path.add(p);
    const hidden: THREE.Object3D[] = [];
    const walk = (o: THREE.Object3D) => {
      for (const c of o.children) {
        if (c === keep) continue;
        if (path.has(c)) { walk(c); continue; }
        if (c.userData.splatRenderer || (c as THREE.Light).isLight) continue;
        // a group HOLDING lights (Solid shading's studio rig) is walked
        // into, not hidden — hiding it rendered everything black
        if (hasLight(c)) { walk(c); continue; }
        if (c.visible) { c.visible = false; hidden.push(c); }
      }
    };
    walk(this.scene3);
    try { return this.renderThumbnail(this.scene3, box); }
    finally { for (const o of hidden) o.visible = true; }
  }

  /** Render `scene` from a three-quarter view fitted to `box` into a small
   *  JPEG — the picture on a Library tile. */
  private renderThumbnail(scene: THREE.Scene, box: THREE.Box3): string | null {
    const SIZE = 160;
    const upZ = this.ctx.settings.upAxis === 'Z';
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.05, box.getSize(new THREE.Vector3()).length() / 2);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
    cam.up.set(0, upZ ? 0 : 1, upZ ? 1 : 0);
    const dir = (upZ ? new THREE.Vector3(0.55, -0.75, 0.42) : new THREE.Vector3(0.55, 0.42, 0.75)).normalize();
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05;
    cam.position.copy(centre).addScaledVector(dir, dist);
    cam.near = Math.max(0.01, dist - radius * 2);
    cam.far = dist + radius * 2;
    cam.lookAt(centre);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const rt = new THREE.WebGLRenderTarget(SIZE, SIZE);
    rt.texture.colorSpace = THREE.SRGBColorSpace;   // encode like the screen, or it comes out dark
    const saved = { bg: scene.background, fog: scene.fog, target: this.glRenderer.getRenderTarget() };
    scene.background = new THREE.Color(0x202024);
    scene.fog = null;
    try {
      this.glRenderer.setRenderTarget(rt);
      this.glRenderer.clear();
      this.glRenderer.render(scene, cam);
      const px = new Uint8Array(SIZE * SIZE * 4);
      this.glRenderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, px);
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const g = canvas.getContext('2d')!;
      const img = g.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) {                  // GL rows run bottom-up
        img.data.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
      }
      g.putImageData(img, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
      this.glRenderer.setRenderTarget(saved.target);
      scene.background = saved.bg;
      scene.fog = saved.fog;
      rt.dispose();
    }
  }

  /**
   * The part of a scan worth framing: the 5th to 95th percentile of its
   * splat centres on each axis.
   *
   * A scan's real bounds include its FLOATERS — stray gaussians metres out
   * in the air, which every capture has — so a picture fitted to them shows
   * the room as a speck in the middle of nothing. Percentiles ignore the
   * few that wander off and keep the mass. Sampled (at most ~20k centres),
   * since this is for a thumbnail, not a measurement.
   */
  private splatCore(ref: ObjRef): THREE.Box3 | null {
    return this.splatCoreOf(this.splats.meshFor(ref.id));
  }

  private splatCoreOf(obj: THREE.Object3D | null): THREE.Box3 | null {
    const mesh = obj as unknown as {
      packedSplats?: { getNumSplats(): number; forEachSplat(cb: (i: number, c: THREE.Vector3) => void): void };
      matrixWorld: THREE.Matrix4;
    } | null;
    const packed = mesh?.packedSplats;
    const n = packed?.getNumSplats() ?? 0;
    if (!mesh || !packed || !n) return null;
    const step = Math.max(1, Math.floor(n / 20000));
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    packed.forEachSplat((i, c) => {
      if (i % step) return;
      xs.push(c.x); ys.push(c.y); zs.push(c.z);
    });
    const q = (v: number[], f: number) => { v.sort((a, b) => a - b); return v[Math.floor((v.length - 1) * f)]; };
    const box = new THREE.Box3(
      new THREE.Vector3(q(xs, 0.05), q(ys, 0.05), q(zs, 0.05)),
      new THREE.Vector3(q(xs, 0.95), q(ys, 0.95), q(zs, 0.95)),
    );
    return box.applyMatrix4(mesh.matrixWorld);
  }

  // ------------------------------------------------------------ Library

  /**
   * Files dropped on the LIBRARY become entries in it and nothing else: the
   * Library is a container of things to place, and a drop on it used to
   * place the file in the scene too (it went through the viewport's
   * importer). Each file is stored (io/blobstore.ts), described as the
   * object it would become, and pictured.
   */
  async importToLibrary(files: File[]): Promise<void> {
    const upZ = this.ctx.settings.upAxis === 'Z';
    let added = 0;
    const skipped: string[] = [];
    for (const file of files) {
      const kind = await classifyFile(file);
      if (!kind) { skipped.push(file.name); continue; }
      if (kind === 'IMAGE') {
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = dataUrl;
        });
        const mesh = createMeshObject(0, 'PLANE', [0, 0, 0]);
        mesh.name = file.name;
        mesh.texture = dataUrl;
        mesh.unlit = true;
        mesh.drawTarget = false;
        mesh.opacity = 1;
        const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        mesh.scale = [aspect * 0.5, 0.5, 1];
        saveAsset(file.name, 'MESH', meshAssetPayload(mesh), imageThumb(img));
      } else if (kind === 'GP_JSON') {
        const text = await file.text();
        saveAsset(file.name.replace(/\.json$/i, ''), 'GP', text);
      } else {
        const src = await putFile(file);
        if (kind === 'SPLAT') {
          const def = { name: file.name, src, translation: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: 1, visible: true };
          const asset = saveAsset(file.name, 'SPLAT', JSON.stringify(def));
          void this.studioThumb('SPLAT', def).then((t) => { if (t) updateAsset(asset.id, { thumb: t }); });
        } else {
          const mesh = createMeshObject(0, 'MODEL', [0, 0, 0], src);
          mesh.name = file.name;
          if (upZ && isYUpModel(file.name)) mesh.rotation = [Math.PI / 2, 0, 0];
          const asset = saveAsset(file.name, 'MESH', meshAssetPayload(mesh));
          void this.studioThumb('MESH', mesh).then((t) => { if (t) updateAsset(asset.id, { thumb: t }); });
        }
      }
      added++;
    }
    if (skipped.length) this.setStatusHint(`Not a format I can open: ${skipped.join(', ')}`, 5000);
    else if (added) this.setStatusHint(`Added ${added} to the Library`);
  }

  /**
   * A picture of a model or scan that is NOT in the scene: it is loaded into
   * a private "studio" — its own MeshManager or SplatManager, its own
   * lights, the scene's environment — rendered once it has arrived, and
   * thrown away. Nothing appears in the scene, the outliner or the undo
   * history while it loads.
   */
  private async studioThumb(kind: 'MESH' | 'SPLAT', def: object): Promise<string | undefined> {
    const STAGE_ID = -7;
    const studio = new THREE.Scene();
    studio.environment = this.scene3.environment;
    studio.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(3, -4, 6);
    studio.add(sun);
    const base = { ...this.ctx.scene, meshes: [], splats: [] } as GPScene;
    const entity = { ...def, id: STAGE_ID, parent: null, select: false, visible: true, translation: [0, 0, 0] };
    const staged = kind === 'MESH' ? { ...base, meshes: [entity] } as unknown as GPScene
      : { ...base, splats: [entity] } as unknown as GPScene;
    const mm = kind === 'MESH' ? new MeshManager() : null;
    const sm = kind === 'SPLAT' ? new SplatManager() : null;
    if (mm) studio.add(mm.group);
    if (sm) { sm.init(this.glRenderer); studio.add(sm.group); }
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let t = 0; t < 400; t++) {          // up to ~60 s for a big scan
        mm?.sync(staged);
        sm?.sync(staged);
        let box: THREE.Box3 | null = null;
        if (mm) {
          const root = mm.rootFor(STAGE_ID);
          let geo = false;
          root?.traverse((o) => { if ((o as THREE.Mesh).geometry) geo = true; });
          if (root && geo) { root.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(root); }
        } else {
          const m = sm!.meshFor(STAGE_ID);
          if (m) { m.updateMatrixWorld(true); box = this.splatCoreOf(m); }
        }
        if (box && !box.isEmpty()) {
          // Spark sorts its splats during a render, so the first frame can
          // come out empty: render a couple before keeping one
          this.renderThumbnail(studio, box);
          await wait(120);
          this.renderThumbnail(studio, box);
          await wait(120);
          return this.renderThumbnail(studio, box) ?? undefined;
        }
        await wait(150);
      }
      return undefined;
    } catch (err) {
      console.warn('library thumbnail:', err);
      return undefined;
    } finally {
      mm?.sync(base);
      sm?.sync(base);
    }
  }

  /**
   * Render the view (as it is) or the SELECTION (alone, on a transparent
   * background, cropped to what it drew) into a PNG, and keep it in the
   * Library as an image — a reference board of your own views, or a cut-out
   * to hang in the scene. The scene look (post) is not applied: the render
   * is the scene's own colours.
   */
  renderToLibrary(mode: 'VIEW' | 'SELECTION'): void {
    const scene = this.ctx.scene;
    const refs = mode === 'SELECTION' ? listSelected(scene) : [];
    if (mode === 'SELECTION' && !refs.length) { this.setStatusHint('Select something to render it'); return; }
    const canvas = this.glRenderer.domElement;
    const k = Math.min(1, 2048 / Math.max(canvas.width, canvas.height));
    const W = Math.round(canvas.width * k), H = Math.round(canvas.height * k);
    const hidden: THREE.Object3D[] = [];
    if (mode === 'SELECTION') {
      const keep = new Set<THREE.Object3D>();
      for (const r of refs) {
        const root = r.kind === 'SPLAT' ? this.splats.meshFor(r.id) : this.silhouetteRoot(r) ?? this.objectRoot(r);
        if (root) keep.add(root);
      }
      const path = new Set<THREE.Object3D>();
      for (const root of keep) for (let p = root.parent; p; p = p.parent) path.add(p);
      const walk = (o: THREE.Object3D) => {
        for (const c of o.children) {
          if (keep.has(c)) continue;
          if (path.has(c)) { walk(c); continue; }
          if (c.userData.splatRenderer || (c as THREE.Light).isLight) continue;
        // a group HOLDING lights (Solid shading's studio rig) is walked
        // into, not hidden — hiding it rendered everything black
        if (hasLight(c)) { walk(c); continue; }
          if (c.visible) { c.visible = false; hidden.push(c); }
        }
      };
      walk(this.scene3);
    } else {
      // the view as it LOOKS, minus the editor's furniture: grid, gizmo,
      // helpers, selection glyphs, the 3D cursor (all `markOverlay`ed)
      const furniture: THREE.Object3D[] = [this.grid, this.widget.getHelper()];
      this.scene3.traverse((o) => { if (o.userData.overlay && o.visible) furniture.push(o); });
      for (const o of furniture) if (o?.visible) { o.visible = false; hidden.push(o); }
    }
    // the selection/hover rims ride INSIDE the objects (inverted hulls), so
    // they would be in either render; they are interface, not the thing
    this.scene3.traverse((o) => { if (o.userData.hoverShell && o.visible) { o.visible = false; hidden.push(o); } });
    // no MSAA target: reading pixels back from one came out black (alpha
    // survived, colour did not) — render at up to 2x instead where it fits
    const rt = new THREE.WebGLRenderTarget(W, H);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const saved = { bg: this.scene3.background, target: this.glRenderer.getRenderTarget(), clear: this.glRenderer.getClearAlpha() };
    const px = new Uint8Array(W * H * 4);
    try {
      if (mode === 'SELECTION') { this.scene3.background = null; this.glRenderer.setClearAlpha(0); }
      this.glRenderer.setRenderTarget(rt);
      this.glRenderer.clear();
      this.glRenderer.render(this.scene3, this.nav.active);
      this.glRenderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
    } finally {
      this.glRenderer.setRenderTarget(saved.target);
      this.scene3.background = saved.bg;
      this.glRenderer.setClearAlpha(saved.clear);
      for (const o of hidden) o.visible = true;
      rt.dispose();
    }
    // rows come bottom-up; flip, and for a selection find the drawn box
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    const img = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4;
      img.data.set(px.subarray(src, src + W * 4), y * W * 4);
      if (mode === 'SELECTION') {
        for (let x = 0; x < W; x++) if (px[src + x * 4 + 3] > 2) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (mode === 'SELECTION' && x1 < 0) { this.setStatusHint('The selection drew nothing in this view'); return; }
    const full = document.createElement('canvas');
    full.width = W; full.height = H;
    full.getContext('2d')!.putImageData(img, 0, 0);
    let out = full;
    if (mode === 'SELECTION') {
      const pad = 8;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
      out = document.createElement('canvas');
      out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
      out.getContext('2d')!.drawImage(full, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    }
    const url = out.toDataURL('image/png');
    const name = mode === 'VIEW' ? `View ${new Date().toLocaleTimeString()}`
      : `${refs.length === 1 ? (this.nameOf(refs[0]) ?? 'Selection') : `${refs.length} objects`} render`;
    const mesh = createMeshObject(0, 'PLANE', [0, 0, 0]);
    mesh.name = name;
    mesh.texture = url;
    mesh.unlit = true;
    mesh.drawTarget = false;
    mesh.opacity = 1;
    const aspect = out.width / Math.max(1, out.height);
    mesh.scale = [aspect * 0.5, 0.5, 1];
    const pic = new Image();
    pic.onload = () => {
      saveAsset(name, 'MESH', meshAssetPayload(mesh), imageThumb(pic));
      this.setStatusHint(`${name} added to the Library`);
    };
    pic.src = url;
  }

  private nameOf(ref: ObjRef): string | null {
    const s = this.ctx.scene;
    switch (ref.kind) {
      case 'GP': return s.objects.find((o) => o.id === ref.id)?.name ?? null;
      case 'MESH': return s.meshes.find((o) => o.id === ref.id)?.name ?? null;
      case 'SPLAT': return s.splats.find((o) => o.id === ref.id)?.name ?? null;
      case 'POLY': return s.polyMeshes.find((o) => o.id === ref.id)?.name ?? null;
      case 'ACTOR': return s.actors.find((o) => o.id === ref.id)?.name ?? null;
      default: return null;
    }
  }

  /** Download the whole Library as one zip (records, pictures, files). */
  async exportLibrary(): Promise<void> {
    this.setStatusHint('Packing the Library…', 10000);
    const blob = await packLibrary();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `library-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.setStatusHint(`Library exported (${(blob.size / 1048576).toFixed(1)} MB)`);
  }

  /** Import a Library zip, or a folder (an exported Library, or any folder of
   *  scans, models and images — those come in as new entries). */
  async importLibraryFrom(files: File[]): Promise<void> {
    let entries = new Map<string, Blob>();
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) entries = await zipEntries(files[0]);
    else for (const f of files) entries.set((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, f);
    const { added, loose } = await importLibrary(entries);
    if (loose.length) await this.importToLibrary(loose);
    else this.setStatusHint(`Imported ${added} asset${added === 1 ? '' : 's'} into the Library`);
    this.ui.refresh();
  }

  // ------------------------------------------------------- live cameras

  /** Open a camera (the default, or a device) and list it in the Library. */
  async openCamera(deviceId?: string): Promise<void> {
    try {
      const src = await liveSources.open(deviceId);
      if (!streamAsset(src.key)) {
        saveAsset(src.label, 'STREAM', JSON.stringify({ key: src.key, label: src.label, deviceId: src.deviceId }));
      }
      this.ui.refresh();
    } catch (err) {
      this.setStatusHint(`Camera: ${err instanceof Error ? err.message : String(err)}`, 5000);
    }
  }

  /** The generated test camera, in the Library like any other camera. */
  openTestCamera(): void {
    const src = liveSources.openTest();
    if (!streamAsset(src.key)) {
      saveAsset(src.label, 'STREAM', JSON.stringify({ key: src.key, label: src.label, deviceId: '' }));
    }
    this.ui.refresh();
  }

  /** The test card: a still image in the Library, placed like any image. */
  addTestCard(): void {
    const url = testCardDataUrl();
    const mesh = createMeshObject(0, 'PLANE', [0, 0, 0]);
    mesh.name = 'Test Card';
    mesh.texture = url;
    mesh.unlit = true;
    mesh.drawTarget = false;
    mesh.opacity = 1;
    mesh.scale = [16 / 9 * 0.5, 0.5, 1];
    const img = new Image();
    img.onload = () => {
      saveAsset('Test Card', 'MESH', meshAssetPayload(mesh), imageThumb(img));
      this.setStatusHint('Test card added to the Library');
    };
    img.src = url;
  }

  async cameraDevices(): Promise<{ id: string; label: string }[]> {
    return (await liveSources.devices()).map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  liveAction(key: string, action: 'pause' | 'resume' | 'close'): void {
    if (action === 'pause') liveSources.pause(key);
    else if (action === 'close') liveSources.close(key);
    else void liveSources.resume(key).catch((err) => this.setStatusHint(`Camera: ${err}`, 5000));
    this.ui.refresh();
  }

  /** Library tiles and the capture panel show a camera through small
   *  canvases tagged `data-live`; repainted from the source a few times a
   *  second (the source canvas itself stays where the texture reads it). */
  private livePreviewAt = 0;
  private paintLivePreviews(): void {
    const now = performance.now();
    if (now - this.livePreviewAt < 100) return;
    this.livePreviewAt = now;
    for (const c of document.querySelectorAll<HTMLCanvasElement>('canvas[data-live]')) {
      const src = liveSources.get(c.dataset.live!);
      if (!src || src.canvas.width < 2) continue;
      const g = c.getContext('2d');
      if (!g) continue;
      const w = c.width, h = c.height;
      const s = Math.max(w / src.canvas.width, h / src.canvas.height);
      const dw = src.canvas.width * s, dh = src.canvas.height * s;
      g.drawImage(src.canvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
  }

  /** Re-take a Library tile's picture from the object it was placed as. */
  refreshAssetThumb(assetId: number): void {
    const refs = listSelected(this.ctx.scene);
    const thumb = refs.length === 1 ? this.thumbFor(refs[0]) : null;
    if (thumb) updateAsset(assetId, { thumb });
    else this.setStatusHint('Select one loaded object to picture it');
  }

  /** MediaMime: spawn a trigger primitive at a live address's current
   *  position, rigged to follow it — the "make this landmark a trigger"
   *  quick action from the panel. */
  addMediaMimeTrigger(address: string, pos: [number, number, number]): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const id = scoreId(scene);
    scene.score.triggers.push({
      id, name: address.split('/').pop() ?? `trigger ${id}`,
      position: [...pos], radius: 0.15, retrigger: true,
      messages: [{ address: `/mm/trigger/${id}`, argExprs: ['1'] }],
    });
    scene.mediamime.rigs.push({
      id: scoreId(scene), name: `${address} → trigger`, address,
      target: { kind: 'TRIGGER', id }, offset: [0, 0, 0], scale: 1, enabled: true,
    });
    this.ui.refresh();
  }

  addMediaMimeRig(address: string, target: import('../tools/objects').ObjRef): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    scene.mediamime.rigs.push({
      id: scoreId(scene), name: `${address} → ${target.kind.toLowerCase()}`, address,
      target, offset: [0, 0, 0], scale: 1, enabled: true, resetTransform: true,
    });
    this.ui.refresh();
  }

  deleteMediaMimeRig(id: number): void {
    this.ctx.pushUndo();
    this.ctx.scene.mediamime.rigs = this.ctx.scene.mediamime.rigs.filter((r) => r.id !== id);
    this.ui.refresh();
  }

  // ------------------------------------------- native MediaMime streams

  /** Add streams (skipping CAMERA kinds that already exist — one webcam
   *  feed per semantic channel). */
  addMMStreams(kinds: MMStream['kind'][], source: MMStream['source'], busAddress?: string): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    for (const kind of kinds) {
      if (source === 'CAMERA' && scene.mmStreams.some((s) => s.source === 'CAMERA' && s.kind === kind)) continue;
      scene.mmStreams.push(createStream(scene, kind, source, this.ctx.settings.upAxis, busAddress));
    }
    this.ui.refresh();
  }

  deleteMMStream(id: number): void {
    this.ctx.pushUndo();
    this.ctx.scene.mmStreams = this.ctx.scene.mmStreams.filter((s) => s.id !== id);
    streamStore.drop(id);
    stopDrivingStream(id);
    if (!this.ctx.scene.mmStreams.some((s) => s.source === 'CAMERA')) mmCapture.stop();
    this.ui.refresh();
  }

  /**
   * Point a stream at a SIMULATED source instead of a real camera: an actor
   * (a full pose) or any other object (one tracked point), seen through one
   * of the scene's own cameras. This is what makes a demo scene work — the
   * exact same stream a webcam would drive, fed from a virtual visitor
   * walking a GP path, with no consumer anywhere able to tell the
   * difference. Not undoable: it is a live wiring choice (like starting the
   * webcam), not scene data.
   */
  setStreamDriver(streamId: number, source: { kind: 'ACTOR'; actorId: number } | { kind: 'OBJECT'; ref: ObjRef }, cameraIndex: number): void {
    if (source.kind === 'ACTOR') driveStreamFromActor(streamId, source.actorId, cameraIndex);
    else driveStreamFromObject(streamId, source.ref, cameraIndex);
    this.ui.refresh();
  }

  clearStreamDriver(streamId: number): void {
    stopDrivingStream(streamId);
    this.ui.refresh();
  }

  streamDriver(streamId: number) { return driverOf(streamId); }
  isStreamDriven(streamId: number): boolean { return isDriven(streamId); }

  mmCaptureToggle(): void {
    if (mmCapture.status === 'on' || mmCapture.status === 'starting') mmCapture.stop();
    else void mmCapture.start(this.ctx.scene);
    this.ui.refresh();
  }

  /** Start capture from a URL or file (video, or animated webp/gif) instead
   *  of the webcam — test/iterate without camera access. */
  mmCaptureStart(source?: { url?: string; file?: File; live?: string }): void {
    void mmCapture.start(this.ctx.scene, source);
    this.ui.refresh();
  }

  mmSetPlaybackRate(rate: number): void {
    mmCapture.setPlaybackRate(rate);
  }

  // ------------------------------------------------------- possession

  /**
   * Take the controls of an actor. Fly mode supplies the rig (pointer lock,
   * mouse-look, WASD, Esc); `possession` replaces its final step so the
   * input walks a body instead of the camera.
   */
  possess(actorId: number, view: PossessView = possession.view): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    if (!actor) return;
    if (this.nav.flying) this.nav.stopFly(true);
    possession.view = view;
    possession.begin(actorId);
    // Constraints on the driven actor stand down for the duration —
    // otherwise a FOLLOW_PATH walker snaps back onto its path every frame.
    constraintEngine.setDriven({ kind: 'ACTOR', id: actorId }, true);
    // driving by hand outranks a destination: the goal is kept, not lost
    steerEngine.suppressed.add(actorId);
    // Nothing here poses the character: the gait engine sees the root move
    // and produces the walk cycle, exactly as it does for a path traveler.
    if (actor.gait) actor.gait.enabled = true;
    const upZ = () => this.ctx.settings.upAxis === 'Z';
    this.nav.walkDriver = (input) => {
      possession.update(this.ctx.scene, input, upZ());
      possession.placeCamera(this.ctx.scene, this.nav.persp, upZ());
    };
    this.nav.startFly();
    this.ui.refresh();
  }

  /** Hand the controls back. Routed through fly mode so the camera restore
   *  and the pointer-lock release stay in exactly one place. */
  unpossess(): void {
    if (this.nav.flying) this.nav.stopFly(true);
    else this.endPossess();
  }

  /** Fly mode ended (Enter, Esc, a click elsewhere) — tear possession down. */
  private endPossess(): void {
    if (!possession.active) return;
    // read the id BEFORE end() clears it, or the constraint suppression
    // never lifts and the actor silently ignores its own path afterwards
    constraintEngine.setDriven({ kind: 'ACTOR', id: possession.actorId! }, false);
    steerEngine.suppressed.delete(possession.actorId!);
    possession.end();
    this.nav.walkDriver = null;
    this.ui.refresh();
  }

  togglePossess(actorId: number): void {
    if (possession.actorId === actorId) this.unpossess();
    else this.possess(actorId);
  }

  // ------------------------------------------------------------- steering

  /** Send a character to a world point. It walks; the gait does the rest. */
  actorGoTo(actorId: number, point: Vec3): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    if (!actor?.steer) return;
    this.ctx.pushUndo();
    steerEngine.reset(actorId);
    actor.steer.mode = 'POINT';
    actor.steer.point = [...point] as Vec3;
    actor.steer.target = null;
    actor.steer.arrived = false;
    actor.steer.stuck = false;
    if (actor.gait) actor.gait.enabled = true;
    this.ui.refresh();
  }

  /** Send a character to whatever an object is, wherever it ends up. */
  actorGoToObject(actorId: number, ref: ObjRef): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    if (!actor?.steer) return;
    this.ctx.pushUndo();
    steerEngine.reset(actorId);
    actor.steer.mode = 'OBJECT';
    actor.steer.target = ref;
    actor.steer.arrived = false;
    actor.steer.stuck = false;
    if (actor.gait) actor.gait.enabled = true;
    this.ui.refresh();
  }

  /** Give up on the destination. The goal is cleared, not just paused. */
  actorStop(actorId: number): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    if (!actor?.steer) return;
    this.ctx.pushUndo();
    actor.steer.mode = 'NONE';
    actor.steer.arrived = false;
    actor.steer.stuck = false;
    steerEngine.reset(actorId);
    this.ui.refresh();
  }

  // ------------------------------------------------------- motion import

  /** MODEL objects in the scene that arrived carrying animation. */
  modelMotions(): { meshId: number; name: string; clips: string[] }[] {
    const out: { meshId: number; name: string; clips: string[] }[] = [];
    for (const [meshId, entry] of this.meshes.modelAnimations) {
      const mesh = this.ctx.scene.meshes.find((m) => m.id === meshId);
      if (!mesh) continue;
      out.push({ meshId, name: mesh.name, clips: entry.clips.map((c, i) => c.name || `clip ${i + 1}`) });
    }
    return out;
  }

  /**
   * Retarget one imported animation onto an actor. It becomes an ordinary
   * pose clip plus a mixer layer playing it — so from here it trims, blends
   * and saves like a take you performed yourself.
   */
  /** last retarget's report, for inspecting a bad import */
  lastRetarget: ReturnType<typeof retargetGltfClip> | null = null;

  importMotion(meshId: number, clipIndex: number, actorId: number): void {
    const entry = this.meshes.modelAnimations.get(meshId);
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    const source = entry?.clips[clipIndex];
    if (!entry || !actor || !source) { this.setStatusHint('Import: nothing to retarget'); return; }
    const mesh = this.ctx.scene.meshes.find((m) => m.id === meshId);
    const report = retargetGltfClip(entry.root, source, actor, {
      upZ: this.ctx.settings.upAxis === 'Z',
      name: `${mesh?.name ?? 'model'}: ${source.name || 'motion'}`,
    });
    this.lastRetarget = report;
    if (!report.clip) {
      this.setStatusHint(`Import failed — ${report.error ?? 'no clip'}`, 6000);
      return;
    }
    this.ctx.pushUndo();
    this.ctx.scene.clips.push(report.clip);
    this.swapGeneratedLayer(actor, report.clip.id, source.name || 'Imported');
    this.setStatusHint(
      `Retargeted ${report.matched.length} joints, ${report.frames} frames`
      + `${report.missing.length ? ` (unmatched: ${report.missing.join(', ')})` : ''}`, 8000);
    this.ui.refresh();
  }

  // ---------------------------------------------------- generated motion

  motionBackendIds(): { id: string; label: string }[] {
    return motionBackends().map((b) => ({ id: b.id, label: b.label }));
  }

  motionEndpoint(): string { return remoteBackend.endpoint; }

  /** Download/inference progress for the on-device model, for the panel. */
  motionStatus(): { text: string; busy: boolean; notices: string[]; hint: string } | null {
    return {
      text: this.ardyStatus,
      busy: ardyBackend.busy,
      notices: ARDY_NOTICES,
      hint: ardyDownloadHint(),
    };
  }

  private ardyStatus = '';
  setMotionEndpoint(url: string): void { remoteBackend.endpoint = url.trim(); }

  /**
   * Generate a motion clip for an actor and put it on a layer. The backend
   * is interchangeable — the built-in synthesiser and a service holding
   * real weights answer the same request — so nothing downstream of here
   * knows or cares which one replied.
   */
  async generateMotion(
    actorId: number, prompt: string, seconds: number, backendId = 'local',
  ): Promise<void> {
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    if (!actor) return;
    const backend = motionBackends().find((b) => b.id === backendId) ?? proceduralBackend;
    const req: MotionRequest = {
      prompt,
      seconds,
      joints: [],
      speed: actor.steer?.speed,
      goal: actor.steer?.mode === 'POINT' ? (actor.steer.point ?? null) : null,
    };
    ardyBackend.onProgress = (p) => {
      const pct = p.total > 0 ? Math.round((p.completed / p.total) * 100) : 0;
      this.ardyStatus = `${p.stage.replace(/-/g, ' ')} ${pct}%`
        + (p.message ? ` — ${p.message}` : '');
      this.setStatusHint(`ARDY: ${this.ardyStatus}`, 30000);
    };
    this.setStatusHint(`Generating "${prompt}" (${backend.label})…`, 30000);
    let clip;
    try {
      clip = await backend.generate(req, actor, this.ctx.settings.upAxis === 'Z');
    } catch (err) {
      this.ardyStatus = '';
      this.setStatusHint(`Generate failed — ${String(err)}`, 10000);
      this.ui.refresh();
      return;
    } finally {
      ardyBackend.onProgress = null;
    }
    this.ardyStatus = '';
    this.ctx.pushUndo();
    this.ctx.scene.clips.push(clip);
    this.swapGeneratedLayer(actor, clip.id, clip.name);
    this.setStatusHint(
      `Generated ${clip.frames.length} frames over ${(clip.duration / 1000).toFixed(1)}s`
      + ` on ${clip.count} joints`, 6000);
    this.ui.refresh();
  }

  /** Loaded VRM avatars in the scene, for the Actor panel's picker. */
  avatarChoices(): { id: number; name: string }[] {
    return vrmManager.ids()
      .map((id) => this.ctx.scene.meshes.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ id: m.id, name: m.name }));
  }

  setActorAvatar(actorId: number, meshId: number | null): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    if (!actor) return;
    this.ctx.pushUndo();
    actor.avatar = meshId;
    this.ui.refresh();
  }

  /**
   * Put a clip on the actor's ONE generated-motion layer, crossfading
   * whatever was there before.
   *
   * Appending instead of swapping is what made a character look
   * "conflicted": every press of a Motion button added another layer at
   * full weight, and the solver dutifully averaged ten different walks into
   * one that was none of them. There is a single live generated layer, and
   * a new one fades in as the old fades out.
   *
   * Stale layers are pruned HERE rather than on a timer: at most two ever
   * exist at once, and the faded-out one is collected on the next swap.
   */
  private swapGeneratedLayer(actor: TGActor, clipId: number, name: string): void {
    const FADE = 0.35;
    const layers = actor.layers ?? [];
    const alive = layers.filter((l) => !(l.generated
      && actorMixer.fadeFactor(actor.id, l.id) < 0.01));
    for (const l of alive) {
      if (l.generated) actorMixer.fadeTo(actor.id, l.id, 0, FADE);
    }
    const layer: TGActorLayer = {
      id: nextLayerId(actor),
      name,
      enabled: true,
      weight: 1,
      mask: 'ALL',
      source: 'CLIP',
      clipId,
      phase: 0,
      speed: 1,
      loop: 'LOOP',
      playing: true,
      generated: true,
      // A clip whose source actually walked somewhere is locomotion and is
      // phased on distance, so it never skates. One that stayed put — a
      // wave, a sit — must stay on the clock, or it would freeze the moment
      // the character stopped.
      phaseBy: (this.ctx.scene.clips.find((c) => c.id === clipId)?.impliedSpeed ?? 0) > 0.35
        ? 'DISTANCE' : 'TIME',
    };
    actor.layers = [...alive, layer];
    actorMixer.fadeTo(actor.id, layer.id, 0, 0);      // start silent...
    actorMixer.fadeTo(actor.id, layer.id, 1, FADE);   // ...and come up
    // a generated walk and the procedural one both want the legs
    const gaitLayer = actor.layers.find((l) => l.source === 'GAIT');
    if (gaitLayer) gaitLayer.enabled = false;
  }

  /** Drop every generated layer and hand the body back to the gait. */
  clearGeneratedMotion(actorId: number): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === actorId);
    if (!actor) return;
    this.ctx.pushUndo();
    actor.layers = (actor.layers ?? []).filter((l) => !(l.generated || l.source === 'CLIP'));
    const gaitLayer = actor.layers.find((l) => l.source === 'GAIT');
    if (gaitLayer) gaitLayer.enabled = true;
    if (actor.gait) actor.gait.enabled = true;
    this.ui.refresh();
  }

  possessedActor(): number | null { return possession.actorId; }
  possessView(): PossessView { return possession.view; }

  setPossessView(view: PossessView): void {
    possession.view = view;
    this.ui.refresh();
  }

  // ------------------------------------------------------------ clips

  /** Toggle recording of a stream / object trajectory into a clip. */
  mmRecordToggle(source: RecordSource): void {
    if (clipRecorder.isRecording(source)) {
      this.ctx.pushUndo();
      clipRecorder.stop(this.ctx.scene);
    } else {
      if (clipRecorder.isRecording()) clipRecorder.stop(this.ctx.scene); // commit the other one
      clipRecorder.start(this.ctx.scene, source);
    }
    this.ui.refresh();
  }

  mmRecording(source?: RecordSource): boolean { return clipRecorder.isRecording(source); }

  /** Replay a clip as a CLIP-source stream (new stream object). */
  mmPlayClip(clipId: number): void {
    this.ctx.pushUndo();
    this.ctx.scene.mmStreams.push(
      createStream(this.ctx.scene, 'CUSTOM', 'CLIP', this.ctx.settings.upAxis, undefined, clipId));
    this.ui.refresh();
  }

  /** Bake a clip's landmark trajectories into GP strokes (conf → pressure). */
  mmBakeClip(clipId: number, landmark = -1): void {
    const clip = this.ctx.scene.clips.find((c) => c.id === clipId);
    if (!clip) return;
    this.ctx.pushUndo();
    bakeClipToStrokes(this.ctx.scene, clip, landmark);
    this.ctx.scene.activeObject = this.ctx.scene.objects.length - 1;
    this.gp.markDirty();
    this.ui.refresh();
  }

  mmCropClip(clipId: number): void {
    const clip = this.ctx.scene.clips.find((c) => c.id === clipId);
    if (!clip) return;
    this.ctx.pushUndo();
    cropClip(clip);
    this.ui.refresh();
  }

  mmDeleteClip(clipId: number): void {
    this.ctx.pushUndo();
    this.ctx.scene.clips = this.ctx.scene.clips.filter((c) => c.id !== clipId);
    // orphan any streams replaying it
    for (const st of this.ctx.scene.mmStreams) {
      if (st.source === 'CLIP' && st.clipId === clipId) { st.clipId = null; st.playing = false; }
    }
    this.ui.refresh();
  }

  exportActiveGP(): void {
    const ob = activeObject(this.ctx.scene);
    downloadText(serializeGPObject(ob), `${ob.name || 'gp'}.threegrease.json`);
  }

  async importGPFile(file: File): Promise<void> {
    try {
      this.ctx.pushUndo();
      const added = importGPObjects(this.ctx.scene, await file.text());
      this.ctx.scene.activeObject = this.ctx.scene.objects.length - 1;
      this.gp.markDirty();
      this.ui.refresh();
      console.info(`imported ${added} GP object(s)`);
    } catch (err) {
      alert(`GP import failed: ${err}`);
    }
  }

  exportSplatPly(id: number): void {
    const buffer = this.splats.exportPly(id);
    if (!buffer) { alert('Splat not loaded yet (or unsupported)'); return; }
    const name = this.ctx.scene.splats.find((s) => s.id === id)?.name ?? 'splat';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
    a.download = `${name.replace(/\.\w+.*$/, '')}.ply`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  addMeshObject(kind: 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER' | 'PYRAMID' | 'TETRA' | 'OCTA' | 'DODECA' | 'ICOSA' | 'EMPTY', src?: string, at?: [number, number, number]): void {
    this.ctx.pushUndo();
    const id = Date.now() % 1e9;
    this.ctx.scene.meshes.push(createMeshObject(id, src ? 'MODEL' : kind, at ?? [...this.ctx.scene.cursor], src));
    this.meshes.sync(this.ctx.scene);
    this.ui.refresh();
  }

  /**
   * Rescale the WHOLE scene so a chosen measurement equals a real length.
   *
   * This is the point of the measure tool for blockout work. You build a
   * room from reference photographs at whatever arbitrary size the eye
   * produced, measure something you actually know — a door, a ceiling
   * height, a floor tile — type the real figure, and the scene becomes
   * metric. Everything downstream (an actor's 1.8 m, gravity, trigger radii
   * in metres) then means something.
   *
   * Only ROOTS are touched: a parented object is carried by its parent's
   * scale, so scaling both would square the factor on every child.
   */
  scaleSceneToMeasure(measureId: number, realLength: number): { ok: boolean; factor?: number; error?: string } {
    const scene = this.ctx.scene;
    const m = scene.measures.find((x) => x.id === measureId);
    if (!m) return { ok: false, error: 'measurement not found' };
    const current = measureLength(scene, m);
    if (current < 1e-9) return { ok: false, error: 'measurement has no length' };
    if (!(realLength > 0)) return { ok: false, error: 'real length must be greater than zero' };
    const k = realLength / current;
    if (Math.abs(k - 1) < 1e-9) return { ok: true, factor: 1 };

    this.ctx.pushUndo();
    for (const ref of allRefs(scene)) {
      if (getParent(scene, ref)) continue;      // the parent carries it
      const t = getObjectTransform(scene, ref);
      if (!t) continue;
      setObjectTransform(scene, ref, {
        translation: [t.translation[0] * k, t.translation[1] * k, t.translation[2] * k],
        rotation: [...t.rotation] as [number, number, number],
        scale: [t.scale[0] * k, t.scale[1] * k, t.scale[2] * k],
      });
    }
    // things that carry a world-space length of their own and are not
    // object transforms. Measurements used to be here; they are objects now,
    // so the loop above already scaled them — and a BOUND point needs no
    // scaling at all, because whatever it is stuck to has just been scaled
    // underneath it.
    for (const trig of scene.score.triggers) trig.radius *= k;
    for (const cam of scene.cameras) {
      cam.translation = [cam.translation[0] * k, cam.translation[1] * k, cam.translation[2] * k];
    }
    scene.cursor = [scene.cursor[0] * k, scene.cursor[1] * k, scene.cursor[2] * k];

    this.gp.markDirty();
    this.refreshWidget();
    this.ui.refresh();
    this.ctx.requestRender();
    return { ok: true, factor: k };
  }

  /** Add Actor: the default mannequin, standing at the 3D cursor. Built
   *  for the scene's up axis so it is upright either way, and selected on
   *  arrival so the properties panel lands on its rig. */
  addActor(at?: [number, number, number]): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const id = Date.now() % 1e9;
    const actor = createHumanoid(id, `Actor ${scene.actors.length + 1}`,
      this.ctx.settings.upAxis === 'Z');
    actor.translation = at ?? [...scene.cursor];
    scene.actors.push(actor);
    deselectAllObjects(scene);
    actor.select = true;
    this.setLastPicked({ kind: 'ACTOR', id });
    if (this.ctx.settings.mode !== 'OBJECT') this.setMode('OBJECT');
    this.actors.sync(scene);
    this.refreshWidget();
    this.ui.openTab('actor');
    this.ui.refresh();
    this.ctx.requestRender();
  }

  /** Drop an actor back to its T-pose and clear the simulation's velocity
   *  (otherwise the ragdoll keeps whatever momentum it had). */
  /**
   * One door for every 3D export, so the File menu and the right-click menu
   * cannot offer different sets or different behaviour.
   */
  async export3D(format: string, selectedOnly: boolean): Promise<void> {
    const m = await import('../io/export3d');
    const fmt = m.EXPORT_FORMATS.find((f) => f.id === format);
    if (!fmt) return;
    if (selectedOnly && !listSelected(this.ctx.scene).length) {
      this.setStatusHint('Nothing selected to export');
      return;
    }
    await fmt.run(this.ctx, selectedOnly ? m.SELECTION_EXPORT3D : m.DEFAULT_EXPORT3D);
    this.setStatusHint(`Exported ${selectedOnly ? 'selection' : 'scene'} as ${format.toUpperCase()}`);
  }

  resetActor(id: number): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === id);
    if (!actor) return;
    this.ctx.pushUndo();
    resetPose(actor);
    delete actor.hold;
    actorSolver.reset(id);
    actorRig.reset(id);
    this.ctx.requestRender();
    this.ui.refresh();
  }

  /**
   * Stand an actor in one of the reference poses.
   *
   * The solver is reset with it: a pose is a statement about where the body
   * IS, and leaving last frame's velocity in place makes it sag out of the
   * pose over the following second — which reads as the pose not having
   * been applied at all.
   */
  setActorStance(id: number, kind: 'REST' | 'T' | 'A'): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === id);
    if (!actor) return;
    this.ctx.pushUndo();
    const upZ = this.ctx.settings.upAxis === 'Z';
    const positions = kind === 'REST' ? restPositions(actor)
      : kind === 'T' ? tPosePositions(actor, upZ) : aPosePositions(actor, upZ);
    actor.pose = positions;
    // REST is where tone already pulls, so it needs no holding — and not
    // holding it is what makes "Stance" the way OUT of a held pose.
    if (kind === 'REST') delete actor.hold;
    else actor.hold = holdFrom(actor, positions);
    actorSolver.reset(id);
    actorRig.reset(id);
    this.ctx.requestRender();
    this.ui.refresh();
  }

  /** Store the actor's current pose in the library (overwriting a slot). */
  savePoseSlot(id: number, poseId?: number): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === id);
    if (!actor) return;
    const scene = this.ctx.scene;
    scene.poses ??= [];
    this.ctx.pushUndo();
    const at = poseId !== undefined ? scene.poses.findIndex((p) => p.id === poseId) : -1;
    const nextId = scene.poses.reduce((n, p) => Math.max(n, p.id), 0) + 1;
    const made = capturePose(actor, at >= 0 ? scene.poses[at].id : nextId,
      at >= 0 ? scene.poses[at].name : `Pose ${scene.poses.length + 1}`);
    if (at >= 0) scene.poses[at] = made; else scene.poses.push(made);
    this.ui.refresh();
  }

  applyPoseSlot(id: number, poseId: number): void {
    const actor = this.ctx.scene.actors.find((a) => a.id === id);
    const pose = this.ctx.scene.poses?.find((p) => p.id === poseId);
    if (!actor || !pose) return;
    this.ctx.pushUndo();
    applyPose(actor, pose);
    actor.hold = { ...pose.joints };
    actorSolver.reset(id);
    actorRig.reset(id);
    this.ctx.requestRender();
    this.ui.refresh();
  }

  deletePoseSlot(poseId: number): void {
    const scene = this.ctx.scene;
    if (!scene.poses?.some((p) => p.id === poseId)) return;
    this.ctx.pushUndo();
    scene.poses = scene.poses.filter((p) => p.id !== poseId);
    this.ui.refresh();
  }

  /** Add Editable Mesh: empty TGPolyMesh at the 3D cursor, selected and
   *  active (Ctrl+P target), visible in the outliner immediately. */
  addPolyMeshObject(at?: [number, number, number]): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const id = Date.now() % 1e9;
    const pm = createPolyMesh(id, `PolyMesh ${scene.polyMeshes.length + 1}`, at ?? [...scene.cursor]);
    scene.polyMeshes.push(pm);
    deselectAllObjects(scene);
    pm.select = true;
    this.setLastPicked({ kind: 'POLY', id });
    // straight into topology editing: EDIT mode + the PolyQuilt tool
    // (setTool targets the freshly selected mesh and refreshes the UI)
    if (this.ctx.settings.mode !== 'DRAW' && this.ctx.settings.mode !== 'EDIT') this.setMode('EDIT');
    this.setTool('polypen');
  }

  /**
   * Bake a source (scene / strokes / shadows / live camera) onto the
   * selected object's base-color texture, through its UVs. The result
   * becomes an image datablock marked `baked`, so it persists with the
   * scene and can be re-baked or hand-painted over afterwards.
   */
  bakeToTexture(source: BakeSource, size = 1024, margin = 4): void {
    const ctx = this.ctx;
    const ref = this.getLastPicked();
    const target = ref?.kind === 'MESH' ? ctx.scene.meshes.find((m) => m.id === ref.id)
      : ref?.kind === 'POLY' ? ctx.scene.polyMeshes.find((p) => p.id === ref.id)
      : undefined;
    if (!ref || !target) {
      this.setStatusHint('Bake: select a mesh or editable mesh first');
      return;
    }
    const root = ref.kind === 'POLY' ? this.polys.rootFor(ref.id) : this.meshes.rootFor(ref.id);
    let mesh: THREE.Mesh | null = null;
    root?.traverse((o) => { if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh; });
    if (!mesh) { this.setStatusHint('Bake: target has no renderable geometry'); return; }

    // seed from the current texture so a bake adds to what's painted
    const existingSrc = baseTextureSrc(ctx.scene, target);
    const existing = existingSrc ? new Image() : null;
    if (existing && existingSrc) existing.src = existingSrc;

    const dataUrl = bakeEngine.bake(this.glRenderer, this.scene3, ctx.scene, {
      source, camera: this.nav.active, target: mesh, size, margin,
      input: source === 'INPUT' ? mmCapture.sourceEl ?? null : null,
      existing,
    }, this.gp.root);
    if (!dataUrl) {
      this.setStatusHint('Bake: target has no UVs — unwrap it first');
      return;
    }
    ctx.pushUndo();
    setBaseTexture(ctx.scene, target, dataUrl, true);
    ctx.requestRender();
    this.ui.refresh();
    this.setStatusHint(`Baked ${source.toLowerCase()} to ${target.name}`);
  }

  /** Add a light at the 3D cursor, selected and active like any other
   *  object (lights are ordinary scene objects — see render/lights.ts). */
  addLight(kind: TGLight['kind'], at?: [number, number, number]): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const l = createLight(kind, undefined, at ?? [...scene.cursor]);
    scene.lights.push(l);
    deselectAllObjects(scene);
    l.select = true;
    this.setLastPicked({ kind: 'LIGHT', id: l.id });
    this.refreshWidget();
    this.ui.refresh();
  }

  /** Persist UVs on an editable mesh. Lives here (not in the UI) because
   *  Project-from-View needs the live camera + viewport to flatten along
   *  the current view; core/uvunwrap stays three.js-free by taking a
   *  caller-supplied object-local -> 0..1 screen mapping. */
  unwrapPoly(id: number, mode: UnwrapMode): void {
    const scene = this.ctx.scene;
    const pm = scene.polyMeshes.find((p) => p.id === id);
    if (!pm) return;
    this.ctx.pushUndo();
    if (mode === 'VIEW') {
      const world = worldMatrixOf(scene, { kind: 'POLY', id });
      const cam = this.ctx.camera;
      unwrap(pm, 'VIEW', (co) => {
        const p = new THREE.Vector3(...co).applyMatrix4(world).project(cam);
        return [p.x * 0.5 + 0.5, p.y * 0.5 + 0.5];
      });
    } else {
      unwrap(pm, mode);
    }
    this.ctx.requestRender();
    this.ui.refresh();
  }

  /** The GP object the user last worked in. Held by REFERENCE (the scene is
   *  plain data, so a deleted object's record lives on here) and refreshed
   *  every frame — cheaper than chasing every door an object can leave by. */
  private lastPencil: GPObject | null = null;

  /**
   * A fresh pencil that continues where the last one left off: its material
   * slots and active slot are copied from the pencil you were last using,
   * rather than reset to the app's defaults. Deleting everything and going
   * back to Draw used to hand you a black pen whatever you had been drawing
   * with — a new object is a new container, not a reset of your pen.
   */
  private newPencil(name: string): GPObject {
    const ob = createObject(name);
    const src = this.lastPencil;
    if (src && src.materials.length) {
      ob.materials = structuredClone(src.materials);
      ob.activeMaterial = Math.min(src.activeMaterial, ob.materials.length - 1);
    }
    return ob;
  }

  /** Blender Add > Grease Pencil > Blank: new empty GP object at the 3D cursor. */
  addGPObject(at?: [number, number, number]): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const n = scene.objects.length + 1;
    const ob = this.newPencil(`Pencil${n}`);
    ob.translation = at ?? [...scene.cursor];
    scene.objects.push(ob);
    scene.activeObject = scene.objects.length - 1;
    setObjectSelected(scene, { kind: 'GP', id: ob.id }, true);
    this.gp.markDirty();
    this.refreshWidget();
    this.ui.refresh();
  }

  /**
   * Snapshot a scene camera's view as a reference plane sitting in front of
   * it — the virtual stand-in for "stand here, take a photo, bring it in as
   * a plane and build against it".
   *
   * Useful well beyond the simulation: once real geometry exists, this is
   * how you freeze a viewpoint as an image to draw over, and it is the only
   * reference plane guaranteed to be perfectly registered to the space,
   * because it was rendered FROM that space rather than photographed of it.
   *
   * The plane is placed at `distance` and sized to exactly fill the frustum
   * there, so it lines up with what the camera sees pixel for pixel.
   */
  captureCameraPlate(camIndex: number, distance = 3, width = 1024): void {
    const scene = this.ctx.scene;
    const gpCam = scene.cameras[camIndex];
    if (!gpCam) return;
    const pose = evalCamera(gpCam, scene.frame);
    const aspect = 16 / 9;
    const height = Math.round(width / aspect);

    const cam = new THREE.PerspectiveCamera(pose.fov, aspect, 0.05, 500);
    cam.position.copy(pose.position);
    cam.quaternion.copy(pose.quaternion);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const rt = new THREE.WebGLRenderTarget(width, height);
    const prevTarget = this.glRenderer.getRenderTarget();
    this.glRenderer.setRenderTarget(rt);
    this.glRenderer.render(this.scene3, cam);
    const pixels = new Uint8Array(width * height * 4);
    this.glRenderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    this.glRenderer.setRenderTarget(prevTarget);
    rt.dispose();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return;
    const img = g.createImageData(width, height);
    // readRenderTargetPixels returns rows bottom-up; ImageData is top-down
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width * 4;
      img.data.set(pixels.subarray(src, src + width * 4), y * width * 4);
    }
    g.putImageData(img, 0, 0);

    // size the plane to fill the frustum at `distance`, then place it there
    const h = 2 * distance * Math.tan(THREE.MathUtils.degToRad(pose.fov) / 2);
    const w = h * aspect;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    const at = pose.position.clone().addScaledVector(forward, distance);
    const e = new THREE.Euler().setFromQuaternion(pose.quaternion, 'XYZ');

    this.ctx.pushUndo();
    const mesh = createMeshObject(Date.now() % 1e9, 'PLANE', [at.x, at.y, at.z]);
    mesh.name = `${gpCam.name} · plate`;
    mesh.texture = canvas.toDataURL('image/png');
    mesh.unlit = true;
    mesh.drawTarget = false;   // a reference, not a draw surface, by default
    mesh.doubleSided = true;
    mesh.rotation = [e.x, e.y, e.z];
    mesh.scale = [w, h, 1];
    scene.meshes.push(mesh);
    this.meshes.sync(scene, this.nav.active);
    this.ui.refresh();
    this.ctx.requestRender();
  }

  /** Reference/image plane: textured unlit PLANE sized to the image aspect. */
  /**
   * An image as a flat panel — a reference photo, or the picture of a work
   * to hang.
   *
   * Dropped ON a surface it lies against it, facing out, with its top toward
   * the sky: dropped on a wall it hangs on the wall, which is the gesture
   * for staging 2D works in a room. Dropped on open ground it stands up on
   * the floor facing the camera. With no drop point (the Add menu) it keeps
   * its old behaviour, lying at the 3D cursor.
   */
  importImagePlane(file: File, at?: DropTarget): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        this.ctx.pushUndo();
        const id = Date.now() % 1e9;
        const mesh = createMeshObject(id, 'PLANE', at ? [...at.point] as Vec3 : [...this.ctx.scene.cursor]);
        mesh.name = file.name;
        mesh.texture = dataUrl;
        mesh.unlit = true;
        mesh.drawTarget = false;   // reference by default; toggle in properties
        mesh.opacity = 1;
        const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        // PLANE scale is HALF size. A dropped image is a work at a
        // plausible 1 m tall; the menu's reference plane keeps its old 2 m.
        const half = at ? 0.5 : 1;
        mesh.scale = [aspect * half, half, 1];
        if (at) this.orientPanel(mesh, at);
        this.ctx.scene.meshes.push(mesh);
        this.meshes.sync(this.ctx.scene, this.nav.active);
        this.ui.refresh();
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  /** Turn a PLANE (normal +Z, top +Y in its own space) to face out of the
   *  surface it was dropped on, top toward the up axis. */
  private orientPanel(mesh: TGMesh, at: DropTarget): void {
    const up = this.ctx.settings.upAxis === 'Z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    if (at.flat) {
      // lying on the floor, a millimetre up, its top edge away from the view
      const fwd = this.nav.active.getWorldDirection(new THREE.Vector3());
      fwd.addScaledVector(up, -fwd.dot(up));
      const y = fwd.lengthSq() > 1e-6 ? fwd.normalize() : new THREE.Vector3(0, 1, 0);
      const x = new THREE.Vector3().crossVectors(y, up).normalize();
      const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, up.clone()));
      mesh.rotation = [e.x, e.y, e.z];
      mesh.translation = [at.point[0] + up.x * 0.001, at.point[1] + up.y * 0.001, at.point[2] + up.z * 0.001];
      return;
    }
    let n = at.normal && at.onSurface ? new THREE.Vector3(...at.normal).normalize() : null;
    const standing = !n || Math.abs(n.dot(up)) > 0.7;   // floor or ceiling: stand it up instead
    if (standing) {
      // face the camera, upright, resting on the point
      const toCam = this.nav.active.getWorldPosition(new THREE.Vector3()).sub(new THREE.Vector3(...at.point));
      toCam.addScaledVector(up, -toCam.dot(up));
      n = toCam.lengthSq() > 1e-6 ? toCam.normalize() : new THREE.Vector3(0, -1, 0);
      const lift = mesh.scale[1];                        // half height, so the bottom touches
      mesh.translation = [at.point[0] + up.x * lift, at.point[1] + up.y * lift, at.point[2] + up.z * lift];
    } else {
      // hang: a millimetre proud of the wall, so it cannot z-fight with it
      mesh.translation = [at.point[0] + n!.x * 0.001, at.point[1] + n!.y * 0.001, at.point[2] + n!.z * 0.001];
    }
    const z = n!.clone();
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    mesh.rotation = [e.x, e.y, e.z];
  }

  importModelFile(file: File): void {
    void this.importFiles([file]);
  }

  /** Cursor/trigger glyphs: rebuilt when the score roster changes, posed every frame. */
  /** Orange selection outlines + origin dots (Blender look), object mode only. */
  /** three.js root for any ObjRef (selection glyphs, zone flashes). */
  private objectRoot(ref: ObjRef): THREE.Object3D | null {
    const scene = this.ctx.scene;
    return ref.kind === 'GP' ? this.gp.objectGroups[gpIndexOf(scene, ref.id)] ?? null :
      ref.kind === 'MESH' ? this.meshes.rootFor(ref.id) :
      ref.kind === 'SPLAT' ? this.splats.meshFor(ref.id) :
      ref.kind === 'TRIGGER' ? this.scoreGroup.children.find((c) => c.userData.triggerId === ref.id) ?? null :
      ref.kind === 'STREAM' ? this.mmPoints.objectFor(ref.id) :
      ref.kind === 'POLY' ? this.polys.rootFor(ref.id) :
      null;
  }

  /**
   * Where an object IS, for placing a group's pivot — for every kind.
   *
   * Grouping used to read bounds off each object's render root, and only
   * some kinds have one: a measurement is drawn on the HUD and has no mesh
   * at all, and actors, lights and triggers are not in `objectRoot`, so a
   * selection of only those produced an empty box and Cmd-G silently did
   * nothing. A splat's render root is one instanced quad, which gave a box
   * at its origin. So: a measurement is its points, a splat asks Spark,
   * an actor its body, and anything else with no geometry is at least a
   * point where it stands.
   */
  private groupBounds(ref: ObjRef): THREE.Box3 {
    const scene = this.ctx.scene;
    const box = new THREE.Box3();
    if (ref.kind === 'MEASURE') {
      const m = scene.measures.find((x) => x.id === ref.id);
      if (m) for (const p of worldPointsOf(scene, m)) box.expandByPoint(p);
    } else if (ref.kind === 'SPLAT' || ref.kind === 'POLY') {
      const b = this.computeObjectBox(ref);
      if (b) box.copy(b);
    } else {
      const root = ref.kind === 'ACTOR' ? this.actors.rootFor(ref.id) : this.objectRoot(ref);
      if (root) box.setFromObject(root);
    }
    if (box.isEmpty()) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(scene, ref)));
    return box;
  }

  /** The render root to take a SILHOUETTE of, for the kinds that get one;
   *  null for everything that keeps the hull (meshes) or the box (empties,
   *  triggers, streams, lights). */
  private silhouetteRoot(ref: ObjRef): THREE.Object3D | null {
    const scene = this.ctx.scene;
    if (ref.kind === 'GP') return this.gp.objectGroups[gpIndexOf(scene, ref.id)] ?? null;
    if (ref.kind === 'SPLAT') return this.splats.meshFor(ref.id);
    if (ref.kind === 'ACTOR') return this.actors.rootFor(ref.id);
    // an editable mesh can be anything down to a single flat face, which an
    // inverted hull cannot outline (it z-fights) — the render-based
    // silhouette handles every shape, so these wear it instead of a box
    if (ref.kind === 'POLY') return this.polys.rootFor(ref.id);
    if (ref.kind === 'PCLOUD') {
      return this.paints.group.children.find((c) => c.userData.pcloudId === ref.id) ?? null;
    }
    return null;
  }

  /** A splat's world bounds INCLUDING its gaussians' spread — the region its
   *  silhouette can occupy. Cached per mesh; Spark walks every splat. */
  private splatReachCache = new WeakMap<THREE.Object3D, THREE.Box3>();
  private splatReach(ref: ObjRef): THREE.Box3 | null {
    const root = this.splats.meshFor(ref.id);
    const get = (root as unknown as { getBoundingBox?: (c?: boolean) => THREE.Box3 } | null)?.getBoundingBox;
    if (!root || !get) return null;
    let local = this.splatReachCache.get(root);
    if (!local) {
      local = get.call(root, false);
      if (local.isEmpty()) return null;
      this.splatReachCache.set(root, local);
    }
    return local.clone().applyMatrix4(root.matrixWorld);
  }

  /** World-space bounds of an editable mesh from its DATA — the render
   *  group's box is inflated by the unit-geometry instanced vertex
   *  handles, so selection outlines measure the topology itself. */
  private polyDataBox(ref: ObjRef, box: THREE.Box3): void {
    box.makeEmpty();
    const pm = this.ctx.scene.polyMeshes.find((p) => p.id === ref.id);
    if (!pm) return;
    const world = worldMatrixOf(this.ctx.scene, ref);
    const v = new THREE.Vector3();
    for (const vert of pm.vertices) box.expandByPoint(v.set(...vert.co).applyMatrix4(world));
  }

  /** World-space AABB of `ref`'s actual geometry, for any object kind.
   *  Shared by the selection outline (syncSelectionGlyphs) and the
   *  N-panel's Dimensions readout, so both agree on what "the bounding
   *  box" means — same empty-mesh/POLY/matrix-only-object special cases. */
  private computeObjectBox(ref: ObjRef): THREE.Box3 | null {
    const scene = this.ctx.scene;
    const root = this.objectRoot(ref);
    if (!root) return null;
    const box = new THREE.Box3();
    const isEmptyMesh = ref.kind === 'MESH' && scene.meshes.find((m) => m.id === ref.id)?.kind === 'EMPTY';
    if (ref.kind === 'POLY') this.polyDataBox(ref, box);
    else if (ref.kind === 'SPLAT') {
      // A SplatMesh's own geometry is ONE instanced quad, so setFromObject
      // gives a small box at its origin whatever the cloud looks like. Spark
      // knows the real extent (from the splat centres) — cached, since it
      // walks every splat to find it.
      let local = this.splatBounds.get(root);
      const get = (root as unknown as { getBoundingBox?: (c?: boolean) => THREE.Box3 }).getBoundingBox;
      if (!local && get) {
        local = get.call(root, true);
        if (!local.isEmpty()) this.splatBounds.set(root, local);
      }
      if (local && !local.isEmpty()) box.copy(local).applyMatrix4(root.matrixWorld);
    } else if (!isEmptyMesh) box.setFromObject(root);
    if (isEmptyMesh || box.isEmpty()) {
      const center = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(scene, ref));
      const size = ref.kind === 'GP' || ref.kind === 'POLY' || isEmptyMesh ? 0.15 : 1;
      box.setFromCenterAndSize(center, new THREE.Vector3(size, size, size));
    }
    return box;
  }

  /** World-space bounding-box size (Blender's Item panel "Dimensions"),
   *  for the N-panel. Public because ui.ts only sees App through
   *  AppHandle. */
  objectExtents(ref: ObjRef): [number, number, number] | null {
    const box = this.computeObjectBox(ref);
    if (!box) return null;
    const size = box.getSize(new THREE.Vector3());
    return [size.x, size.y, size.z];
  }

  /** Visual feedback for TRIGGER zones: on enter (highlight color) or
   *  leave (gray) the carrier's outline flashes and fades over ~450ms. */
  private updateZoneFlashes(now: number): void {
    const FLASH_MS = 450;
    for (const f of constraintEngine.fired) {
      const key = `${f.ref.kind}:${f.ref.id}`;
      const root = this.objectRoot(f.ref);
      if (!root) continue;
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) {
        box.setFromCenterAndSize(
          new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(this.ctx.scene, f.ref)),
          new THREE.Vector3(0.5, 0.5, 0.5));
      }
      let entry = this.zoneFlashes.get(key);
      if (!entry) {
        const vp = document.getElementById('viewport');
        const mat = new LineMaterial({
          color: 0xffffff, linewidth: 3, depthTest: false, transparent: true,
          resolution: new THREE.Vector2(vp?.clientWidth || 1, vp?.clientHeight || 1),
        });
        const line = new LineSegments2(new LineSegmentsGeometry(), mat);
        line.renderOrder = 998;
        this.scene3.add(line);
        entry = { line, t0: now, enter: f.kind === 'enter' };
        this.zoneFlashes.set(key, entry);
      }
      entry.t0 = now;
      entry.enter = f.kind === 'enter';
      entry.line.geometry.setPositions(boxEdgePositions(box));
      (entry.line.material as LineMaterial).color.copy(
        f.kind === 'enter' ? this.highlightColor() : srgbColor([0.6, 0.6, 0.65]));
    }
    for (const [key, entry] of this.zoneFlashes) {
      const age = now - entry.t0;
      if (age > FLASH_MS) {
        this.scene3.remove(entry.line);
        entry.line.geometry.dispose();
        (entry.line.material as THREE.Material).dispose();
        this.zoneFlashes.delete(key);
      } else {
        (entry.line.material as LineMaterial).opacity = 1 - age / FLASH_MS;
      }
    }
  }

  private syncSelectionGlyphs(): void {
    const scene = this.ctx.scene;
    const active = this.ctx.settings.mode === 'OBJECT' && !this.presentation;
    this.selGlyphs.visible = active;
    if (!active) {
      // out of object mode there is no selection to show, and a stale hull
      // would sit lit up over a scene nobody is selecting in
      this.meshes.setSelectionOutlines(new Map());
      this.silhouetteGroups = [];
      return;
    }
    const wanted = new Set<string>();
    const refs = listSelected(scene);
    // Blender: the last object touched (click, box-select, shift/cmd-add)
    // is the "active"/target object — brighter outline, and the implicit
    // target for Ctrl+P parenting, Apply, etc. Falls back to the active GP
    // object so something is always highlighted even before any click.
    const activeRef = this.objectPick.lastPicked
      ?? (scene.objects[scene.activeObject] ? { kind: 'GP' as const, id: scene.objects[scene.activeObject].id } : null);
    // Mesh objects wear a SILHOUETTE, not a box (MeshManager draws it as an
    // inverted hull, the same one hover uses). A box is world-axis-aligned,
    // so a rotated object gets a cage that fits nothing and changes size as
    // it rolls — which, now that props tumble, is most of them. Everything
    // with no surface to outline (an EMPTY, a GP object, a splat) keeps the
    // box, where a box is genuinely what there is to show.
    const hulls = new Map<number, string>();
    for (const ref of refs) {
      if (ref.kind !== 'MESH') continue;
      const md = scene.meshes.find((m) => m.id === ref.id);
      // EMPTY has no surface, and a PLANE has no THICKNESS: an inverted hull
      // of a flat quad is coincident with the quad, so it z-fights instead of
      // making a rim. A flat thing's edge loop is already its silhouette, so
      // those keep the line outline (meshEdgePositions handles PLANE).
      if (!md || md.kind === 'EMPTY' || md.kind === 'PLANE') continue;
      const isActive = !!activeRef && activeRef.kind === 'MESH' && activeRef.id === ref.id;
      hulls.set(ref.id, `#${this.highlightColor(isActive).getHexString()}`);
    }
    this.meshes.setSelectionOutlines(hulls);

    // Everything that can be DRAWN but has no surface to fatten wears a
    // silhouette taken from its own render (render/outline.ts): grease
    // pencil hugs its strokes, a splat its opaque cloud, an actor its body.
    // Grouped by colour so the active object can be the brighter one.
    const selGroup: THREE.Object3D[] = [];
    const actGroup: THREE.Object3D[] = [];
    const selRefs: ObjRef[] = [];
    const actRefs: ObjRef[] = [];
    const silhouetted = new Set<string>();
    for (const ref of refs) {
      const root = this.silhouetteRoot(ref);
      if (!root || !root.visible) continue;
      silhouetted.add(`${ref.kind}:${ref.id}`);
      const isActive = !!activeRef && activeRef.kind === ref.kind && activeRef.id === ref.id;
      (isActive ? actGroup : selGroup).push(root);
      (isActive ? actRefs : selRefs).push(ref);
    }
    // Bounds for the scissor. ANY root without trustworthy bounds means the
    // whole frame, because a scissor that is too small does not cost time,
    // it cuts the outline off. A splat's reach is its gaussians, not its
    // centres, so it uses Spark's full extent here rather than the
    // centres-only box the Dimensions readout wants.
    const boxesOf = (refsOf: ObjRef[]): THREE.Box3[] | undefined => {
      const out: THREE.Box3[] = [];
      for (const r of refsOf) {
        const b = r.kind === 'SPLAT' ? this.splatReach(r) : this.computeObjectBox(r);
        if (!b || b.isEmpty()) return undefined;
        out.push(b);
      }
      return out;
    };
    this.silhouetteGroups = [
      { roots: selGroup, color: this.highlightColor(false), boxes: boxesOf(selRefs) },
      { roots: actGroup, color: this.highlightColor(true), boxes: boxesOf(actRefs) },
    ];

    for (const ref of refs) {
      const key = `${ref.kind}:${ref.id}`;
      const root = this.objectRoot(ref);
      if (!root) continue;
      wanted.add(key);
      let entry = this.selHelpers.get(key);
      if (!entry) {
        const box = new THREE.Box3();
        const vp = document.getElementById('viewport');
        const mat = new LineMaterial({
          color: this.highlightColor().getHex(), linewidth: 2, // px, screen-space
          opacity: this.ctx.settings.uiHighlightAlpha,
          depthTest: false, transparent: true, resolution: new THREE.Vector2(vp?.clientWidth || 1, vp?.clientHeight || 1),
        });
        const helper = new LineSegments2(new LineSegmentsGeometry(), mat);
        helper.renderOrder = 999;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        const dot = new THREE.Points(geo, new THREE.PointsMaterial({
          color: this.highlightColor(), size: 7, sizeAttenuation: false, depthTest: false, transparent: true,
          opacity: this.ctx.settings.uiHighlightAlpha,
        }));
        dot.renderOrder = 1000;
        this.selGlyphs.add(helper, dot);
        entry = { box, helper, dot };
        this.selHelpers.set(key, entry);
      }
      const box = this.computeObjectBox(ref);
      if (box) entry.box.copy(box);
      const meshKind = ref.kind === 'MESH' ? scene.meshes.find((m) => m.id === ref.id)?.kind : undefined;
      // A hulled object needs no line at all; the origin dot stays, because
      // the pivot is the one thing a silhouette cannot show.
      // (keyed by KIND as well as id: a GP object and a mesh can share a
      // number, and one used to switch the other's outline off)
      entry.helper.visible = !(ref.kind === 'MESH' && hulls.has(ref.id))
        && !silhouetted.has(key);
      if (entry.helper.visible) {
        // EdgesGeometry every frame is not free, so only for the outlines
        // that are actually drawn
        const realEdges = meshKind ? meshEdgePositions(root, meshKind) : null;
        entry.helper.geometry.setPositions(realEdges ?? boxEdgePositions(entry.box));
      }
      const isActive = !!activeRef && activeRef.kind === ref.kind && activeRef.id === ref.id;
      entry.helper.material.color.copy(this.highlightColor(isActive));
      (entry.dot.material as THREE.PointsMaterial).color.copy(this.highlightColor(isActive));
      entry.helper.material.opacity = this.ctx.settings.uiHighlightAlpha;
      (entry.dot.material as THREE.PointsMaterial).opacity = this.ctx.settings.uiHighlightAlpha;
      entry.helper.material.linewidth = isActive ? 2.5 : 1.5;
      worldMatrixOf(scene, ref).decompose(
        entry.dot.position, new THREE.Quaternion(), new THREE.Vector3());
    }
    for (const [key, entry] of this.selHelpers) {
      if (wanted.has(key)) continue;
      this.selGlyphs.remove(entry.helper, entry.dot);
      entry.helper.geometry?.dispose?.();
      (entry.helper.material as THREE.Material)?.dispose?.();
      entry.dot.geometry.dispose();
      (entry.dot.material as THREE.Material).dispose();
      this.selHelpers.delete(key);
    }
  }

  private syncScoreGlyphs(): void {
    const sc = this.ctx.scene.score;
    const attractors = this.ctx.scene.attractors;
    const key = `${sc.cursors.map((c) => c.id).join(',')}|${sc.triggers.map((t) => t.id).join(',')}|${attractors.map((a) => a.id).join(',')}`;
    if (key !== this.scoreGlyphKey) {
      this.scoreGlyphKey = key;
      for (const child of [...this.scoreGroup.children]) {
        this.scoreGroup.remove(child);
        (child as THREE.Mesh).geometry?.dispose?.();
        ((child as THREE.Mesh).material as THREE.Material)?.dispose?.();
      }
      for (const cur of sc.cursors) {
        const mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.06),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(...cur.color), depthTest: false }),
        );
        mesh.renderOrder = 15000;
        mesh.userData.cursorId = cur.id;
        this.scoreGroup.add(mesh);
      }
      for (const trig of sc.triggers) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(1, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0x58c0d0, wireframe: true, transparent: true, opacity: 0.35 }),
        );
        mesh.userData.triggerId = trig.id;
        this.scoreGroup.add(mesh);
      }
      for (const at of attractors) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.05, 10, 8),
          new THREE.MeshBasicMaterial({ color: 0xe5605e, depthTest: false }),
        );
        mesh.renderOrder = 15000;
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(1, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0xe5605e, wireframe: true, transparent: true, opacity: 0.15 }),
        );
        mesh.add(halo);
        mesh.userData.attractorId = at.id;
        this.scoreGroup.add(mesh);
      }
    }
    for (const child of this.scoreGroup.children) {
      if (child.userData.cursorId !== undefined) {
        const state = this.score.states.get(child.userData.cursorId);
        child.visible = !!state?.valid;
        if (state?.valid) child.position.copy(state.position);
      } else if (child.userData.triggerId !== undefined) {
        const trig = sc.triggers.find((t) => t.id === child.userData.triggerId);
        child.visible = !!trig && !this.presentation; // triggers hidden on stage
        if (trig) {
          worldMatrixOf(this.ctx.scene, { kind: 'TRIGGER', id: trig.id })
            .decompose(child.position, child.quaternion, child.scale);
        }
      } else if (child.userData.attractorId !== undefined) {
        const at = attractors.find((a) => a.id === child.userData.attractorId);
        child.visible = !!at && !this.presentation;
        if (at) {
          child.position.set(...at.position);
          (child.children[0] as THREE.Mesh)?.scale.setScalar(at.radius / 0.05);
        }
      }
    }
  }

  /** Blender-style 3D cursor: red/white dashed ring + crosshair ticks,
   *  billboarded and kept at constant screen size in the render loop. */
  private makeCursorMarker(): THREE.Group {
    const g = new THREE.Group();
    const SEG = 32;
    const ringPts = (r: number) => Array.from({ length: SEG + 1 }, (_, i) => {
      const a = (i / SEG) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0);
    });
    const R = 1; // unit radius; loop scales to px
    const white = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ringPts(R)),
      new THREE.LineBasicMaterial({ color: 0xf2f2f2, depthTest: false }),
    );
    const red = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ringPts(R)),
      new THREE.LineDashedMaterial({ color: 0xd04848, depthTest: false, dashSize: R * 0.35, gapSize: R * 0.35 }),
    );
    red.computeLineDistances();
    // crosshair ticks poking out past the ring (screen-plane, like Blender)
    const tickMat = new THREE.LineBasicMaterial({ color: 0x2a2a2a, depthTest: false });
    const tick = (a: THREE.Vector3, b: THREE.Vector3) =>
      new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), tickMat);
    const t0 = R * 0.55, t1 = R * 1.6;
    g.add(
      white, red,
      tick(new THREE.Vector3(t0, 0, 0), new THREE.Vector3(t1, 0, 0)),
      tick(new THREE.Vector3(-t0, 0, 0), new THREE.Vector3(-t1, 0, 0)),
      tick(new THREE.Vector3(0, t0, 0), new THREE.Vector3(0, t1, 0)),
      tick(new THREE.Vector3(0, -t0, 0), new THREE.Vector3(0, -t1, 0)),
    );
    g.traverse((o) => { o.renderOrder = 20000; });
    return g;
  }

  /** Face the camera and hold ~10px screen radius (persp and ortho). */
  private updateCursorMarker(): void {
    const cam = this.nav.active;
    const m = this.cursorMarker;
    m.quaternion.copy(cam.quaternion);
    const PX = 10;
    const vpH = this.ctx.canvas.clientHeight || 1;
    let worldPerPx: number;
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const persp = cam as THREE.PerspectiveCamera;
      const dist = persp.position.distanceTo(m.position);
      worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / vpH;
    } else {
      const ortho = cam as THREE.OrthographicCamera;
      worldPerPx = (ortho.top - ortho.bottom) / ortho.zoom / vpH;
    }
    m.scale.setScalar(Math.max(1e-6, worldPerPx * PX));
  }

  /** Debug aid: a plain wireframe unit square + a short normal tick,
   *  facing whichever way the plane's normal points. */
  private makePlaneHelper(): THREE.Group {
    const g = new THREE.Group();
    const h = 0.5;
    const square = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0),
        new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false, transparent: true }),
    );
    const normalTick = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0.35)]),
      new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false, transparent: true }),
    );
    g.add(square, normalTick);
    g.traverse((o) => { o.renderOrder = 15000; });
    g.visible = false;
    return g;
  }

  /** Orients the plane helper to the plane strokes/splats actually land
   *  on right now: the active sticky standing plane while mid-stroke
   *  (Surface ⊥ / Stroke ⊥ / View at Origin), else the idle Plane
   *  setting's own resolution — anchored where the pointer ACTUALLY
   *  meets that plane (exactly where the next stroke point would land),
   *  not an unrelated fixed point like the 3D cursor, so it visibly
   *  tracks the stroke you're about to draw or are drawing. */
  private updatePlaneHelper(): void {
    const ctx = this.ctx;
    this.planeHelper.visible = ctx.settings.showPlaneHelper && !this.presentation;
    if (!this.planeHelper.visible) return;
    const plane = currentStickyPlane() ?? drawingPlane(ctx);
    const { x, y } = this.tools.lastPointer;
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    this.planeHelperRay.setFromCamera(ndc, ctx.camera);
    const anchor = new THREE.Vector3();
    if (!this.planeHelperRay.ray.intersectPlane(plane, anchor)) {
      // pointer ray grazes the plane (near-parallel view): fall back to
      // the 3D cursor's projection rather than leaving a stale position
      plane.projectPoint(new THREE.Vector3(...ctx.scene.cursor), anchor);
    }
    this.planeHelper.position.copy(anchor);
    // Object3D.lookAt() picks a fixed world-Y "up" reference to disambiguate
    // roll, which goes degenerate (nearly parallel to the target) whenever
    // the plane's normal is close to world Y — exactly the "looking almost
    // down Y" case, producing an unstable, seemingly-arbitrary 45°-ish
    // rotation. Build the basis directly instead, picking whichever world
    // axis is LEAST aligned with the normal as the reference (same
    // never-degenerate pattern used for triangulateFace/Stroke ⊥ elsewhere
    // in this file), so the square's edges land the same way every frame
    // regardless of view direction.
    const n = plane.normal;
    const tmp = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(tmp, n).normalize();
    const up = new THREE.Vector3().crossVectors(n, right);
    this.planeHelper.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
  }

  /** Debug aid: a dashed line dropping straight from the current
   *  placement point to its footprint on the ground, plus a small ring
   *  marking the footprint — positioned each frame in updateDepthHelper. */
  private makeDepthHelper(): THREE.Group {
    const g = new THREE.Group();
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({
        color: 0xffcc33, depthTest: false, transparent: true, dashSize: 0.15, gapSize: 0.1,
      }),
    );
    const R = 0.08, SEG = 20;
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: SEG + 1 }, (_, i) => {
        const a = (i / SEG) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0);
      })),
      new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false, transparent: true }),
    );
    g.add(line, ring);
    g.traverse((o) => { o.renderOrder = 15000; });
    g.visible = false;
    return g;
  }

  /** Grounds the CURRENT placement point (wherever a mouse-down would
   *  land right now, under whatever Placement mode is active — works for
   *  ORIGIN/CURSOR too, unlike placementPreview which only covers modes
   *  with a discrete snap target — and matches the plane helper's own
   *  anchor) onto the floor: a dashed line straight down to its
   *  footprint, so its depth/height reads clearly against the grid,
   *  plus a ring marking the exact footprint. */
  private updateDepthHelper(): void {
    const ctx = this.ctx;
    this.depthHelper.visible = ctx.settings.showDepthHelper && !this.presentation && !this.nav.flying;
    if (!this.depthHelper.visible) return;
    const { x, y } = this.tools.lastPointer;
    const rect = ctx.canvas.getBoundingClientRect();
    const point = screenToWorld(ctx, x + rect.left, y + rect.top);
    if (!point) { this.depthHelper.visible = false; return; }

    const upIdx = ctx.settings.upAxis === 'Z' ? 2 : 1;
    const foot = point.clone().setComponent(upIdx, 0);

    const line = this.depthHelper.children[0] as THREE.Line;
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, point.x, point.y, point.z);
    pos.setXYZ(1, foot.x, foot.y, foot.z);
    pos.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.computeLineDistances();

    const ring = this.depthHelper.children[1];
    ring.position.copy(foot);
    const normal = new THREE.Vector3().setComponent(upIdx, 1);
    const tmp = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(tmp, normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right);
    ring.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
  }

  /** last size the buffers were built for, so a ResizeObserver that fires
   *  for an unchanged layout costs nothing */
  private sized = { w: 0, h: 0, dpr: 0 };

  private resize(): void {
    const vp = document.getElementById('viewport')!;
    const w = vp.clientWidth, h = vp.clientHeight;
    if (w === 0 || h === 0) return;
    // Render resolution: the GL buffer is drawn at devicePixelRatio x the
    // render scale and stretched to the canvas. On a retina display at 100%
    // that is four pixels per point, and every post pass (full-float edge
    // prepass, bloom) pays for all of them — the one setting that trades
    // sharpness for GPU time directly. The HUD stays at full resolution, so
    // text and measurements stay crisp.
    const r = devicePixelRatio * (this.ctx.settings.renderScale ?? 1);
    if (w === this.sized.w && h === this.sized.h && r === this.sized.dpr) return;
    this.sized = { w, h, dpr: r };
    this.glRenderer.setPixelRatio(r);
    this.glRenderer.setSize(w, h, false);
    if (this.quadView) {
      this.paneRects = computePaneRects(w, h);
      const persp = this.paneRects.persp;
      this.nav.setAspect(persp.w, persp.h);
      for (const pane of this.orthoPanes) {
        const rect = this.paneRects[pane.id];
        const halfH = pane.camera.position.distanceTo(pane.target)
          * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        syncOrthoFrustum(pane.camera, halfH, rect.w / rect.h, pane.zoom);
      }
    } else {
      this.paneRects = null;
      this.nav.setAspect(w, h);
    }
    this.gp.setSize(w * r, h * r);
    this.fx.setSize(w * r, h * r);
    this.post.setSize(w * r, h * r);
    this.hud.width = w * devicePixelRatio;
    this.hud.height = h * devicePixelRatio;
    for (const entry of this.selHelpers.values()) entry.helper.material.resolution.set(w, h);
    this.meshes.outlineResolution.set(w, h);
    this.gp.markDirty();
    this.ui?.drawTimeline();
  }

  /** Renders the 4 quad-view panes into their own sub-rects of the single
   *  canvas via WebGL viewport/scissor. `rects` use top-left-origin CSS px
   *  (DOM/canvas-2D convention, matching computePaneRects); WebGL's own
   *  viewport/scissor origin is bottom-left, so Y is flipped here. */
  private renderQuadView(rects: Record<PaneId, PaneRect>): void {
    const vp = document.getElementById('viewport')!;
    const totalH = vp.clientHeight;
    this.glRenderer.setScissorTest(true);
    const panes: { camera: THREE.Camera; rect: PaneRect }[] = [
      { camera: this.nav.active, rect: rects.persp },
      ...this.orthoPanes.map((p) => ({ camera: p.camera, rect: rects[p.id] })),
    ];
    for (const { camera, rect } of panes) {
      const glY = totalH - rect.y - rect.h;
      this.glRenderer.setViewport(rect.x, glY, rect.w, rect.h);
      this.glRenderer.setScissor(rect.x, glY, rect.w, rect.h);
      this.glRenderer.render(this.scene3, camera);
    }
    this.glRenderer.setScissorTest(false);
    this.glRenderer.setViewport(0, 0, vp.clientWidth, totalH);
  }

  private loop(): void {
    requestAnimationFrame(() => this.loop());
    const ctx = this.ctx;
    const now = performance.now();
    perf.frameStart(now);
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.nav.update(dt);
    ctx.camera = this.nav.active;

    if (this.cameraView) {
      const camData = activeCam(ctx.scene);
      const cameraDriven = ctx.scene.score.attachments.some((a) =>
        a.running && a.target.kind === 'CAMERA'
        && (ctx.scene.cameras[a.target.id] ?? activeCam(ctx.scene)) === camData);
      if (cameraDriven) {
        // an attachment owns the camera: apply its transform to the view
        this.camera.position.set(...camData.translation);
        this.camera.quaternion.setFromEuler(new THREE.Euler(...camData.rotation));
      } else if (this.player.playing || !this.lockCamToView) {
        // keyframes drive the view
        const pose = evalCamera(camData, ctx.scene.frame);
        this.camera.position.copy(pose.position);
        this.camera.quaternion.copy(pose.quaternion);
        if (this.camera.fov !== pose.fov) {
          this.camera.fov = pose.fov;
          this.camera.updateProjectionMatrix();
        }
      } else {
        // locked: viewport navigation (orbit, pan, fly) edits the camera live
        camData.translation = this.camera.position.toArray() as [number, number, number];
        const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion);
        camData.rotation = [e.x, e.y, e.z];
        camData.fov = this.camera.fov;
      }
      this.controls.enabled = this.lockCamToView && !this.player.playing && !this.nav.flying;
    }
    if (this.navLocked) this.controls.enabled = false;
    this.syncCameraHelpers();
    if (!this.nav.flying) this.controls.update();

    // followers: triggers/attractors pinned to an object's world origin
    const followPos = new THREE.Vector3();
    for (const trig of ctx.scene.score.triggers) if (trig.follow) {
      followPos.setFromMatrixPosition(worldMatrixOf(ctx.scene, trig.follow as ObjRef));
      trig.position = [followPos.x, followPos.y, followPos.z];
    }
    for (const at of ctx.scene.attractors) if (at.follow) {
      followPos.setFromMatrixPosition(worldMatrixOf(ctx.scene, at.follow as ObjRef));
      at.position = [followPos.x, followPos.y, followPos.z];
    }

    // native MediaMime: detect on new webcam frames, keep BUS streams
    // subscribed, replay CLIP streams, sample any active recording, re-emit
    // world landmarks, then GPU-sync the point sprites. Runs BEFORE
    // mediamime.update so re-emitted events reach rigs this frame.
    perf.lap('nav');
    liveSources.tick();
    this.paintLivePreviews();
    perf.lap('cameras');
    mmCapture.tick(ctx.scene);
    perf.lap('capture');
    mmStreamEngine.sync(ctx.scene);
    updateClipStreams(ctx.scene, dt);
    clipRecorder.tick(ctx.scene);
    streamPen.tick(ctx);
    mmStreamEngine.emit(ctx.scene);
    this.mmPoints.sync(ctx.scene, this.glRenderer.domElement.height);
    perf.lap('streams');

    // score engine: cursors/triggers/attachments run on their own clocks
    mediamime.setPrefix(ctx.scene.mediamime.prefix);
    mediamime.update(ctx.scene);
    this.score.update(ctx.scene, dt, now);
    this.syncScoreGlyphs();
    perf.lap('score');
    if (this.sim.step(ctx.scene, dt)) ctx.requestRender(this.sim.lastLayerId ?? undefined);
    // Loose props: after the solver, so contact reads this frame's finished
    // pose — a foot's velocity is the kick, and it has to be the real one.
    // Static geometry only: props resolve against each other separately, and
    // a crate solved against its own box would shove itself across the room.
    if (engineOf(ctx.scene) === 'RAPIER') {
      // Lazy: the wasm only loads for a scene that asks for it, and until it
      // has, the frame simply has no prop simulation rather than stalling.
      const upZ = ctx.settings.upAxis === 'Z';
      if (rapierPhysics.ready) {
        if (rapierPhysics.update(ctx.scene, dt, upZ)) this.meshes.sync(ctx.scene, this.nav.active);
      } else {
        // the render tree is where a MODEL's triangles live, and hull/mesh
        // colliders need them
        rapierPhysics.geometrySource = (id) => this.meshes.collisionMesh(id);
        void rapierPhysics.init(upZ);
      }
    } else if (propEngine.update(
      ctx.scene, dt, ctx.settings.upAxis === 'Z',
      walkVolume.gather(ctx.scene).staticBoxes)) {
      this.meshes.sync(ctx.scene, this.nav.active);
    }
    perf.lap('physics');
    this.splats.sync(ctx.scene);
    this.meshes.sync(ctx.scene, this.nav.active);
    this.settlePlacements();
    this.polys.sync(ctx.scene, this.nav.active);
    perf.lap('sync objects');
    this.lights.helpersVisible = !this.presentation && !this.infoOverlayHidden;
    // selection tint only reads as selection in object mode, same gate the
    // Box3 outlines use (syncSelectionGlyphs)
    this.lights.selectionColor =
      ctx.settings.mode === 'OBJECT' && !this.presentation ? this.highlightColor() : null;
    // Actors: the rig turns this frame's capture/route data into joint
    // goals, then the solver runs physics+kinematics over them. Both must
    // happen AFTER the stream engine (they read this frame's landmarks) and
    // BEFORE the constraint engine (which may move the actor as a whole).
    // Mixer first: it only advances crossfades, but every source below asks
    // it how loudly it may speak this frame, so the fades must be current
    // before any of them emit.
    actorMixer.update(ctx.scene, dt, ctx.settings.upAxis === 'Z');
    // Steering moves the ROOT, like possession and like a FOLLOW_PATH
    // constraint — and like both of those it touches no joint: the gait
    // below sees the root move and produces the walking. Before the gait so
    // this frame's motion is this frame's stride, and the constraint pass
    // is told to stand down for anything actually steering, or a path would
    // snap the character back every frame.
    // Scripted intent BEFORE steering: a behaviour sets the goal, steering
    // is what walks to it.
    behaviourEngine.update(ctx.scene, dt, ctx.settings.upAxis === 'Z');
    steerEngine.update(ctx.scene, dt, ctx.settings.upAxis === 'Z');
    // The monologue and the badges are one overlay: both say what the
    // characters are up to, and you want them together or not at all.
    actorLog.enabled = ctx.settings.showActorOverlay !== false && !this.presentation;
    actorLog.tick();
    for (const a of ctx.scene.actors) {
      constraintEngine.setDriven({ kind: 'ACTOR', id: a.id },
        possession.actorId === a.id || steerEngine.hasGoal(a));
    }
    actorRig.update(ctx.scene, dt);
    // Gait AFTER the rig (a capture rig should win over a procedural cycle
    // for any joint both drive) and BEFORE the solver, so its foot/pelvis
    // targets land in the same pass. It reads the actor transform, which
    // the constraint pass below updates — so the cycle is phased on last
    // frame's motion. Imperceptible while walking, and the same deliberate
    // one-frame lag simstream already documents.
    gaitEngine.update(ctx.scene, dt, ctx.settings.upAxis === 'Z');
    // a pose you put an actor in is held until something clears it
    pushHeldPoses(ctx.scene);
    // The solver moves JOINTS, and no stroke geometry depends on a joint —
    // a GP object bound to one rides its group transform, which this loop
    // re-applies every frame anyway. Marking the whole GP scene dirty here
    // rebuilt every layer's ribbons and earcut fills on EVERY frame an actor
    // was moving, which is most frames in a scene with a character in it.
    // That is the cost that made other work (a sky slider, say) read as a
    // stutter: it was landing on top of a rebuild that should not happen.
    actorSolver.update(ctx.scene, dt, ctx.settings.upAxis === 'Z');
    this.actors.handlesVisible = !this.presentation && !this.infoOverlayHidden;
    this.actors.selectionColor =
      ctx.settings.mode === 'OBJECT' && !this.presentation ? this.highlightColor() : null;
    this.actors.sync(ctx.scene);
    perf.lap('actors');
    this.lights.sync(ctx.scene);
    // Blender semantics: Solid/Wireframe are modelling views lit by a fixed
    // studio environment, so the scene's own lamps are held back until
    // Material/Rendered. Material shows the world but still ignores lamps;
    // only Rendered is the full scene.
    this.lights.group.visible = ctx.settings.shading === 'RENDERED';
    materialManager.shading = ctx.settings.shading;
    this.world.update(this.scene3, ctx.scene, ctx.settings.shading, ctx.settings.upAxis === 'Z');
    this.paints.sync(ctx.scene, this.glRenderer.domElement.height);
    perf.lap('world');
    ctx.pickableMeshes = [
      ...ctx.scene.meshes
        .map((m) => this.meshes.rootFor(m.id))
        .filter((r): r is THREE.Object3D => !!r && r.visible),
      ...this.polys.pickTargets(ctx.scene),
    ];
    ctx.surfaces = [
      ...this.canvasSurfaces,
      ...this.meshes.drawTargets(ctx.scene),
      ...this.splats.drawTargets(ctx.scene),
      ...this.polys.drawTargets(ctx.scene),
      ...this.actors.drawTargets(ctx.scene),
    ];
    // constraint stacks (FOLLOW_PATH/FOLLOW_STREAM/TRIGGER/...) — after the
    // score engine (trigger probes include this frame's cursors) and after
    // surfaces (SHRINKWRAP raycasts them). NOTE: this call was documented
    // but never actually wired until the mediamime branch — the engine
    // existed and was imported, but nothing invoked it per frame.
    try {
      constraintEngine.update(
        ctx.scene, dt, this.score, ctx.surfaces, ctx.settings.upAxis === 'Z');
      this.updateZoneFlashes(now);
    } catch (err) {
      console.error('constraint engine:', err);
    }
    // Simulated tracking sources: AFTER constraints, because a driven
    // actor's own world transform (e.g. FOLLOW_PATH walking it around) and
    // its pose (actorSolver, above) both need to be final for this frame
    // before sampling. That means a sim-driven landmark reaches TRIGGER
    // probing one frame later than the capture it's standing in for would —
    // irrelevant for a demo/test source, and simpler than reordering the
    // constraint pass around a feature most scenes never use.
    // Avatars: after the constraint pass, because the actor's own world
    // transform has to be final before the avatar inherits it, and after the
    // solver because it reads the finished pose.
    vrmManager.update(ctx.scene, dt, ctx.settings.upAxis === 'Z');

    tickSimStreams(ctx.scene, ctx.scene.frame);
    perf.lap('constraints');
    this.widget.camera = this.nav.active; // ortho/persp swaps
    // quad view step 1: the widget is scene-graph-resident (renders into
    // every pane) and its own sizing/pointer math is bound to one camera +
    // the whole canvas rect, so it's restricted to the persp pane only —
    // force-hidden here regardless of selection while quad view is on;
    // toggleQuadView() restores selection-driven visibility on the way out
    if (this.quadView) this.widget.getHelper().visible = false;

    if (ctx.scene.score.attachments.some((a) => a.running && a.target.kind === 'CANVAS')) {
      this.syncCanvases();
    }

    if (this.player.tick(ctx.scene)) {
      this.gp.markDirty();
      this.ui.refreshTimelineControls();
      this.ui.drawTimeline();
    }

    perf.lap('misc');
    if (this.gp.needsRebuild) {
      perf.count('GP rebuild');
      try {
        this.gp.update(ctx.scene, this.renderState());
      } catch (err) {
        console.error('GP rebuild failed:', err);
      }
    }
    perf.lap('GP rebuild');
    if (ctx.scene.objects.length) this.lastPencil = activeObject(ctx.scene);
    this.cursorMarker.position.set(...ctx.scene.cursor);
    this.updateCursorMarker();
    this.withPane(this.pointerPane, () => {
      this.updatePlaneHelper();
      this.updateDepthHelper();
    });

    // hide groups whose object has active effects; composite them after
    const fxJobs: { group: THREE.Group; obIndex: number }[] = [];
    ctx.scene.objects.forEach((ob, i) => {
      const group = this.gp.objectGroups[i];
      if (!group) return;
      if (ob.effects.some((f) => f.enabled)) {
        group.visible = false;
        fxJobs.push({ group, obIndex: i });
      }
    });

    // GP object transforms are data-driven (and parent-aware); groups must
    // track every frame — the renderer only sets them on rebuild
    ctx.scene.objects.forEach((ob, i) => {
      const g = this.gp.objectGroups[i];
      if (g) {
        worldMatrixOf(ctx.scene, { kind: 'GP', id: ob.id })
          .decompose(g.position, g.quaternion, g.scale);
      }
    });

    perf.lap('helpers');
    this.syncSelectionGlyphs();
    perf.lap('selection');

    if (this.quadView && this.paneRects) {
      this.renderQuadView(this.paneRects);
      // quad view step 1 scope cut: per-object screen-space FX compositing
      // isn't generalized to 4 panes yet — objects with effects enabled
      // just render without their effect while quad view is on.
      for (const job of fxJobs) job.group.visible = true;
    } else {
      // With a scene look on, the frame is drawn into a target and the post
      // chain presents it. The per-object FX composite into whatever target
      // is BOUND (EffectsPipeline.apply restores it), so they land inside
      // the look rather than being the one thing it never touches.
      const look = ctx.scene.post;
      const styled = postActive(look);
      if (styled) {
        this.glRenderer.setRenderTarget(this.post.target);
        this.glRenderer.clear();
      }
      this.glRenderer.render(this.scene3, this.nav.active);
      perf.lap('render');
      for (const job of fxJobs) {
        const ob = ctx.scene.objects[job.obIndex];
        this.fx.apply(this.glRenderer, (rt) => {
          const savedRoot: boolean[] = this.scene3.children.map((c) => c.visible);
          for (const c of this.scene3.children) c.visible = c === this.gp.root;
          const savedGroups = this.gp.objectGroups.map((g) => g.visible);
          for (const g of this.gp.objectGroups) g.visible = g === job.group;
          const savedBg = this.scene3.background;
          this.scene3.background = null;
          this.glRenderer.setRenderTarget(rt);
          this.glRenderer.setClearColor(0x000000, 0);
          this.glRenderer.clear();
          this.glRenderer.render(this.scene3, this.nav.active);
          this.scene3.background = savedBg;
          this.scene3.children.forEach((c, i) => { c.visible = savedRoot[i]; });
          this.gp.objectGroups.forEach((g, i) => { g.visible = savedGroups[i]; });
        }, ob.effects);
        job.group.visible = true;
      }
      perf.lap('object fx');
      if (styled) {
        this.post.present(this.glRenderer, this.scene3, this.nav.active, look, now / 1000);
        this.glRenderer.setRenderTarget(null);
      }
      perf.lap('post');
      // AFTER the look: a selection rim is interface, and belongs over the
      // finished frame rather than inside the bloom or the paper wash
      this.silhouette.draw(this.glRenderer, this.scene3, this.nav.active,
        this.silhouetteGroups, ctx.settings.uiHighlightAlpha);
      perf.lap('outline');
    }

    this.drawHud();
    perf.lap('hud');
    this.updateStatus();
    this.perfOverlay?.update(now);
    perf.lap('status');
    perf.frameEnd();
  }

  private perfOverlay: PerfOverlay | null = null;

  setRenderScale(scale: number): void {
    this.ctx.settings.renderScale = scale;
    this.savePrefs();
    this.resize();
    this.setStatusHint(`Render resolution ${Math.round(scale * 100)}%`);
    this.ui.refresh();
  }

  private targetImageCache = new Map<string, HTMLImageElement>();

  /** Wire-art assist: the active camera's target drawing, aspect-fit over the view. */
  private drawTargetOverlay(g: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.cameraView) return;
    const cam = activeCam(this.ctx.scene);
    if (!cam?.target) return;
    let img = this.targetImageCache.get(cam.target);
    if (!img) {
      img = new Image();
      img.src = cam.target;
      this.targetImageCache.set(cam.target, img);
    }
    if (!img.complete || !img.naturalWidth) return;
    const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    g.globalAlpha = cam.targetOpacity ?? 0.35;
    g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    g.globalAlpha = 1;
  }

  /**
   * "What is at this pixel, and would the ordinary render have drawn it?"
   *
   * A viewport artefact is nearly always one of two things: geometry you did
   * not know was there, or something drawn into the EDGE PREPASS that the
   * colour pass never draws — `scene.overrideMaterial` replaces a material
   * outright, so any object whose appearance depends on its own material
   * flags or its own vertex shader comes back to life for that one pass (see
   * `hideNonDrawing`). Both look identical on screen and neither can be
   * reasoned about from a screenshot, so this reports the facts: the depth
   * and normal the edge pass believes, and every object along the ray with
   * the material flags that decide whether it is really visible.
   *
   * Call it from the console with the artefact under the pointer:
   * `__tg.whatIsHere()`. Coordinates are optional (client px).
   */
  whatIsHere(clientX?: number, clientY?: number): unknown {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const last = (this.hud as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer;
    const x = clientX !== undefined ? clientX - rect.left : last?.x ?? rect.width / 2;
    const y = clientY !== undefined ? clientY - rect.top : last?.y ?? rect.height / 2;
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);

    // what the edge prepass sees here: rgb = view normal, a = view depth
    let prepass: { depth: number; normal: number[] } | null = null;
    try {
      const rt = this.post.normalTarget;
      const px = Math.round(((ndc.x + 1) / 2) * rt.width);
      const py = Math.round(((ndc.y + 1) / 2) * rt.height);
      const buf = new Float32Array(4);
      this.glRenderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
      prepass = {
        depth: +buf[3].toFixed(4),
        normal: [buf[0] * 2 - 1, buf[1] * 2 - 1, buf[2] * 2 - 1].map((v) => +v.toFixed(3)),
      };
    } catch { /* no prepass this frame (edges off) */ }

    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.ctx.camera);
    const view = this.ctx.camera.getWorldDirection(new THREE.Vector3());
    const along = ray.ray.direction.dot(view);
    const hits = ray.intersectObjects(this.scene3.children, true).slice(0, 10).map((h) => {
      const raw = (h.object as THREE.Mesh).material;
      const mats = Array.isArray(raw) ? raw : [raw];
      const m = mats[0] as THREE.Material | undefined;
      const ref = refOfObject3D(h.object);
      const drawn = !!m && m.visible !== false && m.colorWrite !== false
        && !(m.depthWrite === false && m.transparent);
      // exactly what `hideNonDrawing` stands down for the edge prepass, so
      // the report only cries phantom about something that really is one
      let overlay = false;
      for (let n: THREE.Object3D | null = h.object; n; n = n.parent) {
        if (n.userData.overlay || n.userData.hoverShell) { overlay = true; break; }
      }
      return {
        object: ref ? `${ref.kind} ${objectName(this.ctx.scene, ref)}` : (h.object.name || h.object.type),
        type: h.object.type,
        viewDepth: +(h.distance * along).toFixed(4),
        material: m?.type,
        // the flags that decide whether the colour pass draws it at all —
        // the prepass ignores every one of them
        visible: m?.visible, colorWrite: m?.colorWrite, transparent: m?.transparent,
        depthWrite: m?.depthWrite, opacity: m?.opacity,
        inColourPass: drawn,
        inEdgePass: !(overlay || !drawn),
        // THE line worth reading. `prepass.depth` is what the edge pass
        // actually believes is nearest at this pixel, so the object sitting
        // at that exact depth is the one drawing the lines here — and if the
        // colour pass would not draw that object, it is the phantom. No
        // material flag can decide this on its own: a mesh whose shape comes
        // out of its own vertex shader, or one masked by a stencil, passes
        // every flag and still draws something else entirely under an
        // override material.
        isEdgeSurface: prepass !== null && Math.abs(h.distance * along - prepass.depth) < 0.02,
      };
    });
    const phantoms = hits.filter((h) => h.isEdgeSurface && !h.inColourPass);
    return {
      pixel: { x: Math.round(x), y: Math.round(y) },
      prepass,
      // an empty list with a prepass depth that matches nothing in `hits` is
      // itself the answer: whatever is drawing there is not raycastable
      // (points, lines, or geometry built in a shader)
      phantoms,
      hits,
    };
  }

  /** Draw pointer-relative HUD in the pane the pointer is in: pane camera,
   *  pane-local coordinates, clipped to the pane. Outside quad view, just fn. */
  private paneHud(g: CanvasRenderingContext2D, fn: () => void): void {
    const pane = this.pointerPane;
    if (!pane || !this.quadView || !this.paneRects) { fn(); return; }
    const r = this.paneRects[pane];
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.translate(r.x, r.y);
    try { this.withPane(pane, fn); } finally { g.restore(); }
  }

  /** Draw world-anchored HUD once per view: each quad pane through its own
   *  camera, clipped to it; the single view otherwise. */
  private eachPaneHud(g: CanvasRenderingContext2D, fn: () => void): void {
    if (!this.quadView || !this.paneRects) { fn(); return; }
    for (const id of ['persp', 'front', 'side', 'top'] as PaneId[]) {
      const r = this.paneRects[id];
      g.save();
      g.beginPath();
      g.rect(r.x, r.y, r.w, r.h);
      g.clip();
      g.translate(r.x, r.y);
      try { this.withPane(id, fn); } finally { g.restore(); }
    }
  }

  private drawHud(): void {
    const g = this.hud.getContext('2d')!;
    g.clearRect(0, 0, this.hud.width, this.hud.height);
    g.save();
    g.scale(devicePixelRatio, devicePixelRatio);
    this.drawTargetOverlay(g, this.hud.width / devicePixelRatio, this.hud.height / devicePixelRatio);
    // Measurements are drawn in EVERY mode, not only while the measure tool
    // is active: a dimension you can only see inside one tool is a mode, not
    // an annotation of the scene. The tool adds the rubber-band leg on top,
    // so it draws them itself and this stands down while it is running.
    // In quad view they are drawn in EVERY pane through that pane's camera,
    // like any object in the scene; the tool's draft is world points too, so
    // it goes with them rather than through the pointer's pane alone.
    const measureTool = this.tools.active?.id === 'measure' ? this.tools.active as MeasureTool : undefined;
    this.eachPaneHud(g, () => drawMeasures(this.ctx, g, measureTool));
    if (!measureTool) this.paneHud(g, () => this.tools.active?.drawHud?.(this.ctx, g));
    if (this.objModal.active) {
      const w = this.hud.width / devicePixelRatio;
      const kind = this.objModal.trackball ? 'Rotate (trackball)'
        : this.objModal.kind === 'move' ? 'Move'
        : this.objModal.kind === 'rotate' ? 'Rotate' : 'Scale';
      const lock = this.objModal.axis === 'none' ? ''
        : this.objModal.planeLock ? ` ⟂${this.objModal.axis.toUpperCase()}` : ` ${this.objModal.axis.toUpperCase()}`;
      g.font = '12px ui-monospace, monospace';
      g.textAlign = 'center';
      const line = `${kind}${lock}   ${this.objModal.info}`;
      const tw = g.measureText(line).width + 20;
      g.fillStyle = 'rgba(20,20,22,0.85)';
      g.fillRect(w / 2 - tw / 2, 8, tw, 22);
      g.fillStyle = '#e8e8ec';
      g.fillText(line, w / 2, 23);
      g.textAlign = 'left';
    }
    // Placement preview: show what the pointer will snap to (every mode
    // with a discrete target — ORIGIN/CURSOR have none, so no HUD there)
    if (this.ctx.settings.mode === 'DRAW' && !this.nav.flying) this.paneHud(g, () => {
      const { x, y } = this.tools.lastPointer;
      const anchor = placementPreview(this.ctx, x, y);
      if (anchor) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(anchor.x, anchor.y);
        g.strokeStyle = 'rgba(255,190,80,0.5)';
        g.lineWidth = 1;
        g.stroke();
        g.beginPath();
        g.arc(anchor.x, anchor.y, 5, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(255,190,80,0.95)';
        g.lineWidth = 1.6;
        g.stroke();
      }
    });
    if (!this.presentation) {
      const inset = this.ui.inspectorOpen ? 250 : 0;
      this.nav.drawGizmo(g, this.hud.width / devicePixelRatio - inset);
    }
    // ---- per-actor state badges ----------------------------------------
    // Above the head, in the same hues the log uses. The monologue says what
    // a character INTENDS; this says what is actually happening to it, and
    // the two disagreeing is the most useful thing on screen.
    if (!this.presentation && !this.infoOverlayHidden
      && this.ctx.settings.showActorOverlay !== false) {
      const upZ = this.ctx.settings.upAxis === 'Z';
      const upAxis = upZ ? 2 : 1;
      const head = new THREE.Vector3();
      g.font = '600 11px sans-serif';
      g.textAlign = 'center';
      for (const actor of this.ctx.scene.actors) {
        if (!actor.visible) continue;
        const hi = actor.joints.findIndex((j) => j.name === 'head');
        const local = hi >= 0 ? actor.pose[hi] : null;
        head.set(local?.[0] ?? 0, local?.[1] ?? 0, local?.[2] ?? 0);
        head.applyMatrix4(worldMatrixOf(this.ctx.scene, { kind: 'ACTOR', id: actor.id }));
        head.setComponent(upAxis, head.getComponent(upAxis) + 0.28);
        const p = head.clone().project(this.ctx.camera);
        if (p.z > 1 || p.z < -1) continue;      // behind the camera
        const x = (p.x * 0.5 + 0.5) * (this.hud.width / devicePixelRatio);
        const y = (-p.y * 0.5 + 0.5) * (this.hud.height / devicePixelRatio);
        const st = actorState(this.ctx.scene, actor, upZ, possession.actorId);
        const main = `${actor.name} · ${st.label}`;
        const tail = ` · ${st.driver}`;
        // The driver rides along in a dimmer tone: which system is producing
        // the pose is the question you have the moment more than one can.
        const wMain = g.measureText(main).width;
        g.font = '11px sans-serif';
        const wTail = g.measureText(tail).width;
        g.font = '600 11px sans-serif';
        const w = wMain + wTail;
        g.fillStyle = 'rgba(20,20,24,0.62)';
        g.beginPath();
        g.roundRect(x - w / 2 - 6, y - 14, w + 12, 17, 5);
        g.fill();
        g.textAlign = 'left';
        g.fillStyle = st.color;
        g.fillText(main, x - w / 2, y - 2);
        g.font = '11px sans-serif';
        g.fillStyle = 'rgba(210,210,220,0.72)';
        g.fillText(tail, x - w / 2 + wMain, y - 2);
        g.font = '600 11px sans-serif';
        g.textAlign = 'center';
      }
      g.textAlign = 'left';
    }

    if (this.nav.flying) {
      g.fillStyle = '#fff';
      g.font = '13px sans-serif';
      g.fillText('FLY — WASD move · Q/E down/up · wheel speed · Shift boost · Enter/click accept · Esc cancel', 16, 24);
    }
    if (this.modal.active && this.ctx.settings.propEdit.enabled) this.paneHud(g, () => {
      const { x, y } = this.tools.lastPointer;
      g.beginPath();
      g.arc(x, y, this.ctx.settings.propEdit.radius, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(160,160,170,0.5)';
      g.stroke();
    });
    g.restore();
  }

  /** Transient one-line message in the status bar (bake results, warnings)
   *  — outlives a few frames then falls back to the mode hint. */
  private statusHint: { text: string; until: number } | null = null;
  setStatusHint(text: string, ms = 4000): void {
    this.statusHint = { text, until: performance.now() + ms };
  }

  private updateStatus(): void {
    const s = this.ctx.settings;
    const status = document.getElementById('status')!;
    if (this.statusHint) {
      if (performance.now() < this.statusHint.until) {
        status.textContent = this.statusHint.text;
        return;
      }
      this.statusHint = null;
    }
    const hints: Record<string, string> = {
      OBJECT: 'LMB select (Shift extends) · widget or G/R/S mode · X delete · Add… for primitives/models · Shift+RMB drag cursor · RMB menu',
      DRAW: 'LMB draw · MMB orbit · RMB pan · Shift+RMB drag cursor · Tab edit mode',
      EDIT: 'LMB select (drag box, Ctrl lasso) · G/R/S transform · X delete · Shift+D dup · A all',
      SCULPT: 'LMB sculpt · Ctrl inverts brush',
      VERTEX: 'LMB paint vertex color',
      WEIGHT: 'LMB paint weight · Ctrl erases',
    };
    status.textContent = this.objModal.active
      ? 'LMB/Enter confirm · RMB/Esc cancel · X/Y/Z axis (Shift+axis = plane, again clears) · G/R/S switch · RR trackball · type a number for exact · Shift precision · Ctrl inverts snap'
      : `${s.mode} — ${s.activeTool} · frame ${this.ctx.scene.frame} · ${hints[s.mode]}`;
  }
}

/** Where a drop landed, and which way the surface there faces. */
export interface DropTarget {
  point: Vec3;
  normal: Vec3 | null;
  /** true when it landed ON something, rather than on the ground plane */
  onSurface: boolean;
  /** lay an image FLAT on the point (Plane: Top) rather than standing it up */
  flat?: boolean;
}

/** Mark a subtree as EDITOR FURNITURE — gizmos, helpers, frusta. The scene
 *  look's edge prepass skips these (see `hideNonDrawing`), because a line
 *  drawing of the scene should not contain a drawing of the tools. */
function markOverlay(root: THREE.Object3D): void {
  root.traverse((o) => { o.userData.overlay = true; });
}

new App();

