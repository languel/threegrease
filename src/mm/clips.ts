// Clips: recorded point-sets-over-time ("splats × time") — the capture
// layer between live streams and persistent artwork. One minimal concept
// covers every source: a whole MM stream (count=N points/frame) or any
// object's world origin (travelers, followers, rigged things — count=1).
// Frames store WORLD-space [x,y,z,confidence] so recordings are
// placement-independent ("what you saw is what you recorded").
//
// Playback deliberately reuses the STREAM concept: a CLIP-source MMStream
// replays frames through the same streamStore the camera writes into —
// identical rendering, constraints (FOLLOW_STREAM), bus re-emit, and
// trigger probing as live data. Its own transform (identity by default)
// then re-places the replay anywhere.
//
// Bake turns one landmark's trajectory (or all of them) into GP strokes
// with confidence→pressure — clips become PATHS, and the whole existing
// traveler/trigger/path ecosystem picks them up.
import * as THREE from 'three';
import type { GPScene, LoopMode, TGClip, Vec3 } from '../core/types';
import { createFrame, createObject, createStroke, createPoint, genId } from '../core/gpdata';
import { objectName, worldMatrixOf, type ObjRef } from '../tools/objects';
import { advancePhase, samplePhase } from '../score/engine';
import { streamStore, streamWorldMatrix } from './streams';

export type RecordSource =
  | { kind: 'STREAM'; id: number }
  | { kind: 'OBJECT'; ref: ObjRef };

interface ActiveRecording {
  source: RecordSource;
  label: string;
  count: number;               // fixed per clip (first frame decides)
  frames: { t: number; data: number[] }[];
  t0: number;
  lastStreamVersion: number;
  lastObjectSample: number;
}

export class ClipRecorder {
  active: ActiveRecording | null = null;

  isRecording(source?: RecordSource): boolean {
    if (!this.active) return false;
    if (!source) return true;
    const a = this.active.source;
    return a.kind === source.kind && (
      a.kind === 'STREAM'
        ? a.id === (source as { id: number }).id
        : a.ref.kind === (source as { ref: ObjRef }).ref.kind && a.ref.id === (source as { ref: ObjRef }).ref.id);
  }

  start(scene: GPScene, source: RecordSource): void {
    // The clip's display name is the label's LAST segment, so the object's
    // own name has to be last — `object:ACTOR:20` named every recorded walk
    // "20", which is unreadable once a scene has a few of them.
    const label = source.kind === 'STREAM'
      ? `stream:${scene.mmStreams.find((s) => s.id === source.id)?.name ?? source.id}`
      : `object:${source.ref.kind.toLowerCase()}:${objectName(scene, source.ref)}`;
    this.active = {
      source, label, count: 0, frames: [],
      t0: performance.now(), lastStreamVersion: -1, lastObjectSample: 0,
    };
  }

  /** Stop and commit the recording as a TGClip (null if nothing captured). */
  stop(scene: GPScene): TGClip | null {
    const rec = this.active;
    this.active = null;
    if (!rec || !rec.frames.length) return null;
    const clip: TGClip = {
      id: genId(),
      name: `${rec.label.split(':').pop()} ${new Date().toLocaleTimeString()}`,
      source: rec.label,
      count: rec.count,
      duration: rec.frames[rec.frames.length - 1].t,
      frames: rec.frames,
    };
    scene.clips.push(clip);
    return clip;
  }

  /** Per-frame sampling. STREAM sources sample on store-version change
   *  (capture rate); OBJECT sources sample on a ~60Hz clock. */
  tick(scene: GPScene): void {
    const rec = this.active;
    if (!rec) return;
    const now = performance.now();
    if (rec.source.kind === 'STREAM') {
      const st = scene.mmStreams.find((s) => s.id === (rec.source as { id: number }).id);
      if (!st) { this.active = null; return; }
      const ver = streamStore.version.get(st.id) ?? -1;
      if (ver === rec.lastStreamVersion) return;
      rec.lastStreamVersion = ver;
      const frame = streamStore.get(st.id);
      if (!frame || !frame.count) return;
      if (!rec.count) rec.count = frame.count;
      if (frame.count !== rec.count) return; // hand left frame etc. — skip
      const m = streamWorldMatrix(scene, st);
      const v = new THREE.Vector3();
      const data = new Array<number>(frame.count * 4);
      for (let i = 0; i < frame.count; i++) {
        v.set(frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2]).applyMatrix4(m);
        data[i * 4] = +v.x.toFixed(5);
        data[i * 4 + 1] = +v.y.toFixed(5);
        data[i * 4 + 2] = +v.z.toFixed(5);
        data[i * 4 + 3] = +frame.data[i * 4 + 3].toFixed(3);
      }
      rec.frames.push({ t: Math.round(now - rec.t0), data });
    } else {
      if (now - rec.lastObjectSample < 15) return;
      rec.lastObjectSample = now;
      const p = new THREE.Vector3().setFromMatrixPosition(
        worldMatrixOf(scene, (rec.source as { ref: ObjRef }).ref));
      rec.count = 1;
      rec.frames.push({
        t: Math.round(now - rec.t0),
        data: [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5), 1],
      });
    }
  }
}

