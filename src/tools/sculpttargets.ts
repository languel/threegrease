// What a sculpt brush is allowed to push around.
//
// The brushes themselves are the same gesture whatever they land on — drag a
// circle over points and move/average/jitter them — so the only thing that
// differs per kind of thing is WHERE the points live, how they reach the
// screen, and who their neighbours are. That is this file: one `SculptTarget`
// per kind (grease-pencil strokes, an editable poly mesh), built ONCE at the
// start of a stroke because sculpting never changes topology, only positions.
//
// A raw primitive (box, sphere, …) has no entry here on purpose: Edit mode
// already converts one to a TGPolyMesh on the way in (render/polyconvert.ts),
// so "sculpt a mesh" IS the poly path with the existing conversion in front
// of it, rather than a third representation that could drift from the other
// two. An imported MODEL stays out — `isConvertiblePrimitive` refuses it, and
// a 162k-triangle scan is not something to hand a per-move brush anyway.
import * as THREE from 'three';
import { activeObject, frameAt, visibleEditableLayers } from '../core/gpdata';
import type { GPPoint, TGPolyMesh, Vec3 } from '../core/types';
import type { AppCtx } from './context';
import { screenToWorld } from './projection';
import { worldMatrixOf } from './objects';
import { touchPolyMesh } from '../core/polymesh';

/** One sculptable point. Positions are read LIVE (the brush moves them as it
 *  goes, and Smooth/Relax have to see where their neighbours got to). */
export interface SculptPoint {
  co(): Vec3;
  set(co: Vec3): void;
  /** Current neighbour positions: the chain's previous/next for a stroke
   *  point, the edge-connected vertices for a mesh one. EMPTY when the point
   *  has none to average against — a stroke's two ends report none, which is
   *  what keeps them pinned the way they always were. */
  nbrs(): Vec3[];
  /**
   * The part of a smoothing delta that SLIDES the point along the shape
   * instead of changing the shape. That difference is the whole of Relax vs
   * Smooth: Smooth applies the delta whole, which pulls the surface toward
   * the average of its neighbours and erodes detail a little more on every
   * pass; Relax keeps only this part, so points even out their spacing while
   * the silhouette they describe stays put.
   *
   * For a mesh point that means everything except the surface normal; for a
   * point in a CHAIN (a stroke, or a loose wire in a mesh) it means only the
   * component along the chord between its neighbours.
   */
  tangential(delta: THREE.Vector3): THREE.Vector3;
  /** The grease-pencil point, when this is one. Thickness / Strength are the
   *  two brushes that edit per-point attributes no mesh vertex has. */
  gp: GPPoint | null;
}

export interface SculptTarget {
  kind: 'GP' | 'POLY';
  /** What this is, for the status line when a brush has nothing to say. */
  label: string;
  points: SculptPoint[];
  toScreen(co: Vec3): THREE.Vector2;
  toWorld(co: Vec3): THREE.Vector3;
  fromWorld(w: THREE.Vector3): Vec3;
  /** A screen-space delta at a screen position, as local movement. */
  deltaToLocal(at: THREE.Vector2, delta: THREE.Vector2): Vec3 | null;
  /** Tell the app what changed, once a brush pass is done. */
  flush(ctx: AppCtx): void;
}

const sub = (a: Vec3, b: Vec3): THREE.Vector3 =>
  new THREE.Vector3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Only the component of `delta` along `axis` (which need not be unit). */
function alongAxis(delta: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
  const len = axis.length();
  if (len < 1e-9) return delta.clone();
  const u = axis.clone().divideScalar(len);
  return u.multiplyScalar(delta.dot(u));
}

