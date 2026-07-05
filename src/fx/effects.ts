import * as THREE from 'three';
import type { EffectType, GPEffect } from '../core/types';

// Screen-space effect passes applied to a GP object's isolated render,
// mirroring Blender's Visual Effects.

export const EFFECT_DEFAULTS: Record<EffectType, { label: string; defaults: Record<string, number | boolean | number[]> }> = {
  BLUR: { label: 'Blur', defaults: { radius: 8 } },
  GLOW: { label: 'Glow', defaults: { radius: 24, strength: 1.2, color: [1, 0.8, 0.2] } },
  PIXELATE: { label: 'Pixelate', defaults: { size: 8 } },
  RIM: { label: 'Rim', defaults: { offsetX: 12, offsetY: 12, color: [1, 1, 1], blur: 2 } },
  SHADOW: { label: 'Shadow', defaults: { offsetX: 16, offsetY: -16, color: [0, 0, 0], opacity: 0.6 } },
  COLORIZE: { label: 'Colorize', defaults: { mode: 0 /* 0 gray, 1 sepia, 2 duotone */, factor: 1, lowColor: [0.1, 0, 0.3], highColor: [1, 0.9, 0.3] } },
  FLIP: { label: 'Flip', defaults: { flipX: true, flipY: false } },
  SWIRL: { label: 'Swirl', defaults: { angle: 1.5, radius: 0.5 } },
  WAVE_FX: { label: 'Wave', defaults: { amplitude: 12, period: 120, phase: 0, horizontal: true } },
};

