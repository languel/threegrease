// OUTPUT WINDOWS: a chosen camera rendered into its own popup — a projector,
// one screen of a multi-view installation, a clean window for OBS to capture,
// a recording.
//
// EVERYTHING STAYS ON THE GPU. Each window gets its own WebGLRenderer whose
// canvas lives INSIDE the popup's document, and draws the SAME three.js scene
// the main view draws. Nothing is read back, copied through the CPU or
// re-encoded between windows: three keeps a separate set of GPU buffers,
// textures and programs per renderer, uploads each once, and after that an
// output costs what a second view always costs — its draw calls.
//
// Three things in the shared scene are not simply "the scene" and are swapped
// around each output's render, then put back:
//   - EDITOR FURNITURE (grid, gizmo, light glyphs, the poly edit overlay,
//     selection rims): anything tagged `userData.overlay` or `hoverShell`.
//     A projector must never throw a picture of the tools.
//   - SHADING. An output has its own, independent of the main viewport's —
//     the main view can be Wireframe while the projector shows Rendered.
//     Shading is three things in this app: whether the LAMPS light
//     (LightManager.overrideEnabled), the WORLD's environment and background
//     (a WorldManager of the output's own, see below) and WIREFRAME on the
//     managers' materials (`overrideWire`).
//   - THE WORLD. An environment map is a PMREM render target, and a render
//     target only exists in the context that drew it — handed to a second
//     renderer it is an empty texture, and every lit surface comes out BLACK.
//     So each output owns a WorldManager built on its own renderer, which
//     builds its own PMREM from the same scene.world.
//
// A browser throttles requestAnimationFrame in a hidden or minimised window.
// An installation's control laptop is exactly that — behind the projector, or
// shut — so each output also ticks the WHOLE app from its own animation frame
// whenever the main loop has gone quiet (`OutputHost.tickIfStale`), or the
// show would freeze the moment nobody was looking at the editor.
import * as THREE from 'three';
import type { GPCamera, GPScene, TGOutput } from '../core/types';
import type { AppCtx } from '../tools/context';
import { activeCam } from '../core/gpdata';
import { evalCamera } from '../anim/camera';
import { worldMatrixOf } from '../tools/objects';
import { WorldManager } from '../render/world';
import type { LightManager } from '../render/lights';
import { ScenePost, postActive } from '../fx/scenefx';
import { LensCamera, isCurved } from '../render/lens';

export interface OutputHost {
  ctx: AppCtx;
  scene3: THREE.Scene;
  mainRenderer: THREE.WebGLRenderer;
  mainWorld: WorldManager;
  lights: LightManager;
  /** furniture that is not tagged `overlay` (the grid, the gizmo) */
  furniture(): THREE.Object3D[];
  /** true while the main view is WRITING into this camera (looking through
   *  it with lock-to-view): its stored transform is then the live one, and
   *  its keys must not override what the operator is doing */
  cameraLive(cam: GPCamera): boolean;
  /** run one app frame if the main loop has gone quiet */
  tickIfStale(): void;
  /** a window opened, closed, or started/stopped recording */
  changed(): void;
  status(text: string): void;
}

/** A screen from the Window Management API (only the fields used here). */
export interface OutputScreen {
  label: string;
  width: number; height: number;
  availLeft: number; availTop: number; availWidth: number; availHeight: number;
  isPrimary: boolean;
}

interface Live {
  win: Window;
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  world: WorldManager;
  post: ScenePost | null;
  lens: LensCamera;
  cam: THREE.PerspectiveCamera;
  size: [number, number];
  recorder: MediaRecorder | null;
  chunks: Blob[];
  raf: number;
  /** frame time of the last render, for the panel's fps readout */
  frames: number[];
}

