// TIME VOLUMES: a video or GIF as a SPACE-TIME CUBE — its frames stacked
// into one 3D texture, width × height × time — and SLICES that cut through it.
//
// This is the Khronos Projector's idea (Cassinelli & Ishikawa, 2005) and the
// "volume slicing display" after it: a film is a block, and what you see is
// whatever SURFACE you pass through the block. A flat slice square to the
// time axis is an ordinary frame, and moving it along the axis plays the
// film; tilt it and the left of the picture is earlier than the right; bend
// it and time bends with it; push a TIME MAP into it (a depth image, a video,
// a camera) and every pixel shows its own moment.
//
// Two pieces of data:
//  - a VOLUME (`scene.volumes`, `TGVolume`) is an object of its own kind —
//    outliner row, selection, transform, parenting, constraints like any
//    other — and IS the cube. Its local x is the picture's across, z its up
//    and y TIME (front face = first frame). Its own faces sample the volume,
//    so it shows the film's first frame at the front, its last at the back
//    and the time streaks down its sides; WIRE shows only its edges.
//  - `TGMesh.timeSlice` on any mesh makes that mesh a SLICE of a volume, so
//    every surface the app can make — a plane, a sphere, a sculpted poly
//    mesh — can cut one, and is placed and turned with the tools that exist:
//    POSITION — where the surface is inside the cube decides (u, v, t), so a
//      plane is a frame, a tilted plane an oblique cut, a curved mesh a
//      curved one; outside the cube is empty;
//    MAP — the surface's own UVs are the picture, and TIME comes from a map
//      (luminance of an image, a video or a camera), times a gain, plus the
//      offset — Khronos proper.
//   Either can be SCRUBBED (offset) and PLAYED (a rate in cycles a second).
//
// The volume is decoded ONCE per (file, resolution, frame count) into a
// Data3DTexture: every frame drawn into a canvas at the target size and read
// back. GIFs through WebCodecs' ImageDecoder, which hands back COMPOSITED
// frames (a GIF's frames are usually only the part that changed); videos by
// seeking a hidden <video> to evenly spaced times. The budget is memory:
// 256 × 144 × 128 frames of RGBA is 19 MB, and the texture is uploaded once.
import * as THREE from 'three';
import type { GPScene, TGMesh, TGVolume } from '../core/types';
import { worldMatrixOf } from '../tools/objects';

export interface VolumeTex {
  /** one LAYER per frame (a texture array, not a 3D texture): a live
   *  camera writes one layer per new frame, and a 3D texture can only be
   *  re-uploaded whole — 9 MB a frame at 30 fps */
  tex: THREE.DataArrayTexture | null;
  /** LIVE: the ring's newest layer; time 0 is the one after it (the oldest) */
  head: number;
  live?: { key: string; lastFrame: number; canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; filled: number };
  status: 'loading' | 'ok' | 'error';
  error?: string;
  width: number; height: number; frames: number;
  /** picture aspect, width / height */
  aspect: number;
  /** 0..1 while decoding */
  progress: number;
}

const MAX_BYTES = 256 * 1024 * 1024;

/** Draw `frame` into the target canvas and copy its pixels into slice `z`.
 *  The canvas is flipped so v = 0 is the picture's BOTTOM, as a 2D texture's. */
function copySlice(data: Uint8Array, z: number, g: CanvasRenderingContext2D, w: number, h: number,
  frame: CanvasImageSource): void {
  g.save();
  g.clearRect(0, 0, w, h);
  g.translate(0, h); g.scale(1, -1);
  g.drawImage(frame, 0, 0, w, h);
  g.restore();
  data.set(g.getImageData(0, 0, w, h).data, z * w * h * 4);
}

