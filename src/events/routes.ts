// Property routing (P4, after languel/routional): bind incoming bus events
// to scene/settings properties through a WHITELISTED resolver — target paths
// are parsed against an explicit table, never walked arbitrarily.
import type { AppCtx } from '../tools/context';
import type { TGRoute } from '../core/types';
import { activeObject } from '../core/gpdata';
import { bus, addressMatches, type TGEvent } from './bus';
import { actorSolver } from '../actor/solver';

interface ResolvedTarget {
  set(v: number): void;
  /** what to refresh after a write */
  dirty: 'render' | 'canvas' | 'none';
}

/**
 * Whitelist:
 *   brush.size|strength|hardness            brush.style.<numeric field>
 *   layer.<id>.opacity|thicknessOffset      object.opacity? (no)
 *   modifier.<id>.<numeric param>           effect.<id>.<numeric param>
 *   cursor.<id>.speed|phase|rate            trigger.<id>.radius
 *   actor.<id>.joint.<name>.<x|y|z>         actor.<id>.gravity|tone|damping
 *   actor.<id>.strength|smoothing|opacity   actor.<id>.tx..rz
 *   camera.<index>.fov                      canvas.<id>.tx|ty|tz|rx|ry|rz
 *   cursor3d.x|y|z (the 3D cursor)          frame (scene frame number)
 */
