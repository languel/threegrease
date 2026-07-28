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
  /** Where a material's image sits in the shared atlas. Injected rather
   *  than imported so this stays a pure geometry builder. Returning null
   *  (no atlas yet, image still decoding) degrades to untextured. */
  atlasRect?: (imageId: number | null | undefined) => [number, number, number, number] | null;
}

const SHADE_CODE: Record<string, number> = {
  SOLID: 0, GRADIENT_LINEAR: 1, GRADIENT_RADIAL: 2, TEXTURE: 3,
};
const NO_RECT: [number, number, number, number] = [0, 0, 0, 0];

/** Per-stroke NPR shading, resolved once per material. A TEXTURE material
 *  whose image hasn't packed yet falls back to SOLID so it draws as a plain
 *  ribbon instead of vanishing. */
function shadeOf(mat: GPMaterial, opts: BuildOptions, isFill: boolean) {
  const styleName = isFill ? mat.fillStyle : (mat.strokeShade ?? 'SOLID');
  let code = SHADE_CODE[styleName] ?? 0;
  const imageId = isFill ? mat.fillImageId : mat.strokeImageId;
  let rect = code === 3 ? opts.atlasRect?.(imageId) ?? null : null;
  if (code === 3 && !rect) { code = 0; rect = null; }
  return {
    code,
    rect: rect ?? NO_RECT,
    uvFactor: (isFill ? mat.fillUvFactor : mat.strokeUvFactor) ?? 1,
    texBlend: (isFill ? mat.fillTexBlend : mat.strokeTexBlend) ?? 0,
    color2: (isFill ? mat.fillColor2 : mat.strokeColor2 ?? mat.strokeColor),
  };
}

/**
 * Per-point variation signal in 0..1, plus the taper envelope, collapsed
 * into one multiplier per point for radius and one for alpha.
 *
 * The point of this is that a stroke shouldn't be uniform: real media vary
 * along the mark. The signal chooses WHAT varies it, `varyRadius` /
 * `varyStrength` choose how much, and taper handles the lift-off at the
 * ends that a plain ribbon never has.
 */
function varyFactors(s: GPStroke, arcs: number[]): { radius: number[]; alpha: number[] } {
  const st = s.style;
  const n = s.points.length;
  const mode = st?.varyMode ?? 'NONE';
  const vr = st?.varyRadius ?? 0;
  const va = st?.varyStrength ?? 0;
  const tin = st?.taperIn ?? 0;
  const tout = st?.taperOut ?? 0;
  const radius = new Array<number>(n).fill(1);
  const alpha = new Array<number>(n).fill(1);
  if (mode === 'NONE' && vr === 0 && va === 0 && tin === 0 && tout === 0) return { radius, alpha };

  const freq = Math.max(0.5, st?.varyScale ?? 4);
  const noiseAt = (t: number): number => {
    // cheap value noise over the arc: lattice + smoothstep, seeded per stroke
    const x = t * freq;
    const i0 = Math.floor(x), f = x - i0;
    const h = (k: number) => {
      const v = Math.sin((k + 1) * 127.1 + s.id * 311.7) * 43758.5453;
      return v - Math.floor(v);
    };
    const u = f * f * (3 - 2 * f);
    return h(i0) * (1 - u) + h(i0 + 1) * u;
  };

  for (let i = 0; i < n; i++) {
    let sig = 1;
    if (mode === 'RANDOM') {
      sig = noiseAt(arcs[i]);
    } else if (mode === 'ARC') {
      sig = arcs[i];
    } else if (mode === 'DENSITY') {
      // strokes drawn before this existed have no baked density; treat as
      // fully dense so they render exactly as they used to
      sig = s.points[i].density ?? 1;
    } else if (mode === 'CURVATURE') {
      const a = s.points[Math.max(0, i - 1)].co;
      const b = s.points[i].co;
      const c = s.points[Math.min(n - 1, i + 1)].co;
      const v1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
      const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
      if (l1 < 1e-9 || l2 < 1e-9) sig = 0;
      else {
        const dot = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (l1 * l2);
        // Normalise against 30°, not 180°: adjacent points in a smoothed
        // stroke turn by a few degrees at most, so dividing by PI would
        // leave the signal near zero and the effect invisible.
        const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
        sig = Math.min(1, ang / (Math.PI / 6));
      }
    }
    // Positive amount THINS where the signal is weak (fast = thin pencil).
    // Negative amount GROWS where the signal is strong (ink pooling in a
    // corner, a calligraphic nib fattening through a turn) — the two read
    // as opposite intents, so one signed control covers both.
    radius[i] = vr >= 0 ? 1 - vr * (1 - sig) : 1 + -vr * sig;
    alpha[i] = va >= 0 ? 1 - va * (1 - sig) : 1 + -va * sig;

    const t = arcs[i];
    if (tin > 0) {
      const e = Math.min(1, t / tin);
      radius[i] *= e; alpha[i] *= 0.35 + 0.65 * e;
    }
    if (tout > 0) {
      const e = Math.min(1, (1 - t) / tout);
      radius[i] *= e; alpha[i] *= 0.35 + 0.65 * e;
    }
    // a stroke must never invert or vanish outright; taper still reaches
    // near-zero at the very tip, which is the point of it
    radius[i] = Math.max(0.02, radius[i]);
    alpha[i] = Math.max(0, Math.min(1.5, alpha[i]));
  }
  return { radius, alpha };
}

