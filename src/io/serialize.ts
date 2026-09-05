import type { GPObject, GPScene, TGMaterial, Vec3 } from '../core/types';
import { defaultGait } from '../actor/gait';
import { defaultLayers } from '../actor/mixer';
import { defaultSteer } from '../actor/steering';
import { rebuildLimbRules } from '../actor/skeleton';
import { bumpIdCounter, createDefaultCamera, createImage, createMaterialDB, createWorld, defaultLights, genId } from '../core/gpdata';
import { defaultStyle } from '../core/brushes';
import { sanitizePolyMesh } from '../core/polymesh';

const FORMAT = 'threegrease-scene';
const VERSION = 3; // v3: MediaMime rigs + trigger select/parent (P11)

export function serializeScene(scene: GPScene): string {
  // A blob: URL is a handle into THIS tab's memory — saving one produces a
  // scene that silently fails to load its environment video on any other
  // machine, or even in the same browser tomorrow. Drop it and let the
  // world fall back; a real http(s) URL is saved as given.
  const world = scene.world?.videoUrl?.startsWith('blob:')
    ? { ...scene.world, videoUrl: '' } : scene.world;
  // detectHits is the last inference's output, not document state — saving
  // it would restore a scene claiming to have seen things it hasn't
  const mmStreams = scene.mmStreams?.some((s) => s.detectHits)
    ? scene.mmStreams.map((s) => (s.detectHits ? { ...s, detectHits: undefined } : s))
    : scene.mmStreams;
  return JSON.stringify(
    { format: FORMAT, version: VERSION, scene: { ...scene, world, mmStreams } }, null, 0);
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
    if (st.kind === 'DETECT') {
      st.detect ??= {
        model: 'Xenova/owlvit-base-patch32', queries: [], threshold: 0.12,
        maxResults: 8, intervalMs: 600, webgpu: true,
      };
      // hits are this frame's inference output, never document state
      delete st.detectHits;
    }
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
  // shared material/image datablocks (pre-datablock saves get theirs
  // synthesized from the per-object flattened fields — see migrateMaterials
  // below, which runs after meshes/polyMeshes are defaulted)
  scene.images ??= [];
  // actors postdate most saves; an empty list is the correct migration
  scene.actors ??= [];
  scene.measures ??= [];
  for (const m of scene.measures) {
    m.visible ??= true;
    m.points ??= [];
  }
  for (const a of scene.actors) {
    a.select ??= false;
    a.lock ??= false;
    a.visible ??= true;
    a.parent ??= null;
    a.constraints ??= [];
    a.limits ??= [];
    a.shape ??= 'BOTH';
    a.look ??= 'DEFAULT';
    a.gait ??= defaultGait();
    a.layers ??= defaultLayers();
    a.steer ??= defaultSteer();
    a.physics.hinges ??= true;
    // A limit with no pole predates hinges — and those limits also named
    // the wrong bones (they constrained the hip and the shoulder, never the
    // knee or the elbow), so they are rebuilt rather than patched.
    if (!a.limits?.length || a.limits.some((l) => !l.pole)
      || !a.bones.some((b) => b.trackRest)) rebuildLimbRules(a);
    // a pose shorter than the joint list means the skeleton changed under
    // an old save — fill from rest rather than leaving holes the solver
    // would read as NaN
    a.pose ??= [];
    for (let i = 0; i < a.joints.length; i++) {
      a.pose[i] ??= [...a.joints[i].rest];
    }
    a.pose.length = a.joints.length;
  }
  scene.materials ??= [];
  // pre-world saves had a flat background colour and no IBL; seed a SOLID
  // world carrying that same colour so an old scene renders identically
  scene.world ??= { ...createWorld(), color: [0.11, 0.11, 0.12] };
  // forward-compat: a world saved before a field existed
  const w = scene.world;
  w.mode ??= 'SOLID';
  w.skyColor ??= [0.32, 0.42, 0.58];
  w.groundColor ??= [0.15, 0.13, 0.12];
  w.imageId ??= null;
  w.videoSource ??= 'CAMERA';
  w.videoUrl ??= '';
  w.sunElevation ??= 25; w.sunAzimuth ??= 180; w.turbidity ??= 2; w.rayleigh ??= 1;
  w.rotation ??= 0; w.strength ??= 1;
  w.backgroundVisible ??= true; w.backgroundIntensity ??= 1; w.blur ??= 0;
  w.lighting ??= false;
  // pre-datablock saves had lighting hardcoded in the App constructor;
  // seed the same two lights so an old scene looks identical
  scene.lights ??= defaultLights();
  for (const l of scene.lights) {
    l.select ??= false;
    l.lock ??= false;
    l.visible ??= true;
    l.parent ??= null;
    l.constraints ??= [];
    l.castShadow ??= false;
  }
  scene.images = scene.images.filter((i) => !i.src.startsWith('blob:')); // session-only
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
    // persisted UVs must stay parallel to the face boundary; a truncated
    // or malformed array degrades to the auto-projection rather than
    // rendering garbage (same repair-don't-reject rule as the topology)
    for (const f of pm.faces ?? []) {
      if (!f.uv) continue;
      const ok = Array.isArray(f.uv) && f.uv.length === f.vertices.length
        && f.uv.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      if (!ok) delete f.uv;
    }
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
        for (const s of f.strokes) {
          s.style ??= defaultStyle();
          // strokes saved before per-stroke variation existed: no signal, no
          // taper, so they rebuild as the uniform ribbons they were. Points
          // keep `density` undefined, which varyFactors reads as fully dense.
          s.style.varyMode ??= 'NONE';
          s.style.varyRadius ??= 0;
          s.style.varyStrength ??= 0;
          s.style.varyScale ??= 4;
          s.style.taperIn ??= 0;
          s.style.taperOut ??= 0;
        }
      }
    }
    // NPR stroke shading: every field defaults to the plain solid ribbon
    // these materials already drew, so an old scene is pixel-identical
    for (const m of ob.materials) {
      m.strokeShade ??= 'SOLID';
      m.strokeColor2 ??= [...m.strokeColor];
      m.strokeImageId ??= null;
      m.strokeUvFactor ??= 1;
      m.strokeTexBlend ??= 0;
      m.fillImageId ??= null;
      m.fillUvFactor ??= 1;
      m.fillTexBlend ??= 0;
    }
  }
  bumpIdCounter(scene); // ids must be safe before migrateMaterials mints any
  migrateMaterials(scene);
  return scene;
}

