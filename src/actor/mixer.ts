// The animation mixer: one place where every source of motion is weighed.
//
// An actor has more than one thing trying to pose it at once — a capture
// rig, the procedural gait, a recorded clip, a hand drag, an OSC route, and
// eventually a generative model. Before this existed they all pushed goals
// straight at the solver, which applied them in sequence: each one lerped
// the pose toward its own answer, so the LAST source to run won in
// proportion to its weight and the result depended on which engine happened
// to be called first in the frame. That is not a blend, it is a race.
//
// Two pieces fix it, and they are deliberately separate:
//
//  - The SOLVER now resolves every contribution to a joint into one goal
//    (weighted mean, summed pull) instead of applying them one after
//    another. That makes "two sources want this ankle" well-defined no
//    matter who asks.
//  - This MIXER decides how loudly each source is allowed to ask. A layer
//    carries a weight and a body mask, so "the capture owns the upper body,
//    the walk owns the legs" is a two-line stack rather than a special case
//    wired into the rig.
//
// Layers are scene data (they are authorship, and they undo); crossfades
// are runtime (they are performance, and they must not land in an undo
// snapshot). A layer's weight is what you author; a fade scales it live
// without touching it, which is what lets a piece hand control from a clip
// to the gait mid-show and still save the file you started with.
//
// Sources ask `gain()` for their own multiplier rather than the mixer
// calling the sources. That keeps every producer in charge of its own
// timing and state — the gait still advances its cycle while muted, so
// unmuting does not restart mid-step — and it means a scene with no layer
// stack at all (an older file) gets gain 1 and behaves exactly as before.
import type { GPScene, TGActor, TGActorLayer, ActorLayerSource, LoopMode } from '../core/types';
import { actorSolver } from './solver';
import { clipWindowSeconds, sampleClipFrame } from '../mm/clips';
import { worldMatrixOf } from '../tools/objects';
import * as THREE from 'three';
import { advancePhase } from '../score/engine';

/** Which joints a mask covers. Names are the skeleton's own vocabulary
 *  (see actor/skeleton.ts), so a mask is a name test, not an index list —
 *  a retargeted or hand-built skeleton with the same names masks the same
 *  way. Membership is binary on purpose: a soft falloff across the waist
 *  sounds better than it looks, and it hides which layer actually moved a
 *  joint when something goes wrong. */
const ARM = /^(shoulder|elbow|wrist|hand)\./;
const LEG = /^(hip|knee|ankle|foot)\./;
const SPINE = /^(hips|spine|chest|neck|head)$/;
const HEAD = /^(neck|head)$/;

export function maskHas(mask: TGActorLayer['mask'], joint: string): boolean {
  switch (mask) {
    case 'ALL': return true;
    case 'ARMS': return ARM.test(joint);
    case 'LEGS': return LEG.test(joint);
    case 'SPINE': return SPINE.test(joint);
    case 'HEAD': return HEAD.test(joint);
    // UPPER/LOWER split at the pelvis: `hips` belongs to the LOWER body
    // because it is what a walk cycle drives, and an upper-body layer that
    // also claimed the pelvis would fight the bob on every step.
    case 'UPPER': return ARM.test(joint) || /^(spine|chest|neck|head)$/.test(joint);
    case 'LOWER': return LEG.test(joint) || joint === 'hips';
    default: return true;
  }
}

export const MASK_LABELS: [TGActorLayer['mask'], string][] = [
  ['ALL', 'Whole body'],
  ['UPPER', 'Upper body'],
  ['LOWER', 'Lower body'],
  ['ARMS', 'Arms'],
  ['LEGS', 'Legs'],
  ['SPINE', 'Spine + head'],
  ['HEAD', 'Head'],
];

export const SOURCE_LABELS: [ActorLayerSource, string][] = [
  ['RIG', 'Capture rig'],
  ['GAIT', 'Procedural walk'],
  ['CLIP', 'Recorded clip'],
  ['MANUAL', 'Manual — drag, routes, agent'],
];

interface Fade {
  from: number;
  to: number;
  /** seconds elapsed */
  t: number;
  dur: number;
}

