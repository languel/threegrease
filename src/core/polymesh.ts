// Pure topology utilities for TGPolyMesh (editable generalized meshes).
// No UI, no three.js — plain-JSON in, plain-JSON out, so the same code
// serves the tool, the renderer, spatial queries, and tests. Mixed
// dimensionality is a feature: isolated vertices, dangling edges, open
// chains, n-gons, and disconnected components are all valid states.
// See docs/design/polymesh.md.
import type { TGPolyEdge, TGPolyFace, TGPolyMesh, TGPolyVertex, TGVertexBinding, Vec3 } from './types';

export function createPolyMesh(id: number, name: string, at: Vec3 = [0, 0, 0]): TGPolyMesh {
  return {
    id, name,
    vertices: [], edges: [], faces: [],
    nextElemId: 1, rev: 0,
    translation: [...at], rotation: [0, 0, 0], scale: [1, 1, 1],
    visible: true, select: false, lock: false, parent: null, constraints: [],
    drawTarget: true, wireframe: false,
    // neutral, matching primitive mesh defaults (render/meshes.ts) — the
    // blue/cyan accents belong to the edit-time vertex/edge overlay only
    // (COL_SELECT etc. in render/polymesh.ts), never the object's own color
    color: [0.62, 0.65, 0.72], opacity: 1,
    unlit: false, doubleSided: true,
  };
}

/** All element kinds share one per-mesh id space (never ambiguous). */
export function allocElemId(pm: TGPolyMesh): number {
  return pm.nextElemId++;
}

export function touchPolyMesh(pm: TGPolyMesh): void { pm.rev = (pm.rev + 1) % 1e9; }

// ---- lookups ---------------------------------------------------------------

export function getVertex(pm: TGPolyMesh, id: number): TGPolyVertex | undefined {
  return pm.vertices.find((v) => v.id === id);
}
export function getEdge(pm: TGPolyMesh, id: number): TGPolyEdge | undefined {
  return pm.edges.find((e) => e.id === id);
}
export function getFace(pm: TGPolyMesh, id: number): TGPolyFace | undefined {
  return pm.faces.find((f) => f.id === id);
}

/** Edge between two vertices, orientation-independent. */
export function findEdge(pm: TGPolyMesh, a: number, b: number): TGPolyEdge | undefined {
  return pm.edges.find((e) => (e.v[0] === a && e.v[1] === b) || (e.v[0] === b && e.v[1] === a));
}

// ---- element creation ------------------------------------------------------

export function addVertex(pm: TGPolyMesh, co: Vec3, binding?: TGVertexBinding | null): TGPolyVertex {
  const v: TGPolyVertex = { id: allocElemId(pm), co: [...co], select: false, binding: binding ?? null };
  pm.vertices.push(v);
  touchPolyMesh(pm);
  return v;
}

/** Create the edge a-b, or return the existing one (duplicates are never
 *  stored; orientation does not matter). Returns null for degenerate a===b
 *  or missing vertices. */
export function addEdge(pm: TGPolyMesh, a: number, b: number): TGPolyEdge | null {
  if (a === b || !getVertex(pm, a) || !getVertex(pm, b)) return null;
  const existing = findEdge(pm, a, b);
  if (existing) return existing;
  const e: TGPolyEdge = { id: allocElemId(pm), v: [a, b], select: false };
  pm.edges.push(e);
  touchPolyMesh(pm);
  return e;
}

/** Create a face from an ordered boundary (>= 3 unique existing vertices).
 *  Missing boundary edges are created; the boundary array is stored as
 *  given (triangulation is derived later, never persisted). Returns null
 *  without touching the mesh when the boundary is invalid. */
export function addFace(pm: TGPolyMesh, vertexIds: number[]): TGPolyFace | null {
  const unique = new Set(vertexIds);
  if (vertexIds.length < 3 || unique.size !== vertexIds.length) return null;
  for (const id of vertexIds) if (!getVertex(pm, id)) return null;
  for (let i = 0; i < vertexIds.length; i++) {
    addEdge(pm, vertexIds[i], vertexIds[(i + 1) % vertexIds.length]);
  }
  const f: TGPolyFace = { id: allocElemId(pm), vertices: [...vertexIds], select: false };
  pm.faces.push(f);
  touchPolyMesh(pm);
  return f;
}

