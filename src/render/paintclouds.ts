// Painted gaussian-splat clouds (3DGS painting): derived render state for
// scene.paintClouds. Same soft-gaussian point-sprite look as the MMStream
// renderer (src/mm/points.ts) but with PER-POINT radius, color, and alpha
// baked as attributes — a splat look without the full 3DGS pipeline.
// Geometry rebuilds only when a cloud's `rev` changes.
import * as THREE from 'three';
import type { GPScene, TGPaintCloud } from '../core/types';
import { worldMatrixOf } from '../tools/objects';

const VERT = /* glsl */`
  attribute float aSize;      // world-space splat radius
  attribute vec3 aColor;
  attribute float aAlpha;
  uniform float uViewportH;   // drawing-buffer height in px
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // projectionMatrix[1][1]/w works for both persp and ortho cameras
    gl_PointSize = aSize * uViewportH * projectionMatrix[1][1] / (2.0 * gl_Position.w);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv) * 4.0;              // 0 center -> 1 at sprite edge
    float a = exp(-r2 * 2.5) * (1.0 - smoothstep(0.8, 1.0, r2)) * vAlpha;
    if (a < 0.012) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export const PAINT_STRIDE = 8; // x,y,z, radius, r,g,b, a

interface Entry {
  points: THREE.Points;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  rev: number;
}

export class PaintCloudManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, Entry>();

  sync(scene: GPScene, viewportH: number): void {
    for (const [id, e] of this.entries) {
      if (!scene.paintClouds.some((c) => c.id === id)) {
        this.group.remove(e.points);
        e.geo.dispose();
        e.mat.dispose();
        this.entries.delete(id);
      }
    }
    for (const pc of scene.paintClouds) {
      let e = this.entries.get(pc.id);
      if (!e) {
        const geo = new THREE.BufferGeometry();
        const mat = new THREE.ShaderMaterial({
          vertexShader: VERT, fragmentShader: FRAG,
          uniforms: { uViewportH: { value: viewportH } },
          transparent: true, depthWrite: false,
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        points.userData.pcloudId = pc.id;
        points.raycast = () => {}; // never intercepts surface raycasts
        this.group.add(points);
        e = { points, geo, mat, rev: -1 };
        this.entries.set(pc.id, e);
      }
      e.mat.uniforms.uViewportH.value = viewportH;
      if (e.rev !== pc.rev) {
        this.rebuild(e, pc);
        e.rev = pc.rev;
      }
      e.points.matrixAutoUpdate = false;
      e.points.matrix.copy(worldMatrixOf(scene, { kind: 'PCLOUD', id: pc.id }));
      e.points.visible = pc.visible && pc.points.length > 0;
    }
  }

  private rebuild(e: Entry, pc: TGPaintCloud): void {
    const n = pc.points.length / PAINT_STRIDE;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * PAINT_STRIDE;
      pos[i * 3] = pc.points[o];
      pos[i * 3 + 1] = pc.points[o + 1];
      pos[i * 3 + 2] = pc.points[o + 2];
      size[i] = pc.points[o + 3];
      col[i * 3] = pc.points[o + 4];
      col[i * 3 + 1] = pc.points[o + 5];
      col[i * 3 + 2] = pc.points[o + 6];
      alpha[i] = pc.points[o + 7];
    }
    e.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    e.geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    e.geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    e.geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    e.geo.setDrawRange(0, n);
  }
}

export function createPaintCloud(id: number, name: string, at: [number, number, number]): TGPaintCloud {
  return {
    id, name, points: [], rev: 0,
    translation: [...at], rotation: [0, 0, 0], scale: [1, 1, 1],
    visible: true, select: false, lock: false, parent: null, constraints: [],
  };
}
