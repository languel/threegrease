// Live video sources — webcams, as ASSETS.
//
// A camera used to belong to the capture panel: MMCapture opened its own
// getUserMedia stream for MediaPipe and nothing else could see the pixels.
// Here a camera is a source any consumer can take: a plane in the scene
// shows it (a texture src of `live:<key>`), capture detects on it, and the
// Library lists it beside the scans and models. Several can be open at once.
//
// Every source draws its video into its OWN canvas each frame and the
// texture is a CanvasTexture over that canvas. That one indirection is what
// makes PAUSE work: pausing stops the camera (its light goes off) and simply
// stops redrawing, so everything showing it holds the last frame — a
// placeholder that is the actual picture rather than a black square.
//
// Keys are `cam:<deviceId>`. A device id is stable per origin once camera
// permission has been granted, so a plane saved with one finds the same
// camera again after a reload — it shows a grey placeholder until the camera
// is reopened (click its Library tile), then goes live without being touched.
import * as THREE from 'three';

export type LiveStatus = 'starting' | 'on' | 'paused' | 'closed' | 'error';

export interface LiveSource {
  key: string;
  label: string;
  deviceId: string;
  status: LiveStatus;
  error?: string;
  /** the latest frame (live) or the frozen one (paused) — what everything reads */
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  /** bumped on every new frame, so a detector can skip repeats */
  frame: number;
  video: HTMLVideoElement | null;
  stream: MediaStream | null;
  /** the camera delivered a frame since the last copy (see tick) */
  fresh?: boolean;
  /** a GENERATED source (the test camera): drawn here, no device at all */
  synthetic?: { next: number; t0: number };
}

export const LIVE_PREFIX = 'live:';
export function liveKeyOf(src: string | null | undefined): string | null {
  return src && src.startsWith(LIVE_PREFIX) ? src.slice(LIVE_PREFIX.length) : null;
}

class LiveSources {
  private sources = new Map<string, LiveSource>();
  private listeners: (() => void)[] = [];

  onChange(fn: () => void): void { this.listeners.push(fn); }
  private notify(): void { for (const fn of this.listeners) fn(); }

  /** Open (or re-open) sources only — closed placeholders are not listed. */
  list(): LiveSource[] { return [...this.sources.values()].filter((s) => s.status !== 'closed'); }
  get(key: string): LiveSource | undefined { return this.sources.get(key); }

  /** The cameras the browser can see (labels only after permission). */
  async devices(): Promise<MediaDeviceInfo[]> {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch { return []; }
  }

  /** A source record for `key`, created as a grey placeholder if unknown —
   *  so a texture can be handed out before its camera is open, and becomes
   *  live in place when it is. */
  private ensure(key: string, label = key): LiveSource {
    let s = this.sources.get(key);
    if (!s) {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 48;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#3a3a40'; g.fillRect(0, 0, 64, 48);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      s = { key, label, deviceId: key.startsWith('cam:') ? key.slice(4) : '', status: 'closed', canvas, texture, frame: 0, video: null, stream: null };
      this.sources.set(key, s);
    }
    return s;
  }

  /** The texture for a `live:` key (placeholder until the camera opens). */
  textureFor(key: string): THREE.CanvasTexture { return this.ensure(key).texture; }

