import type { AppCtx, EraserMode, GuideType, PaintBrush, PlacementMode, PlaneMode, SculptBrush, StrokeTarget } from '../tools/context';
import type { EditorMode } from '../render/GPSceneRenderer';
import type { GPLayer, GPMaterial, ModifierType, EffectType, Vec4, BlendMode, LineMode, FillStyle } from '../core/types';
import { activeCam, activeLayer, activeObject, createLayer, createMaterial, cloneFrame, createFrame, frameAt, genId } from '../core/gpdata';
import { ACTIONS, comboFromEvent, type Keymap } from './keymap';
import { MODIFIERS, applyModifierToData, createModifier } from '../modifiers/index';
import { BRUSH_PRESETS } from '../core/brushes';
import { bus } from '../events/bus';
import { defaultCursor, scoreId } from '../score/engine';
import { createRoute, routes, TARGET_SUGGESTIONS } from '../events/routes';
import { mediamime } from '../io/mediamime';
import { mmCapture } from '../mm/capture';
import { streamStore } from '../mm/streams';
import { deleteAsset, listAssets } from '../io/assets';
import { CONSTRAINT_DEFS, createConstraint } from '../score/constraints';
import type { ConstraintType, TGConstraint } from '../core/types';
import {
  getObjectTransform, listSelected as listSelectedObjects, objectName, selectionPivot,
  setObjectTransform, setParentKeepWorld, type ObjRef,
} from '../tools/objects';
import {
  applyObjectTransformPartial, clearObjectTransform, geometryToOrigin, mirrorObject,
  originToCursor, originToFirstPoint, originToGeometry, originToGeometryBase, separateConnectedIntoObjects,
  snapCursorToSelectionMedian, snapSelectionToCursor,
} from '../tools/objectops';

type CtxItem =
  | { label: string; icon?: IconName; action?: string; do?: () => void; items?: CtxItem[]; disabled?: boolean }
  | { sep: true }
  | { header: string };
import {
  DEFAULT_STRINGART, loadTargetImage, pinSourceStroke, runStringArt,
  type StringArtRun,
} from '../solvers/stringart';
import { DEFAULT_WIREART, runWireArt } from '../solvers/wireart';
import type { PathRef } from '../core/types';
import { midi } from '../events/midi';
import { wsLink } from '../events/ws';
import { EFFECT_DEFAULTS, createEffect } from '../fx/effects';
import { interpolateFrame, interpolateSequence } from '../anim/interpolate';
import * as ops from '../tools/editops';
import { selectAll, selectLinked, selectMoreLess } from '../tools/select';
import { icon, type IconName } from './icons';

export interface AppHandle {
  ctx: AppCtx;
  setMode(mode: EditorMode): void;
  setTool(id: string): void;
  addCanvasPlane(): void;
  removeCanvasPlane(id: number): void;
  syncCanvases(): void;
  snapView(view: 'FRONT' | 'BACK' | 'RIGHT' | 'LEFT' | 'TOP' | 'BOTTOM'): void;
  playToggle(): void;
  isPlaying(): boolean;
  undo(): void;
  redo(): void;
  saveScene(): void;
  loadScene(): void;
  exportPng(): void;
  addKeyframe(duplicate: boolean): void;
  removeKeyframe(): void;
  jumpKey(dir: 1 | -1): void;
  toggleCameraView(): void;
  cameraView: boolean;
  lockCamToView: boolean;
  addCameraKey(): void;
  removeCameraKeyAtFrame(): void;
  togglePresentation(): void;
  setBackground(rgb: [number, number, number]): void;
  applyThemeColors(): void;
  rebuildGrid(): void;
  keymap: Keymap;
  commands: import('./commands').CommandRegistry;
  sim: { enabled: boolean; damping: number; stiffness: number; reset(): void };
  splats: { errors: Map<number, string> };
  meshes: { errors: Map<number, string> };
  addMeshObject(kind: 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER'): void;
  importModelFile(file: File): void;
  importImagePlane(file: File): void;
  setWidgetMode(mode: 'translate' | 'rotate' | 'scale'): void;
  widgetMode: string;
  refreshWidget(): void;
  exportActiveGP(): void;
  addGPObject(): void;
  saveSelectedAsAsset(): void;
  addAssetToScene(asset: import('../io/assets').TGAsset): void;
  addMediaMimeTrigger(address: string, pos: [number, number, number]): void;
  addMediaMimeRig(address: string, target: import('../tools/objects').ObjRef): void;
  deleteMediaMimeRig(id: number): void;
  addMMStreams(kinds: import('../core/types').MMStream['kind'][], source: 'CAMERA' | 'BUS', busAddress?: string): void;
  deleteMMStream(id: number): void;
  mmCaptureToggle(): void;
  importGPFile(file: File): void;
  exportSplatPly(id: number): void;
  run(action: string): void;
  setLastPicked(ref: import('../tools/objects').ObjRef): void;
  getLastPicked(): import('../tools/objects').ObjRef | null;
  pickObject(cb: (ref: import('../tools/objects').ObjRef | null) => void): void;
  newScene(): void;
  viewAll(): void;
  addCamera(): void;
  cycleCamera(): void;
  setActiveCamera(index: number): void;
  addCamera(): void;
  removeCamera(): void;
  applyUpAxis(resetView?: boolean): void;
  setShowAxes(v: boolean): void;
  setTrackpadNav(v: boolean): void;
  savePrefs(): void;
}

const $ = (id: string) => document.getElementById(id)!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on')) (e as unknown as Record<string, unknown>)[k] = v;
    else if (k === 'title') e.title = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children) e.append(c);
  return e;
}

function btn(label: string | Node, onclick: () => void, opts: { active?: boolean; title?: string; cls?: string } = {}): HTMLButtonElement {
  const b = el('button', {
    onclick, title: opts.title ?? (typeof label === 'string' ? label : ''),
    class: `${opts.cls ?? ''} ${opts.active ? 'active' : ''}`,
  });
  b.append(label);
  return b;
}

