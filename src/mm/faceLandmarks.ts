// MediaPipe Face Mesh — curated subset for the visual picker: face oval,
// both eyes, both irises, and the lips, rather than all 468(+10 iris)
// points (way too dense to click). Index numbers are MediaPipe's real
// face-mesh indices (0-467 mesh, 468-477 iris — same iris indices this
// app's own IRIS_INDICES in mm/streams.ts uses), so a picked id is a
// valid landmark straight into the FACE stream's packed frame.
// Positions are a generated approximation (points evenly spaced around
// authored ellipses in loop order) — not a pixel-accurate face template,
// just readable at a glance, same spirit as poseLandmarks.ts.

export const FACE_VIEWBOX = '0 0 300 330';

// Ordered contour loops (MediaPipe's real index sequence per feature).
const FACE_OVAL: number[] = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
// subject's left eye (image right side)
const LEFT_EYE: number[] = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
// subject's right eye (image left side)
const RIGHT_EYE: number[] = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173];
const LIPS_OUTER: number[] = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_INNER: number[] = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 42, 183];
// MediaPipe iris indices (468-477): right center+ring, then left center+ring.
const RIGHT_IRIS_CENTER = 468;
const RIGHT_IRIS_RING: number[] = [469, 470, 471, 472];
const LEFT_IRIS_CENTER = 473;
const LEFT_IRIS_RING: number[] = [474, 475, 476, 477];

function ellipseRing(cx: number, cy: number, rx: number, ry: number, n: number, startDeg = -90): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

// Radii are sized so each loop's point-to-point spacing (checked
// numerically, not by the circumference/n average — an ellipse's real
// point spacing varies with curvature and the average badly
// underestimates the tightest gap) clears 2x the picker's dot radius (a
// fixed 6 units, same as pose/hand — every dot in the combined map is
// the same size now, so this layout carries the whole non-overlap
// requirement on its own instead of leaning on smaller dots there).
const OVAL_CENTER: [number, number] = [150, 165];
const OVAL_R: [number, number] = [140, 155];
const RIGHT_EYE_CENTER: [number, number] = [85, 125];
const LEFT_EYE_CENTER: [number, number] = [215, 125];
// sized so the eye ring sits equidistant between the iris ring and the
// oval boundary (dist(127,158) == dist(472,158), solved numerically —
// the previous, bigger eye hugged the oval edge instead)
const EYE_R: [number, number] = [44, 36];
const LIPS_CENTER: [number, number] = [150, 235];
// smallest size (found by grid search) that still clears 2x the dot
// radius on both loops and between them — the previous size read as
// crowding the oval edge
const LIPS_OUTER_R: [number, number] = [70, 56];
// more elongated than a circle (an inner-mouth opening reads as an oval,
// not a ring) — this is close to the most eccentric shape 20 points can
// take at this dot size before they'd start crowding each other
const LIPS_INNER_R: [number, number] = [56, 40];
const IRIS_R = 18;

const posMap = new Map<number, [number, number]>();
const nameMap = new Map<number, string>();
const edges: [number, number][] = [];

function addLoop(ids: number[], pos: [number, number][], namePrefix: string): void {
  ids.forEach((id, i) => {
    posMap.set(id, pos[i]);
    nameMap.set(id, `${namePrefix} ${i + 1}`);
  });
  for (let i = 0; i < ids.length; i++) edges.push([ids[i], ids[(i + 1) % ids.length]]);
}

addLoop(FACE_OVAL, ellipseRing(...OVAL_CENTER, ...OVAL_R, FACE_OVAL.length), 'face oval');
addLoop(LEFT_EYE, ellipseRing(...LEFT_EYE_CENTER, ...EYE_R, LEFT_EYE.length), 'left eye');
addLoop(RIGHT_EYE, ellipseRing(...RIGHT_EYE_CENTER, ...EYE_R, RIGHT_EYE.length), 'right eye');
addLoop(LIPS_OUTER, ellipseRing(...LIPS_CENTER, ...LIPS_OUTER_R, LIPS_OUTER.length), 'lips (outer)');
addLoop(LIPS_INNER, ellipseRing(...LIPS_CENTER, ...LIPS_INNER_R, LIPS_INNER.length), 'lips (inner)');

posMap.set(RIGHT_IRIS_CENTER, RIGHT_EYE_CENTER);
nameMap.set(RIGHT_IRIS_CENTER, 'right iris center');
addLoop(RIGHT_IRIS_RING, ellipseRing(RIGHT_EYE_CENTER[0], RIGHT_EYE_CENTER[1], IRIS_R, IRIS_R, RIGHT_IRIS_RING.length), 'right iris');
edges.push([RIGHT_IRIS_CENTER, RIGHT_IRIS_RING[0]]);

posMap.set(LEFT_IRIS_CENTER, LEFT_EYE_CENTER);
nameMap.set(LEFT_IRIS_CENTER, 'left iris center');
addLoop(LEFT_IRIS_RING, ellipseRing(LEFT_EYE_CENTER[0], LEFT_EYE_CENTER[1], IRIS_R, IRIS_R, LEFT_IRIS_RING.length), 'left iris');
edges.push([LEFT_IRIS_CENTER, LEFT_IRIS_RING[0]]);

export const FACE_LANDMARK_IDS: number[] = [...posMap.keys()].sort((a, b) => a - b);
export const FACE_LANDMARK_POS: Map<number, [number, number]> = posMap;
export const FACE_LANDMARK_NAMES: Map<number, string> = nameMap;
export const FACE_LANDMARK_EDGES: [number, number][] = edges;