// ---- element removal (documented semantics) --------------------------------
// face   -> only the face goes;
// edge   -> the edge and every face whose boundary uses that edge;
// vertex -> the vertex, its edges, and every face using the vertex.
// Orphan cleanup is a separate, explicit call — never automatic.

export function removeFace(pm: TGPolyMesh, id: number): boolean {
  const i = pm.faces.findIndex((f) => f.id === id);
  if (i < 0) return false;
  pm.faces.splice(i, 1);
  touchPolyMesh(pm);
  return true;
}

function faceUsesEdge(f: TGPolyFace, a: number, b: number): boolean {
  const n = f.vertices.length;
  for (let i = 0; i < n; i++) {
    const p = f.vertices[i], q = f.vertices[(i + 1) % n];
    if ((p === a && q === b) || (p === b && q === a)) return true;
  }
  return false;
}

export function removeEdge(pm: TGPolyMesh, id: number): boolean {
  const i = pm.edges.findIndex((e) => e.id === id);
  if (i < 0) return false;
  const [a, b] = pm.edges[i].v;
  pm.edges.splice(i, 1);
  pm.faces = pm.faces.filter((f) => !faceUsesEdge(f, a, b));
  touchPolyMesh(pm);
  return true;
}

export function removeVertex(pm: TGPolyMesh, id: number): boolean {
  const i = pm.vertices.findIndex((v) => v.id === id);
  if (i < 0) return false;
  pm.vertices.splice(i, 1);
  pm.edges = pm.edges.filter((e) => e.v[0] !== id && e.v[1] !== id);
  pm.faces = pm.faces.filter((f) => !f.vertices.includes(id));
  touchPolyMesh(pm);
  return true;
}

/** Delete a face AND the boundary topology that only existed for it:
 *  boundary edges left with zero faces go, then vertices left with no
 *  edges and no faces go. Edges/vertices still shared with other faces,
 *  chains, or points survive. (Plain removeFace keeps everything.) */
export function removeFaceCascade(pm: TGPolyMesh, id: number): boolean {
  const f = getFace(pm, id);
  if (!f) return false;
  const boundary = [...f.vertices];
  pm.faces = pm.faces.filter((x) => x.id !== id);
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    const e = findEdge(pm, a, b);
    if (e && !pm.faces.some((x) => faceUsesEdge(x, a, b))) {
      pm.edges = pm.edges.filter((x) => x.id !== e.id);
    }
  }
  const used = new Set<number>();
  for (const e of pm.edges) { used.add(e.v[0]); used.add(e.v[1]); }
  for (const x of pm.faces) for (const vid of x.vertices) used.add(vid);
  pm.vertices = pm.vertices.filter((v) => used.has(v.id) || !boundary.includes(v.id));
  touchPolyMesh(pm);
  return true;
}

/** Remove vertices referenced by no edge and no face. Explicit opt-in. */
export function removeOrphanVertices(pm: TGPolyMesh): number {
  const used = new Set<number>();
  for (const e of pm.edges) { used.add(e.v[0]); used.add(e.v[1]); }
  for (const f of pm.faces) for (const id of f.vertices) used.add(id);
  const before = pm.vertices.length;
  pm.vertices = pm.vertices.filter((v) => used.has(v.id));
  if (pm.vertices.length !== before) touchPolyMesh(pm);
  return before - pm.vertices.length;
}

/** Drop faces that reference missing vertices or have < 3 unique ones. */
export function cleanupDegenerateFaces(pm: TGPolyMesh): number {
  const ids = new Set(pm.vertices.map((v) => v.id));
  const before = pm.faces.length;
  pm.faces = pm.faces.filter((f) =>
    new Set(f.vertices).size >= 3
    && new Set(f.vertices).size === f.vertices.length
    && f.vertices.every((id) => ids.has(id)));
  if (pm.faces.length !== before) touchPolyMesh(pm);
  return before - pm.faces.length;
}

// ---- edge split -------------------------------------------------------------

