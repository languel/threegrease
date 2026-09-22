import * as THREE from 'three';
import { activeObject, cloneStroke, ensureFrame, activeLayer } from '../core/gpdata';
import { clamp, falloff, seededRandom } from '../core/mathutil';
import type { Vec3 } from '../core/types';
import type { AppCtx } from './context';
import { screenToWorld } from './projection';
import type { Tool, ToolEvent } from './toolsys';
import { drawBrushCircle } from './draw';
import { sculptTarget, type SculptPoint, type SculptTarget } from './sculpttargets';

interface GrabState { p: SculptPoint; orig: Vec3; weight: number }

/** Where the neighbours average out to — Smooth's destination, and the raw
 *  material Relax takes only the sliding part of. Null when the point has
 *  too few neighbours to average (a stroke's two ends, a loose vertex). */
function toNeighbourMean(p: SculptPoint): THREE.Vector3 | null {
  const nbrs = p.nbrs();
  if (nbrs.length < 2) return null;
  const mean = new THREE.Vector3();
  for (const n of nbrs) mean.add(new THREE.Vector3(...n));
  mean.divideScalar(nbrs.length);
  return mean.sub(new THREE.Vector3(...p.co()));
}

/**
 * RELAX, as one pass of the brush — shared by the Sculpt tool's Relax brush
 * and the poly tools' Shift+drag, so "hold Shift to relax" and "pick the
 * Relax brush" cannot drift into meaning two different things.
 *
 * It is Smooth with the shape-changing half taken out: each point still
 * heads for the average of its neighbours, but only the component that
 * GLIDES IT ALONG the thing it belongs to survives (`SculptPoint.tangential`
 * — across the surface normal for a mesh vertex, along the chord for a
 * stroke point or a loose wire). So spacing evens out and a lumpy
 * silhouette combs itself straight, while the surface stays where it is
 * instead of slowly deflating the way repeated Smooth passes do.
 */
export function relaxPass(
  target: SculptTarget, cursor: THREE.Vector2, radius: number, press: number,
): void {
  for (const p of target.points) {
    const w = falloff(target.toScreen(p.co()).distanceTo(cursor), radius);
    if (w <= 0) continue;
    const toMean = toNeighbourMean(p);
    if (!toMean) continue;
    const by = p.tangential(toMean).multiplyScalar(w * press * 0.6);
    const co = p.co();
    p.set([co[0] + by.x, co[1] + by.y, co[2] + by.z]);
  }
}

/**
 * Every sculpt brush, over whatever kind of thing is being edited — grease
 * pencil strokes, or an editable poly mesh (which is also how a primitive
 * sculpts: Edit mode converts it to one on the way in). The brush is picked
 * from settings; `sculpttargets.ts` is what makes the same brush code work
 * on points that live in completely different places.
 *
 * Two of the nine act on per-POINT attributes only a stroke has (Thickness,
 * Strength) and one pastes strokes (Clone). On a mesh those say so instead
 * of doing nothing silently.
 */
export class SculptTool implements Tool {
  id = 'sculpt';
  cursor = 'none';
  /** Set by App alongside its own `meshEditId` (the splat tools take their
   *  target the same way): "Edit mode is editing THIS mesh", or null for the
   *  active drawing. */
  meshTargetId: number | null = null;
  private active = false;
  private last = new THREE.Vector2();
  private grab: GrabState[] = [];
  private grabStart = new THREE.Vector2();
  /** Built once per stroke: sculpting moves points, never topology. */
  private target: SculptTarget | null = null;

  onDown(ctx: AppCtx, e: ToolEvent): void {
    const brush = ctx.settings.sculpt.brush;
    const target = sculptTarget(ctx, this.meshTargetId);
    if (!target) {
      ctx.setStatus('nothing to sculpt here — draw a stroke, or edit a mesh', 2000);
      return;
    }
    if (target.kind === 'POLY' && (brush === 'THICKNESS' || brush === 'STRENGTH' || brush === 'CLONE')) {
      ctx.setStatus(`${brush.toLowerCase()} is a stroke brush — a mesh vertex has no ${
        brush === 'CLONE' ? 'stroke to clone' : brush.toLowerCase()}`, 2500);
      return;
    }
    ctx.pushUndo();
    this.active = true;
    this.target = target;
    this.last.set(e.x, e.y);
    if (brush === 'GRAB') {
      this.grab = [];
      this.grabStart.set(e.x, e.y);
      const cursor = new THREE.Vector2(e.x, e.y);
      const { radius } = ctx.settings.sculpt;
      this.forPoints(target, cursor, radius, (p, w) => {
        this.grab.push({ p, orig: [...p.co()] as Vec3, weight: w });
      });
    } else if (brush === 'CLONE') {
      this.pasteClone(ctx, e);
    } else {
      this.apply(ctx, e);
    }
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (!this.active || !this.target) return;
    const brush = ctx.settings.sculpt.brush;
    if (brush === 'GRAB') this.applyGrab(ctx, e);
    else if (brush !== 'CLONE') this.apply(ctx, e);
    this.last.set(e.x, e.y);
  }

  onUp(): void { this.active = false; this.grab = []; this.target = null; }
  onCancel(): void { this.active = false; this.grab = []; this.target = null; }

  drawHud(ctx: AppCtx, hud: CanvasRenderingContext2D): void {
    drawBrushCircle(hud, ctx.settings.sculpt.radius, [1, 0.5, 0.9]);
  }

