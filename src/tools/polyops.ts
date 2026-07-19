// Higher-level poly operations shared by the Topology Pen: quad-loop
// walking (loop cut), and PolyQuilt-style AutoQuad inference — "guess the
// face the user is pointing at" from nearby open edges.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { TGPolyMesh } from '../core/types';
import { addFace, addVertex, edgeFaceCount, findEdge, getEdge, getVertex } from '../core/polymesh';
import { worldMatrixOf } from './objects';

// ---- quad loop walking (loop cut) -----------------------------------------

export interface LoopCutStop {
  edgeId: number;
  /** t along this edge is measured FROM this vertex (keeps the cut aligned
   *  as the walk crosses each quad) */
  fromVertex: number;
}

export interface LoopCutPlan {
  stops: LoopCutStop[];
  /** faces between consecutive stops (stops[i] and stops[i+1]); for a
   *  closed loop the last face joins the last and first stops */
  faces: number[];
  closed: boolean;
}

/** Face adjacent to edge (a,b), excluding `notFaceId`. Quad-only walks
 *  care about the FIRST such face — non-manifold extras end the walk. */
function adjacentFace(pm: TGPolyMesh, a: number, b: number, notFaceId: number | null): number | null {
  for (const f of pm.faces) {
    if (f.id === notFaceId) continue;
    const n = f.vertices.length;
    for (let i = 0; i < n; i++) {
      const p = f.vertices[i], q = f.vertices[(i + 1) % n];
      if ((p === a && q === b) || (p === b && q === a)) return f.id;
    }
  }
  return null;
}

/** Walk the quad strip crossed by `edgeId` in both directions. Stops at
 *  boundaries, non-quad faces, or when the loop closes on itself. */
export function walkQuadLoop(pm: TGPolyMesh, edgeId: number): LoopCutPlan | null {
  const start = getEdge(pm, edgeId);
  if (!start) return null;

  const walk = (fromVertex: number, firstFaceExclude: number | null) => {
    const stops: LoopCutStop[] = [];
    const faces: number[] = [];
    let curEdge = start.id;
    let curFrom = fromVertex;
    let prevFace: number | null = firstFaceExclude;
    for (let guard = 0; guard < 512; guard++) {
      const e = getEdge(pm, curEdge)!;
      const other = e.v[0] === curFrom ? e.v[1] : e.v[0];
      const fid = adjacentFace(pm, curFrom, other, prevFace);
      if (fid === null) return { stops, faces, closed: false };
      const f = pm.faces.find((x) => x.id === fid)!;
      if (f.vertices.length !== 4) return { stops, faces, closed: false };
      // quad [p0..p3]: entry edge at (i, i+1); opposite edge (i+2, i+3);
      // the opposite vertex ALIGNED with the entry "from" side:
      const idx = f.vertices.findIndex((v, i) => {
        const q = f.vertices[(i + 1) % 4];
        return (v === curFrom && q === other) || (v === other && q === curFrom);
      });
      if (idx < 0) return { stops, faces, closed: false };
      const p = f.vertices[idx];
      const oppA = f.vertices[(idx + 2) % 4], oppB = f.vertices[(idx + 3) % 4];
      // side edges are (i+1,i+2) and (i+3,i): the vertex following the
      // opposite pair (oppB) connects back to p — so if entry from == p,
      // the aligned opposite from-vertex is oppB, else oppA.
      const nextFrom = p === curFrom ? oppB : oppA;
      const nextOther = p === curFrom ? oppA : oppB;
      const nextEdge = findEdge(pm, nextFrom, nextOther);
      if (!nextEdge) return { stops, faces, closed: false };
      faces.push(fid);
      if (nextEdge.id === start.id) return { stops, faces, closed: true };
      if (stops.some((s) => s.edgeId === nextEdge.id)) return { stops, faces, closed: false };
      stops.push({ edgeId: nextEdge.id, fromVertex: nextFrom });
      curEdge = nextEdge.id;
      curFrom = nextFrom;
      prevFace = fid;
    }
    return { stops, faces, closed: false };
  };

  // forward from v[0]; if not closed, also walk backward and prepend
  const fwd = walk(start.v[0], null);
  const startStop: LoopCutStop = { edgeId: start.id, fromVertex: start.v[0] };
  if (fwd.closed) {
    return { stops: [startStop, ...fwd.stops], faces: fwd.faces, closed: true };
  }
  const usedFirst = fwd.faces.length
    ? fwd.faces[0]
    : adjacentFace(pm, start.v[0], start.v[1], null);
  const back = walk(start.v[0], usedFirst);
  const stops = [...[...back.stops].reverse(), startStop, ...fwd.stops];
  const faces = [...[...back.faces].reverse(), ...fwd.faces];
  if (!faces.length) return null; // interior walk found no quad at all
  return { stops, faces, closed: false };
}

// ---- AutoQuad --------------------------------------------------------------
// Shift+click: infer the face the cursor is inside from nearby OPEN edges
// (fewer than two faces). Priority: close a 3-edge "U" (quad), close a
// 2-edge corner sharing a vertex where both far ends exist... else
// parallelogram-complete an "L", else bridge two facing open edges.