/** Split an edge at parametric t (0..1 along v[0]->v[1]): insert a new
 *  vertex, replace the edge with two, and patch EVERY adjacent face
 *  boundary so the new vertex sits between the old endpoints in loop
 *  order. Returns the new vertex, or null if the edge is missing. */
export function splitEdge(
  pm: TGPolyMesh, edgeId: number, t: number, binding?: TGVertexBinding | null,
): TGPolyVertex | null {
  const e = getEdge(pm, edgeId);
  if (!e) return null;
  const va = getVertex(pm, e.v[0]), vb = getVertex(pm, e.v[1]);
  if (!va || !vb) return null;
  const k = Math.max(0, Math.min(1, t));
  const co: Vec3 = [
    va.co[0] + (vb.co[0] - va.co[0]) * k,
    va.co[1] + (vb.co[1] - va.co[1]) * k,
    va.co[2] + (vb.co[2] - va.co[2]) * k,
  ];
  const mid = addVertex(pm, co, binding);
  const [a, b] = e.v;
  pm.edges = pm.edges.filter((x) => x.id !== edgeId);
  addEdge(pm, a, mid.id);
  addEdge(pm, mid.id, b);
  // insert into adjacent face boundaries between a and b (either order)
  for (const f of pm.faces) {
    const n = f.vertices.length;
    for (let i = 0; i < n; i++) {
      const p = f.vertices[i], q = f.vertices[(i + 1) % n];
      if ((p === a && q === b) || (p === b && q === a)) {
        f.vertices.splice(i + 1, 0, mid.id);
        break; // a boundary uses an edge at most once per simple loop
      }
    }
  }
  touchPolyMesh(pm);
  return mid;
}

/** PolyQuilt-style dissolve: an edge shared by exactly two faces melts
 *  into them — the faces merge into one n-gon around the removed edge.
 *  Any other edge (boundary/dangling/non-manifold) returns false so the
 *  caller can fall back to plain deletion. */
export function dissolveEdge(pm: TGPolyMesh, edgeId: number): boolean {
  const e = getEdge(pm, edgeId);
  if (!e) return false;
  const [a, b] = e.v;
  const adjacent = pm.faces.filter((f) => faceUsesEdge(f, a, b));
  if (adjacent.length !== 2) return false;
  const [f1, f2] = adjacent;
  // rotate each boundary so it STARTS just after the shared edge, walking
  // away from it; concatenating the two walks yields the merged loop
  const walkFrom = (f: TGPolyFace, from: number, to: number): number[] | null => {
    const n = f.vertices.length;
    for (let i = 0; i < n; i++) {
      const p = f.vertices[i], q = f.vertices[(i + 1) % n];
      if (p === from && q === to) {
        const out: number[] = [];
        for (let k = 1; k < n; k++) out.push(f.vertices[(i + k) % n]);
        return out; // to ... (all the way around) ... from, minus `from`
      }
    }
    return null;
  };
  // f1 traverses a->b or b->a; f2 must traverse the opposite direction
  let w1 = walkFrom(f1, a, b), w2 = walkFrom(f2, b, a);
  if (!w1 || !w2) { w1 = walkFrom(f1, b, a); w2 = walkFrom(f2, a, b); }
  if (!w1 || !w2) return false;
  // w1 = b..a (exclusive of nothing at the end: ends with a), w2 = a..b;
  // drop each walk's final vertex to avoid repeats when concatenating
  const merged = [...w1.slice(0, -1), ...w2.slice(0, -1)];
  if (new Set(merged).size !== merged.length || merged.length < 3) return false;
  pm.faces = pm.faces.filter((f) => f.id !== f1.id && f.id !== f2.id);
  pm.edges = pm.edges.filter((x) => x.id !== edgeId);
  pm.faces.push({ id: allocElemId(pm), vertices: merged, select: false });
  touchPolyMesh(pm);
  return true;
}

/** Dissolve a 2-edge pass-through vertex (not used by any face): its two
 *  edges fuse into one spanning edge. Returns false otherwise. */
