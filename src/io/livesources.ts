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

  /** Stop the camera, keep the last frame showing everywhere. */
  pause(key: string): void {
    const s = this.sources.get(key);
    if (!s || s.status !== 'on') return;
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = null;
    if (s.video) s.video.srcObject = null;
    s.status = 'paused';
    this.notify();
  }

  async resume(key: string): Promise<void> {
    const s = this.sources.get(key);
    if (!s || s.status === 'on') return;
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

  /** Per frame: copy every live camera's newest frame into its canvas. */
  tick(): void {
    for (const s of this.sources.values()) {
      if (s.status !== 'on' || !s.video || s.video.readyState < 2) continue;
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