/** Everything EXCEPT the component along `normal` (assumed unit-ish). */
function acrossNormal(delta: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 {
  const len = normal.length();
  if (len < 1e-9) return delta.clone();
  const u = normal.clone().divideScalar(len);
  return delta.clone().sub(u.multiplyScalar(delta.dot(u)));
}

/** How far from straight the border may turn at a vertex before that vertex
 *  counts as a corner and stops moving: ~40 degrees. */
const CORNER_DOT = -Math.cos(40 * Math.PI / 180);

/** A border vertex whose two border edges turn sharply — a box's corner, the
 *  point of an L. Anything that is not a two-neighbour border vertex is not a
 *  corner: interior vertices are free, and a border JUNCTION (three borders
 *  meeting) has no chord to run along and is held by `tangential` instead. */
function isPinnedCorner(
  id: number, ids: number[], byId: Map<number, { co: Vec3 }>, onBorder: boolean,
): boolean {
  if (!onBorder || ids.length !== 2) return false;
  const here = byId.get(id)?.co;
  const a = byId.get(ids[0])?.co, b = byId.get(ids[1])?.co;
  if (!here || !a || !b) return false;
  const d1 = sub(a, here), d2 = sub(b, here);
  if (d1.lengthSq() < 1e-18 || d2.lengthSq() < 1e-18) return false;
  // straight through = the two directions oppose (dot -1); a right angle = 0
  return d1.normalize().dot(d2.normalize()) > CORNER_DOT;
}

/** Screen/world plumbing shared by both kinds — only the matrix differs. */
function makeSpace(ctx: AppCtx, matrix: THREE.Matrix4) {
  const inv = matrix.clone().invert();
  const rect = ctx.canvas.getBoundingClientRect();
  const toWorld = (co: Vec3) => new THREE.Vector3(...co).applyMatrix4(matrix);
  const fromWorld = (w: THREE.Vector3): Vec3 => {
    const v = w.clone().applyMatrix4(inv);
    return [v.x, v.y, v.z];
  };
  return {
    toWorld,
    fromWorld,
    toScreen: (co: Vec3) => {
      const v = toWorld(co).project(ctx.camera);
      return new THREE.Vector2((v.x * 0.5 + 0.5) * rect.width, (-v.y * 0.5 + 0.5) * rect.height);
    },
    deltaToLocal: (at: THREE.Vector2, delta: THREE.Vector2): Vec3 | null => {
      const w0 = screenToWorld(ctx, at.x + rect.left, at.y + rect.top);
      const w1 = screenToWorld(ctx, at.x + delta.x + rect.left, at.y + delta.y + rect.top);
      if (!w0 || !w1) return null;
      const l0 = fromWorld(w0), l1 = fromWorld(w1);
      return [l1[0] - l0[0], l1[1] - l0[1], l1[2] - l0[2]];
    },
  };
}

/** The active GP object's editable strokes at the current frame. */
function gpTarget(ctx: AppCtx): SculptTarget | null {
  const ob = activeObject(ctx.scene);
  if (!ob || ob.lock || ob.hide) return null;
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...ob.translation),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
    new THREE.Vector3(...ob.scale),
  );
  const space = makeSpace(ctx, matrix);

  const points: SculptPoint[] = [];
  for (const layer of visibleEditableLayers(ob)) {
    const frame = frameAt(layer, ctx.scene.frame);
    if (!frame) continue;
    for (const s of frame.strokes) {
      const pts = s.points;
      pts.forEach((p, i) => {
        // A stroke's ENDS report no neighbours, which is what has always
        // held them fixed under Smooth — keep that, or a sculpted line
        // slowly retracts from both ends.
        const prev = i > 0 ? pts[i - 1] : null;
        const next = i < pts.length - 1 ? pts[i + 1] : null;
        const chain = prev && next;
        points.push({
          co: () => p.co,
          set: (co) => { p.co = co; },
          nbrs: () => (chain ? [prev.co, next.co] : []),
          tangential: (delta) => (chain ? alongAxis(delta, sub(next.co, prev.co)) : delta.clone()),
          gp: p,
        });
      });
    }
  }
  return points.length
    ? { kind: 'GP', label: ob.name ?? 'strokes', points, ...space, flush: (c) => c.requestRender() }
    : null;
}

/** An editable mesh's vertices, with its edges for neighbours and its faces
 *  for the normals Relax slides along. */
