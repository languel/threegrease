// Spark adapter (P7). This is the ONLY file that imports @sparkjsdev/spark —
// keep the dependency isolated so version churn stays contained.
// SplatMesh is a THREE.Object3D: it renders alongside our stroke meshes and
// participates in depth, so strokes occlude with splats naturally.
//
// LOADED LAZILY. Spark is ~4.9MB of the bundle (80% of it) and is dead
// weight for every session that never opens a splat, so ./index.ts is a
// facade that dynamic-imports this module the first time a scene actually
// has splats in it. Nothing outside ./index.ts may import this file
// statically or that saving is silently undone — import the facade.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { resolveSrc, sourceName } from '../io/blobstore';
import type { GPScene, TGSplat } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import { decodeRemoved, splatDisplay } from './edit';

/**
 * What Edit mode and the filters need to know about one loaded cloud, kept
 * beside the mesh. `orig` is the packed array AS LOADED: every display —
 * removals, filters, the selection tint, point-cloud mode — is rebuilt from
 * it, so none of them is ever baked into what the next one reads.
 */
export interface SplatEditState {
  n: number;
  /** object-space centres, xyz per splat */
  centers: Float32Array;
  /** 1 = shown: not removed and not filtered out */
  alive: Uint8Array;
  /** runtime selection (not scene data — like a mesh's, it is a view) */
  sel: Uint8Array;
  selCount: number;
  orig: Uint32Array;
  key: string;
  /** the `removed` string last applied — compared by value, and V8 checks
   *  the pointer first, so an untouched record costs nothing per frame */
  removedApplied: string;
  /** how many splats that record removes */
  removedCount: number;
  selVersion: number;
  points: THREE.Points | null;
}

const SEL_RGB = [255, 140, 26];
let dotTexture: THREE.Texture | null = null;
function dot(): THREE.Texture {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}
/** sRGB byte -> linear, since three treats vertex colours as linear and a
 *  splat's colour is display-referred */
const TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
});

export class SparkSplats {
  /** The facade owns the group (it's already parented into scene3 before
   *  this module exists), so meshes are added into the group we're given
   *  rather than one of our own. */
  private readonly group: THREE.Group;
  private readonly errors: Map<number, string>;

  constructor(group: THREE.Group, errors: Map<number, string>) {
    this.group = group;
    this.errors = errors;
  }

  private meshes = new Map<number, { mesh: SplatMesh; src: string }>();
  private edits = new Map<number, SplatEditState>();
  /** the splat Edit mode is open on: its selection is tinted */
  editingId: number | null = null;
  /** called when what is SHOWN changed (a delete, an undo, a filter), since
   *  that happens on the next frame, after the panel has already redrawn */
  onApplied: (() => void) | null = null;
  /** splats whose source is still being resolved to a URL */
  private pending = new Set<number>();
  private lastScene: GPScene | null = null;
  private spark: SparkRenderer | null = null;

  /** Must be called once with the app's WebGLRenderer before any splat loads. */
  init(renderer: THREE.WebGLRenderer): void {
    if (this.spark) return;
    this.spark = new SparkRenderer({ renderer });
    // the selection outline isolates objects by hiding everything else; the
    // one renderer that draws EVERY splat must survive that (render/outline.ts)
    this.spark.userData.splatRenderer = true;
    this.group.add(this.spark);
  }

  /** Create/dispose/transform splat meshes to mirror scene.splats. */
  sync(scene: GPScene): void {
    const wanted = new Set(scene.splats.map((s) => s.id));
    for (const [id, entry] of this.meshes) {
      const data = scene.splats.find((s) => s.id === id);
      if (!data || data.src !== entry.src) {
        this.group.remove(entry.mesh);
        entry.mesh.dispose?.();
        this.meshes.delete(id);
        this.edits.delete(id);
        this.errors.delete(id);
      }
    }
    for (const data of scene.splats) {
      if (!this.meshes.has(data.id) && !this.pending.has(data.id)) {
        // A stored file has to be turned into a URL first (asynchronously),
        // so the mesh arrives a moment later; `pending` stops the next sync
        // from starting a second load of the same splat meanwhile. The
        // fileName goes along because Spark, like three, picks its parser by
        // extension, and an object URL has none.
        const src = data.src;
        this.pending.add(data.id);
        void resolveSrc(src).then((url) => {
          this.pending.delete(data.id);
          if (this.meshes.has(data.id)) return;
          // only a name WITH an extension helps; an old blob: URL's "name"
          // is a uuid, and Spark does better sniffing the bytes than trusting it
          const name = sourceName(src);
          const mesh = new SplatMesh(name.includes('.') ? { url, fileName: name } : { url });
          mesh.userData.splatId = data.id;
          this.group.add(mesh);
          this.meshes.set(data.id, { mesh, src });
          const now = this.lastScene?.splats.find((s) => s.id === data.id);
          if (now && this.lastScene) this.applyTransform(mesh, now, this.lastScene);
          void Promise.resolve((mesh as unknown as { initialized?: Promise<unknown> }).initialized)
            .catch((err) => this.errors.set(data.id, String(err)));
        }).catch((err) => {
          this.pending.delete(data.id);
          this.errors.set(data.id, String(err));
        });
      }
      const entry = this.meshes.get(data.id);
      if (entry) {
        this.applyTransform(entry.mesh, data, scene);
        this.applyEdits(data.id, entry.mesh, data);
      }
    }
    this.lastScene = scene;
    void wanted;
  }

