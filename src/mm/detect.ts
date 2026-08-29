// Semantic scene search: find things by DESCRIBING them.
//
// MediaPipe answers "where are this person's joints". This answers "where are
// the people wearing hats", "where are the dogs", "where is the empty
// plinth" — open-vocabulary detection, where the classes are text you type
// rather than a fixed list baked into the model. OWL-ViT/OWLv2 do this by
// embedding your query with CLIP's text tower and matching it against
// per-token box predictions, so any phrase is a valid class.
//
// It feeds the SAME stream store as MediaPipe, packed in the same normalized
// convention, so every downstream consumer — trigger zones, routes, clips,
// rigs — works on semantic detections with no changes. A zone that fires
// when "a person carrying a bag" enters is an ordinary trigger zone.
//
// The honest constraint: this is NOT frame-rate work. OWL-ViT is a ViT with
// a text tower; a run is tens to hundreds of milliseconds even on WebGPU,
// and the first run also downloads a model measured in hundreds of MB. So
// detection runs on its own interval, asynchronously, never blocking the
// render loop, and at most one inference is in flight at a time.
import type { DetectHit } from '../core/types';

/** Loaded lazily — transformers.js and its ONNX runtime are far too large to
 *  sit in the main bundle for a feature most sessions never turn on. */
type Pipe = (
  image: unknown, labels: string[], opts: { threshold?: number; top_k?: number; percentage?: boolean },
) => Promise<{ label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }[]>;

export type DetectStatus = 'off' | 'loading' | 'ready' | 'error';

/**
 * Candidate models for the zero-shot pipeline, cheapest first.
 *
 * ONNX exports go stale: the widely-cited `Xenova/owlvit-base-patch32` fails
 * session creation on transformers.js 4.2 with "Could not find an
 * implementation for Cast(13)" — its graph predates this runtime, and it
 * fails identically on WebGPU and WASM. The `onnx-community/*-ONNX`
 * re-exports are the current ones, so they lead here.
 *
 * NONE of these is verified running end-to-end yet (see docs/INSTALLATION.md);
 * treat the list as candidates to try on the target machine, which is why
 * the model is a dropdown rather than a constant.
 */
export const DETECT_MODELS: { id: string; label: string; note: string }[] = [
  { id: 'onnx-community/owlvit-base-patch32-ONNX', label: 'OWL-ViT base/32', note: 'smallest — start here' },
  { id: 'onnx-community/owlv2-base-patch16-ensemble-ONNX', label: 'OWLv2 base ensemble', note: 'more accurate, heavier' },
  { id: 'onnx-community/grounding-dino-tiny-ONNX', label: 'Grounding DINO tiny', note: 'different family; try if OWL struggles' },
  { id: 'Xenova/owlvit-base-patch32', label: 'OWL-ViT base/32 (legacy export)', note: 'older export — known to fail on current runtimes' },
];

export class SemanticDetector {
  status: DetectStatus = 'off';
  error = '';
  /** which model is loaded, so a model change forces a rebuild */
  private loadedModel = '';
  private pipe: Pipe | null = null;
  private loading: Promise<void> | null = null;
  /** one inference at a time: queueing them would run further and further
   *  behind the video with no way to catch up */
  private busy = false;
  private lastRun = 0;
  /** scratch canvas the video frame is copied into for the model */
  private canvas: HTMLCanvasElement | null = null;
  /** ms the last inference took — surfaced so the interval can be set
   *  from evidence rather than guesswork */
  lastMs = 0;
  onStatus: (() => void) | null = null;

  /** Longest edge the frame is downscaled to before inference. The model
   *  resizes internally anyway; sending a 4K frame just costs upload time. */
  private static readonly MAX_EDGE = 640;

  /** which backend actually ended up running, after any fallback */
  device: 'webgpu' | 'wasm' | '' = '';

