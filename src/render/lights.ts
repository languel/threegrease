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
import { isCurved } from './lens';

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
  /** SPOT only: the draggable aim target out along the beam, and the cone
   *  and blend rings at the distance it reaches */
  aim?: THREE.Object3D;
  cone?: THREE.Object3D;
  blend?: THREE.Object3D;
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
/**
 * The wire beam. `up`, when given, is the direction the PICTURE's top edge
 * points in the beam's own x/y plane — a projector throwing an image is the
 * one light whose ROLL matters, and a cone (or even a rectangle, which is
 * symmetric about both axes) cannot show it: a frame hung upside down or
 * quarter-turned looks exactly like a correct one until you light it.
 */
function beamLines(
  angle: number, aspect: number, length: number, up?: [number, number] | null,
  corners?: [number, number][] | null,
): THREE.BufferGeometry {
  const pts: number[] = [];
  const r = Math.tan(angle) * length;
  if (corners && corners.length === 4) {
    // KEYSTONE: the glyph draws the quad the picture is actually thrown
    // into, not the rectangle it would have been. A wireframe that still
    // showed a rectangle after the corners were pulled would be a drawing
    // of a projector nobody has.
    const q = corners.map(([u, v]) => [(u * 2 - 1) * r, (v * 2 - 1) * r] as [number, number]);
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      pts.push(a[0], a[1], -length, b[0], b[1], -length);
      pts.push(0, 0, 0, a[0], a[1], -length);
    }
  } else if (aspect > 0) {
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
  if (up) {
    // an arrowhead riding just outside the beam's edge, along the picture's
    // own up — drawn at the FAR end where the picture lands, and in the
    // beam's plane, so it reads from wherever you can see the beam
    const un = Math.hypot(up[0], up[1]) || 1;
    const u: [number, number] = [up[0] / un, up[1] / un];
    const side: [number, number] = [-u[1], u[0]];
    // how far out the edge is in this direction: the rectangle's own half
    // extent, or the disc's radius
    let edge = r;
    if (aspect > 0) {
      const w = r * aspect / Math.hypot(1, aspect), h = r / Math.hypot(1, aspect);
      edge = Math.min(Math.abs(u[0]) > 1e-6 ? w / Math.abs(u[0]) : Infinity,
        Math.abs(u[1]) > 1e-6 ? h / Math.abs(u[1]) : Infinity);
    }
    const base = edge + r * 0.08, tip = edge + r * 0.3, half = r * 0.12;
    const at = (a: number, b: number): [number, number, number] =>
      [u[0] * a + side[0] * b, u[1] * a + side[1] * b, -length];
    const t = at(tip, 0), l = at(base, -half), rr = at(base, half);
    pts.push(...l, ...t, ...t, ...rr, ...rr, ...l);
    // and a stem back to the edge, so the arrow reads as belonging to it
    pts.push(...at(edge, 0), ...at(base, 0));
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
  /**
   * Do the LAMPS light the scene? Blender holds them back outside Rendered
   * shading, and the whole group used to be hidden to do that — which took
   * the wire GLYPHS with it, so in Solid or Wireframe a projector was a
   * selection dot with no beam and nothing to aim. The glyph is editor
   * furniture, like a camera's frustum: it is drawn in every shading mode,
   * and only the light itself stands down.
   */
  lightsEnabled = true;
  /** Selection tint for the wire glyph, set by the App from
   *  settings.uiHighlight. A light has no surface for the usual Box3
   *  outline to hug, so the glyph itself turns highlight-coloured — same
   *  read as an outlined object, and how Blender marks a selected lamp. */
  selectionColor: THREE.Color | null = null;
  /** the light a media drag is hovering: its glyph is all a lamp has to
   *  light up with, so the beam says "drop it here and I will throw it" */
  hoverId: number | null = null;
  /** The view's rotation, set by the App each frame. A POINT light has no
   *  orientation of its own, so its reach ring has no plane to lie in that
   *  is not arbitrary — drawn in the lamp's own XY it is edge-on from a
   *  level view, which is most of them, and both unreadable and ungrabbable.
   *  It faces the camera instead, like Blender's. */
  viewQuat: THREE.Quaternion | null = null;
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

  /**
   * THE AIM HANDLE: a ring out along the beam, at the distance the beam
   * actually reaches, with a stem back to the lamp. Dragging it aims the
   * projector (App.aimDrag) — which is the only way to aim one from outside
   * it, since a lamp has no face to grab and rotating it by eye through the
   * transform widget means guessing which way -Z went.
   *
   * It is drawn only for the SELECTED spot, because it is a control and not
   * a decoration, and it lives in the light's own space so it follows
   * whatever moves the lamp.
   */
  private makeAimHandle(): THREE.Object3D {
    const g = new THREE.Group();
    // painted from `selectionColor` in apply(), like the glyph itself
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 });
    const pts: number[] = [];
    const R = 0.16;
    for (let i = 0; i < 20; i++) {
      const a0 = (i / 20) * Math.PI * 2, a1 = ((i + 1) / 20) * Math.PI * 2;
      pts.push(Math.cos(a0) * R, Math.sin(a0) * R, 0, Math.cos(a1) * R, Math.sin(a1) * R, 0);
    }
    // a cross in the ring, so it reads as a target rather than a bubble
    pts.push(-R, 0, 0, R, 0, 0, 0, -R, 0, 0, R, 0);
    const ring = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: pts.length / 3 }, (_, i) => new THREE.Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]))), mat);
    g.add(ring);
    g.renderOrder = 999;
    return g;
  }

  /**
   * THE CONE AND BLEND RINGS, Blender's light gizmo: the beam's rim at the
   * distance it reaches, and inside it the ring where the soft edge begins.
   * Dragging either is how a spot is shaped in a room — a cone angle typed
   * into a field is a number you then have to go and look at, while the
   * ring IS the edge of the light on the wall.
   *
   * Both are drawn in the light's own space at the aim distance, so they
   * ride the lamp; the handle dot sits on the ring at a fixed clock
   * position (3 o'clock for the cone, 12 for the blend) so the two are
   * never on top of each other.
   */
  private makeRing(dot: [number, number]): THREE.Object3D {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.75 });
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 48; i++) {
      const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a0), Math.sin(a0), 0),
        new THREE.Vector3(Math.cos(a1), Math.sin(a1), 0));
    }
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat));
    // the grab point, a small square on the ring
    // built around ITS OWN origin and then positioned on the ring: scaling
    // it to hold a constant size must not drag it toward the centre, which
    // is exactly what happens if its vertices carry the offset
    const d = 1;
    const q: THREE.Vector3[] = [];
    const corner = [[-d, -d], [d, -d], [d, d], [-d, d]] as const;
    for (let i = 0; i < 4; i++) {
      const a = corner[i], b = corner[(i + 1) % 4];
      q.push(new THREE.Vector3(a[0], a[1], 0), new THREE.Vector3(b[0], b[1], 0));
    }
    const handle = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(q), mat.clone());
    handle.position.set(dot[0], dot[1], 0);
    handle.userData.ringHandle = true;
    g.add(handle);
    g.renderOrder = 999;
    return g;
  }

  /** Where each selected projector's handle sits, in metres down the beam —
   *  the App measures it against what the beam hits, so the ring lands ON
   *  the wall it is lighting. */
  aimDistance = new Map<number, number>();

  private apply(entry: Entry, data: TGLight, scene: GPScene): void {
    const { light, root, helper } = entry;
    root.visible = data.visible;
    root.matrixAutoUpdate = false;
    root.matrix.copy(worldMatrixOf(scene, { kind: 'LIGHT', id: data.id }));

    light.color.setRGB(...data.color);
    light.intensity = data.intensity;
    light.visible = this.lightsEnabled;
    helper.visible = this.helpersVisible;
    if (data.kind === 'POINT') {
      // a point light's REACH: the distance past which it contributes
      // nothing. Drawn as a ring you can pull rather than left as a number,
      // for the same reason as the spot's cone — it is a size in the room.
      if (!entry.cone) { entry.cone = this.makeRing([1, 0]); entry.root.add(entry.cone); }
      const reach = data.distance ?? 0;
      entry.cone.visible = this.helpersVisible && !!data.select && reach > 1e-3;
      entry.cone.position.set(0, 0, 0);
      entry.cone.scale.setScalar(Math.max(1e-3, reach));
      if (this.viewQuat) {
        // face the camera, expressed in the lamp's own space (it may be
        // parented to something turned)
        const inv = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().extractRotation(root.matrix)).invert();
        entry.cone.quaternion.copy(inv.multiply(this.viewQuat));
      }
      entry.cone.traverse((o) => {
        const m = (o as THREE.Line).material as THREE.LineBasicMaterial | undefined;
        if (m?.color) m.color.copy(this.tint);
        if (o.userData.ringHandle) o.scale.setScalar(Math.max(0.06, reach * 0.05) / Math.max(1e-3, reach));
      });
    }
    if (data.kind === 'SPOT') {
      if (!entry.aim) { entry.aim = this.makeAimHandle(); entry.root.add(entry.aim); }
      if (!entry.cone) {
        entry.cone = this.makeRing([1, 0]);        // 3 o'clock
        entry.blend = this.makeRing([0, 1]);       // 12 o'clock
        entry.root.add(entry.cone, entry.blend);
      }
      const d = this.aimDistance.get(data.id) ?? 4;
      entry.aim.visible = this.helpersVisible && !!data.select;
      // the aim target belongs to the gizmo: same colour as the rest of it
      entry.aim.traverse((o) => {
        const m = (o as THREE.Line).material as THREE.LineBasicMaterial | undefined;
        if (m?.color) m.color.copy(this.tint);
      });
      entry.aim.position.set(0, 0, -d);
      // the ring keeps a constant apparent size relative to the throw, so
      // it is grabbable whether the wall is 1 m or 20 m away
      entry.aim.scale.setScalar(Math.max(0.35, d * 0.25));
      const rim = Math.tan(data.angle ?? Math.PI / 6) * d;
      const show = this.helpersVisible && !!data.select;
      for (const [ring, radius] of [
        [entry.cone!, rim],
        [entry.blend!, rim * (1 - (data.penumbra ?? 0.2))],
      ] as const) {
        ring.visible = show && radius > 1e-3;
        ring.position.set(0, 0, -d);
        ring.scale.setScalar(radius);
        ring.traverse((o) => {
          const m = (o as THREE.Line).material as THREE.LineBasicMaterial | undefined;
          if (m?.color) m.color.copy(this.tint);
          // the ring scales with the beam, so the handle square would grow
          // with it — undo that, and it stays the same size to grab
          if (o.userData.ringHandle) o.scale.setScalar(Math.max(0.25, d * 0.05) / Math.max(1e-3, radius));
        });
      }
    }
    if ((data.select || this.hoverId === data.id) && this.selectionColor) this.tint.copy(this.selectionColor);
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
      // WHICH WAY UP THE PICTURE LANDS is decided by the SHADOW CAMERA, not
      // by the light's own rotation. Both paths sample through
      // `light.shadow.matrix` — three's spot map does, and so does the flat
      // projector — and that matrix is built by a lookAt whose roll is
      // resolved against `shadow.camera.up`, which three leaves at world
      // +Y. In a Z-up scene that is sideways, so a projector threw its
      // picture a quarter-turn over: measured, moving UP in the world
      // raised the matrix's u and moving RIGHT lowered its v.
      // Pointing that up at the LAMP's own +Y makes the picture follow the
      // projector's own roll, which is what a real one does — and it is
      // what makes `projection.rotation` and the beam glyph's up arrow
      // agree with what lands on the wall.
      if (light.shadow) {
        light.shadow.camera.up.set(0, 1, 0)
          .applyMatrix4(new THREE.Matrix4().extractRotation(root.matrix)).normalize();
      }
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
      light.visible = this.lightsEnabled;
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
      + `|${proj!.maskSrc ?? ''}|${proj!.maskInvert ? 1 : 0}|${proj!.lens?.type ?? ''}`
      + `|${proj!.corners ? proj!.corners.map((c) => c.map((n) => n.toFixed(4)).join()).join(';') : ''}`
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
    // A CURVED lens is round and flat by derivation, never by editing the
    // record. Writing `aspect: 0, flat: true` into the projection (as the
    // panel used to) cannot be undone when the lens goes back to a pinhole:
    // the picture stayed round and unlit, which reads as "switching back
    // broke it". The stored aspect and flat are the user's; the lens simply
    // overrides how they are USED.
    const curved = isCurved(proj!.lens);
    // The lamp only carries the picture on the LIT path. Under flat — or a
    // curved lens, which has no frustum to throw through — it would
    // otherwise wash the wall with a plain white cone beside the picture the
    // material pass is drawing, which is the "a light's spot appears" bug.
    const flat = curved || !!proj!.flat;
    light.map = flat ? null : p.texture;
    light.visible = this.lightsEnabled && !flat;
    this.shapeBeam(entry, data, curved ? 0 : proj!.aspect ?? 0);
  }

  /** The wire beam, rebuilt only when its shape changes. */
  private shapeBeam(entry: Entry, data: TGLight, aspect: number): void {
    if (entry.kind !== 'SPOT') return;
    const angle = data.angle ?? Math.PI / 6;
    // Which way is UP in the picture, in the beam's own plane. The canvas is
    // painted y-DOWN and a CanvasTexture is uploaded flipped, so v = 1 (the
    // canvas's top row) lands at +y here: the picture's top is +y. The paint
    // rotates the image by `rotation` in canvas coordinates, which takes its
    // top (0, -1) to (sin, -cos) — that is (sin, cos) once the y flip is
    // undone. MIRROR is not part of it: `scale(-1, 1)` negates x only, so a
    // rear-projected picture reads backwards but still stands the same way
    // up, and folding the flip in here pointed the arrow at the floor.
    const proj = data.projection;
    const rot = proj?.rotation ?? 0;
    const up: [number, number] | null = proj?.src ? [Math.sin(rot), Math.cos(rot)] : null;
    const corners = !isCurved(proj?.lens) && proj?.src && proj.corners?.length === 4 ? proj.corners : null;
    const key = `${angle.toFixed(4)}|${aspect}|${up ? `${up[0].toFixed(3)},${up[1].toFixed(3)}` : '-'}`
      + `|${corners ? corners.map((c) => c.map((n) => n.toFixed(3)).join()).join(';') : ''}`;
    if (entry.beamKey === key) return;
    entry.beamKey = key;
    const lines = entry.helper.children.find((c) => c instanceof THREE.LineSegments) as THREE.LineSegments | undefined;
    if (!lines) return;
    lines.geometry.dispose();
    lines.geometry = beamLines(angle, aspect, 0.9, up, corners);
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
/**
 * KEYSTONE. Draw `picture` into an arbitrary QUAD (canvas pixels, in the
 * corner order TL, TR, BR, BL) instead of a rectangle.
 *
 * Canvas 2D has no projective transform — `setTransform` is affine, and an
 * affine map cannot turn a rectangle into a trapezium. So the image is
 * subdivided and each cell drawn affinely through the true homography's
 * corner points: the mapping is exact AT every grid vertex and the error in
 * between falls off with the cell size. A bilinear blend of the four
 * corners (the obvious cheap version) is NOT the same mapping — it bends
 * straight lines, and the whole point of keystone is that the edges of the
 * picture land straight on the edges of the thing you are projecting at.
 *
 * The grid is 16x16: at 1024px that is 64px cells, where the residual is
 * well under a pixel even at extreme corner pulls.
 */
function drawQuad(
  g: CanvasRenderingContext2D, picture: CanvasImageSource,
  quad: [number, number][], src: { x: number; y: number; w: number; h: number },
  toSource: (u: number, v: number) => [number, number],
  N = 16,
): void {
  // the unit square -> quad homography, as a 3x3 acting on (u, v, 1)
  const [p0, p1, p2, p3] = quad;             // TL, TR, BR, BL
  const dx1 = p1[0] - p2[0], dy1 = p1[1] - p2[1];
  const dx2 = p3[0] - p2[0], dy2 = p3[1] - p2[1];
  const sx = p0[0] - p1[0] + p2[0] - p3[0];
  const sy = p0[1] - p1[1] + p2[1] - p3[1];
  let g0: number, g1: number;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) { g0 = 0; g1 = 0; } else {
    g0 = (sx * dy2 - dx2 * sy) / den;
    g1 = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1[0] - p0[0] + g0 * p1[0], b = p3[0] - p0[0] + g1 * p3[0], c = p0[0];
  const d = p1[1] - p0[1] + g0 * p1[1], e = p3[1] - p0[1] + g1 * p3[1], f = p0[1];
  const at = (u: number, v: number): [number, number] => {
    const w = g0 * u + g1 * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
  // one triangle at a time: an affine map is determined by three points,
  // and three points of the homography are exact
  const tri = (
    s0: [number, number], s1: [number, number], s2: [number, number],
    d0: [number, number], d1: [number, number], d2: [number, number],
  ): void => {
    const denom = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (Math.abs(denom) < 1e-9) return;
    const m11 = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / denom;
    const m12 = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / denom;
    const m21 = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / denom;
    const m22 = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / denom;
    g.save();
    g.beginPath();
    g.moveTo(d0[0], d0[1]); g.lineTo(d1[0], d1[1]); g.lineTo(d2[0], d2[1]);
    g.closePath();
    // the seams between cells are hairline gaps without this: each triangle
    // is clipped to itself, and adjacent clips do not quite meet
    g.clip();
    g.transform(m11, m12, m21, m22,
      d0[0] - m11 * s0[0] - m21 * s0[1], d0[1] - m12 * s0[0] - m22 * s0[1]);
    g.drawImage(picture, 0, 0, src.w, src.h, src.x, src.y, src.w, src.h);
    g.restore();
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N;
      // a hair of overlap, so neighbouring cells cannot leave a seam
      const D = (u: number, v: number): [number, number] => {
        const eu = u === u1 ? Math.min(1, u + 0.35 / N) : u;
        const ev = v === v1 ? Math.min(1, v + 0.35 / N) : v;
        return at(eu, ev);
      };
      const s00 = toSource(u0, v0), s10 = toSource(u1, v0);
      const s11 = toSource(u1, v1), s01 = toSource(u0, v1);
      const d00 = D(u0, v0), d10 = D(u1, v0), d11 = D(u1, v1), d01 = D(u0, v1);
      tri(s00, s10, s11, d00, d10, d11);
      tri(s00, s11, s01, d00, d11, d01);
    }
  }
}

/** The four corners of the picture in the beam's square, as (u, v) with
 *  v UP — the default rectangle `aspect` describes, in the order this file
 *  and `TGProjection.corners` use: TL, TR, BR, BL. */
export function defaultCorners(aspect: number): [number, number][] {
  const hw = (aspect ? aspect / Math.hypot(1, aspect) : 1) / 2;
  const hh = (aspect ? 1 / Math.hypot(1, aspect) : 1) / 2;
  return [
    [0.5 - hw, 0.5 + hh], [0.5 + hw, 0.5 + hh],
    [0.5 + hw, 0.5 - hh], [0.5 - hw, 0.5 - hh],
  ];
}

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
  // a curved lens fills the circle: a fisheye image laid into a 16:9
  // rectangle would be thrown as a rectangle with black bars round it
  const aspect = !isCurved(proj.lens) && proj.aspect && proj.aspect > 0 ? proj.aspect : 0;
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
  const corners = proj.corners && proj.corners.length === 4 ? proj.corners : null;
  if (corners) {
    // KEYSTONE: the picture goes into the corner quad instead of the
    // rectangle. Still inside the same transform, so Rotate and Mirror
    // compose with it, and inside the same clip, so the mask and the edge
    // blend below act on exactly what was drawn.
    const quad = corners.map(([u, v]) =>
      // uv has v UP; the canvas has y DOWN, and this transform has already
      // moved the origin to the middle
      [u * S - S / 2, (1 - v) * S - S / 2] as [number, number]);
    // CONTAIN letterboxes inside the quad, COVER fills it — the same choice
    // the rectangle offers, but expressed in the SOURCE, since the
    // destination is no longer a rectangle to letterbox inside of. The
    // sampled source rect grows past the image for CONTAIN (what falls
    // outside it simply draws nothing, which is the letterbox) and shrinks
    // inside it for COVER (which is the crop).
    const qa = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1])
      / Math.max(1e-6, Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]));
    const sa = sw / sh;
    const wide = sa > qa;                       // the picture is wider than the quad
    const contain = proj.fit !== 'COVER';
    const ew = sw * (contain ? (wide ? 1 : qa / sa) : (wide ? qa / sa : 1));
    const eh = sh * (contain ? (wide ? sa / qa : 1) : (wide ? 1 : sa / qa));
    drawQuad(g, picture, quad, { x: 0, y: 0, w: sw, h: sh },
      (u, v) => [sw / 2 + (u - 0.5) * ew, sh / 2 + (v - 0.5) * eh]);
  } else {
    g.drawImage(picture, -dw / 2, -dh / 2, dw, dh);
  }
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