  /**
   * Open a camera. No deviceId = the browser's default (which is also how
   * permission is first asked for). Resolves to the source, live.
   */
  async open(deviceId?: string): Promise<LiveSource> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: 1280, height: 720 } : { width: 1280, height: 720 },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    const id = track?.getSettings().deviceId ?? deviceId ?? `default-${Date.now()}`;
    const s = this.ensure(`cam:${id}`, track?.label || 'Camera');
    s.label = track?.label || s.label;
    s.deviceId = id;
    // already running? keep the one we have, drop the duplicate
    if (s.stream && s.status === 'on') { stream.getTracks().forEach((t) => t.stop()); return s; }
    s.stream = stream;
    s.video ??= Object.assign(document.createElement('video'), { muted: true, playsInline: true });
    s.video.srcObject = stream;
    this.watchFrames(s);
    s.status = 'starting';
    this.notify();
    try {
      await s.video.play();
      s.status = 'on';
    } catch (err) {
      s.status = 'error';
      s.error = err instanceof Error ? err.message : String(err);
    }
    this.notify();
    return s;
  }

  /**
   * The TEST CAMERA: a generated 1280x720 source at 30 fps — colour bars, a
   * sweeping marker, a running timecode and frame count — that behaves
   * exactly like a webcam (Library tile, planes, capture, pause) with no
   * device and no permission. For building and checking a scene anywhere,
   * including browsers that refuse camera access.
   */
  openTest(): LiveSource {
    const s = this.ensure('test:camera', 'Test Camera');
    s.label = 'Test Camera';
    s.synthetic ??= { next: 0, t0: performance.now() };
    if (s.canvas.width !== 1280) {
      s.canvas.width = 1280; s.canvas.height = 720;
      s.texture.dispose();
    }
    s.status = 'on';
    this.notify();
    return s;
  }

  /** Stop the camera, keep the last frame showing everywhere. */
  pause(key: string): void {
    const s = this.sources.get(key);
    if (!s || s.status !== 'on') return;
    if (s.synthetic) { s.status = 'paused'; this.notify(); return; }
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = null;
    if (s.video) s.video.srcObject = null;
    s.status = 'paused';
    this.notify();
  }

  async resume(key: string): Promise<void> {
    const s = this.sources.get(key);
    if (!s || s.status === 'on') return;
    if (s.synthetic) { s.status = 'on'; this.notify(); return; }
    await this.open(s.deviceId || undefined);
  }

  /** Stop and forget the stream; anything showing it keeps its last frame. */
  close(key: string): void {
    const s = this.sources.get(key);
    if (!s) return;
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = null;
    if (s.video) s.video.srcObject = null;
    s.status = 'closed';
    this.notify();
  }

  /**
   * Mark a source FRESH whenever its camera presents a new frame.
   *
   * Copying on every animation frame instead is what took the app to 1-2 fps
   * with a camera open: a 30 fps camera was redrawn and re-uploaded as a
   * 720p texture 60 times a second, and — worse — its frame counter ticked
   * at the display rate, so capture ran its MediaPipe detectors on every
   * display frame of a picture that had not changed.
   */
  private watchFrames(s: LiveSource): void {
    const v = s.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (!v.requestVideoFrameCallback) { s.fresh = true; return; }   // no rVFC: copy every tick
    const onFrame = () => {
      if (s.video !== v || !s.stream) return;
      s.fresh = true;
      v.requestVideoFrameCallback!(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  /** Per frame: copy each live camera's NEW frame (if it has one) into its
   *  canvas. */
  tick(): void {
    const now = performance.now();
    for (const s of this.sources.values()) {
      if (s.synthetic) {
        if (s.status === 'on' && now >= s.synthetic.next) {
          s.synthetic.next = now + 1000 / 30;
          drawTestPattern(s.canvas, (now - s.synthetic.t0) / 1000, s.frame);
          s.texture.needsUpdate = true;
          s.frame++;
        }
        continue;
      }
      if (s.status !== 'on' || !s.video || s.video.readyState < 2) continue;
      const rvfc = 'requestVideoFrameCallback' in s.video;
      if (rvfc && !s.fresh) continue;
      s.fresh = false;
      const w = s.video.videoWidth, h = s.video.videoHeight;
      if (!w || !h) continue;
      if (s.canvas.width !== w || s.canvas.height !== h) {
        s.canvas.width = w; s.canvas.height = h;
        // a CanvasTexture keeps the size it was first uploaded at; a new
        // size needs a new GPU texture, which dispose() arranges
        s.texture.dispose();
      }
      s.canvas.getContext('2d')!.drawImage(s.video, 0, 0, w, h);
      s.texture.needsUpdate = true;
      s.frame++;
    }
  }
}

export const liveSources = new LiveSources();

/** One frame of the test camera: SMPTE-style bars, a marker sweeping across
 *  them, and the time — so motion, colour and latency are all readable. */
function drawTestPattern(c: HTMLCanvasElement, t: number, frame: number): void {
  const g = c.getContext('2d')!;
  const w = c.width, h = c.height;
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const bw = w / bars.length;
  bars.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * bw, 0, bw + 1, h * 0.67); });
  const ramp = g.createLinearGradient(0, 0, w, 0);
  ramp.addColorStop(0, '#000'); ramp.addColorStop(1, '#fff');
  g.fillStyle = ramp; g.fillRect(0, h * 0.67, w, h * 0.13);
  g.fillStyle = '#101014'; g.fillRect(0, h * 0.8, w, h * 0.2);
  // the sweep: one full crossing every 4 s
  const x = ((t / 4) % 1) * w;
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath(); g.arc(x, h * 0.335, h * 0.09, 0, Math.PI * 2); g.fill();
  const tc = (() => {
    const f = Math.floor((t % 1) * 30);
    const sec = Math.floor(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}:${p(f)}`;
  })();
  g.fillStyle = '#e8e8ec';
  g.font = `600 ${Math.round(h * 0.09)}px ui-monospace, Menlo, monospace`;
  g.textBaseline = 'middle';
  g.fillText(tc, w * 0.04, h * 0.9);
  g.font = `${Math.round(h * 0.05)}px ui-monospace, Menlo, monospace`;
  g.fillText(`TEST CAMERA · frame ${frame}`, w * 0.55, h * 0.9);
}

/**
 * The TEST CARD: a still image for checking a surface — its aspect, which
 * way is up, whether it is mirrored, and how colour and fine detail survive
 * the render. Returned as a PNG data URL.
 */
export function testCardDataUrl(w = 1600, h = 900): string {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2a2a30'; g.fillRect(0, 0, w, h);
  // grid
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
  const step = h / 10;
  for (let x = w / 2 % step; x < w; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = h / 2 % step; y < h; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  // bars across the middle
  const bars = ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000'];
  const bw = w * 0.6 / bars.length;
  bars.forEach((col, i) => { g.fillStyle = col; g.fillRect(w * 0.2 + i * bw, h * 0.36, bw + 1, h * 0.14); });
  // grey ramp
  for (let i = 0; i < 11; i++) {
    const v = Math.round(i * 25.5);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(w * 0.2 + i * (w * 0.6 / 11), h * 0.5, w * 0.6 / 11 + 1, h * 0.08);
  }
  // the circle (aspect), corner marks (orientation) and a label (mirroring)
  g.strokeStyle = '#fff'; g.lineWidth = 4;
  g.beginPath(); g.arc(w / 2, h / 2, h * 0.42, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2);
  g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#ff5a4f';
  g.beginPath(); g.moveTo(0, 0); g.lineTo(h * 0.12, 0); g.lineTo(0, h * 0.12); g.fill();
  g.fillStyle = '#e8e8ec';
  g.font = `600 ${Math.round(h * 0.07)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText('3ζ TEST CARD', w / 2, h * 0.24);
  g.font = `${Math.round(h * 0.035)}px system-ui, sans-serif`;
  g.fillText('TOP LEFT ◤ · 16:9 · the circle should be round', w / 2, h * 0.7);
  return c.toDataURL('image/png');
}
