// Dynamic string simulation: strokes on the "StringArt" layer (or any layer
// named in `layerName`) become verlet chains pinned at both ends; attractors
// pull/push points within their radius. Steps run from the App loop while
// enabled — NO undo pushes, this is live performance material.
import type { GPScene, GPStroke } from '../core/types';
import { activeObject, frameAt } from '../core/gpdata';

interface ChainState {
  prev: Float32Array;    // previous positions (verlet)
  rest: Float32Array;    // rest lengths between neighbors
  home: Float32Array;    // original positions (for stiffness pull-back)
}

export class StringSim {
  layerName = 'StringArt';
  damping = 0.96;
  iterations = 2;
  stiffness = 0.02;      // pull back toward home shape
  enabled = false;
  private states = new Map<number, ChainState>();

  reset(): void { this.states.clear(); }

  private stateFor(s: GPStroke): ChainState {
    let st = this.states.get(s.id);
    if (st && st.prev.length === s.points.length * 3) return st;
    const n = s.points.length;
    const prev = new Float32Array(n * 3);
    const home = new Float32Array(n * 3);
    const rest = new Float32Array(Math.max(0, n - 1));
    for (let i = 0; i < n; i++) {
      const c = s.points[i].co;
      prev[i * 3] = c[0]; prev[i * 3 + 1] = c[1]; prev[i * 3 + 2] = c[2];
      home[i * 3] = c[0]; home[i * 3 + 1] = c[1]; home[i * 3 + 2] = c[2];
    }
    for (let i = 0; i < n - 1; i++) {
      const a = s.points[i].co, b = s.points[i + 1].co;
      rest[i] = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    st = { prev, rest, home };
    this.states.set(s.id, st);
    return st;
  }

  /** Returns true if anything moved (caller marks dirty). */
  step(scene: GPScene, dt: number): boolean {
    if (!this.enabled) return false;
    const ob = activeObject(scene);
    const layer = ob.layers.find((l) => l.name === this.layerName);
    if (!layer) return false;
    const frame = frameAt(layer, scene.frame);
    if (!frame) return false;
    const attractors = scene.attractors;
    const dt2 = Math.min(dt, 0.033) ** 2;
    let moved = false;

    for (const s of frame.strokes) {
      const n = s.points.length;
      if (n < 3) continue;
      const st = this.stateFor(s);
      // integrate interior points (endpoints pinned)
      for (let i = 1; i < n - 1; i++) {
        const p = s.points[i].co;
        const px = p[0], py = p[1], pz = p[2];
        let ax = (st.home[i * 3] - px) * this.stiffness;
        let ay = (st.home[i * 3 + 1] - py) * this.stiffness;
        let az = (st.home[i * 3 + 2] - pz) * this.stiffness;
        for (const at of attractors) {
          const dx = at.position[0] - px, dy = at.position[1] - py, dz = at.position[2] - pz;
          const d = Math.hypot(dx, dy, dz);
          if (d > at.radius || d < 1e-6) continue;
          const f = at.strength * (1 - d / at.radius) / d;
          ax += dx * f; ay += dy * f; az += dz * f;
        }
        const vx = (px - st.prev[i * 3]) * this.damping;
        const vy = (py - st.prev[i * 3 + 1]) * this.damping;
        const vz = (pz - st.prev[i * 3 + 2]) * this.damping;
        st.prev[i * 3] = px; st.prev[i * 3 + 1] = py; st.prev[i * 3 + 2] = pz;
        p[0] = px + vx + ax * dt2 * 60;
        p[1] = py + vy + ay * dt2 * 60;
        p[2] = pz + vz + az * dt2 * 60;
        moved = true;
      }
      // satisfy segment rest lengths
      for (let it = 0; it < this.iterations; it++) {
        for (let i = 0; i < n - 1; i++) {
          const a = s.points[i].co, b = s.points[i + 1].co;
          const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
          const d = Math.hypot(dx, dy, dz) || 1e-9;
          const diff = (d - st.rest[i]) / d * 0.5;
          const aPinned = i === 0, bPinned = i + 1 === n - 1;
          const aw = aPinned ? 0 : (bPinned ? 1 : 0.5);
          const bw = bPinned ? 0 : (aPinned ? 1 : 0.5);
          a[0] += dx * diff * aw * 2; a[1] += dy * diff * aw * 2; a[2] += dz * diff * aw * 2;
          b[0] -= dx * diff * bw * 2; b[1] -= dy * diff * bw * 2; b[2] -= dz * diff * bw * 2;
        }
      }
    }
    return moved;
  }
}
