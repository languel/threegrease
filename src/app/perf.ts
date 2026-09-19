// Frame profiler and the perf overlay.
//
// The frame loop marks LAPS between its phases (`perf.lap('render')`), so a
// slow frame says WHERE it went rather than just that it was slow. Two
// clocks are kept apart on purpose:
//   - loop: CPU time spent inside App.loop, summed from the laps;
//   - frame: the rAF-to-rAF interval, i.e. what you actually get.
// When `frame` is far above `loop`, the time is going somewhere the loop
// cannot see — the GPU, a UI rebuild in an event handler, layout, a long
// task — and the overlay says so rather than letting the laps look innocent.
//
// Everything is windowed: sums, counts and maxima over the last second,
// swapped into a published snapshot once a second, so the numbers hold
// still long enough to read and cost nothing to display.
import type * as THREE from 'three';

interface Acc { sum: number; max: number; n: number }

export interface PerfSnapshot {
  fps: number;
  frameMs: number; frameMax: number;
  loopMs: number; loopMax: number;
  laps: { name: string; ms: number; max: number }[];
  counters: { name: string; perSec: number }[];
  calls: number; triangles: number; points: number; lines: number;
  geometries: number; textures: number; programs: number;
  heapMB: number | null;
  longTasks: number; longTaskMs: number;
}

class Perf {
  enabled = false;
  private frameT = 0;
  private lapT = 0;
  private window: { start: number; frames: number; frame: Acc; loop: Acc; laps: Map<string, Acc>; counters: Map<string, number>; longTasks: number; longTaskMs: number } = this.fresh(0);
  snapshot: PerfSnapshot | null = null;
  /** recent frame intervals, ms, for the graph */
  readonly history: number[] = [];
  private renderer: THREE.WebGLRenderer | null = null;
  private gpu = { calls: 0, triangles: 0, points: 0, lines: 0 };
  private observer: PerformanceObserver | null = null;

  private fresh(start: number) {
    return { start, frames: 0, frame: { sum: 0, max: 0, n: 0 }, loop: { sum: 0, max: 0, n: 0 }, laps: new Map<string, Acc>(), counters: new Map<string, number>(), longTasks: 0, longTaskMs: 0 };
  }

  attach(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    // several renders per frame (post, outline, thumbnails, quad panes):
    // count them all, not just the last one three would otherwise keep
    renderer.info.autoReset = false;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { this.window.longTasks++; this.window.longTaskMs += e.duration; }
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch { /* longtask timing is Chromium-only */ }
  }

  /** Start of App.loop. */
  frameStart(now: number): void {
    if (this.frameT) {
      const dt = now - this.frameT;
      add(this.window.frame, dt);
      this.history.push(dt);
      if (this.history.length > 180) this.history.shift();
    }
    this.frameT = now;
    this.lapT = now;
    this.window.frames++;
    if (this.renderer) {
      const r = this.renderer.info.render;
      this.gpu = { calls: r.calls, triangles: r.triangles, points: r.points, lines: r.lines };
      this.renderer.info.reset();
    }
    if (now - this.window.start >= 1000) this.publish(now);
  }

  /** Time since the previous lap goes to `name`. Cheap enough to leave in. */
  lap(name: string): void {
    const t = performance.now();
    let a = this.window.laps.get(name);
    if (!a) { a = { sum: 0, max: 0, n: 0 }; this.window.laps.set(name, a); }
    add(a, t - this.lapT);
    this.lapT = t;
  }

  /** End of App.loop. */
  frameEnd(): void { add(this.window.loop, performance.now() - this.frameT); }

  /** Count an event (a UI rebuild, a GP rebuild...) per second. */
  count(name: string, n = 1): void {
    this.window.counters.set(name, (this.window.counters.get(name) ?? 0) + n);
  }

