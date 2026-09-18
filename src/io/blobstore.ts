// Files that outlive the page: scans, models and images, kept in IndexedDB.
//
// Everything a scene references used to be a URL, and a file you dropped or
// picked became a `blob:` URL — which is valid for exactly as long as the
// tab is open. Reload and every scan in the scene is gone, which is why
// imports were named "(session only)". localStorage cannot help: it holds
// about 5 MB in total, and one gallery scan is 24.
//
// So file bytes live here, in IndexedDB, keyed by their SHA-256. A scene
// refers to one as `store:<hash>/<filename>`: the hash makes the same file
// dropped twice a single stored copy, and the filename is kept because the
// LOADERS need it — three's and Spark's both pick a parser by extension, and
// a bare blob URL has none (which is why an .obj picked from disk used to be
// handed to the glTF loader and fail).
//
// Resolving a reference yields an object URL, cached for the session.

const DB = 'threegrease';
const STORE = 'files';
const PREFIX = 'store:';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** One IndexedDB request as a promise. */
export async function idb<T>(
  store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keep a file; returns the reference a scene should store. */
export async function putFile(file: File | Blob, name?: string): Promise<string> {
  const filename = (name ?? (file as File).name ?? 'file').replace(/[/\\]/g, '_');
  const hash = await sha256(await file.arrayBuffer());
  const existing = await idb<unknown>(STORE, 'readonly', (s) => s.get(hash));
  if (!existing) await idb(STORE, 'readwrite', (s) => s.put(file, hash));
  return `${PREFIX}${hash}/${filename}`;
}

export function isStoreRef(src: string | null | undefined): boolean {
  return !!src && src.startsWith(PREFIX);
}

/** The filename a source stands for — the part loaders pick a parser by. */
export function sourceName(src: string): string {
  const clean = src.split('?')[0];
  return clean.slice(clean.lastIndexOf('/') + 1);
}

export function sourceExt(src: string): string {
  const n = sourceName(src);
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i + 1).toLowerCase();
}

const urls = new Map<string, string>();

/**
 * A URL a loader can fetch. Store references become object URLs (made once
 * per session); anything else is passed through untouched.
 */
export async function resolveSrc(src: string): Promise<string> {
  if (!isStoreRef(src)) return src;
  const hit = urls.get(src);
  if (hit) return hit;
  const hash = src.slice(PREFIX.length).split('/')[0];
  const blob = await idb<Blob | undefined>(STORE, 'readonly', (s) => s.get(hash));
  if (!blob) throw new Error(`${sourceName(src)} is not in this browser's file store`);
  const url = URL.createObjectURL(blob);
  urls.set(src, url);
  return url;
}

/** The stored bytes, for exporting or packing a scene. */
export async function getBlob(src: string): Promise<Blob | null> {
  if (!isStoreRef(src)) return null;
  const hash = src.slice(PREFIX.length).split('/')[0];
  return (await idb<Blob | undefined>(STORE, 'readonly', (s) => s.get(hash))) ?? null;
}
