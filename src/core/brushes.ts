import type { StrokeStyle } from './types';

export function defaultStyle(): StrokeStyle {
  return {
    unit: 'VIEW', stamp: false, spacing: 0.12, angle: 0,
    aspect: 1, jitter: 0, grain: 0, grainScale: 6,
    varyMode: 'NONE', varyRadius: 0, varyStrength: 0, varyScale: 4,
    taperIn: 0, taperOut: 0,
  };
}

export interface BrushPreset {
  name: string;
  size: number;          // px (VIEW) or world*100 (SCENE: size 30 => 0.3u)
  strength: number;
  hardness: number;
  style: StrokeStyle;
}

/** Blender-inspired natural-media presets. Applied onto Settings.brush. */
export const BRUSH_PRESETS: BrushPreset[] = [
  {
    name: 'Pen', size: 8, strength: 1, hardness: 1,
    style: { ...defaultStyle() },
  },
  {
    name: 'Ink Rough', size: 20, strength: 1, hardness: 0.9,
    style: {
      unit: 'SCENE', stamp: true, spacing: 0.12, angle: 0,
      aspect: 0.85, jitter: 0.15, grain: 0.55, grainScale: 7,
    },
  },
  {
    name: 'Marker', size: 30, strength: 0.9, hardness: 0.85,
    style: {
      unit: 'SCENE', stamp: true, spacing: 0.1, angle: 0.7,
      aspect: 0.45, jitter: 0.02, grain: 0.15, grainScale: 4,
    },
  },
  {
    name: 'Charcoal', size: 26, strength: 0.85, hardness: 0.55,
    style: {
      unit: 'SCENE', stamp: true, spacing: 0.16, angle: 0,
      aspect: 0.6, jitter: 0.35, grain: 0.9, grainScale: 10,
    },
  },
  {
    name: 'Airbrush', size: 46, strength: 0.25, hardness: 0.15,
    style: {
      unit: 'SCENE', stamp: true, spacing: 0.3, angle: 0,
      aspect: 1, jitter: 0.25, grain: 0.25, grainScale: 3,
    },
  },

  // ---- expressive set -------------------------------------------------
  // These are the ones with handwriting in them. Each picks a different
  // SIGNAL to vary along the stroke, because that choice — not the tip
  // shape — is what separates a live mark from a uniform ribbon:
  //   DENSITY   how slowly it was drawn (baked from input sampling)
  //   CURVATURE how hard it turns here
  //   RANDOM    seeded noise along the arc
  //   ARC       a deliberate ramp end to end
  {
    // the classic pencil: presses dark where you lingered, skips where the
    // hand moved fast, and lifts off at both ends
    name: 'Pencil Soft', size: 10, strength: 0.85, hardness: 0.7,
    style: {
      ...defaultStyle(),
      varyMode: 'DENSITY', varyRadius: 0.45, varyStrength: 0.55,
      taperIn: 0.06, taperOut: 0.12,
    },
  },
  {
    // dry graphite dragged over tooth: heavy random break-up, thin overall
    name: 'Pencil Hard', size: 5, strength: 0.7, hardness: 1,
    style: {
      ...defaultStyle(),
      varyMode: 'RANDOM', varyRadius: 0.3, varyStrength: 0.5, varyScale: 22,
      taperIn: 0.04, taperOut: 0.08,
    },
  },
  {
    // ink that pools in the corners — thickens exactly where the line turns
    name: 'Ink Pooling', size: 14, strength: 1, hardness: 0.95,
    style: {
      ...defaultStyle(),
      unit: 'SCENE',
      varyMode: 'CURVATURE', varyRadius: -0.9, varyStrength: 0,
      taperIn: 0.05, taperOut: 0.05,
    },
  },
  {
    // brush pen: fat belly, whip-thin entry and exit
    name: 'Brush Pen', size: 26, strength: 1, hardness: 0.85,
    style: {
      ...defaultStyle(),
      unit: 'SCENE',
      varyMode: 'DENSITY', varyRadius: 0.5, varyStrength: 0.2,
      taperIn: 0.22, taperOut: 0.3,
    },
  },
  {
    // chalk: coarse stamped grain AND random width break-up on top
    name: 'Chalk', size: 30, strength: 0.8, hardness: 0.4,
    style: {
      unit: 'SCENE', stamp: true, spacing: 0.14, angle: 0.3,
      aspect: 0.75, jitter: 0.4, grain: 0.8, grainScale: 14,
      varyMode: 'RANDOM', varyRadius: 0.35, varyStrength: 0.4, varyScale: 9,
      taperIn: 0, taperOut: 0.05,
    },
  },
  {
    // dry-brush scrape: mostly gaps, survives only where it was slow
    name: 'Dry Brush', size: 34, strength: 0.9, hardness: 0.5,
    style: {
      unit: 'SCENE', stamp: true, spacing: 0.2, angle: 0,
      aspect: 0.5, jitter: 0.3, grain: 0.95, grainScale: 18,
      varyMode: 'DENSITY', varyRadius: 0.25, varyStrength: 0.8, varyScale: 4,
      taperIn: 0.05, taperOut: 0.15,
    },
  },
  {
    // fading marker: full at the start, running out by the end
    name: 'Fading Marker', size: 24, strength: 0.95, hardness: 0.8,
    style: {
      ...defaultStyle(),
      unit: 'SCENE',
      varyMode: 'ARC', varyRadius: 0.2, varyStrength: 0.75,
      taperOut: 0.1,
    },
  },
  {
    // thick-and-thin calligraphic nib, driven by how the line turns
    name: 'Calligraphy', size: 22, strength: 1, hardness: 1,
    style: {
      unit: 'SCENE', stamp: true, spacing: 0.06, angle: 0.9,
      aspect: 0.25, jitter: 0, grain: 0, grainScale: 6,
      varyMode: 'CURVATURE', varyRadius: -0.5, varyStrength: 0,
      taperIn: 0.03, taperOut: 0.06,
    },
  },
];
