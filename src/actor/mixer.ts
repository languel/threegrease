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
import type { GPScene, TGActor, TGActorLayer, ActorLayerSource } from '../core/types';

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

  /** Advance crossfades. Call once per frame, before any source emits. */
  update(scene: GPScene, dt: number): void {
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
