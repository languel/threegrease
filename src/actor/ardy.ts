// ARDY Mini: a learned motion model, running on this machine.
//
// ARDY (NVIDIA, SIGGRAPH 2026) is an autoregressive DIFFUSION model for
// interactive human motion. `intsuc` exported a browser build of it, and
// the reason that is possible at all is one substitution: upstream ARDY
// encodes prompts with a gated Llama-3-8B-Instruct at ~14 GB of VRAM, and
// the browser build distils that down to MiniLM-L6-v2. That turns a
// workstation model into a ~653 MiB download.
//
// Three ONNX graphs chained on WebGPU: text_encoder (MiniLM -> a 2048-dim
// conditioning vector), denoiser (10-step deterministic DDIM over a latent
// body embedding plus explicit root features), decoder (latent -> posed
// joints on a 27-joint skeleton at 20 fps). It is AUTOREGRESSIVE — 40
// frames per window, then the previous 40 are retained and recentred as
// history — which is what lets it run long and stay coherent.
//
// WHAT IT DOES NOT DO, despite what the ARDY paper offers: this export is
// TEXT-ONLY. Upstream ARDY accepts root paths, waypoints, keyframes and
// sparse joint constraints; the browser graphs have no such input, and the
// vendored runtime says so in as many words ("The text-only browser runtime
// does not feed these values into ONNX"). So it answers "move like this",
// not "go there" — and that is fine here, because in this app travel has
// always belonged to whatever drives the ROOT (the gait, a path, a steer
// goal, your hands) and the pose is a separate layer. A generated clip
// composes with a destination instead of competing with it.
//
// The runtime under src/vendor/ardy is intsuc's, unmodified, Apache-2.0.
// Vendoring it rather than reimplementing was deliberate: the DDIM update,
// the window recentring and the latent quantisation are exactly the kind of
// detail that is easy to get subtly wrong and hard to notice.
import type { TGActor, TGClip } from '../core/types';
import type { MotionBackend, MotionRequest } from './generate';
import { retargetPoseFrames, type PoseSource } from './retarget';
import { BrowserArdyRuntime, loadModelAssets, type ModelAssets } from '../vendor/ardy';

/** fp16 needs WebGPU `shader-f16`; fp32 is the fallback build. */
const REPO = 'https://huggingface.co/intsuc/Llama-3-ARDY-Mini-Core40-Browser/resolve/main';

/**
 * cskel27 -> our joint vocabulary.
 *
 * ARDY's skeleton uses Mixamo-style names, which is lucky: the mapping is
 * almost the same one the glTF importer needs. Two things are NOT a plain
 * rename:
 *  - `Arm` is the UPPER arm, so it is our shoulder; `Shoulder` is the
 *    clavicle and has no home here.
 *  - our `chest` binds to the MIDPOINT OF THE SHOULDERS by convention (see
 *    skeleton.ts) rather than to any single spine joint, so it is
 *    synthesised from the two clavicles instead of mapped.
 */
const JOINT_MAP: [string, string | [string, string]][] = [
  ['hips', 'Hips'],
  ['spine', 'Spine1'],
  ['chest', ['LeftShoulder', 'RightShoulder']],
  ['neck', 'Neck'],
  ['head', 'Head'],
  ['shoulder.L', 'LeftArm'],
  ['elbow.L', 'LeftForeArm'],
  ['wrist.L', 'LeftHand'],
  ['hand.L', 'LeftHandEnd'],
  ['shoulder.R', 'RightArm'],
  ['elbow.R', 'RightForeArm'],
  ['wrist.R', 'RightHand'],
  ['hand.R', 'RightHandEnd'],
  ['hip.L', 'LeftUpLeg'],
  ['knee.L', 'LeftLeg'],
  ['ankle.L', 'LeftFoot'],
  ['foot.L', 'LeftToeBase'],
  ['hip.R', 'RightUpLeg'],
  ['knee.R', 'RightLeg'],
  ['ankle.R', 'RightFoot'],
  ['foot.R', 'RightToeBase'],
];

export interface ArdyProgress {
  stage: string;
  completed: number;
  total: number;
  message?: string;
}

/** The attributions the composite model terms REQUIRE us to display. */
export const ARDY_NOTICES = [
  'Motion model: Llama 3 ARDY Mini Core40 Browser (intsuc), built from '
  + 'NVIDIA ARDY-Core-RP-20FPS-Horizon40.',
  'Licensed by NVIDIA Corporation under the NVIDIA Open Model License.',
  'Built with Meta Llama 3. Meta Llama 3 is licensed under the Meta Llama 3 '
  + 'Community License, Copyright © Meta Platforms, Inc. All Rights Reserved.',
  'Browser runtime © 2026 intsuc, Apache-2.0.',
];

export class ArdyBackend implements MotionBackend {
  readonly id = 'ardy';
  readonly label = 'ARDY Mini (on-device model)';

  private runtime: BrowserArdyRuntime | null = null;
  private loading: Promise<BrowserArdyRuntime> | null = null;
  /** set by the App so the UI can show download progress */
  onProgress: ((p: ArdyProgress) => void) | null = null;
  /** last error, so the panel can say why it is not available */
  lastError: string | null = null;

