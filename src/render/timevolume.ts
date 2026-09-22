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
  /** the ALPHA channel holds a person mask (people filter), not the film's own */
  segmented?: boolean;
  /** what the decode is doing, for the panel */
  stage?: string;
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

/**
 * PEOPLE: MediaPipe's selfie segmenter, frame by frame, its person
 * confidence written into each layer's ALPHA. Run once, as the film decodes,
 * not per display frame — the filter is then a threshold in the shader.
 * The layers are stored bottom-row-first, so each frame is turned the right
 * way up for the model (it finds people upside down badly) and the mask is
 * turned back.
 */
const SELFIE_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
async function segmentPeople(data: Uint8Array, w: number, h: number, n: number,
  onProgress: (p: number) => void): Promise<void> {
  const vision = await import('@mediapipe/tasks-vision');
  let fileset;
  try { fileset = await vision.FilesetResolver.forVisionTasks('/node_modules/@mediapipe/tasks-vision/wasm'); }
  catch { fileset = await vision.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'); }
  const seg = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: SELFIE_MODEL, delegate: 'CPU' },
    runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  });
  const row = w * 4;
  const upright = new Uint8ClampedArray(w * h * 4);
  for (let z = 0; z < n; z++) {
    const base = z * w * h * 4;
    for (let y = 0; y < h; y++) upright.set(data.subarray(base + (h - 1 - y) * row, base + (h - y) * row), y * row);
    const r = seg.segment(new ImageData(upright, w, h));
    const masks = r.confidenceMasks ?? [];
    // one mask = the person; several (multiclass) = the first is BACKGROUND
    const m = masks.length ? masks[0].getAsFloat32Array() : null;
    const person = masks.length === 1;
    if (m) {
      for (let y = 0; y < h; y++) {
        const src = y * w, dst = base + (h - 1 - y) * row;
        for (let x = 0; x < w; x++) {
          const c = person ? m[src + x] : 1 - m[src + x];
          data[dst + x * 4 + 3] = Math.round(Math.min(1, Math.max(0, c)) * 255);
        }
      }
    }
    r.close();
    onProgress((z + 1) / n);
  }
  seg.close();
}

// ---------------------------------------------------------------- shader

