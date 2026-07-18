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
import { FACE_DOT_RADIUS, FACE_LANDMARK_EDGES, FACE_LANDMARK_IDS, FACE_LANDMARK_NAMES, FACE_LANDMARK_POS, FACE_VIEWBOX } from '../mm/faceLandmarks';
import type { MMStream } from '../core/types';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** MIME type carried by a dragged landmark dot's dataTransfer — a future
 *  drop target (e.g. a constraint/binding row) can read this to bind
 *  directly without going through the dropdown. */
export const POSE_LANDMARK_DRAG_MIME = 'application/x-tg-pose-landmark';

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
  /** dots are sized to leave a clear gap between neighbors given each
   *  set's own point spacing — dense sets (face) need smaller dots. */
  dotRadius?: number;
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
    dotRadius: FACE_DOT_RADIUS,
  };
}

/** One picker's worth of dots + drag/click wiring, appended into a
 *  caller-supplied <svg> (own coordinate space, transform applied by the
 *  caller for the combined map). `onPick(id)` fires on click/drag/drop. */
function addLandmarks(svg: SVGSVGElement, set: LandmarkSet, onPick: (id: number) => void): Map<number, SVGCircleElement> {
  for (const [a, b] of set.edges) {
    const [ax, ay] = set.pos(a);
    const [bx, by] = set.pos(b);
    svg.append(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'pose-map-edge' }));
  }
  const dots = new Map<number, SVGCircleElement>();
  const r = set.dotRadius ?? 8;
  for (const id of set.ids) {
    const [x, y] = set.pos(id);
    const dot = svgEl('circle', { cx: x, cy: y, r, class: `pose-map-dot${r < 6 ? ' pose-map-dot-sm' : ''}` });
    dot.append(svgEl('title'));
    (dot.firstChild as SVGTitleElement).textContent = `${id}: ${set.name(id)}`;
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
function singleKindPicker(set: LandmarkSet, value: number, onChange: (v: number) => void, widthPx: number, heightPx: number): HTMLElement {
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
  const dots = addLandmarks(svg, set, pick);
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
  return singleKindPicker(poseSet(), value, onChange, 150, 280);
}

export function handMapPicker(value: number, onChange: (v: number) => void): HTMLElement {
  return singleKindPicker(handSet(), value, onChange, 140, 160);
}

export function faceMapPicker(value: number, onChange: (v: number) => void): HTMLElement {
  return singleKindPicker(faceSet(), value, onChange, 160, 190);
}

/** Rig-mapper kind: matches MMStream['kind'] for POSE/HAND_LEFT/
 *  HAND_RIGHT/FACE (the four covered by the combined diagram) plus
 *  'iris'/'custom' for the manual-address fallback below it. */
export type RigMapKind = 'POSE' | 'HAND_LEFT' | 'HAND_RIGHT' | 'FACE';

// Vitruvian-style pose layout used ONLY by the combined map: arms spread
// wide and legs apart (rather than the standalone pose picker's more
// compact hanging-arm layout) so the attached hand diagrams have room to
// sit clear of the torso, and the pose's own crude face-cluster (ids
// 0-10) and hand-cluster (17-22) points are dropped entirely — the
// detailed face/hand diagrams cover that ground instead, so keeping
// both would just be redundant clutter sitting on top of each other.
const VITRUVIAN_POSE_POS: Record<number, [number, number]> = {
  11: [330, 400], 12: [570, 400],   // shoulders
  13: [230, 390], 14: [670, 390],   // elbows
  15: [130, 420], 16: [770, 420],   // wrists
  23: [390, 540], 24: [510, 540],   // hips
  25: [370, 660], 26: [530, 660],   // knees
  27: [355, 780], 28: [545, 780],   // ankles
  29: [330, 800], 30: [570, 800],   // heels
  31: [395, 805], 32: [505, 805],   // foot index
};

/** Combined picker for the MediaMime rig mapper: pose + a hand attached
 *  at each wrist + the face above the head, all in one diagram, since
 *  picking here can target any of the four kinds. Returns (kind, id). */
export function combinedBodyMapPicker(
  kind: RigMapKind, landmark: number, onChange: (kind: RigMapKind, id: number) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pose-map';

  const svg = svgEl('svg', { viewBox: '0 0 900 840', width: 300, height: 280 });
  svg.classList.add('pose-map-svg');

  const label = document.createElement('div');
  label.className = 'pose-map-label';

  const poseSetVitruvian: LandmarkSet = {
    ...poseSet((id) => id in VITRUVIAN_POSE_POS),
    pos: (id) => VITRUVIAN_POSE_POS[id],
  };
  const poseG = svgEl('g');
  svg.append(poseG);

  // hands: local origin is the wrist (id 0) at (100,210), fingers up.
  // Each hand's own wrist point lands on the pose's wrist. The hand's
  // local layout has the thumb on the LEFT (low x), so the left-side
  // hand is the one that gets mirrored — thumb faces the body on both
  // sides, like palms-forward vitruvian arms.
  const [lwx, lwy] = VITRUVIAN_POSE_POS[15];
  const [rwx, rwy] = VITRUVIAN_POSE_POS[16];
  const handScale = 1;
  const leftHandG = svgEl('g', {
    transform: `translate(${lwx + 100 * handScale} ${lwy - 210 * handScale}) scale(${-handScale} ${handScale})`,
  });
  const rightHandG = svgEl('g', {
    transform: `translate(${rwx - 100 * handScale} ${rwy - 210 * handScale}) scale(${handScale})`,
  });
  svg.append(leftHandG, rightHandG);

  // face: own viewBox is 240x224 — top-center, with clear air between
  // its bottom edge and the shoulder line, and between its sides and
  // the raised hands
  const faceScale = 1.4;
  const faceG = svgEl('g', { transform: `translate(282 10) scale(${faceScale})` });
  svg.append(faceG);

  const allDots = new Map<string, SVGCircleElement>();
  const key = (k: RigMapKind, id: number) => `${k}:${id}`;

  const pick = (k: RigMapKind, id: number) => {
    onChange(k, id);
    allDots.forEach((d, dk) => d.classList.toggle('picked', dk === key(k, id)));
    label.textContent = `${k} ${id}`;
  };

  const wire = (targetSvg: SVGGElement, set: LandmarkSet, k: RigMapKind) => {
    const dots = addLandmarks(targetSvg as unknown as SVGSVGElement, set, (id) => pick(k, id));
    for (const [id, d] of dots) allDots.set(key(k, id), d);
  };
  wire(poseG, poseSetVitruvian, 'POSE');
  wire(leftHandG, handSet(), 'HAND_LEFT');
  wire(rightHandG, handSet(), 'HAND_RIGHT');
  wire(faceG, faceSet(), 'FACE');

  allDots.get(key(kind, landmark))?.classList.add('picked');
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
    case 'HAND_LEFT': case 'HAND_RIGHT': return handMapPicker(value, onChange);
    case 'FACE': return faceMapPicker(value, onChange);
    default: return null;
  }
}