  private applyTransform(mesh: SplatMesh, data: TGSplat, scene: GPScene): void {
    // parent-aware world placement (matrix, so baked shear survives)
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(worldMatrixOf(scene, { kind: 'SPLAT', id: data.id }));
    mesh.visible = data.visible;
  }

  /** The edit state, built the first time a loaded cloud asks for it. */
  editState(id: number): SplatEditState | null {
    const hit = this.edits.get(id);
    if (hit) return hit;
    const mesh = this.meshFor(id);
    const packed = mesh?.packedSplats;
    if (!mesh?.isInitialized || !packed?.packedArray || !packed.numSplats) return null;
    const n = packed.numSplats;
    const centers = new Float32Array(n * 3);
    packed.forEachSplat((i, c) => { centers[i * 3] = c.x; centers[i * 3 + 1] = c.y; centers[i * 3 + 2] = c.z; });
    const st: SplatEditState = {
      n, centers, alive: new Uint8Array(n).fill(1), sel: new Uint8Array(n), selCount: 0,
      orig: packed.packedArray.slice(0, n * 4), key: '', removedApplied: '', removedCount: 0, selVersion: 0, points: null,
    };
    this.edits.set(id, st);
    return st;
  }

  /** Tell the renderer the selection changed (the tool writes `sel`). */
  touchSelection(id: number): void {
    const st = this.edits.get(id);
    if (!st) return;
    let c = 0;
    for (let i = 0; i < st.n; i++) c += st.sel[i];
    st.selCount = c;
    st.selVersion++;
  }

