// Stencil masking for the paint tools (Blender's Texture Paint stencil,
// generalized). Three very different-sounding sources —
//
//   IMAGE    an image datablock positioned on screen
//   VIDEO    the live MediaMime camera frame
//   OBJECTS  the rendered silhouette of chosen scene objects
//
// — all reduce to ONE primitive: a screen-space mask that answers
// "how much paint is allowed at this pixel?". Every paint tool then just
// multiplies its per-dab strength by maskAt(x, y), so masking is a single
// multiply at each tool's existing falloff site rather than bespoke logic
// per tool.
//
// The mask is built once per stroke (begin) and sampled per dab, so a
// silhouette render + readback costs one pass per stroke, not per event.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { ObjRef } from './objects';
import { imageById } from '../core/gpdata';

/** Live-video source, wired once from App init (keeps MMCapture out of
 *  AppCtx, matching how splatpick/texpaint get their managers). */
let videoSource: (() => HTMLVideoElement | HTMLCanvasElement | null) | null = null;
export function setStencilVideoSource(fn: () => HTMLVideoElement | HTMLCanvasElement | null): void {
  videoSource = fn;
}

/** Objects the OBJECTS source should silhouette, resolved by App (which
 *  owns the managers that map an ObjRef to its three.js root). */
let objectResolver: ((refs: ObjRef[]) => THREE.Object3D[]) | null = null;
export function setStencilObjectResolver(fn: (refs: ObjRef[]) => THREE.Object3D[]): void {
  objectResolver = fn;
}

/** Cached decoded images for the IMAGE source, keyed by src. */
const imageCache = new Map<string, HTMLImageElement>();
function decoded(src: string): HTMLImageElement {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    imageCache.set(src, img);
  }
  return img;
}

export class StencilMask {
  private canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private data: ImageData | null = null;
  private rt: THREE.WebGLRenderTarget | null = null;

  /** True when a mask is armed and maskAt() should be consulted. */
  get active(): boolean { return this.data !== null; }

  /**
   * Build the screen-space mask for a stroke that's just starting.
   * Cheap for IMAGE/VIDEO (a 2D draw); for OBJECTS it renders the chosen
   * objects' silhouettes into a render target and reads them back once —
   * the codebase's first readRenderTargetPixels.
   */
  begin(ctx: AppCtx): void {
    this.data = null;
    const s = ctx.settings.stencil;
    if (!s.enabled) return;
    const rect = ctx.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = w;
    this.canvas.height = h;
    this.g.clearRect(0, 0, w, h);

    if (s.source === 'OBJECTS') this.renderSilhouette(ctx, w, h);
    else this.drawFlat(ctx, w, h);

    try { this.data = this.g.getImageData(0, 0, w, h); }
    catch { this.data = null; } // tainted canvas — fail open rather than blocking paint
  }

  /** IMAGE / VIDEO: draw the source with the user's screen placement. */
  private drawFlat(ctx: AppCtx, w: number, h: number): void {
    const s = ctx.settings.stencil;
    let src: CanvasImageSource | null = null;
    let sw = 0, sh = 0;
    if (s.source === 'VIDEO') {
      const el = videoSource?.() ?? null;
      if (el) {
        src = el;
        sw = (el as HTMLVideoElement).videoWidth || (el as HTMLCanvasElement).width;
        sh = (el as HTMLVideoElement).videoHeight || (el as HTMLCanvasElement).height;
      }
    } else {
      const img = imageById(ctx.scene, s.imageId);
      if (img) {
        const el = decoded(img.src);
        if (el.complete && el.naturalWidth) { src = el; sw = el.naturalWidth; sh = el.naturalHeight; }
      }
    }
    if (!src || !sw || !sh) return;
    // aspect-fit into the viewport, then apply the user's placement
    const fit = Math.min(w / sw, h / sh) * s.scale;
    const dw = sw * fit, dh = sh * fit;
    this.g.save();
    this.g.translate(w / 2 + s.offset[0] * w, h / 2 + s.offset[1] * h);
    this.g.rotate(s.rotation);
    this.g.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    this.g.restore();
  }

