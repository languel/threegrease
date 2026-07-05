import type { GPPoint, GPStroke, Vec3 } from './types';
import { clonePoint } from './gpdata';

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function v3lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
export function v3dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Moving-average smooth of point positions (Blender "smooth" post-process). */
export function smoothPoints(points: GPPoint[], factor: number, iterations = 1, cyclic = false): void {
  const n = points.length;
  if (n < 3) return;
  for (let it = 0; it < iterations; it++) {
    const src = points.map((p) => [...p.co] as Vec3);
    const lo = cyclic ? 0 : 1;
    const hi = cyclic ? n : n - 1;
    for (let i = lo; i < hi; i++) {
      const prev = src[(i - 1 + n) % n];
      const next = src[(i + 1) % n];
      const mid: Vec3 = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2, (prev[2] + next[2]) / 2];
      points[i].co = v3lerp(src[i], mid, factor);
    }
  }
}

export function smoothAttr(points: GPPoint[], attr: 'pressure' | 'strength', factor: number): void {
  const n = points.length;
  if (n < 3) return;
  const src = points.map((p) => p[attr]);
  for (let i = 1; i < n - 1; i++) {
    points[i][attr] = lerp(src[i], (src[i - 1] + src[i + 1]) / 2, factor);
  }
}

/** Ramer–Douglas–Peucker simplification. Returns kept indices. */
export function rdpIndices(pts: Vec3[], epsilon: number): number[] {
  const n = pts.length;
  if (n < 3) return pts.map((_, i) => i);
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, maxI = -1;
    const A = pts[a], B = pts[b];
    const ab: Vec3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const abLen2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      let d: number;
      if (abLen2 === 0) d = v3dist(P, A);
      else {
        const t = clamp(((P[0] - A[0]) * ab[0] + (P[1] - A[1]) * ab[1] + (P[2] - A[2]) * ab[2]) / abLen2, 0, 1);
        d = v3dist(P, [A[0] + ab[0] * t, A[1] + ab[1] * t, A[2] + ab[2] * t]);
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = true;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export function simplifyStroke(stroke: GPStroke, epsilon: number): void {
  const idx = rdpIndices(stroke.points.map((p) => p.co), epsilon);
  if (idx.length < stroke.points.length) stroke.points = idx.map((i) => stroke.points[i]);
}

/** Insert midpoints between every pair of points (Blender Subdivide). */
export function subdivideStroke(stroke: GPStroke, cuts = 1, selectedOnly = false): void {
  for (let c = 0; c < cuts; c++) {
    const out: GPPoint[] = [];
    const pts = stroke.points;
    const n = pts.length;
    const last = stroke.cyclic ? n : n - 1;
    for (let i = 0; i < n; i++) {
      out.push(pts[i]);
      if (i < last) {
        const a = pts[i], b = pts[(i + 1) % n];
        if (selectedOnly && !(a.select && b.select)) continue;
        const m = clonePoint(a);
        m.co = v3lerp(a.co, b.co, 0.5);
        m.pressure = (a.pressure + b.pressure) / 2;
        m.strength = (a.strength + b.strength) / 2;
        m.weight = (a.weight + b.weight) / 2;
        for (let k = 0; k < 4; k++) m.vertexColor[k] = (a.vertexColor[k] + b.vertexColor[k]) / 2;
        m.select = a.select && b.select;
        out.push(m);
      }
    }
    stroke.points = out;
  }
}

/** Resample a polyline to `count` evenly spaced points (for interpolation). */
export function resamplePoints(points: GPPoint[], count: number): GPPoint[] {
  const n = points.length;
  if (n === 0 || count <= 0) return [];
  if (n === 1) return Array.from({ length: count }, () => clonePoint(points[0]));
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + v3dist(points[i - 1].co, points[i].co));
  const total = cum[n - 1] || 1e-9;
  const out: GPPoint[] = [];
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * total;
    let i = 1;
    while (i < n - 1 && cum[i] < target) i++;
    const t = clamp((target - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]), 0, 1);
    const a = points[i - 1], b = points[i];
    const p = clonePoint(a);
    p.co = v3lerp(a.co, b.co, t);
    p.pressure = lerp(a.pressure, b.pressure, t);
    p.strength = lerp(a.strength, b.strength, t);
    p.weight = lerp(a.weight, b.weight, t);
    for (let c = 0; c < 4; c++) p.vertexColor[c] = lerp(a.vertexColor[c], b.vertexColor[c], t);
    out.push(p);
  }
  return out;
}

export function strokeLength(points: GPPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += v3dist(points[i - 1].co, points[i].co);
  return len;
}

/** Newell normal of a polygon. */
export function polygonNormal(pts: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Smoothstep falloff used by proportional editing & sculpt brushes. */
export function falloff(dist: number, radius: number): number {
  if (dist >= radius) return 0;
  const t = 1 - dist / radius;
  return t * t * (3 - 2 * t);
}

let seedState = 12345;
export function seededRandom(seed?: number): () => number {
  let s = (seed ?? seedState++) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
