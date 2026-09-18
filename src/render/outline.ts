// Selection outlines by SILHOUETTE, for anything the renderer can draw.
//
// Mesh objects already wear an inverted-hull rim (MeshManager), which works
// because a mesh has surfaces and normals to push outward. Two kinds have
// neither and were stuck with a world-axis bounding box — which is a lie
// about their shape and, for a splat, was not even a lie about the right
// place: a SplatMesh's own geometry is one instanced quad, so its box sat
// small at the origin whatever the splat looked like.
//
//   - a GREASE PENCIL object is ribbons built in its vertex shader, so
//     there is no mesh to fatten; its outline should hug the STROKES.
//   - a SPLAT is thousands of gaussians alpha-blended by Spark; its outline
//     is wherever the cloud is opaque enough to read, ragged floaters and
//     all — the same thing Blender draws.
//
// Both answer to the approach Blender itself uses: render the selected
// objects alone, with THEIR OWN materials, into a mask; then draw a rim
// wherever a pixel outside the mask has a neighbour inside it. Their own
// materials, not an override — an override material is exactly what turns
// a GP stroke into a slab and a point sprite into a square (see
// fx/scenefx.ts `hideNonDrawing`), and would give the silhouette of
// something that was never drawn.
//
// The mask is taken with nothing else in the frame, so an outline shows
// through whatever stands in front of it, like the hull rims: the outline
// you cannot see is the one you were looking for.
import * as THREE from 'three';

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Rim = outside the mask, with something inside it within `uWidth` px.
 *
 * Sampled on two rings rather than a solid disc: sixteen directions at the
 * full width and at half of it catch any feature wider than a couple of
 * pixels, which is every feature a selection outline has to show, at a
 * fraction of the cost of a dilation pass.
 */
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMask;
uniform vec2 uTexel;
uniform float uWidth;
uniform float uThreshold;
uniform vec3 uColor;
uniform float uAlpha;
float inside(vec2 uv) { return step(uThreshold, texture2D(tMask, uv).a); }
void main() {
  if (inside(vUv) > 0.5) discard;
  float hit = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.39269908;           // 2*pi / 16
    vec2 d = vec2(cos(a), sin(a)) * uTexel;
    hit = max(hit, inside(vUv + d * uWidth));
    hit = max(hit, inside(vUv + d * uWidth * 0.5));
  }
  if (hit < 0.5) discard;
  gl_FragColor = vec4(uColor, uAlpha);
}`;

export interface OutlineGroup {
  roots: THREE.Object3D[];
  color: THREE.Color;
}

export class SilhouetteOutline {
  private mask = new THREE.WebGLRenderTarget(2, 2);
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  /** line width in CSS px — scaled by the pixel ratio when drawn */
  width = 2;
  /** how opaque a pixel must be to count as the object. Low enough to catch
   *  a translucent stroke, high enough that a splat's faint haze does not
   *  inflate its outline into a blob */
  threshold = 0.22;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        tMask: { value: this.mask.texture },
        uTexel: { value: new THREE.Vector2() },
        uWidth: { value: 2 },
        uThreshold: { value: 0.22 },
        uColor: { value: new THREE.Color() },
        uAlpha: { value: 1 },
      },
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat));
  }

  /**
   * Draw the outlines of each group over whatever is currently on screen.
   *
   * One mask render per group, so the active object can wear a brighter rim
   * than the rest of the selection; in practice that is at most two.
   */
  draw(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
    groups: OutlineGroup[], alpha: number,
  ): void {
    const live = groups.filter((g) => g.roots.length);
    if (!live.length) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.mask.width !== size.x || this.mask.height !== size.y) this.mask.setSize(size.x, size.y);
    const u = this.mat.uniforms;
    (u.uTexel.value as THREE.Vector2).set(1 / size.x, 1 / size.y);
    u.uWidth.value = this.width * renderer.getPixelRatio();
    u.uThreshold.value = this.threshold;
    u.uAlpha.value = alpha;

    const savedTarget = renderer.getRenderTarget();
    const savedClear = renderer.getClearColor(new THREE.Color());
    const savedClearAlpha = renderer.getClearAlpha();
    const savedAutoClear = renderer.autoClear;
    for (const g of live) {
      this.renderMask(renderer, scene, camera, g.roots);
      (u.uColor.value as THREE.Color).copy(g.color);
      renderer.setRenderTarget(savedTarget);
      renderer.autoClear = false;
      renderer.render(this.quadScene, this.quadCam);
      renderer.autoClear = savedAutoClear;
    }
    renderer.setClearColor(savedClear, savedClearAlpha);
  }

  /**
   * The selected objects, drawn alone, into the mask's alpha.
   *
   * Isolation is by VISIBILITY, the same lever the per-object FX pass uses:
   * everything that is neither a selected root, inside one, nor on the path
   * from the scene down to one is hidden for the duration. The splat
   * renderer is the one exception — Spark draws every splat through a
   * single SparkRenderer object, so it must stay on while the OTHER splat
   * meshes (siblings, not ancestors) go dark.
   */
  private renderMask(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
    roots: THREE.Object3D[],
  ): void {
    const keep = new Set(roots);
    const path = new Set<THREE.Object3D>();
    for (const r of roots) for (let p = r.parent; p; p = p.parent) path.add(p);
    const hidden: THREE.Object3D[] = [];
    const walk = (o: THREE.Object3D) => {
      for (const c of o.children) {
        if (keep.has(c)) continue;
        if (path.has(c)) { walk(c); continue; }
        if (c.userData.splatRenderer) continue;
        if (c.visible) { c.visible = false; hidden.push(c); }
      }
    };
    walk(scene);
    const savedBg = scene.background;
    const savedFog = scene.fog;
    const savedOverride = scene.overrideMaterial;
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = null;
    renderer.setRenderTarget(this.mask);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    scene.background = savedBg;
    scene.fog = savedFog;
    scene.overrideMaterial = savedOverride;
    for (const o of hidden) o.visible = true;
  }

  dispose(): void {
    this.mask.dispose();
    this.mat.dispose();
  }
}
