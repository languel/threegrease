// Native MediaMime core: live landmark streams as first-class scene point
// clouds. MMStream (core/types.ts) is the persisted CONFIG; the frames
// themselves are runtime-only and live here in StreamStore, packed
// [x,y,z,confidence] per point in STREAM-LOCAL space (X right, Y up,
// Z toward the viewer — the stream's own transform places it in world,
// so the Z-up/Y-up world convention is handled by the default rotation,
// same trick as createDefaultCamera).
//
// Sources:
//  - CAMERA: in-app webcam + MediaPipe (src/mm/capture.ts) pushes frames.
//  - BUS: '<busAddress>/<index>' events (x, y[, z[, confidence]]) accumulate
//    into a frame — the old external-bridge path, now feeding the same
//    native representation (and the headless test path).
import * as THREE from 'three';
import type { GPScene, MMStream, Vec3 } from '../core/types';
import { bus } from '../events/bus';
import { worldMatrixOf, type ObjRef } from '../tools/objects';

export const STREAM_POINT_COUNTS: Record<MMStream['kind'], number> = {
  POSE: 33, HAND_LEFT: 21, HAND_RIGHT: 21, FACE: 478, CUSTOM: 0,
};

/** Packed landmark frame: [x,y,z,conf] * count, stream-local coords. */
export interface MMFrame {
  data: Float32Array;
  count: number;
  t: number;
}

export class StreamStore {
  private frames = new Map<number, MMFrame>();
  /** bumped on every push — cheap dirty check for the GPU sync */
  readonly version = new Map<number, number>();

  push(streamId: number, data: Float32Array, count: number): void {
    this.frames.set(streamId, { data, count, t: performance.now() });
    this.version.set(streamId, (this.version.get(streamId) ?? 0) + 1);
  }

  get(streamId: number): MMFrame | null { return this.frames.get(streamId) ?? null; }

  drop(streamId: number): void {
    this.frames.delete(streamId);
    this.version.delete(streamId);
  }
}

/** The app-wide live-frame store. */
export const streamStore = new StreamStore();

let nextStreamId = 1;
export function createStream(
  scene: GPScene, kind: MMStream['kind'], source: MMStream['source'],
  upAxis: 'Y' | 'Z', busAddress?: string,
): MMStream {
  const maxId = scene.mmStreams.reduce((m, s) => Math.max(m, s.id), 0);
  nextStreamId = Math.max(nextStreamId, maxId + 1);
  const names: Record<MMStream['kind'], string> = {
    POSE: 'Pose', HAND_LEFT: 'Hand L', HAND_RIGHT: 'Hand R', FACE: 'Face', CUSTOM: busAddress ?? 'Stream',
  };
  return {
    id: nextStreamId++,
    name: names[kind],
    kind, source, busAddress,
    visible: true, select: false, parent: null,
    translation: [0, 0, upAxis === 'Z' ? 1 : 0],
    // local frames are Y-up; stand the figure upright in Z-up worlds
    rotation: upAxis === 'Z' ? [Math.PI / 2, 0, 0] : [0, 0, 0],
    scale: [2, 2, 2],
    mirror: true,
    pointSize: 0.04,
    color: kind === 'POSE' ? [0.35, 0.8, 1] : kind === 'FACE' ? [1, 0.8, 0.35] : [0.55, 1, 0.5],
    confidenceAlpha: true,
    confidenceSize: false,
    emitBus: true,
  };
}

/** Stream -> world transform. Mirror (webcam selfie view) is baked in here
 *  so the rendered points, streamLandmarkWorld(), and the bus re-emit all
 *  agree on where a landmark is. */
export function streamWorldMatrix(scene: GPScene, st: MMStream): THREE.Matrix4 {
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(...st.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...st.rotation)),
    new THREE.Vector3(...st.scale),
  );
  if (st.mirror) local.multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
  if (!st.parent) return local;
  return worldMatrixOf(scene, st.parent as ObjRef).multiply(local);
}

