// Scene lights (scene.lights) -> three.js light objects + helper glyphs.
//
// Lighting used to be two hardcoded objects in the App constructor. Making
// them scene data is what lets the PBR material channels added in phase 1
// mean anything, and is the prerequisite for baking shadows in phase 5.
//
// Same lifecycle pattern as MeshManager: sync() reconciles entries against
// the data each frame, rebuilding an entry only when its light KIND changes
// (three.js has a different class per kind) and otherwise just pushing
// properties. Helper glyphs are unlit line art so a light is visible and
// clickable even though the light itself renders nothing.
import * as THREE from 'three';
import type { GPScene, TGLight, TGProjection } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import { liveKeyOf, liveSources } from '../io/livesources';

/** The projector canvas is square because three maps a spot light's texture
 *  over its SQUARE frustum; the cone then cuts the inscribed circle out of
 *  it, and the picture is laid inside that circle. */
const PROJ_SIZE = 1024;

type AnyLight = THREE.AmbientLight | THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight;

interface Entry {
  root: THREE.Group;
  light: AnyLight;
  helper: THREE.Object3D;
  kind: TGLight['kind'];
  shadowMapSize: number;
  /** the projected picture: its canvas, the texture over it, and what was
   *  last painted there (so a still image is painted once) */
  proj?: {
    canvas: HTMLCanvasElement;
    texture: THREE.CanvasTexture;
    imgs: Map<string, HTMLImageElement>;
    key: string;
    live: boolean;
    frame: number;
  };
  /** the beam glyph's current shape, so it is only rebuilt when it changes */
  beamKey?: string;
}

/** Unlit wire glyph per kind, so lights read at a glance in the viewport.
 *  Sized in world units; kept small since lights have no geometry of their
 *  own. An invisible pick sphere keeps them clickable (same trick as the
 *  EMPTY object's helper in meshes.ts). */
function makeHelper(kind: TGLight['kind'], color: THREE.ColorRepresentation): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color });
  const pts: number[] = [];
  if (kind === 'SUN') {
    // rays radiating from a small ring, plus a direction stem down -Z
    const R = 0.18;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push(Math.cos(a) * R, Math.sin(a) * R, 0, Math.cos(a) * R * 1.9, Math.sin(a) * R * 1.9, 0);
    }
    pts.push(0, 0, 0, 0, 0, -0.9);
  } else if (kind === 'AMBIENT') {
    const R = 0.22; // a plain ring — ambient has no position or direction
    for (let i = 0; i < 24; i++) {
      const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
      pts.push(Math.cos(a0) * R, Math.sin(a0) * R, 0, Math.cos(a1) * R, Math.sin(a1) * R, 0);
    }
  } else if (kind === 'POINT') {
    const R = 0.16;
    for (const [ax, ay] of [[0, 1], [1, 0], [1, 1]] as const) {
      for (let i = 0; i < 16; i++) {
        const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
        pts.push(
          Math.cos(a0) * R * ax, Math.sin(a0) * R * ay, ax && ay ? 0 : Math.sin(a0) * R * (1 - ay),
          Math.cos(a1) * R * ax, Math.sin(a1) * R * ay, ax && ay ? 0 : Math.sin(a1) * R * (1 - ay),
        );
      }
    }
  } else { // SPOT: a cone opening down -Z
    const R = 0.35, L = 0.9;
    for (let i = 0; i < 16; i++) {
      const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
      pts.push(Math.cos(a0) * R, Math.sin(a0) * R, -L, Math.cos(a1) * R, Math.sin(a1) * R, -L);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      pts.push(0, 0, 0, Math.cos(a) * R, Math.sin(a) * R, -L);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, mat);
  lines.userData.lightHelper = true;
  const pick = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  pick.userData.lightHelper = true;
  g.add(lines, pick);
  return g;
}

/**
 * The beam a projector throws, as wire: a rectangular pyramid at the
 * picture's own aspect, inscribed in the cone (the picture's DIAGONAL spans
 * the cone, which is how the texture is laid in). A round gobo, or a spot
 * with no picture, keeps the cone.
 */
