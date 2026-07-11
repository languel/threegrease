// 3D exporters (P8): strokes as tubes (fabrication-friendly), fills as
// meshes. Exports what you SEE: modifier-evaluated strokes of the current
// frame, per visible layer.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type { AppCtx } from '../tools/context';
import { frameAt } from '../core/gpdata';
import { evaluateModifiers, remapTime } from '../modifiers/index';
import { buildFillGeometry } from '../render/geometry';

export interface Export3DOptions {
  pxToWorld: number;        // width conversion for VIEW-unit strokes
  radialSegments: number;
  minRadius: number;
  selectedOnly: boolean;
}

export const DEFAULT_EXPORT3D: Export3DOptions = {
  pxToWorld: 0.005, radialSegments: 6, minRadius: 0.002, selectedOnly: false,
};

/** Build a plain-geometry group mirroring the visible drawing. */
export function buildExportGroup(ctx: AppCtx, opts: Export3DOptions): THREE.Group {
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
  const group = buildExportGroup(ctx, opts);
  const buffer = await new GLTFExporter().parseAsync(group, { binary: true }) as ArrayBuffer;
  download(buffer, 'threegrease.glb', 'model/gltf-binary');
  return buffer;
}

export function exportOBJ(ctx: AppCtx, opts = DEFAULT_EXPORT3D): string {
  const text = new OBJExporter().parse(buildExportGroup(ctx, opts));
  download(text, 'threegrease.obj', 'text/plain');
  return text;
}

export function exportSTL(ctx: AppCtx, opts = DEFAULT_EXPORT3D): DataView | string {
  const result = new STLExporter().parse(buildExportGroup(ctx, opts), { binary: true });
  download(result as unknown as BlobPart, 'threegrease.stl', 'model/stl');
  return result;
}