async function decodeGif(blob: Blob, maxW: number, maxFrames: number,
  onProgress: (p: number) => void): Promise<{ data: Uint8Array; w: number; h: number; n: number; aspect: number }> {
  type Dec = {
    tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
    decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>;
    close(): void;
  };
  const Ctor = (globalThis as unknown as { ImageDecoder?: new (o: { data: ArrayBuffer; type: string }) => Dec }).ImageDecoder;
  if (!Ctor) throw new Error('GIF volumes need the ImageDecoder API (Chromium)');
  const dec = new Ctor({ data: await blob.arrayBuffer(), type: 'image/gif' });
  await dec.tracks.ready;
  const count = dec.tracks.selectedTrack?.frameCount ?? 1;
  const first = (await dec.decode({ frameIndex: 0 })).image;
  const aspect = first.displayWidth / Math.max(1, first.displayHeight);
  first.close();
  const w = Math.min(maxW, 2048), h = Math.max(1, Math.round(w / aspect));
  const n = Math.min(count, maxFrames);
  const data = new Uint8Array(w * h * n * 4);
  const cv = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  for (let z = 0; z < n; z++) {
    const idx = Math.min(count - 1, Math.round((z * (count - 1)) / Math.max(1, n - 1)));
    const { image } = await dec.decode({ frameIndex: idx });
    copySlice(data, z, g, w, h, image);
    image.close();
    onProgress((z + 1) / n);
  }
  dec.close();
  return { data, w, h, n, aspect };
}

