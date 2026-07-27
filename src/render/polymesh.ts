// Editable generalized meshes (TGPolyMesh): derived three.js render state.
// Persistent topology lives in scene.polyMeshes; this manager rebuilds
// triangulated face meshes when a mesh's `rev` changes, and keeps edge/
// vertex overlays + transient tool previews in sync every frame. Nothing
// here is scene data — overlays and previews are runtime-only.
import * as THREE from 'three';
import type { GPScene, TGPolyFace, TGPolyMesh, Vec3 } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import { materialManager } from './materialmgr';

// ---- transient overlay state (topology tool -> renderer) -------------------
// The tool writes hover/preview/edit-target here; the manager reads it each
// frame. Deliberately a module singleton so the tool never touches renderer
// objects and the renderer never imports tool code.
export interface PolyOverlayState {
  /** overlays get edit styling (louder, depth-tested off) for this mesh */
  editMeshId: number | null;
  hover: { meshId: number; dim: 0 | 1 | 2; id: number } | null;
  /** world-space pending chain (construction preview), cursor point last */
  previewLine: Vec3[] | null;
  /** candidate construction point (world) */
  previewPoint: Vec3 | null;
  /** the preview would close a valid face */
  previewLoop: boolean;
  /** the pending operation is invalid (red feedback) */
  previewInvalid: boolean;
  /** vertex ids of the active construction sequence (edit mesh) */
  activeVertexIds: number[];
}

export const polyOverlay: PolyOverlayState = {
  editMeshId: null, hover: null,
  previewLine: null, previewPoint: null,
  previewLoop: false, previewInvalid: false,
  activeVertexIds: [],
};

export function clearPolyOverlay(): void {
  polyOverlay.hover = null;
  polyOverlay.previewLine = null;
  polyOverlay.previewPoint = null;
  polyOverlay.previewLoop = false;
  polyOverlay.previewInvalid = false;
  polyOverlay.activeVertexIds = [];
}

// ---- colors (PolyQuilt-inspired cyan topology display) ---------------------
const COL_EDGE = new THREE.Color(0.25, 0.75, 0.95);
const COL_EDGE_DIM = new THREE.Color(0.16, 0.42, 0.55);
const COL_HOVER = new THREE.Color(1, 1, 1);
const COL_SELECT = new THREE.Color(1, 0.48, 0);       // matches uiHighlight
const COL_ACTIVE = new THREE.Color(0.3, 1, 0.65);
const COL_INVALID = new THREE.Color(1, 0.25, 0.25);

/** Newell normal of an ordered 3D polygon (robust for non-planar n-gons). */
function newellNormal(pts: Vec3[]): THREE.Vector3 {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n.x += (a[1] - b[1]) * (a[2] + b[2]);
    n.y += (a[2] - b[2]) * (a[0] + b[0]);
    n.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n.lengthSq() < 1e-12 ? n.set(0, 0, 1) : n.normalize();
}

/** Triangulate one face boundary (local space). Returns triangle index
 *  triples into the BOUNDARY array. Never mutates the persistent face. */
