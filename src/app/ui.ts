import type { AppCtx, CursorSnap, EraserMode, GuideType, PaintBrush, PlacementMode, PlaneMode, SculptBrush, StrokeTarget } from '../tools/context';
import type { EditorMode } from '../render/GPSceneRenderer';
import type { GPLayer, GPMaterial, ModifierType, EffectType, Vec4, BlendMode, LineMode, FillStyle } from '../core/types';
import { activeCam, activeLayer, activeObject, createLayer, createMaterial, cloneFrame, createFrame, frameAt, genId } from '../core/gpdata';
import { ACTIONS, comboFromEvent, type Keymap } from './keymap';
import { MODIFIERS, createModifier } from '../modifiers/index';
import { BRUSH_PRESETS } from '../core/brushes';
import { bus } from '../events/bus';
import { midi } from '../events/midi';
import { wsLink } from '../events/ws';
import { EFFECT_DEFAULTS, createEffect } from '../fx/effects';
import { interpolateFrame, interpolateSequence } from '../anim/interpolate';
import * as ops from '../tools/editops';
import { selectAll, selectLinked, selectMoreLess } from '../tools/select';

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
  keymap: Keymap;
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

function btn(label: string, onclick: () => void, opts: { active?: boolean; title?: string; cls?: string } = {}): HTMLButtonElement {
  return el('button', {
    text: label, onclick, title: opts.title ?? label,
    class: `${opts.cls ?? ''} ${opts.active ? 'active' : ''}`,
  });
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

function panel(title: string, ...children: (Node | string)[]): HTMLElement {
  const body = el('div', { class: 'body' }, ...children);
  const h = el('h3', { text: title });
  h.onclick = () => { body.style.display = body.style.display === 'none' ? '' : 'none'; };
  return el('div', { class: 'panel' }, h, body);
}

// ---------------------------------------------------------------------------

const TOOLS_BY_MODE: Record<EditorMode, [string, string, string][]> = {
  DRAW: [
    ['draw', '✏️', 'Draw (D)'], ['erase', '◌', 'Erase (E)'], ['fill', '🪣', 'Fill (F)'],
    ['tint', '🖌', 'Tint'], ['cutter', '✂️', 'Cutter'], ['eyedropper', '💧', 'Eyedropper'],
    ['line', '╱', 'Line'], ['polyline', '⌇', 'Polyline'], ['arc', '◜', 'Arc'],
    ['curve', '∿', 'Curve'], ['box', '▭', 'Box'], ['circle', '◯', 'Circle'],
    ['interpolate', '⇄', 'Interpolate (drag)'],
  ],
  EDIT: [
    ['select', '⬚', 'Box select (Ctrl lasso, C circle)'],
    ['select-lasso', '⟁', 'Lasso select'],
    ['select-circle', '◯', 'Circle select ([ ] size)'],
  ],
  SCULPT: [['sculpt', '🫳', 'Sculpt brush']],
  VERTEX: [['vertexpaint', '🎨', 'Vertex paint']],
  WEIGHT: [['weightpaint', '⚖️', 'Weight paint']],
};

export class UI {
  private app: AppHandle;
  private tlCanvas: HTMLCanvasElement;

  constructor(app: AppHandle) {
    this.app = app;
    this.tlCanvas = el('canvas');
    this.buildTimelineShell();
    this.refresh();
    // live values (camera position etc.) — skip while the user types in it
    setInterval(() => {
      if (this.inspectorOpen && !this.inspectorEl?.contains(document.activeElement)) {
        this.rebuildInspector();
      }
      this.refreshMonitor();
    }, 300);
  }

  refresh(): void {
    this.buildTopbar();
    this.buildToolbar();
    this.buildSidebar();
    this.refreshTimelineControls();
    this.drawTimeline();
  }

  // ------------------------------------------------------------- topbar

  private buildTopbar(): void {
    const { ctx } = this.app;
    const s = ctx.settings;
    const bar = $('topbar');
    bar.replaceChildren();

    const modes: [EditorMode, string][] = [
      ['DRAW', 'Draw'], ['EDIT', 'Edit'], ['SCULPT', 'Sculpt'], ['VERTEX', 'Vertex Paint'], ['WEIGHT', 'Weight Paint'],
    ];
    for (const [m, label] of modes) {
      bar.append(btn(label, () => this.app.setMode(m), { active: s.mode === m }));
    }
    bar.append(el('div', { class: 'sep' }));

    if (s.mode === 'DRAW') {
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
        checkbox('🧲 Snap', s.snap.enabled, (v) => { s.snap.enabled = v; this.app.savePrefs(); }),
        selectField('', s.snap.mode, [
          ['INCREMENT', 'Increment'], ['POINT', 'Stroke point'], ['CANVAS', 'Canvas'],
        ], (v) => { s.snap.mode = v as typeof s.snap.mode; this.app.savePrefs(); }),
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
    bar.append(
      selectField('Cursor snap', s.cursorSnap, [
        ['PLANE', 'Plane'], ['GRID', 'Grid'], ['STROKE', 'Stroke point'], ['SELECTION', 'Selection'],
      ] as [CursorSnap, string][], (v) => { s.cursorSnap = v; this.app.savePrefs(); }),
      checkbox('Numpad', s.emulateNumpad, (v) => { s.emulateNumpad = v; this.app.savePrefs(); }),
      checkbox('Alt-nav', s.emulate3Button, (v) => { s.emulate3Button = v; this.app.savePrefs(); }),
      colorField('BG', [...s.background, 1], (rgb) => { this.app.setBackground(rgb); this.app.savePrefs(); }),
      btn('Present', () => this.app.togglePresentation(), { title: 'Presentation/performance mode (P): viewport only, shortcuts stay live' }),
    );
    bar.append(el('div', { class: 'sep' }));
    bar.append(
      btn('↶', () => this.app.undo(), { title: 'Undo (Ctrl+Z)' }),
      btn('↷', () => this.app.redo(), { title: 'Redo (Ctrl+Shift+Z)' }),
      btn('Save', () => this.app.saveScene()),
      btn('Load', () => this.app.loadScene()),
      btn('PNG', () => this.app.exportPng(), { title: 'Export viewport snapshot' }),
    );
  }

  // ------------------------------------------------------------ toolbar

  private buildToolbar(): void {
    const { ctx } = this.app;
    const bar = $('toolbar');
    bar.replaceChildren();
    for (const [id, icon, title] of TOOLS_BY_MODE[ctx.settings.mode]) {
      bar.append(btn(icon, () => this.app.setTool(id), {
        active: ctx.settings.activeTool === id, title, cls: 'tool',
      }));
    }
  }

  // ------------------------------------------------------------ sidebar

  private buildSidebar(): void {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const side = $('sidebar');
    side.replaceChildren();

    if (ctx.settings.mode === 'DRAW') side.append(this.brushPanel());
    side.append(this.layersPanel());
    side.append(this.materialsPanel());
    side.append(this.canvasesPanel());
    if (ctx.settings.mode === 'EDIT') side.append(this.editOpsPanel());
    side.append(this.modifiersPanel());
    side.append(this.effectsPanel());
    side.append(this.onionPanel());
    side.append(this.ioPanel());
    void ob;
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
        btn(layer.hide ? '🙈' : '👁', () => { layer.hide = !layer.hide; ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn', title: 'Hide' }),
        btn(layer.lock ? '🔒' : '🔓', () => { layer.lock = !layer.lock; this.refresh(); }, { cls: 'icon-btn', title: 'Lock' }),
        btn(layer.useOnion ? '🧅' : '·', () => { layer.useOnion = !layer.useOnion; ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn', title: 'Onion skin' }),
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
        btn('▲', () => this.moveLayer(1), { title: 'Move up' }),
        btn('▼', () => this.moveLayer(-1), { title: 'Move down' }),
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
      row.append(btn(`${l?.name ?? id} ✕`, () => {
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
          btn('✕', () => this.app.removeCanvasPlane(c.id), { cls: 'icon-btn', title: 'Delete canvas' }),
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

  private editOpsPanel(): HTMLElement {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const layerSel = el('select') as HTMLSelectElement;
    for (const l of ob.layers) layerSel.append(el('option', { value: String(l.id), text: l.name }));
    return panel('Stroke Ops',
      el('div', { class: 'row' },
        btn('Subdivide', () => ops.subdivideSelected(ctx)),
        btn('Simplify', () => ops.simplifySelected(ctx)),
        btn('Smooth', () => ops.smoothSelected(ctx)),
      ),
      el('div', { class: 'row' },
        btn('Join', () => ops.joinSelected(ctx)),
        btn('Split', () => ops.splitSelected(ctx)),
        btn('Merge dist', () => ops.mergeByDistance(ctx)),
      ),
      el('div', { class: 'row' },
        btn('Cyclic', () => ops.toggleCyclic(ctx)),
        btn('Reverse', () => ops.switchDirection(ctx)),
        btn('Set start', () => ops.setStartPoint(ctx)),
      ),
      el('div', { class: 'row' },
        btn('Norm. width', () => ops.normalizeThickness(ctx)),
        btn('Norm. alpha', () => ops.normalizeOpacity(ctx)),
      ),
      el('div', { class: 'row' },
        btn('⤒ Front', () => ops.arrangeSelected(ctx, 'TOP')),
        btn('↑', () => ops.arrangeSelected(ctx, 'UP')),
        btn('↓', () => ops.arrangeSelected(ctx, 'DOWN')),
        btn('⤓ Back', () => ops.arrangeSelected(ctx, 'BOTTOM')),
      ),
      el('div', { class: 'row' },
        btn('Snap→Cursor', () => ops.snapToCursor(ctx)),
        btn('Snap→Grid', () => ops.snapToGrid(ctx)),
      ),
      el('div', { class: 'row' },
        btn('Sel linked (L)', () => { selectLinked(ctx); ctx.requestRender(); }),
        btn('More', () => { selectMoreLess(ctx, true); ctx.requestRender(); }),
        btn('Less', () => { selectMoreLess(ctx, false); ctx.requestRender(); }),
        btn('Invert', () => { selectAll(ctx, 'invert'); ctx.requestRender(); }),
      ),
      el('div', { class: 'row' }, 'Move to layer:', layerSel,
        btn('Go', () => ops.moveToLayer(ctx, Number(layerSel.value)))),
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
          btn('▲', () => { if (i > 0) { [ob.modifiers[i - 1], ob.modifiers[i]] = [ob.modifiers[i], ob.modifiers[i - 1]]; ctx.requestRender(); this.refresh(); } }, { cls: 'icon-btn' }),
          btn('▼', () => { if (i < ob.modifiers.length - 1) { [ob.modifiers[i + 1], ob.modifiers[i]] = [ob.modifiers[i], ob.modifiers[i + 1]]; ctx.requestRender(); this.refresh(); } }, { cls: 'icon-btn' }),
          btn('✕', () => { ctx.pushUndo(); ob.modifiers.splice(i, 1); ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn' }),
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
          btn('✕', () => { ctx.pushUndo(); ob.effects.splice(i, 1); ctx.requestRender(); this.refresh(); }, { cls: 'icon-btn' }),
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
      ),
      el('div', { class: 'row' },
        checkbox('Emulate Numpad (digit-row view keys)', s.emulateNumpad, (v) => { s.emulateNumpad = v; save(); }),
      ),
      el('div', { class: 'row' },
        checkbox('Emulate 3-Button Mouse (Alt+LMB navigates)', s.emulate3Button, (v) => { s.emulate3Button = v; save(); }),
      ),
      el('div', { class: 'row' },
        selectField('Cursor snap', s.cursorSnap, [
          ['PLANE', 'Plane'], ['GRID', 'Grid'], ['STROKE', 'Stroke point'], ['SELECTION', 'Selection'],
        ], (v) => { s.cursorSnap = v as typeof s.cursorSnap; save(); }),
        numField('Grid step', s.gridStep, (v) => { s.gridStep = Math.max(0.01, v); save(); }),
      ),
      el('div', { class: 'row' },
        colorField('Background', [...s.background, 1], (rgb) => { this.app.setBackground(rgb); save(); }),
        checkbox('Auto-key', s.autoKey, (v) => { s.autoKey = v; }),
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
        btn('✕', close, { cls: 'icon-btn' }),
      ),
      el('div', { class: 'panel' }, el('h3', { text: 'Preferences' }), prefs),
      el('div', { class: 'panel' }, el('h3', { text: 'Shortcuts (click a binding to change it)' }), shortcutRows),
    );
    overlay.append(dialog);
    document.body.append(overlay);
  }

  // ---------------------------------------------------------- events / IO

  private monitorPaused = false;

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
        btn(this.monitorPaused ? '▶ monitor' : '⏸ monitor', () => { this.monitorPaused = !this.monitorPaused; this.refresh(); }),
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
      btn('⏮', () => { s.frame = s.frameStart; ctx.requestRender(); this.drawTimeline(); }, { title: 'Jump to start' }),
      btn('◀◀', () => this.app.jumpKey(-1), { title: 'Previous keyframe (Down)' }),
      btn(this.app.isPlaying() ? '⏸' : '▶', () => { this.app.playToggle(); this.refreshTimelineControls(); }, { title: 'Play (Space)' }),
      btn('▶▶', () => this.app.jumpKey(1), { title: 'Next keyframe (Up)' }),
      el('span', { text: `Frame ${s.frame}` }),
      el('div', { class: 'sep' }),
      numField('Start', s.frameStart, (v) => { s.frameStart = Math.round(v); this.drawTimeline(); }, 1),
      numField('End', s.frameEnd, (v) => { s.frameEnd = Math.round(v); this.drawTimeline(); }, 1),
      numField('FPS', s.fps, (v) => { s.fps = Math.max(1, Math.round(v)); }, 1),
      el('div', { class: 'sep' }),
      btn('＋Key', () => this.app.addKeyframe(false), { title: 'Insert blank keyframe (I)' }),
      btn('＋Dup', () => this.app.addKeyframe(true), { title: 'Duplicate current keyframe' }),
      btn('－Key', () => this.app.removeKeyframe(), { title: 'Delete keyframe' }),
      el('div', { class: 'sep' }),
      checkbox('Auto-key', ctx.settings.autoKey, (v) => { ctx.settings.autoKey = v; }),
      btn('Interpolate', () => { interpolateFrame(ctx, ctx.scene.frame, this.interpFactor(ctx)); this.drawTimeline(); }, { title: 'Insert breakdown at current frame' }),
      btn('Sequence', () => { interpolateSequence(ctx); this.drawTimeline(); }, { title: 'Interpolate all frames between keys' }),
      el('div', { class: 'sep' }),
      btn('🎥', () => this.app.toggleCameraView(), { active: this.app.cameraView, title: 'Look through the active camera (0)' }),
      this.cameraSelect(),
      btn('＋Cam', () => this.app.addCamera(), { title: 'Add a camera at the current view' }),
      btn('－Cam', () => this.app.removeCamera(), { title: 'Delete the active camera' }),
      checkbox('Lock', this.app.lockCamToView, (v) => { this.app.lockCamToView = v; }),
      btn('＋CamKey', () => this.app.addCameraKey(), { title: 'Keyframe the camera at the current frame' }),
      btn('－CamKey', () => this.app.removeCameraKeyAtFrame(), { title: 'Remove camera key at current frame' }),
      numField('FOV', activeCam(ctx.scene).fov, (v) => { activeCam(ctx.scene).fov = Math.min(140, Math.max(5, v)); }, 1),
      btn('⚙', () => this.openSettings(), { title: 'Settings & shortcuts (,)' }),
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
