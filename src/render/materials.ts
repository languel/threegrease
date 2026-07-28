import * as THREE from 'three';
import type { BlendMode } from '../core/types';
import { gpAtlas } from './atlas';

// Screen-space stroke ribbons with per-point radius/color/opacity.
// Vertex kinds: 0 = miter-joined strip vertex, 1 = round dot (DOTS mode),
// 2 = square dot, 3 = NPR stamp (rotated/squashed quad with grain),
// 4 = half-disc end cap (the outward half only — a full disc would overlap
//     the ribbon and re-create the bead artefact the strip exists to avoid).
// aUnit: 0 = radius in px (VIEW), 1 = radius in world units (SCENE).
// aStamp: (rotation offset, aspect, grain amount, grain scale).
const strokeVert = /* glsl */ `
attribute vec3 aDir;
attribute vec3 aDirPrev;   // back to the previous point, for the miter join
// ATTRIBUTE BUDGET: WebGL guarantees only 16 vertex attributes and this
// shader is the whole per-stroke parameter channel (a layer's strokes share
// one merged buffer and one material, so there is nowhere else to put
// anything). Scalars are therefore PACKED, not given an attribute each —
// adding a 16th slot silently fails to link with "Too many attributes".
attribute vec3 aCorner;  // xy = quad corner, z = 0..1 along the arc
attribute float aRadius;
attribute vec4 aColor;
attribute vec4 aMisc;    // x kind, y hardness, z unit (0 px / 1 world), w seed
attribute vec4 aStamp;
// NPR shading, per-vertex because a layer's strokes share ONE material and
// one merged buffer — there is nowhere else to put per-stroke parameters.
attribute vec4 aColor2;
attribute vec3 aShade;   // x: mode (0 solid, 1 gradient-along, 2 gradient-across, 3 texture)
                         // y: uv factor (texture repeats along the stroke)
                         // z: texture/colour blend
attribute vec4 aTexRect; // this material's sub-rect of the atlas (x, y, w, h)
uniform vec2 uResolution;
varying vec4 vColor;
varying vec2 vUv;
varying float vKind;
varying float vHardness;
varying vec2 vGrain;
varying float vSeed;
varying vec4 vColor2;
varying vec3 vShade;
varying vec4 vTexRect;
varying float vArc;

void main() {
  vColor = aColor;
  vKind = aMisc.x;
  vHardness = aMisc.y;
  vGrain = aStamp.zw;
  vSeed = aMisc.w;
  vColor2 = aColor2;
  vShade = aShade;
  vTexRect = aTexRect;
  vArc = aCorner.z;
  vec4 clipA = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  float aspect = uResolution.x / uResolution.y;

  if (aMisc.x < 0.5) {
    // Strip vertex: ONE vertex pair per point, offset along the MITER of the
    // two adjoining segments. Mitring here (rather than emitting per-segment
    // quads on the CPU) is what keeps the ribbon free of overlap: the width
    // is applied in screen space, so only the projected tangents give the
    // correct offset direction, and those aren't known until now.
    vec4 clip = clipA;
    vec2 ndcC = clipA.xy / clipA.w;

    vec2 tPrev = vec2(0.0);
    if (dot(aDirPrev, aDirPrev) > 1e-12) {
      vec4 clipP = projectionMatrix * modelViewMatrix * vec4(position - aDirPrev, 1.0);
      tPrev = ndcC - clipP.xy / clipP.w;
      tPrev.x *= aspect;
    }
    vec2 tNext = vec2(0.0);
    if (dot(aDir, aDir) > 1e-12) {
      vec4 clipB = projectionMatrix * modelViewMatrix * vec4(position + aDir, 1.0);
      tNext = clipB.xy / clipB.w - ndcC;
      tNext.x *= aspect;
    }
    // at the two ends only one side exists — reuse it so the cap sits square
    if (length(tPrev) < 1e-6) tPrev = tNext;
    if (length(tNext) < 1e-6) tNext = tPrev;
    if (length(tPrev) < 1e-6) { tPrev = vec2(1.0, 0.0); tNext = tPrev; }
    tPrev = normalize(tPrev);
    tNext = normalize(tNext);

    vec2 nPrev = vec2(-tPrev.y, tPrev.x);
    vec2 nNext = vec2(-tNext.y, tNext.x);
    vec2 m = nPrev + nNext;
    // Near-reversal (a hairpin, or the jitter that noisy input produces at
    // almost every point) leaves the miter direction ill-defined — the sum
    // of the two normals cancels. Fall back to this segment's own normal
    // instead of normalizing something that is essentially zero.
    if (dot(tPrev, tNext) < -0.99 || length(m) < 1e-3) m = nNext;
    m = normalize(m);
    // Lengthen the offset so the join's OUTER edge stays on the ribbon
    // boundary — but CLAMP HARD. Unbounded, a sharp turn throws the vertex
    // a long way from the stroke and draws a bright star; the old 4x limit
    // was still 4 stroke-widths of spike, which is exactly what those
    // stars were. 1.5 keeps the join continuous with no visible point.
    float miter = min(1.0 / max(dot(m, nNext), 1e-3), 1.5);
    vec2 normal = m * miter;
    normal.x /= aspect;
    // px offset scales with 1/resolution and w; world offset with proj[1][1]
    float amt = aMisc.z < 0.5
      ? (aRadius / uResolution.y) * 2.0 * clip.w
      : aRadius * projectionMatrix[1][1];
    clip.xy += normal * amt * aCorner.x;
    vUv = vec2(aCorner.x, 0.0);
    gl_Position = clip;
  } else {
    vec4 clip = clipA;
    vec2 corner = aCorner.xy;
    if (aMisc.x > 2.5) {
      // stamp AND cap: squash then rotate by (screen-space path direction + offset)
      corner = vec2(corner.x, corner.y * aStamp.y);
      float pathAngle = 0.0;
      if (dot(aDir, aDir) > 1e-12) {
        vec4 clipB = projectionMatrix * modelViewMatrix * vec4(position + aDir, 1.0);
        vec2 d2 = clipB.xy / clipB.w - clipA.xy / clipA.w;
        d2.x *= aspect;
        if (length(d2) > 1e-6) pathAngle = atan(d2.y, d2.x);
      }
      float rot = pathAngle + aStamp.x;
      float c = cos(rot), s = sin(rot);
      corner = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    }
    float amt = aMisc.z < 0.5
      ? (aRadius / uResolution.y) * 2.0 * clip.w
      : aRadius * projectionMatrix[1][1];
    vec2 off = corner * amt;
    off.x *= uResolution.y / uResolution.x;
    clip.xy += off;
    vUv = aCorner.xy;
    gl_Position = clip;
  }
}
`;

