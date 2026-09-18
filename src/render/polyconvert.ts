// A primitive mesh (box, sphere, cylinder...) turned into an editable
// TGPolyMesh — what entering Edit mode on one does, the way Blender's
// primitives are just meshes once they exist. Lives in render/ because the
// geometry comes from `primitiveGeometry`, the same factory the renderer
// draws from, so the editable mesh is exactly the shape you were looking at.
import * as THREE from 'three';
import type { TGMesh, TGPolyMesh, Vec3 } from '../core/types';
import { addFace, addVertex, createPolyMesh, removeOrphanVertices } from '../core/polymesh';
import { primitiveGeometry } from './meshes';

/** Kinds that have a surface to edit (not EMPTY, not an imported MODEL). */
export function isConvertiblePrimitive(m: TGMesh): boolean {
  return m.kind !== 'EMPTY' && m.kind !== 'MODEL';
}

/**
 * Welds the primitive's triangle soup (three.js splits vertices at every
 * UV / normal seam) and merges every flat region into one face, so a box
 * edits as six quads rather than twelve triangles, a cylinder's caps as one
 * n-gon each, and a UV sphere as its quad bands with triangle fans at the
 * poles — what the same primitive is in Blender.
 */
export function primitiveToPoly(m: TGMesh, id: number): TGPolyMesh {
  const geo = primitiveGeometry(m.kind);
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const pm = createPolyMesh(id, m.name, [...m.translation] as Vec3);
  pm.rotation = [...m.rotation] as Vec3;
  pm.scale = [...m.scale] as Vec3;
  pm.parent = m.parent ?? null;
  pm.constraints = m.constraints ? structuredClone(m.constraints) : [];
  pm.visible = m.visible;
  pm.drawTarget = m.drawTarget;
  pm.materialId = m.materialId ?? null;
  pm.color = [...m.color] as Vec3;
  pm.wireframe = m.wireframe;
  pm.opacity = m.opacity;

  // weld (rounded to 1e-5 with -0 folded into 0: three writes both at seams)
  const r5 = (x: number) => Math.round(x * 1e5) || 0;
  const key = (i: number) => `${r5(pos.getX(i))},${r5(pos.getY(i))},${r5(pos.getZ(i))}`;
  const weld = new Map<string, number>();
  const vid: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    let v = weld.get(k);
    if (v === undefined) {
      v = addVertex(pm, [pos.getX(i), pos.getY(i), pos.getZ(i)]).id;
      weld.set(k, v);
    }
    vid.push(v);
  }
  const tris: number[][] = [];
  const n = idx ? idx.count : pos.count;
  for (let t = 0; t < n; t += 3) {
    const a = vid[idx ? idx.getX(t) : t], b = vid[idx ? idx.getX(t + 1) : t + 1], c = vid[idx ? idx.getX(t + 2) : t + 2];
    if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
  }
  geo.dispose();

  // Merge each FLAT region (edge-connected triangles on one plane) into one
  // n-gon: a box's side is one quad, a cylinder's cap one 24-gon, a UV
  // sphere's bands stay quads because no two of its quads are coplanar.
  // Coplanar means exactly — a looser test folds a sphere's pole fan into
  // bent quads.
  const co = new Map(pm.vertices.map((v) => [v.id, new THREE.Vector3(...v.co)] as const));
  const planes = tris.map((t) => {
    const nrm = new THREE.Vector3().subVectors(co.get(t[1])!, co.get(t[0])!)
      .cross(new THREE.Vector3().subVectors(co.get(t[2])!, co.get(t[0])!)).normalize();
    return { n: nrm, d: nrm.dot(co.get(t[0])!) };
  });
  const ek = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const byEdge = new Map<string, number[]>();
  tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const e = ek(t[k], t[(k + 1) % 3]); (byEdge.get(e) ?? byEdge.set(e, []).get(e)!).push(i); } });
  const region = tris.map((_, i) => i);
  const find = (i: number): number => (region[i] === i ? i : (region[i] = find(region[i])));
  for (const list of byEdge.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const p = planes[list[x]], q = planes[list[y]];
      if (p.n.dot(q.n) > 1 - 1e-6 && Math.abs(p.d - q.d) < 1e-5) region[find(list[x])] = find(list[y]);
    }
  }
  const groups = new Map<number, number[]>();
  tris.forEach((_, i) => { const g = find(i); (groups.get(g) ?? groups.set(g, []).get(g)!).push(i); });
  for (const members of groups.values()) {
    if (members.length === 1) { addFace(pm, tris[members[0]]); continue; }
    // the region's boundary: directed edges used once, chained head to tail
    const count = new Map<string, number>();
    for (const i of members) for (let k = 0; k < 3; k++) { const e = ek(tris[i][k], tris[i][(k + 1) % 3]); count.set(e, (count.get(e) ?? 0) + 1); }
    const next = new Map<number, number>();
    for (const i of members) for (let k = 0; k < 3; k++) {
      const a = tris[i][k], b = tris[i][(k + 1) % 3];
      if (count.get(ek(a, b)) === 1) next.set(a, b);
    }
    const start = next.keys().next().value as number;
    const loop = [start];
    for (let cur = next.get(start)!; cur !== start && loop.length <= next.size; cur = next.get(cur)!) loop.push(cur);
    // one clean loop covering the whole boundary, or keep the triangles
    if (loop.length === next.size && addFace(pm, loop)) continue;
    for (const i of members) addFace(pm, tris[i]);
  }
  // vertices only interior to a merged region (a cap's centre) are gone
  removeOrphanVertices(pm);
  return pm;
}