export class ActorMixer {
  /** live crossfades, keyed `actorId:layerId` — runtime, never serialized */
  private fades = new Map<string, Fade>();
  /** settled fade values for layers that finished fading */
  private held = new Map<string, number>();

  reset(actorId?: number): void {
    if (actorId === undefined) { this.fades.clear(); this.held.clear(); return; }
    for (const k of [...this.fades.keys()]) if (k.startsWith(`${actorId}:`)) this.fades.delete(k);
    for (const k of [...this.held.keys()]) if (k.startsWith(`${actorId}:`)) this.held.delete(k);
  }

  /** Ramp a layer's live multiplier to `to` over `seconds` (0 = instant). */
  fadeTo(actorId: number, layerId: number, to: number, seconds = 0.35): void {
    const key = `${actorId}:${layerId}`;
    const from = this.fadeFactor(actorId, layerId);
    const t = Math.max(0, Math.min(1, to));
    if (seconds <= 0) {
      this.fades.delete(key);
      this.held.set(key, t);
      return;
    }
    this.fades.set(key, { from, to: t, t: 0, dur: seconds });
  }

  /** Live multiplier on a layer's authored weight, 0..1. */
  fadeFactor(actorId: number, layerId: number): number {
    const key = `${actorId}:${layerId}`;
    const f = this.fades.get(key);
    if (!f) return this.held.get(key) ?? 1;
    const k = Math.min(1, f.t / f.dur);
    return f.from + (f.to - f.from) * (k * k * (3 - 2 * k));
  }

  /**
   * Advance crossfades, then play any CLIP layers. Call once per frame,
   * BEFORE any other source emits — the fades have to be current before
   * anything asks `gain()`, and a clip is the one source the mixer drives
   * itself (nothing else owns a recorded performance).
   */
  update(scene: GPScene, dt: number, upZ = true): void {
    this.advanceFades(scene, dt);
    for (const actor of scene.actors) {
      const moved = this.travelled(scene, actor, upZ);
      for (const layer of actor.layers ?? []) {
        if (layer.source === 'CLIP') this.playClip(scene, actor, layer, dt, moved);
      }
    }
  }

  private advanceFades(scene: GPScene, dt: number): void {
    if (!this.fades.size) return;
    const live = new Set<string>();
    for (const a of scene.actors) for (const l of a.layers ?? []) live.add(`${a.id}:${l.id}`);
    for (const [key, f] of [...this.fades]) {
      if (!live.has(key)) { this.fades.delete(key); this.held.delete(key); continue; }
      f.t += dt;
      if (f.t >= f.dur) {
        this.fades.delete(key);
        this.held.set(key, f.to);
      }
    }
  }