const strokeFrag = /* glsl */ `
precision highp float;
varying vec4 vColor;
varying vec2 vUv;
varying float vKind;
varying float vHardness;
varying vec2 vGrain;
varying float vSeed;
varying vec4 vColor2;
varying vec3 vShade;
varying vec4 vTexRect;
varying float vArc;
uniform sampler2D uAtlas;
uniform float uHasAtlas;

float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
    mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  float alpha = vColor.a;
  float soft = max(1.0 - vHardness, 0.001);
  if (vKind < 0.5) {
    alpha *= smoothstep(1.0, 1.0 - soft, abs(vUv.x));
  } else if (vKind < 1.5) {
    float d = length(vUv);
    if (d > 1.0) discard;
    alpha *= smoothstep(1.0, 1.0 - soft, d);
  } else if (vKind > 3.5) {
    // end cap: keep only the OUTWARD half disc. The vertex stage rotated the
    // quad so local +x points away from the stroke, and vUv is that
    // pre-rotation space, so x < 0 is the half the ribbon already covers —
    // drawing it would double-composite and put the bead back.
    if (vUv.x < 0.0) discard;
    float d = length(vUv);
    if (d > 1.0) discard;
    alpha *= smoothstep(1.0, 1.0 - soft, d);
  } else if (vKind > 2.5) {
    float d = length(vUv);
    if (d > 1.0) discard;
    alpha *= smoothstep(1.0, 1.0 - soft, d);
    // procedural grain, rotates with the stamp (vUv is pre-rotation space)
    float n = vnoise(vUv * vGrain.y + vec2(vSeed * 13.7, vSeed * 7.3));
    alpha *= mix(1.0, smoothstep(0.15, 0.85, n), vGrain.x);
  }
  // ---- NPR shading -------------------------------------------------
  // vUv.x is the across-the-ribbon coordinate (-1..1 on a segment, the
  // corner on a dot/stamp); vArc runs 0..1 along the stroke.
  vec3 rgb = vColor.rgb;
  float mode = vShade.x;
  if (mode > 0.5 && mode < 1.5) {
    rgb = mix(vColor.rgb, vColor2.rgb, clamp(vArc, 0.0, 1.0));
    alpha *= mix(vColor.a, vColor2.a, clamp(vArc, 0.0, 1.0)) / max(vColor.a, 1e-4);
  } else if (mode > 1.5 && mode < 2.5) {
    // across the width: the core reads as pressed-hard, the edge as dry
    float t = clamp(abs(vUv.x), 0.0, 1.0);
    rgb = mix(vColor.rgb, vColor2.rgb, t);
    alpha *= mix(vColor.a, vColor2.a, t) / max(vColor.a, 1e-4);
  } else if (mode > 2.5 && uHasAtlas > 0.5) {
    // tile inside this material's atlas rect: fract() keeps a repeating
    // texture from bleeding into a neighbour's cell
    vec2 uv = vec2(vArc * max(vShade.y, 0.0001), vUv.x * 0.5 + 0.5);
    vec2 auv = vTexRect.xy + fract(uv) * vTexRect.zw;
    vec4 tex = texture2D(uAtlas, auv);
    rgb = mix(tex.rgb, vColor.rgb, clamp(vShade.z, 0.0, 1.0));
    alpha *= tex.a;  // the texture's alpha always carves the stroke — that
                     // is what gives a dry pencil its broken tooth
  }
  if (alpha <= 0.003) discard;
  gl_FragColor = vec4(rgb, alpha);
}
`;

