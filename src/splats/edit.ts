// Splat EDITING as data: which splats of a source file are gone, and which
// ones a filter hides. Nothing here knows about Spark, so the tools, the
// panel and the serializer can use it without pulling the 4.9 MB renderer
// in (see ./index.ts).
//
// A deletion is stored as a STRING, in whichever of two encodings is
// shorter — and which one wins depends on what was deleted:
//  - 'b' + base64 BITMASK: one bit per splat, so never more than n/6
//    characters. A scan's splats are not stored in spatial order, so a lasso
//    over half a room removes tens of thousands of scattered indices; as runs
//    that was ~50k numbers for a 100k scan, and every undo snapshot carried it.
//  - 'r' + base64 VARINT RUNS (gap, length, gap, length…): a few bytes for
//    a handful of floaters picked off one by one.
import type { TGSplatDisplay } from '../core/types';

export const DEFAULT_SPLAT_DISPLAY: TGSplatDisplay = {
  mode: 'SPLATS', pointSize: 2, minOpacity: 0, maxSize: 0,
};

export function splatDisplay(d: TGSplatDisplay | undefined): TGSplatDisplay {
  return { ...DEFAULT_SPLAT_DISPLAY, ...(d ?? {}) };
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A 0/1 mask (1 = removed) -> the stored string ('' when nothing is). */
export function encodeRemoved(mask: Uint8Array): string {
  const n = mask.length;
  let any = false;
  for (let i = 0; i < n && !any; i++) any = mask[i] !== 0;
  if (!any) return '';
  // runs as varints of (gap since the last run's end, run length)
  const runs: number[] = [];
  const push = (v: number) => { while (v >= 0x80) { runs.push((v & 0x7f) | 0x80); v >>>= 7; } runs.push(v); };
  let i = 0, end = 0;
  while (i < n) {
    if (!mask[i]) { i++; continue; }
    const start = i;
    while (i < n && mask[i]) i++;
    push(start - end); push(i - start);
    end = i;
    if (runs.length > n / 8) break; // already longer than the bitmask
  }
  const bits = new Uint8Array(Math.ceil(n / 8));
  for (let k = 0; k < n; k++) if (mask[k]) bits[k >> 3] |= 1 << (k & 7);
  return runs.length < bits.length && i >= n ? 'r' + toB64(new Uint8Array(runs)) : 'b' + toB64(bits);
}

/** The stored string -> a 0/1 mask of length n. */
export function decodeRemoved(s: string | undefined, n: number): Uint8Array {
  const mask = new Uint8Array(n);
  if (!s) return mask;
  const bytes = fromB64(s.slice(1));
  if (s[0] === 'b') {
    for (let k = 0; k < n; k++) if (bytes[k >> 3] & (1 << (k & 7))) mask[k] = 1;
    return mask;
  }
  let p = 0, end = 0;
  const read = () => { let v = 0, shift = 0, b; do { b = bytes[p++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && p < bytes.length); return v; };
  while (p < bytes.length) {
    const start = end + read();
    const len = read();
    mask.fill(1, Math.max(0, start), Math.min(n, start + len));
    end = start + len;
  }
  return mask;
}