async function decodeVideo(url: string, maxW: number, maxFrames: number,
  onProgress: (p: number) => void): Promise<{ data: Uint8Array; w: number; h: number; n: number; aspect: number }> {
  const v = Object.assign(document.createElement('video'), { muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
  v.src = url;
  await new Promise<void>((res, rej) => {
    v.addEventListener('loadeddata', () => res(), { once: true });
    v.addEventListener('error', () => rej(new Error('video would not load')), { once: true });
  });
  const aspect = v.videoWidth / Math.max(1, v.videoHeight);
  const w = Math.min(maxW, 2048), h = Math.max(1, Math.round(w / aspect));
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
  const n = Math.max(2, maxFrames);
  const data = new Uint8Array(w * h * n * 4);
  const cv = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  for (let z = 0; z < n; z++) {
    // sample the middle of each slot, and never exactly the end: seeking to
    // `duration` shows a black or repeated frame on most decoders
    v.currentTime = Math.min(dur - 1e-3, ((z + 0.5) / n) * dur);
    await new Promise<void>((res) => v.addEventListener('seeked', () => res(), { once: true }));
    copySlice(data, z, g, w, h, v);
    onProgress((z + 1) / n);
  }
  v.removeAttribute('src');
  v.load();
  return { data, w, h, n, aspect };
}

// ---------------------------------------------------------------- shader

const VERT = /* glsl */`
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  precision highp sampler2DArray;
  uniform sampler2DArray uVol;
  uniform float uFrames;
  uniform float uStart;     // the layer time 0 is in (a live ring's oldest)
  uniform bool uRing;
  uniform mat4 uWorldToVol;
  uniform int uMode;        // 0 position, 1 map
  uniform float uTime;      // offset along time, 0..1 of the film
  uniform float uGain;
  uniform bool uRepeat;
  uniform bool uHasMap;
  uniform sampler2D uMap;
  uniform bool uInvertMap;
  uniform float uOpacity;
  uniform bool uReady;
  varying vec3 vWorld;
  varying vec2 vUv;

  float wrapT(float t) { return uRepeat ? fract(t) : clamp(t, 0.0, 1.0); }

  void main() {
    if (!uReady) { gl_FragColor = vec4(0.25, 0.25, 0.28, uOpacity); return; }
    vec3 uvt;
    if (uMode == 0) {
      // the cube's local space is -0.5..0.5: x across, z up, y TIME
      vec3 p = (uWorldToVol * vec4(vWorld, 1.0)).xyz + 0.5;
      if (any(lessThan(p, vec3(-1e-4))) || any(greaterThan(p, vec3(1.0001)))) discard;
      uvt = vec3(p.x, p.z, wrapT(p.y + uTime));
    } else {
      float m = 0.0;
      if (uHasMap) {
        vec3 c = texture2D(uMap, vUv).rgb;
        m = dot(c, vec3(0.2126, 0.7152, 0.0722));
        if (uInvertMap) m = 1.0 - m;
      }
      uvt = vec3(vUv, wrapT(uTime + uGain * m));
    }
    // TIME is a layer index, blended between the two neighbours by hand (a
    // texture array does not filter across layers the way a 3D texture does)
    float f = uvt.z * (uFrames - 1.0);
    float f0 = floor(f);
    float f1 = min(f0 + 1.0, uFrames - 1.0);
    float l0 = mod(f0 + uStart, uFrames), l1 = mod(f1 + uStart, uFrames);
    vec4 col = mix(texture(uVol, vec3(uvt.xy, l0)), texture(uVol, vec3(uvt.xy, l1)), f - f0);
    gl_FragColor = vec4(col.rgb, col.a * uOpacity);
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------- manager

type Uniforms = Record<string, THREE.IUniform>;

function sliceMaterial(empty: THREE.DataArrayTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, transparent: true,
    uniforms: {
      uVol: { value: empty }, uWorldToVol: { value: new THREE.Matrix4() },
      uFrames: { value: 1 }, uStart: { value: 0 }, uRing: { value: false },
      uMode: { value: 0 }, uTime: { value: 0 }, uGain: { value: 1 }, uRepeat: { value: true },
      uHasMap: { value: false }, uMap: { value: null }, uInvertMap: { value: false },
      uOpacity: { value: 1 }, uReady: { value: false },
    },
  });
}

/** A volume as it stands in the scene: its cube and its playhead. */
type VolumeEntry = { root: THREE.Mesh; outline: THREE.LineSegments; phase: number };
/** A mesh wearing a slice: the material it had, put back when it stops. */
type SliceEntry = { mat: THREE.ShaderMaterial; orig: THREE.Material | THREE.Material[]; phase: number };

export class TimeVolumeManager {
  /** the cubes; parented into the scene by the App */
  readonly group = new THREE.Group();
  private vols = new Map<string, VolumeTex>();
  private entries = new Map<number, VolumeEntry>();
  private slices = new Map<THREE.Mesh, SliceEntry>();
  /** resolves a scene src (store:/URL) to a URL and, when stored, its Blob */
  resolve: ((src: string) => Promise<{ url: string; blob: Blob | null }>) | null = null;
  /** a map texture for MAP slices (images, videos, cameras) */
  textureFor: ((src: string) => THREE.Texture | null) | null = null;
  /** a volume finished (or failed) decoding — redraw the panel */
  onChange: (() => void) | null = null;
  private emptyTex = (() => {
    const t = new THREE.DataArrayTexture(new Uint8Array([64, 64, 72, 255]), 1, 1, 1);
    t.needsUpdate = true;
    return t;
  })();
  /** the app's live sources (cameras), for LIVE volumes */
  live: { get(key: string): { canvas: HTMLCanvasElement; frame: number; status: string } | undefined; openTest(): unknown } | null = null;

  static key(v: TGVolume): string {
    return `${v.src}|${v.resolution}|${v.frames}`;
  }

  /** The decoded texture for a volume, starting the decode on first ask. */
  volume(v: TGVolume): VolumeTex {
    const key = TimeVolumeManager.key(v);
    const hit = this.vols.get(key);
    if (hit) return hit;
    const vt: VolumeTex = { tex: null, head: -1, status: 'loading', width: 0, height: 0, frames: 0, aspect: 1, progress: 0 };
    this.vols.set(key, vt);
    if (v.src.startsWith('live:')) this.startLive(v, vt);
    else void this.load(v, vt);
    return vt;
  }

  /**
   * A LIVE volume: the camera recorded into a ring of `frames` layers, so the
   * cube always holds the last N frames and time 0 is the oldest. This is
   * the Khronos Projector as built — a camera, a buffer, and a surface you
   * push into the past. Nothing is decoded up front; the ring is allocated
   * when the camera's first frame says what shape it is.
   */
  private startLive(v: TGVolume, vt: VolumeTex): void {
    const key = v.src.slice('live:'.length);
    if (key === 'test:camera') this.live?.openTest();
    const canvas = document.createElement('canvas');
    vt.live = { key, lastFrame: -1, canvas, g: canvas.getContext('2d', { willReadFrequently: true })!, filled: 0 };
  }

  private recordLive(v: TGVolume, vt: VolumeTex): void {
    const L = vt.live;
    const src = L ? this.live?.get(L.key) : undefined;
    if (!L || !src || src.canvas.width < 2) return;
    if (src.frame === L.lastFrame || v.frozen) return;
    L.lastFrame = src.frame;
    if (!vt.tex) {
      const aspect = src.canvas.width / src.canvas.height;
      const w = Math.max(16, Math.min(1024, v.resolution || 256)), h = Math.max(1, Math.round(w / aspect));
      let n = Math.max(2, v.frames || 128);
      if (w * h * n * 4 > MAX_BYTES) n = Math.max(8, Math.floor(MAX_BYTES / (w * h * 4)));
      L.canvas.width = w; L.canvas.height = h;
      const tex = new THREE.DataArrayTexture(new Uint8Array(w * h * n * 4), w, h, n);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      Object.assign(vt, { tex, status: 'ok', width: w, height: h, frames: n, aspect, progress: 1, head: -1 });
      this.onChange?.();
    }
    const tex = vt.tex!;
    const w = vt.width, h = vt.height;
    vt.head = (vt.head + 1) % vt.frames;
    copySlice(tex.image.data as Uint8Array, vt.head, L.g, w, h, src.canvas);
    // only this layer goes up to the GPU — the reason for a texture array
    tex.addLayerUpdate(vt.head);
    tex.needsUpdate = true;
    L.filled = Math.min(vt.frames, L.filled + 1);
  }

  statusOf(v: TGVolume): VolumeTex | undefined { return this.vols.get(TimeVolumeManager.key(v)); }

  private async load(v: TGVolume, vt: VolumeTex): Promise<void> {
    try {
      if (!this.resolve) throw new Error('no file resolver');
      const { url, blob } = await this.resolve(v.src);
      const maxW = Math.max(16, v.resolution || 256);
      let frames = Math.max(2, v.frames || 128);
      const isGif = /\.gif(\?|$)/i.test(v.src) || blob?.type === 'image/gif';
      const progress = (p: number) => { vt.progress = p; };
      // the whole volume inside the memory budget, whatever was asked
      if (maxW * maxW * frames * 4 > MAX_BYTES) frames = Math.max(8, Math.floor(MAX_BYTES / (maxW * maxW * 4)));
      const r = isGif
        ? await decodeGif(blob ?? await (await fetch(url)).blob(), maxW, frames, progress)
        : await decodeVideo(url, maxW, frames, progress);
      const tex = new THREE.DataArrayTexture(r.data as Uint8Array<ArrayBuffer>, r.w, r.h, r.n);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      Object.assign(vt, { tex, status: 'ok', width: r.w, height: r.h, frames: r.n, aspect: r.aspect, progress: 1 });
    } catch (err) {
      vt.status = 'error';
      vt.error = err instanceof Error ? err.message : String(err);
    }
    this.onChange?.();
  }

  private fill(u: Uniforms, v: TGVolume, scene: GPScene): VolumeTex {
    const vt = this.volume(v);
    u.uVol.value = vt.tex ?? this.emptyTex;
    u.uReady.value = vt.status === 'ok';
    u.uFrames.value = Math.max(1, vt.frames);
    // a live ring's time 0 is the layer after the newest; a file's is layer 0
    u.uStart.value = vt.live ? (vt.head + 1) % Math.max(1, vt.frames) : 0;
    u.uRing.value = !!vt.live;
    (u.uWorldToVol.value as THREE.Matrix4).copy(worldMatrixOf(scene, { kind: 'VOLUME', id: v.id })).invert();
    return vt;
  }

  /** Mirror scene.volumes: one cube per volume, sampling itself. */
  sync(scene: GPScene): void {
    for (const [id, e] of this.entries) {
      if (scene.volumes.some((v) => v.id === id)) continue;
      this.group.remove(e.root);
      e.root.geometry.dispose();
      (e.root.material as THREE.Material).dispose();
      e.outline.geometry.dispose();
      this.entries.delete(id);
    }
    for (const v of scene.volumes) {
      let e = this.entries.get(v.id);
      if (!e) {
        const root = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sliceMaterial(this.emptyTex));
        root.userData.volumeId = v.id;
        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
        );
        outline.raycast = () => {};
        root.add(outline);
        this.group.add(root);
        e = { root, outline, phase: 0 };
        this.entries.set(v.id, e);
      }
      e.root.matrixAutoUpdate = false;
      e.root.matrix.copy(worldMatrixOf(scene, { kind: 'VOLUME', id: v.id }));
      e.root.visible = v.visible;
      const mat = e.root.material as THREE.ShaderMaterial;
      const u = mat.uniforms;
      this.fill(u, v, scene);
      u.uMode.value = 0;
      u.uTime.value = v.time + e.phase;
      u.uRepeat.value = v.wrap !== 'CLAMP';
      u.uOpacity.value = v.opacity;
      // WIRE: only the edges. The faces stay in the scene graph (invisible
      // material, still raycast) so the cube can be clicked and outlined.
      mat.visible = v.display !== 'WIRE';
      e.outline.visible = v.outline !== false;
    }
  }

  /**
   * Make `mesh` (of `data`) wear its slice, or put its own material back
   * when it has none. Called from MeshManager.apply; true when it took the
   * mesh over, so the caller leaves the material alone.
   */
  applySlice(mesh: THREE.Mesh, data: TGMesh, scene: GPScene): boolean {
    const s = data.timeSlice;
    const v = s ? scene.volumes.find((x) => x.id === s.volumeId) : undefined;
    let e = this.slices.get(mesh);
    if (!s || !v) {
      if (e) { mesh.material = e.orig; e.mat.dispose(); this.slices.delete(mesh); }
      return false;
    }
    if (!e) {
      e = { mat: sliceMaterial(this.emptyTex), orig: mesh.material, phase: 0 };
      this.slices.set(mesh, e);
    }
    if (mesh.material !== e.mat) mesh.material = e.mat;
    const u = e.mat.uniforms;
    this.fill(u, v, scene);
    u.uMode.value = s.mode === 'MAP' ? 1 : 0;
    u.uTime.value = s.time + e.phase;
    u.uGain.value = s.gain;
    u.uRepeat.value = s.wrap !== 'CLAMP';
    u.uInvertMap.value = !!s.invertMap;
    u.uOpacity.value = data.opacity ?? 1;
    const map = s.mode === 'MAP' && s.map ? this.textureFor?.(s.map) ?? null : null;
    u.uHasMap.value = !!map;
    u.uMap.value = map;
    return true;
  }

  /** Advance every PLAYING volume and slice by its rate (cycles a second),
   *  and record a new frame into every LIVE one. */
  tick(dt: number, scene: GPScene): void {
    for (const v of scene.volumes) {
      const vt = this.vols.get(TimeVolumeManager.key(v));
      if (vt?.live) this.recordLive(v, vt);
    }
    for (const v of scene.volumes) {
      const e = this.entries.get(v.id);
      if (e && v.rate) e.phase = (e.phase + v.rate * dt) % 1;
    }
    for (const [mesh, e] of this.slices) {
      const id = mesh.userData.meshId ?? findMeshId(mesh);
      const rate = scene.meshes.find((m) => m.id === id)?.timeSlice?.rate ?? 0;
      if (rate) e.phase = (e.phase + rate * dt) % 1;
    }
  }

  rootFor(id: number): THREE.Object3D | null { return this.entries.get(id)?.root ?? null; }
  roots(scene: GPScene): THREE.Object3D[] {
    return scene.volumes.filter((v) => v.visible).map((v) => this.entries.get(v.id)?.root).filter((r): r is THREE.Mesh => !!r);
  }
}

function findMeshId(o: THREE.Object3D): number | undefined {
  let cur: THREE.Object3D | null = o;
  while (cur) { if (cur.userData.meshId !== undefined) return cur.userData.meshId; cur = cur.parent; }
  return undefined;
}

export const timeVolumes = new TimeVolumeManager();
