import * as THREE from 'three';
import type { GPMaterial, GPStroke, Vec3, Vec4 } from '../core/types';
import { polygonNormal, seededRandom } from '../core/mathutil';

export interface BuildOptions {
  layerOpacity: number;
  tint: Vec4;              // rgb + factor
  thicknessOffset: number;
  /** onion-skin style override: replace color, scale opacity */
  colorOverride?: { color: Vec3; opacity: number };
  background: Vec3;        // for holdout materials
}

function pointColor(
  mat: GPMaterial, vcol: Vec4, strength: number, opts: BuildOptions, isFill: boolean,
): Vec4 {
  let r: number, g: number, b: number, a: number;
  const base = isFill ? mat.fillColor : mat.strokeColor;
  if (mat.holdout) {
    return [opts.background[0], opts.background[1], opts.background[2], base[3] * strength * opts.layerOpacity];
  }
  const mix = vcol[3];
  r = base[0] * (1 - mix) + vcol[0] * mix;
  g = base[1] * (1 - mix) + vcol[1] * mix;
  b = base[2] * (1 - mix) + vcol[2] * mix;
  a = base[3] * strength;
  const tf = opts.tint[3];
  if (tf > 0) {
    r = r * (1 - tf) + opts.tint[0] * tf;
    g = g * (1 - tf) + opts.tint[1] * tf;
    b = b * (1 - tf) + opts.tint[2] * tf;
  }
  if (opts.colorOverride) {
    const c = opts.colorOverride.color;
    r = c[0]; g = c[1]; b = c[2];
    a *= opts.colorOverride.opacity;
  }
  return [r, g, b, a * opts.layerOpacity];
}

/** Builds the screen-space ribbon geometry for a list of evaluated strokes. */
export function buildStrokeGeometry(
  strokes: GPStroke[], materials: GPMaterial[], opts: BuildOptions,
): THREE.BufferGeometry | null {
  const pos: number[] = [], dir: number[] = [], corner: number[] = [];
  const radius: number[] = [], color: number[] = [], kind: number[] = [], hard: number[] = [];
  const unit: number[] = [], stampAttr: number[] = [], seedAttr: number[] = [];
  const index: number[] = [];
  let v = 0;

  const pushVert = (
    p: Vec3, d: Vec3, cx: number, cy: number, r: number, c: Vec4, k: number, h: number,
    u = 0, rot = 0, aspect = 1, grain = 0, grainScale = 6, seed = 0,
  ) => {
    pos.push(p[0], p[1], p[2]);
    dir.push(d[0], d[1], d[2]);
    corner.push(cx, cy);
    radius.push(r);
    color.push(c[0], c[1], c[2], c[3]);
    kind.push(k);
    hard.push(h);
    unit.push(u);
    stampAttr.push(rot, aspect, grain, grainScale);
    seedAttr.push(seed);
    return v++;
  };

  const quad = (
    p: Vec3, d: Vec3, r: number, c: Vec4, k: number, h: number,
    u = 0, rot = 0, aspect = 1, grain = 0, grainScale = 6, seed = 0,
  ) => {
    const a = pushVert(p, d, -1, -1, r, c, k, h, u, rot, aspect, grain, grainScale, seed);
    const b = pushVert(p, d, 1, -1, r, c, k, h, u, rot, aspect, grain, grainScale, seed);
    const cc = pushVert(p, d, 1, 1, r, c, k, h, u, rot, aspect, grain, grainScale, seed);
    const dd = pushVert(p, d, -1, 1, r, c, k, h, u, rot, aspect, grain, grainScale, seed);
    index.push(a, b, cc, a, cc, dd);
  };

  for (const s of strokes) {
    const mat = materials[s.materialIndex] ?? materials[0];
    if (!mat || !mat.showStroke) continue;
    const n = s.points.length;
    if (n === 0) continue;
    const style = s.style;
    const isScene = style?.unit === 'SCENE';
    const u = isScene ? 1 : 0;
    const radiusOf = (p: GPStroke['points'][number]) =>
      Math.max(isScene ? 1e-4 : 0.1,
        (s.lineWidth * p.pressure + (isScene ? 0 : opts.thicknessOffset)) * 0.5);

    if (style?.stamp) {
      buildStamps(s, mat, opts, u, quad);
      continue;
    }

    const dotKind = mat.lineMode === 'DOTS' ? 1 : mat.lineMode === 'SQUARES' ? 2 : 1;
    // dots at every point: caps + round joins in LINE mode, the whole stroke in DOTS/SQUARES
    for (let i = 0; i < n; i++) {
      const p = s.points[i];
      const c = pointColor(mat, p.vertexColor, p.strength, opts, false);
      if (c[3] <= 0.003) continue;
      quad(p.co, [0, 0, 0], radiusOf(p), c, dotKind, s.hardness, u);
    }
    if (mat.lineMode !== 'LINE') continue;

    const segCount = s.cyclic ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const A = s.points[i], B = s.points[(i + 1) % n];
      const d: Vec3 = [B.co[0] - A.co[0], B.co[1] - A.co[1], B.co[2] - A.co[2]];
      const cA = pointColor(mat, A.vertexColor, A.strength, opts, false);
      const cB = pointColor(mat, B.vertexColor, B.strength, opts, false);
      if (cA[3] <= 0.003 && cB[3] <= 0.003) continue;
      const rA = radiusOf(A), rB = radiusOf(B);
      const i0 = pushVert(A.co, d, -1, 0, rA, cA, 0, s.hardness, u);
      const i1 = pushVert(A.co, d, 1, 0, rA, cA, 0, s.hardness, u);
      const i2 = pushVert(A.co, d, 1, 1, rB, cB, 0, s.hardness, u);
      const i3 = pushVert(A.co, d, -1, 1, rB, cB, 0, s.hardness, u);
      index.push(i0, i1, i2, i0, i2, i3);
    }
  }

  if (index.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 3));
  geom.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  geom.setAttribute('aRadius', new THREE.Float32BufferAttribute(radius, 1));
  geom.setAttribute('aColor', new THREE.Float32BufferAttribute(color, 4));
  geom.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  geom.setAttribute('aHardness', new THREE.Float32BufferAttribute(hard, 1));
  geom.setAttribute('aUnit', new THREE.Float32BufferAttribute(unit, 1));
  geom.setAttribute('aStamp', new THREE.Float32BufferAttribute(stampAttr, 4));
  geom.setAttribute('aSeed', new THREE.Float32BufferAttribute(seedAttr, 1));
  geom.setIndex(index);
  geom.computeBoundingSphere();
  return geom;
}

