// UV unwrapping for TGPolyMesh — projection-family operators, matching
// Blender's Project from View / Cube / Cylinder / Sphere / Reset.
//
// Pure like core/polymesh.ts: plain-JSON in, plain-JSON out, no three.js
// and no UI, so the same code serves the tool, the renderer, the exporter
// and tests. Results are written to `face.uv` (one [u,v] per boundary
// CORNER, parallel to face.vertices) so seams are representable — two
// faces sharing a vertex can give it different UVs.
//
// Conformal/angle-based unwrapping (Blender's Smart UV Project / LSCM) is
// deliberately not here: it's a much larger algorithmic lift and the
// projection family covers the texture-painting and baking cases this
// system was built for. A mesh with no `face.uv` still falls back to the
// dynamic planar auto-projection everything used before (polyAutoUV in
// render/polymesh.ts), so unwrapping is opt-in and never breaks old data.
import type { TGPolyMesh, Vec3 } from './types';
import { touchPolyMesh } from './polymesh';

export type UnwrapMode = 'PLANAR' | 'BOX' | 'CYLINDER' | 'SPHERE' | 'VIEW' | 'RESET';

type Vec2 = [number, number];

function bounds(pm: TGPolyMesh): { min: Vec3; max: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of pm.vertices) {
    for (let k = 0; k < 3; k++) {
      if (v.co[k] < min[k]) min[k] = v.co[k];
      if (v.co[k] > max[k]) max[k] = v.co[k];
    }
  }
  if (!pm.vertices.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [1, 1, 1] };
  return {
    min, max,
    size: [
      Math.max(1e-6, max[0] - min[0]),
      Math.max(1e-6, max[1] - min[1]),
      Math.max(1e-6, max[2] - min[2]),
    ],
  };
}

/** Newell normal of a face boundary — which way the polygon faces. */
function faceNormal(co: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < co.length; i++) {
    const a = co[i], b = co[(i + 1) % co.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Write UVs for every face from a per-corner projection function. */
function project(pm: TGPolyMesh, fn: (co: Vec3, faceCo: Vec3[]) => Vec2): void {
  const byId = new Map(pm.vertices.map((v) => [v.id, v.co] as const));
  for (const f of pm.faces) {
    const faceCo = f.vertices.map((id) => byId.get(id)).filter((c): c is Vec3 => !!c);
    if (faceCo.length !== f.vertices.length) continue;
    f.uv = faceCo.map((c) => fn(c, faceCo));
  }
  touchPolyMesh(pm);
}

/** Planar: box-project onto the mesh's dominant flat plane (the axis with
 *  the SMALLEST extent becomes the normal). Same math as the dynamic
 *  polyAutoUV fallback — this just bakes it into persisted data so it
 *  stops sliding when the mesh's bounds change. */
export function unwrapPlanar(pm: TGPolyMesh): void {
  const { min, size } = bounds(pm);
  const flat = size[0] <= size[1] && size[0] <= size[2] ? 0 : size[1] <= size[2] ? 1 : 2;
  const [u, v] = flat === 0 ? [1, 2] : flat === 1 ? [0, 2] : [0, 1];
  project(pm, (c) => [(c[u] - min[u]) / size[u], (c[v] - min[v]) / size[v]]);
}

/** Cube: each FACE projects along whichever axis its own normal points
 *  down, so a box unwraps into six correctly-oriented squares. */
export function unwrapBox(pm: TGPolyMesh): void {
  const { min, size } = bounds(pm);
  const scale = Math.max(size[0], size[1], size[2]);
  project(pm, (c, faceCo) => {
    const n = faceNormal(faceCo);
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const [u, v] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [0, 2] : [0, 1];
    return [(c[u] - min[u]) / scale, (c[v] - min[v]) / scale];
  });
}

/** Cylindrical around the mesh's tallest axis: U = angle, V = height. */
export function unwrapCylinder(pm: TGPolyMesh): void {
  const { min, max, size } = bounds(pm);
  const axis = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
  const [a, b] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const cA = (min[a] + max[a]) / 2, cB = (min[b] + max[b]) / 2;
  project(pm, (c) => [
    (Math.atan2(c[b] - cB, c[a] - cA) / (Math.PI * 2)) + 0.5,
    (c[axis] - min[axis]) / size[axis],
  ]);
}

/** Spherical about the mesh centroid: U = longitude, V = latitude. */
export function unwrapSphere(pm: TGPolyMesh): void {
  const { min, max } = bounds(pm);
  const c0 = (min[0] + max[0]) / 2, c1 = (min[1] + max[1]) / 2, c2 = (min[2] + max[2]) / 2;
  project(pm, (c) => {
    const x = c[0] - c0, y = c[1] - c1, z = c[2] - c2;
    const r = Math.hypot(x, y, z) || 1;
    return [
      (Math.atan2(z, x) / (Math.PI * 2)) + 0.5,
      1 - Math.acos(Math.max(-1, Math.min(1, y / r))) / Math.PI,
    ];
  });
}

/**
 * Project from view: flatten along the camera's view direction, exactly
 * as it appears on screen right now. `toScreen01` maps an object-local
 * point into 0..1 viewport space — the caller supplies it so this module
 * stays free of three.js (see the UI's unwrap action).
 */
export function unwrapFromView(pm: TGPolyMesh, toScreen01: (co: Vec3) => Vec2): void {
  project(pm, (c) => toScreen01(c));
}

/** Drop persisted UVs — every face falls back to the dynamic planar
 *  auto-projection again (which is what un-unwrapped meshes use). */
export function resetUV(pm: TGPolyMesh): void {
  for (const f of pm.faces) delete f.uv;
  touchPolyMesh(pm);
}

/** True if this mesh carries any persisted UVs at all. */
export function hasUV(pm: TGPolyMesh): boolean {
  return pm.faces.some((f) => !!f.uv);
}

export function unwrap(pm: TGPolyMesh, mode: UnwrapMode, toScreen01?: (co: Vec3) => Vec2): void {
  switch (mode) {
    case 'PLANAR': return unwrapPlanar(pm);
    case 'BOX': return unwrapBox(pm);
    case 'CYLINDER': return unwrapCylinder(pm);
    case 'SPHERE': return unwrapSphere(pm);
    case 'VIEW': return toScreen01 ? unwrapFromView(pm, toScreen01) : unwrapPlanar(pm);
    case 'RESET': return resetUV(pm);
  }
}