const VERT = /* glsl */`
  uniform int uField;       // 0 = the mesh as it is; >0 = a time surface
  uniform mat4 uVolToWorld;
  uniform float uBase, uAmount, uRadius, uFreq;
  uniform vec2 uCenter;
  uniform bool uHasFieldMap;
  uniform sampler2D uFieldMap;
  varying vec3 vWorld;
  varying vec2 vUv;
  const float TAU = 6.28318530718;
  void main() {
    vUv = uv;
    vec4 w;
    if (uField > 0) {
      // A TIME SURFACE: the grid's uv is the picture, and its depth in the
      // cube is the moment that point shows. It is laid out in the CUBE's
      // space (x across, y time, z up), not its own — the mesh is only the
      // grid it is drawn with.
      float d = distance(uv, uCenter);
      float f = 0.0;
      if (uField == 2) f = exp(-d * d / (2.0 * uRadius * uRadius));            // bump
      else if (uField == 3) f = uv.x - 0.5;                                     // tilt
      else if (uField == 4) f = 0.5 * sin(TAU * uFreq * uv.x);                  // wave
      else if (uField == 5) f = 0.5 * cos(TAU * uFreq * d / max(uRadius, 1e-3)) * exp(-d / max(uRadius * 2.0, 1e-3)); // ripple
      else if (uField == 6 && uHasFieldMap) f = dot(texture2D(uFieldMap, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
      // the sheet stays inside the film: past either end it lies on the face
      float t = clamp(uBase + uAmount * f, 0.0, 1.0);
      w = uVolToWorld * vec4(uv.x - 0.5, t - 0.5, uv.y - 0.5, 1.0);
    } else {
      w = modelMatrix * vec4(position, 1.0);
    }
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
  uniform int uMode;        // 0 position, 1 map, 2 VOLUME (ray-march the cube)
  uniform float uTime;      // offset along time, 0..1 of the film
  uniform float uGain;
  uniform bool uRepeat;
  uniform bool uHasMap;
  uniform sampler2D uMap;
  uniform bool uInvertMap;
  uniform float uOpacity;
  uniform bool uReady;
  uniform float uDensity;
  // the FILTER: what of the film counts
  uniform int uPeople;       // 0 off, 1 keep people, 2 remove people
  uniform float uPeopleTh;
  uniform bool uKey;
  uniform vec3 uKeyColor;
  uniform float uKeyTol;
  uniform bool uKeyKeep;
  uniform float uLumaMin, uLumaMax;
  uniform float uMotion;
  uniform int uPlayhead;     // 0 off, 1 crisp slice, 2 cut
  uniform float uPH;         // the playhead, 0..1 along the scan axis
  uniform int uScan;         // axis in the cube's local space: 0 x, 1 y (time), 2 z
  varying vec3 vWorld;
  varying vec2 vUv;

  float wrapT(float t) { return uRepeat ? fract(t) : clamp(t, 0.0, 1.0); }

  // TIME is a layer index, blended between the two neighbours by hand (a
  // texture array does not filter across layers the way a 3D texture does)
  vec4 sampleAt(vec3 uvt) {
    float f = uvt.z * (uFrames - 1.0);
    float f0 = floor(f);
    float f1 = min(f0 + 1.0, uFrames - 1.0);
    float l0 = mod(f0 + uStart, uFrames), l1 = mod(f1 + uStart, uFrames);
    return mix(texture(uVol, vec3(uvt.xy, l0)), texture(uVol, vec3(uvt.xy, l1)), f - f0);
  }

  // 1 when the voxel passes the filter, 0 when it is filtered out (soft at
  // the edges, so a mask does not alias). The ALPHA channel carries the
  // person mask when the volume was decoded with people segmentation.
  float passes(vec3 uvt, vec4 c) {
    float k = 1.0;
    if (uPeople == 1) k *= smoothstep(uPeopleTh - 0.1, uPeopleTh + 0.1, c.a);
    else if (uPeople == 2) k *= 1.0 - smoothstep(uPeopleTh - 0.1, uPeopleTh + 0.1, c.a);
    if (uKey) {
      float d = distance(c.rgb, uKeyColor);
      float near = 1.0 - smoothstep(uKeyTol * 0.8, uKeyTol * 1.2 + 1e-3, d);
      k *= uKeyKeep ? near : 1.0 - near;
    }
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    k *= step(uLumaMin, l) * step(l, uLumaMax);
    if (uMotion > 0.0) {
      vec4 prev = sampleAt(vec3(uvt.xy, max(0.0, uvt.z - 1.0 / max(1.0, uFrames - 1.0))));
      float dm = (abs(prev.r - c.r) + abs(prev.g - c.g) + abs(prev.b - c.b)) / 3.0;
      k *= smoothstep(uMotion * 0.7, uMotion * 1.3, dm);
    }
    return k;
  }

  void main() {
    if (!uReady) { gl_FragColor = vec4(0.25, 0.25, 0.28, uOpacity * 0.5); return; }
    if (uMode == 2) {
      // VOLUME: march the ray through the cube (drawn with its BACK faces,
      // so this runs once per covered pixel whether the eye is outside or
      // in), compositing front to back what the filter lets through
      vec3 eye = (uWorldToVol * vec4(cameraPosition, 1.0)).xyz;
      vec3 end = (uWorldToVol * vec4(vWorld, 1.0)).xyz;
      vec3 dir = normalize(end - eye);
      vec3 inv = 1.0 / dir;
      vec3 t0 = (vec3(-0.5) - eye) * inv, t1 = (vec3(0.5) - eye) * inv;
      vec3 tn = min(t0, t1), tf = max(t0, t1);
      float tIn = max(max(max(tn.x, tn.y), tn.z), 0.0);
      float tOut = min(min(tf.x, tf.y), tf.z);
      if (tOut <= tIn) discard;
      // the PLAYHEAD plane, in the cube's space, and where the ray meets it
      float ph = uPH - 0.5;
      float ea = uScan == 0 ? eye.x : uScan == 1 ? eye.y : eye.z;
      float da = uScan == 0 ? dir.x : uScan == 1 ? dir.y : dir.z;
      float tPlane = abs(da) > 1e-6 ? (ph - ea) / da : -1.0;
      // CUT: the block that remains is the part of the cube PAST the
      // playhead; the ray's first hit on it is an opaque surface — the
      // playhead face shows the current frame, the other faces the streaks
      float tSolid = 1e9;
      if (uPlayhead == 2) {
        vec3 lo = vec3(-0.5), hi = vec3(0.5);
        if (uScan == 0) lo.x = ph; else if (uScan == 1) lo.y = ph; else lo.z = ph;
        vec3 s0 = (lo - eye) * inv, s1 = (hi - eye) * inv;
        vec3 sn = min(s0, s1), sf = max(s0, s1);
        float a0 = max(max(sn.x, sn.y), sn.z), a1 = min(min(sf.x, sf.y), sf.z);
        if (a1 > max(a0, 0.0)) tSolid = max(a0, 0.0);
      }
      const int STEPS = 160;
      float dt = (tOut - tIn) / float(STEPS);
      vec4 acc = vec4(0.0);
      bool slicePending = uPlayhead == 1 && tPlane >= tIn && tPlane <= tOut;
      for (int i = 0; i < STEPS; i++) {
        float t = tIn + (float(i) + 0.5) * dt;
        // the crisp SLICE is composited exactly where the ray crosses it
        if (slicePending && t >= tPlane) {
          slicePending = false;
          vec3 q = eye + dir * tPlane + 0.5;
          vec3 quvt = vec3(q.x, q.z, wrapT(q.y + uTime));
          vec4 c = sampleAt(quvt);
          float a = passes(quvt, c);
          acc.rgb += (1.0 - acc.a) * a * c.rgb;
          acc.a += (1.0 - acc.a) * a;
        }
        if (t >= tSolid) break;
        vec3 p = eye + dir * t + 0.5;
        vec3 uvt = vec3(p.x, p.z, wrapT(p.y + uTime));
        vec4 c = sampleAt(uvt);
        // DENSITY. Without a playhead it is opacity per unit of DEPTH — a
        // cloud, thinner where a ray only clips the cube, which is right for
        // smoke. With one it is the GHOST of the block, and per depth made it
        // SHRINK: a ray through a corner or near an edge crosses a sliver of
        // the cube and gathers almost nothing, so the block read as a cloud
        // smaller than its own box. There it is normalised per RAY instead —
        // every ray through the cube gathers the same total (the Ghost
        // value), so the block reads as a uniform translucent box to its
        // very edges.
        float span = uPlayhead > 0 ? dt / max(tOut - tIn, 1e-3) : dt * 4.0;
        float a = passes(uvt, c) * (1.0 - pow(1.0 - clamp(uDensity, 0.0, 0.999), span));
        acc.rgb += (1.0 - acc.a) * a * c.rgb;
        acc.a += (1.0 - acc.a) * a;
        if (acc.a > 0.98) break;
      }
      if (tSolid < 1e8 && acc.a < 0.98) {
        vec3 q = eye + dir * (tSolid + 1e-4) + 0.5;
        vec3 quvt = vec3(q.x, q.z, wrapT(q.y + uTime));
        vec4 c = sampleAt(quvt);
        float a = passes(quvt, c);
        acc.rgb += (1.0 - acc.a) * a * c.rgb;
        acc.a += (1.0 - acc.a) * a;
      }
      if (acc.a < 0.003) discard;
      gl_FragColor = vec4(acc.rgb / acc.a, acc.a * uOpacity);
      #include <colorspace_fragment>
      return;
    }
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
    vec4 col = sampleAt(uvt);
    float k = passes(uvt, col);
    if (k < 0.5) discard;
    gl_FragColor = vec4(col.rgb, uOpacity);
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
      uFrames: { value: 1 }, uStart: { value: 0 }, uRing: { value: false }, uDensity: { value: 0.5 },
      uPeople: { value: 0 }, uPeopleTh: { value: 0.5 }, uKey: { value: false }, uKeyColor: { value: new THREE.Color(0, 1, 0) },
      uKeyTol: { value: 0.25 }, uKeyKeep: { value: false }, uLumaMin: { value: 0 }, uLumaMax: { value: 1 }, uMotion: { value: 0 },
      uPlayhead: { value: 0 }, uPH: { value: 0 }, uScan: { value: 1 },
      uField: { value: 0 }, uVolToWorld: { value: new THREE.Matrix4() }, uBase: { value: 0 },
      uAmount: { value: 0 }, uRadius: { value: 0.25 }, uFreq: { value: 1 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uHasFieldMap: { value: false }, uFieldMap: { value: null },
      uMode: { value: 0 }, uTime: { value: 0 }, uGain: { value: 1 }, uRepeat: { value: true },
      uHasMap: { value: false }, uMap: { value: null }, uInvertMap: { value: false },
      uOpacity: { value: 1 }, uReady: { value: false },
    },
  });
}

/** A volume as it stands in the scene: its cube and its playhead. */
type VolumeEntry = { root: THREE.Mesh; outline: THREE.LineSegments; phase: number };
/** A mesh wearing a slice: the material it had, put back when it stops. */
type SliceEntry = {
  mat: THREE.ShaderMaterial; orig: THREE.Material | THREE.Material[]; phase: number;
  /** FIELD: the dense grid drawn in place of the mesh's own geometry */
  grid?: THREE.BufferGeometry; origGeo?: THREE.BufferGeometry;
};
const FIELD_SHAPES = { FLAT: 1, BUMP: 2, TILT: 3, WAVE: 4, RIPPLE: 5, MAP: 6 } as const;

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

  /** A volume decoded with the people mask is a different decode. */
  static key(v: TGVolume): string {
    const seg = v.filter && v.filter.people !== 'OFF' && !v.src.startsWith('live:') ? '|people' : '';
    return `${v.src}|${v.resolution}|${v.frames}${seg}`;
  }

  /** The decoded texture for a volume, starting the decode on first ask. */
  private noSource: VolumeTex = { tex: null, head: -1, status: 'loading', width: 0, height: 0, frames: 0, aspect: 1, progress: 0, stage: 'no source yet' };

  volume(v: TGVolume): VolumeTex {
    // a volume made from the Add menu has no film until one is picked
    if (!v.src) return this.noSource;
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

  statusOf(v: TGVolume): VolumeTex | undefined { return v.src ? this.vols.get(TimeVolumeManager.key(v)) : this.noSource; }

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
      if (v.filter && v.filter.people !== 'OFF') {
        vt.stage = 'finding people';
        vt.progress = 0;
        await segmentPeople(r.data, r.w, r.h, r.n, progress);
        vt.segmented = true;
      }
      vt.stage = undefined;
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
    const f = v.filter;
    // PEOPLE only means something when the volume was decoded with a mask
    u.uPeople.value = f && f.people !== 'OFF' && vt.segmented ? (f.people === 'KEEP' ? 1 : 2) : 0;
    u.uPeopleTh.value = f?.peopleThreshold ?? 0.5;
    u.uKey.value = !!f?.key;
    (u.uKeyColor.value as THREE.Color).setRGB(...(f?.keyColor ?? [0, 1, 0]));
    u.uKeyTol.value = f?.keyTolerance ?? 0.25;
    u.uKeyKeep.value = !!f?.keyKeep;
    u.uLumaMin.value = f?.lumaMin ?? 0;
    u.uLumaMax.value = f?.lumaMax ?? 1;
    u.uMotion.value = f?.motion ?? 0;
    // a live ring's time 0 is the layer after the newest; a file's is layer 0
    u.uStart.value = vt.live ? (vt.head + 1) % Math.max(1, vt.frames) : 0;
    u.uRing.value = !!vt.live;
    (u.uWorldToVol.value as THREE.Matrix4).copy(worldMatrixOf(scene, { kind: 'VOLUME', id: v.id })).invert();
    return vt;
  }

  /** Mirror scene.volumes: one cube per volume, sampling itself. */
  sync(scene: GPScene): void {
    // a decode nothing names any more (a changed resolution, the people
    // mask turned on or off) is a texture of up to 256 MB — but the last two
    // are KEPT: toggling the people filter off and on again must not cost a
    // second segmentation of every frame. Map order is insertion order, so
    // the oldest unused go first.
    if (this.vols.size > scene.volumes.length + 2) {
      const used = new Set(scene.volumes.map((v) => TimeVolumeManager.key(v)));
      const unused = [...this.vols].filter(([k, vt]) => !used.has(k) && vt.status !== 'loading');
      for (const [k, vt] of unused.slice(0, Math.max(0, unused.length - 2))) {
        vt.tex?.dispose();
        this.vols.delete(k);
      }
    }
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
      // VOLUME ray-marches the cube, drawn from its BACK faces so it works
      // with the eye inside it too; FACES samples the faces themselves
      const march = v.display === 'VOLUME';
      u.uMode.value = march ? 2 : 0;
      const side = march ? THREE.BackSide : THREE.DoubleSide;
      if (mat.side !== side) { mat.side = side; mat.needsUpdate = true; }
      mat.depthWrite = !march;
      u.uDensity.value = v.density ?? 0.5;
      // with a PLAYHEAD, `time` is where the playhead is, not a shift of the
      // whole film — the block stays put and the playhead moves through it
      const ph = march ? (v.playhead ?? 'OFF') : 'OFF';
      u.uPlayhead.value = ph === 'SLICE' ? 1 : ph === 'CUT' ? 2 : 0;
      u.uPH.value = v.time;
      u.uScan.value = v.scan === 'ACROSS' ? 0 : v.scan === 'UP' ? 2 : 1;
      u.uTime.value = ph !== 'OFF' ? 0 : v.time + e.phase;
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
      if (e) {
        mesh.material = e.orig; e.mat.dispose();
        if (e.origGeo) { mesh.geometry = e.origGeo; e.grid?.dispose(); mesh.frustumCulled = true; }
        this.slices.delete(mesh);
      }
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
    // FIELD: the mesh is swapped for a dense grid (the shape needs vertices
    // to bend) and the vertex shader lays it out in the cube's space
    const field = s.mode === 'FIELD' ? (s.field ?? { shape: 'BUMP', amount: -0.5, radius: 0.25, cx: 0.5, cy: 0.5, freq: 2 }) : null;
    if (field && !e.grid) {
      e.origGeo = mesh.geometry;
      e.grid = new THREE.PlaneGeometry(2, 2, 96, 96);
      mesh.geometry = e.grid;
      // it is drawn where the SHAPE puts it, not where the mesh stands
      mesh.frustumCulled = false;
    } else if (!field && e.grid) {
      mesh.geometry = e.origGeo!; e.grid.dispose(); e.grid = undefined; e.origGeo = undefined;
      mesh.frustumCulled = true;
    }
    u.uField.value = field ? FIELD_SHAPES[field.shape] : 0;
    if (field) {
      u.uMode.value = 0;
      // the base is the sheet's time: scrub moves the whole surface through
      // the film; the fragment then reads exactly where it lies
      u.uBase.value = s.wrap === 'CLAMP' ? Math.min(1, Math.max(0, s.time + e.phase))
        : (((s.time + e.phase) % 1) + 1) % 1;
      u.uTime.value = 0;
      u.uAmount.value = field.amount;
      u.uRadius.value = field.radius;
      u.uFreq.value = field.freq;
      (u.uCenter.value as THREE.Vector2).set(field.cx, field.cy);
      (u.uVolToWorld.value as THREE.Matrix4).copy(worldMatrixOf(scene, { kind: 'VOLUME', id: v.id }));
      const fm = field.shape === 'MAP' && s.map ? this.textureFor?.(s.map) ?? null : null;
      u.uHasFieldMap.value = !!fm;
      u.uFieldMap.value = fm;
    }
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
    // a volume's PLAY moves its `time` — the same value Time scrubs — so
    // pausing leaves the playhead exactly where it is and scrubbing takes
    // over from there
    for (const v of scene.volumes) {
      if (!v.rate || v.paused) continue;
      const t = v.time + v.rate * dt;
      v.time = v.wrap === 'CLAMP' ? Math.min(1, Math.max(0, t)) : ((t % 1) + 1) % 1;
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
