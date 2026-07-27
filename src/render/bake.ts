// Texture baking + camera projection.
//
// Bakes anything the renderer can draw — the whole scene, GP strokes alone,
// shadows, or a live camera frame — into an object's texture, mapped
// through its UVs.
//
// The standard two-pass GPU bake:
//
//   1. UV-space G-buffer. Render the TARGET mesh with a shader whose vertex
//      stage emits gl_Position = vec4(uv * 2 - 1, 0, 1) — i.e. rasterize the
//      mesh flat into UV space at texture resolution — while passing the
//      world position through. Every texel of the result answers "which
//      point in the world am I?".
//
//   2. Projection. A fullscreen pass over that G-buffer: take each texel's
//      world position, project it into the SOURCE camera's clip space,
//      sample the source render there, and depth-compare to reject texels
//      the source camera can't actually see (so back faces don't get
//      front-face paint).
//
// Then a dilation pass, without which UV seams bake as black fringes: bake
// coverage never lands exactly on the seam edge, and bilinear filtering
// pulls those empty texels in.
//
// The source render reuses the app's established isolation idiom (save
// visibility, show only what this bake wants, render, restore) — the same
// one the FX compositor and the object stencil use.
import * as THREE from 'three';
import type { GPScene } from '../core/types';

export type BakeSource = 'SCENE' | 'STROKES' | 'SHADOW' | 'INPUT';

export interface BakeRequest {
  /** what to render into the projection source */
  source: BakeSource;
  /** camera to project from (usually the viewport camera) */
  camera: THREE.Camera;
  /** the object being baked onto — must have a `uv` attribute */
  target: THREE.Mesh;
  /** output texture resolution */
  size: number;
  /** edge dilation in texels, to kill seam fringing */
  margin: number;
  /** live video/canvas frame for source === 'INPUT' */
  input?: HTMLVideoElement | HTMLCanvasElement | null;
  /** composite over the object's existing texture rather than replacing */
  existing?: HTMLImageElement | null;
}

const POSITION_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    // rasterize the mesh FLAT into UV space: uv becomes clip position
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const POSITION_FRAG = /* glsl */`
  varying vec3 vWorld;
  void main() { gl_FragColor = vec4(vWorld, 1.0); }
`;

const PROJECT_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PROJECT_FRAG = /* glsl */`
  uniform sampler2D tPos;     // world position per texel (pass 1)
  uniform sampler2D tSource;  // the rendered source
  uniform sampler2D tDepth;   // source depth, for occlusion
  uniform mat4 uViewProj;     // source camera view-projection
  uniform float uUseDepth;
  varying vec2 vUv;

  void main() {
    vec4 p = texture2D(tPos, vUv);
    if (p.a < 0.5) discard;               // texel isn't covered by the mesh

    vec4 clip = uViewProj * vec4(p.xyz, 1.0);
    if (clip.w <= 0.0) discard;           // behind the source camera
    vec3 ndc = clip.xyz / clip.w;
    if (any(greaterThan(abs(ndc.xy), vec2(1.0)))) discard;  // outside the frame

    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uUseDepth > 0.5) {
      // reject texels the source camera can't see (something is in front)
      float sceneDepth = texture2D(tDepth, uv).x;
      float texelDepth = ndc.z * 0.5 + 0.5;
      if (texelDepth > sceneDepth + 0.002) discard;
    }
    gl_FragColor = texture2D(tSource, uv);
  }
`;

/** Spread covered texels outward so seams don't sample empty space. */
const DILATE_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tSrc, vUv);
    if (c.a > 0.01) { gl_FragColor = c; return; }
    // take the nearest covered neighbour
    vec4 acc = vec4(0.0);
    float n = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec4 s = texture2D(tSrc, vUv + vec2(float(x), float(y)) * uTexel);
        if (s.a > 0.01) { acc += s; n += 1.0; }
      }
    }
    gl_FragColor = n > 0.0 ? acc / n : c;
  }