function slider(
  label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void,
): HTMLElement {
  const input = el('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
  input.oninput = () => onInput(parseFloat(input.value));
  return el('label', { class: 'inline' }, label, input);
}

function numField(label: string, value: number, onChange: (v: number) => void, step = 0.1): HTMLElement {
  const input = el('input', { type: 'number', value: Math.round(value * 1000) / 1000, step }) as HTMLInputElement;
  input.onchange = () => onChange(parseFloat(input.value) || 0);
  return el('label', { class: 'inline' }, label, input);
}

function checkbox(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = value;
  input.onchange = () => onChange(input.checked);
  return el('label', { class: 'inline' }, input, label);
}

/** Icon-only checkbox (no visible text) with a hover tooltip. */
function iconCheckbox(iconEl: string | Node, title: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = value;
  input.onchange = () => onChange(input.checked);
  return el('label', { class: 'inline', title }, input, iconEl);
}

function colorField(label: string, rgba: number[], onChange: (rgb: [number, number, number]) => void): HTMLElement {
  const input = el('input', { type: 'color', value: rgbToHex(rgba) }) as HTMLInputElement;
  input.oninput = () => onChange(hexToRgb(input.value));
  return el('label', { class: 'inline' }, label, input);
}

function selectField<T extends string>(
  label: string, value: T, options: [T, string][], onChange: (v: T) => void,
): HTMLElement {
  const sel = el('select') as HTMLSelectElement;
  for (const [v, text] of options) sel.append(el('option', { value: v, text }));
  sel.value = value;
  sel.onchange = () => onChange(sel.value as T);
  return el('label', { class: 'inline' }, label, sel);
}

function rgbToHex(c: number[]): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** Icon + text combo for buttons whose label needs both (e.g. "replace texture…"). */
function iconLabel(iconName: IconName, text: string): HTMLElement {
  return el('span', { class: 'icon-label' }, icon(iconName, 14), text);
}

function panel(title: string, ...children: (Node | string)[]): HTMLElement {
  const body = el('div', { class: 'body' }, ...children);
  const h = el('h3', { text: title });
  h.onclick = () => { body.style.display = body.style.display === 'none' ? '' : 'none'; };
  return el('div', { class: 'panel' }, h, body);
}

// ---------------------------------------------------------------------------

const TOOLS_BY_MODE: Record<EditorMode, [string, IconName, string][]> = {
  OBJECT: [['object-select', 'cursorArrow', 'Select objects (Shift extends)']],
  DRAW: [
    ['draw', 'pencil', 'Draw (D)'], ['erase', 'eraser', 'Erase (E)'], ['fill', 'swatch', 'Fill (F)'],
    ['tint', 'brush', 'Tint'], ['cutter', 'scissors', 'Cutter'], ['eyedropper', 'droplet', 'Eyedropper'],
    ['line', 'lineTool', 'Line'], ['polyline', 'polylineTool', 'Polyline'], ['arc', 'arcTool', 'Arc'],
    ['curve', 'curveTool', 'Curve'], ['box', 'square', 'Box'], ['circle', 'circle', 'Circle'],
    ['interpolate', 'arrowsRightLeft', 'Interpolate (drag)'],
  ],
  EDIT: [
    ['select', 'squareTarget', 'Box select (Ctrl lasso, C circle)'],
    ['select-lasso', 'lasso', 'Lasso select'],
    ['select-circle', 'circle', 'Circle select ([ ] size)'],
  ],
  SCULPT: [['sculpt', 'hand', 'Sculpt brush']],
  VERTEX: [['vertexpaint', 'brush', 'Vertex paint']],
  WEIGHT: [['weightpaint', 'adjustments', 'Weight paint']],
};

export class UI {
  private app: AppHandle;
  private tlCanvas: HTMLCanvasElement;

  constructor(app: AppHandle) {
    this.app = app;
    this.tlCanvas = el('canvas');
    this.buildTimelineShell();
    this.initHoverTips();
    this.refresh();
    // live values (camera position etc.) — skip while the user types in it
    setInterval(() => {
      if (this.inspectorOpen && !this.inspectorEl?.contains(document.activeElement)) {
        this.rebuildInspector();
      }
      this.refreshMonitor();
    }, 300);
    // menus close on outside click / Esc
    document.addEventListener('pointerdown', (e) => {
      if (this.openMenu && !(e.target as HTMLElement).closest?.('.menu')) {
        this.openMenu = null;
        this.buildMenubar();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.openMenu) {
        this.openMenu = null;
        this.buildMenubar();
      }
    }, true);
  }

  /** Icon-only buttons rely entirely on `title` for meaning, but a CSS-only
   *  ::after tooltip anchored to the button gets clipped by any ancestor
   *  with overflow:hidden/auto (the scrollable sidebar tab strip, panel
   *  bodies, etc). Instead: on hover, spawn a position:fixed tooltip
   *  appended directly to <body>, positioned from the button's own
   *  getBoundingClientRect() — immune to ancestor clipping since it isn't
   *  a descendant of the clipped container at all. */
  private initHoverTips(): void {
    const SEL = '.icon-btn[title], .tl-transport[title], .props-tab[title]';
    let tip: HTMLElement | null = null;
    const hide = () => { tip?.remove(); tip = null; };
    document.body.addEventListener('mouseover', (e) => {
      const target = (e.target as HTMLElement)?.closest?.(SEL) as HTMLElement | null;
      if (!target) return;
      const text = target.getAttribute('title');
      if (!text) return;
      hide();
      tip = el('div', { class: 'hover-tip', text });
      document.body.append(tip);
      const r = target.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      const left = Math.max(4, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 4));
      const above = r.top - tr.height - 6;
      tip.style.left = `${left}px`;
      tip.style.top = `${above >= 4 ? above : r.bottom + 6}px`;
    });
    document.body.addEventListener('mouseout', (e) => {
      if ((e.target as HTMLElement)?.closest?.(SEL)) hide();
    });
    window.addEventListener('scroll', hide, true);
  }

  refresh(): void {
    this.buildMenubar();
    this.buildTopbar();
    this.buildToolbar();
    this.buildSidebar();
    this.refreshTimelineControls();
    this.drawTimeline();
  }

  // ------------------------------------------------------------ menubar

  private openMenu: string | null = null;

  private filePick(accept: string, onFile: (f: File) => void): void {
    const input = el('input', { type: 'file', accept }) as HTMLInputElement;
    input.style.display = 'none';
    document.body.append(input);
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) onFile(f);
      input.remove();
    };
    input.click();
  }

  private buildMenubar(): void {
    const { ctx } = this.app;
    const bar = $('menubar');
    bar.replaceChildren();
    bar.append(el('span', { class: 'app-title', text: 'threegrease' }));

    type Item = { label: string; action?: string; do?: () => void; check?: boolean }
      | { sep: true } | { header: string };

    const menu = (name: string, items: Item[]) => {
      const root = el('div', { class: `menu ${this.openMenu === name ? 'open' : ''}` });
      const button = btn(name, () => {
        this.openMenu = this.openMenu === name ? null : name;
        this.buildMenubar();
      });
      button.onmouseenter = () => {
        if (this.openMenu && this.openMenu !== name) {
          this.openMenu = name;
          this.buildMenubar();
        }
      };
      root.append(button);
      if (this.openMenu === name) {
        const pop = el('div', { class: 'menu-pop' });
        for (const item of items) {
          if ('sep' in item) { pop.append(el('div', { class: 'menu-sep' })); continue; }
          if ('header' in item) { pop.append(el('div', { class: 'menu-header', text: item.header })); continue; }
          const key = item.action ? this.app.keymap.comboFor(item.action) : '';
          const row = el('div', { class: 'menu-item' },
            el('span', { text: `${item.check ? '✓ ' : ''}${item.label}` }),
            el('span', { class: 'menu-key', text: key }),
          );
          row.onclick = () => {
            this.openMenu = null;
            this.buildMenubar();
            if (item.do) item.do();
            else if (item.action) this.app.run(item.action);
          };
          pop.append(row);
        }
        root.append(pop);
      }
      bar.append(root);
    };

    menu('File', [
      { label: 'New', action: 'newScene' },
      { label: 'Open…', action: 'open' },
      { label: 'Save', action: 'save' },
      { sep: true },
      { header: 'Import' },
      { label: 'GP object / scene (.json)…', do: () => this.filePick('.json', (f) => this.app.importGPFile(f)) },
      { label: 'Model (.glb/.gltf/.obj)…', do: () => this.filePick('.glb,.gltf,.obj', (f) => this.app.importModelFile(f)) },
      {
        label: 'Splat (.ply/.spz/.splat)…',
        do: () => this.filePick('.ply,.spz,.splat,.ksplat,.sog', (f) => {
          ctx.pushUndo();
          ctx.scene.splats.push({
            id: scoreId(ctx.scene), name: `${f.name} (session only)`, src: URL.createObjectURL(f),
            translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true, select: false,
          });
          this.refresh();
        }),
      },
      { sep: true },
      { header: 'Export' },
      { label: 'GP object (.threegrease.json)', do: () => this.app.exportActiveGP() },
      { label: 'GLB', do: async () => { const m = await import('../io/export3d'); m.exportGLB(ctx); } },
      { label: 'OBJ', do: async () => { const m = await import('../io/export3d'); m.exportOBJ(ctx); } },
      { label: 'STL', do: async () => { const m = await import('../io/export3d'); m.exportSTL(ctx); } },
      { label: 'PLY (geometry)', do: async () => { const m = await import('../io/export3d'); m.exportPLY(ctx); } },
      { label: 'PNG snapshot', do: () => this.app.exportPng() },
    ]);

    menu('Edit', [
      { label: 'Undo', action: 'undo' },
      { label: 'Redo', action: 'redo' },
      { sep: true },
      { label: 'Apply transform (object mode)', action: 'applyTransform' },
      { sep: true },
      { label: 'Preferences…', action: 'settings' },
    ]);

    const assetItems = listAssets().flatMap((a) => [{
      label: a.name,
      do: () => this.app.addAssetToScene(a),
    }]);
    menu('Add', [
      {
        label: 'Reference / image plane…',
        do: () => this.filePick('image/*', (f) => this.app.importImagePlane(f)),
      },
      { sep: true },
      { header: 'Assets' },
      ...assetItems,
      { label: 'Save selected as asset', do: () => this.app.saveSelectedAsAsset() },
      ...(assetItems.length ? [{ label: 'Manage assets…', do: () => this.manageAssets() }] : []),
      { sep: true },
      { label: 'Plane', do: () => this.app.addMeshObject('PLANE') },
      { label: 'Box', do: () => this.app.addMeshObject('BOX') },
      { label: 'Sphere', do: () => this.app.addMeshObject('SPHERE') },
      { label: 'Cylinder', do: () => this.app.addMeshObject('CYLINDER') },
      { sep: true },
      { label: 'Model…', do: () => this.filePick('.glb,.gltf,.obj', (f) => this.app.importModelFile(f)) },
      { sep: true },
      { label: 'Grease Pencil (blank)', do: () => this.app.addGPObject() },
      { label: 'GP object…', do: () => this.filePick('.json', (f) => this.app.importGPFile(f)) },
      {
        label: 'Splat from URL…',
        do: () => {
          const url = prompt('Splat URL (.ply/.spz/.splat)');
          if (!url) return;
          ctx.pushUndo();
          ctx.scene.splats.push({
            id: scoreId(ctx.scene), name: url.split('/').pop() ?? 'splat', src: url.trim(),
            translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true, select: false,
          });
          this.refresh();
        },
      },
      { label: 'Camera (at current view)', do: () => this.app.addCamera() },
    ]);

    menu('View', [
      { label: 'Frame all', action: 'viewAll' },
      { label: 'Center cursor & frame all', action: 'centerCursorViewAll' },
      { sep: true },
      { label: 'Camera view', action: 'cameraView' },
      { label: 'Next camera', action: 'cycleCamera' },
      { label: 'Flythrough', action: 'fly' },
      { sep: true },
      { label: 'Presentation mode', action: 'presentation' },
      { label: 'Inspector panel', action: 'inspector' },
      { label: 'World axes', check: ctx.settings.showAxes, do: () => { this.app.setShowAxes(!ctx.settings.showAxes); this.refresh(); } },
      { sep: true },
      { header: 'Viewpoint' },
      { label: 'Front', do: () => this.app.snapView('FRONT') },
      { label: 'Right', do: () => this.app.snapView('RIGHT') },
      { label: 'Top', do: () => this.app.snapView('TOP') },
    ]);

    menu('MediaMime', [
      { label: 'Open MediaMime panel', do: () => this.openTab('mediamime') },
      { sep: true },
      { header: `Prefix: ${ctx.scene.mediamime.prefix}` },
      { label: `${ctx.scene.mediamime.rigs.length} rig(s) · ${mediamime.list().length} live address(es)`, do: () => this.openTab('mediamime') },
      { sep: true },
      { label: 'mediamime on GitHub…', do: () => window.open('https://github.com/languel/mediamime', '_blank') },
    ]);

    menu('Help', [
      { label: 'Command palette…', action: 'palette' },
      { label: 'Keyboard shortcuts…', action: 'settings' },
      { label: 'About (GitHub)', do: () => window.open('https://github.com/languel/threegrease', '_blank') },
    ]);
  }

  // ------------------------------------------------------------- topbar

  private buildTopbar(): void {
    const { ctx } = this.app;
    const s = ctx.settings;
    const bar = $('topbar');
    bar.replaceChildren();

    const modes: [EditorMode, IconName, string][] = [
      ['OBJECT', 'cursorArrow', 'Object mode'], ['DRAW', 'pencil', 'Draw mode'], ['EDIT', 'pencilSquare', 'Edit mode'],
      ['SCULPT', 'hand', 'Sculpt mode'], ['VERTEX', 'brush', 'Vertex paint'], ['WEIGHT', 'adjustments', 'Weight paint'],
    ];
    for (const [m, iconName, label] of modes) {
      bar.append(btn(icon(iconName), () => this.app.setMode(m), { active: s.mode === m, title: label }));
    }
    bar.append(el('div', { class: 'sep' }));

    if (s.mode === 'OBJECT') {
      bar.append(
        btn(icon('compass'), () => { s.showGizmo = !s.showGizmo; this.app.savePrefs(); this.app.refreshWidget(); this.refresh(); },
          { active: s.showGizmo, title: 'Show transform gizmo (off = Blender-style G/R/S modal only)' }),
      );
      if (s.showGizmo) {
        bar.append(
          btn(icon('scale'), () => this.app.setWidgetMode('translate'), { active: this.app.widgetMode === 'translate', title: 'Widget: move (G)' }),
          btn(icon('rotate'), () => this.app.setWidgetMode('rotate'), { active: this.app.widgetMode === 'rotate', title: 'Widget: rotate (R)' }),
          btn(icon('arrowsRightLeft'), () => this.app.setWidgetMode('scale'), { active: this.app.widgetMode === 'scale', title: 'Widget: scale (S)' }),
        );
      }
    } else if (s.mode === 'DRAW') {
      bar.append(
        selectField('Brush', s.brush.preset,
          BRUSH_PRESETS.map((p) => [p.name, p.name]) as [string, string][],
          (name) => {
            const p = BRUSH_PRESETS.find((x) => x.name === name);
            if (!p) return;
            s.brush.preset = p.name;
            s.brush.size = p.size;
            s.brush.strength = p.strength;
            s.brush.hardness = p.hardness;
            s.brush.style = { ...p.style };
            this.refresh();
          }),
        slider('Size', s.brush.size, 1, 80, 1, (v) => { s.brush.size = v; }),
        slider('Strength', s.brush.strength, 0.05, 1, 0.05, (v) => { s.brush.strength = v; }),
        selectField('Placement', s.placement, [['ORIGIN', 'Origin'], ['CURSOR', '3D Cursor'], ['SURFACE', 'Surface'], ['STROKE', 'Stroke']] as [PlacementMode, string][], (v) => { s.placement = v; this.refresh(); }),
        ...(s.placement === 'SURFACE' ? [
          numField('Offset', s.surfaceOffset, (v) => { s.surfaceOffset = v; }, 0.01),
        ] : []),
        selectField('Plane', s.plane, (s.upAxis === 'Z'
          ? [['VIEW', 'View'], ['FRONT', 'Front (X·Z)'], ['SIDE', 'Side (Y·Z)'], ['TOP', 'Top (X·Y)'], ['CURSOR', 'Cursor']]
          : [['VIEW', 'View'], ['FRONT', 'Front (X·Y)'], ['SIDE', 'Side (Z·Y)'], ['TOP', 'Top (X·Z)'], ['CURSOR', 'Cursor']]) as [PlaneMode, string][],
        (v) => { s.plane = v; }),
        ...(s.placement === 'STROKE' ? [
          selectField('Target', s.strokeTarget, [['ALL', 'All Points'], ['ENDS', 'End Points'], ['FIRST', 'First Point']] as [StrokeTarget, string][], (v) => { s.strokeTarget = v; }),
        ] : []),
        selectField('Guide', s.guide.type, [['NONE', 'No Guide'], ['CIRCULAR', 'Circular'], ['RADIAL', 'Radial'], ['PARALLEL', 'Parallel'], ['GRID', 'Grid'], ['ISO', 'Isometric']] as [GuideType, string][], (v) => { s.guide.type = v; }),
      );
      if (s.activeTool === 'erase') {
        bar.append(
          selectField('Eraser', s.eraser.mode, [['POINT', 'Point'], ['STROKE', 'Stroke'], ['SOFT', 'Soft']] as [EraserMode, string][], (v) => { s.eraser.mode = v; }),
          slider('Size', s.eraser.radius, 4, 120, 1, (v) => { s.eraser.radius = v; }),
        );
      }
    } else if (s.mode === 'EDIT') {
      bar.append(
        selectField('Select', s.selectMode, [['POINT', 'Point'], ['STROKE', 'Stroke']], (v) => { s.selectMode = v; ctx.requestRender(); }),
        checkbox('Proportional', s.propEdit.enabled, (v) => { s.propEdit.enabled = v; }),
        checkbox('Multiframe', s.multiframe, (v) => { s.multiframe = v; }),
      );
    } else if (s.mode === 'SCULPT') {
      const brushes: [SculptBrush, string][] = [
        ['SMOOTH', 'Smooth'], ['THICKNESS', 'Thickness'], ['STRENGTH', 'Strength'], ['RANDOMIZE', 'Randomize'],
        ['GRAB', 'Grab'], ['PUSH', 'Push'], ['TWIST', 'Twist'], ['PINCH', 'Pinch'], ['CLONE', 'Clone'],
      ];
      bar.append(
        selectField('Brush', s.sculpt.brush, brushes, (v) => { s.sculpt.brush = v; }),
        slider('Radius', s.sculpt.radius, 10, 200, 1, (v) => { s.sculpt.radius = v; }),
        slider('Strength', s.sculpt.strength, 0.05, 1, 0.05, (v) => { s.sculpt.strength = v; }),
      );
    } else if (s.mode === 'VERTEX') {
      bar.append(
        selectField('Brush', s.paint.brush, [['DRAW', 'Draw'], ['BLUR', 'Blur'], ['AVERAGE', 'Average'], ['SMEAR', 'Smear']] as [PaintBrush, string][], (v) => { s.paint.brush = v; }),
        colorField('Color', [...s.brush.vertexColor, 1], (rgb) => { s.brush.vertexColor = rgb; }),
        slider('Radius', s.paint.radius, 5, 150, 1, (v) => { s.paint.radius = v; }),
        slider('Strength', s.paint.strength, 0.05, 1, 0.05, (v) => { s.paint.strength = v; }),
      );
    } else if (s.mode === 'WEIGHT') {
      bar.append(
        slider('Weight', s.weight.target, 0, 1, 0.05, (v) => { s.weight.target = v; }),
        slider('Radius', s.weight.radius, 5, 150, 1, (v) => { s.weight.radius = v; }),
        slider('Strength', s.weight.strength, 0.05, 1, 0.05, (v) => { s.weight.strength = v; }),
      );
    }

    bar.append(el('div', { class: 'sep' }));
    // Global Snap cluster (Blender parity): ONE magnet setting drives
    // G/R/S point drags (EDIT), the translate widget (OBJECT), and the 3D
    // cursor (Shift+RMB drag). Magnet off = cursor moves freely on the
    // drawing plane.
    bar.append(
      iconCheckbox(icon('magnet'), 'Magnet snapping', s.snap.enabled, (v) => { s.snap.enabled = v; this.app.savePrefs(); }),
      selectField('', s.snap.mode === 'CANVAS' ? 'SURFACE' : s.snap.mode, [
        ['INCREMENT', 'Grid'], ['POINT', 'Vertex'], ['EDGE', 'Edge (along path)'],
        ['OBJECT', 'Object origin'], ['SURFACE', 'Surface (mesh/3DGS)'],
      ], (v) => { s.snap.mode = v as typeof s.snap.mode; this.app.savePrefs(); }),
      ...(s.snap.mode === 'POINT' || s.snap.mode === 'EDGE' ? [
        selectField('', s.snap.strokeScope ?? 'ANY', [
          ['ANY', 'Any GP'], ['SELECTED', 'Selected only'],
        ], (v) => { s.snap.strokeScope = v as 'ANY' | 'SELECTED'; this.app.savePrefs(); },
        ),
      ] : []),
    );
  }

  // ------------------------------------------------------------ toolbar

  private buildToolbar(): void {
    const { ctx } = this.app;
    const bar = $('toolbar');
    bar.replaceChildren();
    for (const [id, iconName, title] of TOOLS_BY_MODE[ctx.settings.mode]) {
      bar.append(btn(icon(iconName, 18), () => this.app.setTool(id), {
        active: ctx.settings.activeTool === id, title, cls: 'tool',
      }));
    }
  }

  // ------------------------------------------------------- context menu

  private ctxMenuEls: HTMLElement[] = [];
  private ctxCloseHandler: ((e: MouseEvent) => void) | null = null;

  closeContextMenu(): void {
    for (const el2 of this.ctxMenuEls) el2.remove();
    this.ctxMenuEls = [];
    if (this.ctxCloseHandler) window.removeEventListener('mousedown', this.ctxCloseHandler, true);
    this.ctxCloseHandler = null;
  }

  private pieEls: HTMLElement[] = [];
  private pieCloseHandler: ((e: KeyboardEvent | MouseEvent) => void) | null = null;

  closeModePie(): void {
    for (const el2 of this.pieEls) el2.remove();
    this.pieEls = [];
    if (this.pieCloseHandler) {
      window.removeEventListener('keydown', this.pieCloseHandler, true);
      window.removeEventListener('mousedown', this.pieCloseHandler, true);
    }
    this.pieCloseHandler = null;
  }

  /**
   * Blender Ctrl+Tab mode pie: click a wedge OR press its numpad-style
   * digit (works as a blind chord too — Ctrl+Tab then 8 lands on Draw
   * even before the menu paints). Esc/outside-click cancels.
   */
  openModePie(center: { x: number; y: number }): void {
    this.closeModePie();
    const { ctx } = this.app;
    type Slot = { mode: EditorMode; label: string; icon: IconName; key: string; angleDeg: number };
    const SLOTS: Slot[] = [
      { mode: 'DRAW', label: 'Draw', icon: 'pencil', key: '8', angleDeg: -90 },
      { mode: 'SCULPT', label: 'Sculpt', icon: 'hand', key: '2', angleDeg: 90 },
      { mode: 'OBJECT', label: 'Object', icon: 'cursorArrow', key: '4', angleDeg: 180 },
      { mode: 'EDIT', label: 'Edit', icon: 'pencilSquare', key: '6', angleDeg: 0 },
      // pushed further from Draw (N, -90) than a plain ±45 hexagon would
      // put them, so Draw has breathing room at the top
      { mode: 'WEIGHT', label: 'Weight Paint', icon: 'adjustments', key: '7', angleDeg: -150 },
      { mode: 'VERTEX', label: 'Vertex Paint', icon: 'brush', key: '9', angleDeg: -30 },
    ];
    const R = 105;
    const rect = ctx.canvas.getBoundingClientRect();
    const cx = Math.min(Math.max(center.x, R + 20), rect.width - R - 20) + rect.left;
    const cy = Math.min(Math.max(center.y, R + 20), rect.height - R - 20) + rect.top;

    const root = el('div', { class: 'pie-root' });
    root.style.left = `${cx}px`;
    root.style.top = `${cy}px`;
    root.append(el('div', { class: 'pie-ring' }), el('div', { class: 'pie-center', text: 'Mode' }));

    const choose = (mode: EditorMode) => { this.closeModePie(); this.app.setMode(mode); };
    for (const s of SLOTS) {
      const rad = (s.angleDeg * Math.PI) / 180;
      const item = el('div', { class: `pie-item${ctx.settings.mode === s.mode ? ' pie-item-active' : ''}` },
        el('span', { class: 'pie-icon' }, icon(s.icon, 18)),
        el('span', { text: s.label }),
        el('span', { class: 'pie-key', text: s.key }),
      );
      item.style.left = `${R * Math.cos(rad)}px`;
      item.style.top = `${R * Math.sin(rad)}px`;
      item.onclick = () => choose(s.mode);
      root.append(item);
    }
    document.body.append(root);
    this.pieEls = [root];

    this.pieCloseHandler = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') { this.closeModePie(); return; }
        const slot = SLOTS.find((s) => s.key === e.key);
        if (slot) { e.preventDefault(); choose(slot.mode); }
        return;
      }
      if (!root.contains(e.target as Node)) this.closeModePie();
    };
    window.addEventListener('keydown', this.pieCloseHandler as (e: KeyboardEvent) => void, true);
    window.addEventListener('mousedown', this.pieCloseHandler as (e: MouseEvent) => void, true);
  }

  /** Generic right-click popup: flat items + one level of ▶ submenus. */
  openContextMenu(x: number, y: number, items: CtxItem[]): void {
    this.closeContextMenu();
    const build = (its: CtxItem[], px: number, py: number, depth: number): HTMLElement => {
      const pop = el('div', { class: 'menu-pop' });
      pop.style.position = 'fixed';
      pop.style.left = `${px}px`;
      pop.style.top = `${py}px`;
      pop.style.zIndex = String(200 + depth);
      for (const item of its) {
        if ('sep' in item) { pop.append(el('div', { class: 'menu-sep' })); continue; }
        if ('header' in item) { pop.append(el('div', { class: 'menu-header', text: item.header })); continue; }
        const row = el('div', { class: `menu-item${item.disabled ? ' menu-item-disabled' : ''}` },
          el('span', { class: 'menu-label' },
            ...(item.icon ? [el('span', { class: 'menu-icon' }, icon(item.icon, 14))] : []),
            item.label,
          ),
          el('span', { class: 'menu-key', text: item.items ? '▶' : (item.action ? this.app.keymap.comboFor(item.action) : '') }),
        );
        if (item.disabled) { pop.append(row); continue; }
        if (item.items) {
          row.onmouseenter = () => {
            this.ctxMenuEls.splice(depth + 1).forEach((e2) => e2.remove());
            const rect = row.getBoundingClientRect();
            const child = build(item.items!, rect.right, rect.top, depth + 1);
            document.body.append(child);
            this.ctxMenuEls[depth + 1] = child;
          };
        } else {
          row.onclick = () => {
            this.closeContextMenu();
            if (item.action) this.app.run(item.action);
            else item.do?.();
          };
        }
        pop.append(row);
      }
      return pop;
    };
    const root = build(items, x, y, 0);
    document.body.append(root);
    this.ctxMenuEls = [root];
    this.ctxCloseHandler = (e: MouseEvent) => {
      if (this.ctxMenuEls.some((el2) => el2.contains(e.target as Node))) return;
      this.closeContextMenu();
    };
    window.addEventListener('mousedown', this.ctxCloseHandler, true);
  }

  /** Blender Stroke/Point context menu (RMB in the viewport, Edit mode). */
  openStrokeOpsContextMenu(clientX: number, clientY: number): void {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const run = (fn: () => void) => () => { fn(); this.refresh(); };

    const items: CtxItem[] = [
      { label: 'Move', action: 'move' },
      { label: 'Rotate', action: 'rotate' },
      { label: 'Scale', action: 'scale' },
      { sep: true },
      { label: 'Duplicate', action: 'duplicate' },
      { label: 'Delete', action: 'delete' },
      { label: 'Dissolve', do: run(() => ops.deleteSelected(ctx, true)) },
      { sep: true },
      { label: 'Split', action: 'split' },
      { label: 'Separate', action: 'separate' },
      { label: 'Join', action: 'join' },
      { label: 'Merge by Distance', do: run(() => ops.mergeByDistance(ctx)) },
      { sep: true },
      { label: 'Subdivide', do: run(() => ops.subdivideSelected(ctx)) },
      { label: 'Simplify', do: run(() => ops.simplifySelected(ctx)) },
      { label: 'Smooth', do: run(() => ops.smoothSelected(ctx)) },
      { sep: true },
      { label: 'Toggle Cyclic', do: run(() => ops.toggleCyclic(ctx)) },
      { label: 'Switch Direction', do: run(() => ops.switchDirection(ctx)) },
      { label: 'Set Start Point', do: run(() => ops.setStartPoint(ctx)) },
      {
        label: 'Normalize', items: [
          { label: 'Thickness', do: run(() => ops.normalizeThickness(ctx)) },
          { label: 'Opacity', do: run(() => ops.normalizeOpacity(ctx)) },
        ],
      },
      {
        label: 'Arrange', items: [
          { label: 'Bring to Front', do: run(() => ops.arrangeSelected(ctx, 'TOP')) },
          { label: 'Move Up', do: run(() => ops.arrangeSelected(ctx, 'UP')) },
          { label: 'Move Down', do: run(() => ops.arrangeSelected(ctx, 'DOWN')) },
          { label: 'Send to Back', do: run(() => ops.arrangeSelected(ctx, 'BOTTOM')) },
        ],
      },
      {
        label: 'Snap', items: [
          { label: 'Selection to Cursor', do: run(() => ops.snapToCursor(ctx)) },
          { label: 'Selection to Grid', do: run(() => ops.snapToGrid(ctx, ctx.settings.gridStep)) },
        ],
      },
      {
        label: 'Move to Layer', items: ob.layers.map((l) => ({
          label: l.name, do: run(() => ops.moveToLayer(ctx, l.id)),
        })),
      },
    ];
    this.openContextMenu(clientX, clientY, items);
  }

  /** Blender Object context menu (RMB in the viewport, object mode). */
  openObjectContextMenu(clientX: number, clientY: number): void {
    const { ctx } = this.app;
    const refs = listSelectedObjects(ctx.scene);
    if (!refs.length) return;
    const gpOnly = refs.every((r) => r.kind === 'GP');
    // Origin to Geometry/Cursor/Base support GP + primitive MESH kinds
    // (image planes are PLANE mesh objects — see HANDOFF "canvas retirement");
    // MODEL (loaded) geometry isn't supported (no known local bounds).
    const gpOrMesh = refs.every((r) => r.kind === 'GP' || r.kind === 'MESH');
    const one = refs.length === 1 ? refs[0] : null;

    const items: CtxItem[] = [
      { label: 'Duplicate', action: 'duplicate' },
      { label: 'Delete', action: 'delete' },
      { sep: true },
      {
        label: 'Set Origin', items: [
          { label: 'Geometry to Origin', do: () => this.runObjectOp((ref) => geometryToOrigin(ctx.scene, ref)), disabled: !gpOnly },
          { label: 'Origin to Geometry', do: () => this.runObjectOp((ref) => originToGeometry(ctx.scene, ref)), disabled: !gpOrMesh },
          { label: 'Origin to Geometry (Base)', do: () => this.runObjectOp((ref) => originToGeometryBase(ctx.scene, ref, ctx.settings.upAxis)), disabled: !gpOrMesh },
          { label: 'Origin to 3D Cursor', do: () => this.runObjectOp((ref) => originToCursor(ctx.scene, ref)), disabled: !gpOrMesh },
          { label: 'Origin to First Point', do: () => this.runObjectOp((ref) => originToFirstPoint(ctx.scene, ref)), disabled: !gpOnly },
        ],
      },
      {
        label: 'Auto-Separate Connected Strokes',
        do: () => {
          if (!one || one.kind !== 'GP') return;
          ctx.pushUndo();
          const n = separateConnectedIntoObjects(ctx.scene, one);
          this.afterObjectOp();
          if (n === 0) alert('Already one connected piece (or nothing to separate) — origin was still set to the first point.');
        },
        disabled: !one || one.kind !== 'GP',
      },
      {
        label: 'Mirror', items: [
          { label: 'X Global', do: () => this.runObjectOp((ref) => (mirrorObject(ctx.scene, ref, 0), true)) },
          { label: 'Y Global', do: () => this.runObjectOp((ref) => (mirrorObject(ctx.scene, ref, 1), true)) },
          { label: 'Z Global', do: () => this.runObjectOp((ref) => (mirrorObject(ctx.scene, ref, 2), true)) },
        ],
      },
      {
        label: 'Clear', items: [
          { label: 'Location', do: () => this.runObjectOp((ref) => (clearObjectTransform(ctx.scene, ref, 'LOC'), true)) },
          { label: 'Rotation', do: () => this.runObjectOp((ref) => (clearObjectTransform(ctx.scene, ref, 'ROT'), true)) },
          { label: 'Scale', do: () => this.runObjectOp((ref) => (clearObjectTransform(ctx.scene, ref, 'SCALE'), true)) },
          { label: 'All Transforms', do: () => this.runObjectOp((ref) => (clearObjectTransform(ctx.scene, ref, 'ALL'), true)) },
        ],
      },
      {
        label: 'Apply', items: [
          { label: 'Location', do: () => this.runObjectOp((ref) => applyObjectTransformPartial(ctx.scene, ref, 'LOC')), disabled: !gpOnly },
          { label: 'Rotation', do: () => this.runObjectOp((ref) => applyObjectTransformPartial(ctx.scene, ref, 'ROT')), disabled: !gpOnly },
          { label: 'Scale', do: () => this.runObjectOp((ref) => applyObjectTransformPartial(ctx.scene, ref, 'SCALE')), disabled: !gpOnly },
          { label: 'All Transforms', action: 'applyTransform' },
        ],
      },
      {
        label: 'Snap', items: [
          { label: 'Selection to Cursor', do: () => { ctx.pushUndo(); snapSelectionToCursor(ctx.scene); this.afterObjectOp(); } },
          { label: 'Cursor to Selected', do: () => { ctx.pushUndo(); snapCursorToSelectionMedian(ctx.scene, selectionPivot(ctx.scene)); this.afterObjectOp(); } },
        ],
      },
      { sep: true },
      { label: 'Parent to last-picked', action: 'parentSet' },
      { label: 'Clear parent', action: 'parentClear' },
      ...(one ? [{ sep: true as const }, { label: `Rename ${objectName(ctx.scene, one)}… (F2)`, do: () => this.renameObjectInline(one) }] : []),
    ];
    this.openContextMenu(clientX, clientY, items);
  }

  private runObjectOp(fn: (ref: import('../tools/objects').ObjRef) => boolean): void {
    const { ctx } = this.app;
    ctx.pushUndo();
    for (const ref of listSelectedObjects(ctx.scene)) fn(ref);
    this.afterObjectOp();
  }

  private afterObjectOp(): void {
    const { ctx } = this.app;
    ctx.syncCanvases();
    this.app.refreshWidget();
    ctx.requestRender();
    this.refresh();
  }

  /**
   * Rename via the outliner's inline text field (NOT window.prompt() —
   * that's silently blocked/no-op in sandboxed embeds, which is why the
   * old right-click "Rename…" appeared to do nothing). Switches to the
   * Objects tab if needed so the row exists, then simulates the same
   * double-click-to-edit the outliner already supports.
   */
  renameObjectInline(ref: import('../tools/objects').ObjRef): void {
    if (this.propsTab !== 'object') this.openTab('object');
    const key = `${ref.kind}:${ref.id}`;
    const row = document.querySelector(`#sidebar [data-ref="${CSS.escape(key)}"]`);
    const nameSpan = row?.querySelector('.grow') as HTMLElement | null;
    nameSpan?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }

  /** F2: rename the active (last-picked) object, from anywhere. */
  renameActiveObject(): void {
    const ref = this.app.getLastPicked();
    if (ref) this.renameObjectInline(ref);
  }

  // ------------------------------------------------------------ sidebar

  /** N3: Blender-style properties editor — icon tabs over panel groups. */
  private propsTab = 'object';

  /** Jump the properties editor to a tab by id (agent/palette entrypoint). */
  openTab(id: string): void { this.propsTab = id; this.refresh(); }
  private lastMode = '';

  private buildSidebar(): void {
    const { ctx } = this.app;
    const side = $('sidebar');
    side.replaceChildren();

    // mode changes nudge the tab the way Blender's context tabs follow mode
    if (ctx.settings.mode !== this.lastMode) {
      this.lastMode = ctx.settings.mode;
      this.propsTab = ctx.settings.mode === 'OBJECT' ? 'object'
        : ctx.settings.mode === 'EDIT' ? 'data' : 'brush';
    }

    const tabs: { id: string; icon: IconName; title: string; build: () => HTMLElement[] }[] = [
      {
        id: 'object', icon: 'cube', title: 'Objects — outliner · transform · material',
        build: () => [this.objectsPanel(), this.objectPropsPanel()],
      },
      {
        id: 'constraints', icon: 'link', title: 'Constraints — travelers · triggers · physics',
        build: () => [this.constraintsPanel()],
      },
      {
        id: 'brush', icon: 'brush', title: 'Brush & GP materials',
        build: () => [
          this.brushPanel(), this.materialsPanel(),
          ...(ctx.settings.mode === 'EDIT' ? [this.strokePanel(), this.editOpsPanel()] : []),
        ],
      },
      {
        id: 'data', icon: 'folder', title: 'Data — layers · strokes · onion skin',
        build: () => [
          this.layersPanel(),
          ...(ctx.settings.mode === 'EDIT' ? [this.strokePanel(), this.editOpsPanel()] : []),
          this.onionPanel(),
        ],
      },
      {
        id: 'mods', icon: 'wrench', title: 'Modifiers & effects',
        build: () => [this.modifiersPanel(), this.effectsPanel()],
      },
      {
        id: 'bindings', icon: 'boltCircle', title: 'Bindings — score · routes · MIDI/OSC/WS',
        build: () => [this.scorePanel(), this.routesPanel(), this.ioPanel()],
      },
      {
        id: 'mediamime', icon: 'camera', title: 'MediaMime — live landmarks & object rigging',
        build: () => [this.mmStreamsPanel(), this.mediamimePanel()],
      },
      {
        id: 'solvers', icon: 'variable', title: 'Solvers — splats · string art · wire art',
        build: () => [this.splatsPanel(), this.solverPanel()],
      },
    ];

    // Blender-style vertical tab column beside the panel stack
    const strip = el('div', { class: 'props-tabs' });
    for (const t of tabs) {
      strip.append(btn(icon(t.icon, 17), () => { this.propsTab = t.id; this.refresh(); },
        { cls: `props-tab${this.propsTab === t.id ? ' active' : ''}`, title: t.title }));
    }
    const content = el('div', { class: 'props-content' });
    const active = tabs.find((t) => t.id === this.propsTab) ?? tabs[0];
    content.append(...active.build());
    side.append(strip, content);
  }

  /** N6: hierarchy outliner — tree by parent, drag-to-parent, dbl-click rename. */
  private outlinerCollapsed = new Set<string>();

  private objectsPanel(): HTMLElement {
    const { ctx } = this.app;
    const scene = ctx.scene;

    const toggleSel = (apply: (v: boolean) => void, cur: boolean, shift: boolean) => {
      ctx.pushUndo();
      if (!shift) {
        for (const o of scene.objects) o.select = false;
        for (const c of scene.canvases) c.select = false;
        for (const s of scene.splats) s.select = false;
        for (const m of scene.meshes) m.select = false;
        for (const t of scene.score.triggers) t.select = false;
      }
      apply(shift ? !cur : true);
      ctx.syncCanvases();
      ctx.requestRender();
      this.app.refreshWidget();
      this.refresh();
    };

    interface NodeDesc {
      ref: ObjRef; icon: Node; name: string; selected: boolean;
      parent?: { kind: string; id: number } | null;
      onSelect: (e?: MouseEvent) => void; extras: Node[];
      rename: (v: string) => void; after?: Node[];
    }
    const nodes: NodeDesc[] = [];

    /** Outliner eye/lock pair, Blender-style — shared across every kind so
     *  they read consistently (view = renders, lock = blocks viewport
     *  click/box-select but the row itself still selects). */
    const viewLockBtns = (
      hidden: boolean, onHide: (v: boolean) => void,
      locked: boolean, onLock: (v: boolean) => void,
    ): Node[] => [
      btn(hidden ? icon('eyeOff') : icon('eye'), () => { onHide(!hidden); this.refresh(); },
        { cls: 'icon-btn', title: hidden ? 'Hidden (click to show)' : 'Visible (click to hide)' }),
      btn(locked ? icon('lockClosed') : icon('lockOpen'), () => { onLock(!locked); this.refresh(); },
        { cls: 'icon-btn', title: locked ? 'Locked (click to unlock)' : 'Unlocked (click to lock — blocks viewport click-select)' }),
    ];

    scene.objects.forEach((ob, i) => nodes.push({
      ref: { kind: 'GP', id: ob.id }, icon: icon('pencil'), name: ob.name, selected: !!ob.select,
      parent: ob.parent,
      onSelect: (e) => {
        scene.activeObject = i;
        this.app.setLastPicked({ kind: 'GP', id: ob.id });
        toggleSel((v) => { ob.select = v; }, !!ob.select, !!e?.shiftKey);
      },
      extras: [
        btn(icon('arrowDownTray'), () => this.app.exportActiveGP(), { cls: 'icon-btn', title: 'Export this GP object' }),
        ...viewLockBtns(
          !!ob.hide, (v) => { ob.hide = v; ctx.requestRender(); },
          !!ob.lock, (v) => { ob.lock = v; },
        ),
      ],
      rename: (v) => { ob.name = v; },
    }));
    for (const c of scene.canvases) nodes.push({
      ref: { kind: 'CANVAS', id: c.id }, icon: icon('square'), name: c.name, selected: c.select,
      parent: c.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'CANVAS', id: c.id });
        toggleSel((v) => { c.select = v; }, c.select, !!e?.shiftKey);
      },
      extras: [
        btn(c.drawTarget ? icon('pencilSquare') : icon('dot'), () => { c.drawTarget = !c.drawTarget; ctx.syncCanvases(); this.refresh(); }, { cls: 'icon-btn', title: 'Draw target' }),
        btn(c.visible ? icon('eye') : icon('eyeOff'), () => { c.visible = !c.visible; ctx.syncCanvases(); this.refresh(); }, { cls: 'icon-btn' }),
      ],
      rename: (v) => { c.name = v; },
    });
    for (const m of scene.meshes) nodes.push({
      ref: { kind: 'MESH', id: m.id }, icon: m.kind === 'MODEL' ? icon('cubeModel') : icon('cube'), name: m.name,
      selected: m.select, parent: m.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'MESH', id: m.id });
        toggleSel((v) => { m.select = v; }, m.select, !!e?.shiftKey);
      },
      extras: [
        colorField('', [...m.color, 1], (rgb) => { m.color = rgb; }),
        btn(m.drawTarget ? icon('pencilSquare') : icon('dot'), () => { m.drawTarget = !m.drawTarget; this.refresh(); }, { cls: 'icon-btn', title: 'Draw target' }),
        btn(m.wireframe ? icon('wireframe') : icon('square'), () => { m.wireframe = !m.wireframe; this.refresh(); }, { cls: 'icon-btn', title: 'Wireframe (reference look)' }),
        ...viewLockBtns(
          !m.visible, (v) => { m.visible = !v; },
          !!m.lock, (v) => { m.lock = v; },
        ),
      ],
      rename: (v) => { m.name = v; },
      after: m.select ? [el('div', { class: 'row' },
        slider('Opacity', m.opacity, 0.05, 1, 0.01, (v) => { m.opacity = v; }),
      )] : [],
    });
    for (const s of scene.splats) nodes.push({
      ref: { kind: 'SPLAT', id: s.id }, icon: icon('sparkles'), name: s.name, selected: s.select,
      parent: s.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'SPLAT', id: s.id });
        toggleSel((v) => { s.select = v; }, s.select, !!e?.shiftKey);
      },
      extras: [
        btn(s.drawTarget ? icon('pencilSquare') : icon('dot'), () => { s.drawTarget = !s.drawTarget; this.refresh(); }, { cls: 'icon-btn', title: 'Draw target (GP surface placement raycasts the splat)' }),
        btn('⬇.ply', () => this.app.exportSplatPly(s.id), { cls: 'icon-btn', title: 'Export as 3DGS PLY (PlayCanvas/SuperSplat compatible)' }),
        ...viewLockBtns(
          !s.visible, (v) => { s.visible = !v; },
          !!s.lock, (v) => { s.lock = v; },
        ),
      ],
      rename: (v) => { s.name = v; },
    });
    for (const t of scene.score.triggers) nodes.push({
      ref: { kind: 'TRIGGER', id: t.id }, icon: icon('boltCircle'), name: t.name, selected: !!t.select,
      parent: t.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'TRIGGER', id: t.id });
        toggleSel((v) => { t.select = v; }, !!t.select, !!e?.shiftKey);
      },
      extras: [
        btn(t.zone ? icon('wave') : t.follow ? icon('link') : ctx.scene.mediamime.rigs.some((r) => r.target.kind === 'TRIGGER' && r.target.id === t.id) ? icon('camera') : icon('dot'),
          () => {}, { cls: 'icon-btn', title: t.zone ? 'Stroke zone' : t.follow ? 'Follows an object' : 'Static / MediaMime-rigged' }),
        ...viewLockBtns(
          !!t.hide, (v) => { t.hide = v; },
          !!t.lock, (v) => { t.lock = v; },
        ),
      ],
      rename: (v) => { t.name = v; },
    });

    // parent → children tree (unknown parents render as roots)
    const keyOf = (r: { kind: string; id: number }) => `${r.kind}:${r.id}`;
    const known = new Set(nodes.map((n) => keyOf(n.ref)));
    const children = new Map<string, NodeDesc[]>();
    const roots: NodeDesc[] = [];
    for (const n of nodes) {
      const pk = n.parent && known.has(keyOf(n.parent)) ? keyOf(n.parent) : '';
      if (!pk) { roots.push(n); continue; }
      if (!children.get(pk)) children.set(pk, []);
      children.get(pk)!.push(n);
    }

    const reparent = (childKey: string, parentRef: ObjRef | null) => {
      const [kind, id] = childKey.split(':');
      const childRef = { kind: kind as ObjRef['kind'], id: Number(id) };
      if (parentRef && keyOf(childRef) === keyOf(parentRef)) return;
      ctx.pushUndo();
      if (setParentKeepWorld(scene, childRef, parentRef)) {
        ctx.syncCanvases();
        ctx.requestRender();
        this.app.refreshWidget();
        this.refresh();
      }
    };

    const rows: Node[] = [];
    const emit = (n: NodeDesc, depth: number) => {
      const key = keyOf(n.ref);
      const kids = children.get(key) ?? [];
      const collapsed = this.outlinerCollapsed.has(key);
      const item = el('div', { class: `list-item ${n.selected ? 'active' : ''}`, 'data-ref': key });
      item.style.paddingLeft = `${6 + depth * 14}px`;
      item.onclick = (e) => n.onSelect(e as MouseEvent);
      item.oncontextmenu = (e) => {
        e.preventDefault();
        if (!n.selected) n.onSelect(undefined);
        this.openObjectContextMenu(e.clientX, e.clientY);
      };

      if (kids.length) {
        const tri = el('span', { class: 'tree-tri', text: collapsed ? '▸' : '▾' });
        tri.onclick = (e) => {
          e.stopPropagation();
          if (collapsed) this.outlinerCollapsed.delete(key);
          else this.outlinerCollapsed.add(key);
          this.refresh();
        };
        item.append(tri);
      } else {
        item.append(el('span', { class: 'tree-tri', text: '·' }));
      }

      const nameSpan = el('span', { class: 'grow', text: n.name });
      nameSpan.ondblclick = (e) => {
        e.stopPropagation();
        const input = el('input', { type: 'text', value: n.name }) as HTMLInputElement;
        input.onclick = (ev) => ev.stopPropagation();
        const commit = () => { n.rename(input.value.trim() || n.name); this.refresh(); };
        input.onblur = commit;
        input.onkeydown = (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') input.blur();
          if (ev.key === 'Escape') { input.onblur = null; this.refresh(); }
        };
        nameSpan.replaceWith(input);
        input.focus(); input.select();
      };
      item.append(el('span', { class: 'row-icon' }, n.icon), nameSpan, ...n.extras);

      // drag-to-parent
      item.draggable = true;
      item.ondragstart = (e) => e.dataTransfer?.setData('text/tg-ref', key);
      item.ondragover = (e) => { e.preventDefault(); item.classList.add('drop-target'); };
      item.ondragleave = () => item.classList.remove('drop-target');
      item.ondrop = (e) => {
        e.preventDefault();
        item.classList.remove('drop-target');
        const src = e.dataTransfer?.getData('text/tg-ref');
        if (src && src !== key) reparent(src, n.ref);
      };

      rows.push(item, ...(n.after ?? []));
      if (!collapsed) for (const kid of kids) emit(kid, depth + 1);
    };
    for (const n of roots) emit(n, 0);

    const hint = el('div', { class: 'row', text: 'Click selects · dbl-click renames · drag onto a row parents · drop here unparents · Ctrl+P/Alt+P · X deletes' });
    hint.ondragover = (e) => e.preventDefault();
    hint.ondrop = (e) => {
      e.preventDefault();
      const src = e.dataTransfer?.getData('text/tg-ref');
      if (src) reparent(src, null);
    };

    return panel('Objects', hint, ...rows);
  }

  /** Blender-lite per-object Properties + Material panel (single selection). */
  /**
   * Blender-lite multi-object transform: fields show the ACTIVE (last-
   * picked) object's values; editing a field sets that axis ABSOLUTELY on
   * every selected object (not a delta — "type 0 in Z, everyone drops to
   * the ground plane" is the point). Kind-specific material fields still
   * need exactly one selection, same as before.
   */
  private multiObjectTransformPanel(refs: ObjRef[]): HTMLElement {
    const { ctx } = this.app;
    const lastPicked = this.app.getLastPicked();
    const activeRef = (lastPicked && refs.some((r) => r.kind === lastPicked.kind && r.id === lastPicked.id))
      ? lastPicked : refs[0];
    const t = getObjectTransform(ctx.scene, activeRef);
    const rows: Node[] = [];
    if (t) {
      const setAxis = (group: 'translation' | 'rotation' | 'scale', i: number, v: number) => {
        for (const r of refs) {
          const rt = getObjectTransform(ctx.scene, r);
          if (!rt) continue;
          rt[group][i] = v;
          setObjectTransform(ctx.scene, r, rt);
        }
        ctx.syncCanvases();
        ctx.requestRender();
        this.app.refreshWidget();
        this.refresh();
      };
      rows.push(
        el('div', { class: 'row', text: `Editing sets that value on all ${refs.length} selected` }),
        el('div', { class: 'row' }, 'Loc',
          ...[0, 1, 2].map((i) => numField('', +t.translation[i].toFixed(3), (v) => setAxis('translation', i, v)))),
        el('div', { class: 'row' }, 'Rot',
          ...[0, 1, 2].map((i) => numField('', +t.rotation[i].toFixed(3), (v) => setAxis('rotation', i, v)))),
        el('div', { class: 'row' }, 'Scale',
          ...[0, 1, 2].map((i) => numField('', +t.scale[i].toFixed(3), (v) => setAxis('scale', i, v)))),
      );
    }
    return panel(`Object Properties — ${refs.length} selected`, ...rows);
  }

  private objectPropsPanel(): HTMLElement {
    const { ctx } = this.app;
    const refs = listSelectedObjects(ctx.scene);
    if (!refs.length) {
      return panel('Object Properties', el('div', { class: 'row', text: 'select one or more objects' }));
    }
    if (refs.length > 1) return this.multiObjectTransformPanel(refs);
    const ref = refs[0];
    const rows: Node[] = [];
    const t = getObjectTransform(ctx.scene, ref);
    if (t) {
      const write = () => {
        setObjectTransform(ctx.scene, ref, t);
        ctx.syncCanvases();
        ctx.requestRender();
        this.app.refreshWidget();
      };
      rows.push(
        el('div', { class: 'row' }, 'Loc',
          ...[0, 1, 2].map((i) => numField('', +t.translation[i].toFixed(3), (v) => { t.translation[i] = v; write(); }))),
        el('div', { class: 'row' }, 'Rot',
          ...[0, 1, 2].map((i) => numField('', +t.rotation[i].toFixed(3), (v) => { t.rotation[i] = v; write(); }))),
        el('div', { class: 'row' }, 'Scale',
          ...[0, 1, 2].map((i) => numField('', +t.scale[i].toFixed(3), (v) => { t.scale[i] = v; write(); }))),
      );
    }

    if (ref.kind === 'MESH') {
      const m = ctx.scene.meshes.find((x) => x.id === ref.id)!;
      const texFile = el('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
      texFile.style.display = 'none';
      texFile.onchange = () => {
        const f = texFile.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { m.texture = String(reader.result); m.unlit = true; this.refresh(); };
        reader.readAsDataURL(f);
      };
      rows.push(
        el('div', { class: 'menu-sep' }),
        el('div', { class: 'menu-header', text: 'Material' }),
        el('div', { class: 'row' },
          colorField('Color', [...m.color, 1], (rgb) => { m.color = rgb; }),
          slider('Opacity', m.opacity, 0.02, 1, 0.01, (v) => { m.opacity = v; }),
        ),
        el('div', { class: 'row' },
          texFile,
          btn(m.texture ? iconLabel('photo', 'replace texture…') : 'Load texture…', () => texFile.click()),
          ...(m.texture ? [btn(icon('xMark'), () => { m.texture = null; this.refresh(); }, { cls: 'icon-btn', title: 'Clear texture' })] : []),
        ),
        el('div', { class: 'row' },
          checkbox('Unlit', !!m.unlit, (v) => { m.unlit = v; }),
          checkbox('Two-sided', m.doubleSided !== false, (v) => { m.doubleSided = v; }),
          checkbox('Wireframe', m.wireframe, (v) => { m.wireframe = v; }),
        ),
        el('div', { class: 'row' },
          selectField('Lock', m.billboard ?? 'NONE', [
            ['NONE', 'World'], ['FACE_VIEW', 'Face view'], ['CAMERA', 'Camera (HUD)'],
          ], (v) => { m.billboard = v as typeof m.billboard; this.refresh(); }),
          checkbox('Draw target', m.drawTarget, (v) => { m.drawTarget = v; }),
        ),
        ...(m.billboard === 'CAMERA' ? [el('div', {
          class: 'row',
          text: 'Camera lock: Loc/Rot/Scale become a view-space offset (keep z negative for depth)',
        })] : []),
      );
    } else if (ref.kind === 'SPLAT') {
      const s = ctx.scene.splats.find((x) => x.id === ref.id)!;
      rows.push(
        el('div', { class: 'menu-sep' }),
        el('div', { class: 'row' },
          checkbox('Visible', s.visible, (v) => { s.visible = v; }),
          checkbox('Draw target', !!s.drawTarget, (v) => { s.drawTarget = v; }),
          btn('⬇ .ply', () => this.app.exportSplatPly(s.id), { title: '3DGS PLY (PlayCanvas/SuperSplat)' }),
        ),
      );
    } else if (ref.kind === 'GP') {
      const ob = ctx.scene.objects.find((o) => o.id === ref.id);
      if (ob) {
        const name = el('input', { type: 'text', value: ob.name }) as HTMLInputElement;
        name.onchange = () => { ob.name = name.value; this.refresh(); };
        rows.push(el('div', { class: 'menu-sep' }), el('div', { class: 'row' }, 'Name', name));
      }
    } else if (ref.kind === 'TRIGGER') {
      const trig = ctx.scene.score.triggers.find((x) => x.id === ref.id)!;
      const rig = ctx.scene.mediamime.rigs.find((r) => r.target.kind === 'TRIGGER' && r.target.id === trig.id);
      rows.push(
        el('div', { class: 'menu-sep' }),
        el('div', { class: 'row' },
          checkbox('Retrigger', trig.retrigger, (v) => { trig.retrigger = v; }),
          this.followField(() => trig.follow, (v) => { trig.follow = v; }),
        ),
        el('div', { class: 'row', text: trig.zone ? 'Zone: whole stroke (see Data → Stroke panel)' : rig ? `MediaMime: ${rig.address}` : 'Static position (drag to move, or bind in the MediaMime panel)' }),
      );
    }
    return panel(`Properties — ${objectName(ctx.scene, ref)}`, ...rows);
  }

  /** Blender-style brush Advanced panel; edits are baked into future strokes only. */
  private brushPanel(): HTMLElement {
    const { ctx } = this.app;
    const b = ctx.settings.brush;
    const st = b.style;
    return panel('Brush — Advanced',
      el('div', { class: 'row' },
        selectField('Size unit', st.unit, [['VIEW', 'View (px)'], ['SCENE', 'Scene (world)']],
          (v) => { st.unit = v as 'VIEW' | 'SCENE'; }),
        checkbox('Stamp', st.stamp, (v) => { st.stamp = v; }),
      ),
      slider('Hardness', b.hardness, 0.05, 1, 0.01, (v) => { b.hardness = v; }),
      slider('Spacing', st.spacing, 0.03, 1, 0.01, (v) => { st.spacing = v; }),
      slider('Angle', st.angle, -Math.PI, Math.PI, 0.05, (v) => { st.angle = v; }),
      slider('Aspect', st.aspect, 0.1, 1, 0.01, (v) => { st.aspect = v; }),
      slider('Jitter', st.jitter, 0, 1, 0.01, (v) => { st.jitter = v; }),
      slider('Grain', st.grain, 0, 1, 0.01, (v) => { st.grain = v; }),
      slider('Grain scale', st.grainScale, 1, 30, 0.5, (v) => { st.grainScale = v; }),
      el('div', { class: 'row' },
        slider('Active smooth', b.activeSmooth, 0, 0.8, 0.02, (v) => { b.activeSmooth = v; }),
      ),
      el('div', { class: 'row' },
        slider('Post smooth', b.postSmooth, 0, 1, 0.02, (v) => { b.postSmooth = v; }),
        numField('Simplify', b.simplify, (v) => { b.simplify = Math.max(0, v); }, 0.001),
      ),
      el('div', { class: 'row' },
        checkbox('Stabilize', b.stabilize, (v) => { b.stabilize = v; }),
        slider('Radius', b.stabilizeRadius, 5, 120, 1, (v) => { b.stabilizeRadius = v; }),
      ),
    );
  }

  private layersPanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const items: Node[] = [];

    // top layer first (Blender lists top-down)
    for (let i = ob.layers.length - 1; i >= 0; i--) {
      const layer = ob.layers[i];
      const item = el('div', { class: `list-item ${layer.id === ob.activeLayerId ? 'active' : ''}` });
      item.onclick = () => { ob.activeLayerId = layer.id; ctx.requestRender(); this.refresh(); };
      const name = el('span', { class: 'grow', text: layer.name });
      name.ondblclick = () => {
        const n = prompt('Layer name', layer.name);
        if (n) { layer.name = n; this.refresh(); }
      };
      item.append(
        name,
        btn(layer.hide ? icon('eyeOff') : icon('eye'), () => { layer.hide = !layer.hide; ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn', title: 'Hide' }),
        btn(layer.lock ? icon('lockClosed') : icon('lockOpen'), () => { layer.lock = !layer.lock; this.refresh(); }, { cls: 'icon-btn', title: 'Lock' }),
        btn(layer.useOnion ? icon('sparkles') : icon('dot'), () => { layer.useOnion = !layer.useOnion; ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn', title: 'Onion skin' }),
      );
      items.push(item);
    }

    const layer = activeLayer(ob);
    const props: Node[] = [];
    if (layer) {
      props.push(
        slider('Opacity', layer.opacity, 0, 1, 0.01, (v) => { layer.opacity = v; ctx.requestRender(); }),
        el('div', { class: 'row' },
          selectField('Blend', layer.blendMode, [['REGULAR', 'Regular'], ['ADD', 'Add'], ['MULTIPLY', 'Multiply']] as [BlendMode, string][], (v) => { layer.blendMode = v; ctx.requestRender(); }),
          numField('Thickness +', layer.thicknessOffset, (v) => { layer.thicknessOffset = v; ctx.requestRender(); }, 1),
        ),
        el('div', { class: 'row' },
          colorField('Tint', layer.tint, (rgb) => { layer.tint = [rgb[0], rgb[1], rgb[2], layer.tint[3]]; ctx.requestRender(); }),
          slider('Factor', layer.tint[3], 0, 1, 0.01, (v) => { layer.tint[3] = v; ctx.requestRender(); }),
        ),
        this.maskRow(layer),
      );
    }

    return panel('Layers',
      el('div', { class: 'row' },
        btn('＋', () => {
          ctx.pushUndo();
          const l = createLayer(`Layer ${ob.layers.length + 1}`);
          ob.layers.push(l);
          ob.activeLayerId = l.id;
          ctx.requestRender(); this.refresh();
        }, { title: 'Add layer' }),
        btn('－', () => {
          if (ob.layers.length <= 1 || !layer) return;
          ctx.pushUndo();
          ob.layers.splice(ob.layers.indexOf(layer), 1);
          ob.activeLayerId = ob.layers[ob.layers.length - 1].id;
          ctx.requestRender(); this.refresh();
        }, { title: 'Remove layer' }),
        btn('⧉', () => {
          if (!layer) return;
          ctx.pushUndo();
          const copy = createLayer(`${layer.name} copy`);
          Object.assign(copy, JSON.parse(JSON.stringify({ ...layer, id: copy.id, name: copy.name })));
          copy.frames = layer.frames.map(cloneFrame);
          ob.layers.push(copy);
          ob.activeLayerId = copy.id;
          ctx.requestRender(); this.refresh();
        }, { title: 'Duplicate layer' }),
        btn(icon('chevronUp'), () => this.moveLayer(1), { title: 'Move up' }),
        btn(icon('chevronDown'), () => this.moveLayer(-1), { title: 'Move down' }),
      ),
      ...items, ...props,
    );
  }

  private maskRow(layer: GPLayer): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const row = el('div', { class: 'row' });
    row.append(checkbox('Mask', layer.useMask, (v) => { layer.useMask = v; ctx.requestRender(); }));
    const sel = el('select') as HTMLSelectElement;
    sel.append(el('option', { value: '', text: 'add mask layer…' }));
    for (const l of ob.layers) {
      if (l.id !== layer.id && !layer.maskLayerIds.includes(l.id)) {
        sel.append(el('option', { value: String(l.id), text: l.name }));
      }
    }
    sel.onchange = () => {
      if (sel.value) { layer.maskLayerIds.push(Number(sel.value)); ctx.requestRender(); this.refresh(); }
    };
    row.append(sel);
    for (const id of layer.maskLayerIds) {
      const l = ob.layers.find((x) => x.id === id);
      row.append(btn(el('span', { class: 'icon-label' }, `${l?.name ?? id} `, icon('xMark', 12)), () => {
        layer.maskLayerIds = layer.maskLayerIds.filter((x) => x !== id);
        ctx.requestRender(); this.refresh();
      }, { cls: 'icon-btn', title: 'Remove mask' }));
    }
    return row;
  }

  private moveLayer(dir: number): void {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const layer = activeLayer(ob);
    if (!layer) return;
    const i = ob.layers.indexOf(layer);
    const j = i + dir;
    if (j < 0 || j >= ob.layers.length) return;
    ctx.pushUndo();
    [ob.layers[i], ob.layers[j]] = [ob.layers[j], ob.layers[i]];
    ctx.requestRender(); this.refresh();
  }

  private materialsPanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const items: Node[] = [];
    ob.materials.forEach((m, i) => {
      const item = el('div', { class: `list-item ${i === ob.activeMaterial ? 'active' : ''}` });
      item.onclick = () => { ob.activeMaterial = i; this.refresh(); };
      const sw = el('div', { class: 'swatch' });
      sw.style.background = rgbToHex(m.showFill ? m.fillColor : m.strokeColor);
      item.append(sw, el('span', { class: 'grow', text: m.name }));
      items.push(item);
    });

    const m = ob.materials[ob.activeMaterial];
    const props: Node[] = [];
    if (m) {
      props.push(
        el('div', { class: 'row' },
          checkbox('Stroke', m.showStroke, (v) => { m.showStroke = v; ctx.requestRender(); }),
          colorField('', m.strokeColor, (rgb) => { m.strokeColor = [rgb[0], rgb[1], rgb[2], m.strokeColor[3]]; ctx.requestRender(); }),
          slider('A', m.strokeColor[3], 0, 1, 0.01, (v) => { m.strokeColor[3] = v; ctx.requestRender(); }),
        ),
        selectField('Line', m.lineMode, [['LINE', 'Line'], ['DOTS', 'Dots'], ['SQUARES', 'Squares']] as [LineMode, string][], (v) => { m.lineMode = v; ctx.requestRender(); }),
        el('div', { class: 'row' },
          checkbox('Fill', m.showFill, (v) => { m.showFill = v; ctx.requestRender(); }),
          colorField('', m.fillColor, (rgb) => { m.fillColor = [rgb[0], rgb[1], rgb[2], m.fillColor[3]]; ctx.requestRender(); }),
          slider('A', m.fillColor[3], 0, 1, 0.01, (v) => { m.fillColor[3] = v; ctx.requestRender(); }),
        ),
        selectField('Fill style', m.fillStyle, [['SOLID', 'Solid'], ['GRADIENT_LINEAR', 'Linear Gradient'], ['GRADIENT_RADIAL', 'Radial Gradient']] as [FillStyle, string][], (v) => { m.fillStyle = v; ctx.requestRender(); }),
      );
      if (m.fillStyle !== 'SOLID') {
        props.push(el('div', { class: 'row' },
          colorField('Color 2', m.fillColor2, (rgb) => { m.fillColor2 = [rgb[0], rgb[1], rgb[2], m.fillColor2[3]]; ctx.requestRender(); }),
          slider('Angle', m.gradientAngle, 0, Math.PI * 2, 0.05, (v) => { m.gradientAngle = v; ctx.requestRender(); }),
        ));
      }
      props.push(checkbox('Holdout', m.holdout, (v) => { m.holdout = v; ctx.requestRender(); }));
      if (ctx.settings.mode === 'EDIT') {
        props.push(btn('Assign to selected', () => ops.assignMaterial(ctx, ob.activeMaterial)));
      }
    }

    return panel('Materials',
      el('div', { class: 'row' },
        btn('＋', () => {
          ctx.pushUndo();
          ob.materials.push(createMaterial(`Material ${ob.materials.length + 1}`, [0, 0, 0, 1]));
          ob.activeMaterial = ob.materials.length - 1;
          this.refresh();
        }),
        btn('－', () => {
          if (ob.materials.length <= 1) return;
          ctx.pushUndo();
          ob.materials.splice(ob.activeMaterial, 1);
          ob.activeMaterial = Math.max(0, ob.activeMaterial - 1);
          ctx.requestRender(); this.refresh();
        }),
      ),
      ...items, ...props,
    );
  }

  private canvasesPanel(): HTMLElement {
    const { ctx } = this.app;
    const items: Node[] = [];
    for (const c of ctx.scene.canvases) {
      const body = el('div', { class: 'body' });
      body.append(
        el('div', { class: 'row' },
          checkbox('Visible', c.visible, (v) => { c.visible = v; this.app.syncCanvases(); }),
          checkbox('Draw target', c.drawTarget, (v) => { c.drawTarget = v; this.app.syncCanvases(); }),
          btn(icon('xMark'), () => this.app.removeCanvasPlane(c.id), { cls: 'icon-btn', title: 'Delete canvas' }),
        ),
        el('div', { class: 'row' }, 'Pos',
          ...[0, 1, 2].map((i) => numField('', c.translation[i], (v) => { c.translation[i] = v; this.app.syncCanvases(); })),
        ),
        el('div', { class: 'row' }, 'Rot',
          ...[0, 1, 2].map((i) => numField('', c.rotation[i], (v) => { c.rotation[i] = v; this.app.syncCanvases(); })),
        ),
        el('div', { class: 'row' }, 'Size',
          ...[0, 1].map((i) => numField('', c.size[i], (v) => { c.size[i] = Math.max(0.1, v); this.app.syncCanvases(); })),
        ),
      );
      items.push(el('div', { class: 'panel' }, el('h3', { text: c.name }), body));
    }
    return panel('Canvases',
      el('div', { class: 'row' },
        btn('＋ Plane at cursor', () => this.app.addCanvasPlane(),
          { title: 'Add a drawable plane at the 3D cursor, oriented to the current drawing plane' }),
      ),
      el('div', { class: 'row', text: 'Use Placement: Surface to draw on canvases' }),
      ...items,
    );
  }

  /** Per-stroke identity + event assignment (visible with exactly one stroke selected). */
  private strokePanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const obIndex = ctx.scene.activeObject;

    // exactly-one selected stroke across visible editable layers
    let found: { stroke: import('../core/types').GPStroke; layerId: number } | null = null;
    let count = 0;
    for (const layer of ob.layers) {
      if (layer.hide || layer.lock) continue;
      const f = frameAt(layer, ctx.scene.frame);
      if (!f) continue;
      for (const s of f.strokes) {
        if (s.select || s.points.some((p) => p.select)) {
          count++;
          found = { stroke: s, layerId: layer.id };
        }
      }
    }
    if (count !== 1 || !found) {
      return panel('Stroke', el('div', {
        class: 'row',
        text: count === 0 ? 'select a stroke to edit its properties'
          : `${count} strokes selected — Ctrl+J joins, Ctrl+L selects connected`,
      }));
    }
    const { stroke, layerId } = found;
    const sc = ctx.scene.score;

    const nameInput = el('input', { type: 'text', value: stroke.name ?? '', placeholder: `stroke ${stroke.id}` }) as HTMLInputElement;
    nameInput.style.width = '110px';
    nameInput.onchange = () => { stroke.name = nameInput.value.trim() || undefined; };
    const addrInput = el('input', { type: 'text', value: stroke.address ?? '', placeholder: `/stroke/${stroke.id}` }) as HTMLInputElement;
    addrInput.style.width = '130px';
    addrInput.onchange = () => { stroke.address = addrInput.value.trim() || undefined; };

    const path = { objectIndex: obIndex, layerId, strokeId: stroke.id };
    const addr = () => stroke.address ?? `/stroke/${stroke.id}`;
    const boundCursors = sc.cursors.filter((c) => c.path.strokeId === stroke.id);

    const worldOf = (co: [number, number, number]): [number, number, number] => [
      co[0] + ob.translation[0], co[1] + ob.translation[1], co[2] + ob.translation[2],
    ];
    const addTrigger = (at: 'start' | 'end') => {
      ctx.pushUndo();
      const id = scoreId(ctx.scene);
      const p = at === 'start' ? stroke.points[0] : stroke.points[stroke.points.length - 1];
      sc.triggers.push({
        id, name: `${stroke.name ?? `stroke ${stroke.id}`} ${at}`,
        position: worldOf(p.co), radius: 0.2, retrigger: true,
        messages: [{ address: `${addr()}/${at}`, argExprs: ['1'] }],
      });
      this.refresh();
    };

    return panel('Stroke',
      el('div', { class: 'row' }, 'Name', nameInput),
      el('div', { class: 'row' }, 'Addr', addrInput),
      el('div', { class: 'row' },
        btn('＋Traveler', () => {
          ctx.pushUndo();
          const cur = defaultCursor(ctx.scene, path);
          cur.name = stroke.name ?? cur.name;
          cur.messages = [{ address: `${addr()}/pos`, argExprs: ['{x}', '{y}', '{z}', '{t}'] }];
          sc.cursors.push(cur);
          this.refresh();
        }, { title: 'Traveler (playhead) on this stroke emitting at its address' }),
        btn('＋Trig start', () => addTrigger('start')),
        btn('＋Trig end', () => addTrigger('end')),
        btn('＋Zone', () => {
          ctx.pushUndo();
          const id = scoreId(ctx.scene);
          sc.triggers.push({
            id, name: `${stroke.name ?? `stroke ${stroke.id}`} zone`,
            position: worldOf(stroke.points[0].co), radius: 0.2, retrigger: true,
            zone: path,
            messages: [{ address: `${addr()}/hit`, argExprs: ['1'] }],
          });
          this.refresh();
        }, { title: 'Whole stroke becomes a trigger zone: fires when a traveler comes within radius of any of its points' }),
      ),
      ...(boundCursors.length ? [el('div', {
        class: 'row',
        text: `traveler(s) riding this: ${boundCursors.map((c) => c.name).join(', ')}`,
      })] : []),
      el('div', { class: 'row', text: `id ${stroke.id} · ${stroke.points.length} pts · events → ${addr()}/…` }),
    );
  }

  private editOpsPanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const layerSel = el('select') as HTMLSelectElement;
    for (const l of ob.layers) layerSel.append(el('option', { value: String(l.id), text: l.name }));
    const iconBtn = (iconName: IconName, title: string, fn: () => void) =>
      btn(icon(iconName), fn, { cls: 'icon-btn', title });
    return panel('Stroke Ops',
      el('div', { class: 'row' },
        iconBtn('squareTarget', 'Subdivide', () => ops.subdivideSelected(ctx)),
        iconBtn('lineTool', 'Simplify', () => ops.simplifySelected(ctx)),
        iconBtn('curveTool', 'Smooth', () => ops.smoothSelected(ctx)),
      ),
      el('div', { class: 'row' },
        iconBtn('link', 'Join', () => ops.joinSelected(ctx)),
        iconBtn('scissors', 'Split', () => ops.splitSelected(ctx)),
        iconBtn('dot', 'Merge by distance', () => ops.mergeByDistance(ctx)),
      ),
      el('div', { class: 'row' },
        iconBtn('circle', 'Toggle cyclic', () => ops.toggleCyclic(ctx)),
        iconBtn('arrowsRightLeft', 'Reverse direction', () => ops.switchDirection(ctx)),
        iconBtn('play', 'Set start point', () => ops.setStartPoint(ctx)),
      ),
      el('div', { class: 'row' },
        iconBtn('square', 'Normalize width', () => ops.normalizeThickness(ctx)),
        iconBtn('adjustments', 'Normalize opacity', () => ops.normalizeOpacity(ctx)),
      ),
      el('div', { class: 'row' },
        iconBtn('chevronUp', 'Bring to front', () => ops.arrangeSelected(ctx, 'TOP')),
        iconBtn('arrowUp', 'Move up', () => ops.arrangeSelected(ctx, 'UP')),
        iconBtn('arrowDown', 'Move down', () => ops.arrangeSelected(ctx, 'DOWN')),
        iconBtn('chevronDown', 'Send to back', () => ops.arrangeSelected(ctx, 'BOTTOM')),
      ),
      el('div', { class: 'row' },
        iconBtn('target', 'Snap to 3D cursor', () => ops.snapToCursor(ctx)),
        iconBtn('wireframe', 'Snap to grid', () => ops.snapToGrid(ctx)),
      ),
      el('div', { class: 'row' },
        iconBtn('link', 'Select linked (L)', () => { selectLinked(ctx); ctx.requestRender(); }),
        iconBtn('plus', 'Select more', () => { selectMoreLess(ctx, true); ctx.requestRender(); }),
        iconBtn('xMark', 'Select less', () => { selectMoreLess(ctx, false); ctx.requestRender(); }),
        iconBtn('invert', 'Invert selection', () => { selectAll(ctx, 'invert'); ctx.requestRender(); }),
      ),
      el('div', { class: 'row' }, 'Move to layer:', layerSel,
        iconBtn('arrowRight', 'Move selected strokes to this layer', () => ops.moveToLayer(ctx, Number(layerSel.value)))),
    );
  }

  private paramEditors(
    params: Record<string, number | boolean | number[]>, onChange: () => void,
  ): Node[] {
    const out: Node[] = [];
    for (const [key, val] of Object.entries(params)) {
      if (typeof val === 'boolean') {
        out.push(checkbox(key, val, (v) => { params[key] = v; onChange(); }));
      } else if (typeof val === 'number') {
        out.push(numField(key, val, (v) => { params[key] = v; onChange(); }));
      } else if (Array.isArray(val) && val.length === 3 && key.toLowerCase().includes('color')) {
        out.push(colorField(key, [...val, 1], (rgb) => { params[key] = rgb; onChange(); }));
      } else if (Array.isArray(val)) {
        const row = el('div', { class: 'row' }, key);
        val.forEach((component, i) => {
          row.append(numField('', component, (v) => { (params[key] as number[])[i] = v; onChange(); }));
        });
        out.push(row);
      }
    }
    return out;
  }

  private modifiersPanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const addSel = el('select') as HTMLSelectElement;
    addSel.append(el('option', { value: '', text: 'Add modifier…' }));
    for (const [type, def] of Object.entries(MODIFIERS)) {
      addSel.append(el('option', { value: type, text: def.label }));
    }
    addSel.onchange = () => {
      if (!addSel.value) return;
      ctx.pushUndo();
      ob.modifiers.push(createModifier(addSel.value as ModifierType, genId()));
      ctx.requestRender(); this.refresh();
    };

    const items: Node[] = [];
    ob.modifiers.forEach((mod, i) => {
      const body = el('div', { class: 'body' });
      body.append(
        el('div', { class: 'row' },
          checkbox('On', mod.enabled, (v) => { mod.enabled = v; ctx.requestRender(); }),
          btn(icon('chevronUp'), () => { if (i > 0) { [ob.modifiers[i - 1], ob.modifiers[i]] = [ob.modifiers[i], ob.modifiers[i - 1]]; ctx.requestRender(); this.refresh(); } }, { cls: 'icon-btn' }),
          btn(icon('chevronDown'), () => { if (i < ob.modifiers.length - 1) { [ob.modifiers[i + 1], ob.modifiers[i]] = [ob.modifiers[i], ob.modifiers[i + 1]]; ctx.requestRender(); this.refresh(); } }, { cls: 'icon-btn' }),
          btn(icon('check'), () => {
            ctx.pushUndo();
            if (applyModifierToData(ob, mod.id)) { ctx.requestRender(); this.refresh(); }
            else alert('Time modifiers cannot be baked into geometry');
          }, { cls: 'icon-btn', title: 'Apply: bake into keyframes and remove from the stack' }),
          btn(icon('xMark'), () => { ctx.pushUndo(); ob.modifiers.splice(i, 1); ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn' }),
        ),
        ...this.paramEditors(mod.params, () => ctx.requestRender()),
      );
      const layerFilterSel = el('select') as HTMLSelectElement;
      layerFilterSel.append(el('option', { value: '', text: 'All layers' }));
      for (const l of ob.layers) layerFilterSel.append(el('option', { value: String(l.id), text: l.name }));
      layerFilterSel.value = mod.layerFilter === null ? '' : String(mod.layerFilter);
      layerFilterSel.onchange = () => {
        mod.layerFilter = layerFilterSel.value ? Number(layerFilterSel.value) : null;
        ctx.requestRender();
      };
      body.append(el('div', { class: 'row' }, 'Layer:', layerFilterSel));
      items.push(el('div', { class: 'panel' }, el('h3', { text: `${mod.name}` }), body));
    });

    return panel('Modifiers', addSel, ...items);
  }

  private effectsPanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const addSel = el('select') as HTMLSelectElement;
    addSel.append(el('option', { value: '', text: 'Add effect…' }));
    for (const [type, def] of Object.entries(EFFECT_DEFAULTS)) {
      addSel.append(el('option', { value: type, text: def.label }));
    }
    addSel.onchange = () => {
      if (!addSel.value) return;
      ctx.pushUndo();
      ob.effects.push(createEffect(addSel.value as EffectType, genId()));
      ctx.requestRender(); this.refresh();
    };

    const items: Node[] = [];
    ob.effects.forEach((fx, i) => {
      const body = el('div', { class: 'body' });
      body.append(
        el('div', { class: 'row' },
          checkbox('On', fx.enabled, (v) => { fx.enabled = v; ctx.requestRender(); }),
          btn(icon('xMark'), () => { ctx.pushUndo(); ob.effects.splice(i, 1); ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn' }),
        ),
        ...this.paramEditors(fx.params, () => ctx.requestRender()),
      );
      items.push(el('div', { class: 'panel' }, el('h3', { text: fx.name }), body));
    });

    return panel('Visual Effects', addSel, ...items);
  }

  private onionPanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const o = ob.onion;
    return panel('Onion Skinning',
      el('div', { class: 'row' },
        checkbox('Enabled', o.enabled, (v) => { o.enabled = v; ctx.requestRender(); }),
        selectField('Mode', o.mode, [['KEYFRAMES', 'Keyframes'], ['FRAMES', 'Frames']], (v) => { o.mode = v; ctx.requestRender(); }),
      ),
      el('div', { class: 'row' },
        numField('Before', o.before, (v) => { o.before = Math.max(0, Math.round(v)); ctx.requestRender(); }, 1),
        numField('After', o.after, (v) => { o.after = Math.max(0, Math.round(v)); ctx.requestRender(); }, 1),
      ),
      el('div', { class: 'row' },
        colorField('Before', [...o.colorBefore, 1], (rgb) => { o.colorBefore = rgb; ctx.requestRender(); }),
        colorField('After', [...o.colorAfter, 1], (rgb) => { o.colorAfter = rgb; ctx.requestRender(); }),
      ),
      slider('Opacity', o.opacity, 0, 1, 0.01, (v) => { o.opacity = v; ctx.requestRender(); }),
    );
  }

  private cameraSelect(): HTMLElement {
    const { ctx } = this.app;
    const sel = el('select', { title: 'Active camera (Shift+C cycles)' }) as HTMLSelectElement;
    ctx.scene.cameras.forEach((cam, i) => sel.append(el('option', { value: String(i), text: cam.name })));
    sel.value = String(ctx.scene.activeCamera);
    sel.onchange = () => this.app.setActiveCamera(Number(sel.value));
    sel.ondblclick = () => {
      const cam = activeCam(ctx.scene);
      const n = prompt('Camera name', cam.name);
      if (n) { cam.name = n; this.refreshTimelineControls(); }
    };
    return sel;
  }

  // ----------------------------------------------------------- inspector

  inspectorOpen = false;
  private inspectorEl: HTMLElement | null = null;

  toggleInspector(): void {
    this.inspectorOpen = !this.inspectorOpen;
    if (this.inspectorOpen) this.rebuildInspector();
    else { this.inspectorEl?.remove(); this.inspectorEl = null; }
  }

  private vecRow(
    label: string, get: () => number[], set: (i: number, v: number) => void, step = 0.1,
  ): HTMLElement {
    const row = el('div', { class: 'row' }, label);
    get().forEach((component, i) => {
      row.append(numField('', component, (v) => set(i, v), step));
    });
    return row;
  }

  /** Blender-style N-panel: item / view / cursor values, live + editable. */
  rebuildInspector(): void {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const cam = activeCam(ctx.scene);
    if (!this.inspectorEl) {
      this.inspectorEl = el('div', { id: 'inspector' });
      document.getElementById('viewport')!.append(this.inspectorEl);
    }
    const body: Node[] = [];

    // --- Item: selection median (edit-family modes) + object transform ---
    const selected: { co: [number, number, number] }[] = [];
    if (ctx.settings.mode !== 'DRAW') {
      for (const layer of ob.layers) {
        if (layer.hide || layer.lock) continue;
        const f = frameAt(layer, ctx.scene.frame);
        if (!f) continue;
        for (const s of f.strokes) for (const p of s.points) if (p.select) selected.push(p);
      }
    }
    if (selected.length) {
      const median = [0, 1, 2].map((i) => selected.reduce((a, p) => a + p.co[i], 0) / selected.length);
      body.push(el('h3', { text: `Median (${selected.length} pts)` }));
      body.push(this.vecRow('', () => median.map((v) => +v.toFixed(3)), (i, v) => {
        ctx.pushUndo();
        const d = v - median[i];
        for (const p of selected) p.co[i] += d;
        ctx.requestRender();
      }));
    }
    body.push(el('h3', { text: `Object: ${ob.name}` }));
    body.push(
      this.vecRow('Loc', () => ob.translation.map((v) => +v.toFixed(3)), (i, v) => { ob.translation[i] = v; ctx.requestRender(); }),
      this.vecRow('Rot', () => ob.rotation.map((v) => +v.toFixed(3)), (i, v) => { ob.rotation[i] = v; ctx.requestRender(); }),
      this.vecRow('Scale', () => ob.scale.map((v) => +v.toFixed(3)), (i, v) => { ob.scale[i] = v; ctx.requestRender(); }, 0.05),
    );

    // --- View ---
    body.push(el('h3', { text: 'View' }));
    const vp = ctx.camera.position;
    body.push(el('div', { class: 'row', text: `Viewport: ${vp.x.toFixed(2)}, ${vp.y.toFixed(2)}, ${vp.z.toFixed(2)}` }));
    body.push(el('h3', { text: `Camera: ${cam.name}` }));
    body.push(
      this.vecRow('Loc', () => cam.translation.map((v) => +v.toFixed(3)), (i, v) => { cam.translation[i] = v; ctx.requestRender(); }),
      this.vecRow('Rot', () => cam.rotation.map((v) => +v.toFixed(3)), (i, v) => { cam.rotation[i] = v; ctx.requestRender(); }),
      el('div', { class: 'row' },
        numField('FOV', +cam.fov.toFixed(1), (v) => { cam.fov = Math.min(140, Math.max(5, v)); ctx.requestRender(); }, 1),
      ),
    );

    // --- Cursor ---
    body.push(el('h3', { text: '3D Cursor' }));
    body.push(this.vecRow('', () => ctx.scene.cursor.map((v) => +v.toFixed(3)), (i, v) => {
      ctx.scene.cursor[i] = v;
      ctx.requestRender();
    }));

    this.inspectorEl.replaceChildren(...body);
  }

  // ------------------------------------------------------- command palette

  paletteOpen = false;

  openPalette(): void {
    if (this.paletteOpen) return;
    this.paletteOpen = true;
    const overlay = el('div', { id: 'palette-overlay' });
    const input = el('input', { type: 'text', placeholder: 'Type a command…  (Enter runs · Esc closes)' }) as HTMLInputElement;
    const list = el('div', { id: 'palette-list' });
    const box = el('div', { id: 'palette' }, input, list);
    overlay.append(box);
    document.body.append(overlay);

    let items: import('./commands').Command[] = [];
    let sel = 0;
    const renderList = () => {
      items = this.app.commands.search(input.value, 12);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      list.replaceChildren(...items.map((c, i) => {
        const row = el('div', { class: `menu-item ${i === sel ? 'palette-sel' : ''}` },
          el('span', { text: c.title }),
          el('span', { class: 'menu-key', text: c.key ?? '' }),
        );
        row.onclick = () => { close(); c.run(); };
        row.onmouseenter = () => { sel = i; renderList(); };
        return row;
      }));
      if (!items.length) list.replaceChildren(el('div', { class: 'menu-header', text: 'no matches' }));
    };
    const close = () => {
      this.paletteOpen = false;
      overlay.remove();
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); renderList(); }
      else if (e.key === 'Enter') {
        e.stopPropagation();
        const cmd = items[sel];
        close();
        cmd?.run();
      } else {
        e.stopPropagation(); // typing must not hit app shortcuts
      }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    input.oninput = () => { sel = 0; renderList(); };
    renderList();
    setTimeout(() => input.focus(), 0);
  }

  // ------------------------------------------------------------ settings

  settingsOpen = false;

  openSettings(): void {
    if (this.settingsOpen) return;
    this.settingsOpen = true;
    const { ctx } = this.app;
    const s = ctx.settings;

    const overlay = el('div', { id: 'settings-overlay' });
    const close = () => {
      this.settingsOpen = false;
      overlay.remove();
      window.removeEventListener('keydown', escClose, true);
      this.refresh();
    };
    const escClose = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !capturing) { e.stopPropagation(); close(); }
    };
    window.addEventListener('keydown', escClose, true);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    let capturing = false;

    const save = () => this.app.savePrefs();
    const prefs = el('div', { class: 'body' },
      el('div', { class: 'row' },
        selectField('World up', s.upAxis, [
          ['Z', 'Z-up, right-handed (Blender)'], ['Y', 'Y-up (three.js)'],
        ], (v) => { s.upAxis = v as 'Z' | 'Y'; this.app.applyUpAxis(true); }),
        checkbox('Show axes', s.showAxes, (v) => this.app.setShowAxes(v)),
      ),
      el('div', { class: 'row' },
        checkbox('Trackpad navigation (two-finger orbit, Shift pan, Ctrl zoom)', s.trackpadNav, (v) => this.app.setTrackpadNav(v)),
        checkbox('Invert orbit direction', s.invertTrackpadOrbit, (v) => { s.invertTrackpadOrbit = v; save(); }),
      ),
      el('div', { class: 'row' },
        checkbox('Emulate Numpad (digit-row view keys)', s.emulateNumpad, (v) => { s.emulateNumpad = v; save(); }),
      ),
      el('div', { class: 'row' },
        checkbox('Emulate 3-Button Mouse (Alt+LMB navigates)', s.emulate3Button, (v) => { s.emulate3Button = v; save(); }),
      ),
      el('div', { class: 'row' },
        numField('Grid step', s.gridStep, (v) => { s.gridStep = Math.max(0.01, v); save(); }),
        checkbox('Show transform gizmo', s.showGizmo, (v) => { s.showGizmo = v; this.app.refreshWidget(); save(); }),
      ),
      el('div', { class: 'row' },
        selectField('Snap to stroke scope (vertex/edge)', s.snap.strokeScope ?? 'ANY', [
          ['ANY', 'Any GP object'], ['SELECTED', 'Selected strokes only'],
        ], (v) => { s.snap.strokeScope = v as 'ANY' | 'SELECTED'; save(); }),
      ),
      el('div', { class: 'row' },
        colorField('Background', [...s.background, 1], (rgb) => { this.app.setBackground(rgb); save(); }),
        checkbox('Auto-key', s.autoKey, (v) => { s.autoKey = v; }),
      ),
      el('div', { class: 'menu-header', text: 'Theme' }),
      el('div', { class: 'row' },
        colorField('Accent', [...s.uiAccent, 1], (rgb) => { s.uiAccent = rgb; this.app.applyThemeColors(); save(); }),
        colorField('Highlight', [...s.uiHighlight, 1], (rgb) => {
          s.uiHighlight = rgb; this.app.applyThemeColors(); this.app.refreshWidget(); save();
        }),
      ),
      el('div', { class: 'row' },
        checkbox('Auto grid color (matches Background)', !s.gridColor, (v) => {
          s.gridColor = v ? null : [...s.background];
          this.app.rebuildGrid(); save(); this.refresh();
        }),
        ...(s.gridColor ? [colorField('Grid', [...s.gridColor, 1], (rgb) => {
          s.gridColor = rgb; this.app.rebuildGrid(); save();
        })] : []),
      ),
      el('div', { class: 'row', text: 'While Emulate Numpad is on, digit keys are view keys and mode shortcuts are shadowed (use the topbar or Tab).' }),
    );

    const shortcutRows = el('div', { class: 'body' });
    const rebuildShortcuts = () => {
      shortcutRows.replaceChildren();
      let lastCat = '';
      for (const a of ACTIONS) {
        if (a.category !== lastCat) {
          lastCat = a.category;
          shortcutRows.append(el('h3', { text: a.category }));
        }
        const combo = this.app.keymap.comboFor(a.id);
        const comboBtn = btn(combo || '(unbound)', () => {
          capturing = true;
          comboBtn.textContent = 'press a key…';
          comboBtn.classList.add('active');
          const capture = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { cleanup(); rebuildShortcuts(); return; }
            const c = comboFromEvent(e);
            if (!c) return; // modifier alone — keep waiting
            this.app.keymap.rebind(a.id, c);
            cleanup();
            rebuildShortcuts();
          };
          const cleanup = () => {
            capturing = false;
            window.removeEventListener('keydown', capture, true);
          };
          window.addEventListener('keydown', capture, true);
        }, { title: 'Click, then press the new shortcut (Esc cancels)' });
        shortcutRows.append(el('div', { class: 'row spread shortcut-row' },
          el('span', { text: a.label }), comboBtn,
        ));
      }
      shortcutRows.append(el('div', { class: 'row' },
        btn('Reset all to defaults', () => { this.app.keymap.reset(); rebuildShortcuts(); }),
      ));
    };
    rebuildShortcuts();

    const dialog = el('div', { id: 'settings-dialog' },
      el('div', { class: 'row spread' },
        el('h2', { text: 'Settings' }),
        btn(icon('xMark'), close, { cls: 'icon-btn' }),
      ),
      el('div', { class: 'panel' }, el('h3', { text: 'Preferences' }), prefs),
      el('div', { class: 'panel' }, el('h3', { text: 'Shortcuts (click a binding to change it)' }), shortcutRows),
    );
    overlay.append(dialog);
    document.body.append(overlay);
  }

  // --------------------------------------------------------------- score

  /** First selected stroke across visible editable layers, as a PathRef. */
  private selectedPathRef(): PathRef | null {
    const { ctx } = this.app;
    const obIndex = ctx.scene.activeObject;
    const ob = activeObject(ctx.scene);
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const f = frameAt(layer, ctx.scene.frame);
      if (!f) continue;
      for (const s of f.strokes) {
        if (s.select || s.points.some((p) => p.select)) {
          return { objectIndex: obIndex, layerId: layer.id, strokeId: s.id };
        }
      }
    }
    // fallback: last stroke of the active layer
    const layer = activeLayer(ob);
    const f = layer ? frameAt(layer, ctx.scene.frame) : null;
    const s = f?.strokes.at(-1);
    return layer && s ? { objectIndex: obIndex, layerId: layer.id, strokeId: s.id } : null;
  }

  /** N6: delete assets by picking from a list (minimal manager). */
  private manageAssets(): void {
    const assets = listAssets();
    if (!assets.length) return;
    const names = assets.map((a, i) => `${i + 1}. [${a.kind}] ${a.name}`).join('\n');
    const pick = prompt(`Delete which asset? (number, blank cancels)\n${names}`);
    const idx = Number(pick) - 1;
    if (Number.isInteger(idx) && assets[idx]) {
      deleteAsset(assets[idx].id);
      this.refresh();
    }
  }

  /** "Follow object" dropdown for triggers/attractors (N5). */
  private followField(get: () => import('../core/types').ParentRef | null | undefined,
    set: (v: import('../core/types').ParentRef | null) => void): HTMLElement {
    const { ctx } = this.app;
    const cur = get();
    const opts: [string, string][] = [['', '— fixed —']];
    for (const ob of ctx.scene.objects) opts.push([`GP:${ob.id}`, `GP: ${ob.name}`]);
    for (const m of ctx.scene.meshes) opts.push([`MESH:${m.id}`, `Mesh: ${m.name}`]);
    for (const sp of ctx.scene.splats) opts.push([`SPLAT:${sp.id}`, `Splat: ${sp.name}`]);
    return selectField('Follow', cur ? `${cur.kind}:${cur.id}` : '', opts, (v) => {
      if (!v) { set(null); return; }
      const [kind, id] = v.split(':');
      set({ kind: kind as 'GP' | 'MESH' | 'SPLAT', id: Number(id) });
    });
  }

  /**
   * Blender-style object target field: eyedropper (click, then click an
   * object in the viewport) + dropdown of candidates + editable name field
   * for manual entry. Used for constraint targets and any other
   * "pick an object" control.
   */
  private objectPickerField(
    label: string,
    get: () => ObjRef | null,
    set: (v: ObjRef | null) => void,
    exclude?: ObjRef,
  ): HTMLElement {
    const { ctx } = this.app;
    const candidates: { ref: ObjRef; label: string }[] = [
      ...ctx.scene.objects.map((o) => ({ ref: { kind: 'GP' as const, id: o.id }, label: `GP: ${o.name}` })),
      ...ctx.scene.meshes.map((m) => ({ ref: { kind: 'MESH' as const, id: m.id }, label: `Mesh: ${m.name}` })),
      ...ctx.scene.splats.map((s) => ({ ref: { kind: 'SPLAT' as const, id: s.id }, label: `Splat: ${s.name}` })),
      ...ctx.scene.score.triggers.map((t) => ({ ref: { kind: 'TRIGGER' as const, id: t.id }, label: `Trigger: ${t.name}` })),
    ].filter((c) => !exclude || c.ref.kind !== exclude.kind || c.ref.id !== exclude.id);

    const cur = get();

    const eyedrop = btn('◎', () => {
      this.app.pickObject((ref) => {
        if (ref && (!exclude || ref.kind !== exclude.kind || ref.id !== exclude.id)) set(ref);
        this.refresh();
      });
    }, { cls: 'icon-btn', title: 'Click, then click an object in the viewport to pick it (Esc cancels)' });

    const sel = el('select') as HTMLSelectElement;
    sel.append(el('option', { value: '', text: '— none —' }));
    for (const c of candidates) sel.append(el('option', { value: `${c.ref.kind}:${c.ref.id}`, text: c.label }));
    sel.value = cur ? `${cur.kind}:${cur.id}` : '';
    sel.onchange = () => {
      if (!sel.value) { set(null); this.refresh(); return; }
      const [kind, id] = sel.value.split(':');
      set({ kind: kind as ObjRef['kind'], id: Number(id) });
      this.refresh();
    };

    const name = el('input', {
      type: 'text', value: cur ? objectName(ctx.scene, cur) : '',
      placeholder: '(type a name)',
    }) as HTMLInputElement;
    const commitName = () => {
      const q = name.value.trim().toLowerCase();
      if (!q) { set(null); this.refresh(); return; }
      const match = candidates.find((c) => c.label.split(': ').pop()!.toLowerCase() === q);
      if (match) { set(match.ref); this.refresh(); }
      else name.value = cur ? objectName(ctx.scene, cur) : ''; // no match: revert
    };
    name.onchange = commitName;
    name.onkeydown = (e) => { if (e.key === 'Enter') name.blur(); };

    return el('div', { class: 'row' }, label, eyedrop, sel, name);
  }

  private msgEditor(messages: { address: string; argExprs: string[] }[]): HTMLElement {
    const { ctx } = this.app;
    const m = messages[0];
    const addr = el('input', { type: 'text', value: m?.address ?? '' }) as HTMLInputElement;
    addr.style.width = '120px';
    addr.onchange = () => { if (m) m.address = addr.value; };
    const args = el('input', {
      type: 'text', value: m?.argExprs.join(' ') ?? '',
      title: 'space-separated; {x} {y} {z} {t} {id} {name} substitute',
    }) as HTMLInputElement;
    args.style.width = '90px';
    args.onchange = () => { if (m) m.argExprs = args.value.split(/\s+/).filter(Boolean); };
    void ctx;
    return el('div', { class: 'row' }, '→', addr, args);
  }

  private scorePanel(): HTMLElement {
    const { ctx } = this.app;
    const sc = ctx.scene.score;
    const items: Node[] = [];

    for (const cur of sc.cursors) {
      const body = el('div', { class: 'body' },
        el('div', { class: 'row' },
          btn(cur.running ? icon('pause') : icon('play'), () => { cur.running = !cur.running; this.refresh(); }, { cls: 'icon-btn', active: cur.running }),
          el('span', { class: 'grow', text: cur.name }),
          btn(icon('xMark'), () => { ctx.pushUndo(); sc.cursors.splice(sc.cursors.indexOf(cur), 1); this.refresh(); }, { cls: 'icon-btn' }),
        ),
        el('div', { class: 'row' },
          numField('Speed', cur.speed, (v) => { cur.speed = v; }, 0.05),
          numField('Rate', cur.rate, (v) => { cur.rate = Math.max(1, Math.round(v)); }, 1),
          selectField('', cur.loop, [['LOOP', 'Loop'], ['PINGPONG', 'Ping-pong'], ['ONCE', 'Once']], (v) => { cur.loop = v as typeof cur.loop; }),
        ),
        this.msgEditor(cur.messages),
      );
      items.push(el('div', { class: 'panel' }, el('h3', { text: `Traveler: ${cur.name}` }), body));
    }

    for (const trig of sc.triggers) {
      const body = el('div', { class: 'body' },
        el('div', { class: 'row' },
          numField('Radius', trig.radius, (v) => { trig.radius = Math.max(0.01, v); }, 0.05),
          checkbox('Retrigger', trig.retrigger, (v) => { trig.retrigger = v; }),
          this.followField(() => trig.follow, (v) => { trig.follow = v; }),
          btn(icon('xMark'), () => { ctx.pushUndo(); sc.triggers.splice(sc.triggers.indexOf(trig), 1); this.refresh(); }, { cls: 'icon-btn' }),
        ),
        this.msgEditor(trig.messages),
      );
      items.push(el('div', { class: 'panel' },
        el('h3', { text: `◎ ${trig.name}${trig.zone ? ' (stroke zone)' : ''}` }), body));
    }

    for (const at of sc.attachments) {
      const body = el('div', { class: 'body' },
        el('div', { class: 'row' },
          btn(at.running ? icon('pause') : icon('play'), () => { at.running = !at.running; this.refresh(); }, { cls: 'icon-btn', active: at.running }),
          numField('Speed', at.speed, (v) => { at.speed = v; }, 0.05),
          selectField('', at.loop, [['LOOP', 'Loop'], ['PINGPONG', 'Ping-pong'], ['ONCE', 'Once']], (v) => { at.loop = v as typeof at.loop; }),
          checkbox('Tangent', at.orient === 'TANGENT', (v) => { at.orient = v ? 'TANGENT' : 'NONE'; }),
          btn(icon('xMark'), () => { ctx.pushUndo(); sc.attachments.splice(sc.attachments.indexOf(at), 1); this.refresh(); }, { cls: 'icon-btn' }),
        ),
      );
      items.push(el('div', { class: 'panel' },
        el('h3', { text: `${at.target.kind === 'CANVAS' ? 'Canvas' : 'Camera'} → path` }), body));
    }

    const attachTarget = el('select') as HTMLSelectElement;
    for (const m of ctx.scene.meshes) attachTarget.append(el('option', { value: `MESH:${m.id}`, text: `Mesh: ${m.name}` }));
    ctx.scene.cameras.forEach((cam, i) => attachTarget.append(el('option', { value: `CAMERA:${i}`, text: `Camera: ${cam.name}` })));
    for (const s of ctx.scene.splats) attachTarget.append(el('option', { value: `SPLAT:${s.id}`, text: `Splat: ${s.name}` }));

    return panel('Score (travelers · triggers · paths)',
      el('div', { class: 'row' },
        btn('＋Traveler on stroke', () => {
          const path = this.selectedPathRef();
          if (!path) return;
          ctx.pushUndo();
          sc.cursors.push(defaultCursor(ctx.scene, path));
          this.refresh();
        }, { title: 'Attach a traveler (playhead) to the selected (or last) stroke' }),
        btn('＋Trigger at cursor', () => {
          ctx.pushUndo();
          const id = scoreId(ctx.scene);
          sc.triggers.push({
            id, name: `Trigger ${id}`, position: [...ctx.scene.cursor] as [number, number, number],
            radius: 0.25, retrigger: true,
            messages: [{ address: '/trigger/{id}', argExprs: ['1'] }],
          });
          this.refresh();
        }, { title: 'Place a trigger sphere at the 3D cursor' }),
      ),
      el('div', { class: 'row' },
        attachTarget,
        btn('＋Attach to stroke', () => {
          const path = this.selectedPathRef();
          const val = attachTarget.value;
          if (!path || !val) return;
          const [kind, idStr] = val.split(':');
          ctx.pushUndo();
          sc.attachments.push({
            id: scoreId(ctx.scene),
            target: { kind: kind as 'CANVAS' | 'CAMERA' | 'SPLAT' | 'MESH', id: Number(idStr) },
            path, speed: 0.1, phase: 0, loop: 'LOOP', running: true,
            orient: 'TANGENT', offset: [0, 0, 0],
          });
          this.refresh();
        }, { title: 'Ride the selected object along the selected stroke' }),
      ),
      ...items,
    );
  }

  // --------------------------------------------------------------- splats

  private splatsPanel(): HTMLElement {
    const { ctx } = this.app;

    const urlInput = el('input', { type: 'text', placeholder: 'https://…/scan.spz | .ply | .splat' }) as HTMLInputElement;
    urlInput.style.width = '150px';
    const addSplat = (src: string, name: string) => {
      ctx.pushUndo();
      ctx.scene.splats.push({
        id: scoreId(ctx.scene), name, src,
        translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true, select: false,
      });
      this.refresh();
    };
    const fileInput = el('input', { type: 'file', accept: '.spz,.ply,.splat,.ksplat,.sog' }) as HTMLInputElement;
    fileInput.style.display = 'none';
    fileInput.onchange = () => {
      const f = fileInput.files?.[0];
      if (f) addSplat(URL.createObjectURL(f), `${f.name} (session only)`);
    };

    const items: Node[] = ctx.scene.splats.map((s) => {
      const err = this.app.splats.errors.get(s.id);
      const body = el('div', { class: 'body' },
        el('div', { class: 'row' },
          checkbox('', s.visible, (v) => { s.visible = v; }),
          el('span', { class: 'grow', text: s.name }),
          btn(icon('xMark'), () => {
            ctx.pushUndo();
            ctx.scene.splats.splice(ctx.scene.splats.indexOf(s), 1);
            this.refresh();
          }, { cls: 'icon-btn' }),
        ),
        el('div', { class: 'row' }, 'Pos',
          ...[0, 1, 2].map((i) => numField('', s.translation[i], (v) => { s.translation[i] = v; })),
        ),
        el('div', { class: 'row' }, 'Rot',
          ...[0, 1, 2].map((i) => numField('', s.rotation[i], (v) => { s.rotation[i] = v; })),
        ),
        el('div', { class: 'row' },
          numField('Scale', s.scale, (v) => { s.scale = Math.max(0.001, v); }, 0.1),
          ...(err ? [el('span', { text: `! ${err.slice(0, 60)}` })] : []),
        ),
      );
      return el('div', { class: 'panel' }, el('h3', { text: s.name }), body);
    });

    return panel('Gaussian Splats',
      fileInput,
      el('div', { class: 'row' },
        urlInput,
        btn('＋URL', () => { if (urlInput.value.trim()) addSplat(urlInput.value.trim(), urlInput.value.split('/').pop() ?? 'splat'); }),
        btn('＋File', () => fileInput.click(), { title: 'Local file — not saved with the scene' }),
      ),
      ...items,
    );
  }

  // -------------------------------------------------------------- solvers

  private saTarget: { gray: Float32Array; width: number; height: number } | null = null;
  private saTargetName = '';
  private saOpts = { ...DEFAULT_STRINGART };
  private saRun: StringArtRun | null = null;
  private saStatus = '';
  private waStatus = '';

  private solverPanel(): HTMLElement {
    const { ctx } = this.app;
    const sim = this.app.sim;

    const fileInput = el('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    fileInput.style.display = 'none';
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      this.saTarget = await loadTargetImage(file, this.saOpts.imageSize);
      this.saTargetName = file.name;
      this.refresh();
    };

    const source = pinSourceStroke(ctx);
    const stringArt = el('div', { class: 'body' },
      fileInput,
      el('div', { class: 'row' },
        btn(this.saTargetName ? iconLabel('photo', this.saTargetName) : 'Load target image…',
          () => fileInput.click()),
      ),
      el('div', { class: 'row' },
        numField('Pins', this.saOpts.pinCount, (v) => { this.saOpts.pinCount = Math.max(8, Math.round(v)); }, 1),
        numField('Chords', this.saOpts.maxChords, (v) => { this.saOpts.maxChords = Math.max(10, Math.round(v)); }, 10),
        numField('Opacity', this.saOpts.opacity, (v) => { this.saOpts.opacity = Math.min(1, Math.max(0.02, v)); }, 0.01),
      ),
      el('div', { class: 'row' },
        this.saRun
          ? btn('Cancel', () => { this.saRun?.cancel(); this.saRun = null; this.refresh(); })
          : btn('Run string art', () => {
            if (!this.saTarget) { this.saStatus = 'load a target image first'; this.refresh(); return; }
            if (!pinSourceStroke(ctx)) { this.saStatus = 'draw/select a frame stroke first'; this.refresh(); return; }
            this.saStatus = 'solving…';
            this.saRun = runStringArt(ctx, this.saTarget, this.saOpts,
              (done) => {
                this.saStatus = `solving… ${done} chords`;
                const s = document.getElementById('sa-status');
                if (s) s.textContent = this.saStatus;
              },
              (chords) => {
                this.saRun = null;
                this.saStatus = `done: ${chords} chords → layer "StringArt"`;
                this.refresh();
              });
            this.refresh();
          }, { title: 'Pins ride the selected (or last) stroke; result becomes strokes' }),
        el('span', { id: 'sa-status', text: this.saStatus || (source ? `pins on stroke #${source.id}` : 'no source stroke') }),
      ),
    );

    const attractorItems: Node[] = ctx.scene.attractors.map((at) => el('div', { class: 'row' },
      el('span', { text: at.name }),
      numField('str', at.strength, (v) => { at.strength = v; }, 0.1),
      numField('rad', at.radius, (v) => { at.radius = Math.max(0.01, v); }, 0.1),
      this.followField(() => at.follow, (v) => { at.follow = v; }),
      btn(icon('target'), () => { at.position = [...ctx.scene.cursor] as [number, number, number]; }, { cls: 'icon-btn', title: 'Move to 3D cursor' }),
      btn(icon('xMark'), () => {
        ctx.pushUndo();
        ctx.scene.attractors.splice(ctx.scene.attractors.indexOf(at), 1);
        this.refresh();
      }, { cls: 'icon-btn' }),
    ));

    // --- multi-view wire art ---
    const waStatus = el('span', { id: 'wa-status', text: this.waStatus });
    const camTargets: Node[] = ctx.scene.cameras.map((cam, i) => {
      const file = el('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
      file.style.display = 'none';
      file.onchange = () => {
        const f = file.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          cam.target = String(reader.result);
          cam.targetOpacity ??= 0.35;
          this.refresh();
        };
        reader.readAsDataURL(f);
      };
      return el('div', { class: 'row' },
        file,
        el('span', { class: 'grow', text: cam.name }),
        btn(cam.target ? iconLabel('photo', 'set') : 'target…', () => file.click(),
          { active: !!cam.target, title: 'Target drawing seen from this camera' }),
        ...(cam.target ? [
          slider('', cam.targetOpacity ?? 0.35, 0, 1, 0.05, (v) => { cam.targetOpacity = v; }),
          btn(icon('xMark'), () => { delete cam.target; this.refresh(); }, { cls: 'icon-btn' }),
        ] : []),
      );
    });
    const wireArt = el('div', { class: 'body' },
      ...camTargets,
      el('div', { class: 'row' },
        btn('Solve wire (2+ cams)', async () => {
          this.waStatus = 'solving…';
          this.refresh();
          const res = await runWireArt(ctx, DEFAULT_WIREART, (n) => {
            const s = document.getElementById('wa-status');
            if (s) s.textContent = `solving… ${n} voxels`;
          });
          this.waStatus = 'error' in res ? res.error : `wire: ${res.points} pts (hull ${res.hull})`;
          this.refresh();
        }, { title: 'One 3D wire matching the camera target drawings' }),
        waStatus,
      ),
      el('div', { class: 'row', text: 'Assist: in camera view (0) the target shows as an overlay — trace it, switch cameras, connect in 3D.' }),
    );

    return panel('Solvers (string art · wire art · attractors)',
      el('div', { class: 'panel' }, el('h3', { text: 'String art' }), stringArt),
      el('div', { class: 'panel' }, el('h3', { text: 'Multi-view wire art' }), wireArt),
      el('div', { class: 'body' },
        el('div', { class: 'row' },
          btn('＋Attractor at cursor', () => {
            ctx.pushUndo();
            const id = scoreId(ctx.scene);
            ctx.scene.attractors.push({
              id, name: `Attractor ${id}`,
              position: [...ctx.scene.cursor] as [number, number, number],
              strength: 1.5, radius: 1.5,
            });
            this.refresh();
          }),
          checkbox('Simulate strings', sim.enabled, (v) => { sim.enabled = v; if (v) sim.reset(); }),
        ),
        ...attractorItems,
        el('div', { class: 'row' },
          slider('Damping', sim.damping, 0.8, 0.999, 0.001, (v) => { sim.damping = v; }),
          slider('Stiffness', sim.stiffness, 0, 0.2, 0.005, (v) => { sim.stiffness = v; }),
        ),
      ),
    );
  }

  // --------------------------------------------------------------- routes

  private routesPanel(): HTMLElement {
    const { ctx } = this.app;
    const items: Node[] = [];

    for (const route of ctx.scene.routes) {
      const addr = el('input', { type: 'text', value: route.match.address }) as HTMLInputElement;
      addr.style.width = '110px';
      addr.onchange = () => { route.match.address = addr.value.trim(); };

      const target = el('input', { type: 'text', value: route.target, list: 'route-targets' }) as HTMLInputElement;
      target.style.width = '120px';
      target.onchange = () => { route.target = target.value.trim(); route.enabled = true; };

      const learning = routes.learningRouteId === route.id;
      const body = el('div', { class: 'body' },
        el('div', { class: 'row' },
          checkbox('', route.enabled, (v) => { route.enabled = v; }),
          selectField('', route.match.source, [['ANY', 'Any'], ['MIDI', 'MIDI'], ['WS', 'WS/OSC']],
            (v) => { route.match.source = v as typeof route.match.source; }),
          addr,
          btn(learning ? '…' : 'Learn', () => {
            routes.learningRouteId = learning ? null : route.id;
            this.refresh();
          }, { active: learning, title: 'Click, then move a controller / send an event' }),
          btn(icon('xMark'), () => { ctx.pushUndo(); ctx.scene.routes.splice(ctx.scene.routes.indexOf(route), 1); this.refresh(); }, { cls: 'icon-btn' }),
        ),
        el('div', { class: 'row' }, '→', target),
        el('div', { class: 'row' },
          numField('in', route.mapping.inMin, (v) => { route.mapping.inMin = v; }, 1),
          numField('', route.mapping.inMax, (v) => { route.mapping.inMax = v; }, 1),
          numField('out', route.mapping.outMin, (v) => { route.mapping.outMin = v; }),
          numField('', route.mapping.outMax, (v) => { route.mapping.outMax = v; }),
          selectField('', route.mapping.mode, [['SCALE', 'Scale'], ['CLAMP', 'Clamp'], ['WRAP', 'Wrap'], ['RAW', 'Raw']],
            (v) => { route.mapping.mode = v as typeof route.mapping.mode; }),
        ),
      );
      items.push(el('div', { class: 'panel' },
        el('h3', { text: `⇄ ${route.match.address} → ${route.target}` }), body));
    }

    const datalist = el('datalist', { id: 'route-targets' });
    for (const t of TARGET_SUGGESTIONS) datalist.append(el('option', { value: t }));

    return panel('Routes (events → properties)',
      datalist,
      el('div', { class: 'row' },
        btn('＋Route', () => {
          ctx.pushUndo();
          ctx.scene.routes.push(createRoute(scoreId(ctx.scene)));
          this.refresh();
        }),
        el('span', { text: 'Learn: click, then wiggle a controller' }),
      ),
      ...items,
    );
  }

  // ---------------------------------------------------------- events / IO

  private monitorPaused = false;

  /** Blender-style constraint stack for the selected object. */
  private constraintsPanel(): HTMLElement {
    const { ctx } = this.app;
    const refs = listSelectedObjects(ctx.scene);
    if (refs.length !== 1) {
      return panel('Constraints', el('div', {
        class: 'row',
        text: refs.length === 0 ? 'select one object (object mode)' : 'select exactly one object',
      }));
    }
    const ref = refs[0];
    const entity = (
      ref.kind === 'GP' ? ctx.scene.objects.find((o) => o.id === ref.id) :
      ref.kind === 'MESH' ? ctx.scene.meshes.find((m) => m.id === ref.id) :
      ref.kind === 'SPLAT' ? ctx.scene.splats.find((s) => s.id === ref.id) :
      ref.kind === 'TRIGGER' ? ctx.scene.score.triggers.find((t) => t.id === ref.id) :
      undefined
    ) as { constraints?: TGConstraint[] } | undefined;
    if (!entity) return panel('Constraints', el('div', { class: 'row', text: 'unsupported object' }));
    entity.constraints ??= [];
    const stack = entity.constraints;

    // grouped Add dropdown (Blender's Add Object Constraint)
    const addSel = el('select') as HTMLSelectElement;
    addSel.append(el('option', { value: '', text: 'Add Object Constraint…' }));
    const groups = new Map<string, [string, string][]>();
    for (const [type, def] of Object.entries(CONSTRAINT_DEFS)) {
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group)!.push([type, def.label]);
    }
    for (const [group, items] of groups) {
      const og = document.createElement('optgroup');
      og.label = group;
      for (const [type, label] of items) og.append(el('option', { value: type, text: label }));
      addSel.append(og);
    }
    addSel.onchange = () => {
      if (!addSel.value) return;
      ctx.pushUndo();
      stack.push(createConstraint(addSel.value as ConstraintType));
      this.refresh();
    };

    const targetField = (c: TGConstraint) => this.objectPickerField('Target',
      () => c.target ?? null,
      (v) => { c.target = v as TGConstraint['target']; },
      ref);

    const items: Node[] = [];
    stack.forEach((c, i) => {
      const rows: Node[] = [
        el('div', { class: 'row' },
          checkbox('', c.enabled, (v) => { c.enabled = v; }),
          el('span', { class: 'grow', text: CONSTRAINT_DEFS[c.type].label }),
          btn(icon('chevronUp'), () => { if (i > 0) { [stack[i - 1], stack[i]] = [stack[i], stack[i - 1]]; this.refresh(); } }, { cls: 'icon-btn' }),
          btn(icon('chevronDown'), () => { if (i < stack.length - 1) { [stack[i + 1], stack[i]] = [stack[i], stack[i + 1]]; this.refresh(); } }, { cls: 'icon-btn' }),
          btn(icon('xMark'), () => { ctx.pushUndo(); stack.splice(i, 1); this.refresh(); }, { cls: 'icon-btn' }),
        ),
      ];
      if (c.type === 'FOLLOW_PATH') {
        rows.push(
          el('div', { class: 'row' },
            btn(c.path ? `path: stroke #${c.path.strokeId}` : 'Use selected stroke', () => {
              const path = this.selectedPathRef();
              if (path) { c.path = path; this.refresh(); }
              else alert('Select a stroke first (EDIT mode), or draw one — the last stroke is used');
            }, { title: 'Bind to the selected (or last) GP stroke' }),
            btn(c.running ? icon('pause') : icon('play'), () => { c.running = !c.running; this.refresh(); }, { cls: 'icon-btn', active: c.running }),
          ),
          el('div', { class: 'row' },
            slider('Phase', c.phase ?? 0, 0, 1, 0.001, (v) => { c.phase = v; }),
          ),
          el('div', { class: 'row' },
            numField('Speed', c.speed ?? 0.2, (v) => { c.speed = v; }, 0.05),
            selectField('', c.loop ?? 'LOOP', [['LOOP', 'Loop'], ['PINGPONG', 'Ping-pong'], ['ONCE', 'Once']], (v) => { c.loop = v as typeof c.loop; }),
            checkbox('Orient', !!c.orient, (v) => { c.orient = v; }),
          ),
        );
      } else if (c.type === 'TRIGGER') {
        rows.push(
          el('div', { class: 'row' },
            numField('Radius', c.radius ?? 0.25, (v) => { c.radius = Math.max(0.01, v); }, 0.05),
            checkbox('Retrigger', c.retrigger !== false, (v) => { c.retrigger = v; }),
          ),
          this.msgEditor(c.messages ??= []),
        );
      } else if (c.type === 'LIMIT_DISTANCE') {
        rows.push(targetField(c), el('div', { class: 'row' },
          numField('Distance', c.distance ?? 1, (v) => { c.distance = Math.max(0.001, v); }, 0.1)));
      } else if (c.type === 'SPRING') {
        rows.push(targetField(c), el('div', { class: 'row' },
          numField('Stiffness', c.stiffness ?? 12, (v) => { c.stiffness = Math.max(0, v); }, 1),
          numField('Damping', c.damping ?? 4, (v) => { c.damping = Math.max(0, v); }, 0.5)));
      } else if (c.type === 'SHRINKWRAP' || c.type === 'FLOOR') {
        rows.push(el('div', { class: 'row' },
          numField('Offset', c.offset ?? 0, (v) => { c.offset = v; }, 0.05)));
      } else {
        rows.push(targetField(c));
      }
      if (c.type !== 'TRIGGER' && c.type !== 'FLOOR' && c.type !== 'SHRINKWRAP') {
        rows.push(el('div', { class: 'row' },
          slider('Influence', c.influence, 0, 1, 0.01, (v) => { c.influence = v; })));
      }
      items.push(el('div', { class: 'panel' },
        el('h3', { text: `${c.enabled ? '' : '· '}${c.name}` }),
        el('div', { class: 'body' }, ...rows)));
    });

    return panel(`Constraints — ${objectName(ctx.scene, ref)}`,
      addSel,
      ...(items.length ? items : [el('div', { class: 'row', text: 'no constraints — Follow Path makes this a traveler, Trigger makes it a proximity zone' })]),
    );
  }

  /** MediaMime (P11): live landmark addresses + the object-rigging table. */
  /** Native MediaMime: in-app webcam capture -> landmark streams rendered
   *  as confidence-encoded splat sprites. */
  private mmStreamsPanel(): HTMLElement {
    const { ctx } = this.app;
    const streams = ctx.scene.mmStreams;

    const capLabel = mmCapture.status === 'on' ? 'Stop camera'
      : mmCapture.status === 'starting' ? 'Starting…'
      : mmCapture.status === 'error' ? 'Retry camera' : 'Start camera';
    const capRow = el('div', { class: 'row' },
      btn(iconLabel('camera', capLabel), () => this.app.mmCaptureToggle(),
        { active: mmCapture.status === 'on', title: 'Webcam capture (MediaPipe, in-app — no bridge)' }),
      btn('＋Pose', () => this.app.addMMStreams(['POSE'], 'CAMERA'), { title: 'Body stream (33 points)' }),
      btn('＋Hands', () => this.app.addMMStreams(['HAND_LEFT', 'HAND_RIGHT'], 'CAMERA'), { title: 'Left + right hand streams (21 points each)' }),
    );

    const busInput = el('input', { type: 'text', placeholder: '/mm/pose', value: '' }) as HTMLInputElement;
    const busRow = el('div', { class: 'row' },
      busInput,
      btn('＋Bus stream', () => {
        const addr = busInput.value.trim();
        if (addr) this.app.addMMStreams(['CUSTOM'], 'BUS', addr);
      }, { title: 'Point stream fed from bus events <address>/<index> (x, y[, z[, confidence]])' }),
    );

    const rows: Node[] = streams.flatMap((st) => {
      const frame = streamStore.get(st.id);
      return [
        el('div', { class: 'row' },
          btn(st.visible ? icon('eye') : icon('eyeOff'), () => { st.visible = !st.visible; this.refresh(); }, { cls: 'icon-btn' }),
          colorField('', [...st.color, 1], (rgb) => { st.color = rgb; }),
          el('span', { class: 'grow', text: `${st.name}${st.source === 'BUS' ? ` ← ${st.busAddress}` : ''}` }),
          el('span', { text: frame?.count ? `${frame.count} pts` : '—' }),
          btn(icon('xMark'), () => this.app.deleteMMStream(st.id), { cls: 'icon-btn', title: 'Delete stream' }),
        ),
        el('div', { class: 'row' },
          numField('size', st.pointSize, (v) => { st.pointSize = Math.max(0.001, v); }, 0.01),
          checkbox('conf→α', st.confidenceAlpha, (v) => { st.confidenceAlpha = v; }),
          checkbox('conf→size', st.confidenceSize, (v) => { st.confidenceSize = v; }),
          checkbox('mirror', st.mirror, (v) => { st.mirror = v; }),
          ...(st.source === 'CAMERA' ? [checkbox('emit bus', st.emitBus, (v) => { st.emitBus = v; })] : []),
        ),
      ];
    });

    return panel('Streams — native capture',
      capRow,
      ...(mmCapture.status === 'error' ? [el('div', { class: 'row', text: `! ${mmCapture.error.slice(0, 90)}` })] : []),
      ...(mmCapture.status === 'on' || mmCapture.status === 'starting' ? [mmCapture.video] : []),
      busRow,
      ...(rows.length ? rows : [el('div', { class: 'row', text: 'no streams yet — add Pose/Hands then Start camera, or feed one from the bus' })]),
      el('div', { class: 'row', text: 'camera streams re-emit world-space landmarks on the bus (prefix below), so rigs/routes/triggers can ride them' }),
    );
  }

  private mediamimePanel(): HTMLElement {
    const { ctx } = this.app;
    const mm = ctx.scene.mediamime;

    const prefixInput = el('input', { type: 'text', value: mm.prefix, placeholder: '/mm' }) as HTMLInputElement;
    prefixInput.onchange = () => { mm.prefix = prefixInput.value.trim() || '/mm'; };

    const rigTargets: { label: string; ref: import('../tools/objects').ObjRef }[] = [
      ...ctx.scene.objects.map((o) => ({ label: `GP: ${o.name}`, ref: { kind: 'GP' as const, id: o.id } })),
      ...ctx.scene.meshes.map((m) => ({ label: `Mesh: ${m.name}`, ref: { kind: 'MESH' as const, id: m.id } })),
      ...ctx.scene.splats.map((s) => ({ label: `Splat: ${s.name}`, ref: { kind: 'SPLAT' as const, id: s.id } })),
      ...ctx.scene.score.triggers.map((t) => ({ label: `Trigger: ${t.name}`, ref: { kind: 'TRIGGER' as const, id: t.id } })),
    ];

    const live = mediamime.list();
    const liveRows: Node[] = live.length
      ? live.map((l) => {
          const targetSel = el('select') as HTMLSelectElement;
          rigTargets.forEach((t, i) => targetSel.append(el('option', { value: String(i), text: t.label })));
          return el('div', { class: 'row' },
            el('span', { class: 'grow', text: `${l.address}  (${l.pos.map((n) => n.toFixed(2)).join(', ')})` }),
            btn('＋Trigger', () => this.app.addMediaMimeTrigger(l.address, l.pos), { cls: 'icon-btn', title: 'Spawn a trigger primitive rigged to this address' }),
            ...(rigTargets.length ? [
              targetSel,
              btn('Attach', () => this.app.addMediaMimeRig(l.address, rigTargets[Number(targetSel.value)].ref), { cls: 'icon-btn', title: 'Rig the selected object to this address' }),
            ] : []),
          );
        })
      : [el('div', { class: 'row', text: 'no landmarks seen yet — connect the WS bridge below and point mediamime (or any sender) at this prefix' })];

    const rigRows: Node[] = mm.rigs.map((rig) => el('div', { class: 'row' },
      checkbox('', rig.enabled, (v) => { rig.enabled = v; }),
      el('span', { class: 'grow', text: rig.name }),
      numField('scale', rig.scale, (v) => { rig.scale = v; }, 0.05),
      btn(icon('xMark'), () => this.app.deleteMediaMimeRig(rig.id), { cls: 'icon-btn' }),
    ));

    return panel('MediaMime — landmarks & rigs',
      el('div', { class: 'row' }, 'Address prefix', prefixInput,
        el('span', { class: 'row', text: '· uses the WS bridge below (IO panel)' })),
      el('div', { class: 'menu-header', text: 'Live addresses' }),
      ...liveRows,
      el('div', { class: 'menu-header', text: 'Rigs (object ← address)' }),
      ...(rigRows.length ? rigRows : [el('div', { class: 'row', text: 'none yet' })]),
    );
  }

  private ioPanel(): HTMLElement {
    const { ctx } = this.app;
    const io = ctx.scene.io;

    const urlInput = el('input', { type: 'text', value: io.wsUrl, placeholder: 'ws://localhost:8765' }) as HTMLInputElement;
    urlInput.style.width = '150px';
    urlInput.onchange = () => { io.wsUrl = urlInput.value.trim(); };
    const wsRow = el('div', { class: 'row' },
      'WS', urlInput,
      btn(wsLink.status === 'open' ? '● on' : wsLink.status === 'connecting' ? '… ' : 'Connect',
        () => {
          io.wsUrl = urlInput.value.trim();
          if (wsLink.status === 'off' && io.wsUrl) wsLink.connect(io.wsUrl);
          else wsLink.disconnect();
          this.refresh();
        },
        { active: wsLink.status === 'open', title: 'Connect/disconnect the bridge (see bridge/README.md)' }),
    );

    const midiRows: Node[] = [];
    if (midi.available) {
      const mkSel = (ports: { id: string; name: string }[], cur: string | null, onPick: (id: string | null) => void) => {
        const sel = el('select') as HTMLSelectElement;
        sel.append(el('option', { value: '', text: '(all/default)' }));
        for (const p of ports) sel.append(el('option', { value: p.id, text: p.name }));
        sel.value = cur ?? '';
        sel.onchange = () => onPick(sel.value || null);
        return sel;
      };
      midiRows.push(
        el('div', { class: 'row' }, 'MIDI in', mkSel(midi.inputs, midi.inputId, (id) => { midi.setInput(id); io.midiInId = id; })),
        el('div', { class: 'row' }, 'MIDI out', mkSel(midi.outputs, midi.outputId, (id) => { midi.setOutput(id); io.midiOutId = id; })),
      );
    } else {
      midiRows.push(el('div', { class: 'row', text: 'Web MIDI unavailable in this browser' }));
    }

    const monitor = el('div', { id: 'event-monitor' });
    return panel('Events / IO',
      wsRow, ...midiRows,
      el('div', { class: 'row' },
        btn(this.monitorPaused ? iconLabel('play', 'monitor') : iconLabel('pause', 'monitor'), () => { this.monitorPaused = !this.monitorPaused; this.refresh(); }),
        btn('test', () => bus.send('ui', '/ws/test', 1, 'hello'), { title: 'Emit a test event' }),
      ),
      monitor,
    );
  }

  /** Called on the shared 300ms UI tick. */
  refreshMonitor(): void {
    if (this.monitorPaused) return;
    const elMon = document.getElementById('event-monitor');
    if (!elMon) return;
    const rows = bus.history(10).map((e) =>
      `${(e.time / 1000).toFixed(1)} ${e.source} ${e.address} ${e.args.map((a) => typeof a === 'number' ? +a.toFixed(3) : a).join(' ')}`);
    elMon.textContent = rows.join('\n') || '(no events yet)';
  }

  // ------------------------------------------------------------ timeline

  private buildTimelineShell(): void {
    const tl = $('timeline');
    tl.replaceChildren();
    const controls = el('div', { class: 'tl-controls', id: 'tl-controls' });
    const strip = el('div', { id: 'timeline-strip' });
    strip.append(this.tlCanvas);
    strip.onpointerdown = (e) => this.timelinePointer(e, strip);
    strip.onpointermove = (e) => { if (e.buttons & 1) this.timelinePointer(e, strip); };
    tl.append(controls, strip);
  }

  private timelinePointer(e: PointerEvent, strip: HTMLElement): void {
    const { ctx } = this.app;
    const rect = strip.getBoundingClientRect();
    const t = (e.clientX - rect.left) / rect.width;
    const frame = Math.round(ctx.scene.frameStart + t * (ctx.scene.frameEnd - ctx.scene.frameStart));
    if (e.shiftKey && e.type === 'pointerdown') {
      // toggle keyframe selection (multiframe editing)
      const layer = activeLayer(activeObject(ctx.scene));
      if (layer) {
        let best: { d: number; f: typeof layer.frames[number] } | null = null;
        for (const f of layer.frames) {
          const d = Math.abs(f.frameNumber - frame);
          if (!best || d < best.d) best = { d, f };
        }
        if (best && best.d < 5) best.f.select = !best.f.select;
      }
    } else {
      ctx.scene.frame = Math.max(ctx.scene.frameStart, Math.min(ctx.scene.frameEnd, frame));
    }
    ctx.requestRender();
    this.drawTimeline();
    this.refreshTimelineControls();
  }

  refreshTimelineControls(): void {
    const { ctx } = this.app;
    const s = ctx.scene;
    const controls = $('tl-controls');
    controls.replaceChildren(
      btn(icon('skipBack'), () => { s.frame = s.frameStart; ctx.requestRender(); this.drawTimeline(); }, { cls: 'tl-transport', title: 'Jump to start' }),
      btn(icon('chevronsLeft'), () => this.app.jumpKey(-1), { cls: 'tl-transport', title: 'Previous keyframe (Down)' }),
      btn(this.app.isPlaying() ? icon('pause') : icon('play'), () => { this.app.playToggle(); this.refreshTimelineControls(); },
        { cls: 'tl-transport', title: this.app.isPlaying() ? 'Pause (Space)' : 'Play (Space)' }),
      btn(icon('chevronsRight'), () => this.app.jumpKey(1), { cls: 'tl-transport', title: 'Next keyframe (Up)' }),
      el('span', { text: String(s.frame), title: 'Current frame' }),
      el('div', { class: 'sep' }),
      numField('Start', s.frameStart, (v) => { s.frameStart = Math.round(v); this.drawTimeline(); }, 1),
      numField('End', s.frameEnd, (v) => { s.frameEnd = Math.round(v); this.drawTimeline(); }, 1),
      numField('FPS', s.fps, (v) => { s.fps = Math.max(1, Math.round(v)); }, 1),
      el('div', { class: 'sep' }),
      btn(icon('key'), () => this.app.addKeyframe(false), { cls: 'icon-btn', title: 'Insert blank keyframe (I)' }),
      btn(icon('duplicate'), () => this.app.addKeyframe(true), { cls: 'icon-btn', title: 'Duplicate current keyframe' }),
      btn(icon('trash'), () => this.app.removeKeyframe(), { cls: 'icon-btn', title: 'Delete keyframe' }),
      el('div', { class: 'sep' }),
      checkbox('Auto-key', ctx.settings.autoKey, (v) => { ctx.settings.autoKey = v; }),
      btn(icon('arrowsRightLeft'), () => { interpolateFrame(ctx, ctx.scene.frame, this.interpFactor(ctx)); this.drawTimeline(); }, { cls: 'icon-btn', title: 'Interpolate: insert a breakdown at the current frame' }),
      btn(icon('link'), () => { interpolateSequence(ctx); this.drawTimeline(); }, { cls: 'icon-btn', title: 'Sequence: interpolate all frames between keys' }),
      el('div', { class: 'sep' }),
      btn(icon('camera'), () => this.app.toggleCameraView(), { active: this.app.cameraView, cls: 'icon-btn', title: 'Look through the active camera (0)' }),
      this.cameraSelect(),
      btn(icon('plus'), () => this.app.addCamera(), { cls: 'icon-btn', title: 'Add a camera at the current view' }),
      btn(icon('xMark'), () => this.app.removeCamera(), { cls: 'icon-btn', title: 'Delete the active camera' }),
      checkbox('Lock', this.app.lockCamToView, (v) => { this.app.lockCamToView = v; }),
      btn(icon('pin'), () => this.app.addCameraKey(), { cls: 'icon-btn', title: 'Keyframe the camera at the current frame' }),
      btn(icon('minus'), () => this.app.removeCameraKeyAtFrame(), { cls: 'icon-btn', title: 'Remove camera key at current frame' }),
      numField('FOV', activeCam(ctx.scene).fov, (v) => { activeCam(ctx.scene).fov = Math.min(140, Math.max(5, v)); }, 1),
      btn(icon('gear'), () => this.openSettings(), { title: 'Settings & shortcuts (,)' }),
    );
  }

  private interpFactor(ctx: AppCtx): number {
    const layer = activeLayer(activeObject(ctx.scene));
    if (!layer) return 0.5;
    let prev = -Infinity, next = Infinity;
    for (const f of layer.frames) {
      if (f.frameNumber < ctx.scene.frame) prev = Math.max(prev, f.frameNumber);
      if (f.frameNumber > ctx.scene.frame) next = Math.min(next, f.frameNumber);
    }
    if (!isFinite(prev) || !isFinite(next)) return 0.5;
    return (ctx.scene.frame - prev) / (next - prev);
  }

  drawTimeline(): void {
    const { ctx } = this.app;
    const s = ctx.scene;
    const canvas = this.tlCanvas;
    const strip = canvas.parentElement!;
    const W = strip.clientWidth * devicePixelRatio;
    const H = strip.clientHeight * devicePixelRatio;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    const span = Math.max(1, s.frameEnd - s.frameStart);
    const fx = (f: number) => ((f - s.frameStart) / span) * W;

    // frame ticks
    g.fillStyle = '#55555c';
    const step = span > 200 ? 50 : span > 80 ? 20 : span > 30 ? 10 : 5;
    g.font = `${10 * devicePixelRatio}px sans-serif`;
    for (let f = Math.ceil(s.frameStart / step) * step; f <= s.frameEnd; f += step) {
      g.fillRect(fx(f), 0, 1, H);
      g.fillText(String(f), fx(f) + 3, 10 * devicePixelRatio);
    }

    // keyframes of all layers (active layer bright)
    const ob = activeObject(s);
    const rowH = Math.min(8 * devicePixelRatio, H / Math.max(1, ob.layers.length));
    ob.layers.forEach((layer, li) => {
      const y = H - (li + 0.5) * rowH;
      const isActive = layer.id === ob.activeLayerId;
      for (const f of layer.frames) {
        const x = fx(f.frameNumber);
        const r = (isActive ? 4 : 2.5) * devicePixelRatio;
        g.beginPath();
        g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
        g.closePath();
        const typeColor = f.keyframeType === 'BREAKDOWN' ? '#41c8e0' : '#e0e0e0';
        g.fillStyle = f.select ? '#ff9a3b' : isActive ? typeColor : '#77777e';
        g.fill();
      }
    });

    // camera keys along the top edge
    g.fillStyle = '#d8a03c';
    for (const k of activeCam(s).keys) {
      const x = fx(k.frame);
      const r = 3 * devicePixelRatio;
      g.fillRect(x - r / 2, 2, r, r);
    }

    // playhead
    g.fillStyle = '#4f8cff';
    g.fillRect(fx(s.frame) - 1, 0, 2 * devicePixelRatio, H);
  }
}
