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
import type { GPScene, TGLight } from '../core/types';
import { worldMatrixOf } from '../tools/objects';

type AnyLight = THREE.AmbientLight | THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight;

interface Entry {
  root: THREE.Group;
  light: AnyLight;
  helper: THREE.Object3D;
  kind: TGLight['kind'];
  shadowMapSize: number;
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
    helper.traverse((o) => {
      const m = (o as THREE.Line).material as THREE.LineBasicMaterial | undefined;
      if (m?.color) m.color.setRGB(...data.color);
    });

    if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
      light.distance = data.distance ?? 0;
      light.decay = data.decay ?? 2;
    }
    if (light instanceof THREE.SpotLight) {
      light.angle = data.angle ?? Math.PI / 6;
      light.penumbra = data.penumbra ?? 0.2;
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
