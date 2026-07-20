// 3D exporters (P8): strokes as tubes (fabrication-friendly), fills as
// meshes. Exports what you SEE: modifier-evaluated strokes of the current
// frame, per visible layer.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import type { AppCtx } from '../tools/context';
import { frameAt } from '../core/gpdata';
import { evaluateModifiers, remapTime } from '../modifiers/index';
import { buildFillGeometry } from '../render/geometry';
import { polyAutoUV, triangulateFace } from '../render/polymesh';
import { edgeFaceCount } from '../core/polymesh';
import { worldMatrixOf } from '../tools/objects';
import { primitiveGeometry } from '../render/meshes';
import { PAINT_STRIDE } from '../render/paintclouds';
import type { Vec3 } from '../core/types';

export interface Export3DOptions {
  pxToWorld: number;        // width conversion for VIEW-unit strokes
  radialSegments: number;
  minRadius: number;
  selectedOnly: boolean;
  /** Include loose-point geometry (paint-cloud splats, isolated poly-mesh
   *  vertices). Default true; face-only exporters (exportPLY) turn this
   *  off because THREE's PLYExporter drops ALL triangle faces the moment
   *  any Points object is present in the traversal (see exportScenePLY's
   *  doc comment) — mixing would silently corrupt a "just the geometry"
   *  export the moment a splat exists anywhere in the scene. */
  includePointClouds: boolean;
}

export const DEFAULT_EXPORT3D: Export3DOptions = {
  pxToWorld: 0.005, radialSegments: 6, minRadius: 0.002, selectedOnly: false, includePointClouds: true,
};

const textureLoader = new THREE.TextureLoader();
/** Loads and decodes a texture (dataURL or blob/http URL) for embedding
 *  into an export — awaited so GLTFExporter sees a ready image, never a
 *  blank one from a texture that hadn't finished decoding yet. */
