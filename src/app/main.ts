import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createScene, activeObject, activeLayer, activeCam, createDefaultCamera, createFrame, cloneFrame, frameAt, keyframeIndexAt } from '../core/gpdata';
import { History } from '../core/history';
import type { GPScene } from '../core/types';
import { GPSceneRenderer, type EditorMode } from '../render/GPSceneRenderer';
import { EffectsPipeline } from '../fx/effects';
import { defaultSettings, loadPrefs, savePrefs, type AppCtx } from '../tools/context';
import { ToolManager, type ToolEvent } from '../tools/toolsys';
import { DrawTool, EraseTool, TintTool, CutterTool, EyedropperTool } from '../tools/draw';
import { FillTool } from '../tools/fill';
import { PrimitiveTool } from '../tools/primitives';
import { SelectTool, selectAll, selectLinked, selectMoreLess } from '../tools/select';
import { ModalTransform } from '../tools/transform';
import { SculptTool } from '../tools/sculpt';
import { VertexPaintTool, WeightPaintTool } from '../tools/paint';
import * as ops from '../tools/editops';
import { Player } from '../anim/player';
import { interpolateFrame } from '../anim/interpolate';
import { downloadScene, openSceneFile } from '../io/serialize';
import { nearestStrokePoint, screenToWorld, strokeSnapPreview } from '../tools/projection';
import { evalCamera, insertCameraKey, removeCameraKey } from '../anim/camera';
import { Keymap, comboFromEvent } from './keymap';
import { UI, type AppHandle } from './ui';
import type { Tool } from '../tools/toolsys';
import { Navigation } from './nav';
import type { CanvasPlane } from '../core/types';

