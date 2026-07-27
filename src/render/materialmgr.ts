// Shared material + image datablocks -> three.js materials.
//
// Before this module every mesh-family object carried its own flattened
// `color/opacity/texture/unlit/doubleSided/wireframe` fields, and BOTH
// MeshManager and PolyMeshManager kept their own private, unbounded
// `textureFor()` image cache. This centralizes all of it:
//
//   scene.images[]    — one THREE.Texture cache, keyed by image id
//   scene.materials[] — TGMaterial -> a cached THREE material per material id
//
// Objects reference a material by id (`materialId`), so one material drives
// many objects. Legacy per-object fields still work: callers pass a
// `LegacyLook` fallback used whenever an object has no materialId, which is
// what keeps pre-migration saves (and MODEL imports, which own their own
// materials) rendering exactly as before.
//
// Named materialmgr.ts because render/materials.ts is the GP stroke/fill
// shader module — an unrelated system (see its note on why per-stroke
// textures need an atlas).
import * as THREE from 'three';
import type { GPScene, TGMaterial, TGTextureSlot, TextureSlotName, Vec3 } from '../core/types';

/** The pre-datablock per-object appearance fields. Used when an object has
 *  no `materialId` yet, so migration can be lazy and nothing regresses. */
export interface LegacyLook {
  color: Vec3;
  opacity: number;
  texture?: string | null;
  unlit?: boolean;
  doubleSided?: boolean;
  wireframe: boolean;
}

type StdMat = THREE.MeshStandardMaterial;

/** three.js map property for each of our slot channels. */
const SLOT_MAP: Record<TextureSlotName, keyof StdMat> = {
  base: 'map',
  roughness: 'roughnessMap',
  metallic: 'metalnessMap',
  normal: 'normalMap',
  emission: 'emissiveMap',
  alpha: 'alphaMap',
  ao: 'aoMap',
};

/** Channels whose images carry color data (sRGB) rather than linear data. */
const SRGB_SLOTS = new Set<TextureSlotName>(['base', 'emission']);

export class MaterialManager {
  /** id -> texture. The single image cache for the whole app. */
  private textures = new Map<number, { tex: THREE.Texture; src: string }>();
  /** raw src -> texture, for legacy objects whose texture isn't a datablock */
  private legacyTextures = new Map<string, THREE.Texture>();

  /** Texture for an image datablock, rebuilt if its src changed. */
  textureForImage(scene: GPScene, imageId: number): THREE.Texture | null {
    const img = scene.images.find((i) => i.id === imageId);
    if (!img) return null;
    const hit = this.textures.get(imageId);
    if (hit && hit.src === img.src) return hit.tex;
    hit?.tex.dispose();
    const tex = new THREE.TextureLoader().load(img.src);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(imageId, { tex, src: img.src });
    return tex;
  }

  /** Texture for a raw dataURL/URL (legacy per-object `texture` field). */
  textureForSrc(src: string): THREE.Texture {
    let tex = this.legacyTextures.get(src);
    if (!tex) {
      tex = new THREE.TextureLoader().load(src);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.legacyTextures.set(src, tex);
    }
    return tex;
  }

  /** Does this material want an unlit (MeshBasic) or lit (MeshStandard)
   *  material instance? Callers compare against what they built so they
   *  know when to swap the instance. */
  wantsUnlit(scene: GPScene, materialId: number | null | undefined, legacy: LegacyLook): boolean {
    const mat = materialId == null ? undefined : scene.materials.find((m) => m.id === materialId);
    return mat ? mat.unlit : !!legacy.unlit;
  }

  private applySlotTransform(tex: THREE.Texture, slot: TGTextureSlot): void {
    tex.center.set(0.5, 0.5);
    tex.offset.set(slot.offset[0], slot.offset[1]);
    tex.repeat.set(slot.scale[0], slot.scale[1]);
    tex.rotation = slot.rotation;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }

