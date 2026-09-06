// The tool registry: everything an agent can do to a threegrease scene.
//
// This is the single source of truth. The in-app Agent panel, the MCP server
// and the ACP server all enumerate and dispatch through here, so a tool added
// once is immediately callable from Claude Code, Zed, and the built-in chat.
//
// Conventions every tool follows:
//  - Coordinates are OBJECT space for GP strokes (the space GPPoint.co lives
//    in) and WORLD space for scene objects. Each schema says which.
//  - `mutates: true` gets pushUndo() before and requestRender() after from
//    the dispatcher, so a handler never open-codes either and a tool can't
//    silently skip the undo stack.
//  - Results are plain JSON. Anything returning a THREE object is a bug: the
//    MCP/ACP transports serialize results across a process boundary.
import * as THREE from 'three';
import type { AgentHost, AgentTool, JsonSchema, ToolResult } from './types';
import type { GPScene, GPStroke, TGLight, Vec3, Vec4 } from '../core/types';
import {
  activeLayer, activeObject, createLayer, createPoint, createStroke, ensureFrame, frameAt,
} from '../core/gpdata';
import { listSelected, objectName, getObjectTransform, setObjectTransform, deleteObject } from '../tools/objects';
import type { ObjRef } from '../tools/objects';
import { BRUSH_PRESETS } from '../core/brushes';
import { autoRig } from '../actor/rig';
import { actorMixer } from '../actor/mixer';
import { actorSolver } from '../actor/solver';

// ---- schema helpers -------------------------------------------------------

const str = (description: string, opts: Partial<JsonSchema> = {}): JsonSchema =>
  ({ type: 'string', description, ...opts });
const num = (description: string, opts: Partial<JsonSchema> = {}): JsonSchema =>
  ({ type: 'number', description, ...opts });
const bool = (description: string, opts: Partial<JsonSchema> = {}): JsonSchema =>
  ({ type: 'boolean', description, ...opts });
const vec3 = (description: string): JsonSchema =>
  ({ type: 'array', description, items: { type: 'number' }, minItems: 3, maxItems: 3 });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });

const OBJ_KINDS = ['GP', 'MESH', 'POLY', 'SPLAT', 'PCLOUD', 'LIGHT', 'TRIGGER', 'STREAM'] as const;

// ---- shared lookups -------------------------------------------------------

function refOf(args: Record<string, unknown>): ObjRef {
  const kind = String(args.kind ?? 'GP') as ObjRef['kind'];
  return { kind, id: Number(args.id) };
}

/** Resolve the GP object a stroke tool should target: explicit id, else active. */
function gpObject(scene: GPScene, id?: unknown) {
  if (id === undefined || id === null) return activeObject(scene);
  const found = scene.objects.find((o) => o.id === Number(id));
  if (!found) throw new Error(`No GP object with id ${id}`);
  return found;
}

function gpLayer(scene: GPScene, objectId?: unknown, layerId?: unknown) {
  const ob = gpObject(scene, objectId);
  if (layerId === undefined || layerId === null) {
    const l = activeLayer(ob);
    if (!l) throw new Error(`GP object "${ob.name}" has no layers`);
    return { ob, layer: l };
  }
  const layer = ob.layers.find((l) => l.id === Number(layerId));
  if (!layer) throw new Error(`No layer with id ${layerId} on "${ob.name}"`);
  return { ob, layer };
}

function bboxOf(points: { co: Vec3 }[]) {
  if (!points.length) return null;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p.co[i]);
      hi[i] = Math.max(hi[i], p.co[i]);
    }
  }
  return { min: lo.map(r3), max: hi.map(r3) };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const rv = (v: readonly number[]) => v.map(r3);

// ---- the tools ------------------------------------------------------------

