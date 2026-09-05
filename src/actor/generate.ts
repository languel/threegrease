// Generated motion: a clip made from a description and a goal.
//
// This is the seam a learned motion model plugs into, and a working
// generator that fills it today. The contract is deliberately narrow:
//
//     MotionRequest  { prompt, seconds, joints[], goal? }  ->  TGClip
//
// named joint positions in the actor's own frame, which is exactly what a
// CLIP mixer layer already plays and what a glTF import already produces.
// Anything that can answer that request — a procedural synthesiser, an HTTP
// service, a model running in a worker — is interchangeable, and none of
// the rest of the app has to know which one answered.
//
// On Kimodo specifically (nv-tlabs/kimodo): the code is Apache-2.0 but the
// WEIGHTS are under NVIDIA research licences, it wants ~17 GB of VRAM, and
// it generates offline rather than in real time. So it cannot run in this
// browser, and the honest integration is a BACKEND: point `endpoint` at a
// service holding the weights and it answers the same request. The
// community WebGPU port (lyonsno/kimodo-webgpu) does not change that, for
// three independent reasons and any one is enough: it ships NO LICENCE
// FILE, so it cannot be vendored; it still needs a local Llama 3 8B sidecar
// to encode the text, so it is client-plus-server anyway rather than a
// browser-only path; and it is TEXT-TO-MOTION ONLY, with no waypoint or
// constraint code — precisely the half this project needs, since the whole
// point is telling a character where to go. Because it needs a sidecar
// regardless, its integration IS this remote backend: it would fill
// `prompt` and ignore `goal`. If it ever runs end to end in the browser it
// becomes a third `MotionBackend` and nothing else here changes.
//
// The built-in generator is procedural synthesis, not a learned model, and
// is described that way everywhere it appears. What it buys is that the
// whole pipeline — request, clip, layer, blend, trim, save — is exercised
// and testable now, so swapping the backend is a one-line change rather
// than a project.
import type { TGActor, TGClip, Vec3 } from '../core/types';
import { genId } from '../core/gpdata';

export interface MotionRequest {
  /** free text: "walk", "tired shuffle", "march", "limp on the left" */
  prompt: string;
  seconds: number;
  /** samples per second */
  fps?: number;
  /** joint names the caller can accept; a generator may drive a subset */
  joints: string[];
  /** metres per second the motion should read as covering */
  speed?: number;
  /** optional destination, for a generator that plans travel */
  goal?: Vec3 | null;
}

export interface MotionBackend {
  readonly id: string;
  readonly label: string;
  generate(req: MotionRequest, actor: TGActor, upZ: boolean): Promise<TGClip>;
}

// ---------------------------------------------------------------- style

/**
 * What the words mean, in numbers. A keyword table is not a language
 * model and does not pretend to be — but it IS the same interface a
 * language model would be asked for (a description in, a style out), which
 * is the point of writing it down as data.
 */
export interface MotionStyle {
  /** metres of ground per full cycle (two steps) */
  stride: number;
  /** cycles per second */
  cadence: number;
  stepHeight: number;
  stanceWidth: number;
  /** fraction of the cycle a foot is down; >0.5 walks, <0.5 runs */
  duty: number;
  /** pelvis drop per step */
  bob: number;
  /** pelvis side-to-side per cycle */
  sway: number;
  armSwing: number;
  /** forward lean of the chest, metres */
  lean: number;
  /** how far the pelvis sits below its rest height */
  crouch: number;
  /** 0 = symmetric; +1 favours the left leg, -1 the right */
  limp: number;
  /** vertical head float, metres */
  headBob: number;
}

export function baseStyle(): MotionStyle {
  return {
    stride: 1.4, cadence: 0.95, stepHeight: 0.12, stanceWidth: 0.22,
    duty: 0.62, bob: 0.035, sway: 0.02, armSwing: 0.16,
    lean: 0, crouch: 0, limp: 0, headBob: 0.01,
  };
}

