// Score engine (P3, the IanniX layer): cursors ride strokes on their own
// clocks and stream events; triggers fire on entry; attachments drive scene
// objects along paths. Runs every frame from App.loop — keep it light.
import * as THREE from 'three';
import type {
  GPScene, GPStroke, LoopMode, MsgTemplate, PathRef, TGCursor, Vec3,
} from '../core/types';
import { activeCam, frameAt } from '../core/gpdata';
import { bus } from '../events/bus';

interface ArcTable {
  key: string;
  world: THREE.Vector3[];   // points in world space
  cum: number[];            // cumulative lengths
  total: number;
  cyclic: boolean;
}

export interface CursorState {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  valid: boolean;
}

function fillTemplate(tpl: string, vars: Record<string, number | string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? 0));
}

function fireMessages(
  source: string, messages: MsgTemplate[], vars: Record<string, number | string>,
): void {
  for (const m of messages) {
    const address = fillTemplate(m.address, vars);
    const args = m.argExprs.map((e) => {
      const s = fillTemplate(e, vars);
      const n = Number(s);
      return Number.isFinite(n) && s.trim() !== '' ? n : s;
    });
    bus.send(source, address, ...args);
  }
}

/** Advance a phase by dt under a loop mode; returns [phase, stillRunning]. */
export function advancePhase(
  phase: number, speed: number, dt: number, loop: LoopMode,
): [number, boolean] {
  let p = phase + speed * dt;
  if (loop === 'LOOP') {
    p = ((p % 1) + 1) % 1;
    return [p, true];
  }
  if (loop === 'PINGPONG') {
    // fold into [0,2): 0..1 forward, 1..2 mirrored
    const f = ((p % 2) + 2) % 2;
    return [f, true]; // sampling maps >1 to 2-f
  }
  if (p >= 1) return [1, false];
  if (p <= 0 && speed < 0) return [0, false];
  return [p, true];
}

/** Map a possibly-pingpong phase to 0..1 sample position. */
export function samplePhase(phase: number, loop: LoopMode): number {
  if (loop === 'PINGPONG') return phase <= 1 ? phase : 2 - phase;
  return Math.max(0, Math.min(1, phase));
}

export class ScoreEngine {
  private arcs = new Map<number, ArcTable>();       // strokeId -> table
  private lastEmit = new Map<number, number>();     // cursorId -> time
  private triggerInside = new Map<string, boolean>(); // `${trigId}:${curId}`
  private triggerFired = new Set<string>();
  /** live cursor states for rendering (id -> state) */
  readonly states = new Map<number, CursorState>();

  /** Call when stroke data may have changed (piggybacks on markDirty). */
  invalidate(): void { this.arcs.clear(); }

  resetTriggers(): void { this.triggerInside.clear(); this.triggerFired.clear(); }

