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
import type { GPScene, TGActor, TGActorLayer } from '../core/types';
import { actorMixer } from './mixer';
import { steerEngine } from './steering';
import { gaitEngine } from './gait';

export type StateTone = 'route' | 'walk' | 'climb' | 'look' | 'idle' | 'stuck' | 'drive';

export interface ActorState {
  label: string;
  tone: StateTone;
  color: string;
  /** WHICH system is producing the pose right now — the question you
   *  actually have when several of them can. */
  driver: string;
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

/**
 * Which system is posing this actor.
 *
 * Read off the live layer stack rather than guessed, and it names the
 * BACKEND for a generated clip — "synth" and "ARDY" produce the same kind of
 * object through the same seam, so from the outside they are otherwise
 * indistinguishable, which is the point of the seam and also why you need to
 * be told.
 */
function driverOf(scene: GPScene, actor: TGActor, possessed: boolean): string {
  if (possessed) return 'you';
  // The LOUDEST clip layer, not the first. During a crossfade two are live
  // at once, and taking the first named the one on its way out — so the
  // badge went on claiming ARDY after a synth clip had replaced it.
  let live: TGActorLayer | undefined;
  let best = 0.05;
  for (const l of actor.layers ?? []) {
    if (l.source !== 'CLIP' || !l.enabled || l.clipId == null) continue;
    const w = l.weight * actorMixer.fadeFactor(actor.id, l.id);
    if (w > best) { best = w; live = l; }
  }
  if (live) {
    const clip = scene.clips.find((c) => c.id === live.clipId);
    const src = clip?.source ?? '';
    if (src.startsWith('ardy:') || src === 'generated:ardy') return 'ARDY';
    if (src === 'generated:local') return 'synth';
    if (src === 'generated:remote') return 'remote';
    if (src.startsWith('gltf:')) return 'import';
    return 'clip';
  }
  if (actor.rig?.mode && actor.rig.mode !== 'NONE' && actor.rig.mode !== 'MANUAL'
    && actor.rig.streamId != null) return 'capture';
  const gait = (actor.layers ?? []).find((l) => l.source === 'GAIT');
  if (actor.gait?.enabled && (!gait || gait.enabled)) return 'gait';
  return 'still';
}

export function actorState(
  scene: GPScene, actor: TGActor, upZ: boolean, possessedId: number | null,
): ActorState {
  const upAxis = upZ ? 2 : 1;
  const up = actor.translation[upAxis];
  const rose = up - (lastUp.get(actor.id) ?? up);
  lastUp.set(actor.id, up);

  const driver = driverOf(scene, actor, possessedId === actor.id);
  const mk = (label: string, tone: StateTone): ActorState =>
    ({ label, tone, color: COLOR[tone], driver });

  if (possessedId === actor.id) return mk('driving', 'drive');

  const st = actor.steer;
  if (st?.stuck) return mk('stuck', 'stuck');
  if (st && st.mode === 'FACE' && !st.arrived) return mk('looking', 'look');

  // Climbing beats walking: it is the more specific fact, and it is the one
  // you are squinting at the screen trying to confirm.
  if (rose > 0.004) return mk('climbing', 'climb');

  const speed = gaitEngine.speedOf(actor.id);
  // A gesture playing in place is not idling, whatever the feet are doing.
  if (driver === 'synth' || driver === 'ARDY' || driver === 'remote'
    || driver === 'import' || driver === 'clip') {
    if (!steerEngine.active(actor) && speed < 0.15) return mk('performing', 'look');
  }
  if (steerEngine.active(actor)) {
    return mk(speed > 0.15 ? 'walking' : 'setting off', 'walk');
  }
  const onPath = (actor.constraints ?? []).some(
    (c) => c.enabled && c.type === 'FOLLOW_PATH' && c.running);
  if (onPath && speed > 0.05) return mk('on route', 'route');
  if (speed > 0.15) return mk('walking', 'walk');
  return mk('idle', 'idle');
}