  private forPoints(
    target: SculptTarget, cursor: THREE.Vector2, radius: number,
    cb: (p: SculptPoint, weightFalloff: number) => void,
  ): void {
    for (const p of target.points) {
      const w = falloff(target.toScreen(p.co()).distanceTo(cursor), radius);
      if (w > 0) cb(p, w);
    }
  }

  private apply(ctx: AppCtx, e: ToolEvent): void {
    const target = this.target;
    if (!target) return;
    const { brush, radius, strength } = ctx.settings.sculpt;
    const press = (e.pressure || 0.7) * strength;
    const invert = e.ctrl ? -1 : 1;
    const cursor = new THREE.Vector2(e.x, e.y);
    const delta = new THREE.Vector2(e.x - this.last.x, e.y - this.last.y);
    const rnd = seededRandom();
    const move = (p: SculptPoint, by: THREE.Vector3) => {
      const co = p.co();
      p.set([co[0] + by.x, co[1] + by.y, co[2] + by.z]);
    };

    switch (brush) {
      case 'SMOOTH':
        this.forPoints(target, cursor, radius, (p, w) => {
          const toMean = toNeighbourMean(p);
          if (toMean) move(p, toMean.multiplyScalar(w * press * 0.4));
        });
        break;
      case 'RELAX':
        relaxPass(target, cursor, radius, press);
        break;
      case 'THICKNESS':
        this.forPoints(target, cursor, radius, (p, w) => {
          if (p.gp) p.gp.pressure = Math.max(0.02, p.gp.pressure + invert * w * press * 0.08);
        });
        break;
      case 'STRENGTH':
        this.forPoints(target, cursor, radius, (p, w) => {
          if (p.gp) p.gp.strength = clamp(p.gp.strength + invert * w * press * 0.08, 0.02, 1);
        });
        break;
      case 'RANDOMIZE':
        this.forPoints(target, cursor, radius, (p, w) => {
          const amt = w * press * 0.01;
          move(p, new THREE.Vector3((rnd() - 0.5) * amt, (rnd() - 0.5) * amt, (rnd() - 0.5) * amt));
        });
        break;
      case 'PUSH': {
        const moved = target.deltaToLocal(cursor, delta);
        if (moved) {
          this.forPoints(target, cursor, radius, (p, w) => {
            move(p, new THREE.Vector3(...moved).multiplyScalar(w * press));
          });
        }
        break;
      }
      case 'PINCH':
        this.forPoints(target, cursor, radius, (p, w) => {
          const px = target.toScreen(p.co());
          const toC = cursor.clone().sub(px).multiplyScalar(invert * w * press * 0.1);
          const moved = target.deltaToLocal(px, toC);
          if (moved) move(p, new THREE.Vector3(...moved));
        });
        break;
      case 'TWIST': {
        const viewDir = ctx.camera.getWorldDirection(new THREE.Vector3());
        const rect = ctx.canvas.getBoundingClientRect();
        const centerWorld = screenToWorld(ctx, cursor.x + rect.left, cursor.y + rect.top);
        if (!centerWorld) break;
        const angle = invert * press * 0.05 * (delta.length() + 2);
        this.forPoints(target, cursor, radius, (p, w) => {
          const world = target.toWorld(p.co());
          const qw = new THREE.Quaternion().setFromAxisAngle(viewDir, angle * w);
          world.sub(centerWorld).applyQuaternion(qw).add(centerWorld);
          p.set(target.fromWorld(world));
        });
        break;
      }
    }
    target.flush(ctx);
  }

  private applyGrab(ctx: AppCtx, e: ToolEvent): void {
    const target = this.target;
    if (!target) return;
    const delta = new THREE.Vector2(e.x - this.grabStart.x, e.y - this.grabStart.y);
    for (const g of this.grab) {
      const px = target.toScreen(g.orig);
      const moved = target.deltaToLocal(px, delta.clone().multiplyScalar(g.weight));
      if (moved) g.p.set([g.orig[0] + moved[0], g.orig[1] + moved[1], g.orig[2] + moved[2]]);
    }
    target.flush(ctx);
  }

  /** Clone brush: paste the copy buffer centered at the cursor. Strokes
   *  only — it pastes STROKES, which a mesh has nowhere to put. */
  private pasteClone(ctx: AppCtx, e: ToolEvent): void {
    const target = this.target;
    if (!target || target.kind !== 'GP' || !ctx.copyBuffer.length) return;
    const ob = activeObject(ctx.scene);
    const layer = activeLayer(ob);
    if (!layer || layer.lock) return;
    const frame = ensureFrame(layer, ctx.scene.frame, ctx.settings.autoKey);
    // buffer median in screen space -> offset to cursor
    const med: Vec3 = [0, 0, 0];
    let n = 0;
    for (const s of ctx.copyBuffer) for (const p of s.points) {
      med[0] += p.co[0]; med[1] += p.co[1]; med[2] += p.co[2]; n++;
    }
    if (!n) return;
    med[0] /= n; med[1] /= n; med[2] /= n;
    const medScreen = target.toScreen(med);
    const moved = target.deltaToLocal(
      medScreen, new THREE.Vector2(e.x - medScreen.x, e.y - medScreen.y),
    );
    if (!moved) return;
    for (const s of ctx.copyBuffer) {
      const copy = cloneStroke(s);
      for (const p of copy.points) {
        p.co = [p.co[0] + moved[0], p.co[1] + moved[1], p.co[2] + moved[2]];
      }
      frame.strokes.push(copy);
    }
    target.flush(ctx);
  }
}
