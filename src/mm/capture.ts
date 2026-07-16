// Native in-app landmark capture: webcam OR a video/animated-image source
// (URL or local file) + MediaPipe tasks-vision, no external bridge.
// Lazy-imported so the (already large) main bundle only pays for MediaPipe
// when capture actually starts. Each detector feeds the CAMERA-sourced
// MMStreams of the matching kind via streamStore — the same native
// representation BUS streams land in.
//
// Sources:
//  - CAMERA: getUserMedia webcam.
//  - URL/FILE: video (mp4/webm — fetched with CORS then played from a blob
//    URL so pixel reads never taint) or animated image (webp/gif/apng —
//    decoded frame-by-frame via the WebCodecs ImageDecoder onto a canvas,
//    since <video> can't play those). Lets detection be tested/iterated in
//    environments where camera access is blocked.
//
// Asset loading: the wasm runtime is served from node_modules in dev (vite
// serves project-root paths) with a pinned-CDN fallback; the .task models
// come from Google's model CDN. Both need network on first use.
import type { GPScene, MMStream } from '../core/types';
import { streamStore, STREAM_POINT_COUNTS, IRIS_INDICES } from './streams';

// pinned to the installed @mediapipe/tasks-vision version
const WASM_LOCAL = '/node_modules/@mediapipe/tasks-vision/wasm';
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
// face_landmarker outputs 478 points INCLUDING the 10 iris landmarks
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

type Landmarker = {
  detectForVideo(source: HTMLVideoElement | HTMLCanvasElement, ts: number): unknown;
  close(): void;
};

