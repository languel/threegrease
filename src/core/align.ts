// REGISTRATION: the rotation, uniform scale and translation that carry one
// set of points onto another, matched by index. It is how a scan is fitted
// to the thing it is a scan of — pick the corners of a pedestal in the scan,
// the same corners on a virtual box of known size, and the scan is moved,
// turned and scaled so the two sets coincide as closely as they can.
//
// Horn's closed form (1987, "Closed-form solution of absolute orientation
// using unit quaternions"): the best rotation is the eigenvector of the
// largest eigenvalue of a symmetric 4x4 built from the cross-covariance of
// the two centred sets, so there is no SVD to write and no reflection to
// guard against — a unit quaternion cannot mirror. Given that rotation the
// least-squares scale is Σ b'·Ra' / Σ|a'|², and the translation takes one
// centroid onto the other.
import * as THREE from 'three';

export interface AlignResult {
  /** world matrix taking source points onto the target: T · s·R */
  matrix: THREE.Matrix4;
  scale: number;
  /** root-mean-square distance left between the pairs, after alignment */
  rms: number;
  /** the worst pair's distance */
  max: number;
}

/** Largest-eigenvalue eigenvector of a symmetric 4x4 (Jacobi). */
function topEigenvector(m: number[][]): number[] {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * Fit `source` onto `target` (same length, paired by index, at least 3
 * points that are not all on one line). `allowScale: false` fits a rigid
 * motion only — for a scan already in true units.
 */
export function alignPoints(
  source: THREE.Vector3[], target: THREE.Vector3[], allowScale = true,
): AlignResult | null {
  const n = source.length;
  if (n < 3 || target.length !== n) return null;
  const ca = new THREE.Vector3(), cb = new THREE.Vector3();
  for (let i = 0; i < n; i++) { ca.add(source[i]); cb.add(target[i]); }
  ca.divideScalar(n); cb.divideScalar(n);
  const A = source.map((p) => p.clone().sub(ca));
  const B = target.map((p) => p.clone().sub(cb));

  // cross-covariance S[i][j] = Σ a_i b_j
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let aa = 0;
  for (let k = 0; k < n; k++) {
    const a = A[k].toArray(), b = B[k].toArray();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += a[i] * b[j];
    aa += A[k].lengthSq();
  }
  if (aa < 1e-12) return null;
  const [[sxx, sxy, sxz], [syx, syy, syz], [szx, szy, szz]] = S;
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const [w, x, y, z] = topEigenvector(N);
  const q = new THREE.Quaternion(x, y, z, w).normalize();

  let s = 1;
  if (allowScale) {
    let num = 0;
    for (let k = 0; k < n; k++) num += B[k].dot(A[k].clone().applyQuaternion(q));
    s = num / aa;
    if (!(s > 1e-9)) return null;
  }
  const t = cb.clone().sub(ca.clone().applyQuaternion(q).multiplyScalar(s));
  const matrix = new THREE.Matrix4().compose(t, q, new THREE.Vector3(s, s, s));

  let sum = 0, max = 0;
  for (let k = 0; k < n; k++) {
    const d = source[k].clone().applyMatrix4(matrix).distanceTo(target[k]);
    sum += d * d;
    max = Math.max(max, d);
  }
  return { matrix, scale: s, rms: Math.sqrt(sum / n), max };
}

// ---------------------------------------------------------------------------
// FITTING SHAPES THAT DO NOT PAIR UP.
//
// `alignPoints` needs the same corners clicked in the same order. People do
// not do that: one measurement goes round the top of a pedestal clockwise,
// the other anticlockwise from a different corner, or one traces four
// corners and the other three, or an edge and a half. So `alignShapes`
// works in two stages:
//  1. SAME COUNT: try every pairing (all orders up to 8 points, every start
//     and both directions beyond that) and keep the best — which covers the
//     common case exactly, and says the order did not matter.
//  2. OTHERWISE, SHAPE FIT: both measurements are resampled along their legs
//     into point clouds, a first guess lines up their principal axes (centre,
//     orientation and spread; every proper way of turning one frame onto the
//     other, since an axis has no preferred sign and a flat or straight
//     shape has no preferred axis), and ICP refines it with correspondences
//     taken BOTH ways — nearest target for each source point and nearest
//     source for each target point. One-way ICP with free scale shrinks the
//     source into a corner of the target, because that always lowers the
//     one-way error; the symmetric version cannot cheat that way.

export interface ShapeAlignResult extends AlignResult {
  method: 'paired' | 'reordered' | 'shape';
}

/** How far a fit TURNS the object, radians. */
function turnOf(m: THREE.Matrix4): number {
  const q = new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

/**
 * AMONG EQUALLY GOOD FITS, THE ONE THAT TURNS LEAST. A square pedestal top
 * fits four ways, and a flat measurement cannot say which side the object
 * is on — a shape fit is as happy with the pedestal hanging upside down
 * from its own top face. Assuming the object was put in roughly the right
 * way up first (it nearly always is: a scan is at least upright-ish) picks
 * the intended one out of a set the numbers cannot separate.
 */
function leastTurn<T extends { matrix: THREE.Matrix4; err: number }>(cands: T[], slack = 1.1): T | null {
  if (!cands.length) return null;
  const best = Math.min(...cands.map((c) => c.err));
  const near = cands.filter((c) => c.err <= best * slack + 1e-6 * (1 + best));
  return near.reduce((a, b) => (turnOf(b.matrix) < turnOf(a.matrix) ? b : a));
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = [...Array(n).keys()];
  const rec = (k: number) => {
    if (k === n) { out.push(a.slice()); return; }
    for (let i = k; i < n; i++) { [a[k], a[i]] = [a[i], a[k]]; rec(k + 1); [a[k], a[i]] = [a[i], a[k]]; }
  };
  rec(0);
  return out;
}

/** Points along a polyline, evenly by arc length (corners always kept). */
function resample(pts: THREE.Vector3[], closed: boolean, count: number): THREE.Vector3[] {
  if (pts.length < 2) return pts.map((p) => p.clone());
  const legs: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i + 1 < pts.length; i++) legs.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 2) legs.push([pts[pts.length - 1], pts[0]]);
  const total = legs.reduce((s, [a, b]) => s + a.distanceTo(b), 0);
  const out = pts.map((p) => p.clone());
  if (total < 1e-9) return out;
  for (const [a, b] of legs) {
    const k = Math.floor((a.distanceTo(b) / total) * count);
    for (let j = 1; j < k; j++) out.push(a.clone().lerp(b, j / k));
  }
  return out;
}