  private resolveStroke(scene: GPScene, ref: PathRef): { stroke: GPStroke; matrix: THREE.Matrix4 } | null {
    const ob = scene.objects[ref.objectIndex];
    if (!ob) return null;
    const layer = ob.layers.find((l) => l.id === ref.layerId);
    if (!layer) return null;
    const frame = frameAt(layer, scene.frame);
    if (!frame) return null;
    const stroke = frame.strokes.find((s) => s.id === ref.strokeId);
    if (!stroke || stroke.points.length < 2) return null;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...ob.translation),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ob.rotation)),
      new THREE.Vector3(...ob.scale),
    );
    return { stroke, matrix };
  }

  private arcTable(scene: GPScene, ref: PathRef): ArcTable | null {
    const resolved = this.resolveStroke(scene, ref);
    if (!resolved) return null;
    const { stroke, matrix } = resolved;
    const key = `${stroke.points.length}:${stroke.cyclic}`;
    const cached = this.arcs.get(ref.strokeId);
    if (cached && cached.key === key) return cached;
    const world = stroke.points.map((p) =>
      new THREE.Vector3(p.co[0], p.co[1], p.co[2]).applyMatrix4(matrix));
    if (stroke.cyclic) world.push(world[0].clone());
    const cum = [0];
    for (let i = 1; i < world.length; i++) {
      cum.push(cum[i - 1] + world[i].distanceTo(world[i - 1]));
    }
    const table: ArcTable = {
      key, world, cum, total: cum[cum.length - 1] || 1e-9, cyclic: stroke.cyclic,
    };
    this.arcs.set(ref.strokeId, table);
    return table;
  }

  /** Sample world position + tangent at t in [0,1]. */
  sample(scene: GPScene, ref: PathRef, t: number, out: CursorState): boolean {
    const arc = this.arcTable(scene, ref);
    if (!arc) { out.valid = false; return false; }
    const target = t * arc.total;
    let i = 1;
    while (i < arc.cum.length - 1 && arc.cum[i] < target) i++;
    const span = Math.max(1e-9, arc.cum[i] - arc.cum[i - 1]);
    const k = Math.max(0, Math.min(1, (target - arc.cum[i - 1]) / span));
    out.position.copy(arc.world[i - 1]).lerp(arc.world[i], k);
    out.tangent.copy(arc.world[i]).sub(arc.world[i - 1]).normalize();
    out.valid = true;
    return true;
  }

  update(scene: GPScene, dt: number, now: number): void {
    const score = scene.score;
    if (!score) return;

    // --- cursors ---
    for (const cur of score.cursors) {
      let state = this.states.get(cur.id);
      if (!state) {
        state = { position: new THREE.Vector3(), tangent: new THREE.Vector3(1, 0, 0), valid: false };
        this.states.set(cur.id, state);
      }
      if (cur.running) {
        const [p, running] = advancePhase(cur.phase, cur.speed, dt, cur.loop);
        cur.phase = p;
        if (!running) cur.running = false;
      }
      const ok = this.sample(scene, cur.path, samplePhase(cur.phase, cur.loop), state);
      if (!ok) continue;
      if (cur.running) {
        const last = this.lastEmit.get(cur.id) ?? 0;
        if (now - last >= 1000 / Math.max(1, cur.rate)) {
          this.lastEmit.set(cur.id, now);
          fireMessages(`cursor:${cur.id}`, cur.messages, {
            id: cur.id, name: cur.name,
            x: +state.position.x.toFixed(4),
            y: +state.position.y.toFixed(4),
            z: +state.position.z.toFixed(4),
            t: +samplePhase(cur.phase, cur.loop).toFixed(4),
          });
        }
      }
      // --- triggers vs this cursor ---
      for (const trig of score.triggers) {
        const key = `${trig.id}:${cur.id}`;
        const inside = state.position.distanceTo(new THREE.Vector3(...trig.position)) < trig.radius;
        const wasInside = this.triggerInside.get(key) ?? false;
        if (inside && !wasInside && cur.running) {
          const allowed = trig.retrigger || !this.triggerFired.has(key);
          if (allowed) {
            this.triggerFired.add(key);
            fireMessages(`trigger:${trig.id}`, trig.messages, {
              id: trig.id, name: trig.name, cursor: cur.id,
              x: trig.position[0], y: trig.position[1], z: trig.position[2],
              t: +samplePhase(cur.phase, cur.loop).toFixed(4),
            });
          }
        }
        this.triggerInside.set(key, inside);
      }
    }

    // --- attachments drive objects ---
    const tmp: CursorState = {
      position: new THREE.Vector3(), tangent: new THREE.Vector3(), valid: false,
    };
    for (const at of score.attachments) {
      if (at.running) {
        const [p, running] = advancePhase(at.phase, at.speed, dt, at.loop);
        at.phase = p;
        if (!running) at.running = false;
      }
      if (!this.sample(scene, at.path, samplePhase(at.phase, at.loop), tmp)) continue;
      const pos: Vec3 = [
        tmp.position.x + at.offset[0],
        tmp.position.y + at.offset[1],
        tmp.position.z + at.offset[2],
      ];
      let rotation: Vec3 | null = null;
      if (at.orient === 'TANGENT') {
        const m = new THREE.Matrix4().lookAt(
          new THREE.Vector3(), tmp.tangent.clone().negate(), new THREE.Vector3(0, 0, 1));
        const e = new THREE.Euler().setFromRotationMatrix(m);
        rotation = [e.x, e.y, e.z];
      }
      if (at.target.kind === 'CANVAS') {
        const canvas = scene.canvases.find((c) => c.id === at.target.id);
        if (canvas) {
          canvas.translation = pos;
          if (rotation) canvas.rotation = rotation;
        }
      } else if (at.target.kind === 'CAMERA') {
        const cam = scene.cameras[at.target.id] ?? activeCam(scene);
        if (cam) {
          cam.translation = pos;
          if (rotation) cam.rotation = rotation;
        }
      }
    }
  }

  hasWork(scene: GPScene): boolean {
    const sc = scene.score;
    return !!sc && (sc.cursors.length > 0 || sc.attachments.length > 0);
  }
}

let nextScoreId = 1;
export function scoreId(scene: GPScene): number {
  const sc = scene.score;
  for (const c of sc.cursors) nextScoreId = Math.max(nextScoreId, c.id + 1);
  for (const t of sc.triggers) nextScoreId = Math.max(nextScoreId, t.id + 1);
  for (const a of sc.attachments) nextScoreId = Math.max(nextScoreId, a.id + 1);
  return nextScoreId++;
}

export function defaultCursor(scene: GPScene, path: PathRef): TGCursor {
  const id = scoreId(scene);
  return {
    id, name: `Cursor ${id}`, path, speed: 0.2, phase: 0, loop: 'LOOP',
    running: true, rate: 30,
    messages: [{ address: '/cursor/{id}/pos', argExprs: ['{x}', '{y}', '{z}', '{t}'] }],
    color: [1, 0.6, 0.15],
  };
}