function beamLines(angle: number, aspect: number, length: number): THREE.BufferGeometry {
  const pts: number[] = [];
  const r = Math.tan(angle) * length;
  if (aspect > 0) {
    const w = r * aspect / Math.hypot(1, aspect), h = r / Math.hypot(1, aspect);
    const corners: [number, number][] = [[-w, -h], [w, -h], [w, h], [-w, h]];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      pts.push(a[0], a[1], -length, b[0], b[1], -length);
      pts.push(0, 0, 0, a[0], a[1], -length);
    }
  } else {
    for (let i = 0; i < 24; i++) {
      const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
      pts.push(Math.cos(a0) * r, Math.sin(a0) * r, -length, Math.cos(a1) * r, Math.sin(a1) * r, -length);
      if (i % 6 === 0) pts.push(0, 0, 0, Math.cos(a0) * r, Math.sin(a0) * r, -length);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/** The picture the projection points at, as something drawable: a live
 *  source's canvas (camera, video, GIF) or a loaded image. */
function sourceOf(entry: Entry, src: string): CanvasImageSource | null {
  const live = liveKeyOf(src);
  if (live) return liveSources.get(live)?.canvas ?? liveSources.textureFor(live).image as HTMLCanvasElement;
  const p = entry.proj!;
  let img = p.imgs.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => { p.key = ''; };       // force a repaint once it is here
    img.src = src;
    p.imgs.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function makeLight(kind: TGLight['kind']): AnyLight {
  switch (kind) {
    case 'AMBIENT': return new THREE.AmbientLight(0xffffff, 1);
    case 'SUN': return new THREE.DirectionalLight(0xffffff, 1);
    case 'POINT': return new THREE.PointLight(0xffffff, 1);
    case 'SPOT': return new THREE.SpotLight(0xffffff, 1);
  }
}

export class LightManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, Entry>();
  /** helper glyphs hidden in presentation mode / when overlays are off */
  helpersVisible = true;
  /** Selection tint for the wire glyph, set by the App from
   *  settings.uiHighlight. A light has no surface for the usual Box3
   *  outline to hug, so the glyph itself turns highlight-coloured — same
   *  read as an outlined object, and how Blender marks a selected lamp. */
  selectionColor: THREE.Color | null = null;
  private tint = new THREE.Color();

  sync(scene: GPScene): void {
    // drop entries whose light is gone or changed kind (different class)
    for (const [id, entry] of this.entries) {
      const data = scene.lights.find((l) => l.id === id);
      if (!data || data.kind !== entry.kind) {
        this.group.remove(entry.root);
        this.dispose(entry);
        this.entries.delete(id);
      }
    }
    for (const data of scene.lights) {
      let entry = this.entries.get(data.id);
      if (!entry) {
        const light = makeLight(data.kind);
        const helper = makeHelper(data.kind, new THREE.Color(...data.color));
        const root = new THREE.Group();
        root.add(light, helper);
        // SpotLight/DirectionalLight aim at their .target; parenting the
        // target to the light's own root makes "points down -Z" true, so
        // the object's rotation drives the beam like every other object
        // THREE.Light's constructor defaults .position to (0,1,0); leave it
        // and the light sits a unit off its own root, which skews the
        // light→target vector and makes rotation barely steer the beam.
        light.position.set(0, 0, 0);
        const l = light as THREE.SpotLight;
        if (l.target) { l.target.position.set(0, 0, -1); root.add(l.target); }
        root.userData.lightId = data.id;
        root.traverse((o) => { o.userData.lightId = data.id; });
        this.group.add(root);
        entry = { root, light, helper, kind: data.kind, shadowMapSize: 0 };
        this.entries.set(data.id, entry);
      }
      this.apply(entry, data, scene);
    }
  }

  private apply(entry: Entry, data: TGLight, scene: GPScene): void {
    const { light, root, helper } = entry;
    root.visible = data.visible;
    root.matrixAutoUpdate = false;
    root.matrix.copy(worldMatrixOf(scene, { kind: 'LIGHT', id: data.id }));

    light.color.setRGB(...data.color);
    light.intensity = data.intensity;
    helper.visible = this.helpersVisible;
    if (data.select && this.selectionColor) this.tint.copy(this.selectionColor);
    else this.tint.setRGB(...data.color);
    helper.traverse((o) => {
      const m = (o as THREE.Line).material as THREE.LineBasicMaterial | undefined;
      if (m?.color) m.color.copy(this.tint);
    });

    if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
      light.distance = data.distance ?? 0;
      light.decay = data.decay ?? 2;
    }
    if (light instanceof THREE.SpotLight) {
      light.angle = data.angle ?? Math.PI / 6;
      light.penumbra = data.penumbra ?? 0.2;
      this.applyProjection(entry, light, data);
    }
    // AmbientLight has no shadow at all
    if (!(light instanceof THREE.AmbientLight)) {
      light.castShadow = data.castShadow;
      const size = data.shadowMapSize ?? 1024;
      if (light.shadow) {
        light.shadow.bias = data.shadowBias ?? -0.0005;
        light.shadow.radius = data.shadowRadius ?? 2;
        if (entry.shadowMapSize !== size) {
          light.shadow.mapSize.set(size, size);
          // three.js only picks up a mapSize change if the old map is freed
          light.shadow.map?.dispose();
          light.shadow.map = null as unknown as THREE.WebGLRenderTarget;
          entry.shadowMapSize = size;
        }
        if (light instanceof THREE.DirectionalLight) {
          // a sun's shadow camera is orthographic and doesn't auto-fit;
          // a fixed generous box beats shadows silently vanishing offscreen
          const cam = light.shadow.camera as THREE.OrthographicCamera;
          cam.left = -12; cam.right = 12; cam.top = 12; cam.bottom = -12;
          cam.near = 0.1; cam.far = 60;
          cam.updateProjectionMatrix();
        }
      }
    }
  }

  /**
   * Paint the projector's picture into the light's map, and shape its beam
   * glyph to match. A live source repaints every frame it moves; a still
   * image is painted once (and again when it finishes loading).
   */
  private applyProjection(entry: Entry, light: THREE.SpotLight, data: TGLight): void {
    const proj = data.projection;
    const src = proj?.src ?? null;
    if (!src) {
      if (light.map) { light.map = null; }
      this.shapeBeam(entry, data, 0);
      return;
    }
    // a FLAT projector's picture is not carried as light (App collects it
    // for render/projectors.ts instead), so the lamp throws no map
    if (!entry.proj) {
      const canvas = document.createElement('canvas');
      canvas.width = PROJ_SIZE; canvas.height = PROJ_SIZE;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      entry.proj = { canvas, texture, imgs: new Map(), key: '', live: false, frame: -1 };
    }
    const p = entry.proj;
    const liveKey = liveKeyOf(src);
    const ls = liveKey ? liveSources.get(liveKey) : undefined;
    const b = proj!.blend;
    const key = `${src}|${proj!.mode ?? 'PROJECT'}|${proj!.aspect ?? 0}|${proj!.fit ?? 'CONTAIN'}`
      + `|${proj!.rotation ?? 0}|${proj!.flip ? 1 : 0}|${proj!.gain ?? 1}|${proj!.flat ? 1 : 0}`
      + `|${proj!.maskSrc ?? ''}|${proj!.maskInvert ? 1 : 0}`
      + `|${b ? [b.left, b.right, b.top, b.bottom, b.gamma].join(',') : ''}`;
    const frame = ls?.frame ?? 0;
    if (key !== p.key || frame !== p.frame) {
      const picture = sourceOf(entry, src);
      const mask = proj!.maskSrc ? sourceOf(entry, proj!.maskSrc) : null;
      if (picture) {
        paintProjection(p.canvas, picture, proj!, mask);
        p.texture.needsUpdate = true;
        p.key = key;
        p.frame = frame;
      }
    }
    light.map = proj!.flat ? null : p.texture;
    this.shapeBeam(entry, data, proj!.aspect ?? 0);
  }

  /** The wire beam, rebuilt only when its shape changes. */
  private shapeBeam(entry: Entry, data: TGLight, aspect: number): void {
    if (entry.kind !== 'SPOT') return;
    const angle = data.angle ?? Math.PI / 6;
    const key = `${angle.toFixed(4)}|${aspect}`;
    if (entry.beamKey === key) return;
    entry.beamKey = key;
    const lines = entry.helper.children.find((c) => c instanceof THREE.LineSegments) as THREE.LineSegments | undefined;
    if (!lines) return;
    lines.geometry.dispose();
    lines.geometry = beamLines(angle, aspect, 0.9);
  }

  /** The three.js light for a scene light (flat projectors need its own
   *  frustum matrix and shadow map). */
  lightFor(id: number): AnyLight | null { return this.entries.get(id)?.light ?? null; }

  /** The picture a projector is currently throwing, painted into its canvas. */
  projectionTexture(id: number): THREE.Texture | null { return this.entries.get(id)?.proj?.texture ?? null; }

  /** Root for selection glyphs / picking, like MeshManager.rootFor. */
  rootFor(id: number): THREE.Object3D | null { return this.entries.get(id)?.root ?? null; }

  /** Light roots for object-mode click picking. */
  pickTargets(scene: GPScene): THREE.Object3D[] {
    return scene.lights
      .filter((l) => l.visible)
      .map((l) => this.entries.get(l.id)?.root)
      .filter((r): r is THREE.Group => !!r);
  }

  private dispose(entry: Entry): void {
    entry.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
  }
}

/**
 * Lay the picture into the beam.
 *
 * The canvas IS the spot's square frustum and the cone cuts its inscribed
 * circle, so a rectangle of the wanted aspect is inscribed in THAT circle —
 * its diagonal spans the beam. Everything outside is black, which in a light
 * means "no light", so the lit shape on the wall is the projector's
 * rectangle rather than three's circular spot. A GOBO is greyscaled, since
 * what a gobo carries is a shape, and the light's own colour tints it.
 */
function paintProjection(
  canvas: HTMLCanvasElement, picture: CanvasImageSource, proj: TGProjection,
  mask: CanvasImageSource | null = null,
): void {
  const g = canvas.getContext('2d')!;
  const S = canvas.width;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = 'none';
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const sw = (picture as HTMLCanvasElement).width || (picture as HTMLImageElement).naturalWidth || 1;
  const sh = (picture as HTMLCanvasElement).height || (picture as HTMLImageElement).naturalHeight || 1;
  const aspect = proj.aspect && proj.aspect > 0 ? proj.aspect : 0;
  // the beam's disc is the inscribed circle: diameter S
  const rw = aspect ? S * aspect / Math.hypot(1, aspect) : S;
  const rh = aspect ? S / Math.hypot(1, aspect) : S;
  g.save();
  g.translate(S / 2, S / 2);
  if (proj.rotation) g.rotate(proj.rotation);
  if (proj.flip) g.scale(-1, 1);
  const gain = proj.gain ?? 1;
  const filters: string[] = [];
  if (proj.mode === 'GOBO') filters.push('grayscale(1)');
  if (gain !== 1) filters.push(`brightness(${Math.max(0, gain)})`);
  g.filter = filters.length ? filters.join(' ') : 'none';
  if (!aspect) {
    // round gobo: the picture fills the disc, cropped to it
    g.beginPath();
    g.arc(0, 0, S / 2, 0, Math.PI * 2);
    g.clip();
  }
  const k = proj.fit === 'COVER'
    ? Math.max(rw / sw, rh / sh)
    : Math.min(rw / sw, rh / sh);
  const dw = sw * k, dh = sh * k;
  g.beginPath();
  g.rect(-rw / 2, -rh / 2, rw, rh);
  g.clip();
  g.drawImage(picture, -dw / 2, -dh / 2, dw, dh);
  // MASK and EDGE BLEND multiply what was just drawn, inside the same clip:
  // black hides, white shows. Both belong here rather than in a shader
  // because the picture is painted once and BOTH paths — the light's own map
  // and the flat projector — read this canvas, so they cannot disagree.
  g.filter = proj.maskInvert ? 'grayscale(1) invert(1)' : 'grayscale(1)';
  g.globalCompositeOperation = 'multiply';
  if (mask) g.drawImage(mask, -rw / 2, -rh / 2, rw, rh);
  g.filter = 'none';
  const bl = proj.blend;
  if (bl) {
    const gamma = bl.gamma ?? 1;
    // a few stops shaped by gamma: a straight ramp over-brightens the
    // overlap, which is the whole thing edge blending exists to avoid
    const ramp = (x0: number, y0: number, x1: number, y1: number) => {
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const v = Math.round(255 * Math.pow(t, gamma));
        grad.addColorStop(t, `rgb(${v},${v},${v})`);
      }
      return grad;
    };
    const L = (bl.left ?? 0) * rw, R = (bl.right ?? 0) * rw;
    const T = (bl.top ?? 0) * rh, B = (bl.bottom ?? 0) * rh;
    if (L > 0) {                                    // black at the edge -> white inward
      g.fillStyle = ramp(-rw / 2, 0, -rw / 2 + L, 0);
      g.fillRect(-rw / 2, -rh / 2, L, rh);
    }
    if (R > 0) {
      g.fillStyle = ramp(rw / 2, 0, rw / 2 - R, 0);
      g.fillRect(rw / 2 - R, -rh / 2, R, rh);
    }
    if (T > 0) {
      g.fillStyle = ramp(0, -rh / 2, 0, -rh / 2 + T);
      g.fillRect(-rw / 2, -rh / 2, rw, T);
    }
    if (B > 0) {
      g.fillStyle = ramp(0, rh / 2, 0, rh / 2 - B);
      g.fillRect(-rw / 2, rh / 2 - B, rw, B);
    }
  }
  g.globalCompositeOperation = 'source-over';
  g.restore();
}
