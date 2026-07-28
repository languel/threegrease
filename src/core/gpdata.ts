import type {
  GPCamera, GPFrame, GPLayer, GPMaterial, GPObject, GPPoint, GPScene, GPStroke,
  TGImage, TGLight, TGMaterial, Vec3, Vec4,
} from './types';
import { defaultStyle } from './brushes';

let nextId = 1;
export function genId(): number { return nextId++; }
export function bumpIdCounter(scene: GPScene): void {
  // keep id generator ahead of any loaded ids
  let max = 0;
  for (const ob of scene.objects) {
    max = Math.max(max, ob.id);
    for (const l of ob.layers) {
      max = Math.max(max, l.id);
      for (const f of l.frames) for (const s of f.strokes) max = Math.max(max, s.id);
    }
    for (const m of ob.modifiers) max = Math.max(max, m.id);
    for (const e of ob.effects) max = Math.max(max, e.id);
  }
  // every other id-bearing collection, so genId() can't collide with a
  // loaded scene's ids (this used to scan GP objects only)
  for (const i of scene.images ?? []) max = Math.max(max, i.id);
  for (const m of scene.materials ?? []) max = Math.max(max, m.id);
  for (const l of scene.lights ?? []) max = Math.max(max, l.id);
  for (const m of scene.meshes ?? []) max = Math.max(max, m.id);
  for (const p of scene.polyMeshes ?? []) max = Math.max(max, p.id);
  for (const s of scene.splats ?? []) max = Math.max(max, s.id);
  for (const c of scene.paintClouds ?? []) max = Math.max(max, c.id);
  for (const st of scene.mmStreams ?? []) max = Math.max(max, st.id);
  nextId = Math.max(nextId, max + 1);
}

// ---- material / image datablocks -----------------------------------------

export function createImage(name: string, src: string, baked = false): TGImage {
  return { id: genId(), name, src, baked };
}

export function createLight(kind: TGLight['kind'], name?: string, at: Vec3 = [3, -4, 6]): TGLight {
  return {
    id: genId(),
    name: name ?? kind.charAt(0) + kind.slice(1).toLowerCase(),
    kind,
    color: [1, 1, 1],
    intensity: kind === 'AMBIENT' ? 0.9 : kind === 'SUN' ? 1.4 : 20,
    translation: [...at] as Vec3,
    rotation: [0, 0, 0],
    distance: 0,
    decay: 2,
    angle: Math.PI / 6,
    penumbra: 0.2,
    // shadows are off by default: they cost a depth pass per light, and
    // the two migrated defaults must reproduce today's shadowless look
    castShadow: false,
    shadowBias: -0.0005,
    shadowRadius: 2,
    shadowMapSize: 1024,
    visible: true,
    select: false,
    lock: false,
    parent: null,
    constraints: [],
  };
}

/** The two lights that used to be hardcoded in the App constructor.
 *  Reproduces the previous look exactly so migrating changes nothing. */
export function defaultLights(): TGLight[] {
  const amb = createLight('AMBIENT', 'Ambient');
  amb.intensity = 0.9;
  const sun = createLight('SUN', 'Sun', [3, -4, 6]);
  sun.intensity = 1.4;
  return [amb, sun];
}

/** A material datablock. Named `createMaterialDB` because `createMaterial`
 *  is the (unrelated, index-addressed) GP stroke material factory above. */
export function createMaterialDB(name: string, baseColor: Vec3 = [0.62, 0.65, 0.72]): TGMaterial {
  return {
    id: genId(), name,
    baseColor: [...baseColor] as Vec3,
    opacity: 1, roughness: 0.9, metallic: 0,
    emission: [0, 0, 0], emissionStrength: 0,
    unlit: false, doubleSided: true, wireframe: false,
    blend: 'OPAQUE', slots: {},
  };
}

export function materialById(scene: GPScene, id: number | null | undefined): TGMaterial | undefined {
  return id == null ? undefined : scene.materials.find((m) => m.id === id);
}

export function imageById(scene: GPScene, id: number | null | undefined): TGImage | undefined {
  return id == null ? undefined : scene.images.find((i) => i.id === id);
}

/** The per-object appearance fields TGMesh and TGPolyMesh share — enough to
 *  resolve or mint a material datablock without knowing which kind it is. */
export interface MaterialTarget {
  materialId?: number | null;
  name: string;
  color: Vec3;
  opacity: number;
  texture?: string | null;
  unlit?: boolean;
  doubleSided?: boolean;
  wireframe: boolean;
}

/** Copy-on-write: mint a material datablock from an object's legacy
 *  flattened fields the first time anything needs one, so pre-datablock
 *  objects keep rendering untouched until they're actually edited. */
