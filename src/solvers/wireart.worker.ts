// Multi-view wire art solver (compact take on Hsiao/Huang/Chu, SIGGRAPH
// Asia 2018): voxels inside the visual hull of 2-3 target drawings ->
// greedy coverage of the drawings' pixels -> connect into one path through
// the hull -> smooth. Self-contained (no three.js): minimal mat4 math.

interface ViewIn {
  gray: Float32Array;      // darkness 0..1
  width: number;
  height: number;
  viewProj: Float32Array;  // 16, column-major (three.js convention)
}

export interface WireJob {
  views: ViewIn[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  grid: number;            // voxels per side
  darkThreshold: number;   // pixel counts as target when darkness > this
  coverRadius: number;     // px marked covered around a voxel's projection
  maxVoxels: number;
  smoothIterations: number;
}

function project(vp: Float32Array, x: number, y: number, z: number,
  w: number, h: number): [number, number] | null {
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 1e-9) return null;
  const nx = cx / cw, ny = cy / cw;
  if (nx < -1.2 || nx > 1.2 || ny < -1.2 || ny > 1.2) return null;
  return [(nx * 0.5 + 0.5) * (w - 1), (1 - (ny * 0.5 + 0.5)) * (h - 1)];
}

self.onmessage = (e: MessageEvent) => {
  const job = e.data as WireJob;
  const { views, bounds, grid, darkThreshold, coverRadius, maxVoxels } = job;
  const N = grid;
  const size = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const centers: number[][] = [];          // hull voxel centers (world)
  const proj: Int32Array[] = views.map(() => new Int32Array(0));
  const projTmp: number[][] = views.map(() => []);
  const hullIndex = new Map<number, number>(); // voxel key -> hull idx
  const keyOf = (i: number, j: number, k: number) => (i * N + j) * N + k;

  // 1. visual hull: voxel projects onto dark pixels in EVERY view
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        const x = bounds.min[0] + ((i + 0.5) / N) * size[0];
        const y = bounds.min[1] + ((j + 0.5) / N) * size[1];
        const z = bounds.min[2] + ((k + 0.5) / N) * size[2];
        let ok = true;
        const pixAll: number[] = [];
        for (const v of views) {
          const p = project(v.viewProj, x, y, z, v.width, v.height);
          if (!p) { ok = false; break; }
          const px = Math.round(p[0]), py = Math.round(p[1]);
          if (px < 0 || py < 0 || px >= v.width || py >= v.height
            || v.gray[py * v.width + px] <= darkThreshold) { ok = false; break; }
          pixAll.push(px, py);
        }
        if (ok) {
          hullIndex.set(keyOf(i, j, k), centers.length);
          centers.push([x, y, z, i, j, k]);
          views.forEach((_, vi) => projTmp[vi].push(pixAll[vi * 2], pixAll[vi * 2 + 1]));
        }
      }
    }
  }
  views.forEach((_, vi) => { proj[vi] = Int32Array.from(projTmp[vi]); });
  if (centers.length === 0) {
    (self as unknown as Worker).postMessage({ type: 'done', points: [], hull: 0 });
    return;
  }

  // 2. greedy coverage of target pixels
  const covered = views.map((v) => new Uint8Array(v.width * v.height));
  const targetCount = views.map((v) => {
    let c = 0;
    for (let i = 0; i < v.gray.length; i++) if (v.gray[i] > darkThreshold) c++;
    return Math.max(1, c);
  });
  const gainOf = (idx: number): number => {
    let g = 0;
    for (let vi = 0; vi < views.length; vi++) {
      const v = views[vi];
      const px = proj[vi][idx * 2], py = proj[vi][idx * 2 + 1];
      for (let dy = -coverRadius; dy <= coverRadius; dy++) {
        for (let dx = -coverRadius; dx <= coverRadius; dx++) {
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= v.width || y >= v.height) continue;
          const o = y * v.width + x;
          if (!covered[vi][o] && v.gray[o] > darkThreshold) g++;
        }
      }
    }
    return g;
  };
  const markCovered = (idx: number): void => {
    for (let vi = 0; vi < views.length; vi++) {
      const v = views[vi];
      const px = proj[vi][idx * 2], py = proj[vi][idx * 2 + 1];
      for (let dy = -coverRadius; dy <= coverRadius; dy++) {
        for (let dx = -coverRadius; dx <= coverRadius; dx++) {
          const x = px + dx, y = py + dy;
          if (x >= 0 && y >= 0 && x < v.width && y < v.height) covered[vi][y * v.width + x] = 1;
        }
      }
    }
  };
  const selected: number[] = [];
  for (let n = 0; n < maxVoxels; n++) {
    let best = -1, bestGain = 0;
    for (let idx = 0; idx < centers.length; idx++) {
      const g = gainOf(idx);
      if (g > bestGain) { bestGain = g; best = idx; }
    }
    if (best < 0 || bestGain < 3) break;
    selected.push(best);
    markCovered(best);
    if (n % 20 === 0) (self as unknown as Worker).postMessage({ type: 'progress', done: n });
  }

  // 3. connect: nearest-neighbor chain, BFS through the hull to fill gaps
  const chain: number[] = [];
  const remaining = new Set(selected);
  let cur = selected[0];
  remaining.delete(cur);
  chain.push(cur);
  while (remaining.size) {
    let nearest = -1, nd = Infinity;
    for (const cand of remaining) {
      const a = centers[cur], b = centers[cand];
      const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d < nd) { nd = d; nearest = cand; }
    }
    remaining.delete(nearest);
    chain.push(nearest);
    cur = nearest;
  }
  const bfsPath = (a: number, b: number): number[] => {
    // BFS over 26-connected hull voxels from a to b (returns intermediate)
    const start = keyOf(centers[a][3], centers[a][4], centers[a][5]);
    const goal = keyOf(centers[b][3], centers[b][4], centers[b][5]);
    if (start === goal) return [];
    const prev = new Map<number, number>([[start, -1]]);
    let frontier = [start];
    for (let depth = 0; depth < 64 && frontier.length; depth++) {
      const next: number[] = [];
      for (const key of frontier) {
        const i = Math.floor(key / (N * N)), j = Math.floor(key / N) % N, k = key % N;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
          if (!di && !dj && !dk) continue;
          const ni = i + di, nj = j + dj, nk = k + dk;
          if (ni < 0 || nj < 0 || nk < 0 || ni >= N || nj >= N || nk >= N) continue;
          const nkey = keyOf(ni, nj, nk);
          if (prev.has(nkey) || !hullIndex.has(nkey)) continue;
          prev.set(nkey, key);
          if (nkey === goal) {
            const path: number[] = [];
            let c: number = key;
            while (c !== -1 && c !== start) { path.unshift(hullIndex.get(c)!); c = prev.get(c)!; }
            return path;
          }
          next.push(nkey);
        }
      }
      frontier = next;
    }
    return []; // no path: straight segment fallback
  };
  const full: number[] = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    full.push(...bfsPath(chain[i - 1], chain[i]), chain[i]);
  }

  // 4. light smoothing (keep hull-ish shape, relax staircase)
  const pts = full.map((idx) => centers[idx].slice(0, 3) as [number, number, number]);
  for (let it = 0; it < job.smoothIterations; it++) {
    for (let i = 1; i < pts.length - 1; i++) {
      for (let a = 0; a < 3; a++) {
        pts[i][a] = pts[i][a] * 0.6 + (pts[i - 1][a] + pts[i + 1][a]) * 0.2;
      }
    }
  }

  (self as unknown as Worker).postMessage({
    type: 'done', points: pts, hull: centers.length, selected: selected.length,
  });
};
