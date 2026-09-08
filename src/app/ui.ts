import { snapIncrement, type AppCtx, type EraserMode, type GuideType, type PaintBrush, type PlacementMode, type PlaneMode, type SculptBrush, type StrokeTarget } from '../tools/context';
import type { EditorMode } from '../render/GPSceneRenderer';
import type { GPScene, GPLayer, GPMaterial, ModifierType, EffectType, Vec4, BlendMode, LineMode, FillStyle, StrokeShade, VaryMode } from '../core/types';
import type { MaterialBlend, TGActor, TGMaterial, TextureSlotName, TGMesh, Vec3, ViewportShading } from '../core/types';
import { activeCam, activeLayer, activeObject, createLayer, createMaterial, cloneFrame, createFrame, frameAt, genId } from '../core/gpdata';
import type { MaterialTarget } from '../core/gpdata';
import type { UnwrapMode } from '../core/uvunwrap';
import { PROVIDER_LIST, getProvider } from '../agent/providers';
import { webMcp } from '../agent/webmcp';
import { MEASURE_COLOR, formatArea, formatLength, measureArea, measureLength, toWorldLength, worldPointsOf } from '../tools/measure';
import { localPoint } from '../core/measures';
import { DETECT_MODELS, semanticDetector } from '../mm/detect';
import type { DetectConfig, DetectHit, MMStream } from '../core/types';
import type { BakeSource } from '../render/bake';
import { hasUV } from '../core/uvunwrap';
import { createImage, createMaterialDB, ensureMaterial, imageById, materialById } from '../core/gpdata';
import { ACTIONS, comboFromEvent, type Keymap } from './keymap';
import { MODIFIERS, applyModifierToData, createModifier } from '../modifiers/index';
import { BRUSH_PRESETS } from '../core/brushes';
import { bus } from '../events/bus';
import { defaultCursor, scoreId } from '../score/engine';
import { createRoute, routes, TARGET_SUGGESTIONS } from '../events/routes';
import { mediamime } from '../io/mediamime';
import { mmCapture } from '../mm/capture';
import { streamStore } from '../mm/streams';
import { penLandmarkHint } from '../mm/pen';
import { combinedBodyMapPicker, hasLandmarkMap, landmarkMapForKind, listRigLandmarks, multiLandmarkMapForKind, RIG_KIND_PATH, type RigMapKind } from './poseMap';
import { deleteAsset, listAssets } from '../io/assets';
import { CONSTRAINT_DEFS, createConstraint } from '../score/constraints';
import { smoothPolyMesh, subdividePolyMesh } from '../core/polymesh';
import { exportPaintCloudPly } from '../render/paintclouds';
import type { ConstraintType, TGConstraint } from '../core/types';
import {
  deselectAllObjects, descendantRefs, getObjectTransform,
  listSelected as listSelectedObjects, objectName, selectionPivot,
  setObjectHidden, setObjectLockedFlag, setObjectSelected, setObjectTransform,
  setParentKeepWorld, type ObjRef,
} from '../tools/objects';
import {
  applyObjectTransformPartial, clearObjectTransform, geometryToOrigin, mirrorObject,
  originToCursor, originToFirstPoint, originToGeometry, originToGeometryBase, separateConnectedIntoObjects,
  snapCursorToActive, snapCursorToGrid, snapCursorToSelectionMedian, snapCursorToWorldOrigin,
  snapSelectionToActive, snapSelectionToCursor, snapSelectionToGrid,
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
import { autoRig } from '../actor/rig';
import { MASK_LABELS, SOURCE_LABELS, nextLayerId } from '../actor/mixer';
import { MOVE_ACTIONS, runMoveAction } from '../actor/commands';
import { nextMacroId } from '../actor/macros';
import { poseSegments } from '../actor/poses';
import { POST_PRESETS } from '../fx/scenefx';
import { engineOf, resetPhysics } from '../actor/physics';
import { defaultBody, propRadius } from '../actor/props';
import { ACTOR_LOOKS, LOOK_OPTIONS } from '../render/actorlooks';
import type { ActorLayerSource } from '../core/types';

export interface AppHandle {
  ctx: AppCtx;
  /** the scene's environment/IBL manager — the World panel reads its
   *  load status, since an image or video source resolves asynchronously */
  world: { status: 'ok' | 'loading' | 'error'; error: string };
  scaleSceneToMeasure(measureId: number, realLength: number): { ok: boolean; factor?: number; error?: string };
  addActor(at?: [number, number, number]): void;
  resetActor(id: number): void;
  export3D(format: string, selectedOnly: boolean): void;
  setActorStance(id: number, kind: 'REST' | 'T' | 'A'): void;
  savePoseSlot(id: number, poseId?: number): void;
  applyPoseSlot(id: number, poseId: number): void;
  deletePoseSlot(poseId: number): void;
  setStreamDriver(streamId: number, source: { kind: 'ACTOR'; actorId: number } | { kind: 'OBJECT'; ref: ObjRef }, cameraIndex: number): void;
  clearStreamDriver(streamId: number): void;
  streamDriver(streamId: number): { source: { kind: 'ACTOR'; actorId: number } | { kind: 'OBJECT'; ref: ObjRef }; cameraIndex: number } | null;
  isStreamDriven(streamId: number): boolean;
  setMode(mode: EditorMode): void;
  setShading(mode: ViewportShading): void;
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
  addMeshObject(kind: 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER' | 'PYRAMID' | 'TETRA' | 'OCTA' | 'DODECA' | 'ICOSA' | 'EMPTY'): void;
  /** Persist UVs on an editable mesh (App owns the camera for VIEW). */
  unwrapPoly(id: number, mode: UnwrapMode): void;
  /** Bake a source onto the selected object's base-color texture. */
  bakeToTexture(source: BakeSource, size?: number, margin?: number): void;
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
  mmCaptureStart(source?: { url?: string; file?: File }): void;
  mmSetPlaybackRate(rate: number): void;
  togglePossess(actorId: number): void;
  actorGoTo(actorId: number, point: Vec3): void;
  actorGoToObject(actorId: number, ref: import('../tools/objects').ObjRef): void;
  actorStop(actorId: number): void;
  modelMotions(): { meshId: number; name: string; clips: string[] }[];
  avatarChoices(): { id: number; name: string }[];
  setActorAvatar(actorId: number, meshId: number | null): void;
  clearGeneratedMotion(actorId: number): void;
  motionBackendIds(): { id: string; label: string }[];
  motionEndpoint(): string;
  motionStatus(): { text: string; busy: boolean; notices: string[]; hint: string } | null;
  setStatusHint(text: string, ms?: number): void;
  setMotionEndpoint(url: string): void;
  generateMotion(actorId: number, prompt: string, seconds: number, backendId?: string): Promise<void>;
  importMotion(meshId: number, clipIndex: number, actorId: number): void;
  possessedActor(): number | null;
  possessView(): 'FIRST' | 'THIRD';
  setPossessView(view: 'FIRST' | 'THIRD'): void;
  mmRecordToggle(source: import('../mm/clips').RecordSource): void;
  mmRecording(source?: import('../mm/clips').RecordSource): boolean;
  mmPlayClip(clipId: number): void;
  mmBakeClip(clipId: number, landmark?: number): void;
  mmCropClip(clipId: number): void;
  mmDeleteClip(clipId: number): void;
  importGPFile(file: File): void;
  exportSplatPly(id: number): void;
  run(action: string): void;
  setLastPicked(ref: import('../tools/objects').ObjRef): void;
  getLastPicked(): import('../tools/objects').ObjRef | null;
  /** Agent chat + tool session (owns its own transcript across refreshes). */
  agent: import('../agent/panel').AgentPanel;
  /** World-space bounding-box size (Blender's "Dimensions") for the
   *  N-panel's Extents row. Null if the object has no root yet. */
  objectExtents(ref: import('../tools/objects').ObjRef): [number, number, number] | null;
  pickObject(cb: (ref: import('../tools/objects').ObjRef | null) => void): void;
  newScene(): void;
  loadDemoScene(playground?: boolean): void;
  captureCameraPlate(camIndex: number, distance?: number, width?: number): void;
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

// ---- Blender-style drag-number widget -------------------------------------
// One widget for every numeric input: label left / value right in a flat
// box; hover reveals ‹ › nudge arrows; click-drag scrubs (Shift = fine),
// plain click types; Backspace while hovering resets to default; right-
// click opens a context menu (reset / copy / route to routional).

interface NumOpts {
  step?: number;
  min?: number;
  max?: number;
  /** reset target for Backspace-on-hover and the context menu */
  def?: number;
  /** draw a range fill bar (the slider look) — needs min+max */
  fill?: boolean;
  /** routional dot-path (e.g. 'brush.size') → "Add Route" in the menu */
  route?: string;
  title?: string;
}

/** reset action of the widget currently under the pointer (Backspace) */
let hoveredNumReset: (() => void) | null = null;
let numKeysBound = false;
/** true while any drag-number widget is being scrubbed — periodic DOM
 *  rebuilds (the N-panel inspector refresh) must not run mid-drag or
 *  they'd remove the pointer-captured element out from under the user */
let numDragActive = false;
/** Rebuild the panels once the current scrub ends (see UI.refresh). */
let deferredRefresh: (() => void) | null = null;
function flushDeferredRefresh(): void {
  const run = deferredRefresh;
  deferredRefresh = null;
  run?.();
}

function endNumDrag(): void {
  numDragActive = false;
  flushDeferredRefresh();
}

function isTextEditable(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable);
}

/** Minimal floating context menu; closes on outside pointer / Esc. */
function popupMenu(x: number, y: number, items: { label: string; hint?: string; do?: () => void }[]): void {
  const menu = el('div', { class: 'ctxmenu' });
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  for (const it of items) {
    if (!it.do) { menu.append(el('div', { class: 'ctxmenu-sep' })); continue; }
    const row = el('div', { class: 'ctxmenu-item' },
      el('span', { text: it.label }),
      ...(it.hint ? [el('span', { class: 'ctxmenu-hint', text: it.hint })] : []));
    row.onclick = () => { close(); it.do!(); };
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  document.addEventListener('pointerdown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
}

/** Set by the UI instance so number widgets can create routional routes. */
let numAddRouteHook: ((target: string) => void) | null = null;

function dragNumber(label: string, value: number, onChange: (v: number) => void, opts: NumOpts = {}): HTMLElement {
  const step = opts.step ?? 0.1;
  const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  const clamp = (v: number) => Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, v));
  const fmt = (v: number) => v.toFixed(decimals);
  let cur = clamp(value);

  const hasFill = !!opts.fill && opts.min !== undefined && opts.max !== undefined;
  // outer row: label OUTSIDE the box (right-justified, immediately left of
  // it) + a fixed-width box. The box itself never resizes — not on hover
  // (arrows sit INSIDE its edges, overlapping the value) and not while
  // editing (the input overlays the same box, absolutely positioned).
  const row = el('div', { class: `numdrag-row${hasFill ? ' fill' : ''}` });
  if (opts.title) row.title = opts.title;
  const box = el('div', { class: 'numdrag' });
  const fillBar = hasFill ? el('div', { class: 'numdrag-fillbar' }) : null;
  const valEl = el('span', { class: 'numdrag-value', text: fmt(cur) });
  const arrowL = el('span', { class: 'numdrag-arrow left', text: '‹' });
  const arrowR = el('span', { class: 'numdrag-arrow right', text: '›' });
  if (fillBar) box.append(fillBar);
  box.append(arrowL, valEl, arrowR);
  row.append(box);
  const wrap = box; // all interaction/event wiring below targets the box

  const syncFill = () => {
    if (fillBar) fillBar.style.width = `${((cur - opts.min!) / (opts.max! - opts.min!)) * 100}%`;
  };
  syncFill();
  const set = (v: number) => {
    if (!Number.isFinite(v)) return;
    cur = clamp(Math.round(v * 1e6) / 1e6);
    valEl.textContent = fmt(cur);
    syncFill();
    onChange(cur);
  };

  // -- type-in editing --
  const beginEdit = () => {
    if (wrap.querySelector('.numdrag-input')) return;
    wrap.classList.add('editing');
    const input = el('input', { type: 'text', class: 'numdrag-input', value: String(cur) }) as HTMLInputElement;
    let cancelled = false;
    input.onblur = () => {
      if (!cancelled) {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) set(v);
      }
      input.remove();
      wrap.classList.remove('editing');
      flushDeferredRefresh();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') { cancelled = true; input.blur(); }
    };
    wrap.append(input);
    input.focus();
    input.select();
  };

  // -- scrub drag / click / arrow nudge --
  let startX = 0, startVal = 0, dragging = false, pid = -1;
  wrap.onpointerdown = (e) => {
    if (e.button !== 0 || isTextEditable(e.target)) return;
    e.preventDefault();
    pid = e.pointerId;
    startX = e.clientX;
    startVal = cur;
    dragging = false;
    numDragActive = true;
    wrap.setPointerCapture(pid);
  };
  wrap.onpointercancel = (e) => {
    if (pid !== e.pointerId) return;
    pid = -1;
    dragging = false;
    endNumDrag();
    wrap.classList.remove('dragging');
  };
  wrap.onpointermove = (e) => {
    if (pid !== e.pointerId || e.buttons === 0) return;
    const dx = e.clientX - startX;
    if (!dragging && Math.abs(dx) > 3) { dragging = true; wrap.classList.add('dragging'); }
    if (!dragging) return;
    const fine = e.shiftKey ? 0.1 : 1;
    if (hasFill) {
      const raw = startVal + (dx / Math.max(40, wrap.clientWidth)) * (opts.max! - opts.min!) * fine;
      set(Math.round(raw / step) * step); // quantize to step, Blender-style
    } else {
      set(startVal + Math.round(dx / 2) * step * fine);
    }
  };
  wrap.onpointerup = (e) => {
    if (pid !== e.pointerId) return;
    wrap.releasePointerCapture(pid);
    pid = -1;
    endNumDrag();
    if (dragging) { dragging = false; wrap.classList.remove('dragging'); return; }
    const nudge = (dir: number) => set(cur + dir * step * (e.shiftKey ? 0.1 : 1));
    if (e.target === arrowL) nudge(-1);
    else if (e.target === arrowR) nudge(1);
    else beginEdit();
  };

  // -- Backspace-on-hover reset (Blender semantics) --
  const reset = opts.def !== undefined ? () => set(opts.def!) : null;
  wrap.onpointerenter = () => { hoveredNumReset = reset; };
  wrap.onpointerleave = () => { if (hoveredNumReset === reset) hoveredNumReset = null; };
  if (!numKeysBound) {
    numKeysBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && hoveredNumReset && !isTextEditable(e.target)) {
        e.preventDefault();
        hoveredNumReset();
      }
    });
  }

  // -- right-click context menu --
  wrap.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items: { label: string; hint?: string; do?: () => void }[] = [];
    if (reset) items.push({ label: 'Reset to Default Value', hint: 'Backspace', do: reset });
    items.push({ label: 'Copy Value', do: () => { void navigator.clipboard?.writeText(String(cur)); } });
    if (opts.route && numAddRouteHook) {
      items.push({ label: '' }); // separator
      items.push({ label: 'Add Route', hint: 'routional', do: () => numAddRouteHook!(opts.route!) });
    }
    popupMenu(e.clientX, e.clientY, items);
  };

  // A labelled number IS a property row — hand back the two-column form so
  // it lines up with every other field in the panel. Unlabelled ones stay
  // bare so they can be packed into a .field-group (vectors, ranges).
  return label ? fieldRow(label, row) : row;
}

function slider(
  label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void,
  opts: Pick<NumOpts, 'def' | 'route' | 'title'> = {},
): HTMLElement {
  return dragNumber(label, value, onInput, { step, min, max, fill: true, ...opts });
}

/** A plain text input that commits on change/blur. */
function textField(
  value: string, onChange: (v: string) => void, title = '',
): HTMLElement {
  const input = el('input', {
    type: 'text', class: 'grow', value, title,
  }) as HTMLInputElement;
  if (title) input.placeholder = title.split(' \u2014 ')[0].slice(0, 48);
  input.addEventListener('change', () => onChange(input.value));
  input.addEventListener('blur', () => onChange(input.value));
  return input;
}

function numField(
  label: string, value: number, onChange: (v: number) => void, step = 0.1,
  opts: Omit<NumOpts, 'step'> = {},
): HTMLElement {
  return dragNumber(label, value, onChange, { step, ...opts });
}

function checkbox(label: string, value: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = value;
  input.onchange = () => onChange(input.checked);
  // The NAME goes in the label column and the box in the value column, like
  // every other row. Carrying its own text put a checkbox the other way
  // round — box first, name second, both adrift in the value column — so a
  // panel of settings had one row in three reading backwards against the
  // rest and no shared edge to scan down.
  const box = el('label', { class: 'inline' }, input);
  const row = fieldRow(label, box);
  if (title) row.title = title;
  // The name stays clickable, which is what makes a checkbox comfortable to
  // hit; it is a span rather than a <label for>, so wire it by hand.
  const name = row.querySelector('.field-row-label') as HTMLElement | null;
  if (name) {
    name.classList.add('clickable');
    name.onclick = () => { input.checked = !input.checked; onChange(input.checked); };
  }
  return row;
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
  return label ? fieldRow(label, input) : input;
}

function selectField<T extends string>(
  label: string, value: T, options: [T, string][], onChange: (v: T) => void,
): HTMLElement {
  const sel = el('select') as HTMLSelectElement;
  for (const [v, text] of options) sel.append(el('option', { value: v, text }));
  sel.value = value;
  sel.onchange = () => onChange(sel.value as T);
  return label ? fieldRow(label, sel) : sel;
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

/** Collapsed-state store for panel subsections (keyed by title), so a
 *  minimized section stays minimized across refreshes and sessions. */
const PANEL_STATE_KEY = 'threegrease.panels';
function panelCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(PANEL_STATE_KEY) ?? '{}') as Record<string, boolean>; }
  catch { return {}; }
}

/** Marker for panel()'s variadic children: wraps instructional/help text
 *  that should surface as a hover tooltip on the panel header instead of
 *  sitting in the body as a permanently-visible row. */
interface PanelHint { __panelHint: string }
function panelHint(text: string): PanelHint { return { __panelHint: text }; }

/** Formats offered by BOTH export menus — one list so they cannot drift. */
const EXPORT_FORMAT_LABELS: [string, string][] = [
  ['glb', 'GLB — recommended for Blender'],
  ['obj', 'OBJ'],
  ['stl', 'STL'],
  ['ply', 'PLY (geometry only)'],
  ['plyscene', 'PLY (incl. splats)'],
];

/** One pose thumbnail, in normalised 0..1 coordinates. */
function poseThumb(
  lines: [number, number, number, number][], dots: [number, number][],
): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('class', 'pose-thumb');
  for (const [x1, y1, x2, y2] of lines) {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
    svg.append(l);
  }
  for (const [cx, cy] of dots) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy));
    c.setAttribute('r', '0.045');
    svg.append(c);
  }
  return svg;
}

/** Hang an explanation off a control instead of printing it underneath.
 *  A sentence of prose in a panel is read once and then read again every
 *  time you come back for the control it is explaining. */
function tip<T extends HTMLElement>(node: T, text: string): T {
  node.title = text;
  const inner = node.querySelector('select, input, button');
  if (inner instanceof HTMLElement) inner.title = text;
  return node;
}
function isPanelHint(c: unknown): c is PanelHint {
  return typeof c === 'object' && c !== null && !(c instanceof Node) && '__panelHint' in c;
}

/**
 * One transcript row. User and assistant are bubbles; a tool call is a
 * single compact line, because a turn can contain a dozen of them and
 * bubbling each one buries the actual answer.
 */
function agentBubble(e: {
  role: string; text: string; ok?: boolean; source?: 'relay' | 'webmcp';
  call?: { name: string; args?: Record<string, unknown> };
}): HTMLElement {
  if (e.role === 'tool') {
    const mark = e.ok === false ? '\u2715' : e.ok ? '\u2713' : '\u00b7';
    const row = el('div', {
      class: `agent-tool${e.ok === false ? ' agent-failed' : ''}`,
      // full arguments on hover — the line itself stays one line
      title: e.call ? JSON.stringify(e.call.args ?? {}, null, 2) : e.text,
    },
    el('span', { class: 'agent-tool-mark', text: mark }),
    el('span', { class: 'agent-tool-name', text: e.text }));
    if (e.source) {
      row.append(el('span', {
        class: 'agent-src', text: e.source,
        title: e.source === 'webmcp' ? 'Called by the browser\u2019s agent' : 'Called over the relay',
      }));
    }
    return row;
  }
  if (e.role === 'status') return el('div', { class: 'agent-status-line', text: e.text });
  return el('div', { class: `agent-msg agent-${e.role}` }, el('span', { text: e.text }));
}

/** Panels that start CLOSED the first time they are seen — configuration a
 *  user visits occasionally, sitting under something they use constantly.
 *  Once toggled, the stored preference wins. */
const DEFAULT_COLLAPSED = new Set(['Agent settings', 'Behaviour']);

function panel(title: string, ...children: (Node | string | PanelHint)[]): HTMLElement {
  const hint = children.find(isPanelHint)?.__panelHint;
  const kids = children.filter((c) => !isPanelHint(c)) as (Node | string)[];
  const body = el('div', { class: 'body' }, ...kids);
  flattenFieldRows(body);
  const h = el('h3', hint ? { title: hint } : {}, el('span', { class: 'panel-caret', text: '▸' }), title);
  const state0 = panelCollapsed();
  const startCollapsed = title in state0 ? !!state0[title] : DEFAULT_COLLAPSED.has(title);
  const root = el('div', { class: `panel${startCollapsed ? ' collapsed' : ''}` }, h, body);
  h.onclick = () => {
    root.classList.toggle('collapsed');
    const state = panelCollapsed();
    // Store the boolean either way. Deleting the key on expand would let a
    // DEFAULT_COLLAPSED panel snap shut again on the next refresh, so the
    // user's choice has to be recorded explicitly.
    state[title] = root.classList.contains('collapsed');
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
  };
  return root;
}

/** Blender-style property row: label OUTSIDE on the left (right-justified,
 *  via CSS grid so every row in the panel lines up in one label column),
 *  control(s) filling the right column. One parameter per row is the norm
 *  — pass a single control. Pass an ARRAY only for sub-fields that are
 *  truly one logical parameter split into parts (e.g. a min/max range);
 *  they render as a connected, gapless `.field-group` the way Blender
 *  joins Color Depth's 8/16 toggle or a vector's X/Y/Z boxes, so it never
 *  reads as "two unrelated fields fighting for a row". Genuinely
 *  independent parameters must each get their own fieldRow — do not pass
 *  them together as an array. Pass '' as label when the control (e.g. a
 *  checkbox with its own text) already carries its own label.
 *  `full: true` skips the label column entirely (toolbars, button rows). */
function fieldRow(label: string, control: Node | Node[], opts: { full?: boolean } = {}): HTMLElement {
  const controlNode = Array.isArray(control)
    ? el('div', { class: 'field-group' }, ...control)
    : control;
  if (opts.full) return el('div', { class: 'field-row full' }, controlNode);
  // An EMPTY label still gets its (blank) label cell: that's what indents a
  // lone checkbox into the value column, lined up under the fields above
  // it, instead of letting it sprawl across the panel. Genuinely
  // full-width things (button strips) must pass { full: true }.
  return el('div', { class: `field-row${label ? '' : ' blank'}` },
    el('span', { class: 'field-row-label', text: label }), controlNode);
}

/**
 * Panels group related fields with `.row` wrappers, which predate the
 * two-column layout and pack 2-3 labelled widgets side by side — the thing
 * that makes a panel read as a jumble. Now that the field factories return
 * property rows, a `.row` of nothing but rows has no reason to exist:
 * dissolve it so each field takes its own line and its label joins the
 * shared label column. Mixed rows (a field next to a button) are left
 * alone — there the horizontal packing is deliberate.
 */
function flattenFieldRows(body: HTMLElement): void {
  for (const child of [...body.children]) {
    const kids = [...child.children];
    if (!child.classList.contains('row') || kids.length === 0) continue;
    if (kids.every((k) => k.classList.contains('field-row'))) child.replaceWith(...kids);
  }
}

/**
 * The direct-command HUD: a strip of verbs floating over the viewport while
 * the Direct tool is active. It is a HUD rather than a sidebar panel on
 * purpose — the whole interaction is "look at the space, point at it", and
 * a control you have to leave the space to reach breaks that.
 */
function renderDirectHud(app: AppHandle): void {
  const host = document.querySelector('#viewport');
  if (!host) return;
  const existing = host.querySelector('#direct-hud');
  const on = app.ctx.settings.activeTool === 'direct';
  if (!on) { existing?.remove(); return; }
  const bar = el('div', { id: 'direct-hud', class: 'direct-hud' });
  const actor = app.ctx.scene.actors.find((a) => a.select) ?? app.ctx.scene.actors[0];
  bar.append(el('span', {
    class: 'direct-hud-who',
    text: actor ? actor.name : 'no actor in the scene',
  }));
  const armed = app.ctx.settings.directAction;
  bar.append(btn('Navigate', () => {
    app.ctx.settings.directAction = '';
    renderDirectHud(app);
  }, {
    cls: armed ? '' : 'active',
    title: 'Disarmed — clicks do nothing, so you can look around without '
      + 'sending the visitor somewhere. Esc also disarms.',
  }));
  for (const a of MOVE_ACTIONS) {
    const active = armed === a.id;
    const b = btn(a.label, () => {
      // clicking the armed verb disarms: one control, two directions
      app.ctx.settings.directAction = active ? '' : a.id;
      renderDirectHud(app);
    }, {
      cls: active ? 'active' : '',
      title: active ? `${a.label} — armed; click again to disarm` : `${a.label} — ${a.hint}`,
    });
    bar.append(b);
  }
  existing?.replaceWith(bar);
  if (!existing) host.append(bar);
}

// ---------------------------------------------------------------------------

