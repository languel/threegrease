// Renders MMStream landmark frames as soft gaussian point sprites (a splat
// look without the full 3DGS pipeline): one THREE.Points per stream, packed
// position + confidence attributes updated in place every time StreamStore's
// version bumps — no scene rebuild, cheap enough for per-frame live data.
// Confidence is EMBEDDED per point and modulates sprite alpha and/or size
// (stream config). Same manager lifecycle pattern as MeshManager.
import * as THREE from 'three';
import type { GPScene } from '../core/types';
import { streamStore, streamWorldMatrix } from './streams';

const VERT = /* glsl */`
  attribute float aConf;
  uniform float uSize;        // world-space splat radius
  uniform float uViewportH;   // drawing-buffer height in px
  uniform float uConfSize;    // 1 = confidence scales the sprite
  varying float vConf;
  void main() {
    vConf = aConf;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float sizeMod = mix(1.0, clamp(aConf, 0.05, 1.0), uConfSize);
    // projectionMatrix[1][1]/w works for both persp and ortho cameras
    gl_PointSize = uSize * sizeMod * uViewportH * projectionMatrix[1][1] / (2.0 * gl_Position.w);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uConfAlpha;   // 1 = confidence scales opacity
  varying float vConf;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv) * 4.0;              // 0 center -> 1 at sprite edge
    float a = exp(-r2 * 2.5) * (1.0 - smoothstep(0.8, 1.0, r2));
    a *= mix(1.0, clamp(vConf, 0.0, 1.0), uConfAlpha);
    if (a < 0.012) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface Entry {
  points: THREE.Points;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  capacity: number;
  version: number;
}

export class StreamPointsManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, Entry>();

  /** Call once per frame; viewportH = renderer drawing-buffer height. */
  sync(scene: GPScene, viewportH: number): void {
    for (const [id, e] of this.entries) {
      if (!scene.mmStreams.some((s) => s.id === id)) {
        this.group.remove(e.points);
        e.geo.dispose(); e.mat.dispose();
        this.entries.delete(id);
      }
    }
    for (const st of scene.mmStreams) {
      let e = this.entries.get(st.id);
      if (!e) {
        const geo = new THREE.BufferGeometry();
        const capacity = 64;
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
        geo.setAttribute('aConf', new THREE.BufferAttribute(new Float32Array(capacity), 1));
        geo.setDrawRange(0, 0);
        const mat = new THREE.ShaderMaterial({
          vertexShader: VERT, fragmentShader: FRAG,
          uniforms: {
            uSize: { value: st.pointSize },
            uViewportH: { value: viewportH },
            uColor: { value: new THREE.Color(...st.color) },
            uConfAlpha: { value: st.confidenceAlpha ? 1 : 0 },
            uConfSize: { value: st.confidenceSize ? 1 : 0 },
          },
          transparent: true, depthWrite: false,
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false; // buffers update in place; skip bounds upkeep
        points.matrixAutoUpdate = false;
        points.userData.streamId = st.id;
        this.group.add(points);
        e = { points, geo, mat, capacity, version: -1 };
        this.entries.set(st.id, e);
      }
      // config -> uniforms/transform every frame (cheap)
      e.mat.uniforms.uSize.value = st.pointSize;
      e.mat.uniforms.uViewportH.value = viewportH;
      (e.mat.uniforms.uColor.value as THREE.Color).setRGB(...st.color);
      e.mat.uniforms.uConfAlpha.value = st.confidenceAlpha ? 1 : 0;
      e.mat.uniforms.uConfSize.value = st.confidenceSize ? 1 : 0;
      e.points.matrix.copy(streamWorldMatrix(scene, st));
      const frame = streamStore.get(st.id);
      e.points.visible = st.visible && !!frame && frame.count > 0;
      // frame data -> attributes only when the store version moved
      const ver = streamStore.version.get(st.id) ?? -1;
      if (!frame || ver === e.version) continue;
      e.version = ver;
      if (frame.count > e.capacity) {
        e.capacity = Math.ceil(frame.count * 1.5);
        e.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(e.capacity * 3), 3));
        e.geo.setAttribute('aConf', new THREE.BufferAttribute(new Float32Array(e.capacity), 1));
      }
      const pos = e.geo.getAttribute('position') as THREE.BufferAttribute;
      const conf = e.geo.getAttribute('aConf') as THREE.BufferAttribute;
      const bb = (e.geo.boundingBox ??= new THREE.Box3());
      bb.makeEmpty();
      for (let i = 0; i < frame.count; i++) {
        // mirror is baked into streamWorldMatrix, not the buffer
        pos.setXYZ(i, frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2]);
        conf.setX(i, frame.data[i * 4 + 3]);
        bb.expandByPoint(new THREE.Vector3(frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2]));
      }
      pos.needsUpdate = true;
      conf.needsUpdate = true;
      // keep bounds honest over drawRange only (stale capacity would inflate
      // them) — selection glyphs Box3.setFromObject() this geometry
      e.geo.setDrawRange(0, frame.count);
    }
  }

  /** three.js object for a stream id (selection glyphs / picking roots). */
  objectFor(id: number): THREE.Points | null {
    return this.entries.get(id)?.points ?? null;
  }

  dispose(): void {
    for (const e of this.entries.values()) { e.geo.dispose(); e.mat.dispose(); }
    this.entries.clear();
    this.group.clear();
  }
}