  get ready(): boolean { return this.runtime !== null; }
  get busy(): boolean { return this.loading !== null; }

  /** fp16 halves the download but needs a WebGPU feature not every GPU has. */
  private async variant(): Promise<'fp16' | 'fp32'> {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await gpu.requestAdapter() as
      { features?: { has(f: string): boolean } } | null;
    if (!adapter) throw new Error('No WebGPU adapter — generation needs a GPU');
    return adapter.features?.has('shader-f16') ? 'fp16' : 'fp32';
  }

  /**
   * Download (once), verify and open the model. Files land in Cache Storage
   * keyed by manifest hash, so the ~653 MiB is paid for on the first
   * generation and never again.
   */
  async load(signal?: AbortSignal): Promise<BrowserArdyRuntime> {
    if (this.runtime) return this.runtime;
    if (this.loading) return this.loading;
    this.lastError = null;
    this.loading = (async () => {
      const variant = await this.variant();
      const report = (p: ArdyProgress): void => this.onProgress?.(p);
      const assets: ModelAssets = await loadModelAssets(
        `${REPO}/${variant}`,
        (p) => report({
          stage: p.stage, completed: p.completed, total: p.total, message: p.message,
        }),
        signal,
      );
      const rt = await BrowserArdyRuntime.create(assets, {
        signal,
        onProgress: (p) => report({
          stage: p.stage, completed: p.completed, total: p.total, message: p.message,
        }),
      });
      this.runtime = rt;
      return rt;
    })();
    try {
      return await this.loading;
    } catch (err) {
      this.lastError = String(err instanceof Error ? err.message : err);
      throw err;
    } finally {
      this.loading = null;
    }
  }

  async generate(req: MotionRequest, actor: TGActor, upZ: boolean): Promise<TGClip> {
    const rt = await this.load();
    const skeleton = rt.manifest.skeleton;
    if (!skeleton?.joint_names?.length) throw new Error('model manifest has no skeleton');
    const names = skeleton.joint_names as string[];
    const index = new Map(names.map((n, i) => [n, i]));

    // Resolve the mapping against THIS model's skeleton once, so a model
    // whose joint list differs simply contributes fewer joints rather than
    // silently reading the wrong ones.
    const plan: { out: string; from: number[] }[] = [];
    for (const [out, src] of JOINT_MAP) {
      const parts = (Array.isArray(src) ? src : [src])
        .map((n) => index.get(n))
        .filter((i): i is number => i !== undefined);
      if (parts.length === (Array.isArray(src) ? src.length : 1)) {
        plan.push({ out, from: parts });
      }
    }
    if (plan.length < 6) throw new Error('ARDY skeleton did not match our joints');

    const seconds = Math.max(2, Math.min(10, req.seconds));
    const result = await rt.generate({
      prompt: req.prompt,
      seed: Math.floor(Math.random() * 0x7fffffff),
      durationSeconds: seconds,
      onProgress: (p) => this.onProgress?.({
        stage: p.stage, completed: p.completed, total: p.total, message: p.message,
      }),
    });

    const [, frameCount, jointCount] = result.jointsShape;
    const fps = result.fps || 20;
    const stride = jointCount * 3;
    const gather = (src: ArrayLike<number>, off: number): Float32Array => {
      const out = new Float32Array(plan.length * 3);
      for (let p = 0; p < plan.length; p++) {
        const from = plan[p].from;
        let x = 0; let y = 0; let z = 0;
        for (const j of from) {
          x += src[off + j * 3];
          y += src[off + j * 3 + 1];
          z += src[off + j * 3 + 2];
        }
        out[p * 3] = x / from.length;
        out[p * 3 + 1] = y / from.length;
        out[p * 3 + 2] = z / from.length;
      }
      return out;
    };

    // The manifest's neutral pose is the bind reference — a hips-centred
    // TEMPLATE, not a floor-standing pose, which is why the floor is taken
    // from the frames instead (see retarget.ts `groundRef`).
    const neutral = skeleton.neutral_joints as number[][];
    const bindFlat = new Float32Array(jointCount * 3);
    for (let j = 0; j < jointCount && j < neutral.length; j++) {
      bindFlat[j * 3] = neutral[j][0];
      bindFlat[j * 3 + 1] = neutral[j][1];
      bindFlat[j * 3 + 2] = neutral[j][2];
    }

    const source: PoseSource = {
      names: plan.map((p) => p.out),
      bind: gather(bindFlat, 0),
      frames: Array.from({ length: frameCount }, (_, f) => ({
        t: Math.round((f / fps) * 1000),
        pos: gather(result.joints, f * stride),
      })),
    };

    const report = retargetPoseFrames(source, actor, {
      upZ,
      groundRef: 'frames',
      name: req.prompt.trim().slice(0, 40) || 'generated motion',
      source: `ardy:${rt.manifest.model.id}`,
    });
    if (!report.clip) throw new Error(report.error ?? 'retarget failed');
    return report.clip;
  }

  async dispose(): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    await (rt as { dispose?: () => Promise<void> } | null)?.dispose?.();
  }
}

export const ardyBackend = new ArdyBackend();

/** Human-readable size of the download, for the UI to warn with. */
export function ardyDownloadHint(): string {
  return '~653 MiB on first use, then cached in this browser';
}