const TOOLS_BY_MODE: Record<EditorMode, [string, IconName, string][]> = {
  OBJECT: [
    ['object-select', 'squareTarget', 'Box select (Ctrl lasso, C circle)'],
    ['object-select-lasso', 'lasso', 'Lasso select'],
    ['object-select-circle', 'circle', 'Circle select ([ ] size)'],
    ['actorpose', 'actorPose', 'Pose — drag a joint (the body follows through physics; Shift+click pins it), or drag a physics prop to move and throw it (Shift-drag scenery to make it one)'],
    ['direct', 'actorDirect', 'Direct — click the world to send a character there. Pick the verb in the HUD: walk / run / sneak / march / jump / look / stop'],
    ['measure', 'ruler', 'Measure — click points for a ruler (Enter commits, Backspace undoes a point, Esc cancels); drag a placed point to adjust it'],
  ],
  DRAW: [
    ['draw', 'pencil', 'Draw (D)'], ['erase', 'eraser', 'Erase (E)'],
    ['smooth', 'wave', 'Smooth — relaxes stroke points toward their neighbors (Sculpt mode\'s Smooth brush, usable here); Shift = every visible object, not just the active one'],
    ['fill', 'swatch', 'Fill (F)'],
    ['tint', 'brush', 'Tint'], ['cutter', 'scissors', 'Cutter'], ['eyedropper', 'droplet', 'Eyedropper'],
    ['line', 'lineTool', 'Line'], ['polyline', 'polylineTool', 'Polyline'], ['arc', 'arcTool', 'Arc'],
    ['curve', 'curveTool', 'Curve'], ['box', 'square', 'Box'], ['circle', 'circle', 'Circle'],
    ['interpolate', 'arrowsRightLeft', 'Interpolate (drag)'],
    // the quilt trio lives with the drawing tools: same Placement/Plane/
    // Guide options as the pencil, retopologizing over what you draw
    // (strokes, meshes, and splats are snap sources)
    ['polypen', 'wireframe', 'PolyQuilt — context pen: click builds/fills · drag moves (vertex merge on release) · edge center-drag extrudes/loop-cuts · hold deletes/dissolves · hold+drag: vertex=edge extrude, empty=knife · Shift+click=AutoQuad · Ctrl+click=select'],
    ['polybuild', 'polylineTool', 'Poly Build — click/Ctrl+click adds geometry · drag a boundary edge extrudes · Shift+click deletes the element'],
    ['quadpatch', 'swatch', 'Quad Patch — click fills the patch inferred from nearby open edges (U-close, bridge, corner-complete)'],
    ['splatpaint', 'droplet', 'Splat Paint (3DGS) — deposit gaussian splats along the pointer path; Size=stamp px, Strength=alpha, vertex color=splat color, spacing/jitter from brush style; Ctrl+drag erases; placement/plane options apply'],
    ['texpaint', 'photo', 'Texture Paint — brush directly into the texture of the mesh under the pointer (vertex color = paint color, Strength = opacity); persists to the mesh texture on release'],
    // spray-style color tools, same brush family as VERTEX/WEIGHT modes —
    // available here too so you never have to leave DRAW to touch color
    ['vertexpaint', 'brush', 'Vertex Paint — spray per-point color onto the active GP object\'s strokes'],
    ['weightpaint', 'adjustments', 'Weight Paint — spray the softness vertex group onto the active GP object\'s strokes'],
  ],
  EDIT: [
    ['select', 'squareTarget', 'Box select (Ctrl lasso, C circle)'],
    ['select-lasso', 'lasso', 'Lasso select'],
    ['select-circle', 'circle', 'Circle select ([ ] size)'],
    // the quilt trio (same entries as DRAW): retopologize over what you
    // are editing — strokes, meshes, and splats are snap sources
    ['polypen', 'wireframe', 'PolyQuilt — context pen: click builds/fills · drag moves (vertex merge on release) · edge center-drag extrudes/loop-cuts · hold deletes/dissolves · hold+drag: vertex=edge extrude, empty=knife · Shift+click=AutoQuad · Ctrl+click=select'],
    ['polybuild', 'polylineTool', 'Poly Build — click/Ctrl+click adds geometry · drag a boundary edge extrudes · Shift+click deletes the element'],
    ['quadpatch', 'swatch', 'Quad Patch — click fills the patch inferred from nearby open edges (U-close, bridge, corner-complete)'],
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
    // number-widget context menu "Add Route": create a routional route
    // bound to the field's dot-path and jump to the Bindings tab
    numAddRouteHook = (target) => {
      const ctx = this.app.ctx;
      ctx.pushUndo();
      const r = createRoute(scoreId(ctx.scene));
      r.target = target;
      ctx.scene.routes.push(r);
      this.openTab('bindings');
    };
    this.buildTimelineShell();
    this.initHoverTips();
    this.refresh();
    // live values (camera position etc.) — skip while the user types in it
    setInterval(() => {
      if (this.inspectorOpen && !numDragActive && !this.inspectorEl?.contains(document.activeElement)) {
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
    // NEVER rebuild while a value is being scrubbed. Panels are rebuilt from
    // scratch, so a refresh replaces the very element the pointer captured —
    // the drag then has nothing left to drag and dies mid-gesture. That is
    // what made the sky sliders "stutter and halt": the world manager told
    // the UI it had changed on every tick, and each one killed the drag.
    // Anything that asks during a scrub is answered once, at the end.
    // Typing a value into one is the same hazard — the rebuild takes the
    // input away mid-word — so it waits too.
    if (numDragActive || document.querySelector('.numdrag-input')) {
      deferredRefresh = () => this.refresh();
      return;
    }
    this.buildMenubar();
    this.buildTopbar();
    this.buildToolbar();
    renderDirectHud(this.app);
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
    bar.append(el('span', { class: 'app-title', text: '3𝜻', title: 'threegrease' }));

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
      { label: 'New — Demo gallery scene', do: () => this.app.loadDemoScene() },
      { label: 'New — Gallery + loose props', do: () => this.app.loadDemoScene(true) },
      { label: 'Open…', action: 'open' },
      { label: 'Save', action: 'save' },
      { sep: true },
      { header: 'Import' },
      { label: 'GP object / scene (.json)…', do: () => this.filePick('.json', (f) => this.app.importGPFile(f)) },
      { label: 'Model / avatar (.glb/.gltf/.obj/.vrm)…', do: () => this.filePick('.glb,.gltf,.obj,.vrm', (f) => this.app.importModelFile(f)) },
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
      ...EXPORT_FORMAT_LABELS.map(([id, label]) => (
        { label, do: () => this.app.export3D(id, false) } as const)),
      { header: 'Export selection' },
      ...EXPORT_FORMAT_LABELS.map(([id, label]) => (
        { label, do: () => this.app.export3D(id, true) } as const)),
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
      { label: 'Pyramid', do: () => this.app.addMeshObject('PYRAMID') },
      { label: 'Tetrahedron', do: () => this.app.addMeshObject('TETRA') },
      { label: 'Octahedron', do: () => this.app.addMeshObject('OCTA') },
      { label: 'Dodecahedron', do: () => this.app.addMeshObject('DODECA') },
      { label: 'Icosahedron', do: () => this.app.addMeshObject('ICOSA') },
      { label: 'Empty', do: () => this.app.addMeshObject('EMPTY') },
      { sep: true },
      { label: 'Actor (mannequin)', do: () => this.app.addActor() },
      { sep: true },
      { label: 'Model / avatar…', do: () => this.filePick('.glb,.gltf,.obj,.vrm', (f) => this.app.importModelFile(f)) },
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

    menu('Capture', [
      { label: 'Open Capture panel', do: () => this.openTab('mediamime') },
      { sep: true },
      { header: `Prefix: ${ctx.scene.mediamime.prefix}` },
      { label: `${ctx.scene.mediamime.rigs.length} rig(s) · ${mediamime.list().length} live address(es)`, do: () => this.openTab('mediamime') },
      { sep: true },
      { label: 'mediamime bridge on GitHub…', do: () => window.open('https://github.com/languel/mediamime', '_blank') },
    ]);

    menu('Help', [
      { label: 'Command palette…', action: 'palette' },
      { label: 'Keyboard shortcuts…', action: 'settings' },
      { sep: true },
      { header: 'Agent' },
      { label: 'Using the agent…', do: () => this.openAgentHelp() },
      { label: 'Open Agent panel', do: () => this.openTab('agent') },
      { sep: true },
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
    } else if (s.mode === 'DRAW' && s.activeTool === 'vertexpaint') {
      // spray color directly onto GP point vertex colors — same controls
      // as the old standalone VERTEX mode, just reachable without leaving
      // DRAW (proper Color swatch instead of the flat brush.vertexColor
      // default nothing else exposed)
      bar.append(
        selectField('Brush', s.paint.brush, [['DRAW', 'Draw'], ['BLUR', 'Blur'], ['AVERAGE', 'Average'], ['SMEAR', 'Smear']] as [PaintBrush, string][], (v) => { s.paint.brush = v; }),
        colorField('Color', [...s.brush.vertexColor, 1], (rgb) => { s.brush.vertexColor = rgb; }),
        slider('Radius', s.paint.radius, 5, 150, 1, (v) => { s.paint.radius = v; }, { def: 40 }),
        slider('Strength', s.paint.strength, 0.05, 1, 0.05, (v) => { s.paint.strength = v; }),
      );
    } else if (s.mode === 'DRAW' && s.activeTool === 'weightpaint') {
      bar.append(
        slider('Weight', s.weight.target, 0, 1, 0.05, (v) => { s.weight.target = v; }),
        slider('Radius', s.weight.radius, 5, 150, 1, (v) => { s.weight.radius = v; }, { def: 40 }),
        slider('Strength', s.weight.strength, 0.05, 1, 0.05, (v) => { s.weight.strength = v; }),
      );
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
        slider('Size', s.brush.size, 1, 80, 1, (v) => { s.brush.size = v; }, { def: 8, route: 'brush.size' }),
        slider('Strength', s.brush.strength, 0.05, 1, 0.05, (v) => { s.brush.strength = v; }, { def: 1, route: 'brush.strength' }),
        // splat/texture painting spray their color from the same
        // brush.vertexColor swatch as vertex paint — surface it here so
        // it's never a hidden default (this was previously invisible,
        // making the spray color look "stuck" on its orange default)
        ...(s.activeTool === 'splatpaint' || s.activeTool === 'texpaint' ? [
          colorField('Color', [...s.brush.vertexColor, 1], (rgb) => { s.brush.vertexColor = rgb; }),
        ] : []),
        selectField('Placement', s.placement, [['ORIGIN', 'Origin'], ['CURSOR', '3D Cursor'], ['SURFACE', 'Surface'], ['SURFACE_PERP', 'Surface ⊥'], ['STROKE', 'Stroke'], ['STROKE_PERP', 'Stroke ⊥'], ['SPLAT', 'Splat (nearest)'], ['NEAREST', 'Nearest Object']] as [PlacementMode, string][], (v) => { s.placement = v; this.refresh(); }),
        ...(s.placement === 'SURFACE' ? [
          numField('Offset', s.surfaceOffset, (v) => { s.surfaceOffset = v; }, 0.01),
        ] : []),
        ...(s.placement === 'STROKE' || s.placement === 'SPLAT' || s.placement === 'NEAREST' ? [
          checkbox('Lock', s.placementLock, (v) => { s.placementLock = v; },
            'freeze the depth this stroke started at instead of re-snapping to whatever is nearest as you draw'),
          checkbox('Smooth', s.placementSmooth, (v) => { s.placementSmooth = v; },
            'ease toward a new target depth instead of jumping straight to it (ignored when Lock is on)'),
        ] : []),
        selectField('Plane', s.plane, (s.upAxis === 'Z'
          ? [['VIEW', 'View'], ['VIEW_ORIGIN', 'View at Origin'], ['FRONT', 'Front (X·Z)'], ['SIDE', 'Side (Y·Z)'], ['TOP', 'Top (X·Y)'], ['CURSOR', 'Cursor']]
          : [['VIEW', 'View'], ['VIEW_ORIGIN', 'View at Origin'], ['FRONT', 'Front (X·Y)'], ['SIDE', 'Side (Z·Y)'], ['TOP', 'Top (X·Z)'], ['CURSOR', 'Cursor']]) as [PlaneMode, string][],
        (v) => { s.plane = v; }),
        ...(s.placement === 'STROKE' ? [
          selectField('Target', s.strokeTarget, [['ALL', 'All Points'], ['ENDS', 'End Points'], ['FIRST', 'First Point']] as [StrokeTarget, string][], (v) => { s.strokeTarget = v; }),
        ] : []),
        selectField('Guide', s.guide.type, [['NONE', 'No Guide'], ['CIRCULAR', 'Circular'], ['RADIAL', 'Radial'], ['PARALLEL', 'Parallel'], ['GRID', 'Grid'], ['ISO', 'Isometric']] as [GuideType, string][], (v) => { s.guide.type = v; }),
      );
      if (s.activeTool === 'erase') {
        bar.append(
          selectField('Eraser', s.eraser.mode, [['POINT', 'Point'], ['STROKE', 'Stroke'], ['SOFT', 'Soft']] as [EraserMode, string][], (v) => { s.eraser.mode = v; }),
          slider('Size', s.eraser.radius, 4, 120, 1, (v) => { s.eraser.radius = v; }, { def: 24 }),
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
        slider('Radius', s.sculpt.radius, 10, 200, 1, (v) => { s.sculpt.radius = v; }, { def: 50 }),
        slider('Strength', s.sculpt.strength, 0.05, 1, 0.05, (v) => { s.sculpt.strength = v; }, { def: 0.5 }),
      );
    } else if (s.mode === 'VERTEX') {
      bar.append(
        selectField('Brush', s.paint.brush, [['DRAW', 'Draw'], ['BLUR', 'Blur'], ['AVERAGE', 'Average'], ['SMEAR', 'Smear']] as [PaintBrush, string][], (v) => { s.paint.brush = v; }),
        colorField('Color', [...s.brush.vertexColor, 1], (rgb) => { s.brush.vertexColor = rgb; }),
        slider('Radius', s.paint.radius, 5, 150, 1, (v) => { s.paint.radius = v; }, { def: 40 }),
        slider('Strength', s.paint.strength, 0.05, 1, 0.05, (v) => { s.paint.strength = v; }),
      );
    } else if (s.mode === 'WEIGHT') {
      bar.append(
        slider('Weight', s.weight.target, 0, 1, 0.05, (v) => { s.weight.target = v; }),
        slider('Radius', s.weight.radius, 5, 150, 1, (v) => { s.weight.radius = v; }, { def: 40 }),
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
        ['INCREMENT', 'Increment'], ['GRID', 'Grid'], ['POINT', 'Vertex'],
        ['EDGE', 'Edge'], ['EDGE_CENTER', 'Edge Center'], ['EDGE_PERP', 'Edge Perpendicular'],
        ['SURFACE', 'Face Project'], ['FACE_CENTER', 'Face Center'], ['FACE_NEAREST', 'Face Nearest'],
        ['OBJECT', 'Object Origin'],
      ], (v) => { s.snap.mode = v as typeof s.snap.mode; this.app.savePrefs(); }),
      ...(['POINT', 'EDGE', 'EDGE_CENTER', 'EDGE_PERP'].includes(s.snap.mode) ? [
        selectField('', s.snap.strokeScope ?? 'ANY', [
          ['ANY', 'Any GP'], ['SELECTED', 'Selected only'],
        ], (v) => { s.snap.strokeScope = v as 'ANY' | 'SELECTED'; this.app.savePrefs(); },
        ),
      ] : []),
    );

    // Viewport shading, pushed to the far right the way Blender parks it
    // at the end of the 3D-view header. `.grow` eats the slack between.
    const shadings: [ViewportShading, IconName, string][] = [
      ['WIREFRAME', 'shadeWire', 'Wireframe — meshes as edges only'],
      ['SOLID', 'shadeSolid', 'Solid — flat studio light, world ignored (modelling view)'],
      ['MATERIAL', 'shadeMaterial', 'Material preview — world background + IBL, no scene lights'],
      ['RENDERED', 'shadeRendered', 'Rendered — world plus the scene\u2019s own lights and shadows'],
    ];
    bar.append(el('div', { class: 'grow' }), el('div', { class: 'sep' }));
    for (const [mode, iconName, title] of shadings) {
      bar.append(btn(icon(iconName), () => this.app.setShading(mode),
        { active: s.shading === mode, title }));
    }
  }

  // ------------------------------------------------------------ toolbar

  private buildToolbar(): void {
    const { ctx } = this.app;
    const bar = $('toolbar');
    bar.replaceChildren();
    for (const [id, iconName, title] of TOOLS_BY_MODE[ctx.settings.mode]) {
      // the editable-mesh trio is a distinct family — rule it off
      if (id === 'polypen') bar.append(el('div', { class: 'tool-sep' }));
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
          { label: 'Selection to Cursor', icon: 'target', do: run(() => ops.snapToCursor(ctx)) },
          { label: 'Selection to Grid', icon: 'wireframe', do: run(() => ops.snapToGrid(ctx, snapIncrement(ctx.settings))) },
          { label: 'Selection to Cursor (Keep Offset)', icon: 'target', do: run(() => ops.snapToCursor(ctx, true)) },
          { label: 'Selection to Active', icon: 'pin', do: run(() => ops.snapSelectionToActive(ctx)) },
          { sep: true },
          { label: 'Cursor to Selected', icon: 'cursorArrow', do: run(() => ops.snapCursorToSelection(ctx)) },
          { label: 'Cursor to World Origin', icon: 'target', do: run(() => ops.snapCursorToWorldOrigin(ctx)) },
          { label: 'Cursor to Grid', icon: 'wireframe', do: run(() => ops.snapCursorToGrid(ctx, snapIncrement(ctx.settings))) },
          { label: 'Cursor to Active', icon: 'pin', do: run(() => ops.snapCursorToActive(ctx)) },
          { sep: true },
          { label: 'Selection to Stroke Start', icon: 'play', do: run(() => ops.snapSelectionToStrokeEnd(ctx, 'start')) },
          { label: 'Selection to Stroke End', icon: 'play', do: run(() => ops.snapSelectionToStrokeEnd(ctx, 'end')) },
          { label: 'Cursor to Stroke Start', icon: 'play', do: run(() => ops.snapCursorToStrokeEnd(ctx, 'start')) },
          { label: 'Cursor to Stroke End', icon: 'play', do: run(() => ops.snapCursorToStrokeEnd(ctx, 'end')) },
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
      { label: 'Group under empty', action: 'groupToEmpty' },
      {
        label: 'Export selection as…',
        items: EXPORT_FORMAT_LABELS.map(([id, label]) => ({
          label, do: () => this.app.export3D(id, true),
        })),
      },
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
        label: 'Subdivide', disabled: !refs.some((r) => r.kind === 'POLY'),
        do: () => {
          ctx.pushUndo();
          for (const r of refs) {
            if (r.kind !== 'POLY') continue;
            const pm = ctx.scene.polyMeshes.find((p) => p.id === r.id);
            if (pm) subdividePolyMesh(pm);
          }
          this.refresh();
        },
      },
      {
        label: 'Smooth', disabled: !refs.some((r) => r.kind === 'POLY'),
        do: () => {
          ctx.pushUndo();
          for (const r of refs) {
            if (r.kind !== 'POLY') continue;
            const pm = ctx.scene.polyMeshes.find((p) => p.id === r.id);
            if (pm) smoothPolyMesh(pm, 0.5, 2);
          }
          this.refresh();
        },
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
          { label: 'Selection to Cursor', icon: 'target', do: () => { ctx.pushUndo(); snapSelectionToCursor(ctx.scene); this.afterObjectOp(); } },
          { label: 'Selection to Grid', icon: 'wireframe', do: () => { ctx.pushUndo(); snapSelectionToGrid(ctx.scene, snapIncrement(ctx.settings)); this.afterObjectOp(); } },
          { label: 'Selection to Cursor (Keep Offset)', icon: 'target', do: () => { ctx.pushUndo(); snapSelectionToCursor(ctx.scene, true); this.afterObjectOp(); } },
          { label: 'Selection to Active', icon: 'pin', do: () => { ctx.pushUndo(); snapSelectionToActive(ctx.scene, this.app.getLastPicked()); this.afterObjectOp(); } },
          { sep: true },
          { label: 'Cursor to Selected', icon: 'cursorArrow', do: () => { ctx.pushUndo(); snapCursorToSelectionMedian(ctx.scene, selectionPivot(ctx.scene)); this.afterObjectOp(); } },
          { label: 'Cursor to World Origin', icon: 'target', do: () => { ctx.pushUndo(); snapCursorToWorldOrigin(ctx.scene); this.afterObjectOp(); } },
          { label: 'Cursor to Grid', icon: 'wireframe', do: () => { ctx.pushUndo(); snapCursorToGrid(ctx.scene, snapIncrement(ctx.settings)); this.afterObjectOp(); } },
          { label: 'Cursor to Active', icon: 'pin', do: () => { ctx.pushUndo(); snapCursorToActive(ctx.scene, this.app.getLastPicked()); this.afterObjectOp(); } },
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

  /**
   * Scroll offsets of the sidebar's scrollable regions, carried across a
   * rebuild.
   *
   * Panels are rebuilt from scratch on every refresh (by design — see
   * CLAUDE.md), which means the scrolling elements are NEW elements, and a
   * new element starts at scrollTop 0. Selecting an object triggers a
   * refresh, so the outliner threw you back to the top the instant you
   * clicked anything below the fold — and the thing you had just clicked
   * scrolled out from under the pointer. Grouping made it obvious because it
   * lengthens the list, but any long scene had it.
   */
  private scrollMemory = new Map<string, number>();
  private static readonly SCROLLERS = ['.sidebar-outliner', '.props-content'];

  private rememberScroll(root: ParentNode): void {
    for (const sel of UI.SCROLLERS) {
      const node = root.querySelector(sel) as HTMLElement | null;
      if (node) this.scrollMemory.set(sel, node.scrollTop);
    }
  }

  private restoreScroll(root: ParentNode): void {
    for (const sel of UI.SCROLLERS) {
      const node = root.querySelector(sel) as HTMLElement | null;
      const at = this.scrollMemory.get(sel);
      if (!node || !at) continue;
      // The browser clamps this to the content height, so it is safe even
      // when the rebuild made the list shorter.
      node.scrollTop = at;
    }
  }

  private buildSidebar(): void {
    const { ctx } = this.app;
    const side = $('sidebar');
    this.rememberScroll(side);
    side.replaceChildren();

    // mode changes nudge the tab the way Blender's context tabs follow mode
    if (ctx.settings.mode !== this.lastMode) {
      this.lastMode = ctx.settings.mode;
      this.propsTab = ctx.settings.mode === 'OBJECT' ? 'object'
        : ctx.settings.mode === 'EDIT' ? 'data' : 'brush';
    }

    const tabs: { id: string; icon: IconName; title: string; build: () => HTMLElement[] }[] = [
      {
        id: 'scene', icon: 'globe', title: 'Scene — world · grid · background',
        build: () => [this.worldPanel(), this.measurePanel(), this.scenePanel()],
      },
      {
        id: 'object', icon: 'cube', title: 'Object — transform · material',
        build: () => [this.objectPropsPanel(), this.bakePanel()],
      },
      {
        id: 'brush', icon: 'brush', title: 'Brush & GP materials',
        build: () => [
          this.brushPanel(), this.stencilPanel(), this.materialsPanel(),
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
        id: 'actor', icon: 'actor', title: 'Actor — mannequin, physics & rigging',
        build: () => [this.actorPanel()],
      },
      {
        id: 'motion', icon: 'motion',
        title: 'Motion — describe how a character moves, and save it as a button',
        build: () => [this.motionPanel()],
      },
      {
        id: 'mods', icon: 'wrench', title: 'Modifiers, effects & constraints',
        build: () => [this.modifiersPanel(), this.effectsPanel(), this.constraintsPanel()],
      },
      {
        id: 'bindings', icon: 'boltCircle', title: 'Bindings — score · routes · MIDI/OSC/WS',
        build: () => [this.scorePanel(), this.routesPanel(), this.ioPanel()],
      },
      {
        id: 'mediamime', icon: 'camera', title: 'Capture — live landmarks & object rigging',
        build: () => [this.mmStreamsPanel(), this.mediamimePanel(), this.clipsPanel()],
      },
      {
        id: 'solvers', icon: 'variable', title: 'Solvers — splats · string art · wire art',
        build: () => [this.splatsPanel(), this.solverPanel()],
      },
      {
        id: 'agent', icon: 'sparkles', title: 'Agent — chat, tools, MCP/ACP link',
        build: () => [this.agentPanel(), this.agentSettingsPanel(), this.agentLinkPanel()],
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
    // brush/data/mods all read the active GP object directly (no
    // per-panel selection guard, unlike objectPropsPanel) — the scene can
    // have zero GP objects while staying in Object mode, so show a
    // placeholder instead of crashing on an undefined activeObject().
    const needsGP = ['brush', 'data', 'mods'].includes(active.id);
    if (needsGP && !ctx.scene.objects.length) {
      content.append(panel('No GP object', el('div', { class: 'row', text: 'Add or select a GP object to edit its brush, data, or modifiers.' })));
    } else {
      content.append(...active.build());
    }
    // Blender-style outliner: pinned above the tab strip, always visible
    // no matter which properties tab is open — object properties stay a
    // subpanel under the "Object" tab rather than living in the outliner.
    const outliner = el('div', { class: 'sidebar-outliner' }, this.objectsPanel());
    const tabsRow = el('div', { class: 'sidebar-tabsrow' }, strip, content);
    side.append(outliner, tabsRow);
    this.restoreScroll(side);
    this.revealSelectedRow(side);
  }

  /**
   * Bring the selected row into view when the selection changed elsewhere.
   *
   * Selecting in the VIEWPORT used to leave the outliner wherever it was, so
   * a scene of sixty objects would tell you nothing about what you had just
   * clicked. This only fires when the selection actually changed, and only
   * when the row is off screen — scrolling the list out from under someone
   * who is reading it is the bug this replaces, not a feature.
   */
  /** Frame-selection also reveals the row: the two questions ("where is it"
   *  and "which one is it") are asked at the same moment. */
  revealSelection(): void {
    this.revealedKey = '';
    this.revealSelectedRow($('sidebar'));
  }

  private revealSelectedRow(root: ParentNode): void {
    const scroller = root.querySelector('.sidebar-outliner') as HTMLElement | null;
    if (!scroller) return;
    const rows = [...scroller.querySelectorAll('.list-item.active')] as HTMLElement[];
    const row = rows[rows.length - 1];
    const key = row?.dataset.ref ?? '';
    if (key === this.revealedKey) return;
    this.revealedKey = key;
    if (!row) return;
    const top = row.offsetTop - scroller.offsetTop;
    const above = top < scroller.scrollTop;
    const below = top + row.offsetHeight > scroller.scrollTop + scroller.clientHeight;
    if (!above && !below) return;
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2 + row.offsetHeight / 2);
    this.scrollMemory.set('.sidebar-outliner', scroller.scrollTop);
  }

  /** Actor tab: the mannequin's shape, its physics, and its rig.
   *  Everything here is per-actor, so it needs one selected. */
  /**
   * The Motion panel: say what a character should do, in words.
   *
   * Deliberately its own panel rather than a section of the Agent chat. The
   * agent panel is a CONVERSATION; this is a control surface you come back
   * to and press repeatedly, and a grid of buttons inside a transcript makes
   * both of them worse. The Direct HUD keeps what it is good at — pointing
   * at the floor — and everything verbal lives here.
   */
  private motionPanel(): HTMLElement {
    const { ctx } = this.app;
    const actors = ctx.scene.actors;
    if (!actors.length) {
      return panel('Motion', el('div', { class: 'row', text: 'Add an actor to direct.' }));
    }
    const actor = actors.find((a) => a.select) ?? actors[0];
    const macros = ctx.scene.motionMacros ?? [];
    const status = this.app.motionStatus();
    const touch = (): void => { ctx.requestRender(); };

    const run = (prompt: string, seconds?: number, action?: string): void => {
      if (action) {
        const verb = MOVE_ACTIONS.find((m) => m.id === action);
        // a verb that needs a point cannot fire from a button — arm it in
        // the HUD instead of guessing where the user meant
        if (verb && verb.kind === 'STOP') {
          runMoveAction(ctx.scene, actor.id, verb, null, ctx.settings.upAxis === 'Z');
        } else if (verb) {
          ctx.settings.directAction = verb.id;
          this.app.setStatusHint(`${verb.label} — now click the floor`);
        }
      }
      if (prompt.trim()) {
        void this.app.generateMotion(
          actor.id, prompt, seconds && seconds > 0 ? seconds : this.genSeconds, this.genBackend);
      }
    };

    const macroRows = macros.flatMap((mac) => [
      fieldRow('', el('div', { class: 'field-group' },
        btn(mac.label, () => run(mac.prompt, mac.seconds, mac.action),
          { title: mac.prompt + (mac.action ? ` · then ${mac.action}` : '') }),
        btn(icon('pencil'), () => {
          this.macroEdit = this.macroEdit === mac.id ? 0 : mac.id;
          this.refresh();
        }, { cls: 'icon-btn', title: 'Edit this button' }),
        btn(icon('trash'), () => {
          ctx.pushUndo();
          ctx.scene.motionMacros = macros.filter((m) => m.id !== mac.id);
          touch();
          this.refresh();
        }, { cls: 'icon-btn', title: 'Remove' }),
      ), { full: true }),
      ...(this.macroEdit === mac.id ? [
        fieldRow('Label', textField(mac.label, (v: string) => {
          ctx.pushUndo(); mac.label = v; touch(); this.refresh();
        })),
        fieldRow('Says', textField(mac.prompt, (v: string) => {
          ctx.pushUndo(); mac.prompt = v; touch();
        })),
        fieldRow('Seconds', numField('', mac.seconds ?? 0, (v) => {
          ctx.pushUndo(); mac.seconds = Math.max(0, v); touch();
        }, 0.5)),
        fieldRow('Then', selectField('', mac.action ?? '', [
          ['', '(nothing)'],
          ...MOVE_ACTIONS.map((m) => [m.id, m.label] as [string, string]),
        ], (v) => { ctx.pushUndo(); mac.action = v || undefined; touch(); this.refresh(); })),
      ] : []),
    ]);

    return panel(`Motion — ${actor.name}`,
      ...(actors.length > 1 ? [
        fieldRow('Character', selectField('', String(actor.id),
          actors.map((a) => [String(a.id), a.name] as [string, string]),
          (v) => {
            for (const a of actors) a.select = a.id === Number(v);
            this.refresh();
          })),
      ] : []),

      el('div', { class: 'menu-header', text: 'Say it' }),
      fieldRow('', textField(this.genPrompt, (v: string) => { this.genPrompt = v; },
        'walk slowly and look around'), { full: true }),
      slider('Seconds', this.genSeconds, 0.5, 10, 0.5, (v) => { this.genSeconds = v; }, { def: 2 }),
      fieldRow('Using', selectField('', this.genBackend,
        this.app.motionBackendIds().map((b) => [b.id, b.label] as [string, string]),
        (v) => { this.genBackend = v; this.refresh(); })),
      ...(this.genBackend === 'remote' ? [
        fieldRow('Endpoint', textField(this.app.motionEndpoint(),
          (v: string) => { this.app.setMotionEndpoint(v); },
          'https://\u2026 a service holding real weights')),
      ] : []),
      fieldRow('', btn('Generate', () => run(this.genPrompt, this.genSeconds),
        { title: 'Make a clip from the description and put it on a mixer layer' }),
        { full: true }),
      ...(this.genBackend === 'ardy' ? [
        el('div', { class: 'panel-hint', text: status?.busy && status.text
          ? status.text
          : `On-device model \u2014 ${status?.hint ?? ''}. Text only: it makes the `
            + 'motion, where to go is still the character\u2019s own job.' }),
        ...(status?.notices ?? []).map((n) => el('div', { class: 'panel-note', text: n })),
      ] : []),

      el('div', { class: 'menu-header', text: 'Buttons' }),
      el('div', { class: 'panel-hint', text: 'Saved with the scene, so a piece '
        + 'travels with its own vocabulary.' }),
      ...macroRows,
      fieldRow('', el('div', { class: 'field-group' },
        btn('Back to the walk cycle', () => this.app.clearGeneratedMotion(actor.id),
          { title: 'Drop the generated motion and hand the body back to the '
            + 'procedural gait' }),
      ), { full: true }),
      fieldRow('', btn('+ Button', () => {
        ctx.pushUndo();
        ctx.scene.motionMacros = [...macros, {
          id: nextMacroId(ctx.scene),
          label: this.genPrompt.trim().slice(0, 18) || 'New',
          prompt: this.genPrompt,
          seconds: this.genSeconds,
        }];
        touch();
        this.refresh();
      }, { title: 'Save what you just typed as a reusable button' }), { full: true }),
    );
  }

  private actorPanel(): HTMLElement {
    const { ctx } = this.app;
    const scene = ctx.scene;
    const picked = this.app.getLastPicked();
    const actor = scene.actors.find((a) => a.select)
      ?? (picked?.kind === 'ACTOR' ? scene.actors.find((a) => a.id === picked.id) : undefined);
    if (!actor) {
      return panel('Actor',
        el('div', { class: 'row', text: 'Select an actor, or add one from the Add menu.' }),
        fieldRow('', btn('Add actor', () => this.app.addActor()), { full: true }));
    }
    const touch = () => ctx.requestRender();
    const ph = actor.physics;
    const rig = actor.rig;
    const streamOpts: [string, string][] = [
      ['', '(none)'],
      ...scene.mmStreams.map((st) => [String(st.id), `${st.name} · ${st.kind.toLowerCase()}`] as [string, string]),
    ];

    return panel(`Actor — ${actor.name}`,
      el('div', { class: 'menu-header', text: 'Look' }),
      fieldRow('Avatar', selectField('', actor.look ?? 'DEFAULT', LOOK_OPTIONS,
        (v) => {
          ctx.pushUndo();
          actor.look = v as NonNullable<typeof actor.look>;
          // A look is a STARTING POINT: its colour is applied once, here,
          // rather than enforced every frame, so recolouring afterwards
          // sticks instead of being silently overwritten.
          actor.color = [...ACTOR_LOOKS[actor.look].color] as Vec3;
          touch();
          this.refresh();
        }), { }),
      el('div', { class: 'panel-hint', text: ACTOR_LOOKS[actor.look ?? 'DEFAULT'].hint }),
      ...(() => {
        const avatars = this.app.avatarChoices();
        if (!avatars.length) return [];
        return [
          fieldRow('Avatar model', selectField('', String(actor.avatar ?? ''), [
            ['', '(none — use the mannequin)'],
            ...avatars.map((v) => [String(v.id), v.name] as [string, string]),
          ], (v) => this.app.setActorAvatar(actor.id, v ? Number(v) : null))),
          el('div', { class: 'panel-hint', text: actor.avatar != null
            ? 'The avatar wears this actor\u2019s motion. Its transform is the '
              + 'actor\u2019s, so move the actor, not the model.'
            : 'A VRM imported into the scene can wear this skeleton\u2019s motion.' }),
        ];
      })(),
      fieldRow('Shape', selectField('', actor.shape, [
        ['BOTH', 'Body + rig'], ['CAPSULE', 'Body only'], ['STICK', 'Rig only'],
      ], (v) => { actor.shape = v; touch(); })),
      fieldRow('Color', colorField('', [...actor.color, 1], (rgb) => { actor.color = rgb; touch(); })),
      slider('Opacity', actor.opacity, 0, 1, 0.01, (v) => { actor.opacity = v; touch(); }, { def: 1 }),

      el('div', { class: 'menu-header', text: 'Physics' }),
      checkbox('Simulate', ph.enabled, (v) => { ctx.pushUndo(); ph.enabled = v; touch(); this.refresh(); },
        'run the ragdoll — gravity, bones, joint limits, floor'),
      slider('Gravity', ph.gravity, 0, 30, 0.1, (v) => { ph.gravity = v; }, { def: 9.81 }),
      slider('Damping', ph.damping, 0.8, 1, 0.001, (v) => { ph.damping = v; }, { def: 0.98,
        title: 'velocity kept per step — lower is more like moving through syrup' }),
      slider('Tone', ph.tone, 0, 0.5, 0.005, (v) => { ph.tone = v; }, { def: 0.06,
        title: 'muscle tone: pull back toward the rest pose. 0 = a bag of bones' }),
      slider('Iterations', ph.iterations, 1, 24, 1, (v) => { ph.iterations = Math.round(v); }, { def: 8,
        title: 'constraint passes per step — more is stiffer and slower' }),
      checkbox('Floor', ph.floor, (v) => { ph.floor = v; }, 'collide with the ground plane'),
      checkbox('Hinges', ph.hinges !== false, (v) => {
        ctx.pushUndo(); ph.hinges = v; touch(); this.refresh();
      }, 'knees bend forward, elbows back. Off, the limbs are double-jointed '
        + 'and snap between mirror poses as they move — wrong for a person, '
        + 'interesting for everything else'),

      el('div', { class: 'menu-header', text: 'Control' }),
      fieldRow('', btn(
        this.app.possessedActor() === actor.id ? 'Release (Enter / Esc)' : 'Possess — take the controls',
        () => this.app.togglePossess(actor.id),
        {
          cls: this.app.possessedActor() === actor.id ? 'active' : '',
          title: 'Walk this character yourself: mouse looks, WASD moves, '
            + 'Shift runs, V switches 1st/3rd person, R records the walk as '
            + 'a clip, Enter accepts and Esc returns the camera',
        }), { full: true }),
      ...(this.app.possessedActor() === actor.id ? [
        fieldRow('View', selectField('', this.app.possessView(), [
          ['THIRD', 'Third person'],
          ['FIRST', 'First person'],
        ], (v) => this.app.setPossessView(v as 'FIRST' | 'THIRD'))),
        fieldRow('', btn(
          this.app.mmRecording({ kind: 'OBJECT', ref: { kind: 'ACTOR', id: actor.id } })
            ? 'Stop recording (R)' : 'Record this walk (R)',
          () => this.app.mmRecordToggle({ kind: 'OBJECT', ref: { kind: 'ACTOR', id: actor.id } }),
          {
            cls: this.app.mmRecording({ kind: 'OBJECT', ref: { kind: 'ACTOR', id: actor.id } })
              ? 'active' : '',
            title: 'Record the path you walk as a clip. Bake it to a GP '
              + 'stroke in the MediaMime panel, smooth or sculpt it like any '
              + 'other stroke, then give the actor a Follow Path constraint '
              + 'on it — the gait re-walks the loop on its own.',
          }), { full: true }),
      ] : []),
      fieldRow('', btn(
        this.app.mmRecording({ kind: 'ACTOR_POSE', id: actor.id })
          ? 'Stop recording the pose' : 'Record performance (pose)',
        () => this.app.mmRecordToggle({ kind: 'ACTOR_POSE', id: actor.id }),
        {
          cls: this.app.mmRecording({ kind: 'ACTOR_POSE', id: actor.id }) ? 'active' : '',
          title: 'Record the SKELETON over time, in the actor\u2019s own frame — '
            + 'the performance rather than the path. Play it back on a CLIP '
            + 'mixer layer, on this actor or any other with the same joints.',
        }), { full: true }),

      el('div', { class: 'menu-header', text: 'Go to' }),
      ...(actor.steer ? (() => {
        const st = actor.steer!;
        const status = st.stuck ? ' — stuck'
          : st.arrived && st.mode !== 'NONE' ? ' — arrived'
            : st.mode === 'NONE' ? '' : ' — walking';
        return [
          fieldRow('Goal', selectField('', st.mode, [
            ['NONE', 'Nowhere' + (st.mode === 'NONE' ? '' : '')],
            ['POINT', 'A point' + (st.mode === 'POINT' ? status : '')],
            ['OBJECT', 'An object' + (st.mode === 'OBJECT' ? status : '')],
          ], (v) => {
            ctx.pushUndo();
            st.mode = v as typeof st.mode;
            st.arrived = false;
            st.stuck = false;
            touch();
            this.refresh();
          })),
          ...(st.mode === 'POINT' ? [
            fieldRow('', btn('Send to the 3D cursor', () => {
              this.app.actorGoTo(actor.id, [...ctx.scene.cursor] as Vec3);
            }, { title: 'Place the 3D cursor where you want the character to '
              + 'end up (Shift+RMB), then send it there. It walks — the gait '
              + 'is driven by the root moving, so this is the same animation '
              + 'as a path or as driving it yourself.' }), { full: true }),
          ] : []),
          ...(st.mode === 'OBJECT' ? [
            this.objectPickerField('Target',
              () => (st.target ?? null) as import('../tools/objects').ObjRef | null,
              (v) => {
                if (v) this.app.actorGoToObject(actor.id, v);
                else { st.target = null; this.refresh(); }
              },
              { kind: 'ACTOR', id: actor.id }),
          ] : []),
          ...(st.mode === 'NONE' ? [] : [
            slider('Speed', st.speed, 0.2, 4, 0.05, (v) => { st.speed = v; }, { def: 1.3,
              title: 'cruising speed, m/s. The gait is distance-phased, so '
                + 'this IS the cadence' }),
            slider('Turn rate', st.turnRate, 30, 720, 10,
              (v) => { st.turnRate = Math.round(v); }, { def: 200,
                title: 'degrees per second. Not instant on purpose: a body '
                  + 'that snaps round pivots under its own planted foot' }),
            slider('Stop within', st.stopDistance, 0.05, 2, 0.05,
              (v) => { st.stopDistance = v; }, { def: 0.35 }),
            slider('Slow from', st.slowRadius, 0.1, 4, 0.1,
              (v) => { st.slowRadius = v; }, { def: 1.2,
                title: 'start easing off this far out, so the last stride '
                  + 'shortens instead of the walk stopping dead' }),
            checkbox('Walk around things', st.avoid, (v) => {
              ctx.pushUndo(); st.avoid = v; touch(); this.refresh();
            }, 'probe ahead and sidestep. Steering, not pathfinding — it '
              + 'handles furniture in a room, not a maze'),
            fieldRow('', btn(st.arrived || st.stuck ? 'Clear goal' : 'Stop here',
              () => this.app.actorStop(actor.id),
              { title: 'Forget the destination' }), { full: true }),
          ]),
        ];
      })() : []),

      el('div', { class: 'menu-header', text: 'Generate' }),
      el('div', { class: 'panel-hint', text: 'Describing motion in words now '
        + 'lives in the Motion tab, together with the buttons you save.' }),

      el('div', { class: 'menu-header', text: 'Mixer' }),
      ...(actor.layers ?? []).flatMap((layer) => [
        fieldRow('', el('div', { class: 'field-group' },
          checkbox('', layer.enabled, (v) => {
            ctx.pushUndo(); layer.enabled = v; touch(); this.refresh();
          }, 'mute or unmute this layer'),
          selectField('', layer.source, SOURCE_LABELS.map(([v, l]) => [v, l]),
            (v) => { ctx.pushUndo(); layer.source = v as ActorLayerSource; touch(); this.refresh(); }),
          selectField('', layer.mask, MASK_LABELS.map(([v, l]) => [v, l]),
            (v) => { ctx.pushUndo(); layer.mask = v as typeof layer.mask; touch(); this.refresh(); }),
          btn(icon('trash'), () => {
            ctx.pushUndo();
            actor.layers = (actor.layers ?? []).filter((l) => l !== layer);
            touch();
            this.refresh();
          }, { cls: 'icon-btn', title: 'Remove this layer' }),
        ), { full: true }),
        slider(layer.name, layer.weight, 0, 1, 0.01,
          (v) => { layer.weight = v; }, { def: 1,
            title: 'how much of this source survives into the pose. Sources '
              + 'that want the same joint are blended by weight, not fought over' }),
        ...(layer.source === 'CLIP' ? [
          fieldRow('Clip', selectField('', String(layer.clipId ?? ''), [
            ['', '(none)'],
            ...ctx.scene.clips.filter((c) => c.joints?.length)
              .map((c) => [String(c.id), c.name] as [string, string]),
          ], (v) => {
            ctx.pushUndo();
            layer.clipId = v ? Number(v) : null;
            layer.phase = 0;
            layer.playing = true;
            touch();
            this.refresh();
          }), { }),
          slider('Speed', layer.speed ?? 1, 0.05, 4, 0.05,
            (v) => { layer.speed = v; }, { def: 1,
              title: '1 = the take\u2019s own tempo' }),
        ] : []),
      ]),
      ...(() => {
        const motions = this.app.modelMotions();
        if (!motions.length) return [];
        const opts: [string, string][] = [];
        for (const m of motions) {
          m.clips.forEach((c, i) => opts.push([`${m.meshId}:${i}`, `${m.name} — ${c}`]));
        }
        const key = { v: this.motionPick && opts.some(([o]) => o === this.motionPick)
          ? this.motionPick : opts[0][0] };
        return [
          fieldRow('Import', selectField('', key.v, opts, (v) => {
            this.motionPick = v;
            this.refresh();
          }), { }),
          fieldRow('', btn('Retarget onto this actor', () => {
            const [meshId, ci] = key.v.split(':');
            this.app.importMotion(Number(meshId), Number(ci), actor.id);
          }, { title: 'Sample the imported animation onto this skeleton as a '
            + 'pose clip, matched by bone name, rescaled about the feet and '
            + 'turned to face the way this actor faces. It lands as an '
            + 'ordinary clip on a new layer — trimmable, blendable, saved '
            + 'with the scene.' }), { full: true }),
        ];
      })(),
      fieldRow('', btn('+ Layer', () => {
        ctx.pushUndo();
        actor.layers = [...(actor.layers ?? []), {
          id: nextLayerId(actor), name: 'Clip', enabled: true,
          weight: 1, mask: 'ALL', source: 'CLIP', clipId: null,
        }];
        touch();
        this.refresh();
      }, { title: 'Add a mixer layer — a second source of motion, masked to part of the body' }),
        { full: true }),

      el('div', { class: 'menu-header', text: 'Gait' }),
      ...(actor.gait ? [
        checkbox('Walk', actor.gait.enabled, (v) => {
          ctx.pushUndo(); actor.gait!.enabled = v; touch(); this.refresh();
        }, 'procedural walk cycle — drives the feet wherever the root goes'),
        ...(actor.gait.enabled ? [
          slider('Stride', actor.gait.strideLength, 0.4, 2.5, 0.05,
            (v) => { actor.gait!.strideLength = v; }, { def: 1.4,
              title: 'ground covered per full cycle (two steps). The cycle is phased by DISTANCE, so this sets step length, not tempo' }),
          slider('Step height', actor.gait.stepHeight, 0, 0.4, 0.005,
            (v) => { actor.gait!.stepHeight = v; }, { def: 0.12 }),
          slider('Stance width', actor.gait.stanceWidth, 0, 0.6, 0.01,
            (v) => { actor.gait!.stanceWidth = v; }, { def: 0.22 }),
          slider('Duty', actor.gait.dutyFactor, 0.5, 0.9, 0.01,
            (v) => { actor.gait!.dutyFactor = v; }, { def: 0.62,
              title: 'fraction of the cycle a foot is planted — above 0.5 both feet overlap on the ground, which is what makes it a walk rather than a run' }),
          slider('Bob', actor.gait.bob, 0, 0.15, 0.005,
            (v) => { actor.gait!.bob = v; }, { def: 0.035 }),
          slider('Arm swing', actor.gait.armSwing, 0, 0.5, 0.01,
            (v) => { actor.gait!.armSwing = v; }, { def: 0.16 }),
          slider('Blend', actor.gait.strength, 0, 1, 0.05,
            (v) => { actor.gait!.strength = v; }, { def: 0.9,
              title: 'how hard the gait pulls the feet against physics' }),
        ] : []),
      ] : []),

      el('div', { class: 'menu-header', text: 'Rig' }),
      fieldRow('Mode', selectField('', rig.mode, [
        ['NONE', 'None (free ragdoll)'],
        ['MARKERS', 'Markers — 1:1 landmarks'],
        ['ANGLES', 'Angles — retarget directions'],
        ['IK', 'IK — end effectors'],
        ['MANUAL', 'Manual — drag / routes only'],
      ], (v) => { ctx.pushUndo(); rig.mode = v; touch(); this.refresh(); })),
      fieldRow('Stream', selectField('', String(rig.streamId ?? ''), streamOpts,
        (v) => { rig.streamId = v ? Number(v) : null; this.refresh(); })),
      ...(rig.mode === 'NONE' || rig.mode === 'MANUAL' ? [] : [
        fieldRow('', btn(`Auto-bind (${rig.bindings.length} joints)`, () => {
          ctx.pushUndo();
          rig.bindings = autoRig(actor, rig.streamId);
          this.refresh();
        }, { title: 'Bind joints to the standard 33-point pose landmarks by name' }), { full: true }),
        slider('Strength', rig.strength, 0, 1, 0.01, (v) => { rig.strength = v; }, { def: 1,
          title: 'how hard capture pulls the joints — below 1 the body lags, which reads as weight' }),
        slider('Smoothing', rig.smoothing, 0, 0.95, 0.01, (v) => { rig.smoothing = v; }, { def: 0.35,
          title: 'exponential smoothing on the captured targets — capture is noisy' }),
        checkbox('Match size', rig.matchScale, (v) => { rig.matchScale = v; },
          'rescale the captured body to this actor\u2019s size, about the performer\u2019s feet — without it a tall performer stretches the character and lifts it off the ground'),
      ]),
      ...(rig.mode !== 'NONE' && rig.mode !== 'MANUAL' && !rig.bindings.length ? [
        fieldRow('', el('div', { class: 'hint', text: 'No bindings yet — pick a stream and Auto-bind.' })),
      ] : []),

      checkbox('Draw target', !!actor.drawTarget, (v) => { actor.drawTarget = v; },
        'Placement: Surface then lands strokes on the body — a note pinned to '
        + 'a chest, an arrow along an arm. The strokes stay in world space '
        + 'unless the GP object is parented to a joint.'),

      el('div', { class: 'menu-header', text: 'Pose' }),
      fieldRow('', el('div', { class: 'row' },
        btn('Stance', () => this.app.setActorStance(actor.id, 'REST'),
          { title: 'the natural stance the skeleton is authored in' }),
        btn('T-pose', () => this.app.setActorStance(actor.id, 'T'),
          { title: 'arms straight out — the reference pose most rigs are built against' }),
        btn('A-pose', () => this.app.setActorStance(actor.id, 'A'),
          { title: 'arms at 45 degrees — kinder to the shoulder than a T' }),
      ), { full: true }),
      this.poseLibrary(actor),
      fieldRow('', el('div', { class: 'row' },
        btn('Reset pose', () => this.app.resetActor(actor.id),
          { title: 'Back to the rest stance, and clear the simulation velocity' }),
        btn(actor.joints.some((j) => j.pin) ? 'Unpin all' : 'Pin all', () => {
          ctx.pushUndo();
          const anyPinned = actor.joints.some((j) => j.pin);
          for (const j of actor.joints) j.pin = !anyPinned;
          touch(); this.refresh();
        }, { title: 'A pinned joint is held in place — the rest of the body hangs off it' }),
      ), { full: true }),
      el('div', { class: 'hint', text: `${actor.joints.length} joints · ${actor.bones.filter((b) => b.radius > 0).length} bones · ${actor.limits.length} limits` }),
      panelHint('Joints are particles and bones are distance constraints, so capture, dragging and physics all drive one solver.'),
    );
  }

  /** Measurements + display units. Lives in the Scene tab because it is a
   *  property of the whole document, not of a selection. */
  /**
   * The editor for ONE measurement: its look, and what each of its points is
   * stuck to.
   *
   * The per-point list is the whole reason a measurement is an object rather
   * than a HUD doodle. A point that is BOUND rides the thing it was snapped
   * to; a free one does not, and the difference decides whether a set of
   * dimensions survives the next time the blockout moves. So it is stated
   * per point, in words, with the target named — and undoing a binding is
   * one click, because a point pinned to the wrong wall is worse than a
   * point pinned to nothing.
   */
  private measureObjectRows(id: number): Node[] {
    const { ctx } = this.app;
    const scene = ctx.scene;
    const m = scene.measures.find((x) => x.id === id);
    if (!m) return [];
    const unit = ctx.settings.lengthUnit;
    const pts = worldPointsOf(scene, m);
    const area = measureArea(scene, m);

    const rows: Node[] = [
      el('div', { class: 'menu-sep' }),
      el('div', { class: 'menu-header', text: 'Measurement' }),
      el('div', {
        class: 'row',
        text: `${formatLength(measureLength(scene, m), unit)}${area > 0 ? ` · ${formatArea(area, unit)}` : ''} · ${m.points.length} points`,
      }),
      checkbox('Closed', !!m.closed, (v) => {
        ctx.pushUndo(); m.closed = v; this.refresh();
      }, 'join the last point back to the first: a perimeter and an enclosed AREA instead of a running length'),
      checkbox('Corner angles', m.angles !== false, (v) => { m.angles = v; }),
      checkbox('Freeze', !!m.locked, (v) => { m.locked = v; this.refresh(); },
        'stop it being dragged, so the reference the scene was scaled from cannot move by accident'),
      fieldRow('Ink', colorField('', [...(m.color ?? MEASURE_COLOR), 1], (rgb) => { m.color = rgb; })),
      el('div', {
        class: 'menu-header', text: 'Points',
        title: 'Place them with the Measure tool — the magnet decides what a point attaches to. '
          + 'Shift-click extends the selected measurement, C closes it, Backspace deletes the point under the pointer.',
      }),
    ];

    for (let i = 0; i < m.points.length; i++) {
      const p = m.points[i];
      const b = p.bind;
      const where = b
        ? `${b.kind.toLowerCase().replace('_', ' ')} on ${objectName(scene, b.target as ObjRef)}${b.joint ? ` · ${b.joint}` : ''}`
        : 'free';
      rows.push(el('div', { class: 'row' },
        el('span', { text: `${i + 1}`, class: 'dim' }),
        el('span', {
          class: 'grow', text: where,
          title: b
            ? 'this point is stuck to that object and moves with it'
            : 'this point stays where it is, whatever the scene does',
        }),
        el('span', {
          class: 'dim',
          text: i > 0 && pts[i] && pts[i - 1] ? formatLength(pts[i].distanceTo(pts[i - 1]), unit) : '',
          title: 'length of the leg reaching this point',
        }),
        ...(b ? [btn(icon('xMark'), () => {
          // unbinding keeps the point WHERE IT IS: the position it is
          // showing at is the one you were looking at, and a point that
          // jumped back to its stored free position on release would look
          // like the release moved it
          ctx.pushUndo();
          const world = pts[i];
          p.bind = null;
          p.pos = localPoint(m, world);
          this.refresh();
        }, { cls: 'icon-btn', title: 'Detach — leave it where it is, but stop it following' })] : []),
      ));
    }
    return rows;
  }

  private measurePanel(): HTMLElement {
    const { ctx } = this.app;
    const scene = ctx.scene;
    const unit = ctx.settings.lengthUnit;

    const rows: (Node | string)[] = [
      fieldRow('Units', selectField('', unit, [
        ['M', 'Metres'], ['CM', 'Centimetres'], ['MM', 'Millimetres'],
        ['FT', 'Feet'], ['IN', 'Inches'],
      ], (v) => { ctx.settings.lengthUnit = v; this.app.savePrefs(); this.refresh(); })),
    ];

    if (!scene.measures.length) {
      rows.push(fieldRow('', el('div', { class: 'hint', text: 'Pick the Measure tool, click two or more points, press Enter.' })));
    }

    for (const m of scene.measures) {
      const len = measureLength(scene, m);
      const area = measureArea(scene, m);
      const bound = m.points.filter((p) => p.bind).length;
      const nameInput = el('input', { type: 'text', class: 'grow', value: m.name }) as HTMLInputElement;
      nameInput.onchange = () => { m.name = nameInput.value; };
      nameInput.onkeydown = (e) => e.stopPropagation();

      // "this is really N units" -> rescale the whole scene
      const real = el('input', {
        type: 'text', value: '', placeholder: formatLength(len, unit).split(' ')[0],
        title: `Type the REAL length of this measurement and press Enter to rescale the whole scene. Currently ${formatLength(len, unit)}.`,
      }) as HTMLInputElement;
      real.style.width = '68px';
      real.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key !== 'Enter') return;
        const v = Number(real.value);
        if (!Number.isFinite(v) || v <= 0) { real.value = ''; return; }
        const res = this.app.scaleSceneToMeasure(m.id, toWorldLength(v, ctx.settings.lengthUnit));
        if (!res.ok) { real.value = ''; return; }
        this.refresh();
      };

      rows.push(el('div', { class: 'measure-row' },
        el('div', { class: 'row' },
          nameInput,
          btn(m.visible ? icon('eye') : icon('eyeOff'),
            () => { m.visible = !m.visible; ctx.requestRender(); this.refresh(); },
            { cls: 'icon-btn', title: 'Show in the viewport' }),
          btn(m.locked ? icon('lockClosed') : icon('lockOpen'),
            () => { m.locked = !m.locked; this.refresh(); },
            { cls: 'icon-btn', title: 'Freeze it, so a stray drag cannot move the reference the scene was scaled from' }),
          btn(icon('xMark'), () => {
            ctx.pushUndo();
            scene.measures = scene.measures.filter((x) => x.id !== m.id);
            ctx.requestRender(); this.refresh();
          }, { cls: 'icon-btn', title: 'Delete' }),
        ),
        el('div', { class: 'measure-len' },
          el('span', { class: 'measure-val', text: area > 0 ? formatArea(area, unit) : formatLength(len, unit) }),
          el('span', {
            text: `${m.points.length} pts${bound ? ` · ${bound} bound` : ''}`,
            title: bound
              ? `${bound} of ${m.points.length} points are stuck to geometry and follow it`
              : 'no point is attached to anything — this ruler stays put when the scene moves',
          }),
          el('span', { class: 'grow' }),
          el('span', { class: 'measure-set', text: 'is really', title: 'Rescale the scene so this measurement equals the length you type' }),
          real,
        ),
      ));
    }

    return panel('Measure', ...rows,
      panelHint('Typing a real length rescales every root object, camera, trigger radius and measurement at once.'));
  }

  /** Scene tab: the world — what surrounds the scene and lights it.
   *  Blender's World properties, trimmed to the modes that matter here.
   *  Every mode ends up as one equirect/cube source in WorldManager, so
   *  the per-mode fields below are just different ways of authoring it. */
  private worldPanel(): HTMLElement {
    const { ctx } = this.app;
    const w = ctx.scene.world;
    // NOT ctx.requestRender(): that is markDirty on the GP renderer, which
    // rebuilds every layer's stroke ribbons and earcut fills. Nothing about
    // the sky touches grease-pencil geometry, and paying for a full rebuild
    // on every pixel of a slider drag is what made these sliders stutter and
    // halt while the Lighting ones (which ask for no such thing) stayed
    // smooth. The world re-derives itself from scene data every frame — it
    // compares its own key — so an edit needs no notification at all.
    const touch = () => { /* the frame loop already re-reads the world */ };
    // The world is scene data, so edits are undoable — but a slider drag
    // fires per pixel, and one undo step per pixel is useless. Push once
    // on the first edit of a burst, the way the other live fields do.
    const edit = <T>(fn: () => T): T => { const r = fn(); touch(); return r; };

    const rows: (Node | string)[] = [
      fieldRow('Mode', selectField('', w.mode, [
        ['SOLID', 'Solid color'],
        ['GRADIENT', 'Gradient'],
        ['EQUIRECT', 'Environment image'],
        ['VIDEO', 'Video / live'],
        ['SKY', 'Physical sky'],
      ], (v) => { ctx.pushUndo(); w.mode = v; touch(); this.refresh(); })),
    ];

    // Shown in EVERY mode, because it is the viewport background in every
    // mode: the world's own colour in Solid, and the fallback that Solid /
    // Wireframe shading and a hidden background fall back TO in the others.
    // Scene used to carry a second copy of this as a view pref; they were one
    // value under two names and could drift (a holdout stroke paints this
    // colour, and it took whichever copy it was handed).
    rows.push(fieldRow('Color', tip(colorField('', [...w.color, 1],
      (rgb) => { this.app.setBackground(rgb); }),
      w.mode === 'SOLID' ? 'the world itself'
        : 'seen in Solid and Wireframe shading, and whenever the background is hidden')));
    if (w.mode === 'GRADIENT') {
      rows.push(
        fieldRow('Sky', colorField('', [...w.skyColor, 1], (rgb) => edit(() => { w.skyColor = rgb; }))),
        fieldRow('Ground', colorField('', [...w.groundColor, 1], (rgb) => edit(() => { w.groundColor = rgb; }))),
      );
    } else if (w.mode === 'EQUIRECT') {
      const img = imageById(ctx.scene, w.imageId);
      rows.push(fieldRow('Image', el('div', { class: 'field-group' },
        selectField('', String(w.imageId ?? ''), [
          ['', img ? '(none)' : 'pick an image…'],
          ...ctx.scene.images.map((i) => [String(i.id), i.name] as [string, string]),
        ], (v) => { ctx.pushUndo(); w.imageId = v ? Number(v) : null; touch(); this.refresh(); }),
        btn(icon('photo'), () => this.filePick('image/*', (f) => {
          const rd = new FileReader();
          rd.onload = () => {
            ctx.pushUndo();
            const rec = createImage(f.name, String(rd.result));
            ctx.scene.images.push(rec);
            w.imageId = rec.id;
            touch();
            this.refresh();
          };
          rd.readAsDataURL(f);
        }), { cls: 'icon-btn', title: 'Load an equirectangular (2:1 lat-long) image' }),
      )),
      fieldRow('', el('div', { class: 'hint', text: 'Equirectangular / lat-long, 2:1 aspect — the same maps Blender takes.' })));
    } else if (w.mode === 'VIDEO') {
      rows.push(fieldRow('Source', selectField('', w.videoSource, [
        ['CAMERA', 'Live capture'], ['URL', 'File / URL'],
      ], (v) => { ctx.pushUndo(); w.videoSource = v; touch(); this.refresh(); })));
      if (w.videoSource === 'URL') {
        const input = el('input', { type: 'text', value: w.videoUrl, placeholder: 'https://… or load a file' }) as HTMLInputElement;
        input.onchange = () => { ctx.pushUndo(); w.videoUrl = input.value; touch(); this.refresh(); };
        rows.push(fieldRow('URL', el('div', { class: 'field-group' }, input,
          btn(icon('folder'), () => this.filePick('video/*', (f) => {
            // A local file becomes a blob: URL — it plays immediately and
            // streams (no base64 of a multi-GB drone clip), but it dies
            // with the tab, so it is deliberately NOT saved with the scene.
            ctx.pushUndo();
            w.videoUrl = URL.createObjectURL(f);
            touch();
            this.refresh();
          }), { cls: 'icon-btn', title: 'Open a local 360 video (session only — not saved with the scene)' }),
        )));
      } else {
        rows.push(fieldRow('', el('div', { class: 'hint', text: 'Uses the Capture tab\u2019s live camera. Start it there first.' })));
      }
      rows.push(fieldRow('', el('div', { class: 'hint', text: '360 footage must be equirectangular (2:1). Flat video will look stretched.' })));
    } else if (w.mode === 'SKY') {
      rows.push(
        slider('Sun elevation', w.sunElevation, -10, 90, 0.5, (v) => edit(() => { w.sunElevation = v; }), { def: 25 }),
        slider('Sun azimuth', w.sunAzimuth, -180, 180, 1, (v) => edit(() => { w.sunAzimuth = v; }), { def: 180 }),
        slider('Turbidity', w.turbidity, 1, 20, 0.1, (v) => edit(() => { w.turbidity = v; }), { def: 4, title: 'haze / aerosol — higher is milkier' }),
        slider('Rayleigh', w.rayleigh, 0, 5, 0.05, (v) => edit(() => { w.rayleigh = v; }), { def: 2, title: 'how blue the scattering makes the sky' }),
        checkbox('Sun disc', w.sunDisc !== false, (v) => edit(() => { w.sunDisc = v; }),
          'draw the disc itself — its light, glow and gradient stay either way'),
        checkbox('Stylize colours', !!w.skyStylize, (v) => { edit(() => { w.skyStylize = v; }); this.refresh(); },
          'keep the physical brightness — gradient, glow, the darkening overhead — and '
          + 'replace only the hue, so a pink or white sky still reads as a sky'),
        ...(w.skyStylize ? [
          fieldRow('Zenith', colorField('', [...(w.skyTintZenith ?? [0.55, 0.72, 1]), 1],
            (rgb) => edit(() => { w.skyTintZenith = rgb; }))),
          fieldRow('Horizon', colorField('', [...(w.skyTintHorizon ?? [1, 0.85, 0.72]), 1],
            (rgb) => edit(() => { w.skyTintHorizon = rgb; }))),
        ] : []),
      );
    }

    if (this.app.world.status === 'error') {
      rows.push(fieldRow('', el('div', { class: 'hint error', text: this.app.world.error })));
    } else if (this.app.world.status === 'loading') {
      rows.push(fieldRow('', el('div', { class: 'hint', text: 'Loading…' })));
    }

    rows.push(
      el('div', { class: 'menu-header', text: 'Placement' }),
      slider('Rotation', w.rotation * 180 / Math.PI, -180, 180, 1,
        (v) => edit(() => { w.rotation = v * Math.PI / 180; }), { def: 0, title: 'spin the environment about the world up axis' }),
      el('div', { class: 'menu-header', text: 'Lighting' }),
      checkbox('Lights the scene', w.lighting, (v) => { ctx.pushUndo(); w.lighting = v; touch(); },
        'use this world as image-based light on meshes (Material/Rendered shading)'),
      slider('Strength', w.strength, 0, 5, 0.05, (v) => edit(() => { w.strength = v; }), { def: 1 }),
      el('div', { class: 'menu-header', text: 'Viewport' }),
      checkbox('Show background', w.backgroundVisible, (v) => { ctx.pushUndo(); w.backgroundVisible = v; touch(); },
        'off = the world still lights the scene but the viewport keeps the flat background color'),
      slider('Background', w.backgroundIntensity, 0, 5, 0.05, (v) => edit(() => { w.backgroundIntensity = v; }), { def: 1, title: 'brightness of the visible background only' }),
      // Blur is three's own background pass; a moving source is drawn on our
      // sky mesh instead (see render/world.ts), where it has no equivalent.
      // Say so rather than leaving a slider that quietly does nothing.
      ...(w.mode === 'VIDEO' ? [
        fieldRow('Blur', el('div', { class: 'hint', text: 'not available for video / live sources' })),
      ] : [
        slider('Blur', w.blur, 0, 1, 0.01, (v) => edit(() => { w.blur = v; }), { def: 0, title: 'defocus the background without touching the light it casts' }),
      ]),
    );
    return panel('World', ...rows,
      panelHint('The world is only visible in Material and Rendered shading.'));
  }

  /** Scene tab: grid + background — the environment settings that used to
   *  live buried in the Settings dialog, now always visible above Objects. */
  private scenePanel(): HTMLElement {
    const { ctx } = this.app;
    const s = ctx.settings;
    const save = () => this.app.savePrefs();

    return panel('Scene',
      panelHint('Magnet Increment/Grid snap unit = the subdivision lines (Step ÷ Subdivisions).'),
      el('div', { class: 'menu-header', text: 'Physics' }),
      fieldRow('Engine', tip(selectField('', ctx.scene.physicsEngine ?? 'SIMPLE', [
        ['SIMPLE', 'Simple'],
        ['RAPIER', 'Rapier'],
      ], (v) => {
        ctx.pushUndo();
        ctx.scene.physicsEngine = v as 'SIMPLE' | 'RAPIER';
        // Both worlds are dropped, never handed over: they hold different
        // state (one has angular velocity and contact islands, the other has
        // neither) and a half-migrated body would just be a bug with physics.
        resetPhysics();
        this.refresh();
      }), 'Simple: every prop is a sphere and never rotates — small, no download. '
        + 'Rapier: real shapes, rolling and toppling, stacks that hold, and a '
        + 'deterministic fixed step (loads ~1 MB of wasm on first use).')),
      el('div', { class: 'menu-header', text: 'Grid' }),
      checkbox('Show grid', s.showGrid !== false, (v) => {
        s.showGrid = v; this.app.rebuildGrid(); save(); this.refresh();
      }, 'the floor grid and its axis lines'),
      el('div', { class: 'menu-header', text: 'Look' }),
      fieldRow('Style', tip(selectField('', ctx.scene.post?.preset ?? 'NONE', [
        ['NONE', 'Plain'], ['TURRELL', 'Light field'], ['SKETCH', 'Line drawing'],
        ['CUSTOM', 'Custom'],
      ], (v) => {
        ctx.pushUndo();
        const preset = v as NonNullable<GPScene['post']>['preset'];
        if (preset !== 'CUSTOM') {
          const p = POST_PRESETS[preset] ?? POST_PRESETS.NONE;
          const { fog, fogColor, ...rest } = p;
          ctx.scene.post = { preset, ...rest };
          // fog is WORLD data, not post — it has to be lit — so a look sets
          // it alongside rather than owning it
          ctx.scene.world.fog = fog;
          ctx.scene.world.fogColor = [...fogColor];
        } else if (ctx.scene.post) {
          ctx.scene.post.preset = 'CUSTOM';
        }
        this.refresh();
      }), 'Light field: bloom, a two-colour ramp and haze — a room made of '
        + 'light. Line drawing: ink edges from depth and normals over paper, '
        + 'for documentation. Both stay editable; changing anything makes it '
        + 'Custom.')),
      ...this.postRows(),

      el('div', { class: 'menu-header', text: 'Overlays' }),
      checkbox('Actor overlay', s.showActorOverlay !== false, (v) => {
        s.showActorOverlay = v; save();
      }, 'the characters\u2019 first-person monologue and the state badge over each head '
        + '\u2014 what they intend, and what is actually happening to them'),
      fieldRow('Step', numField('', s.gridStep, (v) => { s.gridStep = Math.max(0.01, v); this.app.rebuildGrid(); save(); }, 0.5, { def: 1, min: 0.01 })),
      fieldRow('Subdivisions', numField('', s.gridSubdivisions, (v) => { s.gridSubdivisions = Math.max(1, Math.round(v)); this.app.rebuildGrid(); save(); }, 1, { def: 10, min: 1 })),
      fieldRow('Subdivision style', selectField('', s.gridSubdivStyle, [
        ['dashed', 'Dashed'], ['solid', 'Solid'],
      ], (v) => { s.gridSubdivStyle = v as 'dashed' | 'solid'; this.app.rebuildGrid(); save(); })),
      checkbox('Auto color', !s.gridColor, (v) => {
        s.gridColor = v ? null : [...ctx.scene.world.color];
        this.app.rebuildGrid(); save(); this.refresh();
      }, 'grid color matches the background'),
      ...(s.gridColor ? [fieldRow('Color', colorField('', [...s.gridColor, 1], (rgb) => {
        s.gridColor = rgb; this.app.rebuildGrid(); save();
      }))] : []),
      el('div', { class: 'menu-header', text: 'Shading' }),
      checkbox('Strokes cast shadows', s.gpCastShadows, (v) => {
        s.gpCastShadows = v; save(); this.app.ctx.requestRender();
      }, 'GP strokes and fills occlude light — only visible once a light has Cast shadows on'),
      el('div', { class: 'menu-header', text: 'Helpers' }),
      checkbox('Plane helper', s.showPlaneHelper, (v) => { s.showPlaneHelper = v; save(); },
        'wireframe square showing the plane strokes/splats/etc. are actually landing on right now'),
      checkbox('Depth line', s.showDepthHelper, (v) => { s.showDepthHelper = v; save(); },
        'drop line + ring from the current placement point down to the ground plane'),
    );
  }

  /** N6: hierarchy outliner — tree by parent, drag-to-parent, dbl-click rename. */
  private outlinerCollapsed = new Set<string>();
  /** row a shift-range is measured from — the last plainly-clicked one */
  private outlinerAnchor: string | null = null;
  /** the row the outliner was last scrolled to, so it only chases a CHANGE */
  private revealedKey = '';

  private objectsPanel(): HTMLElement {
    const { ctx } = this.app;
    const scene = ctx.scene;

    // Blender's modifiers: Cmd/Ctrl EXTENDS the selection one row at a
    // time, Shift selects the RANGE from the last row you clicked. Shift
    // used to be the extend key here, which meant there was no range select
    // at all and the muscle memory was wrong besides.
    const toggleSel = (apply: (v: boolean) => void, cur: boolean, shift: boolean) => {
      ctx.pushUndo();
      // plain click on the ONE currently-selected row toggles it off
      // (otherwise a lone selected item — a splat especially, which has
      // no reliable empty-space viewport click to deselect — could never
      // be unselected from the outliner: clicking it just re-selected
      // the same thing)
      const solelySelected = cur && listSelectedObjects(scene).length === 1;
      // use the shared clear, NOT a hand-rolled loop: this one silently
      // missed scene.lights when lights became objects, so clicking a
      // light left the others selected — and with two selected the
      // solely-selected test below never fired, making lights impossible
      // to unselect from the outliner at all
      if (!shift) deselectAllObjects(scene);
      apply(shift ? !cur : !solelySelected);
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
    /**
     * Which rows an eye/lock click applies to.
     *
     * Everything BENEATH the row, always: a group whose contents stay
     * visible after you hide it is not a group, it is a decoration. And if
     * the row is part of a multi-selection, the whole selection — toggling
     * one of five selected objects and having four stay put is the thing
     * that makes people click five times.
     */
    const spread = (ref: ObjRef): ObjRef[] => {
      const sel = listSelectedObjects(scene);
      const inSel = sel.some((r: ObjRef) => r.kind === ref.kind && r.id === ref.id);
      const heads = inSel && sel.length > 1 ? sel : [ref];
      const out: ObjRef[] = [];
      for (const h of heads) out.push(h, ...descendantRefs(scene, h));
      return out;
    };

    const viewLockBtns = (
      ref: ObjRef,
      hidden: boolean, onHide: (v: boolean) => void,
      locked: boolean, onLock: (v: boolean) => void,
    ): Node[] => [
      btn(hidden ? icon('eyeOff') : icon('eye'), () => {
        ctx.pushUndo();
        onHide(!hidden);
        for (const r of spread(ref)) setObjectHidden(scene, r, !hidden);
        ctx.syncCanvases();
        ctx.requestRender();
        this.refresh();
      }, { cls: 'icon-btn', title: hidden ? 'Hidden (click to show)' : 'Visible (click to hide — applies to children and to the whole selection)' }),
      btn(locked ? icon('lockClosed') : icon('lockOpen'), () => {
        ctx.pushUndo();
        onLock(!locked);
        for (const r of spread(ref)) setObjectLockedFlag(scene, r, !locked);
        this.refresh();
      }, { cls: 'icon-btn', title: locked ? 'Locked (click to unlock)' : 'Unlocked (click to lock — blocks viewport click-select)' }),
    ];

    scene.objects.forEach((ob, i) => nodes.push({
      ref: { kind: 'GP', id: ob.id }, icon: icon('pencil'), name: ob.name, selected: !!ob.select,
      parent: ob.parent,
      onSelect: (e) => {
        scene.activeObject = i;
        this.app.setLastPicked({ kind: 'GP', id: ob.id });
        toggleSel((v) => { ob.select = v; }, !!ob.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        btn(icon('arrowDownTray'), () => this.app.exportActiveGP(), { cls: 'icon-btn', title: 'Export this GP object' }),
        ...viewLockBtns(
          { kind: 'GP', id: ob.id },
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
        toggleSel((v) => { c.select = v; }, c.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        btn(c.drawTarget ? icon('pencilSquare') : icon('dot'), () => { c.drawTarget = !c.drawTarget; ctx.syncCanvases(); this.refresh(); }, { cls: 'icon-btn', title: 'Draw target' }),
        btn(c.visible ? icon('eye') : icon('eyeOff'), () => { c.visible = !c.visible; ctx.syncCanvases(); this.refresh(); }, { cls: 'icon-btn' }),
      ],
      rename: (v) => { c.name = v; },
    });
    for (const m of scene.meshes) nodes.push({
      ref: { kind: 'MESH', id: m.id }, icon: m.kind === 'MODEL' ? icon('cubeModel') : m.kind === 'EMPTY' ? icon('target') : icon('cube'), name: m.name,
      selected: m.select, parent: m.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'MESH', id: m.id });
        toggleSel((v) => { m.select = v; }, m.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        colorField('', [...m.color, 1], (rgb) => { m.color = rgb; }),
        btn(m.drawTarget ? icon('pencilSquare') : icon('dot'), () => { m.drawTarget = !m.drawTarget; this.refresh(); }, { cls: 'icon-btn', title: 'Draw target' }),
        btn(m.wireframe ? icon('wireframe') : icon('square'), () => { m.wireframe = !m.wireframe; this.refresh(); }, { cls: 'icon-btn', title: 'Wireframe (reference look)' }),
        ...viewLockBtns(
          { kind: 'MESH', id: m.id },
          !m.visible, (v) => { m.visible = !v; },
          !!m.lock, (v) => { m.lock = v; },
        ),
      ],
      rename: (v) => { m.name = v; },
      // no inline Opacity here — the outliner is a tree, not a property
      // editor; opacity lives in Properties with the rest of the material
    });
    for (const p of scene.polyMeshes) nodes.push({
      ref: { kind: 'POLY', id: p.id }, icon: icon('wireframe'), name: p.name,
      selected: p.select, parent: p.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'POLY', id: p.id });
        toggleSel((v) => { p.select = v; }, p.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        colorField('', [...p.color, 1], (rgb) => { p.color = rgb; }),
        btn(p.drawTarget ? icon('pencilSquare') : icon('dot'), () => { p.drawTarget = !p.drawTarget; this.refresh(); }, { cls: 'icon-btn', title: 'Draw target' }),
        ...viewLockBtns(
          { kind: 'POLY', id: p.id },
          !p.visible, (v) => { p.visible = !v; },
          !!p.lock, (v) => { p.lock = v; },
        ),
      ],
      rename: (v) => { p.name = v; },
    });
    for (const pc of scene.paintClouds) nodes.push({
      ref: { kind: 'PCLOUD', id: pc.id }, icon: icon('droplet'), name: pc.name,
      selected: pc.select, parent: pc.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'PCLOUD', id: pc.id });
        toggleSel((v) => { pc.select = v; }, pc.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        el('span', { text: `${pc.points.length / 8}`, title: 'painted splats' }),
        btn('⬇.ply', () => {
          const buf = exportPaintCloudPly(scene, pc);
          if (!buf) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
          a.download = `${pc.name.replace(/\s+/g, '-')}.ply`;
          a.click();
          URL.revokeObjectURL(a.href);
        }, { cls: 'icon-btn', title: 'Export as 3DGS PLY (world-space, PlayCanvas/SuperSplat compatible)' }),
        ...viewLockBtns(
          { kind: 'PCLOUD', id: pc.id },
          !pc.visible, (v) => { pc.visible = !v; },
          !!pc.lock, (v) => { pc.lock = v; },
        ),
      ],
      rename: (v) => { pc.name = v; },
    });
    for (const a of scene.actors) nodes.push({
      ref: { kind: 'ACTOR', id: a.id }, icon: icon('actor'), name: a.name,
      selected: a.select, parent: a.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'ACTOR', id: a.id });
        toggleSel((v) => { a.select = v; }, a.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        el('span', { text: a.rig.mode === 'NONE' ? '' : a.rig.mode.toLowerCase(), title: 'rig mode' }),
        btn(a.physics.enabled ? icon('boltCircle') : icon('dot'),
          () => { a.physics.enabled = !a.physics.enabled; this.refresh(); },
          { cls: 'icon-btn', title: 'Simulate (ragdoll physics)' }),
        btn(a.drawTarget ? icon('pencilSquare') : icon('dot'),
          () => { a.drawTarget = !a.drawTarget; this.refresh(); },
          { cls: 'icon-btn', title: 'Draw target — Placement: Surface lands strokes on the body' }),
        ...viewLockBtns(
          { kind: 'ACTOR', id: a.id },
          !a.visible, (v) => { a.visible = !v; },
          !!a.lock, (v) => { a.lock = v; },
        ),
      ],
      rename: (v) => { a.name = v; },
    });
    for (const m of scene.measures) nodes.push({
      ref: { kind: 'MEASURE', id: m.id }, icon: icon('ruler'), name: m.name,
      selected: !!m.select, parent: m.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'MEASURE', id: m.id });
        toggleSel((v) => { m.select = v; }, !!m.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        el('span', {
          text: formatLength(measureLength(scene, m), ctx.settings.lengthUnit),
          title: 'total length',
        }),
        colorField('', [...(m.color ?? MEASURE_COLOR), 1], (rgb) => { m.color = rgb; }),
        ...viewLockBtns(
          { kind: 'MEASURE', id: m.id },
          !m.visible, (v) => { m.visible = !v; },
          !!m.lock, (v) => { m.lock = v; },
        ),
      ],
      rename: (v) => { m.name = v; },
    });
    for (const l of scene.lights) nodes.push({
      ref: { kind: 'LIGHT', id: l.id }, icon: icon('boltCircle'), name: l.name,
      selected: l.select, parent: l.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'LIGHT', id: l.id });
        toggleSel((v) => { l.select = v; }, l.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        el('span', { text: l.kind.toLowerCase(), title: 'light type' }),
        ...(l.kind !== 'AMBIENT' ? [btn(l.castShadow ? icon('circle') : icon('dot'),
          () => { l.castShadow = !l.castShadow; this.refresh(); },
          { cls: 'icon-btn', title: 'Cast shadows' })] : []),
        ...viewLockBtns(
          { kind: 'LIGHT', id: l.id },
          !l.visible, (v) => { l.visible = !v; },
          !!l.lock, (v) => { l.lock = v; },
        ),
      ],
      rename: (v) => { l.name = v; },
    });
    for (const s of scene.splats) nodes.push({
      ref: { kind: 'SPLAT', id: s.id }, icon: icon('sparkles'), name: s.name, selected: s.select,
      parent: s.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'SPLAT', id: s.id });
        toggleSel((v) => { s.select = v; }, s.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        btn(s.drawTarget ? icon('pencilSquare') : icon('dot'), () => { s.drawTarget = !s.drawTarget; this.refresh(); }, { cls: 'icon-btn', title: 'Draw target (GP surface placement raycasts the splat)' }),
        btn('⬇.ply', () => this.app.exportSplatPly(s.id), { cls: 'icon-btn', title: 'Export as 3DGS PLY (PlayCanvas/SuperSplat compatible)' }),
        ...viewLockBtns(
          { kind: 'SPLAT', id: s.id },
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
        toggleSel((v) => { t.select = v; }, !!t.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: [
        btn(t.zone ? icon('wave') : t.follow ? icon('link') : ctx.scene.mediamime.rigs.some((r) => r.target.kind === 'TRIGGER' && r.target.id === t.id) ? icon('camera') : icon('dot'),
          () => {}, { cls: 'icon-btn', title: t.zone ? 'Stroke zone' : t.follow ? 'Follows an object' : 'Static / capture-rigged' }),
        ...viewLockBtns(
          { kind: 'TRIGGER', id: t.id },
          !!t.hide, (v) => { t.hide = v; },
          !!t.lock, (v) => { t.lock = v; },
        ),
      ],
      rename: (v) => { t.name = v; },
    });
    for (const st of scene.mmStreams) nodes.push({
      ref: { kind: 'STREAM', id: st.id }, icon: icon('wave'), name: st.name, selected: !!st.select,
      parent: st.parent,
      onSelect: (e) => {
        this.app.setLastPicked({ kind: 'STREAM', id: st.id });
        toggleSel((v) => { st.select = v; }, !!st.select, !!(e?.metaKey || e?.ctrlKey));
      },
      extras: viewLockBtns(
        { kind: 'STREAM', id: st.id },
        !st.visible, (v) => { st.visible = !v; },
        !!st.lock, (v) => { st.lock = v; },
      ),
      rename: (v) => { st.name = v; },
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
    // The rows in the order they are actually DRAWN — a range select has to
    // follow what you can see, not the order the collections happen to be
    // stored in, and collapsed children are not on screen to be ranged over.
    const visible: ObjRef[] = [];
    const emit = (n: NodeDesc, depth: number) => {
      const key = keyOf(n.ref);
      const kids = children.get(key) ?? [];
      const collapsed = this.outlinerCollapsed.has(key);
      const item = el('div', { class: `list-item ${n.selected ? 'active' : ''}`, 'data-ref': key });
      item.style.paddingLeft = `${6 + depth * 14}px`;
      visible.push(n.ref);
      item.onclick = (e) => {
        const me = e as MouseEvent;
        const anchor = this.outlinerAnchor;
        if (me.shiftKey && anchor) {
          const a = visible.findIndex((r) => keyOf(r) === anchor);
          const b = visible.findIndex((r) => keyOf(r) === key);
          if (a >= 0 && b >= 0) {
            ctx.pushUndo();
            const [lo, hi] = a <= b ? [a, b] : [b, a];
            // Extends rather than replaces, which is what makes
            // shift-then-shift widen a range instead of restarting one.
            for (let i = lo; i <= hi; i++) setObjectSelected(scene, visible[i], true);
            ctx.syncCanvases();
            ctx.requestRender();
            this.app.refreshWidget();
            this.refresh();
            return;
          }
        }
        // The anchor only moves on a NON-range click, so a range is always
        // measured from where you started rather than from its own end.
        this.outlinerAnchor = key;
        n.onSelect(me);
      };
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

    // still a functional drop target (drop here to unparent), just no
    // longer a permanently-visible instruction row — see panelHint below
    const dropZone = el('div', { class: 'row', title: 'Drop here to unparent' });
    dropZone.ondragover = (e) => e.preventDefault();
    dropZone.ondrop = (e) => {
      e.preventDefault();
      const src = e.dataTransfer?.getData('text/tg-ref');
      if (src) reparent(src, null);
    };

    return panel('Objects',
      panelHint('Click selects · dbl-click renames · drag onto a row parents · drop here unparents · Ctrl+P/Alt+P · X deletes'),
      dropZone, ...rows);
  }

  // ---- shared material editor ---------------------------------------------

  /** The per-object appearance fields both TGMesh and TGPolyMesh carry —
   *  structurally compatible, so one editor serves both. */
  private materialTargetOf(ref: ObjRef): MaterialTarget | null {
    const { ctx } = this.app;
    if (ref.kind === 'MESH') return ctx.scene.meshes.find((m) => m.id === ref.id) ?? null;
    if (ref.kind === 'POLY') return ctx.scene.polyMeshes.find((p) => p.id === ref.id) ?? null;
    return null;
  }

  /** Copy-on-write (see core/gpdata ensureMaterial): an object with no
   *  material datablock gets one minted from its own legacy fields the
   *  first time you edit anything, so old objects keep rendering untouched
   *  until you actually change them. Undo is pushed only on that mint. */
  private ensureMaterial(target: MaterialTarget): TGMaterial {
    const { ctx } = this.app;
    const existing = materialById(ctx.scene, target.materialId);
    if (existing) return existing;
    ctx.pushUndo();
    return ensureMaterial(ctx.scene, target);
  }

  /** One texture slot row: image name, load/replace, clear, factor. */
  private slotRow(target: MaterialTarget, name: TextureSlotName, label: string): HTMLElement {
    const { ctx } = this.app;
    const mat = materialById(ctx.scene, target.materialId);
    const slot = mat?.slots[name];
    const img = slot ? imageById(ctx.scene, slot.imageId) : undefined;
    const load = () => this.filePick('image/*', (f) => {
      const reader = new FileReader();
      reader.onload = () => {
        const m = this.ensureMaterial(target);
        const image = createImage(f.name || `Image ${ctx.scene.images.length + 1}`, String(reader.result));
        ctx.scene.images.push(image);
        m.slots[name] = {
          imageId: image.id, offset: [0, 0], scale: [1, 1], rotation: 0, factor: 1, enabled: true,
        };
        ctx.requestRender();
        this.refresh();
      };
      reader.readAsDataURL(f);
    });
    return el('div', { class: 'row' },
      el('span', { class: 'grow', text: `${label}${img ? `: ${img.name}` : ''}` }),
      ...(slot ? [
        checkbox('', slot.enabled, (v) => {
          const m = this.ensureMaterial(target);
          if (m.slots[name]) m.slots[name]!.enabled = v;
          ctx.requestRender();
        }, 'use this texture'),
        slider('', slot.factor, 0, 1, 0.01, (v) => {
          const m = this.ensureMaterial(target);
          if (m.slots[name]) m.slots[name]!.factor = v;
          ctx.requestRender();
        }, { def: 1, title: 'blend against the flat value' }),
      ] : []),
      btn(icon('photo'), load, { cls: 'icon-btn', title: img ? 'Replace image…' : 'Load image…' }),
      ...(slot ? [btn(icon('xMark'), () => {
        const m = this.ensureMaterial(target);
        delete m.slots[name];
        ctx.requestRender();
        this.refresh();
      }, { cls: 'icon-btn', title: 'Clear slot' })] : []),
    );
  }

  /**
   * Shared material editor for mesh-family objects. Materials are scene
   * datablocks (scene.materials), so the picker here can point two objects
   * at the same material and editing it updates both.
   */
  private materialEditor(ref: ObjRef): Node[] {
    const { ctx } = this.app;
    const target = this.materialTargetOf(ref);
    if (!target) return [];
    const mat = materialById(ctx.scene, target.materialId);
    // display falls back to the object's own legacy fields until a
    // datablock exists (ensureMaterial copies exactly these)
    const view = {
      baseColor: mat?.baseColor ?? target.color,
      opacity: mat?.opacity ?? target.opacity,
      roughness: mat?.roughness ?? 0.9,
      metallic: mat?.metallic ?? 0,
      emission: mat?.emission ?? ([0, 0, 0] as Vec3),
      emissionStrength: mat?.emissionStrength ?? 0,
      unlit: mat ? mat.unlit : !!target.unlit,
      doubleSided: mat ? mat.doubleSided : target.doubleSided !== false,
      wireframe: mat ? mat.wireframe : target.wireframe,
      blend: mat?.blend ?? ('OPAQUE' as MaterialBlend),
    };
    const edit = (fn: (m: TGMaterial) => void) => {
      fn(this.ensureMaterial(target));
      ctx.requestRender();
    };
    const users = (id: number) =>
      ctx.scene.meshes.filter((m) => m.materialId === id).length
      + ctx.scene.polyMeshes.filter((p) => p.materialId === id).length;

    const picker = selectField('Material',
      String(target.materialId ?? ''),
      [
        ['', mat ? '(unassign)' : '(object settings)'],
        ...ctx.scene.materials.map((m) => [String(m.id), `${m.name}${users(m.id) > 1 ? ` (${users(m.id)})` : ''}`] as [string, string]),
      ],
      (v) => {
        ctx.pushUndo();
        target.materialId = v ? Number(v) : null;
        ctx.requestRender();
        this.refresh();
      });

    return [
      el('div', { class: 'menu-sep' }),
      el('div', { class: 'menu-header', text: 'Material' }),
      el('div', { class: 'row' },
        picker,
        btn(icon('plus'), () => {
          ctx.pushUndo();
          const m = createMaterialDB(`Material ${ctx.scene.materials.length + 1}`);
          ctx.scene.materials.push(m);
          target.materialId = m.id;
          ctx.requestRender();
          this.refresh();
        }, { cls: 'icon-btn', title: 'New material' }),
        ...(mat ? [btn(icon('duplicate'), () => {
          ctx.pushUndo();
          const copy: TGMaterial = JSON.parse(JSON.stringify(mat));
          copy.id = genId();
          copy.name = `${mat.name} copy`;
          ctx.scene.materials.push(copy);
          target.materialId = copy.id;
          ctx.requestRender();
          this.refresh();
        }, { cls: 'icon-btn', title: 'Duplicate material (make single-user)' })] : []),
      ),
      ...(mat ? [fieldRow('Name', (() => {
        const input = el('input', { type: 'text', value: mat.name, class: 'grow' }) as HTMLInputElement;
        input.onchange = () => { mat.name = input.value; this.refresh(); };
        return input;
      })())] : []),
      colorField('Base color', [...view.baseColor, 1], (rgb) => edit((m) => { m.baseColor = rgb; })),
      slider('Opacity', view.opacity, 0.02, 1, 0.01, (v) => edit((m) => { m.opacity = v; })),
      slider('Roughness', view.roughness, 0, 1, 0.01, (v) => edit((m) => { m.roughness = v; }), { def: 0.9 }),
      slider('Metallic', view.metallic, 0, 1, 0.01, (v) => edit((m) => { m.metallic = v; }), { def: 0 }),
      colorField('Emission', [...view.emission, 1], (rgb) => edit((m) => { m.emission = rgb; })),
      slider('Strength', view.emissionStrength, 0, 5, 0.05, (v) => edit((m) => { m.emissionStrength = v; }), { def: 0 }),
      selectField('Blend', view.blend, [
        ['OPAQUE', 'Opaque'], ['BLEND', 'Alpha blend'], ['ADD', 'Additive'], ['MULTIPLY', 'Multiply'],
      ] as [MaterialBlend, string][], (v) => edit((m) => { m.blend = v; })),
      checkbox('Unlit', view.unlit, (v) => edit((m) => { m.unlit = v; })),
      checkbox('Two-sided', view.doubleSided, (v) => edit((m) => { m.doubleSided = v; })),
      checkbox('Wireframe', view.wireframe, (v) => edit((m) => { m.wireframe = v; })),
      el('div', { class: 'menu-header', text: 'Textures' }),
      this.slotRow(target, 'base', 'Base color'),
      this.slotRow(target, 'roughness', 'Roughness'),
      this.slotRow(target, 'metallic', 'Metallic'),
      this.slotRow(target, 'normal', 'Normal'),
      this.slotRow(target, 'emission', 'Emission'),
      this.slotRow(target, 'alpha', 'Alpha'),
      this.slotRow(target, 'ao', 'Ambient occl.'),
    ];
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
        this.vecRow('Loc', () => t.translation.map((v) => +v.toFixed(3)), (i, v) => setAxis('translation', i, v)),
        this.vecRow('Rot', () => t.rotation.map((v) => +v.toFixed(3)), (i, v) => setAxis('rotation', i, v)),
        this.vecRow('Scale', () => t.scale.map((v) => +v.toFixed(3)), (i, v) => setAxis('scale', i, v)),
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
        this.vecRow('Loc', () => t.translation.map((v) => +v.toFixed(3)), (i, v) => { t.translation[i] = v; write(); }),
        this.vecRow('Rot', () => t.rotation.map((v) => +v.toFixed(3)), (i, v) => { t.rotation[i] = v; write(); }),
        this.vecRow('Scale', () => t.scale.map((v) => +v.toFixed(3)), (i, v) => { t.scale[i] = v; write(); }),
      );
    }

    if (ref.kind === 'MESH') {
      const m = ctx.scene.meshes.find((x) => x.id === ref.id)!;
      rows.push(
        tip(selectField('Lock', m.billboard ?? 'NONE', [
          ['NONE', 'World'], ['FACE_VIEW', 'Face view'], ['CAMERA', 'Camera (HUD)'],
        ], (v) => { m.billboard = v as typeof m.billboard; this.refresh(); }),
        'World: an ordinary object · Face view: always turned to the camera · '
        + 'Camera (HUD): Loc/Rot/Scale become a view-space offset, so keep z '
        + 'negative for depth'),
        checkbox('Draw target', m.drawTarget, (v) => { m.drawTarget = v; }),
        ...this.physicsRows(m),
        ...(m.kind === 'MODEL' || m.kind === 'EMPTY'
          ? [] // MODEL owns its imported materials; EMPTY has no surface
          : this.materialEditor(ref)),
      );
    } else if (ref.kind === 'MEASURE') {
      rows.push(...this.measureObjectRows(ref.id));
    } else if (ref.kind === 'POLY') {
      const p = ctx.scene.polyMeshes.find((x) => x.id === ref.id)!;
      rows.push(
        el('div', { class: 'menu-sep' }),
        el('div', { class: 'menu-header', text: 'Editable mesh' }),
        el('div', { class: 'row', text: `${p.vertices.length} verts · ${p.edges.length} edges · ${p.faces.length} faces` }),
        checkbox('Draw target', p.drawTarget, (v) => { p.drawTarget = v; }, 'faces become Surface-placement drawing targets'),
        el('div', { class: 'row' },
          selectField('UV', hasUV(p) ? 'SET' : 'AUTO', [
            ['AUTO', 'Auto (planar)'], ['SET', 'Unwrapped'],
          ], () => { /* display only — use the Unwrap buttons below */ }),
          btn('Unwrap…', () => {
            const r = ctx.canvas.getBoundingClientRect();
            popupMenu(r.left + 40, r.top + 40, [
              { label: 'Project from view', do: () => this.app.unwrapPoly(p.id, 'VIEW') },
              { label: 'Planar (dominant plane)', do: () => this.app.unwrapPoly(p.id, 'PLANAR') },
              { label: 'Cube', do: () => this.app.unwrapPoly(p.id, 'BOX') },
              { label: 'Cylinder', do: () => this.app.unwrapPoly(p.id, 'CYLINDER') },
              { label: 'Sphere', do: () => this.app.unwrapPoly(p.id, 'SPHERE') },
              { label: 'Reset (back to auto)', do: () => this.app.unwrapPoly(p.id, 'RESET') },
            ]);
          }, { title: 'persist UVs so painted textures stop sliding when the mesh changes' }),
        ),
        ...this.materialEditor(ref),
      );
    } else if (ref.kind === 'LIGHT') {
      const l = ctx.scene.lights.find((x) => x.id === ref.id)!;
      const spot = l.kind === 'SPOT';
      const positional = l.kind === 'POINT' || spot;
      rows.push(
        el('div', { class: 'menu-sep' }),
        el('div', { class: 'menu-header', text: 'Light' }),
        fieldRow('Type', selectField('', l.kind, [
          ['AMBIENT', 'Ambient'], ['SUN', 'Sun (directional)'], ['POINT', 'Point'], ['SPOT', 'Spot'],
        ], (v) => { ctx.pushUndo(); l.kind = v as typeof l.kind; this.refresh(); })),
        el('div', { class: 'row' },
          colorField('Color', [...l.color, 1], (rgb) => { l.color = rgb; }),
          slider('Power', l.intensity, 0, l.kind === 'POINT' || spot ? 200 : 5, 0.05,
            (v) => { l.intensity = v; }, { def: l.kind === 'AMBIENT' ? 0.9 : l.kind === 'SUN' ? 1.4 : 20 }),
        ),
        ...(positional ? [
          fieldRow('Distance', numField('', l.distance ?? 0, (v) => { l.distance = Math.max(0, v); }, 0.5, { def: 0 })),
          fieldRow('Decay', slider('', l.decay ?? 2, 0, 4, 0.05, (v) => { l.decay = v; }, { def: 2 })),
        ] : []),
        ...(spot ? [
          fieldRow('Cone', slider('', l.angle ?? Math.PI / 6, 0.05, Math.PI / 2, 0.01, (v) => { l.angle = v; }, { def: Math.PI / 6 })),
          fieldRow('Penumbra', slider('', l.penumbra ?? 0.2, 0, 1, 0.01, (v) => { l.penumbra = v; }, { def: 0.2 })),
        ] : []),
        ...(l.kind === 'AMBIENT' ? [] : [
          el('div', { class: 'menu-header', text: 'Shadow' }),
          checkbox('Cast shadows', l.castShadow, (v) => { l.castShadow = v; this.refresh(); },
            'off by default — each shadow-casting light costs an extra depth pass'),
          ...(l.castShadow ? [
            fieldRow('Bias', numField('', l.shadowBias ?? -0.0005, (v) => { l.shadowBias = v; }, 0.0001, { def: -0.0005 })),
            fieldRow('Softness', slider('', l.shadowRadius ?? 2, 0, 10, 0.1, (v) => { l.shadowRadius = v; }, { def: 2 })),
            fieldRow('Map size', selectField('', String(l.shadowMapSize ?? 1024), [
              ['512', '512'], ['1024', '1024'], ['2048', '2048'], ['4096', '4096'],
            ], (v) => { l.shadowMapSize = Number(v); })),
          ] : []),
        ]),
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
        el('div', { class: 'row', text: trig.zone ? 'Zone: whole stroke (see Data → Stroke panel)' : rig ? `Rig: ${rig.address}` : 'Static position (drag to move, or bind in the Capture panel)' }),
      );
    }
    return panel(`Properties — ${objectName(ctx.scene, ref)}`, ...rows);
  }

  /**
   * Loose-prop physics for one mesh.
   *
   * Absent `body` means static, which stays the default: a wall you can
   * shove is a bug. Turning it on is what makes an object grabbable with the
   * Pose tool, so this row and that drag are really one feature — stage the
   * room by throwing things around in it.
   */
  private physicsRows(m: TGMesh): Node[] {
    const { ctx } = this.app;
    const mode = !m.body ? 'STATIC' : (m.body.type ?? 'DYNAMIC');
    const rapier = engineOf(ctx.scene) === 'RAPIER';
    const rows: Node[] = [
      el('div', { class: 'menu-sep' }),
      el('div', { class: 'menu-header', text: 'Physics' }),
      fieldRow('Body', tip(selectField('', mode, [
        ['STATIC', 'Static'],
        ['DYNAMIC', 'Dynamic'],
        ['KINEMATIC', 'Kinematic'],
      ], (v) => {
        ctx.pushUndo();
        // Static is the ABSENCE of a body, not a body with a flag: a wall
        // already collides as part of the world, which is why balls bounce
        // off a floor that has no physics settings of its own.
        m.body = v === 'STATIC'
          ? undefined
          : { ...(m.body ?? defaultBody(propRadius(m))), type: v as 'DYNAMIC' | 'KINEMATIC' };
        this.refresh();
      }), 'Static collides and never moves · Dynamic falls and can be pushed, '
        + 'kicked or thrown · Kinematic keeps the position you give it (by hand, '
        + 'a constraint or an animation) and shoves dynamics out of the way')),
    ];
    if (!m.body) return rows;
    const b = m.body;
    // Shown even on the simple backend, which ignores it. Hiding a control
    // that does not apply yet leaves no trace of the setting OR of the engine
    // that would honour it — a disabled row with a tip saying where the
    // switch lives is the shorter path to both.
    const collider = fieldRow('Collider', tip(selectField('', b.shape ?? 'AUTO', [
      ['AUTO', 'Auto'], ['BALL', 'Ball'], ['BOX', 'Box'], ['CAPSULE', 'Capsule'],
      ['CYLINDER', 'Cylinder'], ['CONE', 'Cone'], ['HULL', 'Convex hull'],
      ['MESH', 'Triangle mesh'],
    ], (v) => {
      ctx.pushUndo();
      b.shape = v as NonNullable<TGMesh['body']>['shape'];
      resetPhysics();
      this.refresh();
    }), 'The shape it collides as — Auto matches what it is drawn as. '
      + 'Convex hull wraps its own triangles (a chair becomes a wedge). '
      + 'Triangle mesh is exact but hollow, so it applies to Static and '
      + 'Kinematic bodies; anything dynamic falls back to the hull.'
      + (rapier ? '' : ' Needs the Rapier engine — switch it in the Scene panel, '
        + 'Physics ▸ Engine. The simple backend collides everything as a sphere.')));
    if (!rapier) {
      const sel = collider.querySelector('select');
      if (sel instanceof HTMLSelectElement) sel.disabled = true;
    }
    rows.push(collider);
    if (b.type === 'KINEMATIC') return rows;
    rows.push(
      el('div', { class: 'row' },
        numField('Mass', b.mass, (v) => { b.mass = Math.max(0.01, v); }, 0.1,
          { def: defaultBody(propRadius(m)).mass }),
        slider('Bounce', b.bounce, 0, 1, 0.01, (v) => { b.bounce = v; }, { def: 0.42 }),
        slider('Friction', b.friction, 0, 1, 0.01, (v) => { b.friction = v; }, { def: 0.06 }),
      ),
      el('div', { class: 'row' },
        btn('Stop', () => { b.vel = [0, 0, 0]; ctx.requestRender(); },
          { title: 'park it where it is — the drop that put it there keeps trying otherwise' }),
      ),
    );
    return rows;
  }

  /**
   * The pose library: little skeletons you can click.
   *
   * A thumbnail is drawn FROM THE POSE — projected front-on through the
   * actor's own bones — rather than captured as an image. A picture would
   * be a second copy of the truth that goes stale the moment the skeleton
   * changes, and it would have to live in the saved file; a hundred bytes of
   * joint positions draw themselves.
   */
  private poseLibrary(actor: TGActor): HTMLElement {
    const { ctx } = this.app;
    const upZ = ctx.settings.upAxis === 'Z';
    const poses = ctx.scene.poses ?? [];
    const slots: Node[] = [];

    for (const pose of poses) {
      const { lines, dots } = poseSegments(pose, actor, upZ);
      const svg = poseThumb(lines, dots);
      const cell = el('div', { class: 'pose-slot', title: `${pose.name} — click to apply, Shift-click to overwrite` }, svg,
        el('span', { class: 'pose-slot-name', text: pose.name }));
      cell.onclick = (e) => {
        if ((e as MouseEvent).shiftKey) this.app.savePoseSlot(actor.id, pose.id);
        else this.app.applyPoseSlot(actor.id, pose.id);
      };
      cell.oncontextmenu = (e) => {
        e.preventDefault();
        this.app.deletePoseSlot(pose.id);
      };
      slots.push(cell);
    }

    // Always one empty slot on the end: the gesture is "shift-click an empty
    // slot to put this pose in it", so there has to be one to click.
    const empty = el('div', {
      class: 'pose-slot empty',
      title: 'Shift-click to store the current pose here',
    }, el('span', { class: 'pose-slot-plus', text: '+' }));
    empty.onclick = (e) => {
      if (!(e as MouseEvent).shiftKey) {
        this.app.ctx.setStatus('Shift-click an empty slot to store the pose');
        return;
      }
      this.app.savePoseSlot(actor.id);
    };
    slots.push(empty);

    return fieldRow('', el('div', { class: 'pose-grid' }, ...slots), { full: true });
  }

  /** The look's own knobs, shown once a look is doing something. */
  private postRows(): Node[] {
    const { ctx } = this.app;
    const p = ctx.scene.post;
    if (!p || p.preset === 'NONE') return [];
    const w = ctx.scene.world;
    // any edit makes it Custom, so the dropdown never claims to be a preset
    // it no longer is
    const edit = (fn: () => void) => { fn(); p.preset = 'CUSTOM'; };
    const rows: Node[] = [
      slider('Bloom', p.bloom, 0, 2, 0.01, (v) => edit(() => { p.bloom = v; }), { def: 0 }),
      slider('Threshold', p.bloomThreshold, 0, 1.5, 0.01,
        (v) => edit(() => { p.bloomThreshold = v; }), { def: 0.75, title: 'how bright a pixel must be before it blooms' }),
      slider('Duotone', p.duotone, 0, 1, 0.01, (v) => edit(() => { p.duotone = v; }), { def: 0 }),
    ];
    if (p.duotone > 0) {
      rows.push(
        fieldRow('Shadow', colorField('', [...p.duotoneLow, 1], (rgb) => edit(() => { p.duotoneLow = rgb; }))),
        fieldRow('Light', colorField('', [...p.duotoneHigh, 1], (rgb) => edit(() => { p.duotoneHigh = rgb; }))),
        slider('Lift', p.lift, -0.3, 0.6, 0.01, (v) => edit(() => { p.lift = v; }), { def: 0 }),
      );
    }
    rows.push(
      slider('Ink', p.edge, 0, 1, 0.01, (v) => { edit(() => { p.edge = v; }); this.refresh(); }, { def: 0, title: 'lines at depth and normal discontinuities' }),
    );
    if (p.edge > 0) {
      rows.push(
        slider('Line width', p.edgeWidth, 0.5, 4, 0.05, (v) => edit(() => { p.edgeWidth = v; }), { def: 1 }),
        fieldRow('Ink colour', colorField('', [...p.inkColor, 1], (rgb) => edit(() => { p.inkColor = rgb; }))),
        slider('Paper', p.paper, 0, 1, 0.01, (v) => edit(() => { p.paper = v; }), { def: 0, title: 'wash the render out so the lines carry the image' }),
        fieldRow('Paper colour', colorField('', [...p.paperColor, 1], (rgb) => edit(() => { p.paperColor = rgb; }))),
      );
    }
    rows.push(
      el('div', { class: 'menu-header', text: 'Grade' }),
      slider('Brightness', p.brightness, -0.5, 0.5, 0.01, (v) => edit(() => { p.brightness = v; }), { def: 0 }),
      slider('Contrast', p.contrast, 0, 3, 0.01, (v) => edit(() => { p.contrast = v; }), { def: 1, title: 'pivots on middle grey, so it opens and closes the range without shifting the midtone' }),
      slider('Saturation', p.saturation, 0, 3, 0.01, (v) => edit(() => { p.saturation = v; }), { def: 1, title: '0 is greyscale, above 1 pushes the colour past the render' }),
      el('div', { class: 'menu-header', text: 'Levels' }),
      slider('In black', p.inBlack, 0, 1, 0.01, (v) => edit(() => { p.inBlack = Math.min(v, p.inWhite - 0.01); }), { def: 0, title: 'everything at or below this becomes black — the standard way to set a black point' }),
      slider('In white', p.inWhite, 0, 1, 0.01, (v) => edit(() => { p.inWhite = Math.max(v, p.inBlack + 0.01); }), { def: 1 }),
      slider('Gamma', p.gamma, 0.1, 3, 0.01, (v) => edit(() => { p.gamma = v; }), { def: 1, title: 'midtones only, between the two input points' }),
      slider('Out black', p.outBlack, 0, 1, 0.01, (v) => edit(() => { p.outBlack = v; }), { def: 0, title: 'lift the blacks off zero — a print never reaches pure black' }),
      slider('Out white', p.outWhite, 0, 1, 0.01, (v) => edit(() => { p.outWhite = v; }), { def: 1 }),
      el('div', { class: 'menu-header', text: 'Film' }),
      slider('Grain', p.grain, 0, 0.1, 0.002, (v) => edit(() => { p.grain = v; }), { def: 0, title: 'dither — a smooth field bands visibly without it' }),
      slider('Vignette', p.vignette, 0, 1, 0.01, (v) => edit(() => { p.vignette = v; }), { def: 0 }),
      el('div', { class: 'menu-header', text: 'Atmosphere' }),
      slider('Haze', w.fog ?? 0, 0, 0.3, 0.002, (v) => { w.fog = v; }, { def: 0, title: 'fog density — lit, so light fills the air rather than sitting on it' }),
      fieldRow('Haze colour', colorField('', [...(w.fogColor ?? [0.6, 0.65, 0.75]), 1], (rgb) => { w.fogColor = rgb; })),
    );
    return rows;
  }

  /** Blender-style brush Advanced panel; edits are baked into future strokes only. */
  private brushPanel(): HTMLElement {
    const { ctx } = this.app;
    const b = ctx.settings.brush;
    const st = b.style;
    return panel('Brush — Advanced',
      fieldRow('Size unit', selectField('', st.unit, [['VIEW', 'View (px)'], ['SCENE', 'Scene (world)']],
        (v) => { st.unit = v as 'VIEW' | 'SCENE'; })),
      checkbox('Stamp', st.stamp, (v) => { st.stamp = v; }),
      fieldRow('Hardness', slider('', b.hardness, 0.05, 1, 0.01, (v) => { b.hardness = v; }, { def: 1, route: 'brush.hardness' })),
      fieldRow('Spacing', slider('', st.spacing, 0.03, 1, 0.01, (v) => { st.spacing = v; }, { def: 0.12 })),
      fieldRow('Angle', slider('', st.angle, -Math.PI, Math.PI, 0.05, (v) => { st.angle = v; }, { def: 0 })),
      fieldRow('Aspect', slider('', st.aspect, 0.1, 1, 0.01, (v) => { st.aspect = v; }, { def: 1 })),
      fieldRow('Jitter', slider('', st.jitter, 0, 1, 0.01, (v) => { st.jitter = v; }, { def: 0, route: 'brush.style.jitter' })),
      fieldRow('Grain', slider('', st.grain, 0, 1, 0.01, (v) => { st.grain = v; }, { def: 0, route: 'brush.style.grain' })),
      fieldRow('Grain scale', slider('', st.grainScale, 1, 30, 0.5, (v) => { st.grainScale = v; }, { def: 6 })),
      fieldRow('Active smooth', slider('', b.activeSmooth, 0, 0.8, 0.02, (v) => { b.activeSmooth = v; }, { def: 0.2 })),
      fieldRow('Post smooth', slider('', b.postSmooth, 0, 1, 0.02, (v) => { b.postSmooth = v; }, { def: 0.3 })),
      fieldRow('Simplify', numField('', b.simplify, (v) => { b.simplify = Math.max(0, v); }, 0.001, { def: 0.002 })),
      checkbox('Stabilize', b.stabilize, (v) => { b.stabilize = v; this.refresh(); }),
      ...(b.stabilize ? [fieldRow('Radius', slider('', b.stabilizeRadius, 5, 120, 1, (v) => { b.stabilizeRadius = v; }, { def: 30 }))] : []),
      el('div', { class: 'menu-header', text: 'Variation along the stroke' }),
      panelHint('What makes a mark read as drawn rather than extruded. The signal picks WHAT varies; the amounts pick how much. Negative amounts grow with the signal instead of shrinking (ink pooling in a corner).'),
      selectField('Signal', st.varyMode ?? 'NONE', [
        ['NONE', 'None'], ['RANDOM', 'Random'], ['CURVATURE', 'Curvature'],
        ['DENSITY', 'Draw speed'], ['ARC', 'Along stroke'],
      ] as [VaryMode, string][], (v) => { st.varyMode = v; this.refresh(); }),
      ...((st.varyMode ?? 'NONE') === 'NONE' ? [] : [
        slider('Width', st.varyRadius ?? 0, -1, 1, 0.01, (v) => { st.varyRadius = v; }, { def: 0 }),
        slider('Opacity', st.varyStrength ?? 0, -1, 1, 0.01, (v) => { st.varyStrength = v; }, { def: 0 }),
        ...((st.varyMode === 'RANDOM')
          ? [slider('Scale', st.varyScale ?? 4, 1, 40, 0.5, (v) => { st.varyScale = v; }, { def: 4 })]
          : []),
      ]),
      slider('Taper in', st.taperIn ?? 0, 0, 0.5, 0.01, (v) => { st.taperIn = v; }, { def: 0 }),
      slider('Taper out', st.taperOut ?? 0, 0, 0.5, 0.01, (v) => { st.taperOut = v; }, { def: 0 }),
      el('div', { class: 'menu-header', text: 'Texture-paint tip' }),
      (() => {
        const tip = imageById(ctx.scene, b.tipImageId);
        return el('div', { class: 'row' },
          el('span', { class: 'grow', text: tip ? `Tip: ${tip.name}` : 'Tip: soft round (built-in)' }),
          btn(icon('photo'), () => this.filePick('image/*', (f) => {
            const reader = new FileReader();
            reader.onload = () => {
              ctx.pushUndo();
              const img = createImage(f.name || 'Brush tip', String(reader.result));
              ctx.scene.images.push(img);
              b.tipImageId = img.id;
              this.refresh();
            };
            reader.readAsDataURL(f);
          }), { cls: 'icon-btn', title: 'Load a brush tip image (luminance = alpha)' }),
          ...(tip ? [btn(icon('xMark'), () => { b.tipImageId = null; this.refresh(); },
            { cls: 'icon-btn', title: 'Back to the built-in soft round tip' })] : []),
        );
      })(),
    );
  }

  /** Bake scene elements / strokes / shadows / live camera onto the
   *  selected object's texture, through its UVs. See render/bake.ts. */
  private bakePanel(): HTMLElement {
    const { ctx } = this.app;
    const ref = this.app.getLastPicked();
    const bakeable = ref?.kind === 'MESH' || ref?.kind === 'POLY';
    const name = ref && bakeable
      ? (ref.kind === 'MESH' ? ctx.scene.meshes : ctx.scene.polyMeshes).find((o) => o.id === ref.id)?.name
      : null;
    const bake = (source: BakeSource) =>
      this.app.bakeToTexture(source, this.bakeSize, this.bakeMargin);
    return panel('Bake',
      panelHint('Projects from the current view onto the selected object\'s UVs. Unwrap first for stable results.'),
      el('div', { class: 'row', text: name ? `Target: ${name}` : 'Select a mesh or editable mesh' }),
      fieldRow('Resolution', selectField('', String(this.bakeSize), [
        ['512', '512'], ['1024', '1024'], ['2048', '2048'], ['4096', '4096'],
      ], (v) => { this.bakeSize = Number(v); })),
      fieldRow('Margin', slider('', this.bakeMargin, 0, 16, 1, (v) => { this.bakeMargin = Math.round(v); }, { def: 4 })),
      el('div', { class: 'row' },
        btn('Scene', () => bake('SCENE'), { title: 'everything visible, from this view' }),
        btn('Strokes', () => bake('STROKES'), { title: 'GP strokes only' }),
      ),
      el('div', { class: 'row' },
        btn('Shadows', () => bake('SHADOW'), { title: 'lighting/shadow only (needs a shadow-casting light)' }),
        btn('Camera', () => bake('INPUT'), { title: 'the live camera frame (projection painting)' }),
      ),
    );
  }

  private bakeSize = 1024;
  private bakeMargin = 4;

  /** Stencil masking for the paint tools — image / live camera / the
   *  silhouette of chosen objects. See tools/stencil.ts. */
  private stencilPanel(): HTMLElement {
    const { ctx } = this.app;
    const s = ctx.settings.stencil;
    const img = imageById(ctx.scene, s.imageId);
    const sel = listSelectedObjects(ctx.scene);
    return panel('Stencil',
      panelHint('Paint only lands where the mask passes. Works with texture, vertex, weight and splat painting.'),
      checkbox('Enabled', s.enabled, (v) => { s.enabled = v; this.refresh(); }),
      fieldRow('Source', selectField('', s.source, [
        ['IMAGE', 'Image'], ['OBJECTS', 'Object silhouette'], ['VIDEO', 'Live camera'],
      ], (v) => { s.source = v as typeof s.source; this.refresh(); })),
      ...(s.source === 'IMAGE' ? [
        el('div', { class: 'row' },
          el('span', { class: 'grow', text: img ? img.name : 'No image' }),
          btn(icon('photo'), () => this.filePick('image/*', (f) => {
            const reader = new FileReader();
            reader.onload = () => {
              ctx.pushUndo();
              const image = createImage(f.name || 'Stencil', String(reader.result));
              ctx.scene.images.push(image);
              s.imageId = image.id;
              this.refresh();
            };
            reader.readAsDataURL(f);
          }), { cls: 'icon-btn', title: 'Load stencil image' }),
        ),
      ] : []),
      ...(s.source === 'OBJECTS' ? [
        el('div', { class: 'row', text: s.refs.length ? `${s.refs.length} object(s) as mask` : 'No mask objects set' }),
        btn(`Use selected (${sel.length})`, () => {
          ctx.pushUndo();
          s.refs = sel.map((r) => ({ kind: r.kind, id: r.id }));
          this.refresh();
        }, { title: 'silhouette these objects from the current view' }),
      ] : []),
      ...(s.source !== 'OBJECTS' ? [
        fieldRow('Scale', slider('', s.scale, 0.1, 4, 0.01, (v) => { s.scale = v; }, { def: 1 })),
        fieldRow('Rotate', slider('', s.rotation, -Math.PI, Math.PI, 0.02, (v) => { s.rotation = v; }, { def: 0 })),
        fieldRow('Offset X', slider('', s.offset[0], -1, 1, 0.01, (v) => { s.offset[0] = v; }, { def: 0 })),
        fieldRow('Offset Y', slider('', s.offset[1], -1, 1, 0.01, (v) => { s.offset[1] = v; }, { def: 0 })),
      ] : []),
      fieldRow('Threshold', slider('', s.threshold, 0, 0.99, 0.01, (v) => { s.threshold = v; }, { def: 0.5 })),
      checkbox('Invert', s.invert, (v) => { s.invert = v; }),
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
        slider('Opacity', layer.opacity, 0, 1, 0.01, (v) => { layer.opacity = v; ctx.requestRender(); },
          { def: 1, route: `layer.${layer.id}.opacity` }),
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

  /**
   * The mode-dependent rows under a GP material's Stroke/Fill Style. Shared
   * because the two sides carry the same parameters under different field
   * names — gradient gets a second colour, texture gets an image + how
   * often it repeats + how much material colour survives it.
   */
  private shadeRows(m: GPMaterial, isFill: boolean): Node[] {
    const { ctx } = this.app;
    const mode = isFill ? m.fillStyle : (m.strokeShade ?? 'SOLID');
    const rows: Node[] = [];
    if (mode === 'GRADIENT_LINEAR' || mode === 'GRADIENT_RADIAL') {
      if (!isFill) {
        const c2 = m.strokeColor2 ?? m.strokeColor;
        rows.push(
          colorField('Color 2', c2, (rgb) => {
            m.strokeColor2 = [rgb[0], rgb[1], rgb[2], c2[3]]; ctx.requestRender();
          }),
          slider('Alpha 2', c2[3], 0, 1, 0.01, (v) => {
            m.strokeColor2 = [c2[0], c2[1], c2[2], v]; ctx.requestRender();
          }),
        );
      }
      return rows;
    }
    if (mode !== 'TEXTURE') return rows;

    const imageId = isFill ? m.fillImageId : m.strokeImageId;
    const img = imageById(ctx.scene, imageId);
    const setImage = (id: number | null) => {
      if (isFill) m.fillImageId = id; else m.strokeImageId = id;
      ctx.requestRender();
      this.refresh();
    };
    rows.push(fieldRow('Image', el('div', { class: 'field-group' },
      selectField('', String(imageId ?? ''), [
        ['', img ? '(none)' : 'pick an image…'],
        ...ctx.scene.images.map((i) => [String(i.id), i.name] as [string, string]),
      ], (v) => setImage(v ? Number(v) : null)),
      btn(icon('photo'), () => {
        this.filePick('image/*', (f) => {
          const rd = new FileReader();
          rd.onload = () => {
            ctx.pushUndo();
            const rec = createImage(f.name, String(rd.result));
            ctx.scene.images.push(rec);
            setImage(rec.id);
          };
          rd.readAsDataURL(f);
        });
      }, { cls: 'icon-btn', title: 'Load an image…' }),
    )));
    const uvFactor = (isFill ? m.fillUvFactor : m.strokeUvFactor) ?? 1;
    const texBlend = (isFill ? m.fillTexBlend : m.strokeTexBlend) ?? 0;
    rows.push(
      slider('UV factor', uvFactor, 0.1, 40, 0.1, (v) => {
        if (isFill) m.fillUvFactor = v; else m.strokeUvFactor = v;
        ctx.requestRender();
      }, { def: 1, title: 'how many times the texture repeats along the stroke / across the fill' }),
      slider('Blend', texBlend, 0, 1, 0.01, (v) => {
        if (isFill) m.fillTexBlend = v; else m.strokeTexBlend = v;
        ctx.requestRender();
      }, { def: 0, title: '0 = texture colour, 1 = material colour (alpha always masks)' }),
    );
    return rows;
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
      // Blender's GP material layout: each of Stroke and Fill is a titled
      // sub-section gated by its own checkbox, with colour / alpha / style
      // as ordinary property rows underneath — not three widgets fighting
      // for one line.
      props.push(
        el('div', { class: 'menu-header', text: 'Stroke' }),
        checkbox('Show', m.showStroke, (v) => { m.showStroke = v; ctx.requestRender(); }),
        colorField('Color', m.strokeColor, (rgb) => { m.strokeColor = [rgb[0], rgb[1], rgb[2], m.strokeColor[3]]; ctx.requestRender(); }),
        slider('Alpha', m.strokeColor[3], 0, 1, 0.01, (v) => { m.strokeColor[3] = v; ctx.requestRender(); }),
        selectField('Line', m.lineMode, [['LINE', 'Line'], ['DOTS', 'Dots'], ['SQUARES', 'Squares']] as [LineMode, string][], (v) => { m.lineMode = v; ctx.requestRender(); }),
        selectField('Style', m.strokeShade ?? 'SOLID', [
          ['SOLID', 'Solid'], ['GRADIENT_LINEAR', 'Gradient (along)'],
          ['GRADIENT_RADIAL', 'Gradient (across)'], ['TEXTURE', 'Texture'],
        ] as [StrokeShade, string][], (v) => { m.strokeShade = v; ctx.requestRender(); this.refresh(); }),
        ...this.shadeRows(m, false),
        el('div', { class: 'menu-header', text: 'Fill' }),
        checkbox('Show', m.showFill, (v) => { m.showFill = v; ctx.requestRender(); }),
        colorField('Color', m.fillColor, (rgb) => { m.fillColor = [rgb[0], rgb[1], rgb[2], m.fillColor[3]]; ctx.requestRender(); }),
        slider('Alpha', m.fillColor[3], 0, 1, 0.01, (v) => { m.fillColor[3] = v; ctx.requestRender(); }),
        selectField('Style', m.fillStyle, [
          ['SOLID', 'Solid'], ['GRADIENT_LINEAR', 'Linear Gradient'],
          ['GRADIENT_RADIAL', 'Radial Gradient'], ['TEXTURE', 'Texture'],
        ] as [FillStyle, string][], (v) => { m.fillStyle = v; ctx.requestRender(); this.refresh(); }),
        ...this.shadeRows(m, true),
      );
      if (m.fillStyle === 'GRADIENT_LINEAR' || m.fillStyle === 'GRADIENT_RADIAL') {
        props.push(
          colorField('Color 2', m.fillColor2, (rgb) => { m.fillColor2 = [rgb[0], rgb[1], rgb[2], m.fillColor2[3]]; ctx.requestRender(); }),
          slider('Angle', m.gradientAngle, 0, Math.PI * 2, 0.05, (v) => { m.gradientAngle = v; ctx.requestRender(); }),
        );
      }
      props.push(checkbox('Holdout', m.holdout, (v) => { m.holdout = v; ctx.requestRender(); }));
      if (ctx.settings.mode === 'EDIT') {
        props.push(fieldRow('', btn('Assign to selected', () => ops.assignMaterial(ctx, ob.activeMaterial)), { full: true }));
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
      panelHint('Use Placement: Surface to draw on canvases'),
      el('div', { class: 'row' },
        btn('＋ Plane at cursor', () => this.app.addCanvasPlane(),
          { title: 'Add a drawable plane at the 3D cursor, oriented to the current drawing plane' }),
      ),
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
    routePrefix?: string,
  ): Node[] {
    const out: Node[] = [];
    for (const [key, val] of Object.entries(params)) {
      if (typeof val === 'boolean') {
        out.push(checkbox(key, val, (v) => { params[key] = v; onChange(); }));
      } else if (typeof val === 'number') {
        out.push(numField(key, val, (v) => { params[key] = v; onChange(); },
          0.1, routePrefix ? { route: `${routePrefix}.${key}` } : {}));
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
        ...this.paramEditors(mod.params, () => ctx.requestRender(), `modifier.${mod.id}`),
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
        ...this.paramEditors(fx.params, () => ctx.requestRender(), `effect.${fx.id}`),
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
      checkbox('Enabled', o.enabled, (v) => { o.enabled = v; ctx.requestRender(); }),
      fieldRow('Mode', selectField('', o.mode, [['KEYFRAMES', 'Keyframes'], ['FRAMES', 'Frames']], (v) => { o.mode = v; ctx.requestRender(); })),
      fieldRow('Before', numField('', o.before, (v) => { o.before = Math.max(0, Math.round(v)); ctx.requestRender(); }, 1)),
      fieldRow('After', numField('', o.after, (v) => { o.after = Math.max(0, Math.round(v)); ctx.requestRender(); }, 1)),
      fieldRow('Before color', colorField('', [...o.colorBefore, 1], (rgb) => { o.colorBefore = rgb; ctx.requestRender(); })),
      fieldRow('After color', colorField('', [...o.colorAfter, 1], (rgb) => { o.colorAfter = rgb; ctx.requestRender(); })),
      fieldRow('Opacity', slider('', o.opacity, 0, 1, 0.01, (v) => { o.opacity = v; ctx.requestRender(); })),
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
    // one parameter, three sub-fields — a connected .field-group, so X/Y/Z
    // read as one vector rather than three boxes that happen to be adjacent
    return fieldRow(label, get().map((component, i) => numField('', component, (v) => set(i, v), step)));
  }

  /** Read-only bounding-box size line (Blender's Item panel "Dimensions"),
   *  derived from the same world-space AABB the selection outline draws —
   *  see App.objectExtents. Plain text, not a numdrag: the box is a
   *  DERIVED value (world AABB of the actual geometry), so an interactive
   *  control here would either silently no-op or need to back-solve a
   *  scale change from a typed size, which is more than "a display". */
  private extentsRow(ref: ObjRef): Node | null {
    const size = this.app.objectExtents(ref);
    if (!size) return null;
    return fieldRow('Extents', el('span', { text: size.map((v) => v.toFixed(3)).join('  ×  ') }));
  }

  /** Blender-style N-panel: item / view / cursor values, live + editable.
   *  Built from the same panel() sections the sidebar uses (Properties,
   *  Bake, etc.) so it gets identical two-column label alignment for free
   *  instead of a hand-rolled layout that only sort-of matches. */
  rebuildInspector(): void {
    const { ctx } = this.app;
    const ob = activeObject(ctx.scene);
    const cam = activeCam(ctx.scene);
    if (!this.inspectorEl) {
      this.inspectorEl = el('div', { id: 'inspector' });
      document.getElementById('viewport')!.append(this.inspectorEl);
    }
    const sections: HTMLElement[] = [];

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
      sections.push(panel(`Median (${selected.length} pts)`,
        this.vecRow('', () => median.map((v) => +v.toFixed(3)), (i, v) => {
          ctx.pushUndo();
          const d = v - median[i];
          for (const p of selected) p.co[i] += d;
          ctx.requestRender();
        }),
      ));
    }
    // OBJECT mode: show the actually-selected object (any kind), not just
    // the active GP object — the N-panel used to always read GP1 even with
    // a mesh/splat/trigger selected. Other modes edit one specific GP
    // object regardless of object-mode selection, so keep showing that.
    if (ctx.settings.mode === 'OBJECT') {
      const refs = listSelectedObjects(ctx.scene);
      const picked = this.app.getLastPicked();
      const activeRef = (picked && refs.some((r) => r.kind === picked.kind && r.id === picked.id)) ? picked : refs[0];
      if (activeRef) {
        const t = getObjectTransform(ctx.scene, activeRef);
        const rows: Node[] = [];
        if (t) {
          rows.push(
            this.vecRow('Loc', () => t.translation.map((v) => +v.toFixed(3)), (i, v) => { t.translation[i] = v; setObjectTransform(ctx.scene, activeRef, t); ctx.requestRender(); }),
            this.vecRow('Rot', () => t.rotation.map((v) => +v.toFixed(3)), (i, v) => { t.rotation[i] = v; setObjectTransform(ctx.scene, activeRef, t); ctx.requestRender(); }),
            this.vecRow('Scale', () => t.scale.map((v) => +v.toFixed(3)), (i, v) => { t.scale[i] = v; setObjectTransform(ctx.scene, activeRef, t); ctx.requestRender(); }, 0.05),
          );
        }
        const extents = this.extentsRow(activeRef);
        if (extents) rows.push(extents);
        sections.push(panel(`Object: ${objectName(ctx.scene, activeRef)} (${activeRef.kind})${refs.length > 1 ? ` +${refs.length - 1}` : ''}`, ...rows));
      } else {
        sections.push(panel('Object', el('div', { class: 'row', text: 'select one or more objects' })));
      }
    } else {
      const ref: ObjRef = { kind: 'GP', id: ob.id };
      const extents = this.extentsRow(ref);
      sections.push(panel(`Object: ${ob.name}`,
        this.vecRow('Loc', () => ob.translation.map((v) => +v.toFixed(3)), (i, v) => { ob.translation[i] = v; ctx.requestRender(); }),
        this.vecRow('Rot', () => ob.rotation.map((v) => +v.toFixed(3)), (i, v) => { ob.rotation[i] = v; ctx.requestRender(); }),
        this.vecRow('Scale', () => ob.scale.map((v) => +v.toFixed(3)), (i, v) => { ob.scale[i] = v; ctx.requestRender(); }, 0.05),
        ...(extents ? [extents] : []),
      ));
    }

    // --- View ---
    const vp = ctx.camera.position;
    sections.push(panel('View',
      el('div', { class: 'row', text: `Viewport: ${vp.x.toFixed(2)}, ${vp.y.toFixed(2)}, ${vp.z.toFixed(2)}` }),
    ));
    sections.push(panel(`Camera: ${cam.name}`,
      this.vecRow('Loc', () => cam.translation.map((v) => +v.toFixed(3)), (i, v) => { cam.translation[i] = v; ctx.requestRender(); }),
      this.vecRow('Rot', () => cam.rotation.map((v) => +v.toFixed(3)), (i, v) => { cam.rotation[i] = v; ctx.requestRender(); }),
      numField('FOV', +cam.fov.toFixed(1), (v) => { cam.fov = Math.min(140, Math.max(5, v)); ctx.requestRender(); }, 1, { def: 50, min: 5, max: 140, route: 'camera.0.fov' }),
    ));

    // --- Cursor ---
    sections.push(panel('3D Cursor',
      this.vecRow('', () => ctx.scene.cursor.map((v) => +v.toFixed(3)), (i, v) => {
        ctx.scene.cursor[i] = v;
        ctx.requestRender();
      }),
    ));

    this.inspectorEl.replaceChildren(...sections);
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
  /** which imported animation the Actor panel's retarget row is pointing at */
  private motionPick = '';
  /** which macro row is expanded for editing, 0 = none */
  private macroEdit = 0;
  /** Actor panel's motion-generation row (transient, not scene data) */
  private genPrompt = 'walk';
  private genSeconds = 2;
  private genBackend = 'local';

  // -------------------------------------------------------- agent help

  private agentHelpOpen = false;

  /**
   * Compact "how do I use this" for the agent interface, reachable from
   * Help. Deliberately not a copy of docs/AGENT.md — this covers the three
   * things someone needs in the moment (get a model talking, connect an
   * external editor, know what to ask for) and links out for the rest.
   */
  openAgentHelp(): void {
    if (this.agentHelpOpen) return;
    this.agentHelpOpen = true;

    const overlay = el('div', { id: 'settings-overlay' });
    const close = () => {
      this.agentHelpOpen = false;
      overlay.remove();
      window.removeEventListener('keydown', escClose, true);
    };
    const escClose = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    window.addEventListener('keydown', escClose, true);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    /** A shell/JSON snippet with a copy button — these are the fiddly bits
     *  people get wrong, so make them one click rather than a transcription. */
    const snippet = (text: string) => el('div', { class: 'help-snip' },
      el('code', { text }),
      btn(icon('duplicate'), () => { void navigator.clipboard?.writeText(text); },
        { cls: 'icon-btn', title: 'Copy' }),
    );
    /** A prompt example that can be dropped straight into the panel. */
    const example = (text: string) => {
      const row = el('div', { class: 'help-example' },
        el('span', { text }),
        btn('Try', () => {
          close();
          this.openTab('agent');
          this.app.agent.setDraft(text);
          this.refresh();
        }, { title: 'Put this in the Agent composer' }),
      );
      return row;
    };
    const para = (text: string) => el('p', { class: 'help-p', text });

    const dialog = el('div', { id: 'settings-dialog' },
      el('div', { class: 'row spread' },
        el('h2', { text: 'Using the agent' }),
        btn(icon('xMark'), close, { cls: 'icon-btn' }),
      ),

      el('div', { class: 'panel' },
        el('h3', { text: '1 · Chat inside threegrease' }),
        el('div', { class: 'body help-body' },
          para('Start a local model server, then open the Agent tab in the sidebar, pick a provider (local ones need no key) and hit the refresh icon by Model to list what is installed.'),
          snippet('ollama serve'),
          para('Pick a tool-capable model — small ones ignore the tool API. Known-good: llama3.1+, qwen2.5-coder, qwen3, mistral-nemo.'),
          btn('Open the Agent panel', () => { close(); this.openTab('agent'); }, { cls: 'primary' }),
        )),

      el('div', { class: 'panel' },
        el('h3', { text: '2 · Or drive it from an external agent' }),
        el('div', { class: 'body help-body' },
          para('Every client runs the same bridge — only the registration syntax differs. Start the relay once:'),
          snippet('cd agent && npm install && node relay.js'),
          para('Then connect this tab: Agent tab → Agent link → Connect. Now register it, from the repo root so $PWD resolves.'),
          para('Claude Code and Codex share the same form:'),
          snippet('claude mcp add threegrease -- node "$PWD/agent/mcp-server.js"'),
          snippet('codex mcp add threegrease -- node "$PWD/agent/mcp-server.js"'),
          para('Hermes names the command and args explicitly:'),
          snippet('hermes mcp add threegrease --command node --args "$PWD/agent/mcp-server.js"'),
          para('opencode prompts for the details (its opencode.json shape also differs — key is "mcp", command is an array):'),
          snippet('opencode mcp add threegrease'),
          para('Claude Desktop, Cursor and most others use the shared mcpServers JSON:'),
          snippet('{"mcpServers":{"threegrease":{"command":"node","args":["/abs/path/agent/mcp-server.js"]}}}'),
          para('For Zed (ACP), point its agent server at the other bridge instead:'),
          snippet('node "$PWD/agent/acp-server.js"'),
          para('Tools only appear while this tab is connected to the relay — the bridge fetches them live.'),
        )),

      el('div', { class: 'panel' },
        el('h3', { text: '3 · What to ask for' }),
        el('div', { class: 'body help-body' },
          para('Give it a goal, not coordinates — it computes the geometry. The world is Z-up, so the ground plane is XY and Z is height; say "standing up" or "flat on the ground" when it matters.'),
          example('What is in the scene right now?'),
          example('Draw a five-pointed star centred at the origin, lying flat on the ground, about 2 units across. One closed stroke.'),
          example('Draw a spiral staircase: 24 steps rising 3 units over two full turns, each step a short horizontal stroke.'),
          example('Draw three vertical strokes standing up from the ground at x = -1, 0 and 1, each 2 units tall.'),
          example('List the materials, then set material 1 to a red-to-yellow linear gradient.'),
          example('Add a box at the origin and a sun light above it, then frame everything from the front.'),
          para('Weaker prompts: "make it look nicer" (no target to hit) and freehand representational drawing — parametric and structural work is where models are actually good.'),
        )),

      el('div', { class: 'panel' },
        el('h3', { text: 'Good to know' }),
        el('div', { class: 'body help-body' },
          para('Undo works, but per tool call, not per prompt — a request that draws 24 strokes takes 24 undos to unwind. Save before a big ask.'),
          para('Vision: turn on "Send viewport screenshot" to let the model see its own work. It is off by default because a text-only model that receives an image will fail.'),
          para('API keys typed into the panel are kept in this browser only — a development convenience, not a secret store. Prefer local providers.'),
          btn('Full documentation (docs/AGENT.md)', () => window.open('https://github.com/languel/threegrease/blob/agentic/docs/AGENT.md', '_blank')),
        )),
    );
    overlay.append(dialog);
    document.body.append(overlay);
  }

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
        checkbox('Trackpad navigation', s.trackpadNav, (v) => this.app.setTrackpadNav(v),
          'two-finger orbit, Shift pan, Ctrl zoom'),
        checkbox('Invert orbit direction', s.invertTrackpadOrbit, (v) => { s.invertTrackpadOrbit = v; save(); }),
      ),
      el('div', { class: 'row' },
        checkbox('Emulate Numpad', s.emulateNumpad, (v) => { s.emulateNumpad = v; save(); },
          'digit-row keys become view shortcuts — mode shortcuts are shadowed while this is on (use the topbar or Tab)'),
      ),
      el('div', { class: 'row' },
        checkbox('Emulate 3-Button Mouse', s.emulate3Button, (v) => { s.emulate3Button = v; save(); }, 'Alt+LMB navigates'),
      ),
      el('div', { class: 'row' },
        checkbox('Show transform gizmo', s.showGizmo, (v) => { s.showGizmo = v; this.app.refreshWidget(); save(); }),
        checkbox('Auto-key', s.autoKey, (v) => { s.autoKey = v; }),
      ),
      el('div', { class: 'row' },
        selectField('Snap to stroke scope (vertex/edge)', s.snap.strokeScope ?? 'ANY', [
          ['ANY', 'Any GP object'], ['SELECTED', 'Selected strokes only'],
        ], (v) => { s.snap.strokeScope = v as 'ANY' | 'SELECTED'; save(); }),
      ),
      el('div', { class: 'menu-header', text: 'Theme' }),
      el('div', { class: 'row' },
        colorField('Accent', [...s.uiAccent, 1], (rgb) => { s.uiAccent = rgb; this.app.applyThemeColors(); save(); }),
        slider('Accent alpha', s.uiAccentAlpha, 0, 1, 0.01, (v) => {
          s.uiAccentAlpha = v; this.app.applyThemeColors(); save();
        }, { def: 0.5 }),
        colorField('Highlight', [...s.uiHighlight, 1], (rgb) => {
          s.uiHighlight = rgb; this.app.applyThemeColors(); this.app.refreshWidget(); save();
        }),
        slider('Highlight alpha', s.uiHighlightAlpha, 0, 1, 0.01, (v) => {
          s.uiHighlightAlpha = v; this.app.applyThemeColors(); this.app.refreshWidget(); save();
        }, { def: 0.5 }),
        colorField('Highlight (active)', [...s.uiHighlightActive, 1], (rgb) => {
          s.uiHighlightActive = rgb; this.app.refreshWidget(); save();
        }),
      ),
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
      el('div', { class: 'panel' },
        el('h3', { text: 'Preferences', title: 'Grid step/subdivisions and Background live in the Scene tab (sidebar), not here.' }),
        prefs),
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
      ...ctx.scene.actors.map((a) => ({ ref: { kind: 'ACTOR' as const, id: a.id }, label: `Actor: ${a.name}` })),
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
          numField('Speed', cur.speed, (v) => { cur.speed = v; }, 0.05, { route: `cursor.${cur.id}.speed` }),
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
          numField('Radius', trig.radius, (v) => { trig.radius = Math.max(0.01, v); }, 0.05, { min: 0.01, route: `trigger.${trig.id}.radius` }),
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
      fieldRow('Pins', numField('', this.saOpts.pinCount, (v) => { this.saOpts.pinCount = Math.max(8, Math.round(v)); }, 1)),
      fieldRow('Chords', numField('', this.saOpts.maxChords, (v) => { this.saOpts.maxChords = Math.max(10, Math.round(v)); }, 10)),
      fieldRow('Opacity', numField('', this.saOpts.opacity, (v) => { this.saOpts.opacity = Math.min(1, Math.max(0.02, v)); }, 0.01)),
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
      numField('str', at.strength, (v) => { at.strength = v; }, 0.1, { route: `attractor.${at.id}.strength` }),
      numField('rad', at.radius, (v) => { at.radius = Math.max(0.01, v); }, 0.1, { min: 0.01 }),
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
    );

    return panel('Solvers (string art · wire art · attractors)',
      el('div', { class: 'panel' }, el('h3', { text: 'String art' }), stringArt),
      el('div', { class: 'panel' },
        el('h3', { text: 'Multi-view wire art', title: 'Assist: in camera view (0) the target shows as an overlay — trace it, switch cameras, connect in 3D.' }),
        wireArt),
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
        fieldRow('Damping', slider('', sim.damping, 0.8, 0.999, 0.001, (v) => { sim.damping = v; })),
        fieldRow('Stiffness', slider('', sim.stiffness, 0, 0.2, 0.005, (v) => { sim.stiffness = v; })),
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
  /** last capture-source URL typed in the Streams panel (survives refreshes) */
  private mmUrl = '';

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
      ref.kind === 'STREAM' ? ctx.scene.mmStreams.find((st) => st.id === ref.id) :
      ref.kind === 'ACTOR' ? ctx.scene.actors.find((a) => a.id === ref.id) :
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

    // Returns the object picker plus, when the picked target is an actor,
    // a joint dropdown — riding a rig control (a hand, the head) instead
    // of the actor's root is the whole point of attaching to an actor.
    const targetField = (c: TGConstraint): Node[] => {
      const picker = this.objectPickerField('Target',
        () => c.target ?? null,
        (v) => { c.target = v as TGConstraint['target']; if (v?.kind !== 'ACTOR') c.targetJoint = null; },
        ref);
      if (c.target?.kind !== 'ACTOR') return [picker];
      const actor = ctx.scene.actors.find((a) => a.id === c.target!.id);
      const jointSel = selectField('Joint', c.targetJoint ?? '', [
        ['', '(actor root)'],
        ...(actor?.joints.map((j) => [j.name, j.name] as [string, string]) ?? []),
      ], (v) => { c.targetJoint = v || null; });
      return [picker, jointSel];
    };

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
          fieldRow('Phase', slider('', c.phase ?? 0, 0, 1, 0.001, (v) => { c.phase = v; }, { def: 0 })),
          fieldRow('Speed', numField('', c.speed ?? 0.2, (v) => { c.speed = v; }, 0.05, { def: 0.2 })),
          fieldRow('Loop', selectField('', c.loop ?? 'LOOP', [['LOOP', 'Loop'], ['PINGPONG', 'Ping-pong'], ['ONCE', 'Once']], (v) => { c.loop = v as typeof c.loop; })),
          checkbox('Orient', !!c.orient, (v) => { c.orient = v; }),
        );
      } else if (c.type === 'FOLLOW_STREAM') {
        const streamSel = el('select') as HTMLSelectElement;
        streamSel.append(el('option', { value: '', text: '(pick stream)' }));
        for (const st of ctx.scene.mmStreams) {
          streamSel.append(el('option', { value: String(st.id), text: st.name }));
        }
        streamSel.value = c.streamId != null ? String(c.streamId) : '';
        // the landmark picker depends on the target stream's kind (the
        // body map only covers POSE/HAND/FACE), so a stream change needs
        // a rebuild
        streamSel.onchange = () => { c.streamId = streamSel.value ? Number(streamSel.value) : null; this.refresh(); };
        const targetStream = ctx.scene.mmStreams.find((s) => s.id === c.streamId);
        const landmarkMap = targetStream ? landmarkMapForKind(targetStream.kind, c.landmark ?? 0, (v) => { c.landmark = v; }) : null;
        rows.push(
          fieldRow('Stream', streamSel),
          landmarkMap ?? fieldRow('Landmark', numField('', c.landmark ?? 0, (v) => { c.landmark = Math.max(0, Math.round(v)); }, 1)),
          el('div', {
            class: 'row',
            text: landmarkMap ? 'click, pick, or drag a point above'
              : 'iris: 0/5 eye centers',
          }),
        );
      } else if (c.type === 'TRIGGER') {
        const shape = ref.kind === 'MESH'
          ? (ctx.scene.meshes.find((m) => m.id === ref.id)?.kind ?? 'MODEL')
          : null;
        const shapeText = shape === 'PLANE' ? 'zone: PLANE — fires when a probe CROSSES it'
          : shape && shape !== 'MODEL' ? `zone: ${shape} volume (its actual bounds)`
          : 'zone: sphere of Radius at the origin';
        rows.push(
          el('div', { class: 'row', text: `${shapeText} · probes: travelers + stream landmarks` }),
          fieldRow('Radius', numField('', c.radius ?? 0.25, (v) => { c.radius = Math.max(0.01, v); }, 0.05, { def: 0.25, min: 0.01 })),
          checkbox('Retrigger', c.retrigger !== false, (v) => { c.retrigger = v; }),
          el('div', { class: 'menu-header', text: 'On enter' }),
          this.msgEditor(c.messages ??= []),
          el('div', { class: 'menu-header', text: 'On leave' }),
          this.msgEditor(c.leaveMessages ??= []),
        );
      } else if (c.type === 'LIMIT_DISTANCE') {
        rows.push(...targetField(c), fieldRow('Distance', numField('', c.distance ?? 1, (v) => { c.distance = Math.max(0.001, v); }, 0.1)));
      } else if (c.type === 'SPRING') {
        rows.push(...targetField(c),
          fieldRow('Stiffness', numField('', c.stiffness ?? 12, (v) => { c.stiffness = Math.max(0, v); }, 1)),
          fieldRow('Damping', numField('', c.damping ?? 4, (v) => { c.damping = Math.max(0, v); }, 0.5)));
      } else if (c.type === 'SHRINKWRAP' || c.type === 'FLOOR') {
        rows.push(fieldRow('Offset', numField('', c.offset ?? 0, (v) => { c.offset = v; }, 0.05)));
      } else {
        rows.push(...targetField(c));
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
      panelHint('Follow Path makes this a traveler, Trigger makes it a proximity zone'),
      addSel,
      ...(items.length ? items : [el('div', { class: 'row', text: 'no constraints' })]),
    );
  }

  /** MediaMime (P11): live landmark addresses + the object-rigging table. */
  /** Native MediaMime: in-app webcam capture -> landmark streams rendered
   *  as confidence-encoded splat sprites. */
  /**
   * Editor for a DETECT stream. Open-vocabulary detection has no class list
   * to pick from — the queries you type ARE the classes — so the control is
   * a text field, one phrase per line, and the readout shows what actually
   * matched this frame.
   */
  private detectRows(st: MMStream, cfg: DetectConfig): Node[] {
    const { ctx } = this.app;
    const q = el('textarea', {
      class: 'detect-queries', rows: '3',
      placeholder: 'a person wearing a hat\na dog\na cardboard box',
    }) as HTMLTextAreaElement;
    q.value = cfg.queries.join('\n');
    q.onkeydown = (e) => e.stopPropagation();
    q.onchange = () => {
      cfg.queries = q.value.split('\n').map((l) => l.trim()).filter(Boolean);
      ctx.requestRender();
      this.refresh();
    };

    const status = semanticDetector.status;
    const statusText = status === 'ready'
      ? `${semanticDetector.device || 'ready'}${semanticDetector.lastMs ? ` · ${Math.round(semanticDetector.lastMs)} ms/run` : ''}`
      : status === 'loading' ? 'downloading model…'
        : status === 'error' ? semanticDetector.error.slice(0, 90)
          : 'idle';

    const hits: DetectHit[] = st.detectHits ?? [];
    return [
      fieldRow('Look for', q, { full: true }),
      el('div', { class: 'row' },
        selectField('', cfg.model, DETECT_MODELS.map((m) => [m.id, m.label] as [string, string]),
          (v) => { cfg.model = v; semanticDetector.dispose(); this.refresh(); }),
        checkbox('', cfg.webgpu, (v) => { cfg.webgpu = v; semanticDetector.dispose(); },
          'WebGPU when available — much faster than the WASM fallback'),
      ),
      el('div', { class: 'row' },
        numField('every ms', cfg.intervalMs, (v) => { cfg.intervalMs = Math.max(100, Math.round(v)); }, 100,
          { def: 600, min: 100, title: 'Open-vocabulary detection is not frame-rate work — this is how often a run starts' }),
        numField('min score', cfg.threshold, (v) => { cfg.threshold = Math.max(0.01, Math.min(1, v)); }, 0.01,
          { def: 0.12, min: 0.01, max: 1 }),
        numField('max', cfg.maxResults, (v) => { cfg.maxResults = Math.max(1, Math.round(v)); }, 1,
          { def: 8, min: 1, title: 'Cap on detections per frame — also the stream\u2019s point count' }),
      ),
      el('div', { class: 'detect-status' },
        el('span', { class: `detect-dot detect-${status}` }),
        el('span', { text: statusText, title: status === 'error' ? semanticDetector.detail : '' }),
        el('span', { class: 'grow' }),
        ...(hits.length
          ? hits.slice(0, 4).map((h) => el('span', {
            class: 'detect-hit',
            text: `${h.label} ${(h.score * 100).toFixed(0)}%`,
            title: `box ${h.box.map((v) => v.toFixed(2)).join(', ')}`,
          }))
          : [el('span', { class: 'detect-none', text: cfg.queries.length ? 'no matches' : 'no queries' })]),
      ),
    ];
  }

  /**
   * Wire a CAMERA-source stream to a virtual visitor instead of the live
   * webcam: any object as one tracked point, or — for a POSE stream — an
   * actor's whole skeleton. Seen through one of the scene's own cameras, so
   * the synthetic feed represents what a fixed camera in the room would
   * actually see, the same way a real installation's camera would.
   */
  private simSourceRow(st: MMStream): Node[] {
    const { ctx } = this.app;
    const driver = this.app.streamDriver(st.id);
    const curRef: ObjRef | null = !driver ? null
      : driver.source.kind === 'ACTOR' ? { kind: 'ACTOR', id: driver.source.actorId }
        : driver.source.ref;

    const picker = this.objectPickerField('Sim source',
      () => curRef,
      (ref) => {
        if (!ref) { this.app.clearStreamDriver(st.id); return; }
        const camIdx = driver?.cameraIndex ?? ctx.scene.activeCamera;
        // an actor picked for a POSE stream defaults to full-skeleton
        // sampling — that is the whole point of a POSE stream; anywhere
        // else (or any other object) it is one tracked point
        if (ref.kind === 'ACTOR' && st.kind === 'POSE') {
          this.app.setStreamDriver(st.id, { kind: 'ACTOR', actorId: ref.id }, camIdx);
        } else {
          this.app.setStreamDriver(st.id, { kind: 'OBJECT', ref }, camIdx);
        }
      });

    if (!driver) {
      return [el('div', { class: 'row' }, picker,
        el('span', { class: 'hint', text: 'optional — replaces the live camera for testing' }))];
    }

    const camSel = el('select') as HTMLSelectElement;
    ctx.scene.cameras.forEach((c, i) => camSel.append(el('option', { value: String(i), text: c.name })));
    camSel.value = String(driver.cameraIndex);
    camSel.onchange = () => this.app.setStreamDriver(st.id, driver.source, Number(camSel.value));

    // An actor can be driven either way; offer the switch only when it's
    // actually available, so the control never claims a choice that isn't
    // meaningful for a non-POSE stream.
    const actorRef: ObjRef | null = driver.source.kind === 'ACTOR'
      ? { kind: 'ACTOR', id: driver.source.actorId }
      : driver.source.kind === 'OBJECT' && driver.source.ref.kind === 'ACTOR' ? driver.source.ref : null;

    return [
      el('div', { class: 'row' },
        picker,
        btn(icon('xMark'), () => this.app.clearStreamDriver(st.id),
          { cls: 'icon-btn', title: 'Stop simulating — return to the live camera' }),
      ),
      el('div', { class: 'row' },
        'via camera', camSel,
        ...(st.kind === 'POSE' && actorRef ? [checkbox('full skeleton', driver.source.kind === 'ACTOR', (v) => {
          if (v) this.app.setStreamDriver(st.id, { kind: 'ACTOR', actorId: actorRef.id }, driver.cameraIndex);
          else this.app.setStreamDriver(st.id, { kind: 'OBJECT', ref: actorRef }, driver.cameraIndex);
        }, 'sample every mapped joint, not just this actor’s root')] : []),
      ),
    ];
  }

  private mmStreamsPanel(): HTMLElement {
    const { ctx } = this.app;
    const streams = ctx.scene.mmStreams;

    const running = mmCapture.status === 'on' || mmCapture.status === 'starting';
    const capLabel = mmCapture.status === 'on' ? `Stop (${mmCapture.sourceLabel})`
      : mmCapture.status === 'starting' ? 'Starting…'
      : 'Camera';
    const capRow = el('div', { class: 'row' },
      btn(iconLabel('camera', capLabel),
        () => { running ? this.app.mmCaptureToggle() : this.app.mmCaptureStart(); },
        { active: mmCapture.status === 'on', title: running ? 'Stop capture' : 'Webcam capture (MediaPipe, in-app — no bridge)' }),
      btn('＋Pose', () => this.app.addMMStreams(['POSE'], 'CAMERA'), { title: 'Body stream (33 points, flat by default — pose depth is noisy)' }),
      btn('＋Hands', () => this.app.addMMStreams(['HAND_LEFT', 'HAND_RIGHT'], 'CAMERA'), { title: 'Left + right hand streams (21 points each, with relative depth)' }),
      btn('＋Face', () => this.app.addMMStreams(['FACE', 'IRIS'], 'CAMERA'), { title: 'Face mesh (478 points) + iris (10 points) streams, with relative depth' }),
      btn('＋Detect', () => this.app.addMMStreams(['DETECT'], 'CAMERA'),
        { title: 'Semantic detection — type what to look for ("a person wearing a hat", "a dog") and each match becomes a probe' }),
    );

    // URL / file sources stand in for the webcam (testing, found footage,
    // environments where camera access is blocked)
    const urlInput = el('input', { type: 'text', placeholder: 'video / gif / webp URL', value: this.mmUrl }) as HTMLInputElement;
    urlInput.style.width = '150px';
    urlInput.onchange = () => { this.mmUrl = urlInput.value.trim(); };
    const srcFile = el('input', { type: 'file', accept: 'video/*,image/gif,image/webp,image/apng' }) as HTMLInputElement;
    srcFile.style.display = 'none';
    srcFile.onchange = () => { if (srcFile.files?.[0]) this.app.mmCaptureStart({ file: srcFile.files[0] }); };
    const srcRow = el('div', { class: 'row' },
      urlInput,
      btn(icon('play'), () => {
        this.mmUrl = urlInput.value.trim();
        if (this.mmUrl) this.app.mmCaptureStart({ url: this.mmUrl });
      }, { cls: 'icon-btn', title: 'Capture from this URL instead of the camera (video, or animated gif/webp)' }),
      srcFile,
      btn(iconLabel('folder', 'file…'), () => srcFile.click(), { title: 'Capture from a local video/gif/webp file' }),
    );

    const busInput = el('input', { type: 'text', placeholder: '/mp/pose', value: '' }) as HTMLInputElement;
    const busRow = el('div', { class: 'row' },
      busInput,
      btn('＋Bus stream', () => {
        const addr = busInput.value.trim();
        if (addr) this.app.addMMStreams(['CUSTOM'], 'BUS', addr);
      }, { title: 'Point stream fed from bus events <address>/<index> (x, y[, z[, confidence]])' }),
    );

    const rows: Node[] = streams.flatMap((st) => {
      const frame = streamStore.get(st.id);
      const recording = this.app.mmRecording({ kind: 'STREAM', id: st.id });
      const clip = st.source === 'CLIP' ? ctx.scene.clips.find((c) => c.id === st.clipId) : null;
      const recBtn = btn(icon('dot'), () => this.app.mmRecordToggle({ kind: 'STREAM', id: st.id }),
        { cls: 'icon-btn rec-btn', active: recording, title: recording ? 'Stop recording (saves a clip)' : 'Record this stream into a clip' });
      if (recording) recBtn.style.color = '#ff4444';
      const penBtn = checkbox('', !!st.pen?.active, (v) => {
        st.pen ??= { active: false, landmarks: [0], minConf: 0.5 };
        st.pen.active = v;
        this.refresh();
      }, `pen: draws into the active GP object · ${penLandmarkHint(st.kind)} · conf below min = pen up`);
      const driven = this.app.isStreamDriven(st.id);
      return [
        el('div', { class: 'row' },
          btn(st.visible ? icon('eye') : icon('eyeOff'), () => { st.visible = !st.visible; this.refresh(); }, { cls: 'icon-btn' }),
          colorField('', [...st.color, 1], (rgb) => { st.color = rgb; }),
          el('span', { class: 'grow', text: `${st.name}${st.source === 'BUS' ? ` ← ${st.busAddress}` : st.source === 'CLIP' ? ` ⟲ ${clip?.name ?? '(clip gone)'}` : ''}` }),
          ...(driven ? [el('span', { class: 'sim-badge', text: 'SIM', title: 'Driven from a virtual source, not the live camera' })] : []),
          el('span', { text: frame?.count ? `${frame.count} pts` : '—' }),
          penBtn,
          ...(st.source !== 'CLIP' ? [recBtn] : []),
          btn(icon('xMark'), () => this.app.deleteMMStream(st.id), { cls: 'icon-btn', title: 'Delete stream' }),
        ),
        // Simulated source: stand in a virtual visitor for the live camera,
        // so a whole zone/mapping setup can be built and tested with no
        // webcam attached, then swapped for a real one with no other change.
        ...(st.source === 'CAMERA' ? this.simSourceRow(st) : []),
        el('div', { class: 'row' },
          numField('size', st.pointSize, (v) => { st.pointSize = Math.max(0.001, v); }, 0.01,
            { def: st.kind === 'FACE' ? 0.012 : st.kind === 'IRIS' ? 0.02 : 0.04, min: 0.001 }),
          numField('depth', st.depthScale, (v) => { st.depthScale = v; }, 0.1,
            { def: st.source === 'CLIP' || st.kind !== 'POSE' ? 1 : 0 }),
          checkbox('', st.confidenceAlpha, (v) => { st.confidenceAlpha = v; }, 'confidence → opacity'),
          checkbox('', st.confidenceSize, (v) => { st.confidenceSize = v; }, 'confidence → point size'),
          checkbox('', st.mirror, (v) => { st.mirror = v; }, 'mirror'),
          checkbox('', st.probeEvents !== false, (v) => { st.probeEvents = v; }, 'probe: participates in trigger-zone events'),
          checkbox('', !!st.emitBus, (v) => { st.emitBus = v; }, 'emit bus: re-broadcast landmarks at the address prefix so rigs/routes/triggers can ride them'),
        ),
        // DETECT: the queries ARE the classes, so the editor is a text box
        ...(st.kind === 'DETECT' && st.detect ? this.detectRows(st, st.detect) : []),
        // CLIP replays get a traveler-style transport
        ...(st.source === 'CLIP' ? [el('div', { class: 'row' },
          btn(st.playing ? icon('pause') : icon('play'), () => { st.playing = !st.playing; this.refresh(); },
            { cls: 'icon-btn', active: !!st.playing }),
          slider('', st.phase ?? 0, 0, 1, 0.001, (v) => { st.phase = v; }, { def: 0 }),
          numField('speed', st.speed ?? 1, (v) => { st.speed = v; }, 0.1, { def: 1 }),
          selectField('', st.loop ?? 'LOOP', [['LOOP', 'Loop'], ['PINGPONG', 'Ping-pong'], ['ONCE', 'Once']], (v) => { st.loop = v as typeof st.loop; }),
        )] : []),
        // live pen: selected landmarks draw into the active GP object
        ...(st.pen?.active ? [
          el('div', { class: 'row' },
            ...(!hasLandmarkMap(st.kind) ? [
              numField('landmarks', st.pen.landmarks[0] ?? 0, (v) => { st.pen!.landmarks = [Math.max(0, Math.round(v))]; }, 1),
            ] : []),
            numField('min conf', st.pen.minConf, (v) => { st.pen!.minConf = Math.max(0, Math.min(1, v)); }, 0.05, { def: 0.5, min: 0, max: 1 }),
          ),
          ...[multiLandmarkMapForKind(st.kind, st.pen.landmarks, (ids) => { st.pen!.landmarks = ids; })].filter((n): n is HTMLElement => !!n),
        ] : []),
      ];
    });

    // playback speed only makes sense for URL/file sources, not the live
    // webcam — iterate on slow/fast footage without re-encoding it
    const speedRow = el('div', { class: 'row' },
      slider('speed', mmCapture.playbackRate, 0.1, 3, 0.05,
        (v) => this.app.mmSetPlaybackRate(v),
        { def: 1, title: 'URL/file capture playback rate (Backspace resets to 1×)' }),
    );

    const streamsPanel = panel('Streams — native capture',
      capRow,
      srcRow,
      ...(mmCapture.status === 'error' ? [el('div', { class: 'row', text: `! ${mmCapture.error.slice(0, 90)}` })] : []),
      ...(running && mmCapture.sourceLabel !== 'camera' ? [speedRow] : []),
      ...(mmCapture.status === 'on' || mmCapture.status === 'starting' ? [mmCapture.sourceEl] : []),
      busRow,
      ...(rows.length ? rows : [el('div', { class: 'row', text: 'no streams yet — add Pose/Hands then Start camera, or feed one from the bus' })]),
    );
    const streamsHeader = streamsPanel.querySelector('h3');
    if (streamsHeader) streamsHeader.title = 'camera streams re-emit world-space landmarks on the bus (prefix below), so rigs/routes/triggers can ride them';
    return streamsPanel;
  }

  /** Clip assets: recorded point-sets-over-time. Record from any stream
   *  (● on its row above) or the selected object's trajectory; play back
   *  as a stream; bake to GP strokes (confidence → pressure). */
  private clipsPanel(): HTMLElement {
    const { ctx } = this.app;
    const sel = listSelectedObjects(ctx.scene);
    const selRef = sel.length === 1 ? sel[0] : null;
    const objRecording = selRef && this.app.mmRecording({ kind: 'OBJECT', ref: selRef });
    const anyObjRecording = this.app.mmRecording() && !ctx.scene.mmStreams.some(
      (st) => this.app.mmRecording({ kind: 'STREAM', id: st.id }));

    const recObjBtn = btn(
      iconLabel('dot', objRecording ? 'Stop recording' : selRef ? `Record ${objectName(ctx.scene, selRef)}` : 'Record object…'),
      () => { if (selRef) this.app.mmRecordToggle({ kind: 'OBJECT', ref: selRef }); },
      {
        active: !!objRecording,
        title: selRef
          ? 'Record this object\'s world trajectory into a clip (travelers, followers, anything)'
          : 'Select exactly one object (object mode) to record its trajectory',
      });
    if (objRecording) recObjBtn.style.color = '#ff4444';

    const rows: Node[] = ctx.scene.clips.flatMap((clip) => {
      const nameInput = el('input', { type: 'text', value: clip.name }) as HTMLInputElement;
      nameInput.style.width = '110px';
      nameInput.onchange = () => { clip.name = nameInput.value.trim() || clip.name; };
      const trimmed = ((clip.trimEnd ?? 1) - (clip.trimStart ?? 0)) * clip.duration;
      const hasTrim = (clip.trimStart ?? 0) > 0 || (clip.trimEnd ?? 1) < 1;
      return [
        el('div', { class: 'row' },
          nameInput,
          el('span', { class: 'grow', text: `${(trimmed / 1000).toFixed(1)}s · ${clip.count} pt${clip.count === 1 ? '' : 's'} · ${clip.frames.length} f` }),
          btn(icon('play'), () => this.app.mmPlayClip(clip.id), { cls: 'icon-btn', title: 'Play as a stream (same rendering/constraints/events as live data)' }),
          btn(icon('pencil'), () => this.app.mmBakeClip(clip.id), { cls: 'icon-btn', title: 'Bake to GP strokes — one path per landmark, confidence becomes pressure' }),
          btn(icon('xMark'), () => this.app.mmDeleteClip(clip.id), { cls: 'icon-btn', title: 'Delete clip' }),
        ),
        // non-destructive trim window — playback + bake honor it
        el('div', { class: 'row' },
          slider('in', clip.trimStart ?? 0, 0, 1, 0.01, (v) => { clip.trimStart = Math.min(v, clip.trimEnd ?? 1); }),
          slider('out', clip.trimEnd ?? 1, 0, 1, 0.01, (v) => { clip.trimEnd = Math.max(v, clip.trimStart ?? 0); }),
          ...(hasTrim ? [btn(icon('scissors'), () => this.app.mmCropClip(clip.id), { cls: 'icon-btn', title: 'Crop: make the trim permanent (drops outside frames)' })] : []),
        ),
      ];
    });

    return panel('Clips',
      el('div', { class: 'row' }, recObjBtn,
        ...(anyObjRecording ? [el('span', { text: '● recording…' })] : [])),
      ...(rows.length ? rows : [el('div', { class: 'row', text: 'no clips yet — ● on a stream row records its points over time; baked clips become paths travelers can ride' })]),
    );
  }

  /** Rig mapper state: which body-part kind + landmark index is currently
   *  "loaded" for Attach, persisted across refreshes (not per-scene —
   *  it's a UI pick, not data). */
  private mmRigKind: RigMapKind = 'POSE';
  private mmRigLandmark = 0;
  private mmRigManual = false;
  private mmRigManualAddress = '';

  private mediamimePanel(): HTMLElement {
    const { ctx } = this.app;
    const mm = ctx.scene.mediamime;

    const prefixInput = el('input', { type: 'text', value: mm.prefix, placeholder: '/mp' }) as HTMLInputElement;
    prefixInput.title = 'uses the WS bridge below (IO panel)';
    prefixInput.onchange = () => { mm.prefix = prefixInput.value.trim() || '/mp'; };

    const rigTargets: { label: string; ref: ObjRef }[] = [
      ...ctx.scene.objects.map((o) => ({ label: `GP: ${o.name}`, ref: { kind: 'GP' as const, id: o.id } })),
      ...ctx.scene.meshes.map((m) => ({ label: `Mesh: ${m.name}`, ref: { kind: 'MESH' as const, id: m.id } })),
      ...ctx.scene.splats.map((s) => ({ label: `Splat: ${s.name}`, ref: { kind: 'SPLAT' as const, id: s.id } })),
      ...ctx.scene.score.triggers.map((t) => ({ label: `Trigger: ${t.name}`, ref: { kind: 'TRIGGER' as const, id: t.id } })),
    ];

    const live = mediamime.list();
    const liveByAddress = new Map(live.map((l) => [l.address, l]));

    // Rig mapper: click/pick the SOURCE landmark on the combined body
    // map (pose + a hand at each wrist + face above the head — one
    // diagram, since a point here can come from any of those four
    // kinds), then pick the TARGET from the dropdown — picking IS the
    // attach action (no separate button). Iris/custom addresses aren't
    // on the diagram yet, so a manual-address toggle covers them.
    const address = this.mmRigManual
      ? (this.mmRigManualAddress.trim() || `${mm.prefix || '/mp'}/iris/0`)
      : `${mm.prefix || '/mp'}/${RIG_KIND_PATH[this.mmRigKind]}/${this.mmRigLandmark}`;
    const liveInfo = liveByAddress.get(address);

    // eyedropper + dropdown both funnel through the same attach action —
    // pick a target either way, immediately rig it (no separate Attach
    // button; see the dropdown's own onchange below). Every new rig
    // starts from a clean transform; whether it KEEPS resetting rotation/
    // scale every frame after that is a per-rig checkbox in the Rigs list
    // below (rig.resetTransform), not a setting here.
    const attachTarget = (target: ObjRef) => {
      setObjectTransform(ctx.scene, target, { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
      this.app.addMediaMimeRig(address, target);
      this.refresh();
    };

    const eyedrop = btn('◎', () => {
      this.app.pickObject((ref) => { if (ref) attachTarget(ref); });
    }, { cls: 'icon-btn', title: 'Click, then click an object in the viewport to attach it (Esc cancels)' });

    const targetSel = el('select') as HTMLSelectElement;
    targetSel.append(el('option', { value: '', text: '(none)' }));
    rigTargets.forEach((t, i) => targetSel.append(el('option', { value: String(i), text: t.label })));
    targetSel.value = '';
    targetSel.onchange = () => {
      const v = targetSel.value;
      if (!v) return;
      attachTarget(rigTargets[Number(v)].ref);
      targetSel.value = '';
    };

    const manualInput = el('input', { type: 'text', value: this.mmRigManualAddress, placeholder: `${mm.prefix || '/mp'}/iris/0` }) as HTMLInputElement;
    manualInput.onchange = () => { this.mmRigManualAddress = manualInput.value; this.refresh(); };

    // dropdown alternative to clicking the body map — same (kind, id)
    // space it draws dots for, so picking here or on the map keeps both
    // in sync (both funnel through the same mmRigKind/mmRigLandmark
    // state, and combinedBodyMapPicker's own ring highlight follows it)
    const landmarkOptions = listRigLandmarks();
    const landmarkSel = el('select') as HTMLSelectElement;
    for (const [i, opt] of landmarkOptions.entries()) {
      landmarkSel.append(el('option', { value: String(i), text: `${opt.kind} ${opt.id} · ${opt.name}` }));
    }
    const curLandmarkIdx = landmarkOptions.findIndex((o) => o.kind === this.mmRigKind && o.id === this.mmRigLandmark);
    landmarkSel.value = curLandmarkIdx >= 0 ? String(curLandmarkIdx) : '';
    landmarkSel.onchange = () => {
      const opt = landmarkOptions[Number(landmarkSel.value)];
      if (opt) { this.mmRigKind = opt.kind; this.mmRigLandmark = opt.id; this.refresh(); }
    };

    const rigMapperRows: Node[] = [
      el('div', { class: 'row' },
        checkbox('manual address', this.mmRigManual, (v) => { this.mmRigManual = v; this.refresh(); },
          'iris, custom senders, or anything else not on the body map')),
      this.mmRigManual
        ? el('div', { class: 'row' }, 'Address', manualInput)
        : combinedBodyMapPicker(this.mmRigKind, this.mmRigLandmark, (k, v) => { this.mmRigKind = k; this.mmRigLandmark = v; this.refresh(); }, mm.prefix || '/mp'),
      el('div', {
        class: 'row',
        text: liveInfo
          ? `${address}  (${liveInfo.pos.map((n) => n.toFixed(2)).join(', ')})`
          : `${address}  · not seen yet — connect the WS bridge below and point a sender at this prefix`,
      }),
      ...(rigTargets.length ? [el('div', { class: 'row' },
        eyedrop, targetSel,
        ...(this.mmRigManual ? [] : [landmarkSel]),
        btn(icon('plus'), () => this.app.addMediaMimeTrigger(address, liveInfo?.pos ?? [0, 0, 0]),
          { cls: 'icon-btn', title: 'Trigger — spawn a trigger primitive rigged to this address' }),
      )] : []),
    ];

    // reset-transform is per rig, not a global setting — one plain
    // checkbox (no label) between scale and delete on each row
    const rigRows: Node[] = mm.rigs.map((rig) => el('div', { class: 'row', title: rig.address },
      checkbox('', rig.enabled, (v) => { rig.enabled = v; }),
      el('span', { class: 'grow', text: rig.name }),
      numField('scale', rig.scale, (v) => { rig.scale = v; }, 0.05),
      checkbox('', rig.resetTransform !== false, (v) => { rig.resetTransform = v; },
        'reset rotation to 0 and scale to 1 on the target every frame (unchecked: drive translation only, leave rotation/scale alone)'),
      btn(icon('xMark'), () => this.app.deleteMediaMimeRig(rig.id), { cls: 'icon-btn' }),
    ));

    return panel('Capture — landmarks & rigs',
      el('div', { class: 'menu-header', text: `Rig mapper · ${live.length} live address${live.length === 1 ? '' : 'es'}` }),
      ...rigMapperRows,
      el('div', { class: 'menu-header', text: 'Rigs (object ← address)' }),
      el('div', { class: 'row' }, 'Address prefix', prefixInput),
      ...(rigRows.length ? rigRows : [el('div', { class: 'row', text: 'none yet' })]),
    );
  }

  // ------------------------------------------------------------- agent

  /** Chat with a model that can drive the scene through the tool registry. */
  /**
   * Assistant chat. Deliberately a chat surface and nothing else: a log that
   * scrolls, a composer pinned under it, and a toolbar of icon actions.
   * Everything explanatory lives in `title` tooltips rather than as prose in
   * the panel — a sidebar this narrow cannot afford paragraphs, and they push
   * the thing you actually use off screen.
   */
  private agentPanel(): HTMLElement {
    const agent = this.app.agent;
    const st = agent.state;
    // Re-render through UI.refresh so the transcript survives (the panel owns
    // its own state; this container is rebuilt like every other panel).
    agent.setRerender(() => { if (this.propsTab === 'agent') this.refresh(); });

    const log = el('div', { class: 'agent-log' });
    for (const e of st.transcript) log.append(agentBubble(e));
    if (!st.transcript.length) {
      // Suggestions, not an explanation: each one is a prompt you can send.
      const seeds = ['Draw a spiral staircase', 'What is in the scene?', 'Add an actor and make it fall'];
      log.append(el('div', { class: 'agent-seeds' },
        ...seeds.map((q) => btn(q, () => { void agent.send(q); }, { cls: 'agent-seed', title: 'Send this prompt' }))));
    }
    // keep the newest turn in view across refreshes
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });

    const input = el('textarea', {
      class: 'agent-input', rows: '1',
      placeholder: st.busy ? 'Working…' : 'Message',
    }) as HTMLTextAreaElement;
    input.value = st.draft;
    input.disabled = st.busy;
    const autosize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    };
    input.oninput = () => { agent.setDraft(input.value); autosize(); };
    requestAnimationFrame(autosize);
    input.onkeydown = (e) => {
      e.stopPropagation();  // the app owns nearly every bare key
      // Enter sends, Shift+Enter is a newline — chat convention. Cmd/Ctrl+
      // Enter still works for anyone who learned the old binding.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void agent.send(input.value); }
    };

    const sendBtn = btn(st.busy ? icon('xMark') : icon('arrowUp'), () => {
      if (st.busy) agent.cancel(); else void agent.send(input.value);
    }, {
      cls: `agent-send${st.busy ? ' agent-send-stop' : ''}`,
      title: st.busy ? 'Stop this turn' : 'Send — Enter (Shift+Enter for a newline)',
    });

    return panel('Agent',
      el('div', { class: 'agent-chat' },
        el('div', { class: 'agent-bar' },
          el('span', { class: 'agent-chip', text: agent.describeProvider(), title: 'Active provider and model — change in Agent settings' }),
          el('span', { class: 'grow' }),
          btn(icon('duplicate'), () => { void navigator.clipboard?.writeText(agent.asText()); },
            { cls: 'icon-btn', title: 'Copy transcript' }),
          btn(icon('trash'), () => agent.clear(),
            { cls: 'icon-btn', title: 'Clear the transcript and the model’s memory of it' }),
        ),
        log,
        el('div', { class: 'agent-composer' }, input, sendBtn),
      ),
    );
  }

  /** Provider/model/behaviour, folded away under the chat. */
  private agentSettingsPanel(): HTMLElement {
    const agent = this.app.agent;
    const st = agent.state;
    const p = getProvider(st.settings.provider);
    const providerOpts = PROVIDER_LIST.map((d) =>
      [d.id, `${d.local ? '● ' : ''}${d.label}`] as [string, string]);

    const providerSel = selectField('Provider', st.settings.provider, providerOpts,
      (v) => agent.update({ provider: v }));
    // The per-provider setup note was a paragraph in the panel; it is the
    // same text, attached to the control it describes.
    providerSel.title = p.instructions;

    const urlInput = el('input', { type: 'text', class: 'grow', value: st.settings.urls[p.id] ?? p.defaultUrl }) as HTMLInputElement;
    urlInput.onchange = () => agent.setUrl(urlInput.value);
    urlInput.onkeydown = (e) => e.stopPropagation();

    const keyRows: Node[] = [];
    if (p.credentialLabel) {
      const keyInput = el('input', { type: 'password', class: 'grow', value: st.settings.keys[p.id] ?? '' }) as HTMLInputElement;
      keyInput.onchange = () => agent.setKey(keyInput.value);
      keyInput.onkeydown = (e) => e.stopPropagation();
      keyInput.title = 'Stored in this browser only (localStorage) — a development convenience, not a secret store';
      keyRows.push(fieldRow(p.credentialLabel, keyInput));
    }

    const modelControl = st.models.length
      ? selectField('', st.settings.model || st.models[0],
        st.models.map((m: string) => [m, m] as [string, string]), (v) => agent.update({ model: v }))
      : (() => {
        const i = el('input', { type: 'text', class: 'grow', value: st.settings.model, placeholder: p.defaultModel ?? 'model id' }) as HTMLInputElement;
        i.onchange = () => agent.update({ model: i.value });
        i.onkeydown = (e) => e.stopPropagation();
        return i;
      })();

    return panel('Agent settings',
      providerSel,
      fieldRow('Base URL', urlInput),
      ...keyRows,
      fieldRow('Model', el('div', { class: 'field-group' }, modelControl,
        btn(icon('rotate'), () => { void agent.refreshModels(); },
          { cls: 'icon-btn', title: 'Fetch the model list from the provider' }))),
      ...(st.modelError ? [fieldRow('', el('div', { class: 'hint error', text: st.modelError }))] : []),
      el('div', { class: 'menu-header', text: 'Behaviour' }),
      slider('Temperature', st.settings.temperature, 0, 2, 0.05, (v) => agent.update({ temperature: v }), { def: 0.7 }),
      numField('Max steps', st.settings.maxSteps, (v) => agent.update({ maxSteps: Math.max(1, Math.round(v)) }), 1,
        { def: 12, title: 'How many tool rounds one turn may take before stopping' }),
      numField('Max tokens', st.settings.maxTokens, (v) => agent.update({ maxTokens: Math.max(256, Math.round(v)) }), 256, { def: 4096 }),
      checkbox('Send viewport screenshot', st.settings.sendScreenshot,
        (v) => agent.update({ sendScreenshot: v }),
        'Attach a render of the viewport to each message. Vision-capable models only.'),
    );
  }

  /**
   * Everything else that can drive the same tool registry: the browser's own
   * agent (WebMCP), and out-of-process agents over the relay (MCP/ACP).
   */
  private agentLinkPanel(): HTMLElement {
    const agent = this.app.agent;
    const rpc = agent.rpc;
    const status = rpc.status;
    const url = rpc.url || 'ws://localhost:8787';
    const relayInput = el('input', { type: 'text', class: 'grow', value: url }) as HTMLInputElement;
    relayInput.onkeydown = (e) => e.stopPropagation();
    relayInput.title = 'WebSocket address of the relay process';

    const web = webMcp.probe();
    const webLabel: Record<typeof web, string> = {
      unsupported: 'unavailable',
      insecure: 'needs https',
      off: 'off',
      on: `${webMcp.count} tools`,
      error: 'error',
    };
    const webTitle: Record<typeof web, string> = {
      unsupported: 'This browser does not expose document.modelContext. Chrome 149 / Edge 150 ship it behind an origin trial.',
      insecure: 'WebMCP is restricted to secure contexts. Serve the page over https (localhost also counts).',
      off: 'Register this scene’s tools with the browser so its built-in agent can drive it',
      on: 'Registered — the browser’s agent can call these tools',
      error: webMcp.error,
    };
    const canWeb = web === 'off' || web === 'on' || web === 'error';

    return panel('Connections',
      el('div', { class: 'menu-header', text: 'WebMCP (this browser)' }),
      fieldRow('Status', el('span', {
        class: `agent-status agent-status-${web === 'on' ? 'open' : web === 'error' ? 'err' : 'off'}`,
        text: webLabel[web], title: webTitle[web],
      })),
      fieldRow('', (() => {
        const b = btn(webMcp.connected ? 'Unregister' : 'Register tools', () => {
          if (webMcp.connected) webMcp.disable();
          else void webMcp.enable().then(() => this.refresh());
          this.refresh();
        }, { cls: webMcp.connected ? '' : 'primary', title: webTitle[web] });
        // Nothing to register against: leave the control visible so the
        // capability is discoverable, but don't let it look actionable.
        b.disabled = !canWeb;
        return b;
      })(), { full: true }),
      ...(web === 'error' && webMcp.error
        ? [fieldRow('', el('div', { class: 'hint error', text: webMcp.error }))] : []),

      el('div', { class: 'menu-header', text: 'Relay (MCP / ACP)' }),
      fieldRow('Status', el('span', {
        class: `agent-status agent-status-${status}`,
        text: status === 'open' ? 'connected' : status === 'connecting' ? 'connecting…' : 'off',
        title: 'Lets Claude Code or Zed drive this scene. Start it with: node agent/relay.js',
      })),
      fieldRow('Relay', relayInput),
      fieldRow('', btn(status === 'off' ? 'Connect' : 'Disconnect', () => {
        if (status === 'off') rpc.connect(relayInput.value.trim());
        else rpc.disconnect();
        this.refresh();
      }, {
        cls: status === 'off' ? 'primary' : '',
        title: 'Register the bridge with: claude mcp add threegrease -- node agent/mcp-server.js',
      }), { full: true }),
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
      numField('FPS', s.fps, (v) => { s.fps = Math.max(1, Math.round(v)); }, 1, { def: 24, min: 1 }),
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
      btn(icon('photo'), () => this.app.captureCameraPlate(ctx.scene.activeCamera),
        { cls: 'icon-btn', title: 'Snapshot this camera’s view as a reference plane in front of it — perfectly registered to the space, to draw or build against' }),
      btn(icon('pin'), () => this.app.addCameraKey(), { cls: 'icon-btn', title: 'Keyframe the camera at the current frame' }),
      btn(icon('minus'), () => this.app.removeCameraKeyAtFrame(), { cls: 'icon-btn', title: 'Remove camera key at current frame' }),
      numField('FOV', activeCam(ctx.scene).fov, (v) => { activeCam(ctx.scene).fov = Math.min(140, Math.max(5, v)); }, 1, { def: 50, min: 5, max: 140, route: 'camera.0.fov' }),
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

    // keyframes of all layers (active layer bright) — no active GP object
    // once the scene has zero (Object mode tolerates that; see setMode)
    const ob = s.objects.length ? activeObject(s) : null;
    if (ob) {
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
    }

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