export function dissolveVertex(pm: TGPolyMesh, vertexId: number): boolean {
  if (!getVertex(pm, vertexId)) return false;
  if (pm.faces.some((f) => f.vertices.includes(vertexId))) return false;
  const edges = pm.edges.filter((e) => e.v[0] === vertexId || e.v[1] === vertexId);
  if (edges.length !== 2) return false;
  const other = (e: TGPolyEdge) => (e.v[0] === vertexId ? e.v[1] : e.v[0]);
  const a = other(edges[0]), b = other(edges[1]);
  if (a === b || findEdge(pm, a, b)) return false;
  pm.edges = pm.edges.filter((e) => e.id !== edges[0].id && e.id !== edges[1].id);
  pm.vertices = pm.vertices.filter((v) => v.id !== vertexId);
  addEdge(pm, a, b);
  touchPolyMesh(pm);
  return true;
}

/** Split a face into two along two of its boundary vertices (non-adjacent
 *  in the loop). Creates the connecting edge; each half keeps boundary
 *  order. Returns the two new faces, or null untouched. */
export function splitFace(
  pm: TGPolyMesh, faceId: number, va: number, vb: number,
): [TGPolyFace, TGPolyFace] | null {
  const f = getFace(pm, faceId);
  if (!f || va === vb) return null;
  const ia = f.vertices.indexOf(va), ib = f.vertices.indexOf(vb);
  if (ia < 0 || ib < 0) return null;
  const n = f.vertices.length;
  if ((ia + 1) % n === ib || (ib + 1) % n === ia) return null; // adjacent
  const loopA: number[] = [];
  for (let i = ia; ; i = (i + 1) % n) { loopA.push(f.vertices[i]); if (i === ib) break; }
  const loopB: number[] = [];
  for (let i = ib; ; i = (i + 1) % n) { loopB.push(f.vertices[i]); if (i === ia) break; }
  if (loopA.length < 3 || loopB.length < 3) return null;
  pm.faces = pm.faces.filter((x) => x.id !== faceId);
  addEdge(pm, va, vb);
  const fa: TGPolyFace = { id: allocElemId(pm), vertices: loopA, select: false };
  const fb: TGPolyFace = { id: allocElemId(pm), vertices: loopB, select: false };
  pm.faces.push(fa, fb);
  touchPolyMesh(pm);
  return [fa, fb];
}

/** Merge vertex `fromId` into `intoId` (extrusion release-snap): edges are
 *  rewired (degenerates and duplicates dropped), face boundaries rewritten
 *  (consecutive duplicates collapsed; faces below 3 unique vertices
 *  dropped). Returns false untouched when the merge is invalid. */
export function mergeVertices(pm: TGPolyMesh, fromId: number, intoId: number): boolean {
  if (fromId === intoId || !getVertex(pm, fromId) || !getVertex(pm, intoId)) return false;
  pm.vertices = pm.vertices.filter((v) => v.id !== fromId);
  const seen = new Set<string>();
  const edges: TGPolyEdge[] = [];
  for (const e of pm.edges) {
    const a = e.v[0] === fromId ? intoId : e.v[0];
    const b = e.v[1] === fromId ? intoId : e.v[1];
    if (a === b) continue; // collapsed edge
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue; // rewiring produced a duplicate
    seen.add(key);
    edges.push({ ...e, v: [a, b] });
  }
  pm.edges = edges;
  pm.faces = pm.faces
    .map((f) => {
      const mapped = f.vertices.map((id) => (id === fromId ? intoId : id));
      const out: number[] = [];
      for (const id of mapped) if (out[out.length - 1] !== id) out.push(id);
      while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
      return { ...f, vertices: out };
    })
    .filter((f) => new Set(f.vertices).size >= 3 && new Set(f.vertices).size === f.vertices.length);
  touchPolyMesh(pm);
  return true;
}

// ---- subdivision / smoothing -------------------------------------------------

/** One round of uniform subdivision across the whole mesh: every edge
 *  gains a midpoint vertex; every face (tri/quad/n-gon) is replaced by a
 *  fan of QUADS around a new center vertex (Catmull-Clark connectivity,
 *  no smoothing — pair with smoothPolyMesh for the rounded look).
 *  Dangling edges simply split in two; isolated vertices are untouched. */