  private publish(now: number): void {
    const w = this.window;
    const secs = Math.max(0.001, (now - w.start) / 1000);
    const avg = (a: Acc) => (a.n ? a.sum / a.n : 0);
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const info = this.renderer?.info;
    this.snapshot = {
      fps: w.frames / secs,
      frameMs: avg(w.frame), frameMax: w.frame.max,
      loopMs: avg(w.loop), loopMax: w.loop.max,
      // per-FRAME averages, so the laps add up to the loop time
      laps: [...w.laps].map(([name, a]) => ({ name, ms: a.sum / Math.max(1, w.frames), max: a.max }))
        .sort((x, y) => y.ms - x.ms),
      counters: [...w.counters].map(([name, n]) => ({ name, perSec: n / secs })).sort((x, y) => y.perSec - x.perSec),
      ...this.gpu,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
      programs: info?.programs?.length ?? 0,
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
      longTasks: w.longTasks, longTaskMs: w.longTaskMs,
    };
    this.window = this.fresh(now);
  }
}

function add(a: Acc, v: number): void {
  a.sum += v; a.n++;
  if (v > a.max) a.max = v;
}

export const perf = new Perf();

/**
 * The overlay: plain DOM over the viewport's top-left, rewritten a few times
 * a second (never per frame — the overlay must not be what it measures),
 * with a frame-time graph against the 16.7 / 33 ms lines.
 */
export class PerfOverlay {
  readonly el: HTMLDivElement;
  private text: HTMLPreElement;
  private graph: HTMLCanvasElement;
  private last = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'perf-overlay';
    this.graph = document.createElement('canvas');
    this.graph.width = 180; this.graph.height = 40;
    this.text = document.createElement('pre');
    this.el.append(this.graph, this.text);
    this.el.hidden = true;
    parent.append(this.el);
  }

  update(now: number): void {
    this.el.hidden = !perf.enabled;
    if (!perf.enabled || now - this.last < 250) return;
    this.last = now;
    this.drawGraph();
    const s = perf.snapshot;
    if (!s) { this.text.textContent = 'measuring…'; return; }
    const f = (v: number, d = 1) => v.toFixed(d);
    const lines: string[] = [];
    lines.push(`${f(s.fps, 0)} fps   frame ${f(s.frameMs)} ms (max ${f(s.frameMax, 0)})`);
    lines.push(`loop ${f(s.loopMs)} ms (max ${f(s.loopMax, 0)})`);
    // the gap between the two clocks is time the loop never saw
    const outside = s.frameMs - s.loopMs;
    if (s.fps < 50 && outside > 8) {
      lines.push(`⚠ ${f(outside)} ms/frame OUTSIDE the loop — GPU, events or layout`);
    }
    if (s.longTasks) lines.push(`long tasks ${s.longTasks}/s (${f(s.longTaskMs, 0)} ms)`);
    lines.push('');
    for (const l of s.laps.slice(0, 9)) {
      if (l.ms < 0.05 && l.max < 1) continue;
      lines.push(`${l.name.padEnd(12)} ${f(l.ms, 2).padStart(6)}  max ${f(l.max, 1)}`);
    }
    lines.push('');
    lines.push(`draws ${s.calls}  tris ${fmtK(s.triangles)}  pts ${fmtK(s.points)}`);
    lines.push(`geo ${s.geometries}  tex ${s.textures}  prog ${s.programs}`);
    if (s.heapMB !== null) lines.push(`heap ${f(s.heapMB, 0)} MB`);
    for (const c of s.counters.slice(0, 4)) lines.push(`${c.name} ${f(c.perSec, 1)}/s`);
    this.text.textContent = lines.join('\n');
  }

  private drawGraph(): void {
    const g = this.graph.getContext('2d')!;
    const w = this.graph.width, h = this.graph.height;
    g.clearRect(0, 0, w, h);
    const scale = h / 50; // 50 ms full height
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    for (const ms of [16.7, 33.3]) {
      g.beginPath(); g.moveTo(0, h - ms * scale); g.lineTo(w, h - ms * scale); g.stroke();
    }
    const hist = perf.history;
    const n = Math.min(hist.length, w);
    for (let i = 0; i < n; i++) {
      const v = hist[hist.length - n + i];
      g.fillStyle = v > 33.3 ? '#ff5a4f' : v > 17.5 ? '#f0b43c' : '#58d68d';
      const bh = Math.min(h, v * scale);
      g.fillRect(w - n + i, h - bh, 1, bh);
    }
  }
}

function fmtK(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
}
