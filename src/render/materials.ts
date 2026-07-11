import * as THREE from 'three';
import type { BlendMode } from '../core/types';

// Screen-space stroke ribbons with per-point radius/color/opacity.
// Vertex kinds: 0 = segment quad corner, 1 = round dot (cap/join/dot-mode),
// 2 = square dot, 3 = NPR stamp (rotated/squashed quad with grain).
// aUnit: 0 = radius in px (VIEW), 1 = radius in world units (SCENE).
// aStamp: (rotation offset, aspect, grain amount, grain scale).
const strokeVert = /* glsl */ `
attribute vec3 aDir;
attribute vec2 aCorner;
attribute float aRadius;
attribute vec4 aColor;
attribute float aKind;
attribute float aHardness;
attribute float aUnit;
attribute vec4 aStamp;
attribute float aSeed;
uniform vec2 uResolution;
varying vec4 vColor;
varying vec2 vUv;
varying float vKind;
varying float vHardness;
varying vec2 vGrain;
varying float vSeed;

void main() {
  vColor = aColor;
  vKind = aKind;
  vHardness = aHardness;
  vGrain = aStamp.zw;
  vSeed = aSeed;
  vec4 clipA = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  float aspect = uResolution.x / uResolution.y;

  if (aKind < 0.5) {
    // segment: aCorner.x = side (-1/1), aCorner.y = end (0 = A, 1 = B)
    vec4 clipB = projectionMatrix * modelViewMatrix * vec4(position + aDir, 1.0);
    vec4 clip = mix(clipA, clipB, aCorner.y);
    vec2 ndcA = clipA.xy / clipA.w;
    vec2 ndcB = clipB.xy / clipB.w;
    vec2 dir = ndcB - ndcA;
    dir.x *= aspect;
    if (length(dir) < 1e-6) dir = vec2(1.0, 0.0);
    dir = normalize(dir);
    vec2 normal = vec2(-dir.y, dir.x);
    normal.x /= aspect;
    // px offset scales with 1/resolution and w; world offset with proj[1][1]
    float amt = aUnit < 0.5
      ? (aRadius / uResolution.y) * 2.0 * clip.w
      : aRadius * projectionMatrix[1][1];
    clip.xy += normal * amt * aCorner.x;
    vUv = vec2(aCorner.x, 0.0);
    gl_Position = clip;
  } else {
    vec4 clip = clipA;
    vec2 corner = aCorner;
    if (aKind > 2.5) {
      // stamp: squash then rotate by (screen-space path direction + offset)
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
    float amt = aUnit < 0.5
      ? (aRadius / uResolution.y) * 2.0 * clip.w
      : aRadius * projectionMatrix[1][1];
    vec2 off = corner * amt;
    off.x *= uResolution.y / uResolution.x;
    clip.xy += off;
    vUv = aCorner;
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
  } else if (vKind > 2.5) {
    float d = length(vUv);
    if (d > 1.0) discard;
    alpha *= smoothstep(1.0, 1.0 - soft, d);
    // procedural grain, rotates with the stamp (vUv is pre-rotation space)
    float n = vnoise(vUv * vGrain.y + vec2(vSeed * 13.7, vSeed * 7.3));
    alpha *= mix(1.0, smoothstep(0.15, 0.85, n), vGrain.x);
  }
  if (alpha <= 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
}
`;

const fillVert = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aColor2;
attribute vec3 aGrad; // x: style (0 solid, 1 linear, 2 radial), y: angle
attribute vec2 aUv;
varying vec4 vColor;
varying vec4 vColor2;
varying vec3 vGrad;
varying vec2 vFillUv;
void main() {
  vColor = aColor;
  vColor2 = aColor2;
  vGrad = aGrad;
  vFillUv = aUv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fillFrag = /* glsl */ `
precision highp float;
varying vec4 vColor;
varying vec4 vColor2;
varying vec3 vGrad;
varying vec2 vFillUv;
void main() {
  vec4 col = vColor;
  if (vGrad.x > 0.5 && vGrad.x < 1.5) {
    vec2 dir = vec2(cos(vGrad.y), sin(vGrad.y));
    float t = clamp(dot(vFillUv - 0.5, dir) + 0.5, 0.0, 1.0);
    col = mix(vColor, vColor2, t);
  } else if (vGrad.x > 1.5) {
    float t = clamp(length(vFillUv - 0.5) * 2.0, 0.0, 1.0);
    col = mix(vColor, vColor2, t);
  }
  if (col.a <= 0.003) discard;
  gl_FragColor = col;
}
`;

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
    uniforms: { uResolution: { value: resolution } },
    side: THREE.DoubleSide,
  });
  applyBlendMode(mat, blend);
  return mat;
}

export function makeFillMaterial(blend: BlendMode): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: fillVert,
    fragmentShader: fillFrag,
    uniforms: {},
    side: THREE.DoubleSide,
  });
  applyBlendMode(mat, blend);
  return mat;
}