interface ScreenEdge { id: number; a: number; b: number; d: number }

export function autoQuad(ctx: AppCtx, pm: TGPolyMesh, x: number, y: number, radiusPx = 90): boolean {
  const rect = ctx.canvas.getBoundingClientRect();
  const world = worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id });
  const screen = new Map<number, THREE.Vector2>();
  for (const v of pm.vertices) {
    const p = new THREE.Vector3(...v.co).applyMatrix4(world).project(ctx.camera);
    if (p.z > 1) continue;
    screen.set(v.id, new THREE.Vector2((p.x * 0.5 + 0.5) * rect.width, (-p.y * 0.5 + 0.5) * rect.height));
  }
  const cursor = new THREE.Vector2(x, y);
  const open: ScreenEdge[] = [];
  for (const e of pm.edges) {
    if (edgeFaceCount(pm, e.id) >= 2) continue;
    const sa = screen.get(e.v[0]), sb = screen.get(e.v[1]);
    if (!sa || !sb) continue;
    const mid = sa.clone().add(sb).multiplyScalar(0.5);
    const d = mid.distanceTo(cursor);
    if (d < radiusPx) open.push({ id: e.id, a: e.v[0], b: e.v[1], d });
  }
  if (!open.length) return false;
  open.sort((p, q) => p.d - q.d);
  const e1 = open[0];

  const openNeighbors = (vid: number, exclude: number[]): number[] => {
    const out: number[] = [];
    for (const e of open) {
      if (exclude.includes(e.id)) continue;
      if (e.a === vid) out.push(e.b);
      else if (e.b === vid) out.push(e.a);
    }
    return out;
  };
  const tryFace = (ids: number[]): boolean => !!addFace(pm, ids);

  // A: U-shape — edges a-c and b-d hang off the ends of e1
  const aExt = openNeighbors(e1.a, [e1.id]);
  const bExt = openNeighbors(e1.b, [e1.id]);
  // triangle: both ends reach the SAME third vertex
  for (const c of aExt) {
    if (bExt.includes(c) && !pm.faces.some((f) =>
      f.vertices.length === 3 && [e1.a, e1.b, c].every((v) => f.vertices.includes(v)))) {
      if (tryFace([e1.a, e1.b, c])) return true;
    }
  }
  // quad: distinct far ends c (off a) and d (off b), closing edge optional
  let bestQuad: { c: number; d: number; score: number } | null = null;
  for (const c of aExt) {
    for (const d of bExt) {
      if (c === d || c === e1.b || d === e1.a) continue;
      const sc = screen.get(c), sd = screen.get(d);
      if (!sc || !sd) continue;
      const score = sc.distanceTo(cursor) + sd.distanceTo(cursor);
      if (!bestQuad || score < bestQuad.score) bestQuad = { c, d, score };
    }
  }
  if (bestQuad && tryFace([bestQuad.c, e1.a, e1.b, bestQuad.d])) return true;

  // B: bridge — a second open edge with no shared vertices; connect the
  // nearer end pairs so the quad doesn't bow-tie
  for (const e2 of open.slice(1)) {
    if ([e2.a, e2.b].some((v) => v === e1.a || v === e1.b)) continue;
    const s = (vid: number) => screen.get(vid)!;
    if (!screen.get(e2.a) || !screen.get(e2.b)) continue;
    const straight = s(e1.b).distanceTo(s(e2.a)) + s(e1.a).distanceTo(s(e2.b));
    const crossed = s(e1.b).distanceTo(s(e2.b)) + s(e1.a).distanceTo(s(e2.a));
    const ids = straight <= crossed
      ? [e1.a, e1.b, e2.a, e2.b]
      : [e1.a, e1.b, e2.b, e2.a];
    if (tryFace(ids)) return true;
  }

  // C: L-corner — e1 and a second open edge share ONE vertex; complete the
  // parallelogram with a brand-new vertex
  for (const e2 of open.slice(1)) {
    const shared = e2.a === e1.a || e2.a === e1.b ? e2.a : e2.b === e1.a || e2.b === e1.b ? e2.b : null;
    if (shared === null) continue;
    const p1 = shared === e1.a ? e1.b : e1.a;   // far end of e1
    const p2 = shared === e2.a ? e2.b : e2.a;   // far end of e2
    if (p1 === p2) continue;
    const vs = getVertex(pm, shared), v1 = getVertex(pm, p1), v2 = getVertex(pm, p2);
    if (!vs || !v1 || !v2) continue;
    const co: [number, number, number] = [
      v1.co[0] + v2.co[0] - vs.co[0],
      v1.co[1] + v2.co[1] - vs.co[1],
      v1.co[2] + v2.co[2] - vs.co[2],
    ];
    const nv = addVertex(pm, co, { kind: 'FREE' });
    if (tryFace([p1, shared, p2, nv.id])) return true;
    // face rejected: drop the speculative vertex again
    pm.vertices = pm.vertices.filter((v) => v.id !== nv.id);
  }
  return false;
}