export function subdividePolyMesh(pm: TGPolyMesh): void {
  const originalFaces = pm.faces.map((f) => ({ id: f.id, corners: [...f.vertices] }));
  // split every edge at its midpoint (patches face boundaries in place)
  for (const e of [...pm.edges]) splitEdge(pm, e.id, 0.5);
  for (const of of originalFaces) {
    const f = getFace(pm, of.id);
    if (!f) continue;
    const corners = new Set(of.corners);
    const n = f.vertices.length;
    // center vertex at the boundary average
    const c: Vec3 = [0, 0, 0];
    let count = 0;
    for (const vid of f.vertices) {
      const v = getVertex(pm, vid);
      if (!v) continue;
      c[0] += v.co[0]; c[1] += v.co[1]; c[2] += v.co[2]; count++;
    }
    if (count < 3) continue;
    const center = addVertex(pm, [c[0] / count, c[1] / count, c[2] / count]);
    pm.faces = pm.faces.filter((x) => x.id !== f.id);
    for (let i = 0; i < n; i++) {
      const vid = f.vertices[i];
      if (!corners.has(vid)) continue; // quads start at original corners
      const next = f.vertices[(i + 1) % n];
      const prev = f.vertices[(i - 1 + n) % n];
      addFace(pm, [vid, next, center.id, prev]);
    }
  }
  touchPolyMesh(pm);
}

/** Laplacian smoothing over edge adjacency: each vertex moves toward the
 *  average of its neighbors by `factor`, `iterations` times. Acts on the
 *  SELECTED vertices when any are selected, else the whole mesh;
 *  vertices with no edges never move. */
export function smoothPolyMesh(pm: TGPolyMesh, factor = 0.5, iterations = 1): void {
  const anySelected = pm.vertices.some((v) => v.select);
  const neighbors = new Map<number, number[]>();
  for (const e of pm.edges) {
    (neighbors.get(e.v[0]) ?? neighbors.set(e.v[0], []).get(e.v[0])!).push(e.v[1]);
    (neighbors.get(e.v[1]) ?? neighbors.set(e.v[1], []).get(e.v[1])!).push(e.v[0]);
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Map<number, Vec3>();
    for (const v of pm.vertices) {
      if (anySelected && !v.select) continue;
      const ns = neighbors.get(v.id);
      if (!ns?.length) continue;
      const avg: Vec3 = [0, 0, 0];
      for (const nid of ns) {
        const nv = getVertex(pm, nid);
        if (!nv) continue;
        avg[0] += nv.co[0]; avg[1] += nv.co[1]; avg[2] += nv.co[2];
      }
      next.set(v.id, [
        v.co[0] + (avg[0] / ns.length - v.co[0]) * factor,
        v.co[1] + (avg[1] / ns.length - v.co[1]) * factor,
        v.co[2] + (avg[2] / ns.length - v.co[2]) * factor,
      ]);
    }
    for (const [id, co] of next) {
      const v = getVertex(pm, id);
      if (v) v.co = co;
    }
  }
  touchPolyMesh(pm);
}

// ---- adjacency / boundary ----------------------------------------------------

export interface PolyAdjacency {
  /** vertex id -> edge ids touching it */
  vertexEdges: Map<number, number[]>;
  /** edge id -> face ids whose boundary uses it */
  edgeFaces: Map<number, number[]>;
}

export function buildAdjacency(pm: TGPolyMesh): PolyAdjacency {
  const vertexEdges = new Map<number, number[]>();
  const edgeFaces = new Map<number, number[]>();
  for (const e of pm.edges) {
    for (const vid of e.v) {
      const list = vertexEdges.get(vid) ?? [];
      list.push(e.id);
      vertexEdges.set(vid, list);
    }
    edgeFaces.set(e.id, []);
  }
  for (const f of pm.faces) {
    const n = f.vertices.length;
    for (let i = 0; i < n; i++) {
      const e = findEdge(pm, f.vertices[i], f.vertices[(i + 1) % n]);
      if (e) edgeFaces.get(e.id)?.push(f.id);
    }
  }
  return { vertexEdges, edgeFaces };
}