function centroid(p: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const v of p) c.add(v);
  return c.divideScalar(Math.max(1, p.length));
}

/** Principal axes (columns, largest variance first) and RMS spread. */
function frameOf(p: THREE.Vector3[]): { c: THREE.Vector3; axes: THREE.Vector3[]; spread: number } {
  const c = centroid(p);
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let ss = 0;
  for (const v of p) {
    const d = v.clone().sub(c).toArray();
    ss += d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
  }
  // eigenvectors of the 3x3 covariance via the 4x4 routine's Jacobi idea,
  // done directly here
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 40; sweep++) {
    for (let pI = 0; pI < 3; pI++) for (let q = pI + 1; q < 3; q++) {
      if (Math.abs(a[pI][q]) < 1e-300) continue;
      const th = (a[q][q] - a[pI][pI]) / (2 * a[pI][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { const x = a[k][pI], y = a[k][q]; a[k][pI] = cs * x - sn * y; a[k][q] = sn * x + cs * y; }
      for (let k = 0; k < 3; k++) { const x = a[pI][k], y = a[q][k]; a[pI][k] = cs * x - sn * y; a[q][k] = sn * x + cs * y; }
      for (let k = 0; k < 3; k++) { const x = v[k][pI], y = v[k][q]; v[k][pI] = cs * x - sn * y; v[k][q] = sn * x + cs * y; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const axes = order.map((k) => new THREE.Vector3(v[0][k], v[1][k], v[2][k]).normalize());
  // right-handed, so a frame-to-frame map is a rotation, never a mirror
  axes[2] = new THREE.Vector3().crossVectors(axes[0], axes[1]).normalize();
  return { c, axes, spread: Math.sqrt(ss / Math.max(1, p.length)) };
}

/** The 24 rotations of a cube: every proper way of relabelling the axes. */
const CUBE_ROTATIONS: THREE.Matrix4[] = (() => {
  const out: THREE.Matrix4[] = [];
  const e = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  for (const i of [0, 1, 2]) for (const si of [1, -1]) for (const j of [0, 1, 2]) {
    if (j === i) continue;
    for (const sj of [1, -1]) {
      const x = e[i].clone().multiplyScalar(si), y = e[j].clone().multiplyScalar(sj);
      out.push(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)));
    }
  }
  return out;
})();

function nearest(p: THREE.Vector3, set: THREE.Vector3[]): THREE.Vector3 {
  let best = set[0], bd = Infinity;
  for (const q of set) { const d = p.distanceToSquared(q); if (d < bd) { bd = d; best = q; } }
  return best;
}

/** Symmetric chamfer RMS between two point sets. */
function chamfer(a: THREE.Vector3[], b: THREE.Vector3[]): number {
  let s = 0;
  for (const p of a) s += p.distanceToSquared(nearest(p, b));
  for (const p of b) s += p.distanceToSquared(nearest(p, a));
  return Math.sqrt(s / (a.length + b.length));
}

/**
 * Fit the shape `source` (a measurement's points, in order) onto `target`.
 * Same counts are paired exactly when an ordering fits; anything else is a
 * shape fit. `max` is the worst corner's distance for a pairing, and the
 * worst sample's for a shape fit.
 */
export function alignShapes(
  source: THREE.Vector3[], target: THREE.Vector3[],
  opts: { allowScale?: boolean; sourceClosed?: boolean; targetClosed?: boolean } = {},
): ShapeAlignResult | null {
  const allowScale = opts.allowScale ?? true;
  if (source.length < 2 || target.length < 2) return null;
  const size = frameOf(target).spread || 1;

  // 1. same count: the best ordering
  if (source.length === target.length && source.length >= 3) {
    const n = source.length;
    const orders: number[][] = n <= 8 ? permutations(n) : (() => {
      const o: number[][] = [];
      for (let s = 0; s < n; s++) for (const dir of [1, -1]) o.push([...Array(n).keys()].map((k) => (s + dir * k + n * 2) % n));
      return o;
    })();
    const cands: (AlignResult & { err: number; oi: number })[] = [];
    orders.forEach((ord, oi) => {
      const r = alignPoints(ord.map((k) => source[k]), target, allowScale);
      if (r) cands.push({ ...r, err: r.rms, oi });
    });
    // the order AS CLICKED wins whenever it is as good as the best: a
    // symmetric shape (a box has 24) has several equally exact orders, and
    // the one you chose is the one that keeps the scan's CONTENTS the way
    // round you meant — only when yours is clearly worse is the order found
    const clicked = cands.find((c) => orders[c.oi].every((k, i) => k === i));
    const minErr = cands.length ? Math.min(...cands.map((c) => c.err)) : Infinity;
    const pick = clicked && clicked.err <= minErr * 1.1 + 1e-6 * (1 + size) ? clicked : leastTurn(cands);
    const b = pick as AlignResult | null;
    const bestOrder = pick?.oi ?? 0;
    // a pairing that agrees to a few percent of the shape's size is the
    // answer; a bad one means the shapes are not the same corners at all
    if (b && b.rms < 0.05 * size) {
      const identity = orders[bestOrder].every((k, i) => k === i);
      return { ...b, method: identity ? 'paired' : 'reordered' };
    }
  }

  // 1b. POINTS ON POINTS, counts differ: one set is (roughly) a subset of the
  // other — six of a pedestal's eight corners, say. Hypothesise and verify:
  // a well-spread triangle of the smaller set is tried against every ordered
  // triple of the larger, each triple fixes a transform, and the one under
  // which EVERY point of the smaller set lands on a distinct point of the
  // larger wins — then refined over all of those pairs.
  const sub = matchSubset(source, target, allowScale, size, !!opts.sourceClosed, !!opts.targetClosed);
  if (sub) return sub;

  // two points each: a segment onto a segment (no roll to solve for)
  if (source.length === 2 && target.length === 2) {
    const tryEnds = (a0: THREE.Vector3, a1: THREE.Vector3): ShapeAlignResult => {
      const da = a1.clone().sub(a0), db = target[1].clone().sub(target[0]);
      const s = allowScale ? db.length() / Math.max(1e-9, da.length()) : 1;
      const q = new THREE.Quaternion().setFromUnitVectors(da.clone().normalize(), db.clone().normalize());
      const ma = a0.clone().add(a1).multiplyScalar(0.5), mb = target[0].clone().add(target[1]).multiplyScalar(0.5);
      const t = mb.clone().sub(ma.clone().applyQuaternion(q).multiplyScalar(s));
      const matrix = new THREE.Matrix4().compose(t, q, new THREE.Vector3(s, s, s));
      const e0 = a0.clone().applyMatrix4(matrix).distanceTo(target[0]);
      return { matrix, scale: s, rms: e0, max: e0, method: 'paired' };
    };
    return tryEnds(source[0], source[1]);
  }

  // 2. shape fit
  const S = resample(source, !!opts.sourceClosed, 48);
  const T = resample(target, !!opts.targetClosed, 48);
  const targetLegs = legsOf(target, !!opts.targetClosed);
  const fs = frameOf(S), ft = frameOf(T);
  const s0 = allowScale ? ft.spread / Math.max(1e-9, fs.spread) : 1;
  const Rs = new THREE.Matrix4().makeBasis(fs.axes[0], fs.axes[1], fs.axes[2]);
  const Rt = new THREE.Matrix4().makeBasis(ft.axes[0], ft.axes[1], ft.axes[2]);
  const fits: { matrix: THREE.Matrix4; err: number }[] = [];
  for (const C of CUBE_ROTATIONS) {
    // world <- target frame <- relabel <- source frame^-1
    const R = Rt.clone().multiply(C).multiply(Rs.clone().invert());
    const q = new THREE.Quaternion().setFromRotationMatrix(R);
    let M = new THREE.Matrix4().compose(
      ft.c.clone().sub(fs.c.clone().applyQuaternion(q).multiplyScalar(s0)), q, new THREE.Vector3(s0, s0, s0));
    // ICP, symmetric correspondences, each onto the other measurement's
    // LEGS rather than its samples: snapping to the nearest sample pulls the
    // ends of a leg inwards and read a traced L 6% small; the nearest point
    // on the segment has no such bias
    for (let it = 0; it < 40; it++) {
      const inv = M.clone().invert();
      const movedLegs = legsOf(source, !!opts.sourceClosed).map(([a, b]) => [a.clone().applyMatrix4(M), b.clone().applyMatrix4(M)] as [THREE.Vector3, THREE.Vector3]);
      const src: THREE.Vector3[] = [], dst: THREE.Vector3[] = [];
      for (const p of S) { src.push(p); dst.push(onLegs(p.clone().applyMatrix4(M), targetLegs)); }
      for (const t of T) { src.push(onLegs(t, movedLegs).applyMatrix4(inv)); dst.push(t); }
      const r = alignPoints(src, dst, allowScale);
      if (!r) break;
      const change = r.matrix.elements.reduce((acc, v, k) => acc + Math.abs(v - M.elements[k]), 0);
      M = r.matrix;
      if (change < 1e-7) break;
    }
    fits.push({ matrix: M, err: chamfer(S.map((p) => p.clone().applyMatrix4(M)), T) });
  }
  const chosen = leastTurn(fits);
  if (!chosen) return null;
  const bestM = chosen.matrix, bestErr = chosen.err;
  const moved = S.map((p) => p.clone().applyMatrix4(bestM!));
  let max = 0;
  for (const p of moved) max = Math.max(max, p.distanceTo(nearest(p, T)));
  const scale = new THREE.Vector3().setFromMatrixScale(bestM).x;
  return { matrix: bestM, scale, rms: bestErr, max, method: 'shape' };
}

/** See stage 1b of `alignShapes`. Null when no hypothesis fits cleanly. */
function matchSubset(
  source: THREE.Vector3[], target: THREE.Vector3[], allowScale: boolean, size: number,
  sourceClosed: boolean, targetClosed: boolean,
): ShapeAlignResult | null {
  const flip = source.length > target.length;
  const small = flip ? target : source, large = flip ? source : target;
  const smallClosed = flip ? targetClosed : sourceClosed;
  // FOUR at least: with three, the triangle that seeds a hypothesis is also
  // all there is to verify it with, so ANY similar triangle in the larger
  // set passes — along a traced edge there are plenty, at the wrong scale
  if (small.length < 4 || large.length < 4 || large.length > 40) return null;
  // the most spread-out triangle of the small set: the steadiest hypothesis
  let tri: [number, number, number] | null = null, area = 0;
  for (let i = 0; i < small.length; i++) for (let j = i + 1; j < small.length; j++) for (let k = j + 1; k < small.length; k++) {
    const a = new THREE.Vector3().crossVectors(small[j].clone().sub(small[i]), small[k].clone().sub(small[i])).length();
    if (a > area) { area = a; tri = [i, j, k]; }
  }
  if (!tri || area < 1e-9) return null;
  const tol = 0.05 * size;
  const hyps: { matrix: THREE.Matrix4; pairs: number[]; err: number; cover: number }[] = [];
  const smallLegs = legsOf(small, smallClosed);
  const n = large.length;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
    if (a === b || b === c || a === c) continue;
    const h = alignPoints([small[tri[0]], small[tri[1]], small[tri[2]]], [large[a], large[b], large[c]], allowScale);
    if (!h || h.rms > tol) continue;
    // verify: every small point onto a DISTINCT large point, within tolerance
    const used = new Set<number>();
    const pairs: number[] = [];
    let sum = 0, ok = true;
    for (const p of small) {
      const q = p.clone().applyMatrix4(h.matrix);
      let bi = -1, bd = Infinity;
      large.forEach((l, li) => { const d = q.distanceTo(l); if (d < bd && !used.has(li)) { bd = d; bi = li; } });
      if (bi < 0 || bd > tol) { ok = false; break; }
      used.add(bi); pairs.push(bi); sum += bd * bd;
    }
    if (!ok) continue;
    // in the direction the object will actually move, so "turns least"
    // means the same thing whichever set was the smaller
    // COVERAGE: the larger set's points that were NOT paired should still
    // lie on the smaller shape. Four corners fit the square of a traced
    // outline's MIDPOINTS just as exactly as its corners — 45 degrees round
    // and √2 small — and only the unpaired points can tell the two apart
    let cover = 0;
    const movedSmall = smallLegs.map(([a2, b2]) => [a2.clone().applyMatrix4(h.matrix), b2.clone().applyMatrix4(h.matrix)] as [THREE.Vector3, THREE.Vector3]);
    large.forEach((l, li) => { if (!used.has(li)) cover += l.distanceToSquared(onLegs(l, movedSmall)); });
    hyps.push({ matrix: flip ? h.matrix.clone().invert() : h.matrix, pairs, err: Math.sqrt(sum / small.length), cover });
  }
  // the pairing first, then coverage, then the least turn
  const bestErr = Math.min(...hyps.map((h) => h.err));
  const good = hyps.filter((h) => h.err <= bestErr * 1.5 + tol * 0.02);
  const bestCover = Math.min(...good.map((h) => h.cover));
  const best = leastTurn(good.filter((h) => h.cover <= bestCover * 1.1 + tol * tol * 0.01), 1.5);
  if (!best) return null;
  // refine over every pair, then turn it round if we solved target -> source
  const fit = alignPoints(small, best.pairs.map((i) => large[i]), allowScale);
  if (!fit) return null;
  const matrix = flip ? fit.matrix.clone().invert() : fit.matrix;
  const scale = flip ? 1 / fit.scale : fit.scale;
  return { matrix, scale, rms: flip ? fit.rms / fit.scale : fit.rms, max: flip ? fit.max / fit.scale : fit.max, method: 'reordered' };
}

function legsOf(pts: THREE.Vector3[], closed: boolean): [THREE.Vector3, THREE.Vector3][] {
  const legs: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i + 1 < pts.length; i++) legs.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 2) legs.push([pts[pts.length - 1], pts[0]]);
  return legs;
}

/** The nearest point to `p` on any of the legs. */
function onLegs(p: THREE.Vector3, legs: [THREE.Vector3, THREE.Vector3][]): THREE.Vector3 {
  const line = new THREE.Line3(), tmp = new THREE.Vector3();
  let best = legs[0][0].clone(), bd = Infinity;
  for (const [a, b] of legs) {
    line.set(a, b).closestPointToPoint(p, true, tmp);
    const d = tmp.distanceToSquared(p);
    if (d < bd) { bd = d; best = tmp.clone(); }
  }
  return best;
}