function polyTarget(ctx: AppCtx, pm: TGPolyMesh): SculptTarget | null {
  if (!pm.vertices.length || pm.lock) return null;
  const space = makeSpace(ctx, worldMatrixOf(ctx.scene, { kind: 'POLY', id: pm.id }));

  const byId = new Map(pm.vertices.map((v) => [v.id, v]));
  const nbrIds = new Map<number, number[]>();
  for (const e of pm.edges) {
    if (!byId.has(e.v[0]) || !byId.has(e.v[1])) continue;
    (nbrIds.get(e.v[0]) ?? nbrIds.set(e.v[0], []).get(e.v[0])!).push(e.v[1]);
    (nbrIds.get(e.v[1]) ?? nbrIds.set(e.v[1], []).get(e.v[1])!).push(e.v[0]);
  }

  // THE BORDER IS A FEATURE, AND LETTING IT SLIDE ACROSS THE SURFACE EATS
  // THE MESH. A border vertex's surface normal points out of the sheet, so
  // "everything except the normal" leaves it free to move INWARD — and a
  // Laplacian with a free boundary contracts, so an open grid relaxed a few
  // times walks its own edge inwards and collapses toward a point (measured
  // before this: a 3.0-wide row of a flat grid came out 0.04 wide, evenly
  // spaced and useless). A border vertex therefore averages only against
  // its BORDER neighbours and slides only along the chord between them:
  // the silhouette evens out and stays exactly where it was. A vertex with
  // no faces at all — a loose wire — is every bit a border by this rule and
  // gets the same treatment, which is also what a stroke point gets.
  //
  // Corners need no special case: at one, the pull toward the mean is
  // square to that chord, so its sliding part is zero and the corner holds
  // itself. (Same arithmetic that pins the apex of a V.)
  const faceUses = new Map<string, number>();
  const ekey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const f of pm.faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      const k = ekey(f.vertices[i], f.vertices[(i + 1) % f.vertices.length]);
      faceUses.set(k, (faceUses.get(k) ?? 0) + 1);
    }
  }
  const borderIds = new Map<number, number[]>();
  for (const e of pm.edges) {
    if ((faceUses.get(ekey(e.v[0], e.v[1])) ?? 0) >= 2) continue;
    if (!byId.has(e.v[0]) || !byId.has(e.v[1])) continue;
    (borderIds.get(e.v[0]) ?? borderIds.set(e.v[0], []).get(e.v[0])!).push(e.v[1]);
    (borderIds.get(e.v[1]) ?? borderIds.set(e.v[1], []).get(e.v[1])!).push(e.v[0]);
  }

  // Vertex normals by Newell over each face it belongs to, summed — area
  // weighted for free, and right for the slightly non-planar n-gons a
  // blockout is full of. Frozen for the length of the stroke: recomputing
  // per pointer move would cost a full pass over the faces every frame, and
  // a normal that old is still the surface you are looking at.
  const normals = new Map<number, THREE.Vector3>();
  for (const f of pm.faces) {
    const loop = f.vertices.map((id) => byId.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
    if (loop.length < 3) continue;
    const n = new THREE.Vector3();
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i].co, b = loop[(i + 1) % loop.length].co;
      n.x += (a[1] - b[1]) * (a[2] + b[2]);
      n.y += (a[2] - b[2]) * (a[0] + b[0]);
      n.z += (a[0] - b[0]) * (a[1] + b[1]);
    }
    for (const v of loop) {
      const acc = normals.get(v.id);
      if (acc) acc.add(n); else normals.set(v.id, n.clone());
    }
  }

  const points: SculptPoint[] = pm.vertices.map((v) => {
    const border = borderIds.get(v.id) ?? null;
    // On the border, only the border counts — both for what this averages
    // against and for the one direction it may travel.
    const ids = border ?? nbrIds.get(v.id) ?? [];
    const normal = border ? null : normals.get(v.id) ?? null;
    // A CORNER OF THE BORDER IS A FEATURE AND IS PINNED. Sliding it along
    // the chord between its two border neighbours cuts the corner off — and
    // worse, it then drags ITS neighbours off the border, so a straight edge
    // bows inward from both ends (measured on a square grid before this: a
    // corner walked 0.11 off true and the edge beside it wobbled by the
    // same). Classified once, at the start of the stroke, by how far the
    // border TURNS here: a gentle curve (a coarse circle turns 30 degrees a
    // vertex) still relaxes, anything past ~40 keeps its shape. Reported
    // with no neighbours at all, so Smooth holds it too — the same rule a
    // stroke's endpoints have always had.
    const pinned = isPinnedCorner(v.id, ids, byId, !!border);
    return {
      co: () => v.co,
      set: (co) => { v.co = co; },
      nbrs: () => (pinned ? [] : ids.map((id) => byId.get(id)?.co).filter((c): c is Vec3 => !!c)),
      tangential: (delta) => {
        if (pinned) return new THREE.Vector3();
        if (normal && normal.lengthSq() > 1e-18) return acrossNormal(delta, normal);
        if (ids.length === 2) {
          const a = byId.get(ids[0])?.co, b = byId.get(ids[1])?.co;
          if (a && b) return alongAxis(delta, sub(b, a));
        }
        // a border junction (three borders meeting) has no single chord to
        // run along, and guessing one would tear the seam — hold it
        return new THREE.Vector3();
      },
      gp: null,
    };
  });

  return {
    kind: 'POLY',
    label: pm.name ?? 'mesh',
    points,
    ...space,
    flush: (c) => { touchPolyMesh(pm); c.requestRender(); },
  };
}

/**
 * What the brush should act on right now.
 *
 * `meshTargetId` is the App's own `meshEditId` — "Edit mode is editing THIS
 * mesh" — handed to the tool the way the splat tools are handed theirs.
 * Reading `polyOverlay.editMeshId` instead would be wrong: `App.setTool`
 * falls back through "any selected poly mesh" all the way to
 * `polyMeshes[0]`, so in a scene that merely CONTAINS a mesh, picking the
 * sculpt tool to work on your drawing would quietly aim it at that mesh.
 */
export function sculptTarget(ctx: AppCtx, meshTargetId: number | null): SculptTarget | null {
  if (meshTargetId !== null) {
    const pm = ctx.scene.polyMeshes.find((p) => p.id === meshTargetId);
    if (pm) return polyTarget(ctx, pm);
  }
  return gpTarget(ctx);
}