type Tweak = Partial<MotionStyle>;
const WORDS: [RegExp, Tweak][] = [
  [/\b(run|running|jog|jogging|sprint)\b/, { cadence: 1.5, stride: 2.2, duty: 0.42, stepHeight: 0.22, bob: 0.07, armSwing: 0.3, lean: 0.09 }],
  [/\b(walk|walking|stroll)\b/, {}],
  [/\b(slow|slowly|amble|dawdle)\b/, { cadence: 0.65, stride: 1.0, armSwing: 0.1 }],
  [/\b(fast|brisk|hurry|hurried)\b/, { cadence: 1.3, stride: 1.7 }],
  [/\b(tired|weary|exhausted|shuffle|shuffling)\b/, { cadence: 0.7, stride: 0.8, stepHeight: 0.05, armSwing: 0.06, lean: 0.06, crouch: 0.04 }],
  [/\b(march|marching|military)\b/, { stepHeight: 0.26, duty: 0.55, armSwing: 0.3, bob: 0.05, stride: 1.3 }],
  [/\b(sneak|sneaking|creep|creeping|stealth)\b/, { cadence: 0.6, stride: 0.7, stepHeight: 0.09, crouch: 0.12, armSwing: 0.05, duty: 0.7 }],
  [/\b(swagger|strut|confident)\b/, { sway: 0.06, armSwing: 0.24, stride: 1.5 }],
  [/\b(limp|limping|injured|hurt)\b/, { limp: 1, duty: 0.7, cadence: 0.75 }],
  [/\b(stagger|drunk|unsteady)\b/, { sway: 0.09, stanceWidth: 0.34, limp: 0.4, cadence: 0.7 }],
  [/\b(idle|stand|standing|wait|waiting)\b/, { cadence: 0.25, stride: 0.05, stepHeight: 0.005, armSwing: 0.02, bob: 0.008 }],
  [/\b(bouncy|skip|skipping|happy)\b/, { bob: 0.09, stepHeight: 0.2, cadence: 1.2, armSwing: 0.26 }],
  [/\bcrouch(ed|ing)?\b/, { crouch: 0.16, stepHeight: 0.08 }],
  [/\b(right)\b/, {}],
];

/** Read a description into a style. Unknown words are simply ignored. */
export function styleFromPrompt(prompt: string): MotionStyle {
  const p = prompt.toLowerCase();
  const st = baseStyle();
  for (const [re, tweak] of WORDS) if (re.test(p)) Object.assign(st, tweak);
  // "limp on the right" flips which leg is favoured
  if (st.limp && /\bright\b/.test(p)) st.limp = -Math.abs(st.limp);
  return st;
}