export const AGENT_TOOLS: AgentTool[] = [
  // ---------------------------------------------------------------- query
  {
    name: 'scene.summary',
    description:
      'Compact overview of the whole scene: mode, frame, GP objects with their layers and stroke counts, '
      + 'meshes, lights, materials, actors, capture streams, and the active selection. Start here — it is '
      + 'small enough to read in full '
      + 'and tells you the ids every other tool needs.',
    inputSchema: obj({}),
    handler: ({ ctx }) => {
      const s = ctx.scene;
      return {
        mode: ctx.settings.mode,
        frame: s.frame,
        frameRange: [s.frameStart, s.frameEnd],
        activeObject: s.objects[s.activeObject]?.name ?? null,
        gpObjects: s.objects.map((o) => ({
          id: o.id, name: o.name, visible: !o.hide,
          translation: rv(o.translation), rotation: rv(o.rotation), scale: rv(o.scale),
          activeMaterial: o.activeMaterial,
          materials: o.materials.map((m, i) => ({ index: i, name: m.name })),
          layers: o.layers.map((l) => ({
            id: l.id, name: l.name, hidden: l.hide, locked: l.lock, opacity: r3(l.opacity),
            frames: l.frames.map((f) => ({ frame: f.frameNumber, strokes: f.strokes.length })),
          })),
          modifiers: o.modifiers.map((m) => ({ id: m.id, type: m.type, enabled: m.enabled })),
          effects: o.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled })),
        })),
        meshes: s.meshes.map((m) => ({
          id: m.id, name: m.name, kind: m.kind, visible: m.visible,
          translation: rv(m.translation), scale: rv(m.scale),
        })),
        polyMeshes: s.polyMeshes.map((p) => ({
          id: p.id, name: p.name, verts: p.vertices.length, faces: p.faces.length,
        })),
        lights: s.lights.map((l) => ({
          id: l.id, name: l.name, kind: l.kind, intensity: r3(l.intensity), castShadow: l.castShadow,
        })),
        splats: s.splats.map((x) => ({ id: x.id, name: x.name })),
        actors: s.actors.map((a) => ({
          id: a.id, name: a.name, rig: a.rig.mode, streamId: a.rig.streamId,
          simulating: a.physics.enabled, joints: a.joints.map((j) => j.name),
        })),
        streams: s.mmStreams.map((st) => ({
          id: st.id, name: st.name, kind: st.kind, source: st.source,
        })),
        selection: listSelected(s).map((r) => ({ kind: r.kind, id: r.id, name: objectName(s, r) })),
      };
    },
  },
  {
    name: 'scene.strokes',
    description:
      'List strokes on one GP layer/frame with their point counts, material index, width and bounding box. '
      + 'Use before editing or deleting strokes. Omit objectId/layerId for the active ones.',
    inputSchema: obj({
      objectId: num('GP object id (default: active object)'),
      layerId: num('Layer id (default: active layer)'),
      frame: num('Frame number (default: current frame)'),
      includePoints: bool('Return full point coordinates too. Large — off by default.', { default: false }),
    }),
    handler: ({ ctx }, args) => {
      const { ob, layer } = gpLayer(ctx.scene, args.objectId, args.layerId);
      const frame = args.frame === undefined ? ctx.scene.frame : Number(args.frame);
      const kf = frameAt(layer, frame);
      if (!kf) return { objectId: ob.id, layerId: layer.id, frame, strokes: [] };
      return {
        objectId: ob.id, layerId: layer.id, frame: kf.frameNumber,
        strokes: kf.strokes.map((st) => ({
          id: st.id, points: st.points.length, materialIndex: st.materialIndex,
          lineWidth: r3(st.lineWidth), cyclic: st.cyclic, bbox: bboxOf(st.points),
          ...(args.includePoints ? { co: st.points.map((p) => rv(p.co)) } : {}),
        })),
      };
    },
  },
  {
    name: 'scene.materials',
    description: 'GP stroke/fill materials for one object, including NPR shading (style, texture, gradient).',
    inputSchema: obj({ objectId: num('GP object id (default: active object)') }),
    handler: ({ ctx }, args) => {
      const ob = gpObject(ctx.scene, args.objectId);
      return {
        objectId: ob.id,
        activeMaterial: ob.activeMaterial,
        materials: ob.materials.map((m, index) => ({
          index, name: m.name,
          showStroke: m.showStroke, strokeColor: rv(m.strokeColor), lineMode: m.lineMode,
          strokeShade: m.strokeShade ?? 'SOLID',
          showFill: m.showFill, fillColor: rv(m.fillColor), fillStyle: m.fillStyle,
          holdout: m.holdout,
        })),
      };
    },
  },
  {
    name: 'view.screenshot',
    description:
      'Render the current viewport and return it as a base64 PNG. This is how you SEE the drawing — use it '
      + 'to check your own work after drawing, or to answer questions about what is on screen. Only useful '
      + 'with a vision-capable model.',
    inputSchema: obj({}),
    heavy: true,
    handler: (host) => ({ mediaType: 'image/png', base64: host.screenshot() }),
  },

  // ---------------------------------------------------------------- draw
  {
    name: 'stroke.create',
    description:
      'Draw a grease-pencil stroke from a list of points. This is the main creative act. Points are in the '
      + 'GP object\'s OBJECT space (same space scene.strokes reports). With the default Z-up world, the '
      + 'ground plane is XY and Z is height. Returns the new stroke id.',
    inputSchema: obj({
      points: {
        type: 'array', description: 'Ordered [x,y,z] points, at least 1.',
        items: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      },
      objectId: num('GP object id (default: active object)'),
      layerId: num('Layer id (default: active layer)'),
      frame: num('Frame number (default: current frame)'),
      materialIndex: num('Material slot index (default: object\'s active material)'),
      lineWidth: num('Stroke width. Pixels when the brush unit is VIEW, world units when SCENE.', { default: 8 }),
      pressure: num('Uniform pressure 0..1, scales width.', { default: 1, minimum: 0, maximum: 1 }),
      strength: num('Uniform strength 0..1, scales opacity.', { default: 1, minimum: 0, maximum: 1 }),
      cyclic: bool('Close the stroke into a loop.', { default: false }),
      hardness: num('Edge hardness 0..1.', { default: 1, minimum: 0, maximum: 1 }),
    }, ['points']),
    mutates: true,
    handler: ({ ctx }, args) => {
      const pts = args.points as number[][];
      if (!Array.isArray(pts) || !pts.length) throw new Error('points must be a non-empty array of [x,y,z]');
      const { ob, layer } = gpLayer(ctx.scene, args.objectId, args.layerId);
      if (layer.lock) throw new Error(`Layer "${layer.name}" is locked`);
      const frame = args.frame === undefined ? ctx.scene.frame : Number(args.frame);
      const kf = ensureFrame(layer, frame, true);
      const matIndex = args.materialIndex === undefined
        ? ob.activeMaterial : Math.max(0, Math.min(ob.materials.length - 1, Number(args.materialIndex)));
      const st = createStroke(matIndex, Number(args.lineWidth ?? 8));
      st.cyclic = !!args.cyclic;
      st.hardness = Number(args.hardness ?? 1);
      const pressure = Number(args.pressure ?? 1);
      const strength = Number(args.strength ?? 1);
      for (const p of pts) {
        if (!Array.isArray(p) || p.length < 3 || p.some((v) => !Number.isFinite(v))) {
          throw new Error(`Bad point ${JSON.stringify(p)} — expected three finite numbers`);
        }
        st.points.push(createPoint([p[0], p[1], p[2]], pressure, strength));
      }
      kf.strokes.push(st);
      return { strokeId: st.id, objectId: ob.id, layerId: layer.id, frame: kf.frameNumber, points: st.points.length };
    },
  },
  {
    name: 'stroke.delete',
    description: 'Delete strokes by id from a GP layer/frame.',
    inputSchema: obj({
      strokeIds: { type: 'array', description: 'Stroke ids to remove.', items: { type: 'number' } },
      objectId: num('GP object id (default: active object)'),
      layerId: num('Layer id (default: active layer)'),
      frame: num('Frame number (default: current frame)'),
    }, ['strokeIds']),
    mutates: true,
    handler: ({ ctx }, args) => {
      const ids = new Set((args.strokeIds as number[]).map(Number));
      const { layer } = gpLayer(ctx.scene, args.objectId, args.layerId);
      const frame = args.frame === undefined ? ctx.scene.frame : Number(args.frame);
      const kf = frameAt(layer, frame);
      if (!kf) return { deleted: 0 };
      const before = kf.strokes.length;
      kf.strokes = kf.strokes.filter((s) => !ids.has(s.id));
      return { deleted: before - kf.strokes.length };
    },
  },
  {
    name: 'stroke.transform',
    description: 'Translate / scale / rotate existing strokes in object space, about their shared centre.',
    inputSchema: obj({
      strokeIds: { type: 'array', description: 'Strokes to affect. Omit for every stroke on the frame.', items: { type: 'number' } },
      translate: vec3('Offset to add, object space.'),
      scale: num('Uniform scale about the selection centre.'),
      rotate: vec3('Euler XYZ radians about the selection centre.'),
      objectId: num('GP object id (default: active object)'),
      layerId: num('Layer id (default: active layer)'),
      frame: num('Frame number (default: current frame)'),
    }),
    mutates: true,
    handler: ({ ctx }, args) => {
      const { layer } = gpLayer(ctx.scene, args.objectId, args.layerId);
      const frame = args.frame === undefined ? ctx.scene.frame : Number(args.frame);
      const kf = frameAt(layer, frame);
      if (!kf) throw new Error(`No keyframe at frame ${frame}`);
      const ids = args.strokeIds ? new Set((args.strokeIds as number[]).map(Number)) : null;
      const targets: GPStroke[] = kf.strokes.filter((s) => !ids || ids.has(s.id));
      if (!targets.length) return { affected: 0 };
      const all = targets.flatMap((s) => s.points);
      const centre = [0, 1, 2].map((i) => all.reduce((a, p) => a + p.co[i], 0) / all.length) as Vec3;
      const t = args.translate as number[] | undefined;
      const sc = args.scale === undefined ? 1 : Number(args.scale);
      const rot = args.rotate as number[] | undefined;
      const q = rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])) : null;
      const v = new THREE.Vector3();
      for (const s of targets) {
        for (const p of s.points) {
          v.set(p.co[0] - centre[0], p.co[1] - centre[1], p.co[2] - centre[2]);
          if (q) v.applyQuaternion(q);
          v.multiplyScalar(sc);
          p.co = [
            centre[0] + v.x + (t?.[0] ?? 0),
            centre[1] + v.y + (t?.[1] ?? 0),
            centre[2] + v.z + (t?.[2] ?? 0),
          ];
        }
      }
      return { affected: targets.length, centre: rv(centre) };
    },
  },

  // ---------------------------------------------------------------- objects
  {
    name: 'object.create',
    description:
      'Add a scene object: a mesh primitive, a new grease-pencil object, or a light. Placed at the given '
      + 'world position (default: the 3D cursor).',
    inputSchema: obj({
      type: str('What to create.', { enum: ['PLANE', 'BOX', 'SPHERE', 'CYLINDER', 'EMPTY', 'GP', 'LIGHT'] }),
      at: vec3('World position (default: the 3D cursor).'),
      lightKind: str('For type=LIGHT.', { enum: ['AMBIENT', 'SUN', 'POINT', 'SPOT'], default: 'SUN' }),
      name: str('Optional name for the new object.'),
    }, ['type']),
    mutates: true,
    handler: (host, args) => {
      const { ctx } = host;
      const type = String(args.type);
      const at = (args.at as [number, number, number] | undefined);
      const before = {
        meshes: ctx.scene.meshes.length, objects: ctx.scene.objects.length, lights: ctx.scene.lights.length,
      };
      if (type === 'GP') host.addGPObject();
      else if (type === 'LIGHT') host.addLight(String(args.lightKind ?? 'SUN') as TGLight['kind'], at);
      else host.addMeshObject(type as 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER' | 'PYRAMID' | 'TETRA' | 'OCTA' | 'DODECA' | 'ICOSA' | 'EMPTY', undefined, at);

      // report what actually landed, and honour an explicit name
      const s = ctx.scene;
      if (type === 'GP' && s.objects.length > before.objects) {
        const o = s.objects[s.objects.length - 1];
        if (args.name) o.name = String(args.name);
        return { kind: 'GP', id: o.id, name: o.name };
      }
      if (type === 'LIGHT' && s.lights.length > before.lights) {
        const l = s.lights[s.lights.length - 1];
        if (args.name) l.name = String(args.name);
        return { kind: 'LIGHT', id: l.id, name: l.name };
      }
      if (s.meshes.length > before.meshes) {
        const m = s.meshes[s.meshes.length - 1];
        if (args.name) m.name = String(args.name);
        if (at) m.translation = [...at];
        return { kind: 'MESH', id: m.id, name: m.name, meshKind: m.kind };
      }
      throw new Error(`Nothing was created for type ${type}`);
    },
  },
  {
    name: 'object.transform',
    description:
      'Set an object\'s world transform. Works for every object kind (GP, MESH, POLY, SPLAT, LIGHT, ...). '
      + 'Omitted fields keep their current value.',
    inputSchema: obj({
      kind: str('Object kind.', { enum: [...OBJ_KINDS] }),
      id: num('Object id.'),
      translation: vec3('World position.'),
      rotation: vec3('Euler XYZ radians.'),
      scale: vec3('Scale per axis.'),
    }, ['kind', 'id']),
    mutates: true,
    handler: ({ ctx }, args) => {
      const ref = refOf(args);
      const t = getObjectTransform(ctx.scene, ref);
      if (!t) throw new Error(`No ${ref.kind} object with id ${ref.id}, or it has no transform`);
      if (args.translation) t.translation = [...(args.translation as Vec3)];
      if (args.rotation) t.rotation = [...(args.rotation as Vec3)];
      if (args.scale) t.scale = [...(args.scale as Vec3)];
      setObjectTransform(ctx.scene, ref, t);
      return { kind: ref.kind, id: ref.id, translation: rv(t.translation), rotation: rv(t.rotation), scale: rv(t.scale) };
    },
  },
  {
    name: 'object.delete',
    description: 'Delete a scene object by kind + id.',
    inputSchema: obj({
      kind: str('Object kind.', { enum: [...OBJ_KINDS] }),
      id: num('Object id.'),
    }, ['kind', 'id']),
    mutates: true,
    handler: ({ ctx }, args) => {
      const ref = refOf(args);
      const name = objectName(ctx.scene, ref);
      deleteObject(ctx.scene, ref);
      return { deleted: { kind: ref.kind, id: ref.id, name } };
    },
  },
  {
    name: 'object.select',
    description: 'Replace the selection with the given objects (empty list clears it).',
    inputSchema: obj({
      objects: {
        type: 'array', description: 'Objects to select.',
        items: obj({ kind: str('Object kind.', { enum: [...OBJ_KINDS] }), id: num('Object id.') }, ['kind', 'id']),
      },
    }, ['objects']),
    mutates: true,
    handler: (host, args) => {
      const { ctx } = host;
      const s = ctx.scene;
      for (const list of [s.objects, s.meshes, s.polyMeshes, s.splats, s.paintClouds, s.lights, s.mmStreams]) {
        for (const o of list as { select?: boolean }[]) o.select = false;
      }
      for (const t of s.score.triggers) t.select = false;
      const wanted = (args.objects as { kind: string; id: number }[]) ?? [];
      const found: string[] = [];
      for (const w of wanted) {
        const ref = { kind: w.kind, id: Number(w.id) } as ObjRef;
        const entity = entityFor(s, ref);
        if (entity) { entity.select = true; found.push(`${w.kind}:${w.id}`); }
      }
      host.refreshWidget();
      return { selected: found };
    },
  },

  // ---------------------------------------------------------------- style
  {
    name: 'material.update',
    description:
      'Update a GP material slot: colours, line mode, and the NPR shading modes (Solid / Gradient / Texture) '
      + 'for both stroke and fill. Omitted fields are left alone.',
    inputSchema: obj({
      index: num('Material slot index (see scene.materials).'),
      objectId: num('GP object id (default: active object)'),
      name: str('Rename the slot.'),
      strokeColor: { type: 'array', description: 'Stroke RGBA 0..1.', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      fillColor: { type: 'array', description: 'Fill RGBA 0..1.', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      showStroke: bool('Draw the stroke line.'),
      showFill: bool('Draw the fill.'),
      lineMode: str('Line rendering.', { enum: ['LINE', 'DOTS', 'SQUARES'] }),
      strokeShade: str('Stroke shading mode.', { enum: ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'TEXTURE'] }),
      fillStyle: str('Fill shading mode.', { enum: ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'TEXTURE'] }),
      holdout: bool('Punch a background-coloured hole instead of painting.'),
    }, ['index']),
    mutates: true,
    handler: ({ ctx }, args) => {
      const ob = gpObject(ctx.scene, args.objectId);
      const m = ob.materials[Number(args.index)];
      if (!m) throw new Error(`No material slot ${args.index} on "${ob.name}"`);
      if (args.name !== undefined) m.name = String(args.name);
      if (args.strokeColor) m.strokeColor = [...(args.strokeColor as Vec4)];
      if (args.fillColor) m.fillColor = [...(args.fillColor as Vec4)];
      if (args.showStroke !== undefined) m.showStroke = !!args.showStroke;
      if (args.showFill !== undefined) m.showFill = !!args.showFill;
      if (args.lineMode) m.lineMode = args.lineMode as typeof m.lineMode;
      if (args.strokeShade) m.strokeShade = args.strokeShade as typeof m.strokeShade;
      if (args.fillStyle) m.fillStyle = args.fillStyle as typeof m.fillStyle;
      if (args.holdout !== undefined) m.holdout = !!args.holdout;
      return { index: Number(args.index), name: m.name };
    },
  },
  {
    name: 'brush.set',
    description:
      'Set the live brush used by subsequent interactive drawing (not by stroke.create, which takes its own '
      + 'width). Includes the expressive presets and the variation-along-the-stroke controls.',
    inputSchema: obj({
      preset: str(`One of: ${BRUSH_PRESETS.map((p) => p.name).join(', ')}.`),
      size: num('Brush size — px (VIEW unit) or size/100 world units (SCENE unit).'),
      strength: num('Opacity 0..1.', { minimum: 0, maximum: 1 }),
      hardness: num('Edge hardness 0..1.', { minimum: 0, maximum: 1 }),
      varyMode: str('What drives variation along the stroke.', { enum: ['NONE', 'RANDOM', 'CURVATURE', 'DENSITY', 'ARC'] }),
      varyRadius: num('How much the signal thins width. Negative grows it where the signal is strong.'),
      varyStrength: num('How much the signal fades opacity.'),
      taperIn: num('Fraction of the stroke that ramps up from the start.'),
      taperOut: num('Fraction that ramps down into the end.'),
    }),
    mutates: true,
    handler: ({ ctx }, args) => {
      const b = ctx.settings.brush;
      if (args.preset) {
        const p = BRUSH_PRESETS.find((x) => x.name.toLowerCase() === String(args.preset).toLowerCase());
        if (!p) throw new Error(`Unknown brush preset "${args.preset}". Available: ${BRUSH_PRESETS.map((x) => x.name).join(', ')}`);
        b.preset = p.name; b.size = p.size; b.strength = p.strength; b.hardness = p.hardness;
        b.style = { ...p.style };
      }
      for (const k of ['size', 'strength', 'hardness'] as const) {
        if (args[k] !== undefined) b[k] = Number(args[k]);
      }
      for (const k of ['varyMode', 'varyRadius', 'varyStrength', 'taperIn', 'taperOut'] as const) {
        if (args[k] !== undefined) {
          (b.style as unknown as Record<string, unknown>)[k] =
            k === 'varyMode' ? String(args[k]) : Number(args[k]);
        }
      }
      return { preset: b.preset, size: b.size, strength: b.strength, hardness: b.hardness, style: b.style };
    },
  },
  {
    name: 'layer.create',
    description: 'Add a layer to a GP object and make it active.',
    inputSchema: obj({
      name: str('Layer name.', { default: 'Layer' }),
      objectId: num('GP object id (default: active object)'),
    }),
    mutates: true,
    handler: ({ ctx }, args) => {
      const ob = gpObject(ctx.scene, args.objectId);
      const l = createLayer(String(args.name ?? 'Layer'));
      ob.layers.push(l);
      ob.activeLayerId = l.id;
      return { layerId: l.id, name: l.name, objectId: ob.id };
    },
  },
  {
    name: 'layer.update',
    description: 'Change a layer\'s visibility, lock, opacity, blend mode or tint.',
    inputSchema: obj({
      layerId: num('Layer id.'),
      objectId: num('GP object id (default: active object)'),
      name: str('Rename.'),
      hide: bool('Hide the layer.'),
      lock: bool('Lock against edits.'),
      opacity: num('0..1.', { minimum: 0, maximum: 1 }),
      blendMode: str('Blending.', { enum: ['REGULAR', 'ADD', 'MULTIPLY'] }),
    }, ['layerId']),
    mutates: true,
    handler: ({ ctx }, args) => {
      const { layer } = gpLayer(ctx.scene, args.objectId, args.layerId);
      if (args.name !== undefined) layer.name = String(args.name);
      if (args.hide !== undefined) layer.hide = !!args.hide;
      if (args.lock !== undefined) layer.lock = !!args.lock;
      if (args.opacity !== undefined) layer.opacity = Number(args.opacity);
      if (args.blendMode) layer.blendMode = args.blendMode as typeof layer.blendMode;
      return { layerId: layer.id, name: layer.name, hide: layer.hide, opacity: r3(layer.opacity) };
    },
  },

  // ---------------------------------------------------------------- app
  {
    name: 'app.command',
    description:
      'Run any command from the command palette by id, exact title, or fuzzy match — the same surface F3 '
      + 'exposes. Covers everything without a dedicated tool (view snaps, exports, modifiers, mode switches, '
      + 'playback...). Call app.commands first to see what exists.',
    inputSchema: obj({
      query: str('Command id, title, or fuzzy text.'),
      args: str('Optional string argument passed to the command.'),
    }, ['query']),
    mutates: true,
    handler: (host, args) => {
      const r = host.execute(String(args.query), args.args === undefined ? undefined : String(args.args));
      if (!r.ok) throw new Error(r.error ?? `Command "${args.query}" not found`);
      return { id: r.id, result: r.result ?? null };
    },
  },
  {
    name: 'app.commands',
    description: 'List available command-palette commands (id + title), optionally filtered.',
    inputSchema: obj({
      query: str('Filter text. Omit to list everything.'),
      limit: num('Max results.', { default: 60 }),
    }),
    handler: (_host, args) => {
      const all = agentCommandLister?.() ?? [];
      const q = String(args.query ?? '').toLowerCase();
      const limit = Number(args.limit ?? 60);
      return {
        commands: all
          .filter((c) => !q || `${c.id} ${c.title}`.toLowerCase().includes(q))
          .slice(0, limit),
      };
    },
  },
  {
    name: 'app.set_mode',
    description: 'Switch editor mode.',
    inputSchema: obj({
      mode: str('Editor mode.', { enum: ['OBJECT', 'DRAW', 'EDIT', 'SCULPT', 'VERTEX', 'WEIGHT'] }),
    }, ['mode']),
    mutates: true,
    handler: (host, args) => {
      host.setMode(args.mode as import('../render/GPSceneRenderer').EditorMode);
      return { mode: args.mode };
    },
  },
  {
    name: 'view.set',
    description: 'Snap the viewport to an axis-aligned view, and optionally frame everything.',
    inputSchema: obj({
      view: str('Which view.', { enum: ['FRONT', 'BACK', 'RIGHT', 'LEFT', 'TOP', 'BOTTOM'] }),
      frameAll: bool('Zoom to fit the whole scene afterwards.', { default: false }),
    }),
    handler: (host, args) => {
      if (args.view) host.snapView(args.view as 'FRONT');
      if (args.frameAll) host.viewAll();
      return { view: args.view ?? null, framed: !!args.frameAll };
    },
  },
  {
    name: 'actor.create',
    description: 'Add a rigged mannequin (an "actor") to the scene, standing '
      + 'at a position. Returns its id and joint names.',
    inputSchema: obj({
      at: vec3('Where to stand it (defaults to the 3D cursor).'),
    }),
    mutates: true,
    handler: (host, args) => {
      const at = Array.isArray(args.at) && args.at.length === 3
        ? args.at.map(Number) as [number, number, number] : undefined;
      host.addActor(at);
      const actor = host.ctx.scene.actors[host.ctx.scene.actors.length - 1];
      return actor
        ? { id: actor.id, name: actor.name, joints: actor.joints.map((j) => j.name) }
        : { error: 'actor was not created' };
    },
  },
  {
    name: 'actor.rig',
    description: 'Configure an actor: ragdoll physics, and how it is driven. '
      + 'Rig modes — MARKERS pins each joint to its capture landmark 1:1 '
      + '(exact, inherits the performer\u2019s proportions); ANGLES copies bone '
      + 'directions but keeps the actor\u2019s own limb lengths (retargets across '
      + 'body shapes); IK uses wrists/ankles/head as goals; MANUAL leaves it '
      + 'to dragging and routes; NONE is a free ragdoll. Only the fields you '
      + 'pass are changed.',
    inputSchema: obj({
      id: num('Actor id (from actor.create or scene.summary).'),
      mode: str('Rig mode.', { enum: ['NONE', 'MARKERS', 'ANGLES', 'IK', 'MANUAL'] }),
      streamId: num('MediaMime stream to drive it from.'),
      autoBind: bool('Bind joints to the standard 33-point pose landmarks by name.'),
      strength: num('How hard capture pulls the joints, 0..1.'),
      smoothing: num('Smoothing on captured targets, 0..0.95.'),
      matchSize: bool('Rescale the captured body to this actor\u2019s size.'),
      simulate: bool('Run ragdoll physics.'),
      gravity: num('Gravity, world units/s^2.'),
      tone: num('Muscle tone 0..0.5 — pull back toward the rest pose. 0 collapses.'),
      damping: num('Velocity retained per step, 0.8..1.'),
      floor: bool('Collide with the ground plane.'),
      shape: str('How it draws.', { enum: ['CAPSULE', 'STICK', 'BOTH'] }),
      resetPose: bool('Return to the T-pose and clear the simulation velocity.'),
    }, ['id']),
    mutates: true,
    handler: (host, args) => {
      const actor = host.ctx.scene.actors.find((a) => a.id === Number(args.id));
      if (!actor) return { error: `no actor with id ${args.id}` };
      const { rig, physics } = actor;
      if (args.mode) rig.mode = args.mode as typeof rig.mode;
      if (args.streamId !== undefined) rig.streamId = Number(args.streamId);
      if (args.strength !== undefined) rig.strength = Number(args.strength);
      if (args.smoothing !== undefined) rig.smoothing = Number(args.smoothing);
      if (args.matchSize !== undefined) rig.matchScale = !!args.matchSize;
      if (args.autoBind) rig.bindings = autoRig(actor, rig.streamId);
      if (args.simulate !== undefined) physics.enabled = !!args.simulate;
      if (args.gravity !== undefined) physics.gravity = Number(args.gravity);
      if (args.tone !== undefined) physics.tone = Number(args.tone);
      if (args.damping !== undefined) physics.damping = Number(args.damping);
      if (args.floor !== undefined) physics.floor = !!args.floor;
      if (args.shape) actor.shape = args.shape as typeof actor.shape;
      if (args.resetPose) host.resetActor(actor.id);
      return {
        id: actor.id, mode: rig.mode, streamId: rig.streamId,
        bindings: rig.bindings.length, simulate: physics.enabled,
      };
    },
  },
  {
    name: 'actor.generate',
    description: 'Generate a motion clip for a character from a description '
      + '("tired shuffle", "march", "limp on the left") and put it on a mixer '
      + 'layer. The built-in generator is PROCEDURAL SYNTHESIS, not a learned '
      + 'model; a service with real weights answers the same request and lands '
      + 'in the same place. Motion is generated in place \u2014 travel is the '
      + 'root\u2019s job (a path, a goal, or the walk cycle).',
    inputSchema: obj({
      id: num('Actor id.'),
      prompt: str('How it should move.'),
      seconds: num('Length of the clip. Default 2.'),
      backend: str('"local" (default) or "remote".'),
    }, ['id', 'prompt']),
    mutates: true,
    handler: async (host, args) => {
      const actor = host.ctx.scene.actors.find((a) => a.id === Number(args.id));
      if (!actor) return { error: `no actor with id ${args.id}` };
      const app = host as unknown as {
        generateMotion?: (id: number, p: string, s: number, b?: string) => Promise<void>;
      };
      if (!app.generateMotion) return { error: 'motion generation unavailable' };
      await app.generateMotion(
        actor.id, String(args.prompt),
        args.seconds === undefined ? 2 : Number(args.seconds),
        args.backend ? String(args.backend) : 'local');
      const clip = host.ctx.scene.clips[host.ctx.scene.clips.length - 1];
      return { ok: true, clip: clip?.name, frames: clip?.frames.length, joints: clip?.joints };
    },
  },
  {
    name: 'actor.goto',
    description: 'Tell a character where to GO. It walks there itself \u2014 seeking, '
      + 'slowing into the goal, sliding along walls and sidestepping obstacles \u2014 '
      + 'and the procedural gait animates the walking, so this is the same '
      + 'motion as following a path or being driven by hand. Give either a '
      + 'world point or an object to walk to; omit both to stop. This is '
      + 'steering, not pathfinding: it will not solve a maze, and it reports '
      + '`stuck` rather than shuffling forever if it wedges.',
    inputSchema: obj({
      id: num('Actor id.'),
      to: vec3('Destination in WORLD space.'),
      object: obj({
        kind: str('Object kind, e.g. "MESH", "GP", "ACTOR".'),
        id: num('Object id.'),
      }, ['kind', 'id']),
      speed: num('Cruising speed in m/s. Default keeps the current setting.'),
      stop: bool('Stop and forget the destination.'),
    }, ['id']),
    mutates: true,
    handler: (host, args) => {
      const actor = host.ctx.scene.actors.find((a) => a.id === Number(args.id));
      if (!actor) return { error: `no actor with id ${args.id}` };
      if (!actor.steer) return { error: 'actor has no steering block' };
      const st = actor.steer;
      if (args.speed !== undefined) st.speed = Number(args.speed);
      if (args.stop) {
        st.mode = 'NONE';
        st.arrived = false;
        st.stuck = false;
        return { ok: true, stopped: true };
      }
      st.arrived = false;
      st.stuck = false;
      const target = args.object as { kind?: unknown; id?: unknown } | undefined;
      if (target?.kind !== undefined) {
        st.mode = 'OBJECT';
        st.target = { kind: String(target.kind), id: Number(target.id) } as typeof st.target;
      } else if (Array.isArray(args.to) && args.to.length === 3) {
        st.mode = 'POINT';
        st.point = args.to.map(Number) as [number, number, number];
        st.target = null;
      } else {
        return { error: 'give either `to` (a world point) or `object`' };
      }
      // A character with no gait would SLIDE to the goal, which is the one
      // thing this is meant to stop looking like.
      if (actor.gait) actor.gait.enabled = true;
      return { ok: true, mode: st.mode, speed: st.speed };
    },
  },
  {
    name: 'actor.pose',
    description: 'Move an actor\u2019s joints by name. Positions are GOALS fed to '
      + 'the same solver capture uses, so the rest of the body follows through '
      + 'the bones rather than the joint tearing loose. Pin a joint to hold it '
      + 'in place while the rest hangs off it.',
    inputSchema: obj({
      id: num('Actor id.'),
      joints: {
        type: 'array',
        description: 'Joints to move and/or pin.',
        items: obj({
          name: str('Joint name, e.g. "wrist.L", "head", "hips".'),
          at: vec3('Target position in ACTOR-LOCAL space (origin at the actor).'),
          pin: bool('Hold this joint in place.'),
          weight: num('0..1 pull toward `at`; 1 is a hard pin. Default 1.'),
        }, ['name']),
      } as JsonSchema,
    }, ['id', 'joints']),
    mutates: true,
    handler: (host, args) => {
      const actor = host.ctx.scene.actors.find((a) => a.id === Number(args.id));
      if (!actor) return { error: `no actor with id ${args.id}` };
      const list = Array.isArray(args.joints) ? args.joints : [];
      const applied: string[] = [];
      const unknown: string[] = [];
      for (const raw of list) {
        const spec = raw as Record<string, unknown>;
        const index = actor.joints.findIndex((j) => j.name === String(spec.name));
        if (index < 0) { unknown.push(String(spec.name)); continue; }
        if (spec.pin !== undefined) actor.joints[index].pin = !!spec.pin;
        const at = spec.at;
        if (Array.isArray(at) && at.length === 3) {
          const base = spec.weight === undefined ? 1 : Number(spec.weight);
          const w = base * actorMixer.gain(actor, 'MANUAL', actor.joints[index].name);
          if (w > 0.001) {
            actorSolver.addTarget(actor.id, {
              index,
              pos: at.map(Number) as [number, number, number],
              weight: w,
            });
          }
        }
        applied.push(String(spec.name));
      }
      return {
        applied,
        ...(unknown.length ? { unknown, available: actor.joints.map((j) => j.name) } : {}),
      };
    },
  },
  {
    name: 'world.set',
    description: 'Set the scene world (environment): background mode, colours, '
      + 'environment image or 360 video, sky parameters, rotation, and how '
      + 'strongly it lights the scene. Only the fields you pass are changed.',
    inputSchema: obj({
      mode: str('SOLID (flat colour), GRADIENT (sky/ground), EQUIRECT (a 2:1 '
        + 'lat-long image from scene.images), VIDEO (360 footage or live '
        + 'capture), SKY (physical sky model).',
      { enum: ['SOLID', 'GRADIENT', 'EQUIRECT', 'VIDEO', 'SKY'] }),
      color: vec3('SOLID background colour, linear 0..1.'),
      skyColor: vec3('GRADIENT colour at the zenith, linear 0..1.'),
      groundColor: vec3('GRADIENT colour at the nadir, linear 0..1.'),
      imageId: num('EQUIRECT: id of an image in scene.images.'),
      videoSource: str('VIDEO source.', { enum: ['CAMERA', 'URL'] }),
      videoUrl: str('VIDEO url when videoSource is URL.'),
      sunElevation: num('SKY: sun height in degrees above the horizon.'),
      sunAzimuth: num('SKY: sun compass direction in degrees.'),
      turbidity: num('SKY: haze, 1..20.'),
      rayleigh: num('SKY: blueness of the scattering, 0..5.'),
      rotation: num('Spin of the environment about the world up axis, in degrees.'),
      strength: num('How strongly the world lights the scene (IBL multiplier).'),
      lighting: bool('Whether the world lights the scene at all.'),
      backgroundVisible: bool('Whether the world is drawn behind the scene.'),
      backgroundIntensity: num('Brightness of the visible background only.'),
      blur: num('Background defocus, 0..1. Ignored for VIDEO.'),
      shading: str('Viewport shading. The world is only VISIBLE in MATERIAL '
        + 'and RENDERED; SOLID and WIREFRAME use a fixed studio light.',
      { enum: ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED'] }),
    }),
    mutates: true,
    handler: (host, args) => {
      const w = host.ctx.scene.world;
      const setNum = (k: 'sunElevation' | 'sunAzimuth' | 'turbidity' | 'rayleigh'
        | 'strength' | 'backgroundIntensity' | 'blur' | 'imageId') => {
        if (args[k] !== undefined) (w as unknown as Record<string, unknown>)[k] = Number(args[k]);
      };
      const setBool = (k: 'lighting' | 'backgroundVisible') => {
        if (args[k] !== undefined) w[k] = !!args[k];
      };
      const setVec = (k: 'color' | 'skyColor' | 'groundColor') => {
        const v = args[k];
        if (Array.isArray(v) && v.length === 3) w[k] = v.map(Number) as [number, number, number];
      };
      if (args.mode) w.mode = args.mode as typeof w.mode;
      if (args.videoSource) w.videoSource = args.videoSource as typeof w.videoSource;
      if (args.videoUrl !== undefined) w.videoUrl = String(args.videoUrl);
      // degrees on the wire, radians in the model — an LLM reasons about
      // "turn it 90 degrees", not about 1.5707963
      if (args.rotation !== undefined) w.rotation = Number(args.rotation) * Math.PI / 180;
      for (const k of ['sunElevation', 'sunAzimuth', 'turbidity', 'rayleigh',
        'strength', 'backgroundIntensity', 'blur', 'imageId'] as const) setNum(k);
      for (const k of ['lighting', 'backgroundVisible'] as const) setBool(k);
      for (const k of ['color', 'skyColor', 'groundColor'] as const) setVec(k);
      if (args.shading) {
        host.setShading(args.shading as import('../core/types').ViewportShading);
      }
      return { world: w, shading: host.ctx.settings.shading };
    },
  },
  {
    name: 'scene.set_frame',
    description: 'Move the playhead to a frame.',
    inputSchema: obj({ frame: num('Frame number.') }, ['frame']),
    mutates: true,
    handler: ({ ctx }, args) => {
      ctx.scene.frame = Math.max(0, Math.round(Number(args.frame)));
      return { frame: ctx.scene.frame };
    },
  },
];

/** Injected by App so app.commands can enumerate without importing the UI. */
let agentCommandLister: (() => { id: string; title: string }[]) | null = null;
export function setAgentCommandLister(fn: () => { id: string; title: string }[]): void {
  agentCommandLister = fn;
}

function entityFor(scene: GPScene, ref: ObjRef): { select?: boolean } | undefined {
  switch (ref.kind) {
    case 'GP': return scene.objects.find((o) => o.id === ref.id);
    case 'MESH': return scene.meshes.find((o) => o.id === ref.id);
    case 'POLY': return scene.polyMeshes.find((o) => o.id === ref.id);
    case 'SPLAT': return scene.splats.find((o) => o.id === ref.id);
    case 'PCLOUD': return scene.paintClouds.find((o) => o.id === ref.id);
    case 'LIGHT': return scene.lights.find((o) => o.id === ref.id);
    case 'STREAM': return scene.mmStreams.find((o) => o.id === ref.id);
    case 'TRIGGER': return scene.score.triggers.find((o) => o.id === ref.id);
    default: return undefined;
  }
}

// ---- dispatch -------------------------------------------------------------

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): AgentTool | undefined { return BY_NAME.get(name); }

/** Tool definitions in the shape MCP and the provider tool APIs both want. */
export function toolCatalog(includeHeavy = true): { name: string; description: string; inputSchema: JsonSchema }[] {
  return AGENT_TOOLS
    .filter((t) => includeHeavy || !t.heavy)
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/**
 * Run one tool. Every caller — chat panel, MCP, ACP — goes through here, so
 * undo/render bookkeeping and error shaping happen exactly once and a tool
 * cannot be invoked by name without passing this gate.
 */
export function runTool(host: AgentHost, name: string, args: Record<string, unknown>): ToolResult {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}". Call scene.summary or list tools to see what exists.` };
  try {
    if (tool.mutates) host.ctx.pushUndo();
    const result = tool.handler(host, args ?? {});
    if (tool.mutates) {
      host.ctx.requestRender();
      host.ctx.refreshUI();
    }
    return { ok: true, result };
  } catch (err) {
    // Errors are returned, not thrown: a tool failure is information the
    // model should see and correct, not a crashed turn.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
