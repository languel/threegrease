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
import { getBlob, idb, putFile } from './blobstore';
import { LIVE_PREFIX } from './livesources';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';

export interface TGAsset {
  id: number;
  name: string;
  kind: 'GP' | 'MESH' | 'SPLAT' | 'STREAM' | 'POLY';
  /** GP: serializeGPObject JSON; MESH/SPLAT: the entity def, id/parent/select
   *  stripped; STREAM: { key, label, deviceId } of a live camera
   *  (io/livesources.ts) — the entry outlives the stream, so a camera you
   *  used stays in the Library and reopens from its tile */
  payload: string;
  /** a small picture of it, as a data URL */
  thumb?: string;
  /** the Library folder it is filed in; absent = unfiled */
  folder?: string;
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

/** Removed assets, for "Restore last removed" (session only). */
let lastRemoved: TGAsset[] = [];

export function removeAssets(ids: number[]): void {
  const set = new Set(ids);
  lastRemoved = cache.filter((a) => set.has(a.id));
  cache = cache.filter((a) => !set.has(a.id));
  for (const id of ids) void idb('assets', 'readwrite', (s) => s.delete(id));
  notify();
}

export function canRestoreAssets(): boolean { return lastRemoved.length > 0; }

export function restoreAssets(): void {
  for (const a of lastRemoved) {
    if (cache.some((c) => c.id === a.id)) continue;
    cache = [...cache, a];
    void idb('assets', 'readwrite', (s) => s.put(a));
  }
  lastRemoved = [];
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

/** The Library entry for a live camera, if it has one. */
export function streamAsset(key: string): TGAsset | undefined {
  return cache.find((a) => a.kind === 'STREAM' && (JSON.parse(a.payload) as { key: string }).key === key);
}

/** The texture a Library asset can give an object: an image asset's picture,
 *  or a camera's live stream. Null for everything else (models, scans...). */
export function assetTexture(asset: TGAsset): string | null {
  if (asset.kind === 'STREAM') return `${LIVE_PREFIX}${(JSON.parse(asset.payload) as { key: string }).key}`;
  if (asset.kind !== 'MESH') return null;
  const def = JSON.parse(asset.payload) as { kind?: string; texture?: string | null };
  return def.kind === 'PLANE' && def.texture ? def.texture : null;
}

// ---- folders ---------------------------------------------------------------
// A folder is just a name on its assets, plus this list so an EMPTY folder
// (made, not yet filled) survives. Kept in localStorage — it is a handful
// of names, and the assets themselves are in IndexedDB.
const FOLDERS_KEY = 'threegrease.libFolders';

export function listFolders(): string[] {
  let saved: string[] = [];
  try { saved = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]'); } catch { /* none */ }
  const all = new Set([...saved, ...cache.map((a) => a.folder).filter((f): f is string => !!f)]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

function saveFolders(list: string[]): void {
  try { localStorage.setItem(FOLDERS_KEY, JSON.stringify([...new Set(list)])); } catch { /* ignore */ }
}

export function addFolder(name: string): void {
  saveFolders([...listFolders(), name]);
  notify();
}

export function renameFolder(from: string, to: string): void {
  saveFolders(listFolders().map((f) => (f === from ? to : f)));
  for (const a of cache) if (a.folder === from) updateAsset(a.id, { folder: to });
  notify();
}

/** Remove a folder; its assets move to the top level, not the bin. */
export function deleteFolder(name: string): void {
  saveFolders(listFolders().filter((f) => f !== name));
  for (const a of cache) if (a.folder === name) updateAsset(a.id, { folder: undefined });
  notify();
}

export function moveAsset(id: number, folder: string | undefined): void {
  updateAsset(id, { folder });
}

// ---- export / import --------------------------------------------------------
// A Library travels as ONE zip: `library.json` (the records, thumbnails and
// folders) plus `files/<hash>/<name>` for every stored file an asset refers
// to — the scans and models, which are the whole reason a library is worth
// moving. Imported files go back into the store under their content hash,
// so an asset's `store:` reference still points at the same bytes.
const STORE_REF = /store:[0-9a-f]{16,}\/[^"\\]+/g;

export async function exportLibrary(): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  for (const a of cache) {
    for (const ref of new Set(a.payload.match(STORE_REF) ?? [])) {
      const path = `files/${ref.slice('store:'.length)}`;
      if (files[path]) continue;
      const blob = await getBlob(ref);
      if (blob) files[path] = new Uint8Array(await blob.arrayBuffer());
    }
  }
  files['library.json'] = strToU8(JSON.stringify({
    format: 'threegrease-library', version: 1, folders: listFolders(), assets: cache,
  }));
  // already-compressed media (glb, ply, png) gains little: store, don't deflate
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

/**
 * Bring a Library in: a zip made by exportLibrary, or a FOLDER of the same
 * (library.json + files/). Entries are added beside what is there — nothing
 * is replaced — with fresh ids. Returns how many assets came in, and any
 * loose media (a zip or folder with no library.json) for the caller to
 * import as ordinary files.
 */
export async function importLibrary(entries: Map<string, Blob>): Promise<{ added: number; loose: File[] }> {
  const json = [...entries.keys()].find((k) => k.endsWith('library.json'));
  if (!json) {
    const loose = [...entries].filter(([k]) => !k.endsWith('/') && !k.split('/').pop()!.startsWith('.'))
      .map(([k, b]) => new File([b], k.split('/').pop()!));
    return { added: 0, loose };
  }
  const root = json.slice(0, -'library.json'.length);
  const data = JSON.parse(await entries.get(json)!.text()) as { folders?: string[]; assets: TGAsset[] };
  // files first, so every reference resolves the moment its asset lands
  const remap = new Map<string, string>();
  for (const [path, blob] of entries) {
    if (!path.startsWith(`${root}files/`)) continue;
    const rel = path.slice(`${root}files/`.length);           // <hash>/<name>
    const name = rel.split('/').slice(1).join('/');
    remap.set(`store:${rel}`, await putFile(blob, name));
  }
  if (data.folders?.length) saveFolders([...listFolders(), ...data.folders]);
  let added = 0;
  for (const a of data.assets ?? []) {
    let payload = a.payload;
    for (const [from, to] of remap) payload = payload.split(from).join(to);
    const asset: TGAsset = { ...a, payload, id: (Date.now() + added) % 1e9 + Math.floor(Math.random() * 1000) };
    cache = [...cache, asset];
    await idb('assets', 'readwrite', (st) => st.put(asset));
    added++;
  }
  notify();
  return { added, loose: [] };
}

/** A zip file's entries as blobs, for importLibrary. */
export async function zipEntries(file: Blob): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  for (const [path, bytes] of Object.entries(files)) {
    if (path.startsWith('__MACOSX/')) continue;
    out.set(path, new Blob([bytes as BlobPart]));
  }
  return out;
}

export { strFromU8 };
export type { GPObject };
