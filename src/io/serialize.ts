import type { GPObject, GPScene } from '../core/types';
import { bumpIdCounter, createDefaultCamera, genId } from '../core/gpdata';
import { defaultStyle } from '../core/brushes';
import { sanitizePolyMesh } from '../core/polymesh';

const FORMAT = 'threegrease-scene';
const VERSION = 3; // v3: MediaMime rigs + trigger select/parent (P11)

export function serializeScene(scene: GPScene): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, scene }, null, 0);
}

export function deserializeScene(json: string): GPScene {
  const data = JSON.parse(json);
  if (data?.format !== FORMAT) throw new Error('Not a threegrease scene file');
  const scene = data.scene as GPScene;
  scene.canvases ??= []; // older saves predate canvas planes
  for (const c of scene.canvases) {
    c.select ??= false;
    c.drawTarget ??= true;
  }
  // migrate single-camera saves to the camera list
  const legacy = (scene as unknown as { camera?: import('../core/types').GPCamera }).camera;
  scene.cameras ??= legacy ? [{ ...createDefaultCamera(), ...legacy, name: 'Camera 1' }] : [createDefaultCamera()];
  scene.activeCamera ??= 0;
  scene.io ??= { wsUrl: '', midiInId: null, midiOutId: null };
  scene.score ??= { cursors: [], triggers: [], attachments: [] };
  scene.routes ??= [];
  scene.attractors ??= [];
  scene.mediamime ??= { prefix: '/mm', rigs: [] };
  scene.mmStreams ??= [];
  for (const st of scene.mmStreams) {
    st.mirror ??= true;
    st.emitBus ??= true;
    st.confidenceAlpha ??= true;
    st.confidenceSize ??= false;
    st.depthScale ??= st.kind === 'POSE' ? 0 : 1;
    st.select ??= false;
    st.lock ??= false;
    st.parent ??= null;
    st.constraints ??= [];
    st.probeEvents ??= st.kind !== 'FACE';
    st.pen ??= { active: false, landmarks: [0], minConf: 0.5 };
    const legacyPen = st.pen as unknown as { landmark?: number; landmarks?: number[] };
    if (!legacyPen.landmarks) legacyPen.landmarks = legacyPen.landmark !== undefined ? [legacyPen.landmark] : [0];
    delete legacyPen.landmark;
  }
  scene.clips ??= [];
  for (const c of scene.clips) {
    c.trimStart ??= 0;
    c.trimEnd ??= 1;
  }
  for (const trig of scene.score.triggers) {
    trig.select ??= false;
    trig.hide ??= false;
    trig.lock ??= false;
    trig.parent ??= null;
    trig.constraints ??= [];
  }
  scene.splats ??= [];
  // object-URL sources don't survive reload
  scene.splats = scene.splats.filter((s) => !s.src.startsWith('blob:'));
  for (const s of scene.splats) { s.select ??= false; s.lock ??= false; s.drawTarget ??= false; s.constraints ??= []; }
  // editable generalized meshes (TGPolyMesh): default the collection, then
  // repair rather than reject — broken element references degrade to less
  // topology, never to a failed load
  scene.polyMeshes ??= [];
  for (const pm of scene.polyMeshes) {
    pm.select ??= false;
    pm.lock ??= false;
    pm.parent ??= null;
    pm.constraints ??= [];
    pm.rev ??= 0;
    pm.unlit ??= false;
    pm.doubleSided ??= true;
    pm.texture ??= null;
    if (pm.texture?.startsWith('blob:')) pm.texture = null; // session-only
    for (const v of pm.vertices ?? []) v.binding ??= null;
    sanitizePolyMesh(pm);
  }
  // painted splat clouds: default + drop malformed point arrays
  scene.paintClouds ??= [];
  for (const pc of scene.paintClouds) {
    pc.select ??= false;
    pc.lock ??= false;
    pc.parent ??= null;
    pc.constraints ??= [];
    pc.rev ??= 0;
    if (!Array.isArray(pc.points) || pc.points.length % 8 !== 0
      || pc.points.some((v) => !Number.isFinite(v))) pc.points = [];
  }
  scene.meshes ??= [];
  scene.meshes = scene.meshes.filter((m) => !(m.src ?? '').startsWith('blob:'));
  for (const m of scene.meshes) {
    m.select ??= false;
    m.lock ??= false;
    m.constraints ??= [];
    m.texture ??= null;
    if (m.texture?.startsWith('blob:')) m.texture = null; // session-only
    m.unlit ??= false;
    m.doubleSided ??= true;
    m.billboard ??= 'NONE';
    m.originOffset ??= [0, 0, 0];
  }
  // canvases are retired: migrate them to PLANE mesh objects (same ids, so
  // parent refs survive; attachments/routes rewritten below)
  for (const c of scene.canvases) {
    scene.meshes.push({
      id: c.id, name: c.name, kind: 'PLANE',
      translation: [...c.translation], rotation: [...c.rotation],
      scale: [c.size[0] / 2, c.size[1] / 2, 1],   // PLANE geometry is 2x2
      visible: c.visible, select: false,
      drawTarget: c.drawTarget, wireframe: false,
      color: [0.62, 0.65, 0.72], opacity: 0.25,
      parent: c.parent ?? null,
      texture: null, unlit: true, doubleSided: true, billboard: 'NONE',
    });
  }
  if (scene.canvases.length) {
    for (const at of scene.score?.attachments ?? []) {
      if (at.target.kind === 'CANVAS') at.target = { kind: 'MESH', id: at.target.id };
    }
    for (const r of scene.routes ?? []) {
      r.target = r.target.replace(/^canvas\./, 'mesh.');
    }
  }
  scene.canvases = [];
  for (const ob of scene.objects) {
    ob.select ??= false;
    ob.hide ??= false;
    ob.lock ??= false;
    ob.constraints ??= [];
    ob.id ??= genId();
  }
  // v1 -> v2: strokes gain baked style
  for (const ob of scene.objects) {
    for (const layer of ob.layers) {
      for (const f of layer.frames) {
        for (const s of f.strokes) s.style ??= defaultStyle();
      }
    }
  }
  bumpIdCounter(scene);
  return scene;
}