const DEFAULT_TOOL: Record<EditorMode, string> = {
  DRAW: 'draw', EDIT: 'select', SCULPT: 'sculpt', VERTEX: 'vertexpaint', WEIGHT: 'weightpaint',
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
  private interpTool = new InterpolateTool();
  private nav!: Navigation;
  private navDrag: { mode: 'orbit' | 'pan' | 'dolly'; x: number; y: number } | null = null;
  private canvasGroup = new THREE.Group();
  private lastTime = performance.now();
  private grid!: THREE.GridHelper;
  private axes!: THREE.Group;
  private gizmoDrag: { x: number; y: number; startX: number; startY: number; dragged: boolean } | null = null;
  presentation = false;
  cameraView = false;
  lockCamToView = true;
  private camHelper!: THREE.Group; // root: one frustum child per scene camera
  readonly keymap = new Keymap();

  constructor() {
    const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
    this.hud = document.getElementById('hud') as HTMLCanvasElement;
    this.glRenderer = new THREE.WebGLRenderer({
      canvas: glCanvas, antialias: true, stencil: true, preserveDrawingBuffer: true,
    });
    this.glRenderer.setPixelRatio(window.devicePixelRatio);

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
      copyBuffer: [],
      requestRender: () => this.gp.markDirty(),
      pushUndo: () => history.push(self.ctx.scene),
      replaceScene: (s: GPScene) => {
        self.ctx.scene = s;
        this.gp.markDirty();
        this.syncCanvases();
        this.ui?.refresh();
      },
      refreshUI: () => this.ui?.refresh(),
    };

    // scene dressing
    this.scene3.background = new THREE.Color(...settings.background);
    this.grid = new THREE.GridHelper(20, 40, 0x3a3a44, 0x2a2a30);
    this.grid.position.y = -2;
    this.scene3.add(this.grid);
    this.camHelper = new THREE.Group();
    this.scene3.add(this.camHelper);
    this.scene3.add(this.gp.root);
    this.cursorMarker = this.makeCursorMarker();
    this.scene3.add(this.cursorMarker);
    // a ground plane for SURFACE placement demos
    this.scene3.add(this.canvasGroup);
    this.axes = this.makeAxes();
    this.scene3.add(this.axes);
    this.applyUpAxis(true);
    this.axes.visible = settings.showAxes;

    this.fx = new EffectsPipeline(2, 2);

    // tools
    for (const t of [
      new DrawTool(), new EraseTool(), new FillTool(), new TintTool(), new CutterTool(),
      new EyedropperTool(), new PrimitiveTool('line'), new PrimitiveTool('polyline'),
      new PrimitiveTool('arc'), new PrimitiveTool('curve'), new PrimitiveTool('box'),
      new PrimitiveTool('circle'), this.interpTool, new SelectTool(), new SculptTool(),
      new VertexPaintTool(), new WeightPaintTool(),
    ]) this.tools.register(t);
    this.tools.setActive(this.ctx, 'draw');

    this.ui = new UI(this);
    (window as unknown as Record<string, unknown>).__tg = this; // debug/scripting handle
    this.bindEvents(glCanvas);
    this.resize();
    requestAnimationFrame(() => this.loop());
  }

  // ---------------------------------------------------------- AppHandle

  setMode(mode: EditorMode): void {
    this.ctx.settings.mode = mode;
    this.setTool(DEFAULT_TOOL[mode]);
    this.gp.markDirty();
    this.ui.refresh();
  }

  setTool(id: string): void {
    this.tools.setActive(this.ctx, id);
    const tool = this.tools.get(id);
    this.ctx.canvas.style.cursor = tool?.cursor ?? 'default';
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

  /** Place the 3D cursor with the active snap mode (plane/grid/stroke/selection). */
  private placeCursor(clientX: number, clientY: number): void {
    const ctx = this.ctx;
    const rect = ctx.canvas.getBoundingClientRect();
    const snap = ctx.settings.cursorSnap;

    if (snap === 'STROKE') {
      const hit = nearestStrokePoint(ctx, clientX - rect.left, clientY - rect.top, 60);
      if (hit) {
        ctx.scene.cursor = [hit.x, hit.y, hit.z];
        this.gp.markDirty();
        return;
      }
      // no stroke nearby: fall through to plane placement
    }
    if (snap === 'SELECTION') {
      const med = new THREE.Vector3();
      let n = 0;
      const ob = activeObject(ctx.scene);
      for (const layer of ob.layers) {
        if (layer.hide) continue;
        const f = frameAt(layer, ctx.scene.frame);
        if (!f) continue;
        for (const s of f.strokes) for (const p of s.points) {
          if (p.select) { med.add(new THREE.Vector3(...p.co)); n++; }
        }
      }
      if (n > 0) {
        med.divideScalar(n);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(...ob.translation),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
          new THREE.Vector3(...ob.scale),
        );
        med.applyMatrix4(m);
        ctx.scene.cursor = [med.x, med.y, med.z];
        this.gp.markDirty();
        return;
      }
    }
    const world = screenToWorld(ctx, clientX, clientY);
    if (!world) return;
    if (snap === 'GRID') {
      const g = ctx.settings.gridStep;
      world.set(
        Math.round(world.x / g) * g,
        Math.round(world.y / g) * g,
        Math.round(world.z / g) * g,
      );
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
    this.ctx.surfaces = [];
    for (const c of this.ctx.scene.canvases) {
      if (!c.visible) continue;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(c.size[0], c.size[1]),
        new THREE.MeshBasicMaterial({
          color: 0x8899bb, transparent: true, opacity: 0.07,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      mesh.position.set(...c.translation);
      mesh.rotation.set(...c.rotation);
      mesh.renderOrder = -1;
      mesh.userData.canvasId = c.id;
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-c.size[0] / 2, -c.size[1] / 2, 0),
          new THREE.Vector3(c.size[0] / 2, -c.size[1] / 2, 0),
          new THREE.Vector3(c.size[0] / 2, c.size[1] / 2, 0),
          new THREE.Vector3(-c.size[0] / 2, c.size[1] / 2, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x55688f, transparent: true, opacity: 0.6 }),
      );
      border.raycast = () => {}; // border must never catch surface-placement rays
      mesh.add(border);
      this.canvasGroup.add(mesh);
      this.ctx.surfaces.push(mesh);
    }
  }

  snapView(view: 'FRONT' | 'BACK' | 'RIGHT' | 'LEFT' | 'TOP' | 'BOTTOM'): void { this.nav.snapView(view); }

  jumpKey(dir: 1 | -1): void {
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

  private toolEvent(e: PointerEvent): ToolEvent {
    const rect = this.ctx.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left, y: e.clientY - rect.top,
      pressure: e.pointerType === 'pen' ? e.pressure : (e.pressure || 0.5),
      shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
      clientX: e.clientX, clientY: e.clientY,
    };
  }

  private bindEvents(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      (this.hud as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer = this.toolEvent(e);
      if (this.nav.flying) {
        if (e.button === 0) this.nav.stopFly(); // click confirms fly position
        return;
      }
      const te0 = this.toolEvent(e);
      if (e.button === 0 && !this.presentation && this.nav.inGizmo(te0.x, te0.y)) {
        // click a ball snaps; dragging the disc orbits like a trackball
        this.gizmoDrag = { x: te0.x, y: te0.y, startX: te0.x, startY: te0.y, dragged: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button === 0 && e.altKey && this.ctx.settings.emulate3Button) {
        // Blender "Emulate 3 Button Mouse": Alt = orbit, +Shift pan, +Ctrl zoom
        this.navDrag = {
          mode: e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'dolly' : 'orbit',
          x: te0.x, y: te0.y,
        };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button === 2 && e.shiftKey) {
        this.placeCursor(e.clientX, e.clientY);
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      if (this.modal.active) { this.modal.confirm(this.ctx); this.ui.refresh(); return; }
      canvas.setPointerCapture(e.pointerId);
      this.tools.handleDown(this.ctx, this.toolEvent(e));
    });

    canvas.addEventListener('pointermove', (e) => {
      const te = this.toolEvent(e);
      (this.hud as HTMLCanvasElement & { _pointer?: { x: number; y: number } })._pointer = te;
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
      if (this.modal.active) { this.modal.update(this.ctx, te); return; }
      // coalesced events give smoother strokes
      const coalesced = e.getCoalescedEvents?.();
      const events = coalesced && coalesced.length ? coalesced : [e];
      for (const ce of events) this.tools.handleMove(this.ctx, this.toolEvent(ce as PointerEvent));
    });

    canvas.addEventListener('pointerup', (e) => {
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
      else this.nav.orbitBy(e.deltaX * 0.005, e.deltaY * 0.005);
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.resize());
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const ctx = this.ctx;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (this.ui.settingsOpen) return; // dialog handles its own keys

    // fly mode swallows its keys (the fly toggle itself is a keymap action)
    if (this.nav.handleFlyKey(e, true)) { e.preventDefault(); return; }
    if (this.keymap.actionFor(comboFromEvent(e)) === 'fly') {
      this.nav.flying ? this.nav.stopFly() : this.nav.startFly();
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
      case 'inspector': this.ui.toggleInspector(); break;
      case 'presentation': this.togglePresentation(); break;
      case 'toggleEdit': this.setMode(ctx.settings.mode === 'DRAW' ? 'EDIT' : 'DRAW'); break;
      case 'modeDraw': this.setMode('DRAW'); break;
      case 'modeEdit': this.setMode('EDIT'); break;
      case 'modeSculpt': this.setMode('SCULPT'); break;
      case 'modeVertex': this.setMode('VERTEX'); break;
      case 'modeWeight': this.setMode('WEIGHT'); break;
      case 'toolDraw': if (ctx.settings.mode === 'DRAW') this.setTool('draw'); break;
      case 'toolErase': if (ctx.settings.mode === 'DRAW') this.setTool('erase'); break;
      case 'toolFill': if (ctx.settings.mode === 'DRAW') this.setTool('fill'); break;
      case 'move': if (this.editLike()) this.modal.begin(ctx, 'move', this.tools.lastPointer); break;
      case 'rotate': if (this.editLike()) this.modal.begin(ctx, 'rotate', this.tools.lastPointer); break;
      case 'scale': if (this.editLike()) this.modal.begin(ctx, 'scale', this.tools.lastPointer); break;
      case 'selectAll': if (this.editLike()) { selectAll(ctx, 'all'); this.gp.markDirty(); } break;
      case 'selectNone': if (this.editLike()) { selectAll(ctx, 'none'); this.gp.markDirty(); } break;
      case 'selectInvert': if (this.editLike()) { selectAll(ctx, 'invert'); this.gp.markDirty(); } break;
      case 'selectLinked': if (this.editLike()) { selectLinked(ctx); this.gp.markDirty(); } break;
      case 'selectMore': if (this.editLike()) { selectMoreLess(ctx, true); this.gp.markDirty(); } break;
      case 'selectLess': if (this.editLike()) { selectMoreLess(ctx, false); this.gp.markDirty(); } break;
      case 'delete': if (this.editLike()) { ops.deleteSelected(ctx, false); this.ui.refresh(); } break;
      case 'duplicate':
        if (this.editLike()) {
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

  setBackground(rgb: [number, number, number]): void {
    this.ctx.settings.background = rgb;
    (this.scene3.background as THREE.Color).setRGB(rgb[0], rgb[1], rgb[2]);
    this.gp.markDirty();
  }

  private makeCursorMarker(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0xd05555, depthTest: false });
    const mkLine = (a: THREE.Vector3, b: THREE.Vector3) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 20000;
      return line;
    };
    const r = 0.08;
    g.add(
      mkLine(new THREE.Vector3(-r, 0, 0), new THREE.Vector3(r, 0, 0)),
      mkLine(new THREE.Vector3(0, -r, 0), new THREE.Vector3(0, r, 0)),
      mkLine(new THREE.Vector3(0, 0, -r), new THREE.Vector3(0, 0, r)),
    );
    return g;
  }

  private resize(): void {
    const vp = document.getElementById('viewport')!;
    const w = vp.clientWidth, h = vp.clientHeight;
    if (w === 0 || h === 0) return;
    this.glRenderer.setSize(w, h, false);
    this.nav.setAspect(w, h);
    this.gp.setSize(w * devicePixelRatio, h * devicePixelRatio);
    this.fx.setSize(w * devicePixelRatio, h * devicePixelRatio);
    this.hud.width = w * devicePixelRatio;
    this.hud.height = h * devicePixelRatio;
    this.gp.markDirty();
    this.ui?.drawTimeline();
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
      if (this.player.playing || !this.lockCamToView) {
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
    this.syncCameraHelpers();
    if (!this.nav.flying) this.controls.update();

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
        });
      } catch (err) {
        console.error('GP rebuild failed:', err);
      }
    }
    this.cursorMarker.position.set(...ctx.scene.cursor);

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

    this.drawHud();
    this.updateStatus();
  }

  private drawHud(): void {
    const g = this.hud.getContext('2d')!;
    g.clearRect(0, 0, this.hud.width, this.hud.height);
    g.save();
    g.scale(devicePixelRatio, devicePixelRatio);
    this.tools.active?.drawHud?.(this.ctx, g);
    // STROKE placement: show which stroke the depth will lock to
    if (this.ctx.settings.mode === 'DRAW' && this.ctx.settings.placement === 'STROKE' && !this.nav.flying) {
      const { x, y } = this.tools.lastPointer;
      const anchor = strokeSnapPreview(this.ctx, x, y);
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

  private updateStatus(): void {
    const s = this.ctx.settings;
    const status = document.getElementById('status')!;
    const hints: Record<string, string> = {
      DRAW: 'LMB draw · MMB orbit · RMB pan · Shift+RMB set cursor · Tab edit mode',
      EDIT: 'LMB select (drag box, Ctrl lasso) · G/R/S transform · X delete · Shift+D dup · A all',
      SCULPT: 'LMB sculpt · Ctrl inverts brush',
      VERTEX: 'LMB paint vertex color',
      WEIGHT: 'LMB paint weight · Ctrl erases',
    };
    status.textContent = `${s.mode} — ${s.activeTool} · frame ${this.ctx.scene.frame} · ${hints[s.mode]}`;
  }
}

new App();