export function ensureMaterial(scene: GPScene, target: MaterialTarget): TGMaterial {
  const existing = materialById(scene, target.materialId);
  if (existing) return existing;
  const mat = createMaterialDB(target.name, target.color);
  mat.opacity = target.opacity;
  mat.unlit = !!target.unlit;
  mat.doubleSided = target.doubleSided !== false;
  mat.wireframe = target.wireframe;
  if (target.texture) {
    const img = createImage(`${target.name} texture`, target.texture);
    scene.images.push(img);
    mat.slots.base = {
      imageId: img.id, offset: [0, 0], scale: [1, 1], rotation: 0, factor: 1, enabled: true,
    };
  }
  scene.materials.push(mat);
  target.materialId = mat.id;
  return mat;
}

/** Current base-color image src for an object, whichever era it's from —
 *  the material's base slot, else the legacy per-object texture field.
 *  Texture painting seeds its canvas from this. */
export function baseTextureSrc(scene: GPScene, target: MaterialTarget): string | null {
  const mat = materialById(scene, target.materialId);
  if (!mat) return target.texture ?? null;
  const slot = mat.slots.base;
  if (!slot) return null;
  return imageById(scene, slot.imageId)?.src ?? null;
}

/** Write a dataURL into an object's base-color slot, reusing the slot's
 *  existing image datablock when there is one (so repeated texture-paint
 *  strokes update one image rather than piling up new ones). Used by
 *  texture painting and by bake output. */
export function setBaseTexture(scene: GPScene, target: MaterialTarget, src: string, baked = false): TGImage {
  const mat = ensureMaterial(scene, target);
  const slot = mat.slots.base;
  const existing = slot ? imageById(scene, slot.imageId) : undefined;
  if (existing) {
    existing.src = src;
    existing.baked = baked;
    if (slot) slot.enabled = true;
    return existing;
  }
  const img = createImage(`${target.name} texture`, src, baked);
  scene.images.push(img);
  mat.slots.base = {
    imageId: img.id, offset: [0, 0], scale: [1, 1], rotation: 0, factor: 1, enabled: true,
  };
  // keep the legacy field in sync so exporters/older paths still see it
  target.texture = src;
  return img;
}

export function createPoint(co: Vec3, pressure = 1, strength = 1): GPPoint {
  return { co: [...co] as Vec3, pressure, strength, vertexColor: [0, 0, 0, 0], select: false, weight: 1 };
}

export function createStroke(materialIndex: number, lineWidth: number): GPStroke {
  return {
    id: genId(), points: [], cyclic: false, materialIndex, lineWidth,
    hardness: 1, fillVertexColor: [0, 0, 0, 0], select: false,
    style: defaultStyle(),
  };
}

export function createFrame(frameNumber: number): GPFrame {
  return { frameNumber, keyframeType: 'KEYFRAME', strokes: [], select: false };
}

export function createLayer(name: string): GPLayer {
  return {
    id: genId(), name, frames: [], opacity: 1, hide: false, lock: false,
    useOnion: true, blendMode: 'REGULAR', tint: [0, 0, 0, 0], thicknessOffset: 0,
    translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    useMask: false, maskLayerIds: [],
  };
}

export function createMaterial(name: string, stroke: Vec4, fill?: Vec4): GPMaterial {
  return {
    name, showStroke: true, strokeColor: stroke, lineMode: 'LINE',
    showFill: !!fill, fillColor: fill ?? [0.5, 0.5, 0.5, 1],
    fillStyle: 'SOLID', fillColor2: [1, 1, 1, 1], gradientAngle: 0, holdout: false,
    strokeShade: 'SOLID', strokeColor2: [...stroke] as Vec4,
    strokeImageId: null, strokeUvFactor: 1, strokeTexBlend: 0,
    fillImageId: null, fillUvFactor: 1, fillTexBlend: 0,
  };
}

export function createObject(name: string): GPObject {
  const layer = createLayer('Lines');
  return {
    id: genId(),
    name, layers: [layer], activeLayerId: layer.id,
    materials: [
      createMaterial('Stroke Black', [0.05, 0.05, 0.05, 1]),
      createMaterial('Stroke Red', [0.85, 0.12, 0.09, 1]),
      createMaterial('Fill White', [0.05, 0.05, 0.05, 1], [0.95, 0.95, 0.95, 1]),
      createMaterial('Stroke White', [0.95, 0.95, 0.95, 1]),
      createMaterial('Stroke Blue', [0.13, 0.35, 0.85, 1]),
    ],
    activeMaterial: 0, modifiers: [], effects: [],
    translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    onion: {
      enabled: false, mode: 'KEYFRAMES', before: 1, after: 1,
      colorBefore: [0.145, 0.815, 0.137], colorAfter: [0.125, 0.349, 0.867], opacity: 0.5,
    },
  };
}

