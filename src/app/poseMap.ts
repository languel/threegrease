// Visual body-map pickers for MediaPipe landmarks — replace a bare
// numeric index field with a clickable/hoverable diagram, a name
// dropdown, and drag-to-pick. Three flavors sharing one core renderer:
// poseMapPicker (33 pose points), handMapPicker (21 hand points, either
// side), faceMapPicker (curated oval/eyes/iris/lips subset) — plus
// combinedBodyMapPicker, which draws all four together (hands attached
// at the pose wrists, face above the head) as the MediaMime rig mapper's
// single picking surface, since a point there can come from any kind.
import { POSE_LANDMARK_EDGES, POSE_LANDMARK_NAMES, POSE_LANDMARK_POS, POSE_VIEWBOX } from '../mm/poseLandmarks';
import { HAND_LANDMARK_EDGES, HAND_LANDMARK_NAMES, HAND_LANDMARK_POS, HAND_VIEWBOX } from '../mm/handLandmarks';
import { FACE_LANDMARK_EDGES, FACE_LANDMARK_IDS, FACE_LANDMARK_NAMES, FACE_LANDMARK_POS, FACE_LEFT_EYE_IDS, FACE_RIGHT_EYE_IDS, FACE_VIEWBOX } from '../mm/faceLandmarks';
import type { MMStream } from '../core/types';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** MIME type carried by a dragged landmark dot's dataTransfer — a future
 *  drop target (e.g. a constraint/binding row) can read this to bind
 *  directly without going through the dropdown. */
export const POSE_LANDMARK_DRAG_MIME = 'application/x-tg-pose-landmark';
/** Every dot everywhere is this size — pose/hand/face layouts are all
 *  authored so their own point spacing clears 2x this radius. */
const DOT_R = 6;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

interface LandmarkSet {
  ids: number[];
  pos: (id: number) => [number, number];
  name: (id: number) => string;
  edges: [number, number][];
  viewBox: string;
}

function poseSet(idFilter?: (id: number) => boolean): LandmarkSet {
  const ids = POSE_LANDMARK_POS.map((_, i) => i).filter((i) => idFilter?.(i) ?? true);
  const idSet = new Set(ids);
  return {
    ids,
    pos: (id) => POSE_LANDMARK_POS[id],
    name: (id) => POSE_LANDMARK_NAMES[id] ?? '?',
    edges: POSE_LANDMARK_EDGES.filter(([a, b]) => idSet.has(a) && idSet.has(b)),
    viewBox: POSE_VIEWBOX,
  };
}

function handSet(): LandmarkSet {
  return {
    ids: HAND_LANDMARK_POS.map((_, i) => i),
    pos: (id) => HAND_LANDMARK_POS[id],
    name: (id) => HAND_LANDMARK_NAMES[id] ?? '?',
    edges: HAND_LANDMARK_EDGES,
    viewBox: HAND_VIEWBOX,
  };
}

function faceSet(): LandmarkSet {
  return {
    ids: FACE_LANDMARK_IDS,
    pos: (id) => FACE_LANDMARK_POS.get(id) ?? [0, 0],
    name: (id) => FACE_LANDMARK_NAMES.get(id) ?? '?',
    edges: FACE_LANDMARK_EDGES,
    viewBox: FACE_VIEWBOX,
  };
}

const FACE_LEFT_EYE_SET = new Set(FACE_LEFT_EYE_IDS);
const FACE_RIGHT_EYE_SET = new Set(FACE_RIGHT_EYE_IDS);
/** Per-point face color: each eye (ring + its iris) gets its own color,
 *  the rest of the face (oval/lips) shares the default face color. */
function faceColorClass(id: number): string {
  if (FACE_LEFT_EYE_SET.has(id)) return 'pose-map-dot-leye';
  if (FACE_RIGHT_EYE_SET.has(id)) return 'pose-map-dot-reye';
  return 'pose-map-dot-face';
}

