// Non-destructive modifier stack. Pure: takes cloned strokes for one layer at
// one frame, returns modified strokes. Mirrors Blender GP modifiers.
import type { GPLayer, GPModifier, GPObject, GPStroke, ModifierType, Vec3 } from '../core/types';
import { cloneStroke } from '../core/gpdata';
import {
  clamp, lerp, seededRandom, simplifyStroke, smoothPoints, strokeLength, subdivideStroke, v3lerp,
} from '../core/mathutil';

export interface ModifierDef {
  label: string;
  defaults: Record<string, number | boolean | number[]>;
  apply: (strokes: GPStroke[], mod: GPModifier, ctx: EvalContext) => GPStroke[];
}

export interface EvalContext {
  object: GPObject;
  layer: GPLayer;
  frame: number;       // scene frame being evaluated
  keyFrameNumber: number; // frameNumber of the keyframe the strokes came from
}

const num = (mod: GPModifier, key: string, def: ModifierDef): number =>
  (mod.params[key] as number) ?? (def.defaults[key] as number);
const boolp = (mod: GPModifier, key: string, def: ModifierDef): boolean =>
  (mod.params[key] as boolean) ?? (def.defaults[key] as boolean);
const vecp = (mod: GPModifier, key: string, def: ModifierDef): number[] =>
  (mod.params[key] as number[]) ?? (def.defaults[key] as number[]);