export function createEffect(type: EffectType, id: number): GPEffect {
  const def = EFFECT_DEFAULTS[type];
  return { id, type, name: def.label, enabled: true, params: JSON.parse(JSON.stringify(def.defaults)) };
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG_COMMON = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uResolution;
varying vec2 vUv;
`;

const SHADERS: Record<string, string> = {
  copy: FRAG_COMMON + `void main(){ gl_FragColor = texture2D(tSrc, vUv); }`,
  blur: FRAG_COMMON + `
uniform vec2 uDir; uniform float uRadius;
void main(){
  vec4 sum = vec4(0.0); float wsum = 0.0;
  for (int i = -8; i <= 8; i++) {
    float fi = float(i);
    float w = exp(-fi*fi/18.0);
    sum += texture2D(tSrc, vUv + uDir * (fi * uRadius / 8.0) / uResolution) * w;
    wsum += w;
  }
  gl_FragColor = sum / wsum;
}`,
  addGlow: FRAG_COMMON + `
uniform sampler2D tGlow; uniform vec3 uColor; uniform float uStrength;
void main(){
  vec4 src = texture2D(tSrc, vUv);
  vec4 g = texture2D(tGlow, vUv);
  vec3 glow = uColor * g.a * uStrength;
  gl_FragColor = vec4(src.rgb + glow * (1.0 - src.a * 0.5), clamp(src.a + g.a * uStrength * 0.6, 0.0, 1.0));
}`,
  pixelate: FRAG_COMMON + `
uniform float uSize;
void main(){
  vec2 block = uResolution / uSize;
  vec2 uv = (floor(vUv * block) + 0.5) / block;
  gl_FragColor = texture2D(tSrc, uv);
}`,
  rim: FRAG_COMMON + `
uniform vec2 uOffset; uniform vec3 uColor;
void main(){
  vec4 src = texture2D(tSrc, vUv);
  float back = texture2D(tSrc, vUv - uOffset / uResolution).a;
  float rim = src.a * (1.0 - back);
  gl_FragColor = vec4(mix(src.rgb, uColor, rim), src.a);
}`,
  shadow: FRAG_COMMON + `
uniform vec2 uOffset; uniform vec3 uColor; uniform float uOpacity;
void main(){
  vec4 src = texture2D(tSrc, vUv);
  float sh = texture2D(tSrc, vUv - uOffset / uResolution).a * uOpacity;
  vec4 shadow = vec4(uColor, sh);
  // shadow under source
  vec3 rgb = src.rgb * src.a + shadow.rgb * shadow.a * (1.0 - src.a);
  float a = src.a + shadow.a * (1.0 - src.a);
  gl_FragColor = vec4(a > 0.001 ? rgb / a : rgb, a);
}`,
  colorize: FRAG_COMMON + `
uniform float uMode; uniform float uFactor; uniform vec3 uLow; uniform vec3 uHigh;
void main(){
  vec4 src = texture2D(tSrc, vUv);
  float g = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  vec3 outc;
  if (uMode < 0.5) outc = vec3(g);
  else if (uMode < 1.5) outc = vec3(g) * vec3(1.07, 0.74, 0.43) + vec3(0.06, 0.03, 0.0);
  else outc = mix(uLow, uHigh, g);
  gl_FragColor = vec4(mix(src.rgb, outc, uFactor), src.a);
}`,
  flip: FRAG_COMMON + `
uniform vec2 uFlip;
void main(){
  vec2 uv = vUv;
  if (uFlip.x > 0.5) uv.x = 1.0 - uv.x;
  if (uFlip.y > 0.5) uv.y = 1.0 - uv.y;
  gl_FragColor = texture2D(tSrc, uv);
}`,
  swirl: FRAG_COMMON + `
uniform float uAngle; uniform float uRadius;
void main(){
  vec2 center = vec2(0.5);
  vec2 d = vUv - center;
  d.x *= uResolution.x / uResolution.y;
  float r = length(d);
  float theta = uAngle * smoothstep(uRadius, 0.0, r);
  float c = cos(theta), s = sin(theta);
  vec2 rot = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  rot.x /= uResolution.x / uResolution.y;
  gl_FragColor = texture2D(tSrc, center + rot);
}`,
  wave: FRAG_COMMON + `
uniform float uAmp; uniform float uPeriod; uniform float uPhase; uniform float uHoriz;
void main(){
  vec2 uv = vUv;
  if (uHoriz > 0.5) uv.y += sin(vUv.x * uResolution.x / uPeriod * 6.2831 + uPhase) * uAmp / uResolution.y;
  else uv.x += sin(vUv.y * uResolution.y / uPeriod * 6.2831 + uPhase) * uAmp / uResolution.x;
  gl_FragColor = texture2D(tSrc, uv);
}`,
};

interface PassStep { shader: string; uniforms: Record<string, unknown>; useGlowInput?: boolean }

function planEffect(fx: GPEffect, res: THREE.Vector2): PassStep[] {
  const p = fx.params;
  const n = (k: string) => p[k] as number;
  const vec = (k: string) => p[k] as number[];
  switch (fx.type) {
    case 'BLUR':
      return [
        { shader: 'blur', uniforms: { uDir: new THREE.Vector2(1, 0), uRadius: n('radius') } },
        { shader: 'blur', uniforms: { uDir: new THREE.Vector2(0, 1), uRadius: n('radius') } },
      ];
    case 'GLOW':
      return [
        { shader: 'blur', uniforms: { uDir: new THREE.Vector2(1, 0), uRadius: n('radius') } },
        { shader: 'blur', uniforms: { uDir: new THREE.Vector2(0, 1), uRadius: n('radius') } },
        {
          shader: 'addGlow', useGlowInput: true,
          uniforms: { uColor: new THREE.Vector3(...vec('color')), uStrength: n('strength') },
        },
      ];
    case 'PIXELATE': return [{ shader: 'pixelate', uniforms: { uSize: Math.max(1, n('size')) } }];
    case 'RIM': return [{
      shader: 'rim',
      uniforms: { uOffset: new THREE.Vector2(n('offsetX'), n('offsetY')), uColor: new THREE.Vector3(...vec('color')) },
    }];
    case 'SHADOW': return [{
      shader: 'shadow',
      uniforms: { uOffset: new THREE.Vector2(n('offsetX'), n('offsetY')), uColor: new THREE.Vector3(...vec('color')), uOpacity: n('opacity') },
    }];
    case 'COLORIZE': return [{
      shader: 'colorize',
      uniforms: { uMode: n('mode'), uFactor: n('factor'), uLow: new THREE.Vector3(...vec('lowColor')), uHigh: new THREE.Vector3(...vec('highColor')) },
    }];
    case 'FLIP': return [{
      shader: 'flip',
      uniforms: { uFlip: new THREE.Vector2(p.flipX ? 1 : 0, p.flipY ? 1 : 0) },
    }];
    case 'SWIRL': return [{ shader: 'swirl', uniforms: { uAngle: n('angle'), uRadius: n('radius') } }];
    case 'WAVE_FX': return [{
      shader: 'wave',
      uniforms: { uAmp: n('amplitude'), uPeriod: Math.max(1, n('period')), uPhase: n('phase'), uHoriz: p.horizontal ? 1 : 0 },
    }];
  }
}

export class EffectsPipeline {
  private rtScene: THREE.WebGLRenderTarget;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private materials = new Map<string, THREE.ShaderMaterial>();
  private compositeMat: THREE.ShaderMaterial;

  constructor(w: number, h: number) {
    const opts = { format: THREE.RGBAFormat, type: THREE.HalfFloatType } as const;
    this.rtScene = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtA = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opts);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quadScene.add(this.quad);
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG_COMMON + `void main(){ vec4 c = texture2D(tSrc, vUv); gl_FragColor = c; }`,
      uniforms: { tSrc: { value: null }, uResolution: { value: new THREE.Vector2(w, h) } },
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.compositeMat.premultipliedAlpha = false;
  }

  setSize(w: number, h: number): void {
    this.rtScene.setSize(w, h);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
  }

  private material(shader: string): THREE.ShaderMaterial {
    let m = this.materials.get(shader);
    if (!m) {
      m = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: SHADERS[shader],
        uniforms: { tSrc: { value: null }, tGlow: { value: null }, uResolution: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2() }, uRadius: { value: 0 }, uSize: { value: 8 }, uOffset: { value: new THREE.Vector2() }, uColor: { value: new THREE.Vector3() }, uOpacity: { value: 1 }, uStrength: { value: 1 }, uMode: { value: 0 }, uFactor: { value: 1 }, uLow: { value: new THREE.Vector3() }, uHigh: { value: new THREE.Vector3() }, uFlip: { value: new THREE.Vector2() }, uAngle: { value: 0 }, uAmp: { value: 0 }, uPeriod: { value: 100 }, uPhase: { value: 0 }, uHoriz: { value: 1 } },
        depthTest: false, depthWrite: false,
      });
      this.materials.set(shader, m);
    }
    return m;
  }

  /**
   * `renderIsolated` must render only the target GP object into the given
   * render target (the app handles scene-graph isolation). The processed
   * result is composited over the current framebuffer.
   */
  apply(
    renderer: THREE.WebGLRenderer,
    renderIsolated: (target: THREE.WebGLRenderTarget) => void,
    effects: GPEffect[],
  ): void {
    const size = renderer.getSize(new THREE.Vector2());
    const res = new THREE.Vector2(this.rtScene.width, this.rtScene.height);

    const oldTarget = renderer.getRenderTarget();
    const oldClear = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();
    renderIsolated(this.rtScene);

    // run passes
    let src = this.rtScene;
    let dst = this.rtA;
    const glowSource = this.rtScene; // original for glow composite
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const steps = planEffect(fx, res);
      for (const step of steps) {
        const mat = this.material(step.shader);
        mat.uniforms.tSrc.value = step.useGlowInput ? glowSource.texture : src.texture;
        if (step.useGlowInput) mat.uniforms.tGlow.value = src.texture;
        mat.uniforms.uResolution.value.copy(res);
        for (const [k, val] of Object.entries(step.uniforms)) {
          if (mat.uniforms[k]) mat.uniforms[k].value = val;
        }
        this.quad.material = mat;
        renderer.setRenderTarget(dst);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this.quadScene, this.quadCam);
        const swap = src === this.rtScene ? this.rtB : src;
        src = dst;
        dst = swap === dst ? (dst === this.rtA ? this.rtB : this.rtA) : swap;
      }
    }

    // composite over the main framebuffer
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(oldClear, oldAlpha);
    this.compositeMat.uniforms.tSrc.value = src.texture;
    this.compositeMat.uniforms.uResolution.value.set(size.x, size.y);
    this.quad.material = this.compositeMat;
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCam);
    renderer.autoClear = oldAutoClear;
  }
}