  /**
   * Rebuild what is drawn from the ORIGINAL packed data plus the scene's
   * record: removed and filtered splats get zero opacity, selected ones are
   * tinted, and point-cloud mode swaps the gaussians for dots. Runs only when
   * something that decides it changed — the key — so it costs nothing per
   * frame. Rewriting the array is a few ms for a million splats; the upload
   * is Spark's (`needsUpdate` on the packed splats and a new version on the
   * mesh, or it keeps drawing the old generation).
   */
  private applyEdits(id: number, mesh: SplatMesh, data: TGSplat): void {
    const d = splatDisplay(data.display);
    const untouched = !data.removed?.length && !d.minOpacity && !d.maxSize && d.mode === 'SPLATS'
      && !this.edits.has(id);
    if (untouched) return;
    const st = this.editState(id);
    if (!st) return;
    const editing = this.editingId === id;
    const key = [d.mode, d.pointSize, d.minOpacity, d.maxSize,
      editing ? st.selVersion : -1].join('|');
    const removedStr = data.removed ?? '';
    if (key === st.key && removedStr === st.removedApplied) return;
    st.key = key;
    st.removedApplied = removedStr;
    const packed = mesh.packedSplats!;
    const arr = packed.packedArray!;
    const removed = decodeRemoved(data.removed, st.n);
    let rc = 0;
    for (let i = 0; i < st.n; i++) rc += removed[i];
    st.removedCount = rc;
    const enc = packed.splatEncoding;
    const lnMin = enc?.lnScaleMin ?? -12, lnMax = enc?.lnScaleMax ?? 9;
    const lnPerStep = (lnMax - lnMin) / 254;
    // a size limit compared in the packed BYTE domain: one log per call, not
    // three per splat
    const maxByte = d.maxSize > 0 ? Math.floor((Math.log(d.maxSize) - lnMin) / lnPerStep) + 1 : 256;
    const minA = Math.round(d.minOpacity * 255);
    const tint = editing && st.selCount > 0;
    let shownBefore = 0;
    for (let i = 0; i < st.n; i++) shownBefore += st.alive[i];
    for (let i = 0; i < st.n; i++) {
      const w0 = st.orig[i * 4], w3 = st.orig[i * 4 + 3];
      const a = w0 >>> 24;
      const big = Math.max(w3 & 255, (w3 >>> 8) & 255, (w3 >>> 16) & 255) > maxByte;
      const ok = !removed[i] && a >= minA && !big;
      st.alive[i] = ok ? 1 : 0;
      let out = ok ? w0 : w0 & 0x00ffffff;
      if (ok && tint && st.sel[i]) {
        const r = w0 & 255, g = (w0 >>> 8) & 255, b = (w0 >>> 16) & 255;
        out = (((r + SEL_RGB[0] * 2) / 3) | 0) | ((((g + SEL_RGB[1] * 2) / 3) | 0) << 8)
          | ((((b + SEL_RGB[2] * 2) / 3) | 0) << 16) | (a << 24);
      }
      arr[i * 4] = out;
    }
    packed.needsUpdate = true;
    mesh.updateVersion();
    let shown = 0;
    for (let i = 0; i < st.n; i++) shown += st.alive[i];
    if (shown !== shownBefore) this.onApplied?.();

    // POINT CLOUD: the gaussians fade out (opacity 0 leaves the mesh in the
    // scene graph, so the dots — its child — still ride its transform, get
    // outlined with it and are picked as it) and every shown centre is a dot
    if (d.mode === 'POINTS') {
      mesh.opacity = 0;
      let count = 0;
      for (let i = 0; i < st.n; i++) count += st.alive[i];
      const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
      let w = 0;
      for (let i = 0; i < st.n; i++) {
        if (!st.alive[i]) continue;
        pos[w * 3] = st.centers[i * 3]; pos[w * 3 + 1] = st.centers[i * 3 + 1]; pos[w * 3 + 2] = st.centers[i * 3 + 2];
        const w0 = st.orig[i * 4];
        const sel = tint && st.sel[i];
        col[w * 3] = TO_LINEAR[sel ? SEL_RGB[0] : w0 & 255];
        col[w * 3 + 1] = TO_LINEAR[sel ? SEL_RGB[1] : (w0 >>> 8) & 255];
        col[w * 3 + 2] = TO_LINEAR[sel ? SEL_RGB[2] : (w0 >>> 16) & 255];
        w++;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (!st.points) {
        st.points = new THREE.Points(geo, new THREE.PointsMaterial({
          vertexColors: true, sizeAttenuation: false, map: dot(), alphaTest: 0.5,
        }));
        // picking goes through the cloud's own centres (splatpick.ts); a
        // Points raycast's threshold is in world units and would hit
        // everything within a metre
        st.points.raycast = () => {};
        mesh.add(st.points);
      } else {
        st.points.geometry.dispose();
        st.points.geometry = geo;
      }
      (st.points.material as THREE.PointsMaterial).size = d.pointSize * (window.devicePixelRatio || 1);
    } else {
      mesh.opacity = 1;
      if (st.points) {
        mesh.remove(st.points);
        st.points.geometry.dispose();
        (st.points.material as THREE.Material).dispose();
        st.points = null;
      }
    }
  }

  meshFor(id: number): SplatMesh | null { return this.meshes.get(id)?.mesh ?? null; }

  /** Splats flagged as draw targets, for ctx.surfaces (SURFACE placement). */
  drawTargets(scene: GPScene): THREE.Object3D[] {
    return scene.splats
      .filter((s) => s.visible && s.drawTarget)
      .map((s) => this.meshes.get(s.id)?.mesh)
      .filter((m): m is SplatMesh => !!m);
  }

  dispose(): void {
    for (const { mesh } of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.dispose?.();
    }
    this.meshes.clear();
  }

  /**
   * Serialize a loaded splat to a standard (uncompressed) 3DGS PLY —
   * the interchange format every splat tool reads. Inverse of the usual
   * reader transforms: opacity -> logit, scale -> log, color -> f_dc.
   */
  exportPly(id: number): ArrayBuffer | null {
    const mesh = this.meshFor(id);
    const packed = (mesh as unknown as { packedSplats?: {
      getNumSplats(): number;
      forEachSplat(cb: (index: number, center: THREE.Vector3, scales: THREE.Vector3,
        quaternion: THREE.Quaternion, opacity: number, color: THREE.Color) => void): void;
    } })?.packedSplats;
    if (!packed) return null;
    const n0 = packed.getNumSplats();
    if (!n0) return null;
    // WHAT YOU SEE IS WHAT YOU EXPORT: removed and filtered splats are left
    // out, and the colours come from the file as loaded, not the tint
    const st = this.edits.get(id);
    const arr = (packed as unknown as { packedArray?: Uint32Array }).packedArray;
    const shown = st ? st.alive : null;
    let n = n0;
    if (shown) { n = 0; for (let i = 0; i < n0; i++) n += shown[i]; }
    const current = st && arr ? arr.slice(0, n0 * 4) : null;
    if (st && arr) arr.set(st.orig);

    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
      'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n`
      + props.map((p) => `property float ${p}`).join('\n') + '\nend_header\n';
    const headerBytes = new TextEncoder().encode(header);
    const buffer = new ArrayBuffer(headerBytes.length + n * props.length * 4);
    new Uint8Array(buffer).set(headerBytes);
    const view = new DataView(buffer, headerBytes.length);
    const SH_C0 = 0.28209479177387814;
    const logit = (v: number) => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, v)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, v))));
    let off = 0;
    const put = (v: number) => { view.setFloat32(off, v, true); off += 4; };
    packed.forEachSplat((i, center, scales, quat, opacity, color) => {
      if (shown && !shown[i]) return;
      put(center.x); put(center.y); put(center.z);
      put((color.r - 0.5) / SH_C0); put((color.g - 0.5) / SH_C0); put((color.b - 0.5) / SH_C0);
      put(logit(opacity));
      put(Math.log(Math.max(1e-9, scales.x)));
      put(Math.log(Math.max(1e-9, scales.y)));
      put(Math.log(Math.max(1e-9, scales.z)));
      put(quat.w); put(quat.x); put(quat.y); put(quat.z);
    });
    if (current && arr) arr.set(current);
    return buffer;
  }
}
