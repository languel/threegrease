import type { StrokeStyle } from './types';

export function defaultStyle(): StrokeStyle {
  return {
    unit: 'VIEW', stamp: false, spacing: 0.12, angle: 0,
    aspect: 1, jitter: 0, grain: 0, grainScale: 6,
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
];