/** Faces whose boundary uses this edge (0 = dangling, 1 = boundary, 2+ = interior/non-manifold). */
export function edgeFaceCount(pm: TGPolyMesh, edgeId: number): number {
  const e = getEdge(pm, edgeId);
  if (!e) return 0;
  let n = 0;
  for (const f of pm.faces) if (faceUsesEdge(f, e.v[0], e.v[1])) n++;
  return n;
}

/** Boundary for extrusion purposes: belongs to FEWER than two faces. */
export function isBoundaryEdge(pm: TGPolyMesh, edgeId: number): boolean {
  return edgeFaceCount(pm, edgeId) < 2;
}

// ---- validation --------------------------------------------------------------

/** Structural checks; returns human-readable problems (empty = valid). */
export function validatePolyMesh(pm: TGPolyMesh): string[] {
  const problems: string[] = [];
  const vids = new Set<number>();
  for (const v of pm.vertices) {
    if (vids.has(v.id)) problems.push(`duplicate vertex id ${v.id}`);
    vids.add(v.id);
    if (!v.co || v.co.length !== 3 || v.co.some((c) => !Number.isFinite(c))) {
      problems.push(`vertex ${v.id} has invalid coordinates`);
    }
  }
  const pairs = new Set<string>();
  const eids = new Set<number>();
  for (const e of pm.edges) {
    if (eids.has(e.id)) problems.push(`duplicate edge id ${e.id}`);
    eids.add(e.id);
    if (e.v[0] === e.v[1]) problems.push(`edge ${e.id} is degenerate (v${e.v[0]} twice)`);
    for (const vid of e.v) if (!vids.has(vid)) problems.push(`edge ${e.id} references missing vertex ${vid}`);
    const key = e.v[0] < e.v[1] ? `${e.v[0]}:${e.v[1]}` : `${e.v[1]}:${e.v[0]}`;
    if (pairs.has(key)) problems.push(`duplicate edge between v${e.v[0]} and v${e.v[1]}`);
    pairs.add(key);
  }
  const fids = new Set<number>();
  for (const f of pm.faces) {
    if (fids.has(f.id)) problems.push(`duplicate face id ${f.id}`);
    fids.add(f.id);
    if (f.vertices.length < 3) problems.push(`face ${f.id} has fewer than 3 vertices`);
    if (new Set(f.vertices).size !== f.vertices.length) problems.push(`face ${f.id} repeats a vertex`);
    for (const vid of f.vertices) if (!vids.has(vid)) problems.push(`face ${f.id} references missing vertex ${vid}`);
  }
  for (const id of [...vids, ...eids, ...fids]) {
    if (id >= pm.nextElemId) problems.push(`element id ${id} >= nextElemId ${pm.nextElemId}`);
  }
  return problems;
}

/** Load-time repair: drop elements with broken references, fix the id
 *  counter. Never throws — invalid data degrades to less data. */
export function sanitizePolyMesh(pm: TGPolyMesh): void {
  pm.vertices = (pm.vertices ?? []).filter((v) =>
    Array.isArray(v.co) && v.co.length === 3 && v.co.every((c) => Number.isFinite(c)));
  const vids = new Set(pm.vertices.map((v) => v.id));
  const pairs = new Set<string>();
  pm.edges = (pm.edges ?? []).filter((e) => {
    if (!Array.isArray(e.v) || e.v.length !== 2) return false;
    if (e.v[0] === e.v[1] || !vids.has(e.v[0]) || !vids.has(e.v[1])) return false;
    const key = e.v[0] < e.v[1] ? `${e.v[0]}:${e.v[1]}` : `${e.v[1]}:${e.v[0]}`;
    if (pairs.has(key)) return false;
    pairs.add(key);
    return true;
  });
  pm.faces = (pm.faces ?? []).filter((f) =>
    Array.isArray(f.vertices)
    && new Set(f.vertices).size >= 3
    && new Set(f.vertices).size === f.vertices.length
    && f.vertices.every((id) => vids.has(id)));
  let maxId = 0;
  for (const v of pm.vertices) maxId = Math.max(maxId, v.id);
  for (const e of pm.edges) maxId = Math.max(maxId, e.id);
  for (const f of pm.faces) maxId = Math.max(maxId, f.id);
  pm.nextElemId = Math.max(pm.nextElemId ?? 1, maxId + 1);
}
