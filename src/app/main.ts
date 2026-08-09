import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { createScene, activeObject, activeLayer, activeCam, createDefaultCamera, createLight, createObject, createFrame, cloneFrame, frameAt, keyframeIndexAt, baseTextureSrc, setBaseTexture } from '../core/gpdata';
import { History } from '../core/history';
import type { GPScene, TGLight } from '../core/types';
import { GPSceneRenderer, type EditorMode } from '../render/GPSceneRenderer';
import { EffectsPipeline } from '../fx/effects';
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
import { currentStickyPlane, drawingPlane, nearestStrokeEdgeAll, nearestStrokePointAll, nearestStrokeSegmentAll, objectToScreen, perpendicularFoot, placementPreview, raycastFaceTriangle, raycastSurfaces, screenToWorld } from '../tools/projection';
import { evalCamera, insertCameraKey, removeCameraKey } from '../anim/camera';
import { ACTIONS, Keymap, comboFromEvent } from './keymap';
import { CommandRegistry } from './commands';
import { BRUSH_PRESETS as BRUSH_PRESETS_CACHE } from '../core/brushes';
import { listAssets, meshAssetPayload, saveAsset, splatAssetPayload, type TGAsset } from '../io/assets';
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
import type { BakeSource } from '../render/bake';
import { bakeEngine } from '../render/bake';
import { PaintCloudManager, createPaintCloud } from '../render/paintclouds';
import { setSplatPickSource } from '../tools/splatpick';
import { setStencilObjectResolver, setStencilVideoSource } from '../tools/stencil';
import { SplatPaintTool } from '../tools/splatbrush';
import { TexturePaintTool, setTexPaintMeshManager, setTexPaintPolyManager } from '../tools/texpaint';
import { PolyPenTool } from '../tools/polytool';
import { clearPolyOverlay, polyOverlay } from '../render/polymesh';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  ObjectSelectTool, deleteObject, deselectAllObjects, getObjectTransform,
  allRefs, applyObjectTransform, gpIndexOf, listSelected, parentWorldMatrixOf, selectionPivot,
  setObjectSelected, setObjectTransform, setParentKeepWorld, worldMatrixOf,
  type ObjRef, type ObjTransform,
} from '../tools/objects';
import { UI, type AppHandle } from './ui';
import type { Tool } from '../tools/toolsys';
import { Navigation } from './nav';
import type { OrthoPane, PaneId, PaneRect } from './quadview';
import { computePaneRects, createOrthoPanes, relockOrthoPane, syncOrthoFrustum } from './quadview';
import type { CanvasPlane } from '../core/types';

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
  private selHelpers = new Map<string, { box: THREE.Box3; helper: LineSegments2; dot: THREE.Points }>();
  private interpTool = new InterpolateTool();
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
    };

    // scene dressing
    this.scene3.background = srgbColor(settings.background);
    this.grid = this.makeGrid();
    this.grid.position.y = -2;
    this.scene3.add(this.grid);
    this.applyThemeColors();
    this.camHelper = new THREE.Group();
    this.scene3.add(this.camHelper);
    this.scene3.add(this.gp.root);
    this.cursorMarker = this.makeCursorMarker();
    this.scene3.add(this.cursorMarker);
    this.planeHelper = this.makePlaneHelper();
    this.scene3.add(this.planeHelper);
    this.depthHelper = this.makeDepthHelper();
    this.scene3.add(this.depthHelper);
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
    // mesh objects use MeshStandardMaterial — GP shaders ignore lights.
    // Lights are scene data now (scene.lights, migrated from the two that
    // used to be hardcoded here); LightManager mirrors them each frame.
    this.scene3.add(this.lights.group);

    // object-mode transform widget
    this.scene3.add(this.widgetProxy);
    this.widget = new TransformControls(this.camera, glCanvas);
    this.widget.setSize(0.8);
    this.scene3.add(this.widget.getHelper());
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
      this.polyPen, this.polyBuild, this.quadPatch, new SplatPaintTool(), new TexturePaintTool(),
    ]) this.tools.register(t);
    this.tools.setActive(this.ctx, 'draw');

    this.ui = new UI(this);
    this.buildCommands();
    const tg = this as unknown as Record<string, unknown>;
    tg.execute = (q: string, args?: string) => this.commands.execute(q, args);
    (window as unknown as Record<string, unknown>).__tg = this; // debug/scripting handle; __tg.execute() = agent API

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
    // "Edit mode" edits whatever object is active — with an editable mesh
    // as the selection, EDIT opens straight onto the PolyQuilt tool (no
    // standalone poly mode; GP objects keep the GP point editor).
    const enterPolyPen = mode === 'EDIT' && (() => {
      const scene = this.ctx.scene;
      const picked = this.objectPick.lastPicked;
      const pickedPoly = picked?.kind === 'POLY'
        && scene.polyMeshes.some((p) => p.id === picked.id && p.select);
      const onlyPolySelected = scene.polyMeshes.some((p) => p.select)
        && !scene.objects.some((o) => o.select);
      return pickedPoly || onlyPolySelected;
    })();
    if (mode !== this.ctx.settings.mode) this.modeHistory = [this.ctx.settings.mode, mode];
    // OBJECT mode (and the outliner) tolerate zero GP objects — every
    // other mode edits the active one, so create a blank on entry rather
    // than force one to always exist (lets "delete the last GP object"
    // actually empty the scene while staying in Object mode).
    if (mode !== 'OBJECT' && this.ctx.scene.objects.length === 0) {
      this.ctx.scene.objects.push(createObject('Pencil1'));
      this.ctx.scene.activeObject = 0;
    }
    this.ctx.settings.mode = mode;
    this.setTool(enterPolyPen ? 'polypen' : DEFAULT_TOOL[mode]);
    this.gp.markDirty();
    this.refreshWidget();
    this.ui.refresh();
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
    if (id === 'polypen' || id === 'polybuild' || id === 'quadpatch') {
      const scene = this.ctx.scene;
      const picked = this.objectPick.lastPicked;
      const target = (picked?.kind === 'POLY' ? scene.polyMeshes.find((p) => p.id === picked.id) : undefined)
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
  private placeCursor(clientX: number, clientY: number): void {
    const ctx = this.ctx;
    const rect = ctx.canvas.getBoundingClientRect();
    const snap = ctx.settings.snap;

    if (snap.enabled && snap.mode === 'POINT') {
      const hit = nearestStrokePointAll(ctx, clientX - rect.left, clientY - rect.top, 60, ctx.settings.snap.strokeScope ?? 'ANY');
      if (hit) {
        ctx.scene.cursor = [hit.x, hit.y, hit.z];
        this.gp.markDirty();
        return;
      }
      // no stroke nearby: fall through to plane placement
    }
    if (snap.enabled && (snap.mode === 'EDGE' || snap.mode === 'EDGE_CENTER' || snap.mode === 'EDGE_PERP')) {
      // continuous along the path — this is how the cursor rides a stroke
      // freely instead of jumping vertex to vertex. CENTER locks to segment
      // midpoints; PERP drops the foot of the perpendicular from where the
      // cursor currently sits (its pre-move position).
      const seg = nearestStrokeSegmentAll(ctx, clientX - rect.left, clientY - rect.top, 60, ctx.settings.snap.strokeScope ?? 'ANY');
      if (seg) {
        const hit = snap.mode === 'EDGE_CENTER' ? seg.a.clone().lerp(seg.b, 0.5)
          : snap.mode === 'EDGE_PERP' ? perpendicularFoot(seg.a, seg.b, new THREE.Vector3(...ctx.scene.cursor))
          : seg.a.clone().lerp(seg.b, seg.t);
        ctx.scene.cursor = [hit.x, hit.y, hit.z];
        this.gp.markDirty();
        return;
      }
    }
    if (snap.enabled && (snap.mode === 'FACE_CENTER' || snap.mode === 'FACE_NEAREST')) {
      const hit = raycastFaceTriangle(ctx, clientX, clientY);
      if (hit) {
        const p = new THREE.Vector3();
        if (snap.mode === 'FACE_CENTER') hit.tri.getMidpoint(p);
        else hit.tri.closestPointToPoint(new THREE.Vector3(...ctx.scene.cursor), p);
        ctx.scene.cursor = [p.x, p.y, p.z];
        this.gp.markDirty();
        return;
      }
    }
    if (snap.enabled && (snap.mode === 'SURFACE' || snap.mode === 'CANVAS')) {
      const hit = raycastSurfaces(ctx, clientX, clientY);
      if (hit) {
        ctx.scene.cursor = [hit.x, hit.y, hit.z];
        this.gp.markDirty();
        return;
      }
      // nothing under the pointer: fall through to plane placement
    }
    if (snap.enabled && snap.mode === 'OBJECT') {
      // nearest object origin in screen space
      const w = rect.width, h = rect.height;
      let best: THREE.Vector3 | null = null;
      let bestD = 80; // px
      for (const ref of allRefs(ctx.scene)) {
        const pos = new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(ctx.scene, ref));
        const ndc = pos.clone().project(this.nav.active);
        if (ndc.z > 1) continue;
        const dx = (ndc.x * 0.5 + 0.5) * w - (clientX - rect.left);
        const dy = (-ndc.y * 0.5 + 0.5) * h - (clientY - rect.top);
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = pos; }
      }
      if (best) {
        ctx.scene.cursor = [best.x, best.y, best.z];
        this.gp.markDirty();
        return;
      }
    }
    const world = screenToWorld(ctx, clientX, clientY);
    if (!world) return;
    // for a cursor CLICK there is no meaningful "relative increment", so
    // INCREMENT and GRID both land on the absolute lattice (Blender does
    // the same for cursor snapping)
    if (snap.enabled && (snap.mode === 'INCREMENT' || snap.mode === 'GRID')) {
      const g = snapIncrement(ctx.settings);
      // Blender semantics: grid = the visible world floor grid, not a
      // lattice on the current drawing plane. Raycast the ground plane
      // and round the two in-plane world coordinates.
      const zUp = ctx.settings.upAxis === 'Z';
      const groundNormal = zUp ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.nav.active);
      const hit = new THREE.Vector3();
      if (Math.abs(ray.ray.direction.dot(groundNormal)) > 0.05
        && ray.ray.intersectPlane(new THREE.Plane(groundNormal, 0), hit)) {
        if (zUp) {
          ctx.scene.cursor = [Math.round(hit.x / g) * g, Math.round(hit.y / g) * g, 0];
        } else {
          ctx.scene.cursor = [Math.round(hit.x / g) * g, 0, Math.round(hit.z / g) * g];
        }
        this.gp.markDirty();
        return;
      }
      // grazing view (front/side): the floor grid is edge-on, so snap on
      // the drawing plane's lattice instead (matches Blender's ortho grid)
      const plane = drawingPlane(ctx);
      const anchor = plane.normal.clone().multiplyScalar(-plane.constant);
      const tmp = Math.abs(plane.normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(tmp, plane.normal).normalize();
      const v = new THREE.Vector3().crossVectors(plane.normal, u);
      const d = world.clone().sub(anchor);
      world.copy(anchor)
        .addScaledVector(u, Math.round(d.dot(u) / g) * g)
        .addScaledVector(v, Math.round(d.dot(v) / g) * g);
    }
    ctx.scene.cursor = [world.x, world.y, world.z];
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
    this.ctx.surfaces = [...this.canvasSurfaces, ...this.meshes.drawTargets(this.ctx.scene)];
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
      this.placeCursor(e.clientX, e.clientY);
      this.capture(e);
    }, { capture: true });

    canvas.addEventListener('pointerdown', (e) => {
      (this.hud as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer = this.toolEvent(e);
      if (this.nav.flying) {
        if (e.button === 0) this.nav.stopFly(); // click confirms fly position
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
        const hit = this.objectPick.pick(this.ctx, this.toolEvent(e));
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
      this.tools.handleDown(this.ctx, this.toolEvent(e));
    });

    canvas.addEventListener('pointermove', (e) => {
      const te = this.toolEvent(e);
      (this.hud as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer = te;
      if (this.cursorDrag) {
        this.placeCursor(e.clientX, e.clientY);
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
        this.objModal.update(this.ctx, te, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
        return;
      }
      if (this.modal.active) { this.modal.update(this.ctx, te); return; }
      // coalesced events give smoother strokes
      const coalesced = e.getCoalescedEvents?.();
      const events = coalesced && coalesced.length ? coalesced : [e];
      for (const ce of events) this.tools.handleMove(this.ctx, this.toolEvent(ce as PointerEvent));
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 2) {
        if (this.cursorDrag) { this.cursorDrag = false; return; }
        const down = this.rmbDown;
        this.rmbDown = null;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && !this.presentation) {
          if (this.ctx.settings.mode === 'OBJECT') this.ui.openObjectContextMenu(e.clientX, e.clientY);
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
      this.tools.handleUp(this.ctx, this.toolEvent(e));
    });

    window.addEventListener('keyup', (e) => { this.nav.handleFlyKey(e, false); });

    canvas.addEventListener('wheel', (e) => {
      if (this.modal.active && this.ctx.settings.propEdit.enabled) {
        this.modal.adjustRadius(this.ctx, -e.deltaY, this.tools.lastPointer);
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

    // Dropdowns keep keyboard focus after a pick (or after Escape closes
    // the native popup without picking), which silently disables every
    // shortcut until the user clicks back into the viewport — App.onKey
    // bails whenever e.target is a SELECT. Blur it ourselves so the very
    // next keystroke reaches the app again.
    window.addEventListener('change', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'SELECT') (e.target as HTMLElement).blur();
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
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const ctx = this.ctx;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (this.ui.settingsOpen) return; // dialog handles its own keys
    if (this.objectPicking && key === 'Escape') {
      const cb = this.objectPicking;
      this.objectPicking = null;
      this.ctx.canvas.style.cursor = 'default';
      cb(null);
      return;
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
      else if (key === 'x' || key === 'X') om.setAxis(ctx, 'x', e.shiftKey);
      else if (key === 'y' || key === 'Y') om.setAxis(ctx, 'y', e.shiftKey);
      else if (key === 'z' || key === 'Z') om.setAxis(ctx, 'z', e.shiftKey);
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
      else if (key === 'x' || key === 'X') this.modal.setAxis('x', ctx, this.tools.lastPointer);
      else if (key === 'y' || key === 'Y') this.modal.setAxis('y', ctx, this.tools.lastPointer);
      else if (key === 'z' || key === 'Z') this.modal.setAxis('z', ctx, this.tools.lastPointer);
      e.preventDefault();
      return;
    }

    if (this.tools.handleKey(ctx, key, e)) { e.preventDefault(); return; }

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
      case 'modePie': this.ui.openModePie(this.tools.lastPointer); break;
      case 'modeDraw': this.setMode('DRAW'); break;
      case 'modeEdit': this.setMode('EDIT'); break;
      case 'modeSculpt': this.setMode('SCULPT'); break;
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
        if (ctx.settings.mode === 'OBJECT') this.objModal.begin(ctx, 'move', this.tools.lastPointer);
        else if (this.editLike()) this.modal.begin(ctx, 'move', this.tools.lastPointer);
        break;
      case 'rotate':
        if (ctx.settings.mode === 'OBJECT') this.objModal.begin(ctx, 'rotate', this.tools.lastPointer);
        else if (this.editLike()) this.modal.begin(ctx, 'rotate', this.tools.lastPointer);
        break;
      case 'scale':
        if (ctx.settings.mode === 'OBJECT') this.objModal.begin(ctx, 'scale', this.tools.lastPointer);
        else if (this.editLike()) this.modal.begin(ctx, 'scale', this.tools.lastPointer);
        break;
      case 'selectAll': if (this.editLike()) { selectAll(ctx, 'all'); this.gp.markDirty(); } break;
      case 'selectNone': if (this.editLike()) { selectAll(ctx, 'none'); this.gp.markDirty(); } break;
      case 'selectInvert': if (this.editLike()) { selectAll(ctx, 'invert'); this.gp.markDirty(); } break;
      case 'selectLinked': if (this.editLike()) { selectLinked(ctx); this.gp.markDirty(); } break;
      case 'selectConnected': if (this.editLike()) { ctx.pushUndo(); selectConnected(ctx); this.gp.markDirty(); this.ui.refresh(); } break;
      case 'join': if (this.editLike()) { ops.joinSelected(ctx); this.ui.refresh(); } break;
      case 'split': if (this.editLike()) { ops.splitSelected(ctx); this.ui.refresh(); } break;
      case 'separate': if (this.editLike()) { ops.separateSelected(ctx); this.gp.markDirty(); this.ui.refresh(); } break;
      case 'renameObject': this.ui.renameActiveObject(); break;
      case 'selectMore': if (this.editLike()) { selectMoreLess(ctx, true); this.gp.markDirty(); } break;
      case 'selectLess': if (this.editLike()) { selectMoreLess(ctx, false); this.gp.markDirty(); } break;
      case 'delete':
        if (ctx.settings.mode === 'OBJECT') {
          const refs = listSelected(ctx.scene);
          if (refs.length) {
            ctx.pushUndo();
            for (const ref of refs) deleteObject(ctx.scene, ref);
            this.syncCanvases();
            this.gp.markDirty();
            this.refreshWidget();
            this.ui.refresh();
          }
          break;
        }
        if (this.editLike()) {
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
          this.modal.begin(ctx, 'move', this.tools.lastPointer);
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
      case 'cameraView': this.toggleCameraView(); break;
      case 'cycleCamera': this.cycleCamera(); break;
      case 'save': this.saveScene(); break;
      case 'open': void this.loadScene(); break;
      case 'newScene': this.newScene(); break;
      case 'viewAll': this.viewAll(); break;
      case 'quadView': this.toggleQuadView(); break;
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
    this.grid.visible = !this.presentation;
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
    this.quadView = !this.quadView;
    if (this.quadView) {
      // reframe the 3 ortho panes from the persp camera's CURRENT distance,
      // so quad view opens roughly matching what you were just looking at
      const dist = this.camera.position.distanceTo(this.controls.target);
      this.orthoPanes = createOrthoPanes(this.nav.upAxis, dist);
    } else {
      this.refreshWidget(); // restore selection-driven visibility (step 1 forces it hidden while on)
    }
    this.resize();
  }

  /** Alt+Shift+Z: floor grid + bottom-left status/info overlay. */
  toggleInfoOverlay(): void {
    this.infoOverlayHidden = !this.infoOverlayHidden;
    this.grid.visible = !this.infoOverlayHidden && !this.presentation;
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

  setBackground(rgb: [number, number, number]): void {
    this.ctx.settings.background = rgb;
    (this.scene3.background as THREE.Color).copy(srgbColor(rgb));
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
    const main = s.gridColor ? srgbColor(s.gridColor) : this.autoGridColor(s.background);
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
  rebuildGrid(): void {
    const old = this.grid;
    this.grid = this.makeGrid();
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

    for (const kind of ['PLANE', 'BOX', 'SPHERE', 'CYLINDER', 'EMPTY'] as const) {
      add(`add.${kind.toLowerCase()}`, `Add ${kind.toLowerCase()} at cursor`,
        () => this.addMeshObject(kind), 'object primitive mesh');
    }
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
      { label: 'Cylinder', icon: 'cylinder', do: () => this.addMeshObject('CYLINDER', undefined, cursorAt) },
      { label: 'Editable Mesh', icon: 'wireframe', do: () => this.addPolyMeshObject(cursorAt) },
      { label: 'Empty', icon: 'target', do: () => this.addMeshObject('EMPTY', undefined, cursorAt) },
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

  /** N6 assets: snapshot the (single) selected object into the library. */
  saveSelectedAsAsset(): void {
    const scene = this.ctx.scene;
    const refs = listSelected(scene);
    if (refs.length !== 1) { alert('Select exactly one object to save as asset'); return; }
    const ref = refs[0];
    if (ref.kind === 'GP') {
      const ob = scene.objects.find((o) => o.id === ref.id);
      if (ob) saveAsset(ob.name, 'GP', serializeGPObject(ob));
    } else if (ref.kind === 'MESH') {
      const m = scene.meshes.find((x) => x.id === ref.id);
      if (m) saveAsset(m.name, 'MESH', meshAssetPayload(m));
    } else if (ref.kind === 'SPLAT') {
      const s = scene.splats.find((x) => x.id === ref.id);
      if (s) saveAsset(s.name, 'SPLAT', splatAssetPayload(s));
    } else {
      alert('Canvases are legacy — save is not supported');
      return;
    }
    this.ui.refresh();
  }

  /** N6 assets: instance an asset at the 3D cursor. */
  addAssetToScene(asset: TGAsset): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const at = [...scene.cursor] as [number, number, number];
    if (asset.kind === 'GP') {
      importGPObjects(scene, asset.payload);
      const ob = scene.objects[scene.objects.length - 1];
      ob.translation = at;
      scene.activeObject = scene.objects.length - 1;
      this.gp.markDirty();
    } else if (asset.kind === 'MESH') {
      const def = JSON.parse(asset.payload);
      scene.meshes.push({ ...def, id: Date.now() % 1e9, parent: null, select: false, translation: at });
      this.meshes.sync(scene);
    } else {
      const def = JSON.parse(asset.payload);
      scene.splats.push({ ...def, id: Date.now() % 1e9, parent: null, select: false, translation: at });
    }
    this.ui.refresh();
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
    if (!this.ctx.scene.mmStreams.some((s) => s.source === 'CAMERA')) mmCapture.stop();
    this.ui.refresh();
  }

  mmCaptureToggle(): void {
    if (mmCapture.status === 'on' || mmCapture.status === 'starting') mmCapture.stop();
    else void mmCapture.start(this.ctx.scene);
    this.ui.refresh();
  }

  /** Start capture from a URL or file (video, or animated webp/gif) instead
   *  of the webcam — test/iterate without camera access. */
  mmCaptureStart(source?: { url?: string; file?: File }): void {
    void mmCapture.start(this.ctx.scene, source);
    this.ui.refresh();
  }

  mmSetPlaybackRate(rate: number): void {
    mmCapture.setPlaybackRate(rate);
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

  addMeshObject(kind: 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER' | 'EMPTY', src?: string, at?: [number, number, number]): void {
    this.ctx.pushUndo();
    const id = Date.now() % 1e9;
    this.ctx.scene.meshes.push(createMeshObject(id, src ? 'MODEL' : kind, at ?? [...this.ctx.scene.cursor], src));
    this.meshes.sync(this.ctx.scene);
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

  /** Blender Add > Grease Pencil > Blank: new empty GP object at the 3D cursor. */
  addGPObject(at?: [number, number, number]): void {
    const scene = this.ctx.scene;
    this.ctx.pushUndo();
    const n = scene.objects.length + 1;
    const ob = createObject(`Pencil${n}`);
    ob.translation = at ?? [...scene.cursor];
    scene.objects.push(ob);
    scene.activeObject = scene.objects.length - 1;
    setObjectSelected(scene, { kind: 'GP', id: ob.id }, true);
    this.gp.markDirty();
    this.refreshWidget();
    this.ui.refresh();
  }

  /** Reference/image plane: textured unlit PLANE sized to the image aspect. */
  importImagePlane(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        this.ctx.pushUndo();
        const id = Date.now() % 1e9;
        const mesh = createMeshObject(id, 'PLANE', [...this.ctx.scene.cursor]);
        mesh.name = file.name;
        mesh.texture = dataUrl;
        mesh.unlit = true;
        mesh.drawTarget = false;   // reference by default; toggle in properties
        mesh.opacity = 1;
        const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        mesh.scale = [aspect, 1, 1];
        this.ctx.scene.meshes.push(mesh);
        this.meshes.sync(this.ctx.scene, this.nav.active);
        this.ui.refresh();
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  importModelFile(file: File): void {
    this.ctx.pushUndo();
    const id = Date.now() % 1e9;
    const mesh = createMeshObject(id, 'MODEL', [...this.ctx.scene.cursor], URL.createObjectURL(file));
    mesh.name = `${file.name} (session only)`;
    this.ctx.scene.meshes.push(mesh);
    this.meshes.sync(this.ctx.scene);
    this.ui.refresh();
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
    else if (!isEmptyMesh) box.setFromObject(root);
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
    if (!active) return;
    const wanted = new Set<string>();
    const refs = listSelected(scene);
    // Blender: the last object touched (click, box-select, shift/cmd-add)
    // is the "active"/target object — brighter outline, and the implicit
    // target for Ctrl+P parenting, Apply, etc. Falls back to the active GP
    // object so something is always highlighted even before any click.
    const activeRef = this.objectPick.lastPicked
      ?? (scene.objects[scene.activeObject] ? { kind: 'GP' as const, id: scene.objects[scene.activeObject].id } : null);
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
      const realEdges = meshKind ? meshEdgePositions(root, meshKind) : null;
      entry.helper.geometry.setPositions(realEdges ?? boxEdgePositions(entry.box));
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

  private resize(): void {
    const vp = document.getElementById('viewport')!;
    const w = vp.clientWidth, h = vp.clientHeight;
    if (w === 0 || h === 0) return;
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
    this.gp.setSize(w * devicePixelRatio, h * devicePixelRatio);
    this.fx.setSize(w * devicePixelRatio, h * devicePixelRatio);
    this.hud.width = w * devicePixelRatio;
    this.hud.height = h * devicePixelRatio;
    for (const entry of this.selHelpers.values()) entry.helper.material.resolution.set(w, h);
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
    mmCapture.tick(ctx.scene);
    mmStreamEngine.sync(ctx.scene);
    updateClipStreams(ctx.scene, dt);
    clipRecorder.tick(ctx.scene);
    streamPen.tick(ctx);
    mmStreamEngine.emit(ctx.scene);
    this.mmPoints.sync(ctx.scene, this.glRenderer.domElement.height);

    // score engine: cursors/triggers/attachments run on their own clocks
    mediamime.setPrefix(ctx.scene.mediamime.prefix);
    mediamime.update(ctx.scene);
    this.score.update(ctx.scene, dt, now);
    this.syncScoreGlyphs();
    if (this.sim.step(ctx.scene, dt)) ctx.requestRender(this.sim.lastLayerId ?? undefined);
    this.splats.sync(ctx.scene);
    this.meshes.sync(ctx.scene, this.nav.active);
    this.polys.sync(ctx.scene, this.nav.active);
    this.lights.helpersVisible = !this.presentation && !this.infoOverlayHidden;
    // selection tint only reads as selection in object mode, same gate the
    // Box3 outlines use (syncSelectionGlyphs)
    this.lights.selectionColor =
      ctx.settings.mode === 'OBJECT' && !this.presentation ? this.highlightColor() : null;
    this.lights.sync(ctx.scene);
    this.paints.sync(ctx.scene, this.glRenderer.domElement.height);
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
    ];
    // constraint stacks (FOLLOW_PATH/FOLLOW_STREAM/TRIGGER/...) — after the
    // score engine (trigger probes include this frame's cursors) and after
    // surfaces (SHRINKWRAP raycasts them). NOTE: this call was documented
    // but never actually wired until the mediamime branch — the engine
    // existed and was imported, but nothing invoked it per frame.
    try {
      constraintEngine.update(ctx.scene, dt, this.score, ctx.surfaces);
      this.updateZoneFlashes(now);
    } catch (err) {
      console.error('constraint engine:', err);
    }
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

    if (this.gp.needsRebuild) {
      try {
        this.gp.update(ctx.scene, {
        mode: this.presentation ? 'DRAW' : ctx.settings.mode,
        background: ctx.settings.background,
        playing: this.player.playing || this.presentation, // also hides onion in presentation
        selectMode: ctx.settings.selectMode,
        castShadows: ctx.settings.gpCastShadows,
        });
      } catch (err) {
        console.error('GP rebuild failed:', err);
      }
    }
    this.cursorMarker.position.set(...ctx.scene.cursor);
    this.updateCursorMarker();
    this.updatePlaneHelper();
    this.updateDepthHelper();

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

    this.syncSelectionGlyphs();

    if (this.quadView && this.paneRects) {
      this.renderQuadView(this.paneRects);
      // quad view step 1 scope cut: per-object screen-space FX compositing
      // isn't generalized to 4 panes yet — objects with effects enabled
      // just render without their effect while quad view is on.
      for (const job of fxJobs) job.group.visible = true;
    } else {
      this.glRenderer.render(this.scene3, this.nav.active);
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
    }

    this.drawHud();
    this.updateStatus();
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

  private drawHud(): void {
    const g = this.hud.getContext('2d')!;
    g.clearRect(0, 0, this.hud.width, this.hud.height);
    g.save();
    g.scale(devicePixelRatio, devicePixelRatio);
    this.drawTargetOverlay(g, this.hud.width / devicePixelRatio, this.hud.height / devicePixelRatio);
    this.tools.active?.drawHud?.(this.ctx, g);
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
    if (this.ctx.settings.mode === 'DRAW' && !this.nav.flying) {
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
    }
    if (!this.presentation) {
      const inset = this.ui.inspectorOpen ? 250 : 0;
      this.nav.drawGizmo(g, this.hud.width / devicePixelRatio - inset);
    }
    if (this.nav.flying) {
      g.fillStyle = '#fff';
      g.font = '13px sans-serif';
      g.fillText('FLY — WASD move · Q/E down/up · wheel speed · Shift boost · Enter/click accept · Esc cancel', 16, 24);
    }
    if (this.modal.active && this.ctx.settings.propEdit.enabled) {
      const { x, y } = this.tools.lastPointer;
      g.beginPath();
      g.arc(x, y, this.ctx.settings.propEdit.radius, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(160,160,170,0.5)';
      g.stroke();
    }
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

new App();
