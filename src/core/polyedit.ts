// Mesh edit-mode operations on TGPolyMesh — the Blender-style vertex / edge /
// face editor. Pure data in, data out (no three.js scene, no UI), like the
// rest of core/polymesh.ts: selection flushing between the three element
// kinds, extrude, fill and delete by select mode.
import type { TGPolyMesh, Vec3 } from './types';
import {
  addEdge, addFace, addVertex, findEdge, getVertex, removeEdge, removeFaceCascade,
  removeVertex, touchPolyMesh,
} from './polymesh';

export type MeshSelectMode = 'VERTEX' | 'EDGE' | 'FACE';

function faceEdges(vs: number[]): [number, number][] {
  return vs.map((v, i) => [v, vs[(i + 1) % vs.length]] as [number, number]);
}

/**
 * Make the three selections agree, from the one the mode works in.
 *
 * Blender keeps vertex, edge and face selection consistent at all times, and
 * the transform only ever reads VERTICES — so an edge picked in edge mode has
 * to select its two vertices, and a face its corners. In VERTEX mode it runs
 * the other way: an edge is selected when both ends are, a face when every
 * corner is. Always call this after changing selection.
 */
export function flushSelection(pm: TGPolyMesh, mode: MeshSelectMode): void {
  const vsel = new Set(pm.vertices.filter((v) => v.select).map((v) => v.id));
  if (mode === 'VERTEX') {
    for (const e of pm.edges) e.select = vsel.has(e.v[0]) && vsel.has(e.v[1]);
    for (const f of pm.faces) f.select = f.vertices.every((v) => vsel.has(v));
  } else if (mode === 'EDGE') {
    const on = new Set<number>();
    for (const e of pm.edges) if (e.select) { on.add(e.v[0]); on.add(e.v[1]); }
    for (const v of pm.vertices) v.select = on.has(v.id);
    for (const f of pm.faces) {
      f.select = faceEdges(f.vertices).every(([a, b]) => !!findEdge(pm, a, b)?.select);
    }
  } else {
    const on = new Set<number>();
    const onEdge = new Set<string>();
    for (const f of pm.faces) {
      if (!f.select) continue;
      for (const v of f.vertices) on.add(v);
      for (const [a, b] of faceEdges(f.vertices)) onEdge.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
    for (const v of pm.vertices) v.select = on.has(v.id);
    for (const e of pm.edges) {
      const [a, b] = e.v;
      e.select = onEdge.has(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
  }
  touchPolyMesh(pm);
}

export function selectAllElems(pm: TGPolyMesh, on: boolean | 'invert', mode: MeshSelectMode): void {
  const list = mode === 'VERTEX' ? pm.vertices : mode === 'EDGE' ? pm.edges : pm.faces;
  for (const el of list) el.select = on === 'invert' ? !el.select : on;
  flushSelection(pm, mode);
}

export function selectedVertexIds(pm: TGPolyMesh): number[] {
  return pm.vertices.filter((v) => v.select).map((v) => v.id);
}

function clearSelection(pm: TGPolyMesh): void {
  for (const v of pm.vertices) v.select = false;
  for (const e of pm.edges) e.select = false;
  for (const f of pm.faces) f.select = false;
}

/**
 * Extrude the selection, Blender's E: new geometry is created and SELECTED,
 * sitting exactly on top of the old, so the caller starts a grab and the
 * user pulls it out.
 *
 * FACE: region extrude. Every corner of the selected faces is duplicated,
 * the faces move over to the duplicates, and every region-boundary edge
 * (used by exactly one selected face) gets a side quad, wound so its normal
 * points out of the region. The original faces are KEPT, turned over: a
 * floor lifted with E becomes a closed block with a bottom, which is what
 * a plan extruded into a massing model wants (Blender leaves the hole).
 * EDGE: each selected edge grows a quad; edges sharing a vertex share its
 * duplicate, so a chain extrudes as one strip.
 * VERTEX: each selected vertex grows an edge to its duplicate.
 * Returns false when nothing was selected to extrude.
 */
export function extrudeSelection(pm: TGPolyMesh, mode: MeshSelectMode): boolean {
  const dup = new Map<number, number>();
  const twin = (id: number): number => {
    let n = dup.get(id);
    if (n === undefined) {
      const v = getVertex(pm, id)!;
      n = addVertex(pm, [...v.co] as Vec3, v.binding).id;
      dup.set(id, n);
    }
    return n;
  };

  if (mode === 'FACE') {
    const faces = pm.faces.filter((f) => f.select);
    if (!faces.length) return false;
    const use = new Map<string, number>();
    const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    for (const f of faces) for (const [a, b] of faceEdges(f.vertices)) use.set(key(a, b), (use.get(key(a, b)) ?? 0) + 1);
    const sides: [number, number][] = [];
    for (const f of faces) for (const [a, b] of faceEdges(f.vertices)) if (use.get(key(a, b)) === 1) sides.push([a, b]);
    const tops: number[][] = faces.map((f) => f.vertices.map(twin));
    clearSelection(pm);
    // the originals stay as the underside, wound the other way
    for (const f of faces) f.vertices.reverse();
    for (const [a, b] of sides) addFace(pm, [a, b, twin(b), twin(a)]);
    for (const t of tops) { const nf = addFace(pm, t); if (nf) nf.select = true; }
    flushSelection(pm, 'FACE');
    return true;
  }

  if (mode === 'EDGE') {
    const edges = pm.edges.filter((e) => e.select);
    if (!edges.length) return false;
    const pairs = edges.map((e) => {
      // wind the new quad against the face this edge already borders, so
      // the strip continues that surface instead of facing the other way
      const f = pm.faces.find((x) => faceEdges(x.vertices).some(([p, q]) => p === e.v[0] && q === e.v[1]));
      return f ? [e.v[1], e.v[0]] as [number, number] : [e.v[0], e.v[1]] as [number, number];
    });
    clearSelection(pm);
    for (const [a, b] of pairs) {
      addFace(pm, [a, b, twin(b), twin(a)]);
      const top = addEdge(pm, twin(a), twin(b));
      if (top) top.select = true;
    }
    flushSelection(pm, 'EDGE');
    return true;
  }

  const verts = pm.vertices.filter((v) => v.select).map((v) => v.id);
  if (!verts.length) return false;
  clearSelection(pm);
  for (const id of verts) {
    const n = twin(id);
    addEdge(pm, id, n);
    getVertex(pm, n)!.select = true;
  }
  flushSelection(pm, 'VERTEX');
  return true;
}

/**
 * F: make a face from the selected vertices. Ordered by walking the edges
 * between them when they form a chain or a loop (so a traced outline fills
 * the way it was drawn), otherwise by angle around their centroid in their
 * best-fit plane. Two vertices get an edge instead.
 */
export function fillSelection(pm: TGPolyMesh): boolean {
  const ids = selectedVertexIds(pm);
  if (ids.length === 2) return !!addEdge(pm, ids[0], ids[1]);
  if (ids.length < 3) return false;
  const set = new Set(ids);
  const nbr = new Map<number, number[]>();
  for (const e of pm.edges) {
    if (set.has(e.v[0]) && set.has(e.v[1])) {
      (nbr.get(e.v[0]) ?? nbr.set(e.v[0], []).get(e.v[0])!).push(e.v[1]);
      (nbr.get(e.v[1]) ?? nbr.set(e.v[1], []).get(e.v[1])!).push(e.v[0]);
    }
  }
  let order: number[] | null = null;
  if (ids.every((id) => (nbr.get(id)?.length ?? 0) <= 2)) {
    const start = ids.find((id) => (nbr.get(id)?.length ?? 0) < 2) ?? ids[0];
    const walk = [start];
    const seen = new Set(walk);
    for (;;) {
      const next = (nbr.get(walk[walk.length - 1]) ?? []).find((n) => !seen.has(n));
      if (next === undefined) break;
      walk.push(next); seen.add(next);
    }
    if (walk.length === ids.length) order = walk;
  }
  if (!order) {
    const pts = ids.map((id) => getVertex(pm, id)!.co);
    const c = pts.reduce((m, p) => [m[0] + p[0] / pts.length, m[1] + p[1] / pts.length, m[2] + p[2] / pts.length], [0, 0, 0]);
    const n = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0
      : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const u = (ax + 1) % 3, w = (ax + 2) % 3;
    order = ids.map((id) => ({ id, a: Math.atan2(getVertex(pm, id)!.co[w] - c[w], getVertex(pm, id)!.co[u] - c[u]) }))
      .sort((p, q) => p.a - q.a).map((p) => p.id);
  }
  const f = addFace(pm, order);
  if (f) f.select = true;
  return !!f;
}

/**
 * X in edit mode, by select mode — Blender's Delete Vertices / Edges /
 * Faces: a vertex takes its edges and faces with it; an edge takes the
 * faces it borders and then any vertex it leaves loose; a face goes with
 * the edges and vertices that only existed for it.
 */
export function deleteSelection(pm: TGPolyMesh, mode: MeshSelectMode): boolean {
  if (mode === 'FACE') {
    const ids = pm.faces.filter((f) => f.select).map((f) => f.id);
    for (const id of ids) removeFaceCascade(pm, id);
    return ids.length > 0;
  }
  if (mode === 'EDGE') {
    const ids = pm.edges.filter((e) => e.select).map((e) => e.id);
    const ends = new Set(pm.edges.filter((e) => e.select).flatMap((e) => e.v));
    for (const id of ids) removeEdge(pm, id);
    // loose ends the edges leave behind go too — but only THEIR ends
    const used = new Set<number>();
    for (const e of pm.edges) { used.add(e.v[0]); used.add(e.v[1]); }
    for (const f of pm.faces) for (const v of f.vertices) used.add(v);
    for (const v of ends) if (!used.has(v)) removeVertex(pm, v);
    return ids.length > 0;
  }
  const ids = selectedVertexIds(pm);
  for (const id of ids) removeVertex(pm, id);
  return ids.length > 0;
}

export { touchPolyMesh };
