// The asset library: reusable objects you place into scenes — a scan of the
// room, quick models of the works to be hung in it, a drawn figure.
//
// An asset is an object DEFINITION plus a thumbnail. The heavy part of a
// scan or a model is its file, and that is not in here: the definition
// refers to it as a `store:` source (io/blobstore.ts), so the library stays
// small and the file is stored once however many times it is placed or
// saved. Records live in IndexedDB — the library used to be in
// localStorage, which holds about 5 MB for the whole app and so could not
// have held a single real asset — with an in-memory copy so the UI can list
// them synchronously while it builds panels.
import type { GPObject, TGMesh, TGSplat } from '../core/types';
import { idb } from './blobstore';

export interface TGAsset {
  id: number;
  name: string;
  kind: 'GP' | 'MESH' | 'SPLAT';
  /** GP: serializeGPObject JSON; MESH/SPLAT: the entity def, id/parent/select stripped */
  payload: string;
  /** a small picture of it, as a data URL */
  thumb?: string;
  created?: number;
}

/** The drag payload a Library tile carries into the viewport. */
export const ASSET_MIME = 'application/x-threegrease-asset';

const LEGACY_KEY = 'threegrease.assets';
let cache: TGAsset[] = [];
let listeners: (() => void)[] = [];

/** Load the library once at startup (and adopt anything the old
 *  localStorage library still holds). */
export async function initAssets(): Promise<void> {
  try {
    cache = await idb<TGAsset[]>('assets', 'readonly', (s) => s.getAll());
  } catch { cache = []; }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]') as TGAsset[];
    for (const a of legacy) {
      if (cache.some((c) => c.id === a.id)) continue;
      cache.push(a);
      await idb('assets', 'readwrite', (s) => s.put(a));
    }
    if (legacy.length) localStorage.removeItem(LEGACY_KEY);
  } catch { /* nothing to migrate */ }
  cache.sort((a, b) => (a.created ?? a.id) - (b.created ?? b.id));
  notify();
}

/** Called when the library changes, so panels can redraw. */
export function onAssetsChanged(fn: () => void): void { listeners.push(fn); }
function notify(): void { for (const fn of listeners) fn(); }

export function listAssets(): TGAsset[] { return cache; }

export function saveAsset(
  name: string, kind: TGAsset['kind'], payload: string, thumb?: string,
): TGAsset {
  const asset: TGAsset = { id: Date.now() % 1e9, name, kind, payload, thumb, created: Date.now() };
  cache = [...cache, asset];
  void idb('assets', 'readwrite', (s) => s.put(asset))
    .catch((err) => alert(`Could not save "${name}" to the library: ${err}`));
  notify();
  return asset;
}

export function updateAsset(id: number, patch: Partial<Omit<TGAsset, 'id'>>): void {
  const a = cache.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  void idb('assets', 'readwrite', (s) => s.put(a));
  notify();
}

export function deleteAsset(id: number): void {
  cache = cache.filter((a) => a.id !== id);
  void idb('assets', 'readwrite', (s) => s.delete(id));
  notify();
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