// WebCodecs ImageDecoder (Chromium) — not in every TS dom lib yet
type ImageDecoderCtor = new (init: { data: ArrayBuffer; type: string }) => {
  tracks: { ready: Promise<unknown>; selectedTrack: { frameCount: number } | null };
  decode(opts: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
};
const ImgDecoder = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;

export type CaptureStatus = 'off' | 'starting' | 'on' | 'error';
export type CaptureSource = { url?: string; file?: File };

export class MMCapture {
  status: CaptureStatus = 'off';
  error = '';
  /** what's currently (or last) driving capture, for the panel */
  sourceLabel = '';
  /** exposed so the panel can show a live preview */
  readonly video: HTMLVideoElement;
  /** animated-image sources decode into this (also the preview then) */
  readonly canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private usingCanvas = false;
  private stream: MediaStream | null = null;
  private objectUrl: string | null = null;
  /** token — bumping it cancels a running image-animation loop */
  private imgLoop = 0;
  private canvasFrame = 0;
  private lastFrameKey = -1;
  private pose: Landmarker | null = null;
  private hands: Landmarker | null = null;
  private face: Landmarker | null = null;
  /** UI refresh hook (status changes happen async) */
  onStatus: (() => void) | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.loop = true;
    this.canvas = document.createElement('canvas');
    for (const el of [this.video, this.canvas]) {
      el.style.cssText = 'width:100%;border-radius:4px;display:block;';
    }
  }

  /** the element detection reads from (and the panel previews) */
  get sourceEl(): HTMLVideoElement | HTMLCanvasElement {
    return this.usingCanvas ? this.canvas : this.video;
  }

  private setStatus(s: CaptureStatus, err = ''): void {
    this.status = s;
    this.error = err;
    this.onStatus?.();
  }

  /** Start capture: webcam when `source` is omitted, else URL/file video or
   *  animated image. Restarts cleanly if already running. */
  async start(scene: GPScene, source?: CaptureSource): Promise<void> {
    if (this.status === 'on' || this.status === 'starting') this.stop();
    const kinds = new Set(scene.mmStreams.filter((s) => s.source === 'CAMERA').map((s) => s.kind));
    const wantPose = kinds.has('POSE');
    const wantHands = kinds.has('HAND_LEFT') || kinds.has('HAND_RIGHT');
    const wantFace = kinds.has('FACE') || kinds.has('IRIS');
    if (!wantPose && !wantHands && !wantFace) {
      this.setStatus('error', 'no camera streams in the scene — add Pose/Hands/Face first');
      return;
    }
    this.setStatus('starting');
    try {
      await this.startSource(source);
      const vision = await import('@mediapipe/tasks-vision');
      let fileset;
      try {
        fileset = await vision.FilesetResolver.forVisionTasks(WASM_LOCAL);
      } catch {
        fileset = await vision.FilesetResolver.forVisionTasks(WASM_CDN);
      }
      if (wantPose && !this.pose) {
        this.pose = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO', numPoses: 1,
        }) as unknown as Landmarker;
      }
      if (wantHands && !this.hands) {
        this.hands = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO', numHands: 2,
        }) as unknown as Landmarker;
      }
      if (wantFace && !this.face) {
        this.face = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO', numFaces: 1,
        }) as unknown as Landmarker;
      }
      this.setStatus('on');
    } catch (err) {
      this.stop();
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  private async startSource(source?: CaptureSource): Promise<void> {
    if (!source?.url && !source?.file) {
      // webcam (mirror the preview like a selfie view)
      this.sourceLabel = 'camera';
      this.video.style.transform = 'scaleX(-1)';
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: false,
      });
      this.video.srcObject = this.stream;
      this.usingCanvas = false;
      await this.video.play();
      return;
    }
    this.video.style.transform = '';
    if (source.file) {
      this.sourceLabel = source.file.name;
      if (source.file.type.startsWith('image/')) {
        await this.startImageAnim(await source.file.arrayBuffer(), source.file.type);
      } else {
        this.objectUrl = URL.createObjectURL(source.file);
        await this.startVideoUrl(this.objectUrl);
      }
      return;
    }
    // URL: fetch once with CORS (pixel reads need it anyway), then branch on
    // the real content-type — extensions lie
    const url = source.url!;
    this.sourceLabel = url.split('/').pop()?.slice(0, 40) ?? url;
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
    const type = resp.headers.get('content-type') ?? '';
    const buf = await resp.arrayBuffer();
    if (type.startsWith('image/')) {
      await this.startImageAnim(buf, type);
    } else {
      this.objectUrl = URL.createObjectURL(new Blob([buf], { type: type || 'video/mp4' }));
      await this.startVideoUrl(this.objectUrl);
    }
  }

  private async startVideoUrl(url: string): Promise<void> {
    this.usingCanvas = false;
    this.video.srcObject = null;
    this.video.src = url;
    await this.video.play();
  }

  /** Animated webp/gif/apng: WebCodecs ImageDecoder -> canvas frame loop,
   *  honoring each frame's own duration, looping forever. */
  private async startImageAnim(buf: ArrayBuffer, type: string): Promise<void> {
    if (!ImgDecoder) throw new Error('animated-image sources need the ImageDecoder API (Chromium)');
    const dec = new ImgDecoder({ data: buf, type });
    await dec.tracks.ready;
    const frameCount = dec.tracks.selectedTrack?.frameCount ?? 1;
    this.usingCanvas = true;
    this.ctx2d ??= this.canvas.getContext('2d');
    const token = ++this.imgLoop;
    let index = 0;
    const step = async (): Promise<void> => {
      if (token !== this.imgLoop) { dec.close(); return; }
      let durMs = 66;
      try {
        const { image } = await dec.decode({ frameIndex: index });
        if (token !== this.imgLoop) { image.close(); dec.close(); return; }
        if (this.canvas.width !== image.displayWidth || this.canvas.height !== image.displayHeight) {
          this.canvas.width = image.displayWidth;
          this.canvas.height = image.displayHeight;
        }
        this.ctx2d?.drawImage(image, 0, 0);
        durMs = (image.duration ?? 66_000) / 1000;
        image.close();
        this.canvasFrame++;
        index = (index + 1) % Math.max(1, frameCount);
      } catch (err) {
        // decode hiccup: skip the frame, keep the loop alive
        console.warn('mm image-anim decode:', err);
        index = (index + 1) % Math.max(1, frameCount);
      }
      setTimeout(() => { void step(); }, Math.max(15, durMs));
    };
    await step(); // first frame lands before status flips to 'on'
  }

  stop(): void {
    this.pose?.close(); this.pose = null;
    this.hands?.close(); this.hands = null;
    this.face?.close(); this.face = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.imgLoop++; // cancels the image-anim loop
    this.usingCanvas = false;
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    this.lastFrameKey = -1;
    if (this.status !== 'error') this.setStatus('off');
  }

  /** Per-rAF: run detection on new source frames and push stream frames. */
  tick(scene: GPScene): void {
    if (this.status !== 'on') return;
    const frameKey = this.usingCanvas ? this.canvasFrame : this.video.currentTime;
    if (frameKey === this.lastFrameKey) return;
    this.lastFrameKey = frameKey;
    const src = this.sourceEl;
    const w = this.usingCanvas ? this.canvas.width : this.video.videoWidth;
    const h = this.usingCanvas ? this.canvas.height : this.video.videoHeight;
    if (!w || !h) return;
    const now = performance.now();
    const aspect = w / h;

    if (this.pose) {
      const res = this.pose.detectForVideo(src, now) as {
        landmarks: { x: number; y: number; z: number; visibility?: number }[][];
      };
      const lms = res.landmarks?.[0];
      const target = scene.mmStreams.find((s) => s.source === 'CAMERA' && s.kind === 'POSE');
      if (lms && target) streamStore.push(target.id, this.pack(lms, aspect, null), lms.length);
    }
    if (this.hands) {
      const res = this.hands.detectForVideo(src, now) as {
        landmarks: { x: number; y: number; z: number }[][];
        handednesses: { categoryName: string; score: number }[][];
      };
      const seen = new Set<MMStream['kind']>();
      res.landmarks?.forEach((lms, i) => {
        const handed = res.handednesses?.[i]?.[0];
        const kind: MMStream['kind'] = handed?.categoryName === 'Left' ? 'HAND_LEFT' : 'HAND_RIGHT';
        seen.add(kind);
        const target = scene.mmStreams.find((s) => s.source === 'CAMERA' && s.kind === kind);
        // hands have no per-landmark confidence; embed the handedness score
        if (target) streamStore.push(target.id, this.pack(lms, aspect, handed?.score ?? 1), lms.length);
      });
      // a hand that left the frame: push an empty frame so its points hide
      for (const kind of ['HAND_LEFT', 'HAND_RIGHT'] as const) {
        if (seen.has(kind)) continue;
        const target = scene.mmStreams.find((s) => s.source === 'CAMERA' && s.kind === kind);
        if (target && streamStore.get(target.id)?.count) {
          streamStore.push(target.id, new Float32Array(0), 0);
        }
      }
    }
    if (this.face) {
      const res = this.face.detectForVideo(src, now) as {
        faceLandmarks: { x: number; y: number; z: number }[][];
      };
      const lms = res.faceLandmarks?.[0];
      const faceT = scene.mmStreams.find((s) => s.source === 'CAMERA' && s.kind === 'FACE');
      const irisT = scene.mmStreams.find((s) => s.source === 'CAMERA' && s.kind === 'IRIS');
      if (lms) {
        if (faceT) streamStore.push(faceT.id, this.pack(lms, aspect, 1), lms.length);
        if (irisT) {
          // the 10 iris points live inside the 478-point face output
          const iris = IRIS_INDICES.map((i) => lms[i]).filter(Boolean);
          if (iris.length) streamStore.push(irisT.id, this.pack(iris, aspect, 1), iris.length);
        }
      } else {
        for (const target of [faceT, irisT]) {
          if (target && streamStore.get(target.id)?.count) streamStore.push(target.id, new Float32Array(0), 0);
        }
      }
    }
  }

  /** normalized image coords (x right, y DOWN, z toward camera) -> packed
   *  stream-local Y-up frame [x,y,z,conf]*n, centered, aspect-corrected. */
  private pack(
    lms: { x: number; y: number; z: number; visibility?: number }[],
    aspect: number, fixedConf: number | null,
  ): Float32Array {
    const data = new Float32Array(lms.length * 4);
    for (let i = 0; i < lms.length; i++) {
      const lm = lms[i];
      data[i * 4] = (lm.x - 0.5) * aspect;
      data[i * 4 + 1] = 0.5 - lm.y;
      data[i * 4 + 2] = -lm.z * aspect;
      data[i * 4 + 3] = fixedConf ?? lm.visibility ?? 1;
    }
    return data;
  }
}

export const mmCapture = new MMCapture();

/** dev sanity: expected point counts (also used by the panel) */
export { STREAM_POINT_COUNTS };