/** One picker's worth of dots + drag/click wiring, appended into a
 *  caller-supplied <svg> (own coordinate space, transform applied by the
 *  caller for the combined map). `onPick(id)` fires on click/drag/drop.
 *  `r` is in the SAME local units as `set.pos()` — pass a pre-divided
 *  radius when the caller wraps this in a scaled <g> so the ON-SCREEN
 *  size still comes out to DOT_R regardless of that group's scale. */
function addLandmarks(
  svg: SVGSVGElement, set: LandmarkSet, onPick: (id: number) => void, r: number = DOT_R,
  opts: { colorClass?: string | ((id: number) => string | undefined); titleFor?: (id: number) => string; skip?: (id: number) => boolean } = {},
): Map<number, SVGCircleElement> {
  for (const [a, b] of set.edges) {
    const [ax, ay] = set.pos(a);
    const [bx, by] = set.pos(b);
    svg.append(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'pose-map-edge' }));
  }
  const dots = new Map<number, SVGCircleElement>();
  for (const id of set.ids) {
    if (opts.skip?.(id)) continue;
    const [x, y] = set.pos(id);
    const colorClass = typeof opts.colorClass === 'function' ? opts.colorClass(id) : opts.colorClass;
    const cls = colorClass ? `pose-map-dot ${colorClass}` : 'pose-map-dot';
    const dot = svgEl('circle', { cx: x, cy: y, r, class: cls });
    dot.append(svgEl('title'));
    (dot.firstChild as SVGTitleElement).textContent = opts.titleFor ? opts.titleFor(id) : `${id}: ${set.name(id)}`;
    dot.style.cursor = 'pointer';
    dot.setAttribute('draggable', 'true');
    dot.onclick = () => onPick(id);
    dot.ondragstart = (e) => {
      e.dataTransfer?.setData(POSE_LANDMARK_DRAG_MIME, String(id));
      e.dataTransfer?.setData('text/plain', String(id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    };
    svg.append(dot);
    dots.set(id, dot);
  }
  return dots;
}

/** Single-kind picker: map + name dropdown + picked-point label. Used
 *  wherever a field is bound to one specific stream's own index space
 *  (a constraint's landmark, a stream's live-pen landmark). */
function singleKindPicker(
  set: LandmarkSet, value: number, onChange: (v: number) => void, widthPx: number, heightPx: number,
  colorClass?: string | ((id: number) => string | undefined),
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pose-map';

  const svg = svgEl('svg', { viewBox: set.viewBox, width: widthPx, height: heightPx });
  svg.classList.add('pose-map-svg');

  const label = document.createElement('div');
  label.className = 'pose-map-label';
  const setLabel = (v: number) => { label.textContent = `${v}: ${set.name(v)}`; };

  const pick = (v: number) => {
    onChange(v);
    dots.forEach((d, id) => d.classList.toggle('picked', id === v));
    select.value = String(v);
    setLabel(v);
  };
  const dots = addLandmarks(svg, set, pick, undefined, { colorClass });
  dots.get(value)?.classList.add('picked');

  wrap.ondragover = (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
  wrap.ondrop = (e) => {
    e.preventDefault();
    const v = Number(e.dataTransfer?.getData(POSE_LANDMARK_DRAG_MIME) || e.dataTransfer?.getData('text/plain'));
    if (dots.has(v)) pick(v);
  };

  const select = document.createElement('select');
  for (const id of set.ids) {
    const opt = document.createElement('option');
    opt.value = String(id);
    opt.textContent = `${id}: ${set.name(id)}`;
    select.append(opt);
  }
  select.value = String(value);
  select.onchange = () => pick(Number(select.value));

  setLabel(value);
  wrap.append(svg, select, label);
  return wrap;
}

export function poseMapPicker(value: number, onChange: (v: number) => void): HTMLElement {
  return singleKindPicker(poseSet(), value, onChange, 150, 280, 'pose-map-dot-pose');
}

export function handMapPicker(value: number, onChange: (v: number) => void, side: 'left' | 'right' = 'left'): HTMLElement {
  return singleKindPicker(handSet(), value, onChange, 140, 160, side === 'left' ? 'pose-map-dot-handL' : 'pose-map-dot-handR');
}

export function faceMapPicker(value: number, onChange: (v: number) => void): HTMLElement {
  return singleKindPicker(faceSet(), value, onChange, 190, 209, faceColorClass);
}

/** Rig-mapper kind: matches MMStream['kind'] for POSE/HAND_LEFT/
 *  HAND_RIGHT/FACE (the four covered by the combined diagram) plus
 *  'iris'/'custom' for the manual-address fallback below it. */
export type RigMapKind = 'POSE' | 'HAND_LEFT' | 'HAND_RIGHT' | 'FACE';

/** Bus-address path segment per rig-map kind (matches `streamBusPath` in
 *  mm/streams.ts) — shared here so the combined picker's hover tooltips
 *  can show a real resolvable address instead of just "id: name". */
export const RIG_KIND_PATH: Record<RigMapKind, string> = {
  POSE: 'pose', HAND_LEFT: 'hand/l', HAND_RIGHT: 'hand/r', FACE: 'face',
};

export interface RigLandmarkOption { kind: RigMapKind; id: number; name: string; }

/** Every landmark selectable on the combined body map, for a companion
 *  dropdown alongside it — same (kind, id) space `combinedBodyMapPicker`
 *  draws dots for, including each hand's own wrist (id 0), which has no
 *  dot of its own (it sits exactly on the pose wrist) but is still a
 *  distinct, valid address. */
export function listRigLandmarks(): RigLandmarkOption[] {
  const out: RigLandmarkOption[] = [];
  for (const id of Object.keys(VITRUVIAN_POSE_POS).map(Number).sort((a, b) => a - b)) {
    out.push({ kind: 'POSE', id, name: POSE_LANDMARK_NAMES[id] ?? '?' });
  }
  for (const kind of ['HAND_LEFT', 'HAND_RIGHT'] as const) {
    for (let id = 0; id < HAND_LANDMARK_POS.length; id++) out.push({ kind, id, name: HAND_LANDMARK_NAMES[id] ?? '?' });
  }
  for (const id of FACE_LANDMARK_IDS) out.push({ kind: 'FACE', id, name: FACE_LANDMARK_NAMES.get(id) ?? '?' });
  return out;
}

/** CSS class per rig-map kind (styles.css), matching the reference SVGs
 *  in docs/assets/: left hand green, right hand pink, body blue, head
 *  yellow. A class (not an inline fill) so :hover/.picked in the same
 *  stylesheet still take over — an SVG presentation attribute always
 *  loses to ANY stylesheet rule, inline style always beats every
 *  stylesheet rule including :hover/.picked, so only a class survives
 *  both directions of that cascade. */
const KIND_COLOR_CLASS: Record<RigMapKind, string> = {
  POSE: 'pose-map-dot-pose', HAND_LEFT: 'pose-map-dot-handL', HAND_RIGHT: 'pose-map-dot-handR', FACE: 'pose-map-dot-face',
};

// Vitruvian-style pose layout used ONLY by the combined map: arms spread
// wide and legs apart (rather than the standalone pose picker's more
// compact hanging-arm layout) so the attached hand diagrams have room to
// sit clear of the torso, and the pose's own crude face-cluster (ids
// 0-10) and hand-cluster (17-22) points are dropped entirely — the
// detailed face/hand diagrams cover that ground instead, so keeping
// both would just be redundant clutter sitting on top of each other.
const VITRUVIAN_POSE_POS: Record<number, [number, number]> = {
  11: [505, 786], 12: [865, 786],   // shoulders
  13: [355, 771], 14: [1015, 771],  // elbows
  15: [205, 816], 16: [1165, 816],  // wrists
  23: [595, 996], 24: [775, 996],   // hips
  25: [565, 1176], 26: [805, 1176], // knees
  27: [543, 1356], 28: [827, 1356], // ankles
  29: [505, 1386], 30: [865, 1386], // heels
  31: [603, 1393], 32: [767, 1393], // foot index
};

/** Combined picker for the capture rig mapper: pose + a hand attached at
 *  each wrist + the face above the head, all in one diagram, since
 *  picking here can target any of the four kinds. Returns (kind, id).
 *  `prefix` (the bus address prefix, e.g. "/mp") is used only to build
 *  each dot's hover tooltip as a real resolvable address. */
export function combinedBodyMapPicker(
  kind: RigMapKind, landmark: number, onChange: (kind: RigMapKind, id: number) => void, prefix: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pose-map';

  // The rotated hands (see below) reach further out horizontally than
  // the old fingers-up layout did — viewBox widened (and shifted left)
  // so both are fully inside it instead of clipped at the edges.
  const svg = svgEl('svg', { viewBox: '-220 0 1810 1430', width: 350, height: 276 });
  svg.classList.add('pose-map-svg');

  const label = document.createElement('div');
  label.className = 'pose-map-label';

  const poseSetVitruvian: LandmarkSet = {
    ...poseSet((id) => id in VITRUVIAN_POSE_POS),
    pos: (id) => VITRUVIAN_POSE_POS[id],
  };
  const poseG = svgEl('g');
  svg.append(poseG);

  // Every dot reads the same size on screen regardless of which sub-
  // diagram it's in, even though pose/hand/face live at different group
  // scales — divide the target radius by each group's own scale before
  // handing it to addLandmarks (which draws in that group's local units).
  const ON_SCREEN_DOT_R = 12;

  // hands: local origin is the wrist (id 0) at (100,210), fingers "up"
  // in their own frame. A rotate(*, 100, 210) around that same pivot
  // (applied first, before the scale/translate that place the wrist on
  // the pose's own wrist) turns the fingers outward instead — open arms,
  // like reaching in for a hug, rather than fingers pointing straight up.
  // The hand's local layout has the thumb on the LEFT (low x), so the
  // left-side hand is the one that gets mirrored — thumb still faces the
  // body on both sides.
  const [lwx, lwy] = VITRUVIAN_POSE_POS[15];
  const [rwx, rwy] = VITRUVIAN_POSE_POS[16];
  const handScale = 2;
  const leftHandG = svgEl('g', {
    transform: `translate(${lwx + 100 * handScale} ${lwy - 210 * handScale}) scale(${-handScale} ${handScale}) rotate(90 100 210)`,
  });
  const rightHandG = svgEl('g', {
    transform: `translate(${rwx - 100 * handScale} ${rwy - 210 * handScale}) scale(${handScale}) rotate(90 100 210)`,
  });
  svg.append(leftHandG, rightHandG);

  // face: own viewBox is 300x300 — top-center, with clear air between
  // its bottom edge and the shoulder line, and between its sides and
  // the raised hands
  const faceScale = 2.2;
  const faceG = svgEl('g', { transform: `translate(355 18) scale(${faceScale})` });
  svg.append(faceG);

  const allDots = new Map<string, SVGCircleElement>();
  const key = (k: RigMapKind, id: number) => `${k}:${id}`;

  // Highlight ring: a larger orange circle FRAMING the picked dot, rather
  // than recoloring the dot itself (which would hide its kind color) —
  // one ring per group, living in that group's own coordinate space so
  // it tracks the group's transform, shown/hidden/repositioned on pick.
  const groupScaleOf: Record<RigMapKind, number> = { POSE: 1, HAND_LEFT: handScale, HAND_RIGHT: handScale, FACE: faceScale };
  const groupOf: Record<RigMapKind, SVGGElement> = { POSE: poseG, HAND_LEFT: leftHandG, HAND_RIGHT: rightHandG, FACE: faceG };
  const ringOf: Record<RigMapKind, SVGCircleElement> = {} as Record<RigMapKind, SVGCircleElement>;
  for (const k of ['POSE', 'HAND_LEFT', 'HAND_RIGHT', 'FACE'] as const) {
    const ring = svgEl('circle', { r: (ON_SCREEN_DOT_R + 6) / groupScaleOf[k], class: 'pose-map-ring' });
    ring.style.display = 'none';
    groupOf[k].append(ring);
    ringOf[k] = ring;
  }
  const showRing = (k: RigMapKind, id: number) => {
    for (const rk of ['POSE', 'HAND_LEFT', 'HAND_RIGHT', 'FACE'] as const) ringOf[rk].style.display = 'none';
    // a hand's own wrist (id 0) has no dot of its own — it sits exactly
    // on the pose wrist, so frame that dot instead
    const dot = (k === 'HAND_LEFT' && id === 0) ? allDots.get(key('POSE', 15))
      : (k === 'HAND_RIGHT' && id === 0) ? allDots.get(key('POSE', 16))
      : allDots.get(key(k, id));
    if (!dot) return;
    const ringKind = (k === 'HAND_LEFT' || k === 'HAND_RIGHT') && id === 0 ? 'POSE' : k;
    const ring = ringOf[ringKind];
    ring.setAttribute('cx', dot.getAttribute('cx')!);
    ring.setAttribute('cy', dot.getAttribute('cy')!);
    ring.style.display = '';
  };

  const pick = (k: RigMapKind, id: number) => {
    onChange(k, id);
    showRing(k, id);
    label.textContent = `${k} ${id}`;
  };

  const wire = (
    targetSvg: SVGGElement, set: LandmarkSet, k: RigMapKind, groupScale: number,
    skip?: (id: number) => boolean, colorClass: string | ((id: number) => string | undefined) = KIND_COLOR_CLASS[k],
  ) => {
    const dots = addLandmarks(targetSvg as unknown as SVGSVGElement, set, (id) => pick(k, id), ON_SCREEN_DOT_R / groupScale, {
      colorClass,
      titleFor: (id) => `${id} · ${set.name(id)} · ${prefix}/${RIG_KIND_PATH[k]}/${id}`,
      skip,
    });
    for (const [id, d] of dots) allDots.set(key(k, id), d);
  };
  wire(poseG, poseSetVitruvian, 'POSE', 1);
  // the hand's own wrist point (id 0) sits exactly on the pose's own
  // wrist — skip drawing it so the body-colored pose marker is the only
  // one shown there instead of two stacked circles
  wire(leftHandG, handSet(), 'HAND_LEFT', handScale, (id) => id === 0);
  wire(rightHandG, handSet(), 'HAND_RIGHT', handScale, (id) => id === 0);
  wire(faceG, faceSet(), 'FACE', faceScale, undefined, faceColorClass);

  showRing(kind, landmark);
  label.textContent = `${kind} ${landmark}`;

  wrap.ondragover = (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
  wrap.ondrop = (e) => {
    e.preventDefault();
    const v = Number(e.dataTransfer?.getData(POSE_LANDMARK_DRAG_MIME) || e.dataTransfer?.getData('text/plain'));
    // a drag started on this same map already fired onclick's pick()
    // logic isn't available here (id alone is ambiguous across kinds),
    // so a cross-widget drop just re-picks within the currently active
    // kind — good enough until a second combined map exists to drag between.
    if (Number.isInteger(v)) pick(kind, v);
  };

  wrap.append(svg, label);
  return wrap;
}

/** Does this stream kind have a visual picker? (POSE/HAND/FACE — not
 *  IRIS/CUSTOM, which stay numeric-only for now.) */
export function hasLandmarkMap(kind: MMStream['kind']): boolean {
  return kind === 'POSE' || kind === 'HAND_LEFT' || kind === 'HAND_RIGHT' || kind === 'FACE';
}

/** Single-kind picker matching a specific stream's kind, or null if that
 *  kind has no visual picker yet (caller falls back to a numeric field). */
export function landmarkMapForKind(kind: MMStream['kind'], value: number, onChange: (v: number) => void): HTMLElement | null {
  switch (kind) {
    case 'POSE': return poseMapPicker(value, onChange);
    case 'HAND_LEFT': return handMapPicker(value, onChange, 'left');
    case 'HAND_RIGHT': return handMapPicker(value, onChange, 'right');
    case 'FACE': return faceMapPicker(value, onChange);
    default: return null;
  }
}
