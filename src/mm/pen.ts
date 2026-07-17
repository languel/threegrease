// Stream pen: a landmark draws GP strokes LIVE — the direct-drawing
// alternative to record→bake. While a stream's pen is armed, each new
// frame appends the chosen landmark's world position to a growing stroke
// in the ACTIVE GP object (current brush style, exactly like the Draw
// tool bakes it). Confidence is the pen state: below minConf = pen up
// (stroke ends; the next confident sample starts a new one), and it
// doubles as pressure — the same confidence→pressure mapping clips bake
// with. A stale stream (>300ms without frames) also lifts the pen.
import * as THREE from 'three';
import type { GPStroke, MMStream, Vec3 } from '../core/types';
import { activeLayer, activeObject, createPoint, createStroke, ensureFrame } from '../core/gpdata';
import { brushWidth } from '../tools/draw';
import type { AppCtx } from '../tools/context';
import { worldMatrixOf } from '../tools/objects';
import { streamStore, streamWorldMatrix } from './streams';

interface PenState {
  stroke: GPStroke | null;
  layerId: number | null;
  lastVersion: number;
  lastSampleT: number;
}

export class StreamPen {
  private states = new Map<number, PenState>();

  /** true while any armed pen has an open stroke (status display) */
  drawing = false;

  tick(ctx: AppCtx): void {
    const scene = ctx.scene;
    this.drawing = false;
    for (const st of scene.mmStreams) {
      const pen = st.pen;
      if (!pen?.active) { this.endStroke(st.id); continue; }
      let state = this.states.get(st.id);
      if (!state) {
        state = { stroke: null, layerId: null, lastVersion: -1, lastSampleT: 0 };
        this.states.set(st.id, state);
      }
      const frame = streamStore.get(st.id);
      const ver = streamStore.version.get(st.id) ?? -1;
      const now = performance.now();
      // stale stream = pen up
      if (!frame || (state.stroke && now - state.lastSampleT > 300)) {
        if (!frame) { this.endStroke(st.id); continue; }
      }
      if (ver === state.lastVersion) {
        if (state.stroke && now - state.lastSampleT > 300) this.endStroke(st.id);
        else if (state.stroke) this.drawing = true;
        continue;
      }
      state.lastVersion = ver;
      const li = Math.min(pen.landmark, Math.max(0, frame.count - 1));
      if (frame.count === 0) { this.endStroke(st.id); continue; }
      const conf = frame.data[li * 4 + 3];
      if (conf < pen.minConf) { this.endStroke(st.id); continue; }

      // landmark world position -> active GP object local
      const world = new THREE.Vector3(
        frame.data[li * 4], frame.data[li * 4 + 1], frame.data[li * 4 + 2],
      ).applyMatrix4(streamWorldMatrix(scene, st));
      const ob = activeObject(scene);
      const layer = activeLayer(ob);
      if (!layer || layer.hide || layer.lock) { this.endStroke(st.id); continue; }
      world.applyMatrix4(worldMatrixOf(scene, { kind: 'GP', id: ob.id }).invert());

      if (!state.stroke) {
        // stroke start = one undo step, current brush baked like DrawTool
        ctx.pushUndo();
        const b = ctx.settings.brush;
        const s = createStroke(ob.activeMaterial, brushWidth(b));
        s.hardness = b.hardness;
        s.style = { ...b.style };
        const gpFrame = ensureFrame(layer, scene.frame, ctx.settings.autoKey);
        gpFrame.strokes.push(s);
        state.stroke = s;
        state.layerId = layer.id;
      }
      const p = createPoint([world.x, world.y, world.z] as Vec3, Math.max(0.05, conf), Math.max(0.05, conf));
      state.stroke.points.push(p);
      state.lastSampleT = now;
      this.drawing = true;
      ctx.requestRender(state.layerId ?? undefined);
    }
    // cleanup states for deleted streams
    for (const id of this.states.keys()) {
      if (!ctx.scene.mmStreams.some((s) => s.id === id)) this.states.delete(id);
    }
  }

  /** Lift the pen for one stream (stroke stays; next sample starts fresh). */
  endStroke(streamId: number): void {
    const state = this.states.get(streamId);
    if (state) { state.stroke = null; state.layerId = null; }
  }
}

export const streamPen = new StreamPen();

/** UI hints: common landmark indices per stream kind. */
export function penLandmarkHint(kind: MMStream['kind']): string {
  switch (kind) {
    case 'POSE': return '0 nose · 15 L wrist · 16 R wrist · 19/20 index tips';
    case 'HAND_LEFT': case 'HAND_RIGHT': return '8 index tip · 4 thumb tip · 0 wrist';
    case 'IRIS': return '0 L iris center · 5 R iris center';
    default: return 'point index into the stream';
  }
}
