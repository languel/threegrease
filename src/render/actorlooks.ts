// How an actor is DRAWN, as a handful of named presets.
//
// The mannequin is a rig you work on; an avatar is a character you look at,
// and an installation gets staged with people watching it. Both are the
// same skeleton — a look changes nothing about joints, bones, physics or
// motion. It is purely how the same pose is rendered.
//
// Every preset is expressed as multipliers on what the skeleton already
// knows (bone radius, joint radius) rather than as its own geometry. That
// is what keeps a look from drifting away from the thing it is drawing: a
// scaled actor, a retargeted one, or a hand-built skeleton with different
// proportions all still get a coherent figure, because the figure IS the
// proportions.
//
// Colour is applied ONCE when a look is picked, not enforced every frame,
// so a look is a starting point and the colour stays yours afterwards.
import type { Vec3 } from '../core/types';

export type ActorLook = 'DEFAULT' | 'WOOD' | 'MINIMAL' | 'CLAY';

export interface LookSpec {
  label: string;
  /** multiplier on bone.radius for the limb tubes */
  limb: number;
  /** multiplier on joint.radius for the joint beads */
  joint: number;
  /** top/bottom radius ratio of a limb; < 1 tapers toward the child joint */
  taper: number;
  /** limb ends are capped — matters once the tube is fat enough to see into */
  capped: boolean;
  roughness: number;
  metalness: number;
  /** faceted rather than smooth — reads as carved/moulded */
  flat: boolean;
  /** ignore scene lights: a graphic, not an object in the room */
  unlit: boolean;
  /** per-joint size multipliers, by name prefix — what gives a look a face
   *  even without one: a big head and small hands read as a character */
  emphasis: Record<string, number>;
  /**
   * per-LIMB multipliers, keyed by the joint the bone ends at. Needed
   * because "chunky" cannot come from one global radius on this skeleton:
   * the legs are 0.20 m apart and the arms hang 0.21 m off the spine, so
   * past about 1.15x the tubes swallow each other and the figure reads as
   * one undifferentiated mass. Thickening the head, hands and feet instead
   * is both more legible and closer to how stop-motion characters are
   * actually built.
   */
  limbEmphasis: Record<string, number>;
  /** stretch the head along the up axis: 1 is a ball, >1 an egg. A real lay
   *  figure's head is a turned ovoid, and that single ratio is most of why
   *  it reads as carved rather than as a snowman. */
  headOvoid: number;
  /** applied to actor.color when the look is chosen */
  color: Vec3;
  hint: string;
}

export const ACTOR_LOOKS: Record<ActorLook, LookSpec> = {
  DEFAULT: {
    label: 'Mannequin',
    limb: 1, joint: 0.55, taper: 1, capped: false,
    roughness: 0.75, metalness: 0, flat: false, unlit: false,
    // 1.15 holds the head at the size it read at before the skeleton's own
    // head shrank — this look was never the one with the problem
    emphasis: { head: 1.15 },
    limbEmphasis: {},
    headOvoid: 1,
    color: [0.72, 0.74, 0.80],
    hint: 'the working rig — even tubes, small beads, neutral grey',
  },
  WOOD: {
    label: 'Wooden mannequin',
    // The whole read of an artist's mannequin is that the BALL JOINTS are
    // proud of the limbs: you can see how it articulates. So the beads are
    // large and the limbs taper into them.
    limb: 0.92, joint: 0.86, taper: 0.68, capped: true,
    roughness: 0.45, metalness: 0, flat: false, unlit: false,
    emphasis: { head: 1.05, hips: 1.15, chest: 1.1, hand: 0.85, foot: 0.9 },
    // the neck is a slim PEG between the shoulder line and the head, which
    // is the join a lay figure shows off rather than hides
    limbEmphasis: { neck: 0.55, head: 0.62 },
    headOvoid: 1.32,
    color: [0.78, 0.58, 0.34],
    hint: 'artist’s lay figure — turned limbs, proud ball joints, warm wood',
  },
  MINIMAL: {
    label: 'Minimal figure',
    // Thin enough to read as drawing rather than as a body, unlit so it
    // keeps the same weight from every angle and against any background.
    limb: 0.3, joint: 0.42, taper: 1, capped: false,
    roughness: 1, metalness: 0, flat: false, unlit: true,
    // 1.75 keeps this figure EXACTLY the size it was before the skeleton's
    // head shrank; it was the one look that already read correctly
    emphasis: { head: 1.75, hand: 0.7, foot: 0.7 },
    limbEmphasis: {},
    headOvoid: 1,
    color: [0.93, 0.93, 0.96],
    hint: 'stylised stick figure — thin lines, one flat tone, no lighting',
  },
  CLAY: {
    label: 'Clay figure',
    // Chunky BUT LEGIBLE, and the two fight each other. Fattening every
    // limb equally just merges them — the legs are only 0.20 m apart. So
    // the chunk goes where it reads instead: an oversized head, big hands
    // and feet, a slightly stocky torso, and arms and legs left near their
    // real thickness so the silhouette still has a figure in it. That is
    // also how stop-motion characters are actually proportioned.
    limb: 1.12, joint: 1.05, taper: 0.9, capped: true,
    roughness: 0.95, metalness: 0, flat: false, unlit: false,
    emphasis: { head: 1.6, hand: 1.55, foot: 1.35, hips: 1.15, chest: 1.1 },
    limbEmphasis: { spine: 1.25, chest: 1.25, neck: 0.5, head: 0.5, hand: 1.2, foot: 1.2 },
    headOvoid: 1.1,
    color: [0.91, 0.70, 0.58],
    hint: 'stop-motion chunk — big head and hands, stocky torso, matte clay',
  },
};

export function lookSpec(look: ActorLook | undefined): LookSpec {
  return ACTOR_LOOKS[look ?? 'DEFAULT'] ?? ACTOR_LOOKS.DEFAULT;
}

function byPrefix(table: Record<string, number>, name: string): number {
  for (const key of Object.keys(table)) {
    if (name === key || name.startsWith(`${key}.`)) return table[key];
  }
  return 1;
}

/** Size multiplier for one joint under a look (name-prefix matched). */
export function jointEmphasis(spec: LookSpec, name: string): number {
  return byPrefix(spec.emphasis, name);
}

/** Thickness multiplier for one limb, keyed by the joint it ends at. */
export function limbEmphasis(spec: LookSpec, childJoint: string): number {
  return byPrefix(spec.limbEmphasis, childJoint);
}

export const LOOK_OPTIONS: [ActorLook, string][] =
  (Object.keys(ACTOR_LOOKS) as ActorLook[]).map((k) => [k, ACTOR_LOOKS[k].label]);