export const MODIFIERS: Record<ModifierType, ModifierDef> = {
  NOISE: {
    label: 'Noise',
    defaults: { factor: 0.5, factorStrength: 0, factorThickness: 0, scale: 0.5, seed: 1, useWeight: true },
    apply(strokes, mod, _ctx) {
      const def = this;
      const f = num(mod, 'factor', def), fs = num(mod, 'factorStrength', def), ft = num(mod, 'factorThickness', def);
      const scale = Math.max(0.01, num(mod, 'scale', def));
      const seed = num(mod, 'seed', def);
      const useW = boolp(mod, 'useWeight', def);
      for (const s of strokes) {
        const rnd = seededRandom(seed * 7919 + s.id);
        s.points.forEach((p, i) => {
          const w = useW ? p.weight : 1;
          const t = i / scale;
          const n1 = Math.sin(t * 1.7 + rnd() * 6.28) * 0.5 + (rnd() - 0.5);
          const n2 = Math.cos(t * 2.3 + rnd() * 6.28) * 0.5 + (rnd() - 0.5);
          const n3 = Math.sin(t * 3.1 + rnd() * 6.28) * 0.5 + (rnd() - 0.5);
          p.co = [p.co[0] + n1 * f * 0.05 * w, p.co[1] + n2 * f * 0.05 * w, p.co[2] + n3 * f * 0.05 * w];
          if (fs) p.strength = clamp(p.strength + (rnd() - 0.5) * fs * w, 0, 1);
          if (ft) p.pressure = Math.max(0.01, p.pressure + (rnd() - 0.5) * ft * w);
        });
      }
      return strokes;
    },
  },
  SMOOTH: {
    label: 'Smooth',
    defaults: { factor: 0.5, iterations: 2 },
    apply(strokes, mod) {
      const f = num(mod, 'factor', this), it = Math.round(num(mod, 'iterations', this));
      for (const s of strokes) smoothPoints(s.points, f, it, s.cyclic);
      return strokes;
    },
  },
  SUBDIVIDE: {
    label: 'Subdivide',
    defaults: { level: 1 },
    apply(strokes, mod) {
      const level = clamp(Math.round(num(mod, 'level', this)), 0, 4);
      for (const s of strokes) subdivideStroke(s, level);
      return strokes;
    },
  },
  SIMPLIFY: {
    label: 'Simplify',
    defaults: { factor: 0.01 },
    apply(strokes, mod) {
      const eps = num(mod, 'factor', this);
      for (const s of strokes) simplifyStroke(s, eps);
      return strokes;
    },
  },
  THICKNESS: {
    label: 'Thickness',
    defaults: { factor: 1.5, uniform: false },
    apply(strokes, mod) {
      const f = num(mod, 'factor', this);
      const uniform = boolp(mod, 'uniform', this);
      for (const s of strokes) {
        if (uniform) s.points.forEach((p) => { p.pressure = f; });
        else s.points.forEach((p) => { p.pressure *= f; });
      }
      return strokes;
    },
  },
  OFFSET: {
    label: 'Offset',
    defaults: { location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    apply(strokes, mod) {
      const loc = vecp(mod, 'location', this) as Vec3;
      const rot = vecp(mod, 'rotation', this) as Vec3;
      const scl = vecp(mod, 'scale', this) as Vec3;
      const [cx, cy, cz] = [Math.cos(rot[0]), Math.cos(rot[1]), Math.cos(rot[2])];
      const [sx, sy, sz] = [Math.sin(rot[0]), Math.sin(rot[1]), Math.sin(rot[2])];
      for (const s of strokes) {
        for (const p of s.points) {
          let [x, y, z] = p.co;
          x *= scl[0]; y *= scl[1]; z *= scl[2];
          // XYZ euler
          let y1 = y * cx - z * sx, z1 = y * sx + z * cx;
          let x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
          let x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
          p.co = [x3 + loc[0], y3 + loc[1], z2 + loc[2]];
        }
      }
      return strokes;
    },
  },
  ARRAY: {
    label: 'Array',
    defaults: { count: 3, offset: [0.5, 0, 0], rotation: [0, 0, 0], scaleStep: 1, randomSeed: 0 },
    apply(strokes, mod) {
      const count = clamp(Math.round(num(mod, 'count', this)), 1, 50);
      const off = vecp(mod, 'offset', this) as Vec3;
      const rot = vecp(mod, 'rotation', this) as Vec3;
      const sstep = num(mod, 'scaleStep', this);
      const out: GPStroke[] = [...strokes];
      for (let i = 1; i < count; i++) {
        const angle = rot[2] * i;
        const c = Math.cos(angle), sn = Math.sin(angle);
        const sc = Math.pow(sstep, i);
        for (const s of strokes) {
          const copy = cloneStroke(s);
          for (const p of copy.points) {
            let [x, y, z] = p.co;
            x *= sc; y *= sc; z *= sc;
            const xr = x * c - y * sn, yr = x * sn + y * c;
            p.co = [xr + off[0] * i, yr + off[1] * i, z + off[2] * i];
          }
          out.push(copy);
        }
      }
      return out;
    },
  },
  MIRROR: {
    label: 'Mirror',
    defaults: { axisX: true, axisY: false, axisZ: false },
    apply(strokes, mod) {
      const axes: Vec3[] = [];
      if (boolp(mod, 'axisX', this)) axes.push([-1, 1, 1]);
      if (boolp(mod, 'axisY', this)) axes.push([1, -1, 1]);
      if (boolp(mod, 'axisZ', this)) axes.push([1, 1, -1]);
      const out = [...strokes];
      for (const ax of axes) {
        for (const s of strokes) {
          const copy = cloneStroke(s);
          for (const p of copy.points) p.co = [p.co[0] * ax[0], p.co[1] * ax[1], p.co[2] * ax[2]];
          copy.points.reverse();
          out.push(copy);
        }
      }
      return out;
    },
  },
  BUILD: {
    label: 'Build',
    defaults: { mode: 0 /* 0 sequential, 1 concurrent */, startFrame: 1, length: 50, transition: 0 /* 0 grow, 1 shrink, 2 vanish */ },
    apply(strokes, mod, ctx) {
      const start = num(mod, 'startFrame', this);
      const length = Math.max(1, num(mod, 'length', this));
      const mode = num(mod, 'mode', this);
      const transition = num(mod, 'transition', this);
      let t = clamp((ctx.frame - start) / length, 0, 1);
      if (transition === 1) t = 1 - t;
      if (t >= 1) return strokes;
      if (t <= 0) return transition === 1 ? strokes : [];
      const totalPoints = strokes.reduce((a, s) => a + s.points.length, 0);
      if (mode === 0) {
        // sequential: reveal strokes in order, points within stroke
        let budget = Math.floor(totalPoints * t);
        const out: GPStroke[] = [];
        for (const s of strokes) {
          if (budget <= 0) break;
          if (s.points.length <= budget) { out.push(s); budget -= s.points.length; }
          else { s.points = s.points.slice(0, Math.max(2, budget)); out.push(s); budget = 0; }
        }
        return out;
      }
      // concurrent: every stroke grows at once
      for (const s of strokes) {
        const n = Math.max(2, Math.floor(s.points.length * t));
        s.points = s.points.slice(0, n);
      }
      return strokes;
    },
  },
  TINT: {
    label: 'Tint',
    defaults: { color: [1, 0.3, 0.1], factor: 0.5 },
    apply(strokes, mod) {
      const c = vecp(mod, 'color', this);
      const f = clamp(num(mod, 'factor', this), 0, 1);
      for (const s of strokes) {
        for (const p of s.points) {
          const base = p.vertexColor[3] > 0 ? p.vertexColor : [0, 0, 0, 0];
          p.vertexColor = [
            lerp(base[0], c[0], f), lerp(base[1], c[1], f), lerp(base[2], c[2], f),
            Math.max(base[3], f),
          ];
        }
        const fb = s.fillVertexColor[3] > 0 ? s.fillVertexColor : [0, 0, 0, 0];
        s.fillVertexColor = [lerp(fb[0], c[0], f), lerp(fb[1], c[1], f), lerp(fb[2], c[2], f), Math.max(fb[3], f)];
      }
      return strokes;
    },
  },
  OPACITY: {
    label: 'Opacity',
    defaults: { factor: 1, useWeight: false },
    apply(strokes, mod) {
      const f = num(mod, 'factor', this);
      const useW = boolp(mod, 'useWeight', this);
      for (const s of strokes) for (const p of s.points) {
        p.strength = clamp(p.strength * f * (useW ? p.weight : 1), 0, 1);
      }
      return strokes;
    },
  },
  LENGTH: {
    label: 'Length',
    defaults: { startFactor: 0, endFactor: 0.2 },
    apply(strokes, mod) {
      const sf = num(mod, 'startFactor', this), ef = num(mod, 'endFactor', this);
      for (const s of strokes) {
        if (s.points.length < 2 || s.cyclic) continue;
        // positive factor extends by extrapolating end tangents; negative trims
        const extend = (fac: number, atEnd: boolean) => {
          const len = strokeLength(s.points) * Math.abs(fac);
          if (fac > 0) {
            const pts = s.points;
            const [a, b] = atEnd ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[1], pts[0]];
            const d: Vec3 = [b.co[0] - a.co[0], b.co[1] - a.co[1], b.co[2] - a.co[2]];
            const dl = Math.hypot(...d) || 1e-9;
            const steps = Math.max(1, Math.ceil(len / Math.max(dl, 0.01)));
            for (let i = 1; i <= steps; i++) {
              const np = { ...b, co: [b.co[0] + (d[0] / dl) * (len * i / steps), b.co[1] + (d[1] / dl) * (len * i / steps), b.co[2] + (d[2] / dl) * (len * i / steps)] as Vec3, vertexColor: [...b.vertexColor] as [number, number, number, number] };
              if (atEnd) pts.push(np); else pts.unshift(np);
            }
          } else if (fac < 0) {
            const cut = Math.floor(s.points.length * Math.abs(fac));
            if (atEnd) s.points = s.points.slice(0, Math.max(2, s.points.length - cut));
            else s.points = s.points.slice(Math.min(cut, s.points.length - 2));
          }
        };
        extend(sf, false);
        extend(ef, true);
      }
      return strokes;
    },
  },
  TIME: {
    label: 'Time Offset',
    defaults: { offset: 0, scale: 1 },
    // handled specially in evaluation (changes which keyframe is sampled);
    // apply() is identity.
    apply(strokes) { return strokes; },
  },
  WAVE: {
    label: 'Wave (deform)',
    defaults: { amplitude: 0.2, period: 1.5, phase: 0, axis: 0 /* 0=x displace y */, animate: true, speed: 0.1 },
    apply(strokes, mod, ctx) {
      const amp = num(mod, 'amplitude', this), period = Math.max(0.01, num(mod, 'period', this));
      const phase = num(mod, 'phase', this) + (boolp(mod, 'animate', this) ? ctx.frame * num(mod, 'speed', this) : 0);
      const axis = Math.round(num(mod, 'axis', this));
      for (const s of strokes) for (const p of s.points) {
        const along = axis === 0 ? p.co[0] : axis === 1 ? p.co[1] : p.co[2];
        const disp = Math.sin((along / period) * Math.PI * 2 + phase) * amp;
        if (axis === 0) p.co = [p.co[0], p.co[1] + disp, p.co[2]];
        else if (axis === 1) p.co = [p.co[0] + disp, p.co[1], p.co[2]];
        else p.co = [p.co[0], p.co[1] + disp, p.co[2]];
      }
      return strokes;
    },
  },
};

