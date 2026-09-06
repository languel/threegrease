// What a character is doing right now, in one word.
//
// The monologue says what someone INTENDS; this says what is actually
// happening to them, which is not always the same thing and is exactly
// where the interesting bugs live. A character can be intending to reach
// the platform while in fact standing still against a wall, and the pose
// alone will not tell you which.
//
// It is derived, never stored: reading the same state the engines act on
// means the badge cannot claim something the character is not doing.
import type { GPScene, TGActor } from '../core/types';
import { steerEngine } from './steering';
import { gaitEngine } from './gait';

export type StateTone = 'route' | 'walk' | 'climb' | 'look' | 'idle' | 'stuck' | 'drive';

export interface ActorState {
  label: string;
  tone: StateTone;
  color: string;
}

const COLOR: Record<StateTone, string> = {
  route: '#8fd2ff',   // on rails
  walk: '#9ee89b',    // steering itself somewhere
  climb: '#ffd166',   // gaining height
  look: '#c7a6ff',    // turning on the spot
  idle: '#9a9aa2',    // standing
  stuck: '#ff8f8f',   // gave up
  drive: '#ffc98f',   // you have the controls
};

/** Height gained per actor since the last sample, for the climb badge. */
const lastUp = new Map<number, number>();

export function actorState(
  scene: GPScene, actor: TGActor, upZ: boolean, possessedId: number | null,
): ActorState {
  const upAxis = upZ ? 2 : 1;
  const up = actor.translation[upAxis];
  const rose = up - (lastUp.get(actor.id) ?? up);
  lastUp.set(actor.id, up);

  const mk = (label: string, tone: StateTone): ActorState =>
    ({ label, tone, color: COLOR[tone] });

  if (possessedId === actor.id) return mk('driving', 'drive');

  const st = actor.steer;
  if (st?.stuck) return mk('stuck', 'stuck');
  if (st && st.mode === 'FACE' && !st.arrived) return mk('looking', 'look');

  // Climbing beats walking: it is the more specific fact, and it is the one
  // you are squinting at the screen trying to confirm.
  if (rose > 0.004) return mk('climbing', 'climb');

  const speed = gaitEngine.speedOf(actor.id);
  if (steerEngine.active(actor)) {
    return mk(speed > 0.15 ? 'walking' : 'setting off', 'walk');
  }
  const onPath = (actor.constraints ?? []).some(
    (c) => c.enabled && c.type === 'FOLLOW_PATH' && c.running);
  if (onPath && speed > 0.05) return mk('on route', 'route');
  if (speed > 0.15) return mk('walking', 'walk');
  return mk('idle', 'idle');
}
