// Direct commands: "walk here", "jump there".
//
// One place that turns a POINT and a VERB into scene state, so the same
// command means the same thing whether it came from a click in the
// viewport, the agent, or an OSC message. Everything here is expressed in
// terms that already exist — a steer goal moves the root, a style sets the
// gait's shape — rather than a parallel command system with its own
// animation. That is what keeps a clicked "sneak here" and a typed one and
// a generated clip all the same character.
import type { GPScene, TGActor, Vec3 } from '../core/types';
import { styleFromPrompt } from './generate';
import { steerEngine } from './steering';

export interface MoveAction {
  id: string;
  label: string;
  /** the style vocabulary — the same words the generator reads */
  prompt: string;
  /** how it gets there */
  kind: 'GO' | 'JUMP' | 'FACE' | 'STOP';
  hint: string;
}

export const MOVE_ACTIONS: MoveAction[] = [
  { id: 'walk', label: 'Walk here', prompt: 'walk', kind: 'GO', hint: 'click a spot' },
  { id: 'run', label: 'Run here', prompt: 'run', kind: 'GO', hint: 'click a spot' },
  { id: 'sneak', label: 'Sneak here', prompt: 'sneaking crouched', kind: 'GO', hint: 'click a spot' },
  { id: 'shuffle', label: 'Shuffle here', prompt: 'tired shuffle', kind: 'GO', hint: 'click a spot' },
  { id: 'march', label: 'March here', prompt: 'march', kind: 'GO', hint: 'click a spot' },
  { id: 'jump', label: 'Jump there', prompt: 'jump', kind: 'JUMP', hint: 'click where to land' },
  { id: 'face', label: 'Look here', prompt: '', kind: 'FACE', hint: 'click what to face' },
  { id: 'stop', label: 'Stop', prompt: 'idle', kind: 'STOP', hint: 'click anywhere' },
];

/** Write a style into the actor's live gait, so the WALK changes shape and
 *  not just the speed. The words are the generator's vocabulary, which is
 *  the point: one description drives a clip or a live cycle. */
export function applyStyleToGait(actor: TGActor, prompt: string): number {
  const st = styleFromPrompt(prompt);
  const speed = Math.max(0.15, st.cadence * st.stride);
  if (actor.gait) {
    actor.gait.enabled = true;
    actor.gait.strideLength = st.stride;
    actor.gait.stepHeight = st.stepHeight;
    actor.gait.stanceWidth = st.stanceWidth;
    actor.gait.dutyFactor = Math.min(0.9, Math.max(0.5, st.duty));
    actor.gait.bob = st.bob;
    actor.gait.armSwing = st.armSwing;
    actor.gait.walkSpeed = speed;
  }
  return speed;
}

/**
 * Run one command against one actor. Returns a short line for the status
 * hint, or null if nothing applied.
 */
export function runMoveAction(
  scene: GPScene, actorId: number, action: MoveAction, point: Vec3 | null, upZ: boolean,
): string | null {
  const actor = scene.actors.find((a) => a.id === actorId);
  if (!actor?.steer) return null;
  const st = actor.steer;

  if (action.kind === 'STOP') {
    st.mode = 'NONE';
    st.arrived = false;
    st.stuck = false;
    steerEngine.reset(actorId);
    applyStyleToGait(actor, 'idle');
    return `${actor.name}: stop`;
  }
  if (!point) return null;

  if (action.kind === 'FACE') {
    const upAxis = upZ ? 2 : 1;
    const d = [point[0] - actor.translation[0], point[1] - actor.translation[1],
      point[2] - actor.translation[2]];
    d[upAxis] = 0;
    if (Math.hypot(d[0], d[1], d[2]) < 1e-4) return null;
    // reuse the steer goal machinery: a FACE is a goal you are already
    // standing on, so the turn-rate limit applies and it does not snap
    st.mode = 'POINT';
    st.point = [
      actor.translation[0] + d[0], actor.translation[1] + d[1], actor.translation[2] + d[2],
    ] as Vec3;
    st.stopDistance = Math.max(st.stopDistance, 0.35);
    st.arrived = false;
    st.stuck = false;
    return `${actor.name}: look`;
  }

  if (action.kind === 'JUMP') {
    steerEngine.hopTo(actor, point, upZ);
    return `${actor.name}: jump`;
  }

  // GO — clear the previous goal's progress accounting, or a fresh
  // destination inherits the last one's stall timer and reports itself stuck
  // before it has taken a step.
  steerEngine.reset(actorId);
  const speed = applyStyleToGait(actor, action.prompt);
  st.mode = 'POINT';
  st.point = [...point] as Vec3;
  st.target = null;
  st.speed = speed;
  st.arrived = false;
  st.stuck = false;
  return `${actor.name}: ${action.label.toLowerCase()}`;
}