  /** Push a TGMaterial's channels onto a three.js material instance.
   *  `live` = a texture-paint stroke is in flight and the TOOL owns
   *  `.map` (a CanvasTexture over its paint canvas) — leave it alone. */
  private applyMaterial(target: StdMat, scene: GPScene, mat: TGMaterial, live: boolean): void {
    const hasBaseTex = !live && !!mat.slots.base?.enabled;
    // a base texture replaces the flat color rather than tinting it, matching
    // the pre-datablock behavior users are used to
    if (live || hasBaseTex) target.color.setRGB(1, 1, 1);
    else target.color.setRGB(...mat.baseColor);

    for (const name of Object.keys(SLOT_MAP) as TextureSlotName[]) {
      if (live && name === 'base') continue; // tool owns .map
      const prop = SLOT_MAP[name];
      const slot = mat.slots[name];
      const next = slot?.enabled ? this.textureForImage(scene, slot.imageId) : null;
      if (next && slot) {
        this.applySlotTransform(next, slot);
        next.colorSpace = SRGB_SLOTS.has(name) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      }
      if ((target as unknown as Record<string, unknown>)[prop as string] !== next) {
        (target as unknown as Record<string, unknown>)[prop as string] = next;
        target.needsUpdate = true;
      }
    }

    if ('roughness' in target) {
      target.roughness = mat.roughness;
      target.metalness = mat.metallic;
      target.emissive?.setRGB(
        mat.emission[0] * mat.emissionStrength,
        mat.emission[1] * mat.emissionStrength,
        mat.emission[2] * mat.emissionStrength,
      );
    }
    target.wireframe = mat.wireframe;
    target.side = mat.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    target.opacity = mat.opacity;
    this.applyBlend(target, mat.blend, mat.opacity, live);
  }

  private applyBlend(target: StdMat, blend: TGMaterial['blend'], opacity: number, live: boolean): void {
    const needsAlpha = opacity < 1 || !!target.map || live;
    switch (blend) {
      case 'ADD':
        target.transparent = true;
        target.blending = THREE.AdditiveBlending;
        target.depthWrite = false;
        break;
      case 'MULTIPLY':
        target.transparent = true;
        target.blending = THREE.MultiplyBlending;
        target.depthWrite = false;
        break;
      case 'BLEND':
        target.transparent = true;
        target.blending = THREE.NormalBlending;
        target.depthWrite = false;
        break;
      default: // OPAQUE — still honors opacity/alpha maps, like Blender's
        target.blending = THREE.NormalBlending;
        target.transparent = needsAlpha;
        target.depthWrite = opacity >= 0.99;
    }
  }

  /** Legacy path: an object with no materialId, driven by its own flattened
   *  fields. Byte-for-byte the behavior MeshManager/PolyMeshManager had. */
  private applyLegacy(target: StdMat, legacy: LegacyLook, live: boolean): void {
    if (live) {
      target.color.setRGB(1, 1, 1);
    } else {
      target.color.setRGB(...legacy.color);
      const tex = legacy.texture ? this.textureForSrc(legacy.texture) : null;
      if (target.map !== tex) {
        target.map = tex;
        if (tex) target.color.setRGB(1, 1, 1); // don't tint the image
        target.needsUpdate = true;
      }
    }
    target.wireframe = legacy.wireframe;
    target.side = legacy.doubleSided !== false ? THREE.DoubleSide : THREE.FrontSide;
    target.transparent = legacy.opacity < 1 || !!target.map;
    target.opacity = legacy.opacity;
    target.depthWrite = legacy.opacity >= 0.99;
  }

  /**
   * The one entry point renderers call per mesh per frame. Resolves the
   * object's material datablock (or its legacy fields) onto `target`.
   */
  apply(
    target: StdMat, scene: GPScene,
    materialId: number | null | undefined, legacy: LegacyLook, live = false,
  ): void {
    const mat = materialId == null ? undefined : scene.materials.find((m) => m.id === materialId);
    if (mat) this.applyMaterial(target, scene, mat, live);
    else this.applyLegacy(target, legacy, live);
  }

  dispose(): void {
    for (const { tex } of this.textures.values()) tex.dispose();
    for (const tex of this.legacyTextures.values()) tex.dispose();
    this.textures.clear();
    this.legacyTextures.clear();
  }
}

/** App-wide instance — the managers all share one image cache. */
export const materialManager = new MaterialManager();