// ---- GP-object-level interchange ------------------------------------------

export function serializeGPObject(ob: GPObject): string {
  return JSON.stringify({ format: 'threegrease-gpobject', version: VERSION, object: ob });
}

/** Fresh ids for an appended GP object (layers, strokes, mask refs, mods). */
export function remapGPObjectIds(ob: GPObject): GPObject {
  const layerIdMap = new Map<number, number>();
  for (const layer of ob.layers) {
    const newId = genId();
    layerIdMap.set(layer.id, newId);
    layer.id = newId;
    for (const f of layer.frames) {
      for (const s of f.strokes) {
        s.id = genId();
        s.style ??= defaultStyle();
      }
    }
  }
  for (const layer of ob.layers) {
    layer.maskLayerIds = layer.maskLayerIds
      .map((id) => layerIdMap.get(id))
      .filter((id): id is number => id !== undefined);
  }
  ob.activeLayerId = layerIdMap.get(ob.activeLayerId) ?? ob.layers[0]?.id ?? 0;
  ob.id = genId();
  ob.parent = null;
  for (const mod of ob.modifiers) {
    mod.id = genId();
    mod.layerFilter = mod.layerFilter === null
      ? null : (layerIdMap.get(mod.layerFilter) ?? null);
  }
  for (const fx of ob.effects) fx.id = genId();
  ob.select = false;
  return ob;
}

/**
 * Append GP object(s) from a gpobject or full scene file into `scene`.
 * Returns the number of objects added.
 */
export function importGPObjects(scene: GPScene, json: string): number {
  const data = JSON.parse(json);
  let objects: GPObject[] = [];
  if (data?.format === 'threegrease-gpobject' && data.object) objects = [data.object];
  else if (data?.format === FORMAT && data.scene?.objects) objects = data.scene.objects;
  else throw new Error('Not a threegrease GP or scene file');
  bumpIdCounter(scene);
  for (const ob of objects) {
    for (const layer of ob.layers ?? []) {
      for (const f of layer.frames ?? []) {
        for (const s of f.strokes ?? []) s.style ??= defaultStyle();
      }
    }
    scene.objects.push(remapGPObjectIds(ob));
  }
  return objects.length;
}

export function downloadText(text: string, filename: string, type = 'application/json'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadScene(scene: GPScene, filename = 'scene.threegrease.json'): void {
  const blob = new Blob([serializeScene(scene)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function openSceneFile(): Promise<GPScene> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));
      try { resolve(deserializeScene(await file.text())); }
      catch (e) { reject(e); }
    };
    input.click();
  });
}
