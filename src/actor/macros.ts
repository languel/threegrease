// The Motion panel's buttons.
//
// A macro is a phrase plus, optionally, something to DO — so one click can
// mean both "move like this" and "and go over there". They live in the
// scene rather than in preferences because they are part of a piece: a
// class, an installation or a rehearsal builds its own vocabulary
// ("greeter", "bored visitor", "leaving") and that vocabulary should travel
// with the file, not with whoever's laptop it was authored on.
import type { GPScene, TGMotionMacro } from '../core/types';

/** A starting vocabulary — a demonstration of the shape, not a fixed set. */
export function defaultMotionMacros(): TGMotionMacro[] {
  return [
    { id: 1, label: 'Walk', prompt: 'a person walks forward at a normal pace', seconds: 4 },
    { id: 2, label: 'Wander', prompt: 'a person strolls slowly and looks around', seconds: 6 },
    { id: 3, label: 'Wait', prompt: 'a person stands still, shifting their weight', seconds: 5 },
    { id: 4, label: 'Greet', prompt: 'a person waves hello with one hand', seconds: 4 },
    { id: 5, label: 'Look up', prompt: 'a person stops and looks up at something tall', seconds: 4 },
    { id: 6, label: 'Sit', prompt: 'a person sits down', seconds: 4 },
    { id: 7, label: 'Leave', prompt: 'a person walks away briskly', seconds: 4 },
  ];
}

export function nextMacroId(scene: GPScene): number {
  return (scene.motionMacros ?? []).reduce((m, x) => Math.max(m, x.id), 0) + 1;
}