export const clipRecorder = new ClipRecorder();

/** Advance + resample every CLIP-source stream into the frame store.
 *  Runs the same traveler clock semantics as FOLLOW_PATH (loop modes,
 *  speed as a realtime multiplier, scrubbing via phase). */
export function updateClipStreams(scene: GPScene, dt: number): void {
  for (const st of scene.mmStreams) {
    if (st.source !== 'CLIP' || st.clipId == null) continue;
    const clip = scene.clips.find((c) => c.id === st.clipId);
    if (!clip || !clip.frames.length) continue;
    // phase runs over the TRIM WINDOW (non-destructive crop): speed 1 =
    // the window's real duration
    const w0 = (clip.trimStart ?? 0) * clip.duration;
    const w1 = Math.max(w0, (clip.trimEnd ?? 1) * clip.duration);
    const durationS = Math.max(0.001, (w1 - w0) / 1000);
    const prevPhase = st.phase ?? 0;
    if (st.playing) {
      const [p, running] = advancePhase(prevPhase, (st.speed ?? 1) / durationS, dt, st.loop ?? 'LOOP');
      st.phase = p;
      if (!running) st.playing = false;
    }
    const t = w0 + samplePhase(st.phase ?? 0, (st.loop ?? 'LOOP') as LoopMode) * (w1 - w0);
    // bracketing frames + lerp
    let i = 0;
    while (i < clip.frames.length - 1 && clip.frames[i + 1].t < t) i++;
    const a = clip.frames[i];
    const b = clip.frames[Math.min(i + 1, clip.frames.length - 1)];
    const span = Math.max(1, b.t - a.t);
    const k = Math.max(0, Math.min(1, (t - a.t) / span));
    const n = Math.min(a.data.length, b.data.length) / 4;
    const data = new Float32Array(n * 4);
    for (let j = 0; j < n * 4; j++) data[j] = a.data[j] + (b.data[j] - a.data[j]) * k;
    streamStore.push(st.id, data, n);
  }
}

/** Make the trim window permanent: drop outside frames, retime to 0. */
export function cropClip(clip: TGClip): void {
  const w0 = (clip.trimStart ?? 0) * clip.duration;
  const w1 = Math.max(w0, (clip.trimEnd ?? 1) * clip.duration);
  clip.frames = clip.frames.filter((f) => f.t >= w0 && f.t <= w1)
    .map((f) => ({ t: f.t - w0, data: f.data }));
  clip.duration = clip.frames.length ? clip.frames[clip.frames.length - 1].t : 0;
  clip.trimStart = 0;
  clip.trimEnd = 1;
}

/** Bake a clip into GP strokes (one per landmark, confidence → pressure)
 *  inside a NEW GP object at identity — clips become paths the existing
 *  traveler/trigger system rides. Returns the new object's id. */
export function bakeClipToStrokes(scene: GPScene, clip: TGClip, landmark = -1): number {
  const ob = createObject(`clip: ${clip.name}`);
  const layer = ob.layers[0];
  const frame = createFrame(scene.frame);
  layer.frames.push(frame);
  const w0 = (clip.trimStart ?? 0) * clip.duration;
  const w1 = Math.max(w0, (clip.trimEnd ?? 1) * clip.duration);
  const frames = clip.frames.filter((f) => f.t >= w0 && f.t <= w1);
  const indices = landmark >= 0 ? [landmark] : Array.from({ length: clip.count }, (_, i) => i);
  for (const li of indices) {
    if (li >= clip.count) continue;
    const stroke = createStroke(0, 3);
    for (const f of frames) {
      const x = f.data[li * 4], y = f.data[li * 4 + 1], z = f.data[li * 4 + 2];
      const conf = f.data[li * 4 + 3] ?? 1;
      const p = createPoint([x, y, z] as Vec3, Math.max(0.05, conf), Math.max(0.05, conf));
      stroke.points.push(p);
    }
    if (stroke.points.length > 1) frame.strokes.push(stroke);
  }
  scene.objects.push(ob);
  return ob.id;
}
