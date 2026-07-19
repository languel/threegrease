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
    color: [0.35, 0.78, 0.95], opacity: 0.85,
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