export function resolveTarget(ctx: AppCtx, path: string): ResolvedTarget | null {
  const seg = path.split('.');
  const scene = ctx.scene;
  const num = (v: number) => (Number.isFinite(v) ? v : 0);

  switch (seg[0]) {
    case 'brush': {
      if (seg[1] === 'style') {
        const field = seg[2] as keyof typeof ctx.settings.brush.style;
        if (typeof ctx.settings.brush.style[field] !== 'number') return null;
        return { set: (v) => { (ctx.settings.brush.style as unknown as Record<string, number>)[field] = num(v); }, dirty: 'none' };
      }
      const field = seg[1];
      if (!['size', 'strength', 'hardness'].includes(field)) return null;
      return { set: (v) => { (ctx.settings.brush as unknown as Record<string, number>)[field] = num(v); }, dirty: 'none' };
    }
    case 'layer': {
      const layer = activeObject(scene).layers.find((l) => l.id === Number(seg[1]));
      if (!layer) return null;
      if (seg[2] === 'opacity') return { set: (v) => { layer.opacity = Math.max(0, Math.min(1, num(v))); }, dirty: 'render' };
      if (seg[2] === 'thicknessOffset') return { set: (v) => { layer.thicknessOffset = num(v); }, dirty: 'render' };
      return null;
    }
    case 'modifier': case 'effect': {
      const ob = activeObject(scene);
      const list = seg[0] === 'modifier' ? ob.modifiers : ob.effects;
      const mod = list.find((m) => m.id === Number(seg[1]));
      if (!mod || typeof mod.params[seg[2]] !== 'number') return null;
      return { set: (v) => { mod.params[seg[2]] = num(v); }, dirty: 'render' };
    }
    case 'cursor': {
      const cur = scene.score.cursors.find((c) => c.id === Number(seg[1]));
      if (!cur) return null;
      if (seg[2] === 'speed') return { set: (v) => { cur.speed = num(v); }, dirty: 'none' };
      if (seg[2] === 'phase') return { set: (v) => { cur.phase = num(v); }, dirty: 'none' };
      if (seg[2] === 'rate') return { set: (v) => { cur.rate = Math.max(1, num(v)); }, dirty: 'none' };
      return null;
    }
    case 'trigger': {
      const trig = scene.score.triggers.find((t) => t.id === Number(seg[1]));
      if (!trig || seg[2] !== 'radius') return null;
      return { set: (v) => { trig.radius = Math.max(0.01, num(v)); }, dirty: 'none' };
    }
    case 'camera': {
      const cam = scene.cameras[Number(seg[1])];
      if (!cam || seg[2] !== 'fov') return null;
      return { set: (v) => { cam.fov = Math.min(140, Math.max(5, num(v))); }, dirty: 'none' };
    }
    case 'mesh': case 'canvas': { // 'canvas' = legacy alias since the migration
      const mesh = scene.meshes.find((m) => m.id === Number(seg[1]));
      if (mesh) {
        const axes: Record<string, () => ResolvedTarget> = {
          tx: () => ({ set: (v) => { mesh.translation[0] = num(v); }, dirty: 'none' }),
          ty: () => ({ set: (v) => { mesh.translation[1] = num(v); }, dirty: 'none' }),
          tz: () => ({ set: (v) => { mesh.translation[2] = num(v); }, dirty: 'none' }),
          rx: () => ({ set: (v) => { mesh.rotation[0] = num(v); }, dirty: 'none' }),
          ry: () => ({ set: (v) => { mesh.rotation[1] = num(v); }, dirty: 'none' }),
          rz: () => ({ set: (v) => { mesh.rotation[2] = num(v); }, dirty: 'none' }),
          opacity: () => ({ set: (v) => { mesh.opacity = Math.max(0, Math.min(1, num(v))); }, dirty: 'none' }),
        };
        const hit = axes[seg[2]]?.();
        if (hit) return hit;
      }
      // fall through to canvas lookup for any not-yet-migrated scene
      const canvas = scene.canvases.find((c) => c.id === Number(seg[1]));
      if (!canvas) return null;
      const map: Record<string, () => ResolvedTarget> = {
        tx: () => ({ set: (v) => { canvas.translation[0] = num(v); }, dirty: 'canvas' }),
        ty: () => ({ set: (v) => { canvas.translation[1] = num(v); }, dirty: 'canvas' }),
        tz: () => ({ set: (v) => { canvas.translation[2] = num(v); }, dirty: 'canvas' }),
        rx: () => ({ set: (v) => { canvas.rotation[0] = num(v); }, dirty: 'canvas' }),
        ry: () => ({ set: (v) => { canvas.rotation[1] = num(v); }, dirty: 'canvas' }),
        rz: () => ({ set: (v) => { canvas.rotation[2] = num(v); }, dirty: 'canvas' }),
      };
      return map[seg[2]]?.() ?? null;
    }
    case 'actor': {
      const actor = scene.actors.find((a) => a.id === Number(seg[1]));
      if (!actor) return null;
      // actor.<id>.joint.<name>.<x|y|z> — a joint GOAL, not a pose write.
      // Routed values go through the same target queue as capture and the
      // pose tool, so a knob moves a hand and the arm follows it; writing
      // the pose here would tear the joint off the skeleton instead.
      if (seg[2] === 'joint') {
        const index = actor.joints.findIndex((j) => j.name === seg[3]);
        if (index < 0) return null;
        const axis = { x: 0, y: 1, z: 2 }[seg[4] as 'x' | 'y' | 'z'];
        if (axis === undefined) return null;
        return {
          set: (v) => {
            const pos = [...actor.pose[index]] as [number, number, number];
            pos[axis] = num(v);
            actorSolver.addTarget(actor.id, { index, pos, weight: 1 });
          },
          dirty: 'render',
        };
      }
      const fields: Record<string, () => ResolvedTarget> = {
        gravity: () => ({ set: (v) => { actor.physics.gravity = num(v); }, dirty: 'none' }),
        damping: () => ({ set: (v) => { actor.physics.damping = Math.max(0, Math.min(1, num(v))); }, dirty: 'none' }),
        tone: () => ({ set: (v) => { actor.physics.tone = Math.max(0, Math.min(1, num(v))); }, dirty: 'none' }),
        strength: () => ({ set: (v) => { actor.rig.strength = Math.max(0, Math.min(1, num(v))); }, dirty: 'none' }),
        smoothing: () => ({ set: (v) => { actor.rig.smoothing = Math.max(0, Math.min(0.99, num(v))); }, dirty: 'none' }),
        opacity: () => ({ set: (v) => { actor.opacity = Math.max(0, Math.min(1, num(v))); }, dirty: 'render' }),
        tx: () => ({ set: (v) => { actor.translation[0] = num(v); }, dirty: 'render' }),
        ty: () => ({ set: (v) => { actor.translation[1] = num(v); }, dirty: 'render' }),
        tz: () => ({ set: (v) => { actor.translation[2] = num(v); }, dirty: 'render' }),
        rx: () => ({ set: (v) => { actor.rotation[0] = num(v); }, dirty: 'render' }),
        ry: () => ({ set: (v) => { actor.rotation[1] = num(v); }, dirty: 'render' }),
        rz: () => ({ set: (v) => { actor.rotation[2] = num(v); }, dirty: 'render' }),
      };
      return fields[seg[2]]?.() ?? null;
    }
    case 'attractor': {
      const at = scene.attractors.find((a) => a.id === Number(seg[1]));
      if (!at) return null;
      const axes: Record<string, number> = { x: 0, y: 1, z: 2 };
      if (seg[2] in axes) return { set: (v) => { at.position[axes[seg[2]]] = num(v); }, dirty: 'none' };
      if (seg[2] === 'strength') return { set: (v) => { at.strength = num(v); }, dirty: 'none' };
      if (seg[2] === 'radius') return { set: (v) => { at.radius = Math.max(0.01, num(v)); }, dirty: 'none' };
      return null;
    }
    case 'cursor3d': {
      const i = { x: 0, y: 1, z: 2 }[seg[1] as 'x' | 'y' | 'z'];
      if (i === undefined) return null;
      return { set: (v) => { scene.cursor[i] = num(v); }, dirty: 'render' };
    }
    case 'frame':
      return {
        set: (v) => {
          scene.frame = Math.round(Math.min(scene.frameEnd, Math.max(scene.frameStart, num(v))));
        },
        dirty: 'render',
      };
    default: return null;
  }
}

