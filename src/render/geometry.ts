import * as THREE from 'three';
import type { GPMaterial, GPStroke, Vec3, Vec4 } from '../core/types';
import { polygonNormal } from '../core/mathutil';

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
  const index: number[] = [];
  let v = 0;

  const pushVert = (
    p: Vec3, d: Vec3, cx: number, cy: number, r: number, c: Vec4, k: number, h: number,
  ) => {
    pos.push(p[0], p[1], p[2]);
    dir.push(d[0], d[1], d[2]);
    corner.push(cx, cy);
    radius.push(r);
    color.push(c[0], c[1], c[2], c[3]);
    kind.push(k);
    hard.push(h);
    return v++;
  };

  for (const s of strokes) {
    const mat = materials[s.materialIndex] ?? materials[0];
    if (!mat || !mat.showStroke) continue;
    const n = s.points.length;
    if (n === 0) continue;
    const dotKind = mat.lineMode === 'DOTS' ? 1 : mat.lineMode === 'SQUARES' ? 2 : 1;
    const radiusOf = (p: GPStroke['points'][number]) =>
      Math.max(0.1, (s.lineWidth * p.pressure + opts.thicknessOffset) * 0.5);

    // dots at every point: caps + round joins in LINE mode, the whole stroke in DOTS/SQUARES
    for (let i = 0; i < n; i++) {
      const p = s.points[i];
      const c = pointColor(mat, p.vertexColor, p.strength, opts, false);
      if (c[3] <= 0.003) continue;
      const r = radiusOf(p);
      const a = pushVert(p.co, [0, 0, 0], -1, -1, r, c, dotKind, s.hardness);
      const b = pushVert(p.co, [0, 0, 0], 1, -1, r, c, dotKind, s.hardness);
      const cc = pushVert(p.co, [0, 0, 0], 1, 1, r, c, dotKind, s.hardness);
      const d = pushVert(p.co, [0, 0, 0], -1, 1, r, c, dotKind, s.hardness);
      index.push(a, b, cc, a, cc, d);
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
      const i0 = pushVert(A.co, d, -1, 0, rA, cA, 0, s.hardness);
      const i1 = pushVert(A.co, d, 1, 0, rA, cA, 0, s.hardness);
      const i2 = pushVert(A.co, d, 1, 1, rB, cB, 0, s.hardness);
      const i3 = pushVert(A.co, d, -1, 1, rB, cB, 0, s.hardness);
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
  geom.setIndex(index);
  geom.computeBoundingSphere();
  return geom;
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