/** Resolutions worth one click. 0 x 0 follows the window. */
export const OUTPUT_PRESETS: [string, number, number][] = [
  ['Follow window', 0, 0],
  ['1280 × 720 (HD)', 1280, 720],
  ['1920 × 1080 (Full HD)', 1920, 1080],
  ['1920 × 1200 (WUXGA)', 1920, 1200],
  ['2560 × 1440 (QHD)', 2560, 1440],
  ['3840 × 2160 (4K)', 3840, 2160],
  ['1080 × 1920 (portrait)', 1080, 1920],
  ['1024 × 768 (XGA)', 1024, 768],
];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title></title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
canvas{display:block;width:100vw;height:100vh;outline:none}
body.idle,body.idle canvas{cursor:none}
</style></head><body><canvas tabindex="0"></canvas></body></html>`;

export class OutputManager {
  private live = new Map<number, Live>();
  private screensList: OutputScreen[] = [];

  constructor(private host: OutputHost) {}

  isOpen(id: number): boolean {
    const l = this.live.get(id);
    return !!l && !l.win.closed;
  }

  isRecording(id: number): boolean { return !!this.live.get(id)?.recorder; }

  /** Pixel size actually being drawn, and frames per second over the last
   *  second — the two numbers worth checking on a projector. */
  info(id: number): { width: number; height: number; fps: number } | null {
    const l = this.live.get(id);
    if (!l || l.win.closed) return null;
    const now = performance.now();
    l.frames = l.frames.filter((t) => now - t < 1000);
    return { width: l.size[0], height: l.size[1], fps: l.frames.length };
  }

  screens(): OutputScreen[] { return this.screensList; }

  /**
   * Ask for the machine's screens (Window Management API — Chrome, behind a
   * permission prompt). Without it an output still opens; it just opens
   * wherever the browser puts it, and you drag it to the projector.
   */
  async detectScreens(): Promise<OutputScreen[]> {
    const w = window as unknown as { getScreenDetails?: () => Promise<{ screens: OutputScreen[] }> };
    if (!w.getScreenDetails) {
      this.host.status('This browser cannot list screens — drag the output window to the projector instead');
      return [];
    }
    try {
      const d = await w.getScreenDetails();
      this.screensList = d.screens.map((s, i) => ({
        label: s.label || `Screen ${i + 1}`,
        width: s.width, height: s.height,
        availLeft: s.availLeft, availTop: s.availTop,
        availWidth: s.availWidth, availHeight: s.availHeight,
        isPrimary: s.isPrimary,
      }));
    } catch {
      this.host.status('Screen access was refused — drag the output window to the projector instead');
      this.screensList = [];
    }
    this.host.changed();
    return this.screensList;
  }

  /**
   * Open (or bring back) an output's window. Must run inside a click: a
   * browser blocks a popup that no gesture asked for.
   *
   * The name is stable per output, so after the editor is reloaded, Open
   * finds the SAME physical window — still on the projector where it was
   * put — and takes it over rather than opening a second one.
   */
  open(o: TGOutput): boolean {
    if (this.isOpen(o.id)) { this.live.get(o.id)!.win.focus(); return true; }
    this.close(o.id);
    const screen = o.screen != null ? this.screensList[o.screen] : undefined;
    const fixed = o.width > 0 && o.height > 0;
    const [rw, rh] = fixed ? [o.width, o.height] : [1280, 720];
    let features: string;
    if (screen) {
      // fill the chosen screen; double-click (or F) then takes it fullscreen
      features = `popup=yes,left=${screen.availLeft},top=${screen.availTop},`
        + `width=${screen.availWidth},height=${screen.availHeight}`;
    } else {
      // a window you can see all of, at the output's own aspect
      const k = Math.min(1, 960 / rw, 640 / rh);
      features = `popup=yes,width=${Math.round(rw * k)},height=${Math.round(rh * k)}`;
    }
    const win = window.open('', `threegrease-output-${o.id}`, features);
    if (!win) {
      this.host.status('The browser blocked the output window — allow popups for this page');
      return false;
    }
    const doc = win.document;
    doc.open();
    doc.write(PAGE);
    doc.close();
    doc.title = o.name;
    const canvas = doc.querySelector('canvas') as HTMLCanvasElement;

    const main = this.host.mainRenderer;
    // stencil: grease-pencil masks and holdouts are drawn through it
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = main.outputColorSpace;
    renderer.toneMapping = main.toneMapping;
    renderer.toneMappingExposure = main.toneMappingExposure;
    renderer.shadowMap.enabled = main.shadowMap.enabled;
    renderer.shadowMap.type = main.shadowMap.type;

    const world = new WorldManager(renderer);
    world.liveSource = this.host.mainWorld.liveSource;

    const live: Live = {
      win, canvas, renderer, world, post: null, lens: new LensCamera(),
      cam: new THREE.PerspectiveCamera(50, rw / rh, 0.01, 500),
      size: [0, 0], recorder: null, chunks: [], raf: 0, frames: [],
    };
    this.live.set(o.id, live);

    // fullscreen needs a gesture IN this window: double-click or F
    const toggleFull = () => {
      if (doc.fullscreenElement) void doc.exitFullscreen();
      else void doc.documentElement.requestFullscreen().catch(() => {});
    };
    canvas.addEventListener('dblclick', toggleFull);
    win.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFull(); });
    // the pointer is not part of the picture: it hides once it stops moving
    let idle = 0;
    const wake = () => {
      doc.body.classList.remove('idle');
      win.clearTimeout(idle);
      idle = win.setTimeout(() => doc.body.classList.add('idle'), 1500);
    };
    win.addEventListener('mousemove', wake);
    wake();
    // closing the window is closing the output
    win.addEventListener('pagehide', () => this.close(o.id));
    // keep the show running when the editor window is hidden (see top)
    const tick = () => {
      live.raf = win.requestAnimationFrame(tick);
      this.host.tickIfStale();
    };
    live.raf = win.requestAnimationFrame(tick);

    this.host.changed();
    return true;
  }

  close(id: number): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    if (l.recorder && l.recorder.state !== 'inactive') l.recorder.stop();
    try { l.win.cancelAnimationFrame(l.raf); } catch { /* window already gone */ }
    l.post?.dispose();
    l.renderer.dispose();
    if (!l.win.closed) l.win.close();
    this.host.changed();
  }

  closeAll(): void { for (const id of [...this.live.keys()]) this.close(id); }

  /**
   * Record the output's own canvas to a video file. The browser's encoder
   * takes the canvas as a stream on the GPU side — no frame is read back
   * here. Stop saves a .webm.
   */
  toggleRecord(o: TGOutput): void {
    const l = this.live.get(o.id);
    if (!l) return;
    if (l.recorder) { l.recorder.stop(); return; }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) { this.host.status('This browser cannot record video'); return; }
    const stream = l.canvas.captureStream(60);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 20_000_000 });
    l.chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) l.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(l.chunks, { type: mime.split(';')[0] });
      l.chunks = [];
      l.recorder = null;
      stream.getTracks().forEach((t) => t.stop());
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = URL.createObjectURL(blob);
      a.download = `${o.name.replace(/[^\w-]+/g, '_')}-${stamp}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      this.host.changed();
    };
    rec.start(1000);
    l.recorder = rec;
    this.host.changed();
  }

  /** Draw every open output. Called once per app frame, AFTER the main view:
   *  each render swaps shared scene state and must put it back. */
  render(now: number): void {
    if (!this.live.size) return;
    const outs = this.host.ctx.scene.outputs ?? [];
    for (const [id, l] of [...this.live]) {
      const o = outs.find((x) => x.id === id);
      if (!o || l.win.closed) { this.close(id); continue; }
      this.renderOne(o, l, now);
    }
  }

  private renderOne(o: TGOutput, l: Live, now: number): void {
    const { ctx, scene3 } = this.host;
    const scene = ctx.scene;

    // SIZE: a fixed resolution is drawn at exactly that many pixels, and the
    // window only decides how it is shown (object-fit); following the window
    // draws at its real device pixels
    const fixed = o.width > 0 && o.height > 0;
    const dpr = l.win.devicePixelRatio || 1;
    const w = fixed ? o.width : Math.max(1, Math.round(l.win.innerWidth * dpr));
    const h = fixed ? o.height : Math.max(1, Math.round(l.win.innerHeight * dpr));
    if (l.size[0] !== w || l.size[1] !== h) {
      l.renderer.setSize(w, h, false);
      l.post?.setSize(w, h);
      l.size = [w, h];
    }
    l.canvas.style.objectFit = !fixed ? 'fill'
      : o.fit === 'COVER' ? 'cover' : o.fit === 'STRETCH' ? 'fill' : 'contain';
    if (l.win.document.title !== o.name) l.win.document.title = o.name;

    const camData = (o.camera != null ? scene.cameras.find((c) => c.id === o.camera) : undefined)
      ?? activeCam(scene);
    if (!camData) return;
    this.poseCamera(l.cam, camData, scene, w, h);

    // ---- swap the shared scene over to this output ----
    const hidden: THREE.Object3D[] = [];
    for (const f of this.host.furniture()) if (f.visible) { f.visible = false; hidden.push(f); }
    scene3.traverse((obj) => {
      const u = obj.userData;
      if ((u.overlay || u.hoverShell) && obj.visible) { obj.visible = false; hidden.push(obj); }
    });
    const mainWire = ctx.settings.shading === 'WIREFRAME';
    const outWire = o.shading === 'WIREFRAME';
    const undoWire = mainWire !== outWire ? overrideWire(scene3, outWire) : null;
    const undoLights = this.host.lights.overrideEnabled(o.shading === 'RENDERED');
    const bg = scene3.background;
    const saved = {
      env: scene3.environment, envI: scene3.environmentIntensity,
      bg, bgColor: bg instanceof THREE.Color ? bg.clone() : null,
      bgI: scene3.backgroundIntensity, bgBlur: scene3.backgroundBlurriness,
      bgRot: scene3.backgroundRotation.clone(), envRot: scene3.environmentRotation.clone(),
      fog: scene3.fog,
    };
    const mainSky = this.host.mainWorld.setSkyVisible(false);

    try {
      l.world.update(scene3, scene, o.shading, ctx.settings.upAxis === 'Z');
      const look = scene.post;
      const styled = o.look && postActive(look);
      if (styled && !l.post) l.post = new ScenePost(w, h);
      const target = styled ? l.post!.target : null;
      l.renderer.setRenderTarget(target);
      if (styled) l.renderer.clear();
      if (isCurved(camData.lens)) {
        l.cam.updateMatrixWorld(true);
        l.lens.render(l.renderer, scene3, l.cam, camData.lens!, target);
      } else {
        l.renderer.render(scene3, l.cam);
      }
      if (styled) {
        l.post!.present(l.renderer, scene3, l.cam, look, now / 1000);
        l.renderer.setRenderTarget(null);
      }
      l.frames.push(now);
    } catch (err) {
      console.error(`output "${o.name}":`, err);
    } finally {
      // ---- and back to the main view's ----
      l.world.setSkyVisible(false);
      this.host.mainWorld.setSkyVisible(mainSky);
      scene3.environment = saved.env;
      scene3.environmentIntensity = saved.envI;
      scene3.background = saved.bg;
      if (saved.bgColor && saved.bg instanceof THREE.Color) saved.bg.copy(saved.bgColor);
      scene3.backgroundIntensity = saved.bgI;
      scene3.backgroundBlurriness = saved.bgBlur;
      scene3.backgroundRotation.copy(saved.bgRot);
      scene3.environmentRotation.copy(saved.envRot);
      scene3.fog = saved.fog;
      undoLights();
      undoWire?.();
      for (const obj of hidden) obj.visible = true;
    }
  }

  /**
   * Put a three camera where the scene camera is. Keys drive it unless the
   * main view is writing into it right now (looking through with lock to
   * view), when its stored transform IS the live one. Otherwise the object
   * transform, parent included.
   */
  private poseCamera(cam: THREE.PerspectiveCamera, data: GPCamera, scene: GPScene, w: number, h: number): void {
    if (data.keys.length && !this.host.cameraLive(data)) {
      const pose = evalCamera(data, scene.frame);
      cam.position.copy(pose.position);
      cam.quaternion.copy(pose.quaternion);
      cam.fov = pose.fov;
    } else {
      worldMatrixOf(scene, { kind: 'CAMERA', id: data.id })
        .decompose(cam.position, cam.quaternion, new THREE.Vector3());
      cam.fov = data.fov;
    }
    cam.near = data.near ?? 0.01;
    cam.far = data.far ?? 500;
    cam.aspect = w / h;
    // LENS SHIFT on an ordinary lens is an off-axis frustum: a projector on
    // a shelf throws UP without tilting, so its picture stays rectangular on
    // the wall. `shiftX/Y` are in half-frames (render/lens.ts); a curved
    // lens applies its own in the lens pass.
    const sx = data.lens?.shiftX ?? 0, sy = data.lens?.shiftY ?? 0;
    if (!isCurved(data.lens) && (sx || sy)) cam.setViewOffset(w, h, sx * w / 2, -sy * h / 2, w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }
}