export const TARGET_SUGGESTIONS = [
  'brush.size', 'brush.strength', 'brush.hardness', 'brush.style.grain',
  'brush.style.jitter', 'layer.<id>.opacity', 'modifier.<id>.factor',
  'cursor.<id>.speed', 'cursor.<id>.phase', 'trigger.<id>.radius',
  'camera.0.fov', 'canvas.<id>.tx', 'cursor3d.x', 'frame',
  'attractor.<id>.x', 'attractor.<id>.strength',
];

function applyMapping(route: TGRoute, v: number): number {
  const m = route.mapping;
  if (m.mode === 'RAW') return v;
  const spanIn = m.inMax - m.inMin || 1e-9;
  let t = (v - m.inMin) / spanIn;
  if (m.mode === 'CLAMP') t = Math.max(0, Math.min(1, t));
  if (m.mode === 'WRAP') t = ((t % 1) + 1) % 1;
  return m.outMin + t * (m.outMax - m.outMin);
}

function sourceKind(ev: TGEvent): 'MIDI' | 'WS' | 'ANY' {
  if (ev.source === 'midi:in') return 'MIDI';
  if (ev.source === 'ws:in') return 'WS';
  return 'ANY';
}

export class RouteEngine {
  private ctx: AppCtx | null = null;
  private unsub: (() => void) | null = null;
  private warned = new Set<number>();
  /** learn mode: next incoming event fills this route's match */
  learningRouteId: number | null = null;
  onLearned: (() => void) | null = null;

  init(ctx: AppCtx): void {
    this.ctx = ctx;
    this.unsub = bus.on('*', (ev) => this.handle(ev));
  }

  dispose(): void { this.unsub?.(); }

  private handle(ev: TGEvent): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // only external inputs drive routes (avoid feedback from cursors/ui)
    if (ev.source !== 'midi:in' && ev.source !== 'ws:in') return;

    if (this.learningRouteId !== null) {
      const route = ctx.scene.routes.find((r) => r.id === this.learningRouteId);
      if (route) {
        route.match = { source: sourceKind(ev), address: ev.address };
        this.learningRouteId = null;
        this.onLearned?.();
      }
    }

    const value = typeof ev.args[0] === 'number' ? ev.args[0] : NaN;
    for (const route of ctx.scene.routes) {
      if (!route.enabled) continue;
      if (route.match.source !== 'ANY' && route.match.source !== sourceKind(ev)) continue;
      if (!addressMatches(route.match.address, ev.address)) continue;
      if (!Number.isFinite(value)) continue;
      const target = resolveTarget(ctx, route.target);
      if (!target) {
        if (!this.warned.has(route.id)) {
          this.warned.add(route.id);
          console.warn(`route ${route.id}: target '${route.target}' not resolvable — disabled`);
        }
        route.enabled = false;
        ctx.refreshUI();
        continue;
      }
      target.set(applyMapping(route, value));
      if (target.dirty === 'render') ctx.requestRender();
      else if (target.dirty === 'canvas') ctx.syncCanvases();
    }
  }
}

export const routes = new RouteEngine();

export function createRoute(id: number): TGRoute {
  return {
    id, enabled: true,
    match: { source: 'ANY', address: '/midi/cc/1/1' },
    target: 'brush.size',
    mapping: { inMin: 0, inMax: 127, outMin: 1, outMax: 60, mode: 'SCALE' },
  };
}
