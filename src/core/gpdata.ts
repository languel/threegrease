import type {
  GPCamera, GPFrame, GPLayer, GPMaterial, GPObject, GPPoint, GPScene, GPStroke, Vec3, Vec4,
} from './types';
import { defaultStyle } from './brushes';

let nextId = 1;
export function genId(): number { return nextId++; }
export function bumpIdCounter(scene: GPScene): void {
  // keep id generator ahead of any loaded ids
  let max = 0;
  for (const ob of scene.objects) {
    for (const l of ob.layers) {
      max = Math.max(max, l.id);
      for (const f of l.frames) for (const s of f.strokes) max = Math.max(max, s.id);
    }
    for (const m of ob.modifiers) max = Math.max(max, m.id);
    for (const e of ob.effects) max = Math.max(max, e.id);
  }
  nextId = Math.max(nextId, max + 1);
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
  };
}

export function createObject(name: string): GPObject {
  const layer = createLayer('Lines');
  return {
    id: genId(),
    name, layers: [layer], activeLayerId: layer.id,
    materials: [
      createMaterial('Black', [0.05, 0.05, 0.05, 1]),
      createMaterial('Red', [0.85, 0.12, 0.09, 1]),
      createMaterial('Fill White', [0.05, 0.05, 0.05, 1], [0.95, 0.95, 0.95, 1]),
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
    splats: [],
    meshes: [],
    mediamime: { prefix: '/mm', rigs: [] },
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
  return { co: [...p.co] as Vec3, pressure: p.pressure, strength: p.strength, vertexColor: [...p.vertexColor] as Vec4, select: p.select, weight: p.weight };
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
