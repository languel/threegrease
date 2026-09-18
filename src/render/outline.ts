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
  /** world-space bounds of the roots, when known — lets both passes run in
   *  a scissor around the selection instead of over the whole frame */
  boxes?: THREE.Box3[];
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
    const savedScissorTest = renderer.getScissorTest();
    const savedScissor = renderer.getScissor(new THREE.Vector4());
    const px = u.uWidth.value as number;
    for (const g of live) {
      // THE COST IS PIXELS, not objects: the rim shader reads the mask 32
      // times per pixel, so a full-screen pass at retina resolution is most
      // of a millisecond even when the selection is a speck in one corner.
      // Both passes run in a scissor round the selection's projected bounds
      // — the mask one wider by the rim width, so the composite's outermost
      // samples still land on pixels the mask pass actually cleared.
      // bounds are CENTRELINES and centres; a stroke's ribbon and a mesh's
      // shading spill a little past them, so the rect gets a fixed margin
      // on top of the rim width
      const box = screenRect(g.boxes, camera, size);
      const rect = box && grow(box, MARGIN_PX * renderer.getPixelRatio() + px, size);
      this.renderMask(renderer, scene, camera, g.roots, rect && grow(rect, px, size));
      (u.uColor.value as THREE.Color).copy(g.color);
      renderer.setRenderTarget(savedTarget);
      scissor(renderer, rect);
      renderer.autoClear = false;
      renderer.render(this.quadScene, this.quadCam);
      renderer.autoClear = savedAutoClear;
    }
    renderer.setScissor(savedScissor);
    renderer.setScissorTest(savedScissorTest);
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
    roots: THREE.Object3D[], rect: Rect | null,
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
    scissor(renderer, rect);
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

/** Slack round the projected bounds, CSS px — covers a thick stroke's
 *  ribbon, which is drawn this far outside the centreline its box measures. */
const MARGIN_PX = 24;

/** A pixel rectangle in DRAWING-BUFFER space, origin bottom-left (GL). */
interface Rect { x: number; y: number; w: number; h: number }

/**
 * The screen rectangle covering some world boxes, or null for "the whole
 * frame" — which is also the answer whenever a box reaches behind the
 * camera, where projecting its corners gives nonsense rather than bounds.
 */
function screenRect(boxes: THREE.Box3[] | undefined, camera: THREE.Camera, size: THREE.Vector2): Rect | null {
  if (!boxes?.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const v = new THREE.Vector3();
  for (const b of boxes) {
    if (b.isEmpty()) return null;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(camera);
      if (v.z < -1 || v.z > 1) return null;
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
  }
  const px = (n: number, s: number) => (n * 0.5 + 0.5) * s;
  return { x: px(x0, size.x), y: px(y0, size.y), w: px(x1, size.x) - px(x0, size.x), h: px(y1, size.y) - px(y0, size.y) };
}

function grow(r: Rect, by: number, size: THREE.Vector2): Rect {
  const x = Math.max(0, Math.floor(r.x - by));
  const y = Math.max(0, Math.floor(r.y - by));
  const x1 = Math.min(size.x, Math.ceil(r.x + r.w + by));
  const y1 = Math.min(size.y, Math.ceil(r.y + r.h + by));
  return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
}

/** Scissor in drawing-buffer px. three's setScissor takes CSS px and
 *  multiplies by the pixel ratio itself, so divide it back out. */
function scissor(renderer: THREE.WebGLRenderer, r: Rect | null): void {
  if (!r) { renderer.setScissorTest(false); return; }
  const k = renderer.getPixelRatio();
  renderer.setScissor(r.x / k, r.y / k, r.w / k, r.h / k);
  renderer.setScissorTest(true);
}