/** World-space position of one landmark (for pens/cursors/travelers). */
export function streamLandmarkWorld(scene: GPScene, st: MMStream, index: number): Vec3 | null {
  const frame = streamStore.get(st.id);
  if (!frame || index < 0 || index >= frame.count) return null;
  const v = new THREE.Vector3(
    frame.data[index * 4], frame.data[index * 4 + 1], frame.data[index * 4 + 2],
  ).applyMatrix4(streamWorldMatrix(scene, st));
  return [v.x, v.y, v.z];
}

/** bus address path segment per kind ('/mm' + '/pose/0' etc.) */
export function streamBusPath(kind: MMStream['kind']): string {
  switch (kind) {
    case 'POSE': return 'pose';
    case 'HAND_LEFT': return 'hand/l';
    case 'HAND_RIGHT': return 'hand/r';
    case 'FACE': return 'face';
    default: return 'stream';
  }
}

interface BusSub { address: string; unsub: () => void; points: Map<number, [number, number, number, number]> }

/** Keeps BUS-sourced streams fed and re-emits CAMERA streams onto the bus.
 *  Call sync(scene) once per frame (cheap diff). */
export class MMStreamEngine {
  private subs = new Map<number, BusSub>();

  sync(scene: GPScene): void {
    // subscribe BUS streams whose address changed / appeared
    for (const st of scene.mmStreams) {
      if (st.source !== 'BUS' || !st.busAddress) continue;
      const cur = this.subs.get(st.id);
      if (cur && cur.address === st.busAddress) continue;
      cur?.unsub();
      const points = new Map<number, [number, number, number, number]>();
      const address = st.busAddress;
      const unsub = bus.on(`${address}/*`, (ev) => {
        const idx = Number(ev.address.slice(address.length + 1));
        if (!Number.isFinite(idx)) return;
        const n = ev.args.filter((a): a is number => typeof a === 'number');
        if (n.length < 2) return;
        points.set(idx, [n[0], n[1], n[2] ?? 0, n[3] ?? 1]);
        // repack on every event burst; frames are small (tens of points)
        const count = Math.max(...points.keys()) + 1;
        const data = new Float32Array(count * 4);
        for (const [i, p] of points) data.set(p, i * 4);
        streamStore.push(st.id, data, count);
      });
      this.subs.set(st.id, { address, unsub, points });
    }
    // drop subscriptions for removed streams
    for (const [id, sub] of this.subs) {
      const st = scene.mmStreams.find((s) => s.id === id);
      if (!st || st.source !== 'BUS') { sub.unsub(); this.subs.delete(id); streamStore.drop(id); }
    }
  }

  /** Re-emit CAMERA-stream landmarks in WORLD space so existing rigs/routes/
   *  trigger zones can bind to them exactly like external mediamime data. */
  emit(scene: GPScene): void {
    const prefix = scene.mediamime.prefix || '/mm';
    const now = performance.now();
    for (const st of scene.mmStreams) {
      if (st.source !== 'CAMERA' || !st.emitBus) continue;
      const frame = streamStore.get(st.id);
      // only fresh frames — a stopped camera must not re-broadcast its last
      // pose onto the bus forever
      if (!frame || now - frame.t > 250) continue;
      const m = streamWorldMatrix(scene, st);
      const v = new THREE.Vector3();
      const path = `${prefix}/${streamBusPath(st.kind)}`;
      for (let i = 0; i < frame.count; i++) {
        v.set(frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2]).applyMatrix4(m);
        bus.send(`mm:${st.id}`, `${path}/${i}`, v.x, v.y, v.z, frame.data[i * 4 + 3]);
      }
    }
  }

  dispose(): void {
    for (const sub of this.subs.values()) sub.unsub();
    this.subs.clear();
  }
}

export const mmStreamEngine = new MMStreamEngine();