export function triangulateFace(coords: Vec3[]): [number, number, number][] {
  if (coords.length < 3) return [];
  if (coords.length === 3) return [[0, 1, 2]];
  const normal = newellNormal(coords);
  const tmp = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(tmp, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  // fresh Vector2 array — ShapeUtils.triangulateShape mutates its input
  const proj = coords.map((c) => {
    const p = new THREE.Vector3(...c);
    return new THREE.Vector2(p.dot(u), p.dot(v));
  });
  const count = proj.length;
  let tris: number[][] = [];
  try { tris = THREE.ShapeUtils.triangulateShape(proj, []); }
  catch { /* degenerate boundary: fall through to fan */ }
  if (!tris.length) {
    for (let i = 1; i < count - 1; i++) tris.push([0, i, i + 1]);
  }
  return tris.filter((t) => t.length === 3 && t.every((i) => i < count)) as [number, number, number][];
}

/** Dynamic planar auto-UV: box-projects a mesh's vertices onto its
 *  dominant flat plane (the axis with the SMALLEST overall extent is
 *  treated as the "normal", the other two become U/V) — good enough for
 *  texture painting on a roughly-flat quilt, no persisted UV data needed.
 *  Shared by the live renderer (rebuildGeometry) and the scene exporter
 *  so painted textures line up the same way in both. */
/** Per-face-CORNER UV lookup: the persisted `face.uv` written by an
 *  unwrap (core/uvunwrap.ts) when present, else the dynamic planar
 *  auto-projection below. `cornerIndex` indexes the face's boundary, which
 *  is exactly what triangulateFace's returned indices refer to. Shared by
 *  the renderer and the exporter so both agree. */
export function polyFaceUV(pm: TGPolyMesh): (f: TGPolyFace, cornerIndex: number, co: Vec3) => [number, number] {
  const auto = polyAutoUV(pm);
  return (f, i, co) => {
    // Length check, not just presence: a topology op (subdivide, split,
    // extrude) can change a face's boundary without maintaining its UVs,
    // which would silently index stale corners. A mismatched face falls
    // back to the auto-projection instead of rendering garbage.
    const uv = f.uv && f.uv.length === f.vertices.length ? f.uv[i] : undefined;
    return uv ?? auto(co);
  };
}

export function polyAutoUV(pm: TGPolyMesh): (co: Vec3) => [number, number] {
  const box = new THREE.Box3();
  for (const v of pm.vertices) box.expandByPoint(new THREE.Vector3(...v.co));
  const size = box.getSize(new THREE.Vector3());
  const flatAxis = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
  const [uAxis, vAxis] = flatAxis === 0 ? [1, 2] : flatAxis === 1 ? [0, 2] : [0, 1];
  const uExt = Math.max(1e-6, size.getComponent(uAxis));
  const vExt = Math.max(1e-6, size.getComponent(vAxis));
  return (c: Vec3) => [
    (c[uAxis] - box.min.getComponent(uAxis)) / uExt,
    (c[vAxis] - box.min.getComponent(vAxis)) / vExt,
  ];
}

interface Entry {
  group: THREE.Group;
  faceMesh: THREE.Mesh;
  /** triangle index -> source face id (face picking) */
  triFaceIds: number[];
  edgeLines: THREE.LineSegments;
  /** line-segment index -> edge id */
  segEdgeIds: number[];
  verts: THREE.InstancedMesh;
  /** instance index -> vertex id */
  instVertIds: number[];
  rev: number;
  editStyled: boolean;
  unlit: boolean;
  /** texture-paint stroke in flight: applyFrame leaves the material's
   *  map alone (the tool owns it as a CanvasTexture) until endLiveTexture */
  live: boolean;
  texSrc: string | null;
}

const VERT_CAP = 4096; // instanced-handle capacity per mesh (sketch scale)

export class PolyMeshManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, Entry>();
  // transient preview objects (rebuilt from polyOverlay every frame)
  private previewLine: THREE.Line;
  private previewPoint: THREE.Mesh;

  constructor() {
    this.previewLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COL_ACTIVE, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.previewLine.renderOrder = 999;
    this.previewLine.visible = false;
    this.previewLine.frustumCulled = false;
    this.previewPoint = new THREE.Mesh(
      new THREE.OctahedronGeometry(1),
      new THREE.MeshBasicMaterial({ color: COL_ACTIVE, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    this.previewPoint.renderOrder = 1000;
    this.previewPoint.visible = false;
    this.group.add(this.previewLine, this.previewPoint);
  }

  /** Mirror scene.polyMeshes; rebuild geometry on rev change, restyle
   *  overlays + screen-scale vertex handles every frame. */
  sync(scene: GPScene, camera: THREE.Camera): void {
    for (const [id, entry] of this.entries) {
      if (!scene.polyMeshes.some((p) => p.id === id)) {
        this.group.remove(entry.group);
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }
    for (const pm of scene.polyMeshes) {
      let entry = this.entries.get(pm.id);
      if (!entry) {
        entry = this.buildEntry(pm);
        this.group.add(entry.group);
        this.entries.set(pm.id, entry);
      }
      if (entry.rev !== pm.rev) {
        this.rebuildGeometry(entry, pm);
        entry.rev = pm.rev;
      }
      this.applyFrame(entry, pm, scene, camera);
    }
    this.applyPreview(camera);
  }

  private buildEntry(pm: TGPolyMesh): Entry {
    const group = new THREE.Group();
    group.userData.polyId = pm.id;
    const faceMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    );
    faceMesh.userData.polyId = pm.id;
    // quilt faces participate in shadows like any other surface (per-light
    // opt-in, so this is free until a light turns castShadow on)
    faceMesh.castShadow = true;
    faceMesh.receiveShadow = true;
    const edgeLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }),
    );
    edgeLines.userData.polyId = pm.id;
    edgeLines.raycast = () => {}; // overlays never intercept surface raycasts
    const verts = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1),
      new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 }),
      VERT_CAP,
    );
    verts.userData.polyId = pm.id;
    verts.raycast = () => {};
    verts.renderOrder = 998;
    verts.count = 0;
    group.add(faceMesh, edgeLines, verts);
    return {
      group, faceMesh, triFaceIds: [], edgeLines, segEdgeIds: [], verts,
      instVertIds: [], rev: -1, editStyled: false, unlit: false,
      live: false, texSrc: null,
    };
  }

  private rebuildGeometry(entry: Entry, pm: TGPolyMesh): void {
    // faces: non-indexed triangle soup (per-face triangulation of the
    // persistent boundary — boundaries themselves are never touched)
    const pos: number[] = [];
    entry.triFaceIds = [];
    const co = new Map(pm.vertices.map((v) => [v.id, v.co] as const));
    const uvOf = polyFaceUV(pm);

    const uvs: number[] = [];
    for (const f of pm.faces) {
      const boundary = f.vertices.map((id) => co.get(id)).filter((c): c is Vec3 => !!c);
      if (boundary.length !== f.vertices.length || boundary.length < 3) continue;
      for (const [a, b, c] of triangulateFace(boundary)) {
        pos.push(...boundary[a], ...boundary[b], ...boundary[c]);
        // triangulateFace's indices are into the face boundary, which is
        // exactly what a persisted per-corner UV is keyed by
        uvs.push(...uvOf(f, a, boundary[a]), ...uvOf(f, b, boundary[b]), ...uvOf(f, c, boundary[c]));
        entry.triFaceIds.push(f.id);
      }
    }
    entry.faceMesh.geometry.dispose();
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    fg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    fg.computeVertexNormals();
    entry.faceMesh.geometry = fg;
    entry.faceMesh.visible = pos.length > 0;

    // edges: one segment per persistent edge (dangling edges included)
    const epos: number[] = [];
    entry.segEdgeIds = [];
    for (const e of pm.edges) {
      const a = co.get(e.v[0]), b = co.get(e.v[1]);
      if (!a || !b) continue;
      epos.push(...a, ...b);
      entry.segEdgeIds.push(e.id);
    }
    entry.edgeLines.geometry.dispose();
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(epos, 3));
    eg.setAttribute('color', new THREE.Float32BufferAttribute(new Array(epos.length).fill(1), 3));
    entry.edgeLines.geometry = eg;
    entry.edgeLines.visible = epos.length > 0;

    // vertex handles: instance ids (matrices/colors are per-frame)
    entry.instVertIds = pm.vertices.slice(0, VERT_CAP).map((v) => v.id);
    entry.verts.count = entry.instVertIds.length;
  }

  private applyFrame(entry: Entry, pm: TGPolyMesh, scene: GPScene, camera: THREE.Camera): void {
    const world = worldMatrixOf(scene, { kind: 'POLY', id: pm.id });
    entry.group.matrixAutoUpdate = false;
    entry.group.matrix.copy(world);
    entry.group.visible = pm.visible;
    if (!pm.visible) return;

    const isEdit = polyOverlay.editMeshId === pm.id;
    const hover = polyOverlay.hover?.meshId === pm.id ? polyOverlay.hover : null;

    // face material — the shared datablock when assigned, else this mesh's
    // own legacy flattened fields (see render/materialmgr.ts)
    const look = {
      color: pm.color, opacity: pm.opacity, texture: pm.texture,
      unlit: pm.unlit, doubleSided: pm.doubleSided, wireframe: pm.wireframe,
    };
    const mat = entry.faceMesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
    const wantUnlit = materialManager.wantsUnlit(scene, pm.materialId, look);
    if (entry.unlit !== wantUnlit) {
      (mat as THREE.Material).dispose();
      entry.faceMesh.material = wantUnlit
        ? new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
        : new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      entry.unlit = wantUnlit;
      entry.texSrc = null; // fresh material has no map yet — force reapply below
    }
    const fmat = entry.faceMesh.material as THREE.MeshStandardMaterial;
    materialManager.apply(fmat, scene, pm.materialId, look, !!entry.live);
    // hovered face tint (edit mode)
    if (isEdit && hover?.dim === 2) fmat.emissive?.setRGB(0.12, 0.3, 0.38);
    else fmat.emissive?.setRGB(0, 0, 0);

    // edge overlay colors + edit styling
    const emat = entry.edgeLines.material as THREE.LineBasicMaterial;
    if (entry.editStyled !== isEdit) {
      emat.depthTest = !isEdit;
      entry.edgeLines.renderOrder = isEdit ? 997 : 0;
      emat.needsUpdate = true;
      entry.editStyled = isEdit;
    }
    emat.opacity = isEdit ? 1 : 0.85;
    const ecol = entry.edgeLines.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (ecol) {
      const edgeById = new Map(pm.edges.map((e) => [e.id, e] as const));
      for (let i = 0; i < entry.segEdgeIds.length; i++) {
        const e = edgeById.get(entry.segEdgeIds[i]);
        const c = hover?.dim === 1 && hover.id === entry.segEdgeIds[i] ? COL_HOVER
          : e?.select ? COL_SELECT
          : isEdit ? COL_EDGE : COL_EDGE_DIM;
        ecol.setXYZ(i * 2, c.r, c.g, c.b);
        ecol.setXYZ(i * 2 + 1, c.r, c.g, c.b);
      }
      ecol.needsUpdate = true;
    }

    // vertex handles: constant screen size (scale by camera distance)
    const camPos = new THREE.Vector3().setFromMatrixPosition((camera as THREE.PerspectiveCamera).matrixWorld);
    const m = new THREE.Matrix4();
    const wp = new THREE.Vector3();
    const activeSet = new Set(isEdit ? polyOverlay.activeVertexIds : []);
    const vById = new Map(pm.vertices.map((v) => [v.id, v] as const));
    const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
    const orthoSize = !persp ? ((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom)
      / ((camera as THREE.OrthographicCamera).zoom || 1) : 0;
    for (let i = 0; i < entry.instVertIds.length; i++) {
      const v = vById.get(entry.instVertIds[i]);
      if (!v) continue;
      wp.set(...v.co).applyMatrix4(world);
      const dist = persp ? wp.distanceTo(camPos) : orthoSize;
      const s = Math.max(1e-5, dist * (isEdit ? 0.008 : 0.005));
      m.makeScale(s, s, s).setPosition(wp);
      // instances live under the transformed group — pre-multiply inverse
      m.premultiply(world.clone().invert());
      entry.verts.setMatrixAt(i, m);
      const c = hover?.dim === 0 && hover.id === v.id ? COL_HOVER
        : activeSet.has(v.id) ? COL_ACTIVE
        : v.select ? COL_SELECT
        : COL_EDGE;
      entry.verts.setColorAt(i, c);
    }
    entry.verts.instanceMatrix.needsUpdate = true;
    if (entry.verts.instanceColor) entry.verts.instanceColor.needsUpdate = true;
    // vertex diamonds are an editing affordance, not a display style —
    // only the mesh actively being worked on (a quilt tool is active AND
    // targeting it) shows them; a merely-selected-in-object-mode mesh
    // does not, so idle meshes don't clutter the viewport
    entry.verts.visible = isEdit;
    (entry.verts.material as THREE.MeshBasicMaterial).opacity = 0.95;
  }

  private applyPreview(camera: THREE.Camera): void {
    const line = polyOverlay.previewLine;
    if (line && line.length >= 2) {
      this.previewLine.geometry.dispose();
      const pts = polyOverlay.previewLoop ? [...line, line[0]] : line;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
      this.previewLine.geometry = g;
      (this.previewLine.material as THREE.LineBasicMaterial).color =
        polyOverlay.previewInvalid ? COL_INVALID : COL_ACTIVE;
      this.previewLine.visible = true;
    } else {
      this.previewLine.visible = false;
    }
    const pt = polyOverlay.previewPoint;
    if (pt) {
      const wp = new THREE.Vector3(...pt);
      const camPos = new THREE.Vector3().setFromMatrixPosition((camera as THREE.PerspectiveCamera).matrixWorld);
      const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
      const dist = persp ? wp.distanceTo(camPos)
        : ((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom)
          / ((camera as THREE.OrthographicCamera).zoom || 1);
      const s = Math.max(1e-5, dist * 0.01);
      this.previewPoint.position.copy(wp);
      this.previewPoint.scale.setScalar(s);
      (this.previewPoint.material as THREE.MeshBasicMaterial).color =
        polyOverlay.previewInvalid ? COL_INVALID : COL_ACTIVE;
      this.previewPoint.visible = true;
    } else {
      this.previewPoint.visible = false;
    }
  }

  /** Face meshes flagged as draw targets, for ctx.surfaces. */
  drawTargets(scene: GPScene): THREE.Object3D[] {
    return scene.polyMeshes
      .filter((p) => p.visible && p.drawTarget && p.faces.length)
      .map((p) => this.entries.get(p.id)?.faceMesh)
      .filter((r): r is THREE.Mesh => !!r);
  }

  /** Visible face meshes (object-mode picking + face element picking). */
  pickTargets(scene: GPScene): THREE.Object3D[] {
    return scene.polyMeshes
      .filter((p) => p.visible && p.faces.length)
      .map((p) => this.entries.get(p.id)?.faceMesh)
      .filter((r): r is THREE.Mesh => !!r);
  }

  /** Resolve a raycast triangle index back to its source face id. */
  faceIdAt(polyId: number, triangleIndex: number): number | null {
    return this.entries.get(polyId)?.triFaceIds[triangleIndex] ?? null;
  }

  /** Per-mesh render root (selection glyphs, zone flashes). NOTE: the box
   *  of this group is polluted by the unit-sized instanced vertex handles —
   *  size selection outlines from the DATA (vertices x world matrix). */
  rootFor(id: number): THREE.Object3D | null { return this.entries.get(id)?.group ?? null; }

  /** Texture painting on a quilt face: while a stroke is in flight the
   *  tool paints into an offscreen canvas and we show it live as a
   *  CanvasTexture (applyFrame leaves the map alone until endLiveTexture).
   *  Mirrors MeshManager's beginLive/refreshLive/endLiveTexture seam. */
  beginLiveTexture(id: number, canvas: HTMLCanvasElement): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.live = true;
    const mat = entry.faceMesh.material as THREE.MeshStandardMaterial;
    if (!(mat.map instanceof THREE.CanvasTexture) || mat.map.image !== canvas) {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.transparent = true;
      mat.needsUpdate = true;
    }
  }

  refreshLiveTexture(id: number): void {
    const mat = this.entries.get(id)?.faceMesh.material as THREE.MeshStandardMaterial | undefined;
    if (mat?.map) mat.map.needsUpdate = true;
  }

  endLiveTexture(id: number): void {
    const entry = this.entries.get(id);
    if (entry) { entry.live = false; entry.texSrc = null; } // force reapply from pm.texture next sync
  }

  private disposeEntry(entry: Entry): void {
    entry.faceMesh.geometry.dispose();
    (entry.faceMesh.material as THREE.Material).dispose();
    entry.edgeLines.geometry.dispose();
    (entry.edgeLines.material as THREE.Material).dispose();
    entry.verts.geometry.dispose();
    (entry.verts.material as THREE.Material).dispose();
  }
}