  /**
   * OBJECTS: render just the chosen objects, flat white on black, from the
   * current camera. Reuses the app's established isolation idiom (save
   * every child's visibility, show only the targets, render, restore).
   */
  private renderSilhouette(ctx: AppCtx, w: number, h: number): void {
    const refs = ctx.settings.stencil.refs as ObjRef[];
    const targets = objectResolver?.(refs) ?? [];
    if (!targets.length) return;
    const gl = ctx.gl;
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h);
    }
    const wanted = new Set<THREE.Object3D>();
    for (const t of targets) t.traverseAncestors((a) => wanted.add(a));
    for (const t of targets) wanted.add(t);

    const saved: { o: THREE.Object3D; v: boolean }[] = [];
    ctx.scene3.traverse((o) => { saved.push({ o, v: o.visible }); });
    for (const { o } of saved) {
      // keep ancestors visible so targets aren't culled by a hidden parent
      if (!wanted.has(o)) o.visible = targets.some((t) => isDescendant(o, t));
    }
    const savedBg = ctx.scene3.background;
    const savedOverride = ctx.scene3.overrideMaterial;
    const savedTarget = gl.getRenderTarget();
    const savedClear = gl.getClearColor(new THREE.Color());
    const savedAlpha = gl.getClearAlpha();

    ctx.scene3.background = null;
    ctx.scene3.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    gl.setRenderTarget(this.rt);
    gl.setClearColor(0x000000, 1);
    gl.clear();
    gl.render(ctx.scene3, ctx.camera);

    const px = new Uint8Array(w * h * 4);
    gl.readRenderTargetPixels(this.rt, 0, 0, w, h, px);

    ctx.scene3.overrideMaterial?.dispose();
    ctx.scene3.overrideMaterial = savedOverride;
    ctx.scene3.background = savedBg;
    gl.setRenderTarget(savedTarget);
    gl.setClearColor(savedClear, savedAlpha);
    for (const { o, v } of saved) o.visible = v;

    // GL reads bottom-up; the 2D canvas is top-down
    const out = this.g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      out.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    this.g.putImageData(out, 0, 0);
  }

  /**
   * How much paint is allowed at a canvas-relative pixel, 0..1.
   * Returns 1 when no mask is armed, so callers can multiply
   * unconditionally without branching.
   */
  maskAt(ctx: AppCtx, x: number, y: number): number {
    const s = ctx.settings.stencil;
    if (!this.data || !s.enabled) return 1;
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) {
      return s.invert ? 1 : 0; // outside the mask counts as masked-out
    }
    const i = (py * this.canvas.width + px) * 4;
    const d = this.data.data;
    // luminance x alpha: a grayscale image, an alpha cutout, and a white
    // silhouette on black all behave sensibly through one formula
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    let v = lum * (d[i + 3] / 255);
    if (s.invert) v = 1 - v;
    // threshold acts as a soft floor rather than a hard cut, so edges
    // stay feathered instead of aliasing
    return v <= s.threshold ? 0 : (v - s.threshold) / Math.max(1e-6, 1 - s.threshold);
  }

  /** Draw the stencil overlay so it can be seen and positioned. */
  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    if (!ctx.settings.stencil.enabled || !this.data) return;
    hud.save();
    hud.globalAlpha = 0.35;
    hud.drawImage(this.canvas, 0, 0);
    hud.restore();
  }

  /** Rebuild the preview outside a stroke (so the overlay tracks edits). */
  refresh(ctx: AppCtx): void {
    if (ctx.settings.stencil.enabled) this.begin(ctx);
    else this.data = null;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    this.data = null;
  }
}

function isDescendant(o: THREE.Object3D, root: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

/** One app-wide mask — paint tools share it (only one stroke at a time). */
export const stencilMask = new StencilMask();
