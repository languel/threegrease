// Native in-app landmark capture: webcam + MediaPipe tasks-vision, no
// external bridge. Lazy-imported so the (already large) main bundle only
// pays for MediaPipe when capture actually starts. Each detector feeds the
// CAMERA-sourced MMStreams of the matching kind via streamStore — the same
// native representation BUS streams land in.
//
// Asset loading: the wasm runtime is served from node_modules in dev (vite
// serves project-root paths) with a pinned-CDN fallback; the .task models
// come from Google's model CDN. Both need network on first use.
import type { GPScene, MMStream } from '../core/types';
import { streamStore, STREAM_POINT_COUNTS } from './streams';

// pinned to the installed @mediapipe/tasks-vision version
const WASM_LOCAL = '/node_modules/@mediapipe/tasks-vision/wasm';
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

type Landmarker = {
  detectForVideo(video: HTMLVideoElement, ts: number): unknown;
  close(): void;
};

export type CaptureStatus = 'off' | 'starting' | 'on' | 'error';

export class MMCapture {
  status: CaptureStatus = 'off';
  error = '';
  /** exposed so the panel can show a live preview */
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private pose: Landmarker | null = null;
  private hands: Landmarker | null = null;
  private lastVideoTime = -1;
  /** UI refresh hook (status changes happen async) */
  onStatus: (() => void) | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.cssText = 'width:100%;border-radius:4px;transform:scaleX(-1);display:block;';
  }

  private setStatus(s: CaptureStatus, err = ''): void {
    this.status = s;
    this.error = err;
    this.onStatus?.();
  }

  /** Start webcam + the detectors the scene's CAMERA streams need. */
  async start(scene: GPScene): Promise<void> {
    if (this.status === 'starting' || this.status === 'on') return;
    const kinds = new Set(scene.mmStreams.filter((s) => s.source === 'CAMERA').map((s) => s.kind));
    const wantPose = kinds.has('POSE');
    const wantHands = kinds.has('HAND_LEFT') || kinds.has('HAND_RIGHT');
    if (!wantPose && !wantHands) {
      this.setStatus('error', 'no camera streams in the scene — add Pose or Hands first');
      return;
    }
    this.setStatus('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      const vision = await import('@mediapipe/tasks-vision');
      let fileset;
      try {
        fileset = await vision.FilesetResolver.forVisionTasks(WASM_LOCAL);
      } catch {
        fileset = await vision.FilesetResolver.forVisionTasks(WASM_CDN);
      }
      if (wantPose) {
        this.pose = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO', numPoses: 1,
        }) as unknown as Landmarker;
      }
      if (wantHands) {
        this.hands = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO', numHands: 2,
        }) as unknown as Landmarker;
      }
      this.setStatus('on');
    } catch (err) {
      this.stop();
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this.pose?.close(); this.pose = null;
    this.hands?.close(); this.hands = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastVideoTime = -1;
    if (this.status !== 'error') this.setStatus('off');
  }

  /** Per-rAF: run detection on new video frames and push stream frames. */
  tick(scene: GPScene): void {
    if (this.status !== 'on' || this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const now = performance.now();
    const aspect = this.video.videoWidth / Math.max(1, this.video.videoHeight);

    if (this.pose) {
      const res = this.pose.detectForVideo(this.video, now) as {
        landmarks: { x: number; y: number; z: number; visibility?: number }[][];
      };
      const lms = res.landmarks?.[0];
      const target = scene.mmStreams.find((s) => s.source === 'CAMERA' && s.kind === 'POSE');
      if (lms && target) streamStore.push(target.id, this.pack(lms, aspect, null), lms.length);
    }
    if (this.hands) {
      const res = this.hands.detectForVideo(this.video, now) as {
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