async function loadTexture(src: string): Promise<THREE.Texture> {
  const tex = await textureLoader.loadAsync(src);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Build a plain-geometry group mirroring the visible drawing. Async: it
 *  awaits painted-texture decode (primitive mesh / poly mesh .texture
 *  dataURLs) so exported materials carry them, not just a flat color. */
export async function buildExportGroup(ctx: AppCtx, opts: Export3DOptions): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = 'threegrease';
  const scene = ctx.scene;

  scene.objects.forEach((ob) => {
    const obMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    for (const layer of ob.layers) {
      if (layer.hide) continue;
      const kf = frameAt(layer, remapTime(ob, layer, scene.frame));
      if (!kf) continue;
      const strokes = evaluateModifiers(kf.strokes, ob, layer, scene.frame, kf.frameNumber)
        .filter((s) => !opts.selectedOnly || s.select || s.points.some((p) => p.select));
      const layerMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(...layer.translation),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...layer.rotation)),
        new THREE.Vector3(...layer.scale),
      );
      const matrix = obMatrix.clone().multiply(layerMatrix);

      for (const s of strokes) {
        const mat = ob.materials[s.materialIndex] ?? ob.materials[0];
        if (mat?.showStroke && s.points.length >= 2) {
          const pts = s.points.map((p) => new THREE.Vector3(...p.co).applyMatrix4(matrix));
          const meanPressure = s.points.reduce((a, p) => a + p.pressure, 0) / s.points.length;
          const width = s.style?.unit === 'SCENE'
            ? s.lineWidth * meanPressure
            : s.lineWidth * meanPressure * opts.pxToWorld;
          const radius = Math.max(opts.minRadius, width / 2);
          try {
            const curve = new THREE.CatmullRomCurve3(pts, s.cyclic);
            const tube = new THREE.TubeGeometry(
              curve, Math.max(8, s.points.length * 2), radius, opts.radialSegments, s.cyclic);
            const color = new THREE.Color(mat.strokeColor[0], mat.strokeColor[1], mat.strokeColor[2]);
            group.add(new THREE.Mesh(tube, new THREE.MeshStandardMaterial({ color })));
          } catch { /* degenerate stroke: skip */ }
        }
        if (mat?.showFill && s.points.length >= 3) {
          const geom = buildFillGeometry([s], ob.materials, {
            layerOpacity: 1, tint: [0, 0, 0, 0], thicknessOffset: 0, background: [0, 0, 0],
          });
          if (geom) {
            const plain = new THREE.BufferGeometry();
            plain.setAttribute('position', geom.getAttribute('position'));
            plain.setIndex(geom.getIndex());
            plain.applyMatrix4(matrix);
            plain.computeVertexNormals();
            const color = new THREE.Color(mat.fillColor[0], mat.fillColor[1], mat.fillColor[2]);
            group.add(new THREE.Mesh(plain, new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide })));
          }
        }
      }
    }
  });

  // editable generalized meshes: faces as triangulated geometry; face-less
  // edges as GL line primitives and fully isolated vertices as GL points
  // (GLTF carries lines/points; OBJ/STL/PLY exporters only process Mesh
  // objects, so there faces export and points/edges are skipped — never
  // silently converted into unrelated geometry).
  for (const pm of scene.polyMeshes) {
    if (!pm.visible) continue;
    const matrix = worldMatrixOf(scene, { kind: 'POLY', id: pm.id });
    const co = new Map(pm.vertices.map((v) => [v.id, v.co] as const));
    const color = new THREE.Color(pm.color[0], pm.color[1], pm.color[2]);

    const uvOf = polyAutoUV(pm);
    const facePos: number[] = [];
    const faceUv: number[] = [];
    for (const f of pm.faces) {
      const boundary = f.vertices.map((id) => co.get(id)).filter((c): c is Vec3 => !!c);
      if (boundary.length !== f.vertices.length || boundary.length < 3) continue;
      for (const [a, b, c] of triangulateFace(boundary)) {
        facePos.push(...boundary[a], ...boundary[b], ...boundary[c]);
        faceUv.push(...uvOf(boundary[a]), ...uvOf(boundary[b]), ...uvOf(boundary[c]));
      }
    }
    if (facePos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(facePos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(faceUv, 2));
      geo.applyMatrix4(matrix);
      geo.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        color, side: THREE.DoubleSide, transparent: pm.opacity < 1, opacity: pm.opacity,
      });
      if (pm.texture) material.map = await loadTexture(pm.texture);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = pm.name;
      group.add(mesh);
    }

    const edgePos: number[] = [];
    for (const e of pm.edges) {
      if (edgeFaceCount(pm, e.id) > 0) continue; // face boundaries covered above
      const a = co.get(e.v[0]), b = co.get(e.v[1]);
      if (a && b) edgePos.push(...a, ...b);
    }
    if (edgePos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
      geo.applyMatrix4(matrix);
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
      lines.name = `${pm.name} edges`;
      group.add(lines);
    }

    const used = new Set<number>();
    for (const e of pm.edges) { used.add(e.v[0]); used.add(e.v[1]); }
    for (const f of pm.faces) for (const id of f.vertices) used.add(id);
    const pointPos: number[] = [];
    for (const v of pm.vertices) if (!used.has(v.id)) pointPos.push(...v.co);
    if (opts.includePointClouds && pointPos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pointPos, 3));
      geo.applyMatrix4(matrix);
      const points = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 0.02 }));
      points.name = `${pm.name} points`;
      group.add(points);
    }
  }

  // primitive mesh objects (PLANE/BOX/SPHERE/CYLINDER). MODEL is a loaded
  // external asset (not owned data, and loading it here would make this
  // synchronous builder async for one uncommon case) and EMPTY has no
  // surface — both skipped, matching the live renderer's non-draw-target
  // treatment of EMPTY.
  for (const m of scene.meshes) {
    if (!m.visible || m.kind === 'EMPTY' || m.kind === 'MODEL') continue;
    const geo = primitiveGeometry(m.kind).clone();
    geo.applyMatrix4(worldMatrixOf(scene, { kind: 'MESH', id: m.id }));
    geo.computeVertexNormals();
    const color = new THREE.Color(m.color[0], m.color[1], m.color[2]);
    const material = new THREE.MeshStandardMaterial({
      color, opacity: m.opacity, transparent: m.opacity < 1, side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (m.texture) material.map = await loadTexture(m.texture);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = m.name;
    group.add(mesh);
  }

  // painted splat clouds (TGPaintCloud): no gaussian ellipsoids in a plain
  // export, so represent each point as a colored vertex (GLB carries a
  // POINTS-mode primitive with vertex color; PLYExporter also understands
  // Points — see exportScenePLY for the combined-with-faces PLY case,
  // where THREE's own PLYExporter can't mix points and faces correctly).
  for (const pc of opts.includePointClouds ? scene.paintClouds : []) {
    if (!pc.visible || !pc.points.length) continue;
    const n = pc.points.length / PAINT_STRIDE;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * PAINT_STRIDE;
      pos[i * 3] = pc.points[o]; pos[i * 3 + 1] = pc.points[o + 1]; pos[i * 3 + 2] = pc.points[o + 2];
      col[i * 3] = pc.points[o + 4]; col[i * 3 + 1] = pc.points[o + 5]; col[i * 3 + 2] = pc.points[o + 6];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.applyMatrix4(worldMatrixOf(scene, { kind: 'PCLOUD', id: pc.id }));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ vertexColors: true, size: 0.03 }));
    points.name = pc.name;
    group.add(points);
  }
  return group;
}