export function createDefaultCamera(name = 'Camera 1'): GPCamera {
  // Z-up (Blender-style) home: behind -Y looking at the origin, up +Z.
  // rotation.x = PI/2 - atan2(height, distance)
  return { name, translation: [0, -6, 2], rotation: [1.249, 0, 0], fov: 50, keys: [] };
}

export function activeCam(scene: GPScene): GPCamera {
  return scene.cameras[scene.activeCamera] ?? scene.cameras[0];
}

export function createScene(): GPScene {
  return {
    objects: [createObject('Pencil1')], activeObject: 0,
    frame: 1, frameStart: 1, frameEnd: 250, fps: 24, cursor: [0, 0, 0],
    canvases: [],
    cameras: [createDefaultCamera()],
    activeCamera: 0,
    io: { wsUrl: '', midiInId: null, midiOutId: null },
    score: { cursors: [], triggers: [], attachments: [] },
    routes: [],
    attractors: [],
    lights: defaultLights(),
    images: [],
    materials: [],
    splats: [],
    meshes: [],
    polyMeshes: [],
    paintClouds: [],
    mediamime: { prefix: '/mp', rigs: [] },
    mmStreams: [],
    clips: [],
  };
}

// ---- lookups -------------------------------------------------------------

export function activeObject(scene: GPScene): GPObject {
  return scene.objects[scene.activeObject];
}
export function activeLayer(ob: GPObject): GPLayer | undefined {
  return ob.layers.find((l) => l.id === ob.activeLayerId);
}

/** Keyframe shown at `frame`: the last keyframe with frameNumber <= frame. */
export function frameAt(layer: GPLayer, frame: number): GPFrame | undefined {
  let best: GPFrame | undefined;
  for (const f of layer.frames) {
    if (f.frameNumber <= frame && (!best || f.frameNumber > best.frameNumber)) best = f;
  }
  return best;
}

export function keyframeIndexAt(layer: GPLayer, frame: number): number {
  let best = -1;
  layer.frames.forEach((f, i) => {
    if (f.frameNumber <= frame && (best < 0 || f.frameNumber > layer.frames[best].frameNumber)) best = i;
  });
  return best;
}

/** Get or create the keyframe to draw into at `frame` (auto-key: new key at current frame). */
export function ensureFrame(layer: GPLayer, frame: number, autoKey: boolean): GPFrame {
  const exact = layer.frames.find((f) => f.frameNumber === frame);
  if (exact) return exact;
  const prev = frameAt(layer, frame);
  if (prev && !autoKey) return prev;
  const nf = createFrame(frame);
  if (prev && autoKey) nf.strokes = prev.strokes.map(cloneStroke); // duplicate current drawing? Blender starts empty
  nf.strokes = []; // Blender: new keyframe starts empty (additive drawing on new key)
  layer.frames.push(nf);
  layer.frames.sort((a, b) => a.frameNumber - b.frameNumber);
  return nf;
}

// ---- cloning ---------------------------------------------------------------

export function clonePoint(p: GPPoint): GPPoint {
  // NB: this enumerates fields explicitly, so anything added to GPPoint must
  // be added HERE too. The modifier stack clones every stroke before the
  // renderer sees it, so a field missed here is a field that silently never
  // reaches geometry (`density` did exactly that).
  return {
    co: [...p.co] as Vec3, pressure: p.pressure, strength: p.strength,
    vertexColor: [...p.vertexColor] as Vec4, select: p.select, weight: p.weight,
    density: p.density,
  };
}
export function cloneStroke(s: GPStroke): GPStroke {
  return {
    ...s, id: genId(), points: s.points.map(clonePoint),
    fillVertexColor: [...s.fillVertexColor] as Vec4,
    style: { ...(s.style ?? defaultStyle()) },
  };
}
export function cloneFrame(f: GPFrame): GPFrame {
  return { ...f, strokes: f.strokes.map(cloneStroke) };
}

// ---- iteration helpers -----------------------------------------------------

export function visibleEditableLayers(ob: GPObject): GPLayer[] {
  return ob.layers.filter((l) => !l.hide && !l.lock);
}

export function forEachSelectedStroke(
  ob: GPObject, frame: number, cb: (stroke: GPStroke, layer: GPLayer, frameData: GPFrame) => void,
): void {
  for (const layer of visibleEditableLayers(ob)) {
    const f = frameAt(layer, frame);
    if (!f) continue;
    for (const s of [...f.strokes]) if (s.select || s.points.some((p) => p.select)) cb(s, layer, f);
  }
}
