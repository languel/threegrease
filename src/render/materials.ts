import * as THREE from 'three';
import type { BlendMode } from '../core/types';

// Screen-space stroke ribbons with per-point radius/color/opacity.
// Vertex kinds: 0 = segment quad corner, 1 = round dot (cap/join/dot-mode), 2 = square dot.
const strokeVert = /* glsl */ `
attribute vec3 aDir;
attribute vec2 aCorner;
attribute float aRadius;
attribute vec4 aColor;
attribute float aKind;
attribute float aHardness;
uniform vec2 uResolution;
varying vec4 vColor;
varying vec2 vUv;
varying float vKind;
varying float vHardness;

void main() {
  vColor = aColor;
  vKind = aKind;
  vHardness = aHardness;
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
    vec2 offsetNdc = normal * (aRadius / uResolution.y) * 2.0;
    clip.xy += offsetNdc * aCorner.x * clip.w;
    vUv = vec2(aCorner.x, 0.0);
    gl_Position = clip;
  } else {
    // dot: billboard quad in screen space, aCorner in [-1,1]^2
    vec4 clip = clipA;
    vec2 off = aCorner * (aRadius / uResolution.y) * 2.0;
    off.x *= uResolution.y / uResolution.x;
    clip.xy += off * clip.w;
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

void main() {
  float alpha = vColor.a;
  if (vKind > 0.5 && vKind < 1.5) {
    float d = length(vUv);
    if (d > 1.0) discard;
    float soft = max(1.0 - vHardness, 0.001);
    alpha *= smoothstep(1.0, 1.0 - soft, d);
  } else if (vKind < 0.5) {
    float d = abs(vUv.x);
    float soft = max(1.0 - vHardness, 0.001);
    alpha *= smoothstep(1.0, 1.0 - soft, d);
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
