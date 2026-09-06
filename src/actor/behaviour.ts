// Scripted behaviour: a queue of things a character intends to do.
//
// This is the smallest thing that deserves the name. Each step says what the
// character is trying to do and, in its own words, why — and the words are
// emitted at the moment the goal is actually set, so the running commentary
// cannot drift from the behaviour the way a hand-written narration would.
//
// Steps do not implement motion. They set the same scene state a click or a
// panel press sets — a steer goal, a face target, a gait style — so a
// scripted character and a driven one are the same character, which is the
// rule the whole actor pipeline is built on.
//
// RUNTIME state, not scene data, following `App.setStreamDriver`: a script
// is wiring, it is re-established after a load rather than living in an undo
// snapshot.
import type { GPScene, TGActor, Vec3 } from '../core/types';
import { actorLog } from '../app/actorlog';
import { applyStyleToGait } from './commands';
import { steerEngine } from './steering';

export type Step =
  /** walk somewhere, optionally in a named style */
  | { say: string; goto: Vec3; style?: string; arriveWithin?: number }
  /** walk to whatever an object is, wherever it is now */
  | { say: string; gotoObject: { kind: string; id: number }; style?: string }
  /** turn on the spot to look at something */
  | { say: string; face: Vec3 }
  /** stand there */
  | { say: string; wait: number }
  /** do something in place — a gesture, a dance — for `hold` seconds */
  | { say: string; perform: string; hold: number; seconds?: number };

interface Runner {
  steps: Step[];
  i: number;
  /** seconds spent on the current step */
  t: number;
  loop: boolean;
  started: boolean;
}

/** How long a step may run before we give up and move on. */
const STEP_TIMEOUT = 30;

export class BehaviourEngine {
  private runners = new Map<number, Runner>();

  /**
   * Wired by the App, because generating motion is its job, not a behaviour's
   * — the same reason steps set scene state rather than posing anything.
   * `perform` asks for a clip; travelling steps ask for it to be dropped so
   * the walk cycle takes the legs back.
   */
  onPerform: ((actorId: number, prompt: string, seconds: number) => void) | null = null;
  onClearMotion: ((actorId: number) => void) | null = null;

  clear(): void { this.runners.clear(); }

  run(actorId: number, steps: Step[], loop = true): void {
    this.runners.set(actorId, { steps, i: 0, t: 0, loop, started: false });
  }

  stop(actorId: number): void { this.runners.delete(actorId); }
  running(actorId: number): boolean { return this.runners.has(actorId); }

  update(scene: GPScene, dt: number, upZ: boolean): void {
    for (const [actorId, r] of this.runners) {
      const actor = scene.actors.find((a) => a.id === actorId);
      if (!actor || !r.steps.length) continue;
      const step = r.steps[r.i];

      if (!r.started) {
        this.begin(actor, step, upZ);
        r.started = true;
        r.t = 0;
        continue;
      }

      r.t += dt;
      if (this.done(actor, step, r.t) || r.t > STEP_TIMEOUT) {
        r.i += 1;
        if (r.i >= r.steps.length) {
          if (!r.loop) { this.runners.delete(actorId); continue; }
          r.i = 0;
        }
        r.started = false;
      }
    }
  }

  private begin(actor: TGActor, step: Step, upZ: boolean): void {
    // Say it FIRST — the log is a statement of intent, so it belongs at the
    // moment the goal is set rather than after the fact.
    actorLog.say(actor.id, actor.name, step.say);
    const st = actor.steer;
    if (!st) return;
    steerEngine.reset(actor.id);
    st.arrived = false;
    st.stuck = false;

    if ('perform' in step) {
      st.mode = 'NONE';
      this.onPerform?.(actor.id, step.perform, step.seconds ?? 3);
      return;
    }
    // Anything that TRAVELS hands the body back to the gait first: a held
    // gesture playing while the character walks away is the stacking problem
    // in a different costume.
    this.onClearMotion?.(actor.id);

    if ('style' in step && step.style) applyStyleToGait(actor, step.style);

    if ('goto' in step) {
      st.mode = 'POINT';
      st.point = [...step.goto] as Vec3;
      st.target = null;
      if (step.arriveWithin) st.stopDistance = step.arriveWithin;
      if (actor.gait) actor.gait.enabled = true;
    } else if ('gotoObject' in step) {
      st.mode = 'OBJECT';
      st.target = step.gotoObject as typeof st.target;
      if (actor.gait) actor.gait.enabled = true;
    } else if ('face' in step) {
      st.mode = 'FACE';
      st.point = [...step.face] as Vec3;
      st.target = null;
    } else {
      st.mode = 'NONE';
    }
    void upZ;
  }

  private done(actor: TGActor, step: Step, t: number): boolean {
    if ('wait' in step) return t >= step.wait;
    if ('perform' in step) return t >= step.hold;
    // arrived OR gave up — a character that wedged should carry on with its
    // day rather than standing in a corner for the rest of the piece
    return !!actor.steer?.arrived;
  }
}

export const behaviourEngine = new BehaviourEngine();