  /**
   * Play a recorded performance onto the skeleton. Joints are matched by
   * NAME, not by index: a clip recorded on one actor plays on another with
   * the same vocabulary, and it survives a skeleton edited between take and
   * playback. A clip with no `joints` list is a world-space landmark or
   * path recording, not a pose — those replay as CLIP streams instead, and
   * driving joints with them would plant the character at the origin.
   */
  private playClip(
    scene: GPScene, actor: TGActor, layer: TGActorLayer, dt: number, moved: number,
  ): void {
    if (!layer.enabled || layer.clipId == null) return;
    const clip = scene.clips.find((c) => c.id === layer.clipId);
    if (!clip?.frames.length || !clip.joints?.length) return;

    const loop = (layer.loop ?? 'LOOP') as LoopMode;
    if (layer.playing !== false) {
      const windowSec = clipWindowSeconds(clip);
      let rate = (layer.speed ?? 1) / windowSec;
      let step = dt;
      if (layer.phaseBy === 'DISTANCE' && (clip.impliedSpeed ?? 0) > 0.05) {
        // Advance on ground covered instead of on the clock: one clip's
        // worth of phase per (impliedSpeed * window) metres. A character
        // walking at half the speed the clip was made at now takes
        // half-length steps instead of skating.
        const metresPerCycle = clip.impliedSpeed! * windowSec;
        rate = (layer.speed ?? 1) / metresPerCycle;
        step = moved;
      }
      const [p, running] = advancePhase(layer.phase ?? 0, rate, step, loop);
      layer.phase = p;
      if (!running) layer.playing = false;
    }
    const frame = sampleClipFrame(clip, layer.phase ?? 0, loop);
    if (!frame) return;

    const weight = Math.max(0, Math.min(1, layer.weight))
      * this.fadeFactor(actor.id, layer.id);
    if (weight < 0.001) return;

    const index = this.jointIndex(actor);
    const n = Math.min(frame.count, clip.joints.length);
    for (let i = 0; i < n; i++) {
      const name = clip.joints[i];
      if (!maskHas(layer.mask, name)) continue;
      const ji = index.get(name);
      if (ji === undefined) continue;
      const conf = frame.data[i * 4 + 3];
      const w = weight * (conf > 0 ? Math.min(1, conf) : 1);
      if (w < 0.001) continue;
      actorSolver.addTarget(actor.id, {
        index: ji,
        pos: [frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2]],
        weight: w,
      });
    }
  }

  /** name -> joint index, rebuilt only when the skeleton changes shape */
  private nameCache = new Map<number, { n: number; map: Map<string, number> }>();
  /** last world position per actor, for distance-phased clips */
  private lastPos = new Map<number, THREE.Vector3>();

  /**
   * Ground covered by this actor since the previous frame.
   *
   * Vertical motion is excluded — that is bob, not progress — and a jump
   * across the room is rejected as a teleport rather than fast-forwarding
   * the clip through several strides, the same guard the gait uses.
   */
  private travelled(scene: GPScene, actor: TGActor, upZ: boolean): number {
    const p = new THREE.Vector3().setFromMatrixPosition(
      worldMatrixOf(scene, { kind: 'ACTOR', id: actor.id }));
    const prev = this.lastPos.get(actor.id);
    this.lastPos.set(actor.id, p.clone());
    if (!prev) return 0;
    const d = p.clone().sub(prev);
    d.setComponent(upZ ? 2 : 1, 0);
    const len = d.length();
    return len > 1.5 ? 0 : len;
  }

  private jointIndex(actor: TGActor): Map<string, number> {
    const hit = this.nameCache.get(actor.id);
    if (hit && hit.n === actor.joints.length) return hit.map;
    const map = new Map(actor.joints.map((j, i) => [j.name, i]));
    this.nameCache.set(actor.id, { n: actor.joints.length, map });
    return map;
  }

  /** First layer driven by this source, or undefined. */
  layerFor(actor: TGActor, source: ActorLayerSource): TGActorLayer | undefined {
    return (actor.layers ?? []).find((l) => l.source === source);
  }

  /**
   * How much of its goal a source may ask for on one joint, 0..1. Multiply
   * whatever weight the source would have used by this; 0 means "don't
   * bother emitting". An actor with no layer stack returns 1, so nothing
   * has to know whether the stack exists.
   */
  gain(actor: TGActor, source: ActorLayerSource, joint: string): number {
    const layers = actor.layers;
    if (!layers?.length) return 1;
    const l = layers.find((x) => x.source === source);
    if (!l) return 1;
    if (!l.enabled || !maskHas(l.mask, joint)) return 0;
    return Math.max(0, Math.min(1, l.weight)) * this.fadeFactor(actor.id, l.id);
  }
}

export const actorMixer = new ActorMixer();

/** The stack a fresh actor gets: every built-in source, wide open, in the
 *  order they run. Starting fully open rather than empty means adding the
 *  mixer changed nothing about how an existing character behaves — you
 *  reach for it when you want to mask or fade, not to switch it on. */
export function defaultLayers(): TGActorLayer[] {
  return [
    { id: 1, name: 'Capture', enabled: true, weight: 1, mask: 'ALL', source: 'RIG' },
    { id: 2, name: 'Walk', enabled: true, weight: 1, mask: 'ALL', source: 'GAIT' },
    { id: 3, name: 'Manual', enabled: true, weight: 1, mask: 'ALL', source: 'MANUAL' },
  ];
}

/** Actor-local layer ids, like joints and bones — not genId(). */
export function nextLayerId(actor: TGActor): number {
  return (actor.layers ?? []).reduce((m, l) => Math.max(m, l.id), 0) + 1;
}
