// Scene-level post: what the whole frame looks like, not what one object does.
//
// `fx/effects.ts` is per-GP-object — an isolated render of one object with
// blur/glow/rim composited back. This is the other axis: the finished frame,
// treated as an image. Two looks drive the design and every pass here earns
// its place in one of them:
//
//   TURRELL — a light-filled misty room. Fog does most of it (and fog belongs
//   in the scene, not here, because it has to be lit), then BLOOM spreads the
//   bright fields into the air around them and DUOTONE collapses the palette
//   onto two colours so the light reads as a field rather than as objects.
//   GRAIN exists because a smooth gradient across 1000 px in 8-bit BANDS
//   visibly, and dithering is the standard cure.
//
//   SKETCH — a line drawing. Edges come from DEPTH and NORMALS, never from
//   colour: a colour-difference edge detector misses the boundary between two
//   objects of the same colour (which is most of a grey scene) and invents
//   lines inside textures. That needs one extra render of the scene with a
//   normal material, which is the honest cost of good lines.
//
// The passes are ordered: edges are found on the ORIGINAL image (before
// bloom smears it), then colour is remapped, then bloom is added, then grain
// and vignette land on top of everything.
import * as THREE from 'three';
import type { TGPost, Vec3 } from '../core/types';

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEAD = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uResolution;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** bright-pass: keep what is above the threshold, softly */
const BRIGHT = `${HEAD}
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec4 c = texture2D(tSrc, vUv);
  float l = luma(c.rgb);
  // a hard cut-off pops as the light moves; a knee lets a field fade in
  float w = smoothstep(uThreshold - uKnee, uThreshold + uKnee, l);
  gl_FragColor = vec4(c.rgb * w, 1.0);
}`;

/** separable gaussian, in a direction given in pixels */
const BLUR = `${HEAD}
uniform vec2 uDir;
void main() {
  vec2 px = uDir / uResolution;
  vec3 sum = texture2D(tSrc, vUv).rgb * 0.227027;
  sum += (texture2D(tSrc, vUv + px * 1.3846).rgb
        + texture2D(tSrc, vUv - px * 1.3846).rgb) * 0.316216;
  sum += (texture2D(tSrc, vUv + px * 3.2308).rgb
        + texture2D(tSrc, vUv - px * 3.2308).rgb) * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}`;

/**
 * The one compositing pass: duotone, bloom, edges, grain, vignette.
 *
 * Kept as a single shader rather than a chain of small ones because every
 * one of these needs the ORIGINAL pixel as well as its own input, and
 * ping-ponging five times to keep re-reading it costs more than the branches.
 */