/**
 * NPR stamp emission: walk the stroke's arc length placing rotated,
 * squashed, jittered stamps every `spacing * width`. All randomness is
 * seeded by stroke id + stamp index — geometry must be deterministic.
 * SCENE-unit strokes space in world units; VIEW-unit stamp strokes fall
 * back to one stamp per point (screen spacing is camera-dependent).
 */
function buildStamps(
  s: GPStroke, mat: GPMaterial, opts: BuildOptions, u: number,
  quad: (p: Vec3, d: Vec3, r: number, c: Vec4, k: number, h: number,
    u?: number, rot?: number, aspect?: number, grain?: number, grainScale?: number, seed?: number) => void,
): void {
  const style = s.style;
  const pts = s.points;
  const n = pts.length;
  const rnd = seededRandom(s.id * 7919 + 17);
  const emit = (co: Vec3, tangent: Vec3, pressure: number, strength: number, vcol: Vec4, idx: number) => {
    const c = pointColor(mat, vcol, strength, opts, false);
    if (c[3] <= 0.003) return;
    const width = Math.max(1e-4, s.lineWidth * pressure);
    const r = width * 0.5;
    const jr = (rnd() - 0.5) * style.jitter * Math.PI;
    // positional jitter perpendicular-ish to the path, in world units (SCENE)
    const j = style.jitter * r * (u === 1 ? 1 : 0.02);
    const jco: Vec3 = [
      co[0] + (rnd() - 0.5) * j, co[1] + (rnd() - 0.5) * j, co[2] + (rnd() - 0.5) * j,
    ];
    quad(jco, tangent, r, c, 3, s.hardness, u,
      style.angle + jr, style.aspect, style.grain, style.grainScale, (idx % 97) + rnd());
  };

  if (n === 1 || u === 0) {
    // single point, or VIEW-unit fallback: stamp per point
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
      const t: Vec3 = [next.co[0] - prev.co[0], next.co[1] - prev.co[1], next.co[2] - prev.co[2]];
      emit(p.co, t, p.pressure, p.strength, p.vertexColor, i);
    }
    return;
  }

  // SCENE units: arc-length walk
  const step = Math.max(1e-4, style.spacing * s.lineWidth);
  let carried = 0;
  let stampIdx = 0;
  const segCount = s.cyclic ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const A = pts[i], B = pts[(i + 1) % n];
    const d: Vec3 = [B.co[0] - A.co[0], B.co[1] - A.co[1], B.co[2] - A.co[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-9) continue;
    let t = carried > 0 ? (step - carried) / len : 0;
    if (i === 0 && carried === 0) t = 0; // stamp at the very start
    while (t <= 1) {
      const co: Vec3 = [A.co[0] + d[0] * t, A.co[1] + d[1] * t, A.co[2] + d[2] * t];
      const pr = A.pressure + (B.pressure - A.pressure) * t;
      const st = A.strength + (B.strength - A.strength) * t;
      const vc: Vec4 = [0, 1, 2, 3].map((k) =>
        A.vertexColor[k] + (B.vertexColor[k] - A.vertexColor[k]) * t) as Vec4;
      emit(co, d, pr, st, vc, stampIdx++);
      t += step / len;
    }
    carried = (1 - (t - step / len)) * len; // distance left after last stamp
  }
}