const fillVert = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aColor2;
attribute vec3 aGrad; // x: style (0 solid, 1 linear, 2 radial, 3 texture)
                      // y: angle, z: texture/colour blend
attribute vec2 aUv;
attribute vec3 aFillTex; // x,y unused padding kept for alignment; see aTexRect
attribute vec4 aTexRect; // this material's sub-rect of the atlas
varying vec4 vColor;
varying vec4 vColor2;
varying vec3 vGrad;
varying vec2 vFillUv;
varying vec4 vTexRect;
varying float vUvFactor;
void main() {
  vColor = aColor;
  vColor2 = aColor2;
  vGrad = aGrad;
  vFillUv = aUv;
  vTexRect = aTexRect;
  vUvFactor = aFillTex.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fillFrag = /* glsl */ `
precision highp float;
varying vec4 vColor;
varying vec4 vColor2;
varying vec3 vGrad;
varying vec2 vFillUv;
varying vec4 vTexRect;
varying float vUvFactor;
uniform sampler2D uAtlas;
uniform float uHasAtlas;
void main() {
  vec4 col = vColor;
  if (vGrad.x > 0.5 && vGrad.x < 1.5) {
    vec2 dir = vec2(cos(vGrad.y), sin(vGrad.y));
    float t = clamp(dot(vFillUv - 0.5, dir) + 0.5, 0.0, 1.0);
    col = mix(vColor, vColor2, t);
  } else if (vGrad.x > 1.5 && vGrad.x < 2.5) {
    float t = clamp(length(vFillUv - 0.5) * 2.0, 0.0, 1.0);
    col = mix(vColor, vColor2, t);
  } else if (vGrad.x > 2.5 && uHasAtlas > 0.5) {
    // same atlas as strokes; aUv is the fill's bbox-normalised coordinate
    vec2 uv = vFillUv * max(vUvFactor, 0.0001);
    vec4 tex = texture2D(uAtlas, vTexRect.xy + fract(uv) * vTexRect.zw);
    col.rgb = mix(tex.rgb, vColor.rgb, clamp(vGrad.z, 0.0, 1.0));
    col.a *= tex.a;
  }
  if (col.a <= 0.003) discard;
  gl_FragColor = col;
}
`;

/** Bind the shared brush-texture atlas. Safe to call with no atlas yet —
 *  uHasAtlas gates the sampler so a TEXTURE material simply draws solid
 *  until its image finishes packing. Materials are rebuilt whenever the
 *  atlas repacks (TextureAtlas.setOnReady -> markDirty), so reading the
 *  singleton at construction is enough to stay current. */
function bindAtlas(mat: THREE.ShaderMaterial): void {
  mat.uniforms.uAtlas.value = gpAtlas.texture;
  mat.uniforms.uHasAtlas.value = gpAtlas.texture ? 1 : 0;
}

export function applyBlendMode(mat: THREE.Material, mode: BlendMode): void {
  mat.transparent = true;
  mat.depthWrite = false;
  if (mode === 'ADD') {
    mat.blending = THREE.AdditiveBlending;
  } else if (mode === 'MULTIPLY') {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  } else {
    mat.blending = THREE.NormalBlending;
  }
}

export function makeStrokeMaterial(resolution: THREE.Vector2, blend: BlendMode): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: strokeVert,
    fragmentShader: strokeFrag,
    uniforms: {
      uResolution: { value: resolution },
      uAtlas: { value: null }, uHasAtlas: { value: 0 },
    },
    side: THREE.DoubleSide,
  });
  bindAtlas(mat);
  applyBlendMode(mat, blend);
  return mat;
}

export function makeFillMaterial(blend: BlendMode): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: fillVert,
    fragmentShader: fillFrag,
    uniforms: { uAtlas: { value: null }, uHasAtlas: { value: 0 } },
    side: THREE.DoubleSide,
  });
  bindAtlas(mat);
  applyBlendMode(mat, blend);
  return mat;
}