const COMPOSITE = `${HEAD}
uniform sampler2D tBloom;
uniform sampler2D tNormal;
uniform float uBloom;
uniform float uDuotone;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform float uLift;
uniform float uEdge;
uniform float uEdgeWidth;
uniform vec3 uInk;
uniform float uPaper;
uniform vec3 uPaperColor;
uniform float uGrade;
uniform vec2 uLevelsIn;
uniform float uGamma;
uniform vec2 uLevelsOut;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;

  // ---- edges, from the normal+depth buffer, on the UNTOUCHED image -------
  float edge = 0.0;
  if (uEdge > 0.0) {
    vec2 px = uEdgeWidth / uResolution;
    vec4 n0 = texture2D(tNormal, vUv);
    vec4 n1 = texture2D(tNormal, vUv + vec2(px.x, 0.0));
    vec4 n2 = texture2D(tNormal, vUv - vec2(px.x, 0.0));
    vec4 n3 = texture2D(tNormal, vUv + vec2(0.0, px.y));
    vec4 n4 = texture2D(tNormal, vUv - vec2(0.0, px.y));
    // normal discontinuity finds CREASES; depth discontinuity finds
    // SILHOUETTES. A line drawing needs both, and either alone looks broken:
    // creases only misses where a shape ends, depth only misses every fold.
    float dn = length(n1.rgb - n2.rgb) + length(n3.rgb - n4.rgb);
    float dd = abs(n1.a - n2.a) + abs(n3.a - n4.a);
    // RELATIVE depth: the jump as a fraction of the sample's own distance.
    // An absolute threshold cannot work at both ends of a room — tuned for a
    // near fold it draws the whole far floor, tuned for the far floor it
    // misses the fold — and the leftover distance term amplified the depth
    // buffer's own noise into a shimmering speckle along every grazing
    // surface, which is what read as z-fighting on the big flat planes.
    float rel = dd / max(0.001, n0.a);
    edge = clamp(dn * 1.6 + rel * 12.0, 0.0, 1.0);
    edge = smoothstep(0.30, 0.9, edge) * uEdge;
  }

  // ---- duotone ----------------------------------------------------------
  if (uDuotone > 0.0) {
    float l = clamp(luma(c) + uLift, 0.0, 1.0);
    vec3 duo = mix(uLow, uHigh, smoothstep(0.0, 1.0, l));
    c = mix(c, duo, uDuotone);
  }

  // ---- paper: wash the render out so the LINES carry the image ----------
  c = mix(c, uPaperColor, uPaper);

  // ---- bloom ------------------------------------------------------------
  if (uBloom > 0.0) c += texture2D(tBloom, vUv).rgb * uBloom;

  // ---- grade: levels, then brightness/contrast/saturation ---------------
  // Placed after bloom so it grades the finished image, and BEFORE the ink so
  // a line stays exactly the ink colour you picked — crushing the blacks of a
  // drawing should darken the paper, not repaint the pen.
  if (uGrade > 0.5) {
    c = clamp((c - uLevelsIn.x) / max(1e-4, uLevelsIn.y - uLevelsIn.x), 0.0, 1.0);
    c = pow(c, vec3(1.0 / max(0.01, uGamma)));
    c = uLevelsOut.x + c * (uLevelsOut.y - uLevelsOut.x);
    // contrast pivots on MIDDLE grey; pivoting on black is a brightness
    // control wearing the wrong name, and darkens everything as it bites
    c = (c - 0.5) * uContrast + 0.5 + uBrightness;
    c = mix(vec3(luma(c)), c, uSaturation);
    c = max(c, 0.0);
  }

  // ---- ink --------------------------------------------------------------
  c = mix(c, uInk, edge);

  // ---- grain: dither, mostly. A smooth field BANDS in 8 bits ------------
  if (uGrain > 0.0) {
    float n = hash(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5;
    c += n * uGrain;
  }

  // ---- vignette ---------------------------------------------------------
  if (uVignette > 0.0) {
    vec2 d = vUv - 0.5;
    c *= 1.0 - uVignette * smoothstep(0.25, 0.75, dot(d, d) * 2.0);
  }

  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * Hide, for the duration of the edge prepass, everything that does not shape
 * the depth buffer of the ordinary render.
 *
 * `scene.overrideMaterial` replaces each object's material outright, and
 * every flag on it goes too — `visible`, `colorWrite`, `depthWrite`, and the
 * object's own vertex shader. Two families of thing then come back to life
 * for exactly one pass, write depth and normals, and get inked:
 *
 *  - GREASE PENCIL strokes, which are the loud one. A stroke's ribbon is
 *    built in its vertex shader from a centreline plus corner attributes, so
 *    under a foreign material only the raw centreline points survive and
 *    they are drawn as plain triangles — a stroke on the view plane becomes
 *    a big flat polygon at one constant depth. What you see is a giant
 *    square ruled across the middle of the room with nothing inside it,
 *    because the thing never draws a pixel in colour. They belong out of the
 *    pass on their own merits too: `depthWrite: false` means they do not
 *    occlude anything in the real render either, and a stroke is already a
 *    line.
 *  - The invisible helpers — the pick proxies on empties and lights, and the
 *    gizmo's drag plane — whose materials are simply `visible: false`.
 *
 * Object visibility is checked by the renderer BEFORE the override is
 * consulted, so `visible` is the one lever that still works here. EDITOR
 * FURNITURE goes too, marked `userData.overlay`: the transform gizmo, the
 * plane helper, the camera frusta. None of them is part of the world being
 * drawn, and the gizmo in particular carries a 90,000-unit invisible drag
 * plane whose only possible contribution to a line drawing is a wrong one.
 * Outline shells go on the same principle.
 */
function hideNonDrawing(root: THREE.Object3D): THREE.Object3D[] {
  const hidden: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (!o.visible) return;
    if (o.userData.hoverShell || o.userData.overlay) { o.visible = false; hidden.push(o); return; }
    const mat = (o as THREE.Mesh).material;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    const skip = (m: THREE.Material) => m.visible === false || m.colorWrite === false
      || (m.depthWrite === false && m.transparent);
    if (list.every(skip)) { o.visible = false; hidden.push(o); }
  });
  return hidden;
}

/** Normals in rgb, view depth in alpha — one prepass feeds every edge. */
const NORMAL_DEPTH = {
  vertexShader: `
    varying vec3 vNormal;
    varying float vDepth;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vNormal;
    varying float vDepth;
    void main() {
      gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, vDepth);
    }`,
};

export class ScenePost {
  private rt: THREE.WebGLRenderTarget;
  private rtNormal: THREE.WebGLRenderTarget;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private composite: THREE.ShaderMaterial;
  private normalMat: THREE.ShaderMaterial;
  private w = 1; private h = 1;

  constructor(w: number, h: number) {
    const opts = { type: THREE.HalfFloatType } as const;
    this.rt = new THREE.WebGLRenderTarget(w, h, opts);
    this.rt.depthBuffer = true;
    // half res for the bloom chain: it is a blur, and nobody has ever seen
    // the difference — it halves the fill for the most expensive pass here
    this.rtA = new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), opts);
    this.rtB = new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), opts);
    // FULL float for the normal+depth buffer. Half float carries about three
    // decimal digits, so view depth across a 20 m room quantises to
    // centimetres and the edge pass reads that quantisation as detail —
    // visible as ink speckle crawling over big flat surfaces as the camera
    // moves. The colour buffer stays half float; only depth needs the range.
    this.rtNormal = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType });
    this.rtNormal.depthBuffer = true;
    this.rtNormal.texture.minFilter = THREE.NearestFilter;
    this.rtNormal.texture.magFilter = THREE.NearestFilter;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quadScene.add(this.quad);

    const res = new THREE.Vector2(w, h);
    this.bright = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BRIGHT, depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null }, uResolution: { value: res.clone() },
        uThreshold: { value: 0.7 }, uKnee: { value: 0.25 },
      },
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR, depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null }, uResolution: { value: res.clone() },
        uDir: { value: new THREE.Vector2(1, 0) },
      },
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null }, tBloom: { value: null }, tNormal: { value: null },
        uResolution: { value: res.clone() },
        uBloom: { value: 0 }, uDuotone: { value: 0 },
        uLow: { value: new THREE.Color(0.05, 0.02, 0.12) },
        uHigh: { value: new THREE.Color(1, 0.85, 0.7) },
        uLift: { value: 0 },
        uEdge: { value: 0 }, uEdgeWidth: { value: 1 },
        uInk: { value: new THREE.Color(0.1, 0.1, 0.12) },
        uPaper: { value: 0 }, uPaperColor: { value: new THREE.Color(1, 1, 1) },
        uGrade: { value: 0 },
        uLevelsIn: { value: new THREE.Vector2(0, 1) }, uGamma: { value: 1 },
        uLevelsOut: { value: new THREE.Vector2(0, 1) },
        uBrightness: { value: 0 }, uContrast: { value: 1 }, uSaturation: { value: 1 },
        uGrain: { value: 0 }, uVignette: { value: 0 }, uTime: { value: 0 },
      },
    });
    this.normalMat = new THREE.ShaderMaterial(NORMAL_DEPTH);
    this.setSize(w, h);
  }

  setSize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.rt.setSize(w, h);
    this.rtNormal.setSize(w, h);
    this.rtA.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.rtB.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    for (const m of [this.bright, this.blur, this.composite]) {
      (m.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    }
  }

  /** Where the frame should be drawn when post is on. */
  get target(): THREE.WebGLRenderTarget { return this.rt; }

  /** The edge prepass buffer — normals in rgb, view depth in alpha. Exposed
   *  for `App.whatIsHere`, which is how a viewport artefact gets diagnosed
   *  rather than guessed at. */
  get normalTarget(): THREE.WebGLRenderTarget { return this.rtNormal; }

  private draw(
    renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial,
    to: THREE.WebGLRenderTarget | null,
  ): void {
    this.quad.material = mat;
    renderer.setRenderTarget(to);
    renderer.render(this.quadScene, this.quadCam);
  }

  /**
   * Run the chain over whatever is in `target` and present to the screen.
   *
   * `scene`/`camera` are needed only for the edge prepass, and only when
   * edges are actually on — a look with no lines pays nothing for them.
   */
  present(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
    post: TGPost, time: number,
  ): void {
    const u = this.composite.uniforms;

    if (post.edge > 0) {
      const savedBg = scene.background;
      const savedOverride = scene.overrideMaterial;
      scene.background = null;
      scene.overrideMaterial = this.normalMat;
      const hidden = hideNonDrawing(scene);
      renderer.setRenderTarget(this.rtNormal);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      for (const o of hidden) o.visible = true;
      scene.overrideMaterial = savedOverride;
      scene.background = savedBg;
      u.tNormal.value = this.rtNormal.texture;
    }

    if (post.bloom > 0) {
      this.bright.uniforms.tSrc.value = this.rt.texture;
      this.bright.uniforms.uThreshold.value = post.bloomThreshold;
      this.draw(renderer, this.bright, this.rtA);
      const radius = Math.max(1, post.bloomRadius);
      for (let i = 0; i < 3; i++) {
        this.blur.uniforms.tSrc.value = this.rtA.texture;
        (this.blur.uniforms.uDir.value as THREE.Vector2).set(radius * (i + 1), 0);
        this.draw(renderer, this.blur, this.rtB);
        this.blur.uniforms.tSrc.value = this.rtB.texture;
        (this.blur.uniforms.uDir.value as THREE.Vector2).set(0, radius * (i + 1));
        this.draw(renderer, this.blur, this.rtA);
      }
      u.tBloom.value = this.rtA.texture;
    }

    u.tSrc.value = this.rt.texture;
    u.uBloom.value = post.bloom;
    u.uDuotone.value = post.duotone;
    (u.uLow.value as THREE.Color).setRGB(...post.duotoneLow);
    (u.uHigh.value as THREE.Color).setRGB(...post.duotoneHigh);
    u.uLift.value = post.lift;
    u.uEdge.value = post.edge;
    u.uEdgeWidth.value = post.edgeWidth;
    (u.uInk.value as THREE.Color).setRGB(...post.inkColor);
    u.uPaper.value = post.paper;
    (u.uPaperColor.value as THREE.Color).setRGB(...post.paperColor);
    (u.uLevelsIn.value as THREE.Vector2).set(post.inBlack, post.inWhite);
    u.uGamma.value = post.gamma;
    (u.uLevelsOut.value as THREE.Vector2).set(post.outBlack, post.outWhite);
    u.uBrightness.value = post.brightness;
    u.uContrast.value = post.contrast;
    u.uSaturation.value = post.saturation;
    u.uGrade.value = gradeActive(post) ? 1 : 0;
    u.uGrain.value = post.grain;
    u.uVignette.value = post.vignette;
    u.uTime.value = time;
    this.draw(renderer, this.composite, null);
  }

  dispose(): void {
    this.rt.dispose(); this.rtNormal.dispose();
    this.rtA.dispose(); this.rtB.dispose();
  }
}

/**
 * The looks, as data.
 *
 * Presets rather than a pile of sliders: what someone wants is "a Turrell
 * room" or "a line drawing", and the numbers that get there are a package.
 * Every one stays editable afterwards — changing anything flips the preset
 * to CUSTOM, so the panel never lies about what you are looking at.
 */
export const POST_PRESETS: Record<string, Omit<TGPost, 'preset'> & { fog: number; fogColor: Vec3 }> = {
  NONE: {
    bloom: 0, bloomThreshold: 0.75, bloomRadius: 2,
    duotone: 0, duotoneLow: [0.05, 0.03, 0.12], duotoneHigh: [1, 0.9, 0.78], lift: 0,
    edge: 0, edgeWidth: 1, inkColor: [0.1, 0.1, 0.12],
    paper: 0, paperColor: [1, 1, 1],
    inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1,
    brightness: 0, contrast: 1, saturation: 1,
    grain: 0, vignette: 0,
    fog: 0, fogColor: [0.6, 0.65, 0.75],
  },
  // Light as a material: heavy bloom so bright surfaces bleed into the air,
  // a two-colour ramp so the room reads as a field rather than as objects,
  // and grain because the whole point is a smooth gradient and 8 bits band.
  TURRELL: {
    bloom: 0.85, bloomThreshold: 0.55, bloomRadius: 3,
    duotone: 0.72, duotoneLow: [0.10, 0.05, 0.28], duotoneHigh: [1.0, 0.72, 0.55], lift: 0.06,
    edge: 0, edgeWidth: 1, inkColor: [0.1, 0.1, 0.12],
    paper: 0, paperColor: [1, 1, 1],
    inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1,
    brightness: 0, contrast: 1, saturation: 1,
    grain: 0.020, vignette: 0.18,
    fog: 0.075, fogColor: [0.55, 0.45, 0.70],
  },
  // The render is washed almost to paper so the LINES carry the image; a
  // little of it is left so form still reads through the hatching.
  SKETCH: {
    bloom: 0, bloomThreshold: 0.8, bloomRadius: 2,
    // the tonal range is squeezed into the top of the scale — a drawing is
    // paper with marks on it, not a grey render with lines added
    duotone: 0.85, duotoneLow: [0.80, 0.79, 0.76], duotoneHigh: [1, 1, 0.99], lift: 0.26,
    edge: 1, edgeWidth: 1.15, inkColor: [0.13, 0.12, 0.16],
    paper: 0.72, paperColor: [0.99, 0.98, 0.96],
    inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1,
    brightness: 0, contrast: 1, saturation: 1,
    grain: 0.012, vignette: 0.05,
    fog: 0, fogColor: [1, 1, 1],
  },
};

export function defaultPost(): TGPost {
  return { preset: 'NONE', ...POST_PRESETS.NONE };
}

/**
 * True when the grade is anything other than a pass-through.
 *
 * Checked on the CPU so a look that does not grade pays nothing for the
 * branch — the identity grade is a normalise, a pow and a mix per pixel, and
 * every look but a graded one would run all three to arrive back where it
 * started.
 */
export function gradeActive(p: TGPost): boolean {
  return p.inBlack !== 0 || p.inWhite !== 1 || p.gamma !== 1
    || p.outBlack !== 0 || p.outWhite !== 1
    || p.brightness !== 0 || p.contrast !== 1 || p.saturation !== 1;
}

/** True when the chain would change anything — otherwise skip it entirely. */
export function postActive(p: TGPost | undefined): p is TGPost {
  return !!p && (p.bloom > 0 || p.duotone > 0 || p.edge > 0
    || p.paper > 0 || p.grain > 0 || p.vignette > 0 || gradeActive(p));
}
