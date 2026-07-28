// One texture atlas for every image a GP material samples.
//
// This exists to unblock per-stroke textures ("N8"). A layer's strokes are
// merged into ONE geometry drawn by ONE shared ShaderMaterial, so a stroke
// cannot carry its own sampler uniform — that is the whole reason textured
// brushes were impossible. Splitting the batch per material would restore
// per-material samplers but throw away the merge that keeps drawing cheap.
//
// So: pack every image into a single atlas bound once as uAtlas, and give
// each vertex the sub-rect of the atlas its material lives in (aTexRect =
// x, y, width, height in atlas UV space). The shader tiles inside that rect
// with fract(), so a stroke can still repeat its texture along its length.
//
// Packing is shelf-based: sort by height, lay rows left to right. Good
// enough for the tens-of-brush-textures scale this is for, and it keeps
// the atlas deterministic — same image set in, same layout out.
import * as THREE from 'three';
import type { GPScene, TGImage } from '../core/types';

/** Atlas UV rect: [x, y, width, height], all 0..1 in atlas space. */
export type AtlasRect = [number, number, number, number];

const ATLAS_SIZE = 2048;
const CELL_MAX = 512;  // downscale anything larger; brush tips don't need more
const GUTTER = 2;      // transparent margin, so bilinear taps can't bleed

interface Packed { id: number; rect: AtlasRect }

export class TextureAtlas {
  /** Bound once as uAtlas. Null until the first image resolves. */
  texture: THREE.Texture | null = null;
  /** Bumped whenever the atlas repacks, so callers can rebuild geometry. */
  version = 0;

  private rects = new Map<number, AtlasRect>();
  private key = '';
  private building = false;
  private canvas: HTMLCanvasElement | null = null;
  private onReady: (() => void) | null = null;

  /** Called after an async repack finishes (geometry must be rebuilt). */
  setOnReady(fn: () => void): void { this.onReady = fn; }

  /** Where this image sits in the atlas, or null if it isn't packed. */
  rectOf(imageId: number | null | undefined): AtlasRect | null {
    if (imageId == null) return null;
    return this.rects.get(imageId) ?? null;
  }

  /**
   * Repack if the set of images referenced by GP materials changed. Cheap
   * to call every frame: it hashes the id list and bails when unchanged.
   */
  sync(scene: GPScene): void {
    const wanted = referencedImages(scene);
    const key = wanted.map((i) => `${i.id}:${i.src.length}`).join(',');
    if (key === this.key || this.building) return;
    this.key = key;
    if (!wanted.length) {
      this.rects.clear();
      this.texture?.dispose();
      this.texture = null;
      this.version++;
      return;
    }
    void this.build(wanted);
  }

  private async build(images: TGImage[]): Promise<void> {
    this.building = true;
    try {
      const loaded: { img: HTMLImageElement; id: number; w: number; h: number }[] = [];
      for (const rec of images) {
        try {
          const img = new Image();
          img.src = rec.src;
          await img.decode();
          const scale = Math.min(1, CELL_MAX / Math.max(img.naturalWidth, img.naturalHeight));
          loaded.push({
            img, id: rec.id,
            w: Math.max(1, Math.round(img.naturalWidth * scale)),
            h: Math.max(1, Math.round(img.naturalHeight * scale)),
          });
        } catch { /* a broken dataURL shouldn't take the whole atlas down */ }
      }
      if (!loaded.length) { this.building = false; return; }

      // shelf pack, tallest first
      const order = [...loaded].sort((a, b) => b.h - a.h);
      const packed: Packed[] = [];
      let x = GUTTER, y = GUTTER, shelfH = 0;
      const draw: { img: HTMLImageElement; x: number; y: number; w: number; h: number }[] = [];
      for (const it of order) {
        if (x + it.w + GUTTER > ATLAS_SIZE) { x = GUTTER; y += shelfH + GUTTER; shelfH = 0; }
        if (y + it.h + GUTTER > ATLAS_SIZE) break; // atlas full — remaining images go untextured
        draw.push({ img: it.img, x, y, w: it.w, h: it.h });
        packed.push({
          id: it.id,
          rect: [x / ATLAS_SIZE, y / ATLAS_SIZE, it.w / ATLAS_SIZE, it.h / ATLAS_SIZE],
        });
        x += it.w + GUTTER;
        shelfH = Math.max(shelfH, it.h);
      }

      const canvas = this.canvas ??= document.createElement('canvas');
      canvas.width = ATLAS_SIZE;
      canvas.height = ATLAS_SIZE;
      const g = canvas.getContext('2d')!;
      g.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
      for (const d of draw) g.drawImage(d.img, d.x, d.y, d.w, d.h);

      this.rects.clear();
      for (const p of packed) this.rects.set(p.id, p.rect);

      this.texture?.dispose();
      const tex = new THREE.CanvasTexture(canvas);
      // Rects are measured from the canvas TOP-left. three.js flips textures
      // on upload by default, which would put row 0 at v=1 and make every
      // rect sample the empty bottom of the atlas — i.e. alpha 0, and every
      // textured stroke silently discards. Keep canvas space == UV space.
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;  // no mips: neighbours would bleed
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this.texture = tex;
      this.version++;
    } finally {
      this.building = false;
    }
    this.onReady?.();
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.rects.clear();
  }
}

/** Images any GP material samples, deduped, in stable id order. */
function referencedImages(scene: GPScene): TGImage[] {
  const ids = new Set<number>();
  for (const ob of scene.objects) {
    for (const m of ob.materials) {
      if (m.strokeImageId != null) ids.add(m.strokeImageId);
      if (m.fillImageId != null) ids.add(m.fillImageId);
    }
  }
  return scene.images.filter((i) => ids.has(i.id)).sort((a, b) => a.id - b.id);
}

export const gpAtlas = new TextureAtlas();