function download(data: BlobPart, filename: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function exportGLB(ctx: AppCtx, opts = DEFAULT_EXPORT3D): Promise<ArrayBuffer> {
  const group = await buildExportGroup(ctx, opts);
  const buffer = await new GLTFExporter().parseAsync(group, { binary: true }) as ArrayBuffer;
  download(buffer, 'threegrease.glb', 'model/gltf-binary');
  return buffer;
}

export async function exportOBJ(ctx: AppCtx, opts = DEFAULT_EXPORT3D): Promise<string> {
  const text = new OBJExporter().parse(await buildExportGroup(ctx, opts));
  download(text, 'threegrease.obj', 'text/plain');
  return text;
}

/** Geometry-only PLY (tubes + fills as one merged mesh cloud, binary).
 *  Always excludes point clouds regardless of opts.includePointClouds —
 *  THREE's PLYExporter drops ALL triangle faces the moment any Points
 *  object is present in the group (see exportScenePLY), so this format
 *  stays a pure-faces export; use "Export Full Scene (PLY)" for splats.
 *  PLY has no texture support at all (per THREE's own PLYExporter docs),
 *  so textured faces fall back to their flat material color here. */
export async function exportPLY(ctx: AppCtx, opts = DEFAULT_EXPORT3D): Promise<ArrayBuffer | string | null> {
  const group = await buildExportGroup(ctx, { ...opts, includePointClouds: false });
  const result = new PLYExporter().parse(group, () => {}, { binary: true }) as ArrayBuffer | null;
  if (result) download(result, 'threegrease.ply', 'application/octet-stream');
  return result;
}

/** Combined PLY: geometry AS FACES + splat/point clouds as loose colored
 *  vertices in the SAME file. Blender's PLY importer builds one mesh
 *  object per file — faces become real polygons, and the extra vertices
 *  with no face references stay as loose colored points (visible via a
 *  Color Attribute / Vertex Paint overlay, or with the Point Cloud Visualizer
 *  addon for a proper splat-like look). THREE's own PLYExporter can't
 *  produce this: parse() sets includeIndices = false the moment ANY
 *  Points object appears anywhere in the traversal, silently discarding
 *  every triangle face in the file — so this walks buildExportGroup's
 *  Mesh/Points children directly and writes the binary file by hand.
 *  LineSegments (poly-mesh edges with no face) have no PLY analogue and
 *  are skipped, same as every other exporter in this file. Textures
 *  aren't carried either (PLY has no texture concept) — textured faces
 *  fall back to their flat material color, same as exportPLY. */
export async function exportScenePLY(ctx: AppCtx, opts = DEFAULT_EXPORT3D): Promise<ArrayBuffer | null> {
  const group = await buildExportGroup(ctx, opts);
  const positions: number[] = [];
  const colors: number[] = []; // 0-255 per channel, parallel to positions
  const faces: number[][] = [];

  const pushColor = (c: THREE.Color) => {
    colors.push(
      Math.round(THREE.MathUtils.clamp(c.r, 0, 1) * 255),
      Math.round(THREE.MathUtils.clamp(c.g, 0, 1) * 255),
      Math.round(THREE.MathUtils.clamp(c.b, 0, 1) * 255),
    );
  };

  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) return;
      const base = positions.length / 3;
      const matColor = (mesh.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1);
      for (let i = 0; i < pos.count; i++) {
        positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        pushColor(matColor);
      }
      const index = mesh.geometry.getIndex();
      if (index) {
        for (let i = 0; i + 2 < index.count; i += 3) {
          faces.push([base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2)]);
        }
      } else {
        for (let i = 0; i + 2 < pos.count; i += 3) faces.push([base + i, base + i + 1, base + i + 2]);
      }
    } else if ((child as THREE.Points).isPoints) {
      const points = child as THREE.Points;
      const pos = points.geometry.getAttribute('position');
      if (!pos) return;
      const colAttr = points.geometry.getAttribute('color');
      const matColor = (points.material as THREE.PointsMaterial).color ?? new THREE.Color(1, 1, 1);
      for (let i = 0; i < pos.count; i++) {
        positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        pushColor(colAttr ? new THREE.Color(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i)) : matColor);
      }
    }
  });

  const vertexCount = positions.length / 3;
  if (!vertexCount) return null;
  const header = 'ply\nformat binary_little_endian 1.0\n'
    + `element vertex ${vertexCount}\n`
    + 'property float x\nproperty float y\nproperty float z\n'
    + 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
    + `element face ${faces.length}\n`
    + 'property list uchar int vertex_indices\n'
    + 'end_header\n';
  const headerBytes = new TextEncoder().encode(header);
  const buffer = new ArrayBuffer(headerBytes.length + vertexCount * 15 + faces.length * 13);
  new Uint8Array(buffer).set(headerBytes);
  const view = new DataView(buffer, headerBytes.length);
  let off = 0;
  for (let i = 0; i < vertexCount; i++) {
    view.setFloat32(off, positions[i * 3], true); off += 4;
    view.setFloat32(off, positions[i * 3 + 1], true); off += 4;
    view.setFloat32(off, positions[i * 3 + 2], true); off += 4;
    view.setUint8(off, colors[i * 3]); off += 1;
    view.setUint8(off, colors[i * 3 + 1]); off += 1;
    view.setUint8(off, colors[i * 3 + 2]); off += 1;
  }
  for (const f of faces) {
    view.setUint8(off, 3); off += 1;
    view.setInt32(off, f[0], true); off += 4;
    view.setInt32(off, f[1], true); off += 4;
    view.setInt32(off, f[2], true); off += 4;
  }
  download(buffer, 'threegrease-scene.ply', 'application/octet-stream');
  return buffer;
}

export async function exportSTL(ctx: AppCtx, opts = DEFAULT_EXPORT3D): Promise<DataView | string> {
  const result = new STLExporter().parse(await buildExportGroup(ctx, opts), { binary: true });
  download(result as unknown as BlobPart, 'threegrease.stl', 'model/stl');
  return result;
}
