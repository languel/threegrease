// Visual body-map picker for MediaPipe Pose landmarks (33 points) —
// replaces a bare numeric index field with a clickable/hoverable
// humanoid diagram, a name dropdown, and drag-to-pick. Companion pickers
// for hands/face follow the same shape once this one is proven out.
import { POSE_LANDMARK_EDGES, POSE_LANDMARK_NAMES, POSE_LANDMARK_POS, POSE_VIEWBOX } from '../mm/poseLandmarks';

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

/** Body-map picker: click a point, pick from the dropdown, or drag a
 *  point out (see POSE_LANDMARK_DRAG_MIME) — all three set the same value. */
export function poseMapPicker(value: number, onChange: (v: number) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pose-map';

  const svg = svgEl('svg', { viewBox: POSE_VIEWBOX, width: 150, height: 280 });
  svg.classList.add('pose-map-svg');

  for (const [a, b] of POSE_LANDMARK_EDGES) {
    const [ax, ay] = POSE_LANDMARK_POS[a];
    const [bx, by] = POSE_LANDMARK_POS[b];
    svg.append(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'pose-map-edge' }));
  }

  const dots: SVGCircleElement[] = [];
  const label = document.createElement('div');
  label.className = 'pose-map-label';

  const setLabel = (v: number) => {
    label.textContent = `${v}: ${POSE_LANDMARK_NAMES[v] ?? '?'}`;
  };

  const pick = (v: number) => {
    onChange(v);
    dots.forEach((d, i) => d.classList.toggle('picked', i === v));
    setLabel(v);
  };

  POSE_LANDMARK_POS.forEach(([x, y], i) => {
    const dot = svgEl('circle', { cx: x, cy: y, r: 8, class: 'pose-map-dot' });
    dot.classList.toggle('picked', i === value);
    dot.append(svgEl('title')); // native hover tooltip, filled below
    (dot.firstChild as SVGTitleElement).textContent = `${i}: ${POSE_LANDMARK_NAMES[i]}`;
    dot.style.cursor = 'pointer';
    dot.setAttribute('draggable', 'true');
    dot.onclick = () => pick(i);
    dot.ondragstart = (e) => {
      e.dataTransfer?.setData(POSE_LANDMARK_DRAG_MIME, String(i));
      e.dataTransfer?.setData('text/plain', String(i));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    };
    svg.append(dot);
    dots.push(dot);
  });

  // dropping a landmark back onto the map itself is equivalent to a click
  // — also accepts a drag that started elsewhere, once other pickers
  // (hands/face) or bind targets exist and use the same MIME type.
  wrap.ondragover = (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
  wrap.ondrop = (e) => {
    e.preventDefault();
    const v = Number(e.dataTransfer?.getData(POSE_LANDMARK_DRAG_MIME) || e.dataTransfer?.getData('text/plain'));
    if (Number.isInteger(v) && v >= 0 && v < POSE_LANDMARK_NAMES.length) pick(v);
  };

  const select = document.createElement('select');
  for (let i = 0; i < POSE_LANDMARK_NAMES.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i}: ${POSE_LANDMARK_NAMES[i]}`;
    select.append(opt);
  }
  select.value = String(value);
  select.onchange = () => pick(Number(select.value));

  setLabel(value);
  wrap.append(svg, select, label);
  return wrap;
}