  async ensure(model: string, useWebGpu: boolean): Promise<void> {
    if (this.pipe && this.loadedModel === model) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.set('loading');
      const tf = await import('@huggingface/transformers').catch((err) => {
        this.set('error', err instanceof Error ? err.message : String(err));
        return null;
      });
      if (!tf) { this.loading = null; return; }

      // WebGPU is worth trying and cannot be trusted. Session creation for
      // this model family fails outright on some browser/driver
      // combinations — an ONNX Runtime graph-partitioning error, thrown only
      // once the (large) weights have already downloaded. Falling back to
      // WASM keeps the feature working instead of surfacing a stack trace
      // about memcpy transformers to someone who asked to find dogs.
      const attempts: ('webgpu' | 'wasm')[] = useWebGpu ? ['webgpu', 'wasm'] : ['wasm'];
      let lastErr = '';
      for (const device of attempts) {
        try {
          const pipe = await tf.pipeline('zero-shot-object-detection', model,
            device === 'webgpu' ? { device: 'webgpu' } : {});
          this.pipe = pipe as unknown as Pipe;
          this.loadedModel = model;
          this.device = device;
          this.set('ready');
          this.loading = null;
          return;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          if (device === 'webgpu') {
            console.warn('[detect] WebGPU unavailable for this model, falling back to WASM:', lastErr);
          }
        }
      }
      this.pipe = null;
      this.loadedModel = '';
      this.device = '';
      // Raw ONNX Runtime errors name internal graph passes and help nobody.
      // Say what failed and what to do, keeping the detail for the tooltip.
      const friendly = /Can't create a session|Could not find an implementation/i.test(lastErr)
        ? 'This model did not load in this browser — try another from the list.'
        : lastErr;
      this.set('error', friendly, lastErr);
      this.loading = null;
    })();
    return this.loading;
  }

  dispose(): void {
    this.pipe = null;
    this.loadedModel = '';
    this.device = '';
    this.set('off');
  }

  /** Is it worth calling run() right now? Keeps the interval/busy policy in
   *  one place instead of at every call site. */
  due(intervalMs: number, now: number): boolean {
    return !this.busy && this.status === 'ready' && now - this.lastRun >= intervalMs;
  }

  /**
   * Detect `queries` in the current frame. Returns normalized hits — box
   * coordinates as 0..1 fractions of the frame — so the caller can pack them
   * exactly like MediaPipe landmarks without caring about the source size.
   *
   * Never throws: a failed inference reports through `status` and returns
   * nothing, because the capture loop must not die over one bad frame.
   */
  async run(
    source: HTMLVideoElement | HTMLCanvasElement, queries: string[],
    threshold: number, maxResults: number,
  ): Promise<DetectHit[] | null> {
    if (!this.pipe || this.busy || !queries.length) return null;
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!sw || !sh) return null;

    this.busy = true;
    this.lastRun = performance.now();
    try {
      const scale = Math.min(1, SemanticDetector.MAX_EDGE / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      if (!this.canvas) this.canvas = document.createElement('canvas');
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      const g = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!g) return null;
      g.drawImage(source, 0, 0, w, h);

      const tf = await import('@huggingface/transformers');
      const image = tf.RawImage.fromCanvas(this.canvas);
      // `percentage: true` asks the pipeline for 0..1 boxes directly, which
      // is the frame-relative space the stream packing wants
      const out = await this.pipe(image, queries, {
        threshold, top_k: maxResults, percentage: true,
      });
      this.lastMs = performance.now() - this.lastRun;

      const hits: DetectHit[] = out.map((d) => ({
        label: d.label,
        score: d.score,
        box: [d.box.xmin, d.box.ymin, d.box.xmax, d.box.ymax],
      }));
      // Deterministic order matters more than it looks: trigger zones key
      // their enter/leave state by the probe's INDEX, so a set that
      // reshuffles between frames reads as objects teleporting in and out.
      // Sorting by horizontal position keeps well-separated subjects stable.
      hits.sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2]));
      return hits.slice(0, maxResults);
    } catch (err) {
      this.set('error', err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** full text of the last failure, for the tooltip — `error` is the short
   *  human-facing version shown in the panel */
  detail = '';

  private set(status: DetectStatus, error = '', detail = ''): void {
    this.status = status;
    this.error = error;
    this.detail = detail || error;
    this.onStatus?.();
  }
}

export const semanticDetector = new SemanticDetector();

/**
 * Pack detections into the stream store's convention: centred on the frame,
 * aspect-corrected, Y up. Identical to MMCapture.pack so a detection sits in
 * the same space as a landmark and the stream's placement transform means
 * the same thing for both.
 *
 * One point per detection, at the box centre. The box SIZE rides along in
 * the confidence slot's sibling — there isn't one, so size is dropped here;
 * zones care about where a thing is, not how big it looked on camera.
 */
export function packDetections(hits: DetectHit[], aspect: number): Float32Array {
  const data = new Float32Array(hits.length * 4);
  for (let i = 0; i < hits.length; i++) {
    const [x0, y0, x1, y1] = hits[i].box;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    data[i * 4] = (cx - 0.5) * aspect;
    data[i * 4 + 1] = 0.5 - cy;
    data[i * 4 + 2] = 0;            // no depth from a box
    data[i * 4 + 3] = hits[i].score;
  }
  return data;
}
