// N6: tiny asset library — reusable objects saved to localStorage.
// GP objects store their full JSON; meshes/splats store their defs.
// blob: URLs are session-only, so MODEL/SPLAT sources saved from local
// files won't survive a reload — dataURL textures and remote URLs do.
import type { GPObject, TGMesh, TGSplat } from '../core/types';

export interface TGAsset {
  id: number;
  name: string;
  kind: 'GP' | 'MESH' | 'SPLAT';
  /** GP: serializeGPObject JSON; MESH/SPLAT: the entity def, id/parent/select stripped */
  payload: string;
}

const KEY = 'threegrease.assets';

export function listAssets(): TGAsset[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); }
  catch { return []; }
}

function write(assets: TGAsset[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(assets)); }
  catch (err) { alert(`Asset save failed (storage full?): ${err}`); }
}

export function saveAsset(name: string, kind: TGAsset['kind'], payload: string): TGAsset {
  const assets = listAssets();
  const asset = { id: Date.now() % 1e9, name, kind, payload };
  assets.push(asset);
  write(assets);
  return asset;
}

export function deleteAsset(id: number): void {
  write(listAssets().filter((a) => a.id !== id));
}

export function meshAssetPayload(m: TGMesh): string {
  const { id, parent, select, ...def } = m;
  void id; void parent; void select;
  return JSON.stringify(def);
}

export function splatAssetPayload(s: TGSplat): string {
  const { id, parent, select, ...def } = s;
  void id; void parent; void select;
  return JSON.stringify(def);
}

export type { GPObject };
