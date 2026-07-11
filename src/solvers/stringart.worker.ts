// Greedy string-art solver (after Demoussel/Larboulette/Dattatreya,
// Bridges 2022): pick the chord from the current pin that removes the most
// residual darkness from the target; subtract; repeat. Self-contained worker.

export interface StringArtJob {
  pins: [number, number][];   // pin positions in image pixel coords
  width: number;
  height: number;
  gray: Float32Array;         // residual darkness 0..1 per pixel (row-major)
  opacity: number;            // darkness removed per string pass (e.g. 0.25)
  maxChords: number;
  minGain: number;            // stop when best chord gain < this
  minPinSeparation: number;   // skip near-neighbor pins (index distance)
}

export interface StringArtProgress {
  type: 'progress' | 'done' | 'cancelled';
  chords: number[];           // pin index sequence (first = start pin)
  done: number;
}

let cancelled = false;

self.onmessage = (e: MessageEvent) => {
  if (e.data === 'cancel') { cancelled = true; return; }
  cancelled = false;
  const job = e.data as StringArtJob;
  solve(job);
};

function solve(job: StringArtJob): void {
  const { pins, width, gray, opacity, maxChords, minGain, minPinSeparation } = job;
  const n = pins.length;
  const chords: number[] = [0];
  let current = 0;

  const lineGain = (a: number, b: number): number => {
    const [ax, ay] = pins[a], [bx, by] = pins[b];
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay)));
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(ax + (bx - ax) * t);
      const y = Math.round(ay + (by - ay) * t);
      sum += Math.max(0, gray[y * width + x]);
    }
    return sum / (steps + 1); // mean residual darkness along the chord
  };

  const subtract = (a: number, b: number): void => {
    const [ax, ay] = pins[a], [bx, by] = pins[b];
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(ax + (bx - ax) * t);
      const y = Math.round(ay + (by - ay) * t);
      gray[y * width + x] -= opacity;
    }
  };

  for (let c = 0; c < maxChords; c++) {
    if (cancelled) {
      (self as unknown as Worker).postMessage({ type: 'cancelled', chords, done: c });
      return;
    }
    let best = -1;
    let bestGain = -Infinity;
    for (let cand = 0; cand < n; cand++) {
      const sep = Math.min(
        Math.abs(cand - current), n - Math.abs(cand - current));
      if (sep < minPinSeparation) continue;
      const g = lineGain(current, cand);
      if (g > bestGain) { bestGain = g; best = cand; }
    }
    if (best < 0 || bestGain < minGain) break;
    subtract(current, best);
    chords.push(best);
    current = best;
    if (c % 100 === 0) {
      (self as unknown as Worker).postMessage({ type: 'progress', chords: [], done: c });
    }
  }
  (self as unknown as Worker).postMessage({ type: 'done', chords, done: chords.length - 1 });
}