// ------------------------------------------------------- the local one

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Procedural synthesis. Drives only the joints it has an opinion about —
 * feet, pelvis, chest, head, wrists — and names them, so the mixer blends
 * it against whatever else is running and leaves the rest of the body to
 * the solver. Motion is IN PLACE: the clip is an actor-local pose, and
 * travel belongs to the root (the gait's own, a path, steering, your hands).
 */
export class ProceduralBackend implements MotionBackend {
  readonly id = 'local';
  readonly label = 'Built-in (procedural)';

  async generate(req: MotionRequest, actor: TGActor, upZ: boolean): Promise<TGClip> {
    const style = styleFromPrompt(req.prompt);
    if (req.speed && req.speed > 0.01) {
      // a requested speed sets the cadence, keeping the stride: the same
      // coupling the live gait gets from distance-phasing
      style.cadence = req.speed / Math.max(0.05, style.stride);
    }
    const upAxis = upZ ? 2 : 1;
    const fwdAxis = upZ ? 1 : 2;
    const fwdSign = upZ ? 1 : -1;
    const fps = Math.max(10, Math.min(60, req.fps ?? 30));
    const seconds = Math.max(0.3, req.seconds);
    // whole number of cycles, so the clip loops without a hitch
    const cycles = Math.max(1, Math.round(seconds * style.cadence));
    const dur = cycles / style.cadence;
    const count = Math.max(2, Math.round(dur * fps));

    const rest = (n: string): Vec3 | null =>
      actor.joints.find((j) => j.name === n)?.rest ?? null;
    const driven = ['hips', 'chest', 'head', 'ankle.L', 'ankle.R', 'wrist.L', 'wrist.R']
      .filter((n) => rest(n) && (!req.joints.length || req.joints.includes(n)));
    const ground = rest('ankle.L')?.[upAxis] ?? 0;

    const frames: { t: number; data: number[] }[] = [];
    for (let f = 0; f < count; f++) {
      const t = (f / count) * dur;               // exclusive end: seamless loop
      const phase = (t * style.cadence) % 1;
      const data: number[] = [];
      for (const name of driven) {
        const r = rest(name)!;
        const p: Vec3 = [r[0], r[1], r[2]];
        const side = name.endsWith('.L') ? 1 : -1;

        if (name.startsWith('ankle')) {
          // A limp shortens one leg's stance and drops its lift. Expressed
          // as a per-side scale rather than a special case, so "limp" and
          // "limp harder" are the same knob.
          const favour = 1 - Math.max(0, style.limp * side) * 0.55;
          const fp = (phase + (side > 0 ? 0 : 0.5)) % 1;
          const stance = fp < style.duty;
          const half = (style.stride * favour) / 2;
          let along: number;
          let lift = 0;
          if (stance) {
            // planted: slides backwards under the body, linearly
            along = half - (fp / style.duty) * style.stride * favour;
          } else {
            const k = smoothstep((fp - style.duty) / (1 - style.duty));
            along = -half + k * style.stride * favour;
            lift = Math.sin(Math.PI * k) * style.stepHeight * favour;
          }
          p[0] = side * style.stanceWidth * 0.5;
          p[fwdAxis] = along * fwdSign;
          p[upAxis] = ground + lift;
        } else if (name === 'hips') {
          p[upAxis] -= style.crouch
            + Math.abs(Math.sin(phase * Math.PI * 2)) * style.bob;
          p[0] += Math.sin(phase * Math.PI * 2) * style.sway;
        } else if (name === 'chest') {
          p[upAxis] -= style.crouch * 0.8;
          p[fwdAxis] += style.lean * fwdSign;
          p[0] += Math.sin(phase * Math.PI * 2) * style.sway * 0.5;
        } else if (name === 'head') {
          p[upAxis] -= style.crouch * 0.7
            - Math.sin(phase * Math.PI * 4) * style.headBob;
          p[fwdAxis] += style.lean * 0.6 * fwdSign;
        } else if (name.startsWith('wrist')) {
          // arms counter-swing the opposite leg
          const swing = Math.cos((phase + (side > 0 ? 0.5 : 0)) * Math.PI * 2) * style.armSwing;
          p[fwdAxis] += swing * fwdSign;
          p[upAxis] -= style.crouch * 0.6;
        }
        data.push(+p[0].toFixed(5), +p[1].toFixed(5), +p[2].toFixed(5), 1);
      }
      frames.push({ t: Math.round(t * 1000), data });
    }

    return {
      id: genId(),
      name: req.prompt.trim() ? req.prompt.trim().slice(0, 40) : 'generated motion',
      source: `generated:${this.id}`,
      count: driven.length,
      duration: Math.round(dur * 1000),
      frames,
      space: 'ACTOR_LOCAL',
      joints: driven,
    };
  }
}

// ------------------------------------------------------------- remote

/**
 * Anything holding real weights, behind HTTP. This is where a Kimodo
 * server goes: it receives the prompt, the duration, the skeleton's joint
 * NAMES and (when it can use one) a goal, and answers with frames of named
 * joint positions in the actor's frame. Same contract as the local one, so
 * nothing downstream changes.
 *
 * Deliberately opt-in and never contacted unless an endpoint is set: this
 * sends a description of the user's scene to a third party.
 */
export class RemoteBackend implements MotionBackend {
  readonly id = 'remote';
  readonly label = 'Remote service';
  endpoint = '';

  async generate(req: MotionRequest, actor: TGActor, upZ: boolean): Promise<TGClip> {
    if (!this.endpoint) throw new Error('no motion endpoint configured');
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: req.prompt,
        seconds: req.seconds,
        fps: req.fps ?? 30,
        speed: req.speed ?? null,
        goal: req.goal ?? null,
        upAxis: upZ ? 'Z' : 'Y',
        joints: req.joints,
        // the rest pose, so a service can retarget to THIS skeleton rather
        // than answer in its own proportions and leave us to guess
        rest: actor.joints.map((j) => ({ name: j.name, at: j.rest })),
      }),
    });
    if (!res.ok) throw new Error(`motion service: ${res.status} ${res.statusText}`);
    const body = await res.json() as {
      joints?: string[];
      frames?: { t: number; data: number[] }[];
      name?: string;
    };
    if (!body.joints?.length || !body.frames?.length) {
      throw new Error('motion service returned no frames');
    }
    return {
      id: genId(),
      name: body.name || req.prompt.slice(0, 40) || 'generated motion',
      source: `generated:remote`,
      count: body.joints.length,
      duration: body.frames[body.frames.length - 1].t,
      frames: body.frames,
      space: 'ACTOR_LOCAL',
      joints: body.joints,
    };
  }
}

export const proceduralBackend = new ProceduralBackend();
export const remoteBackend = new RemoteBackend();

export function motionBackends(): MotionBackend[] {
  return [proceduralBackend, remoteBackend];
}