/**
 * Wireframe for ONE render, or its absence: the material managers bake the
 * view's wireframe into the materials they own (`userData.ownWire` is what
 * the object itself asked for), so an output under other shading flips it
 * for its own draw and flips it back. An import in wireframe is also drawn
 * UNTEXTURED (meshes.ts), so its map comes back for a textured output and
 * goes again after — a program switch three answers from its cache, not a
 * recompile.
 */
function overrideWire(scene3: THREE.Scene, wire: boolean): () => void {
  type WireMat = THREE.Material & { wireframe?: boolean; map?: THREE.Texture | null };
  const saved: { m: WireMat; wf: boolean; map?: THREE.Texture | null }[] = [];
  scene3.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || obj.userData.overlay) return;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as WireMat[];
    for (const m of mats) {
      const u = m.userData as { ownWire?: boolean; wired?: boolean; baseMap?: THREE.Texture | null };
      if (u.ownWire === undefined) continue;
      const want = wire || u.ownWire;
      if (!!m.wireframe === want) continue;
      const rec: { m: WireMat; wf: boolean; map?: THREE.Texture | null } = { m, wf: !!m.wireframe };
      m.wireframe = want;
      if (u.wired !== undefined) {
        const map = want ? null : (u.baseMap ?? m.map ?? null);
        if (map !== (m.map ?? null)) { rec.map = m.map ?? null; m.map = map; m.needsUpdate = true; }
      }
      saved.push(rec);
    }
  });
  return () => {
    for (const r of saved) {
      r.m.wireframe = r.wf;
      if (r.map !== undefined) { r.m.map = r.map; r.m.needsUpdate = true; }
    }
  };
}