/** Triangulated fills with baked gradient attributes. */
export function buildFillGeometry(
  strokes: GPStroke[], materials: GPMaterial[], opts: BuildOptions,
): THREE.BufferGeometry | null {
  const pos: number[] = [], color: number[] = [], color2: number[] = [];
  const grad: number[] = [], uv: number[] = [];
  const index: number[] = [];
  let v = 0;

  for (const s of strokes) {
    const mat = materials[s.materialIndex] ?? materials[0];
    if (!mat || !mat.showFill || s.points.length < 3) continue;
    const pts = s.points.map((p) => p.co);
    const normal = polygonNormal(pts);
    // build a 2D basis on the polygon plane
    const nvec = new THREE.Vector3(...normal);
    const tmp = Math.abs(normal[2]) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(tmp, nvec).normalize();
    const w = new THREE.Vector3().crossVectors(nvec, u);
    const proj = pts.map((p) => new THREE.Vector2(
      p[0] * u.x + p[1] * u.y + p[2] * u.z,
      p[0] * w.x + p[1] * w.y + p[2] * w.z,
    ));
    let tris: number[][];
    // triangulateShape pops a duplicated end point from `proj` (mutates it),
    // so all loops below must use proj.length, not pts.length
    try { tris = THREE.ShapeUtils.triangulateShape(proj, []); }
    catch { continue; }
    if (!tris.length) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of proj) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const sx = Math.max(1e-9, maxX - minX), sy = Math.max(1e-9, maxY - minY);

    const strengthAvg = s.points.reduce((a, p) => a + p.strength, 0) / s.points.length;
    const c1 = pointColor(mat, s.fillVertexColor, strengthAvg, opts, true);
    const c2raw = mat.fillColor2;
    const c2: Vec4 = opts.colorOverride
      ? c1
      : [c2raw[0], c2raw[1], c2raw[2], c2raw[3] * opts.layerOpacity * strengthAvg];
    if (c1[3] <= 0.003 && c2[3] <= 0.003) continue;
    const style = mat.holdout || opts.colorOverride ? 0
      : mat.fillStyle === 'GRADIENT_LINEAR' ? 1 : mat.fillStyle === 'GRADIENT_RADIAL' ? 2 : 0;

    const base = v;
    for (let i = 0; i < proj.length; i++) {
      pos.push(pts[i][0], pts[i][1], pts[i][2]);
      color.push(c1[0], c1[1], c1[2], c1[3]);
      color2.push(c2[0], c2[1], c2[2], c2[3]);
      grad.push(style, mat.gradientAngle, 0);
      uv.push((proj[i].x - minX) / sx, (proj[i].y - minY) / sy);
      v++;
    }
    for (const t of tris) index.push(base + t[0], base + t[1], base + t[2]);
  }

  if (index.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('aColor', new THREE.Float32BufferAttribute(color, 4));
  geom.setAttribute('aColor2', new THREE.Float32BufferAttribute(color2, 4));
  geom.setAttribute('aGrad', new THREE.Float32BufferAttribute(grad, 3));
  geom.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setIndex(index);
  geom.computeBoundingSphere();
  return geom;
}