/**
 * Pre-datablock saves carried appearance as flattened per-object fields
 * (`color/opacity/texture/unlit/doubleSided/wireframe`). Synthesize a shared
 * TGMaterial for each mesh-family object that has no `materialId` yet,
 * reproducing its look EXACTLY so loading an old scene changes nothing.
 *
 * Objects whose look is identical share one material (and identical texture
 * dataURLs collapse to one image), which is the point of the datablock: a
 * scene of 20 same-colored planes ends up with one material, not twenty.
 */
function migrateMaterials(scene: GPScene): void {
  const imageBySrc = new Map<string, number>();
  for (const img of scene.images) imageBySrc.set(img.src, img.id);
  const materialByKey = new Map<string, number>();
  for (const m of scene.materials) materialByKey.set(materialKey(m), m.id);

  const imageFor = (src: string): number => {
    const hit = imageBySrc.get(src);
    if (hit !== undefined) return hit;
    const img = createImage(`Image ${scene.images.length + 1}`, src);
    scene.images.push(img);
    imageBySrc.set(src, img.id);
    return img.id;
  };

  const materialFor = (look: {
    color: Vec3; opacity: number; texture?: string | null;
    unlit?: boolean; doubleSided?: boolean; wireframe: boolean; name: string;
  }): number => {
    const mat = createMaterialDB(look.name, look.color);
    mat.opacity = look.opacity;
    mat.unlit = !!look.unlit;
    mat.doubleSided = look.doubleSided !== false;
    mat.wireframe = look.wireframe;
    if (look.texture) {
      mat.slots.base = {
        imageId: imageFor(look.texture),
        offset: [0, 0], scale: [1, 1], rotation: 0, factor: 1, enabled: true,
      };
    }
    const key = materialKey(mat);
    const hit = materialByKey.get(key);
    if (hit !== undefined) return hit; // identical look already exists — share it
    scene.materials.push(mat);
    materialByKey.set(key, mat.id);
    return mat.id;
  };

  for (const m of scene.meshes) {
    // MODEL imports own their materials (from the GLTF/OBJ) — leave alone
    if (m.materialId != null || m.kind === 'MODEL' || m.kind === 'EMPTY') continue;
    m.materialId = materialFor({ ...m, name: m.name });
  }
  for (const pm of scene.polyMeshes) {
    if (pm.materialId != null) continue;
    pm.materialId = materialFor({ ...pm, name: pm.name });
  }
}

/** Identity of a material's LOOK (not its id/name) — two objects that
 *  looked the same before the migration end up sharing one datablock. */
function materialKey(m: TGMaterial): string {
  return JSON.stringify([
    m.baseColor, m.opacity, m.roughness, m.metallic, m.emission, m.emissionStrength,
    m.unlit, m.doubleSided, m.wireframe, m.blend, m.slots,
  ]);
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
