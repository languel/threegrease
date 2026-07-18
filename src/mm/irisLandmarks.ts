// Standalone IRIS stream's own local index space (0-9) — distinct from
// the iris points embedded inside the FACE stream's 478-point output
// (see IRIS_INDICES in mm/streams.ts, which is what feeds this stream:
// right center+ring packed first, then left center+ring, so this
// stream's local ids 0-9 line up 1:1 with that packing order).

export const IRIS_VIEWBOX = '0 0 220 120';

export const IRIS_LANDMARK_NAMES: string[] = [
  'right iris center', 'right iris 1', 'right iris 2', 'right iris 3', 'right iris 4',
  'left iris center', 'left iris 1', 'left iris 2', 'left iris 3', 'left iris 4',
];

function ring(cx: number, cy: number, r: number, n: number, startDeg = -90): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

const RIGHT_CENTER: [number, number] = [60, 60];
const LEFT_CENTER: [number, number] = [160, 60];
const RING_R = 24;

export const IRIS_LANDMARK_POS: [number, number][] = [
  RIGHT_CENTER, ...ring(...RIGHT_CENTER, RING_R, 4),
  LEFT_CENTER, ...ring(...LEFT_CENTER, RING_R, 4),
];

export const IRIS_LANDMARK_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 1],
  [5, 6], [6, 7], [7, 8], [8, 9], [9, 6],
];

/** Right-side ids (0-4) vs left-side ids (5-9), for the picker's
 *  leye/reye-matching color split. */
export const IRIS_RIGHT_IDS = [0, 1, 2, 3, 4];
export const IRIS_LEFT_IDS = [5, 6, 7, 8, 9];