/** Sample a per-point factor at an arbitrary arc position. Stamps are laid
 *  down between points, not on them, so they have to interpolate the
 *  variation rather than index it. */
function varyAt(t: number, factors: number[], arcs: number[]): number {
  const n = factors.length;
  if (n === 0) return 1;
  if (t <= arcs[0]) return factors[0];
  for (let i = 1; i < n; i++) {
    if (t <= arcs[i]) {
      const span = arcs[i] - arcs[i - 1];
      const f = span < 1e-9 ? 0 : (t - arcs[i - 1]) / span;
      return factors[i - 1] + (factors[i] - factors[i - 1]) * f;
    }
  }
  return factors[n - 1];
}

/** Cumulative arc length per point, normalised 0..1 over the whole stroke —
 *  the coordinate a texture repeats along and a gradient ramps over. */
function arcLengths(s: GPStroke): number[] {
  const pts = s.points;
  const out = new Array<number>(pts.length).fill(0);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].co, b = pts[i].co;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out[i] = total;
  }
  if (total > 1e-9) for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
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
  const color2: number[] = [], shadeAttr: number[] = [], rectAttr: number[] = [], arcAttr: number[] = [];
  const index: number[] = [];
  let v = 0;

  // per-stroke shading, set once before that stroke emits: these are
  // constant across a stroke but must go out per-vertex, since the whole
  // layer shares one buffer and one material
  let shade = shadeOf(materials[0] ?? ({} as GPMaterial), opts, false);
  let arc = 0; // 0..1 along the stroke, set per emission point

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
    color2.push(shade.color2[0], shade.color2[1], shade.color2[2], shade.color2[3]);
    shadeAttr.push(shade.code, shade.uvFactor, shade.texBlend);
    rectAttr.push(shade.rect[0], shade.rect[1], shade.rect[2], shade.rect[3]);
    arcAttr.push(arc);
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
    shade = shadeOf(mat, opts, false);
    const arcs = arcLengths(s);
    const vary = varyFactors(s, arcs);
    const style = s.style;
    const isScene = style?.unit === 'SCENE';
    const u = isScene ? 1 : 0;
    const radiusOf = (p: GPStroke['points'][number], i: number) =>
      Math.max(isScene ? 1e-4 : 0.1,
        (s.lineWidth * p.pressure * vary.radius[i] + (isScene ? 0 : opts.thicknessOffset)) * 0.5);
    // alpha variation rides on top of the material/strength colour
    const colorAt = (p: GPStroke['points'][number], i: number): Vec4 => {
      const c = pointColor(mat, p.vertexColor, p.strength, opts, false);
      return vary.alpha[i] === 1 ? c : [c[0], c[1], c[2], c[3] * vary.alpha[i]];
    };

    if (style?.stamp) {
      buildStamps(s, mat, opts, u, quad, (a) => { arc = a; }, vary, arcs);
      continue;
    }

    const dotKind = mat.lineMode === 'DOTS' ? 1 : mat.lineMode === 'SQUARES' ? 2 : 1;
    // dots at every point: caps + round joins in LINE mode, the whole stroke in DOTS/SQUARES
    for (let i = 0; i < n; i++) {
      const p = s.points[i];
      const c = colorAt(p, i);
      if (c[3] <= 0.003) continue;
      arc = arcs[i];
      quad(p.co, [0, 0, 0], radiusOf(p, i), c, dotKind, s.hardness, u);
    }
    if (mat.lineMode !== 'LINE') continue;

    const segCount = s.cyclic ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const A = s.points[i], B = s.points[(i + 1) % n];
      const d: Vec3 = [B.co[0] - A.co[0], B.co[1] - A.co[1], B.co[2] - A.co[2]];
      const iB = (i + 1) % n;
      const cA = colorAt(A, i);
      const cB = colorAt(B, iB);
      if (cA[3] <= 0.003 && cB[3] <= 0.003) continue;
      const rA = radiusOf(A, i), rB = radiusOf(B, iB);
      // arc differs across the quad: the A edge and the B edge sit at
      // different points along the stroke, which is what lets a texture
      // travel down the ribbon instead of repeating per segment
      arc = arcs[i];
      const i0 = pushVert(A.co, d, -1, 0, rA, cA, 0, s.hardness, u);
      const i1 = pushVert(A.co, d, 1, 0, rA, cA, 0, s.hardness, u);
      // a cyclic stroke's closing segment wraps the index back to point 0;
      // its arc must read as the END of the stroke (1.0), not the start,
      // or the last segment ramps backwards through the whole gradient
      arc = i + 1 === n ? 1 : arcs[i + 1];
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
  geom.setAttribute('aColor2', new THREE.Float32BufferAttribute(color2, 4));
  geom.setAttribute('aShade', new THREE.Float32BufferAttribute(shadeAttr, 3));
  geom.setAttribute('aTexRect', new THREE.Float32BufferAttribute(rectAttr, 4));
  geom.setAttribute('aArc', new THREE.Float32BufferAttribute(arcAttr, 1));
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
  setArc: (a: number) => void,
  vary: { radius: number[]; alpha: number[] },
  arcs: number[],
): void {
  const style = s.style;
  const pts = s.points;
  const n = pts.length;
  const rnd = seededRandom(s.id * 7919 + 17);
  const emit = (
    co: Vec3, tangent: Vec3, pressure: number, strength: number, vcol: Vec4, idx: number, arc = 0,
  ) => {
    const c = pointColor(mat, vcol, strength, opts, false);
    const fade = varyAt(arc, vary.alpha, arcs);
    if (fade < 1) c[3] *= fade;
    if (c[3] <= 0.003) return;
    setArc(arc);
    const width = Math.max(1e-4, s.lineWidth * pressure * varyAt(arc, vary.radius, arcs));
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
      emit(p.co, t, p.pressure, p.strength, p.vertexColor, i, n > 1 ? i / (n - 1) : 0);
    }
    return;
  }

  // SCENE units: arc-length walk (arcs comes from the caller now)
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
      // interpolate the normalised arc between this segment's endpoints, so
      // a texture keeps travelling smoothly across segment boundaries
      const aA = arcs[i], aB = i + 1 === n ? 1 : arcs[i + 1];
      emit(co, d, pr, st, vc, stampIdx++, aA + (aB - aA) * t);
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
  const fillTex: number[] = [], rectAttr: number[] = [];
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
    // holdout punches a background-coloured hole and onion skins are
    // recoloured wholesale — neither should pick up gradients or textures
    const flat = mat.holdout || opts.colorOverride;
    const shade = shadeOf(mat, opts, true);
    const style = flat ? 0 : shade.code;

    const base = v;
    for (let i = 0; i < proj.length; i++) {
      pos.push(pts[i][0], pts[i][1], pts[i][2]);
      color.push(c1[0], c1[1], c1[2], c1[3]);
      color2.push(c2[0], c2[1], c2[2], c2[3]);
      grad.push(style, mat.gradientAngle, shade.texBlend);
      uv.push((proj[i].x - minX) / sx, (proj[i].y - minY) / sy);
      fillTex.push(shade.uvFactor, 0, 0);
      rectAttr.push(shade.rect[0], shade.rect[1], shade.rect[2], shade.rect[3]);
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
  geom.setAttribute('aFillTex', new THREE.Float32BufferAttribute(fillTex, 3));
  geom.setAttribute('aTexRect', new THREE.Float32BufferAttribute(rectAttr, 4));
  geom.setIndex(index);
  geom.computeBoundingSphere();
  return geom;
}