export function createModifier(type: ModifierType, id: number): GPModifier {
  const def = MODIFIERS[type];
  return {
    id, type, name: def.label, enabled: true, layerFilter: null, materialFilter: null,
    params: JSON.parse(JSON.stringify(def.defaults)),
  };
}

/** Time-offset remap: returns the frame to sample for this layer. */
export function remapTime(ob: GPObject, layer: GPLayer, frame: number): number {
  let f = frame;
  for (const mod of ob.modifiers) {
    if (!mod.enabled || mod.type !== 'TIME') continue;
    if (mod.layerFilter !== null && mod.layerFilter !== layer.id) continue;
    const def = MODIFIERS.TIME;
    const offset = (mod.params.offset as number) ?? (def.defaults.offset as number);
    const scale = (mod.params.scale as number) ?? (def.defaults.scale as number);
    f = Math.round(f * scale + offset);
  }
  return f;
}

/** Run the whole stack over cloned strokes of one layer. */
export function evaluateModifiers(
  strokes: GPStroke[], ob: GPObject, layer: GPLayer, frame: number, keyFrameNumber: number,
): GPStroke[] {
  // keep original ids: stamp jitter and NOISE seeds derive from stroke.id,
  // so evaluated geometry must be deterministic across rebuilds
  let out = strokes.map((s) => {
    const c = cloneStroke(s);
    c.id = s.id;
    return c;
  });
  const ctx: EvalContext = { object: ob, layer, frame, keyFrameNumber };
  for (const mod of ob.modifiers) {
    if (!mod.enabled || mod.type === 'TIME') continue;
    if (mod.layerFilter !== null && mod.layerFilter !== layer.id) continue;
    let subject = out;
    let rest: GPStroke[] = [];
    if (mod.materialFilter !== null) {
      subject = out.filter((s) => s.materialIndex === mod.materialFilter);
      rest = out.filter((s) => s.materialIndex !== mod.materialFilter);
    }
    out = [...rest, ...MODIFIERS[mod.type].apply(subject, mod, ctx)];
  }
  return out;
}