`;

export class BakeEngine {
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private posMat = new THREE.ShaderMaterial({
    vertexShader: POSITION_VERT,
    fragmentShader: POSITION_FRAG,
    side: THREE.DoubleSide,
  });
  private projMat = new THREE.ShaderMaterial({
    vertexShader: PROJECT_VERT,
    fragmentShader: PROJECT_FRAG,
    uniforms: {
      tPos: { value: null }, tSource: { value: null }, tDepth: { value: null },
      uViewProj: { value: new THREE.Matrix4() }, uUseDepth: { value: 1 },
    },
    transparent: true,
  });
  private dilateMat = new THREE.ShaderMaterial({
    vertexShader: PROJECT_VERT,
    fragmentShader: DILATE_FRAG,
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    transparent: true,
  });

  /** Per-pass coverage from the last bake — diagnostic only, so a bake that
   *  comes out empty says WHICH pass produced nothing. */
  lastStats: { posCoverage: number; srcCoverage: number; outCoverage: number } | null = null;

  constructor() { this.quadScene.add(this.quad); }

  /** Fraction of texels in `rt` with a non-zero alpha. */
  private coverage(
    gl: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, size: number, type?: THREE.TextureDataType,
  ): number {
    const n = Math.min(size, 128); // subsample: this is a diagnostic, not a metric
    const step = Math.max(1, Math.floor(size / n));
    const buf = type === THREE.FloatType ? new Float32Array(size * 4) : new Uint8Array(size * 4);
    let hit = 0, total = 0;
    for (let y = 0; y < size; y += step) {
      gl.readRenderTargetPixels(rt, 0, y, size, 1, buf);
      for (let x = 0; x < size; x += step) { total++; if (buf[x * 4 + 3] > 0.004) hit++; }
    }
    return total ? +(hit / total).toFixed(4) : 0;
  }

  /**
   * Run a bake and return the result as a dataURL (ready to become a
   * TGImage). Returns null if the target has no UVs to bake into.
   */
  bake(
    gl: THREE.WebGLRenderer, scene3: THREE.Scene, scene: GPScene,
    req: BakeRequest, gpRoot: THREE.Object3D | null,
  ): string | null {
    if (!req.target.geometry.getAttribute('uv')) return null;
    const size = Math.max(16, Math.min(4096, req.size));

    const savedTarget = gl.getRenderTarget();
    const savedClear = gl.getClearColor(new THREE.Color());
    const savedAlpha = gl.getClearAlpha();

    // --- pass 1: world position per texel, in UV space --------------------
    const rtPos = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType });
    const savedMat = req.target.material;
    req.target.material = this.posMat;
    const bakeScene = new THREE.Scene();
    const prevParent = req.target.parent;
    const prevIndex = prevParent ? prevParent.children.indexOf(req.target) : -1;
    req.target.updateWorldMatrix(true, false);
    // render the target ALONE, keeping its world matrix (the position
    // shader reads modelMatrix, so the object must not be re-parented in a
    // way that changes it — hence matrixAutoUpdate off and a direct copy)
    const savedAuto = req.target.matrixAutoUpdate;
    const savedMatrix = req.target.matrix.clone();
    req.target.matrixAutoUpdate = false;
    req.target.matrix.copy(req.target.matrixWorld);
    bakeScene.add(req.target);
    gl.setRenderTarget(rtPos);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(bakeScene, this.quadCam); // camera is irrelevant: UV-space raster
    // put the target back exactly where it was
    if (prevParent && prevIndex >= 0) prevParent.children.splice(prevIndex, 0, req.target);
    req.target.parent = prevParent;
    req.target.material = savedMat;
    req.target.matrixAutoUpdate = savedAuto;
    req.target.matrix.copy(savedMatrix);

    // --- source render ----------------------------------------------------
    const rtSrc = new THREE.WebGLRenderTarget(size, size, {
      depthTexture: new THREE.DepthTexture(size, size),
    });
    const useDepth = req.source !== 'INPUT';
    if (req.source === 'INPUT' && req.input) {
      // live camera: no scene render at all, just blit the frame
      // VideoTexture gates its upload on video.readyState, which a canvas
      // doesn't have — feed a canvas through CanvasTexture or it bakes black.
      const tex = req.input instanceof HTMLCanvasElement
        ? new THREE.CanvasTexture(req.input)
        : new THREE.VideoTexture(req.input);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.blit(gl, tex, rtSrc);
      tex.dispose();
    } else {
      const restore = this.isolate(scene3, req.source, gpRoot);
      gl.setRenderTarget(rtSrc);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(scene3, req.camera);
      restore();
    }

    // --- pass 2: project the source onto the UV-space G-buffer ------------
    const rtOut = new THREE.WebGLRenderTarget(size, size);
    req.camera.updateMatrixWorld();
    this.projMat.uniforms.tPos.value = rtPos.texture;
    this.projMat.uniforms.tSource.value = rtSrc.texture;
    this.projMat.uniforms.tDepth.value = rtSrc.depthTexture;
    this.projMat.uniforms.uUseDepth.value = useDepth ? 1 : 0;
    (this.projMat.uniforms.uViewProj.value as THREE.Matrix4).multiplyMatrices(
      req.camera.projectionMatrix, req.camera.matrixWorldInverse,
    );
    this.quad.material = this.projMat;
    gl.setRenderTarget(rtOut);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(this.quadScene, this.quadCam);

    // --- dilation: bleed coverage outward so seams don't fringe -----------
    let src = rtOut;
    let dst = new THREE.WebGLRenderTarget(size, size);
    this.quad.material = this.dilateMat;
    (this.dilateMat.uniforms.uTexel.value as THREE.Vector2).set(1 / size, 1 / size);
    for (let i = 0; i < Math.max(0, req.margin); i++) {
      this.dilateMat.uniforms.tSrc.value = src.texture;
      gl.setRenderTarget(dst);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(this.quadScene, this.quadCam);
      const swap = src; src = dst; dst = swap;
    }

    // --- read back --------------------------------------------------------
    const px = new Uint8Array(size * size * 4);
    gl.readRenderTargetPixels(src, 0, 0, size, size, px);
    this.lastStats = {
      posCoverage: this.coverage(gl, rtPos, size, THREE.FloatType),
      srcCoverage: this.coverage(gl, rtSrc, size),
      outCoverage: this.coverage(gl, rtOut, size),
    };
    gl.setRenderTarget(savedTarget);
    gl.setClearColor(savedClear, savedAlpha);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d')!;
    // composite over the existing texture so a bake can add to what's
    // already painted rather than wiping it
    if (req.existing?.complete && req.existing.naturalWidth) {
      g.drawImage(req.existing, 0, 0, size, size);
    }
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      const s = (size - 1 - y) * size * 4; // GL is bottom-up
      img.data.set(px.subarray(s, s + size * 4), y * size * 4);
    }
    // put the baked layer on top, honoring its alpha
    const layer = document.createElement('canvas');
    layer.width = size;
    layer.height = size;
    layer.getContext('2d')!.putImageData(img, 0, 0);
    g.drawImage(layer, 0, 0);

    rtPos.dispose();
    rtSrc.dispose();
    rtOut.dispose();
    dst.dispose();
    if (src !== rtOut) src.dispose();
    void scene;
    return canvas.toDataURL('image/png');
  }

  /** Blit a texture into a render target (used for the live INPUT source). */
  private blit(gl: THREE.WebGLRenderer, tex: THREE.Texture, rt: THREE.WebGLRenderTarget): void {
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    this.quad.material = mat;
    gl.setRenderTarget(rt);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(this.quadScene, this.quadCam);
    mat.dispose();
  }

  /**
   * Hide everything the requested source shouldn't include, returning a
   * restore function. Same save/mutate/render/restore shape the FX
   * compositor uses.
   */
  private isolate(scene3: THREE.Scene, source: BakeSource, gpRoot: THREE.Object3D | null): () => void {
    const saved: { o: THREE.Object3D; v: boolean }[] = [];
    const savedBg = scene3.background;
    const savedOverride = scene3.overrideMaterial;
    scene3.background = null;

    if (source === 'STROKES' && gpRoot) {
      for (const c of scene3.children) {
        saved.push({ o: c, v: c.visible });
        c.visible = c === gpRoot;
      }
    } else if (source === 'SHADOW') {
      // shadow-only: flat white surfaces, so the render IS the shading —
      // lit areas come out white, shadowed areas dark
      scene3.overrideMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    }
    return () => {
      for (const { o, v } of saved) o.visible = v;
      scene3.overrideMaterial?.dispose?.();
      scene3.overrideMaterial = savedOverride;
      scene3.background = savedBg;
    };
  }

  dispose(): void {
    this.posMat.dispose();
    this.projMat.dispose();
    this.dilateMat.dispose();
    this.quad.geometry.dispose();
  }
}

export const bakeEngine = new BakeEngine();
