import type * as THREE from 'three';
import type { GPScene, GPStroke, Vec3 } from '../core/types';
import type { History } from '../core/history';
import type { EditorMode, GPSceneRenderer } from '../render/GPSceneRenderer';

export type PlacementMode = 'ORIGIN' | 'CURSOR' | 'SURFACE';
export type PlaneMode = 'VIEW' | 'FRONT' | 'SIDE' | 'TOP';
export type GuideType = 'NONE' | 'CIRCULAR' | 'RADIAL' | 'PARALLEL' | 'GRID' | 'ISO';
export type EraserMode = 'POINT' | 'STROKE' | 'SOFT';
export type SculptBrush =
  | 'SMOOTH' | 'THICKNESS' | 'STRENGTH' | 'RANDOMIZE' | 'GRAB' | 'PUSH' | 'TWIST' | 'PINCH' | 'CLONE';
export type PaintBrush = 'DRAW' | 'BLUR' | 'AVERAGE' | 'SMEAR';

export interface Settings {
  mode: EditorMode;
  activeTool: string;
  brush: {
    size: number;            // stroke lineWidth px
    strength: number;
    hardness: number;
    pressureSize: boolean;
    pressureStrength: boolean;
    stabilize: boolean;
    stabilizeRadius: number; // px
    stabilizeFactor: number;
    activeSmooth: number;
    postSmooth: number;      // factor
    postSmoothSteps: number;
    simplify: number;        // epsilon world units
    vertexColor: Vec3;
    vertexColorFactor: number; // 0 = material color, >0 mixes vertex color while drawing
  };
  eraser: { mode: EraserMode; radius: number };
  fill: { simplify: number; scale: number };
  placement: PlacementMode;
  plane: PlaneMode;
  guide: { type: GuideType; angle: number; spacing: number };
  selectMode: 'POINT' | 'STROKE';
  autoKey: boolean;
  additiveDraw: boolean;     // draw on new keyframes keeps previous strokes
  propEdit: { enabled: boolean; radius: number };
  multiframe: boolean;
  sculpt: { brush: SculptBrush; radius: number; strength: number };
  paint: { brush: PaintBrush; radius: number; strength: number };
  weight: { radius: number; strength: number; target: number };
  background: Vec3;
}

export interface AppCtx {
  scene: GPScene;
  history: History;
  settings: Settings;
  camera: THREE.PerspectiveCamera;
  gp: GPSceneRenderer;
  gl: THREE.WebGLRenderer;
  scene3: THREE.Scene;
  canvas: HTMLCanvasElement;
  /** meshes eligible for SURFACE placement raycasts */
  surfaces: THREE.Object3D[];
  copyBuffer: GPStroke[];
  requestRender(): void;
  pushUndo(): void;
  replaceScene(s: GPScene): void;
  refreshUI(): void;
}

export function defaultSettings(): Settings {
  return {
    mode: 'DRAW',
    activeTool: 'draw',
    brush: {
      size: 8, strength: 1, hardness: 1,
      pressureSize: true, pressureStrength: true,
      stabilize: false, stabilizeRadius: 30, stabilizeFactor: 0.6,
      activeSmooth: 0.2, postSmooth: 0.3, postSmoothSteps: 2, simplify: 0.002,
      vertexColor: [1, 0.4, 0.1], vertexColorFactor: 0,
    },
    eraser: { mode: 'POINT', radius: 24 },
    fill: { simplify: 1.5, scale: 1 },
    placement: 'ORIGIN',
    plane: 'VIEW',
    guide: { type: 'NONE', angle: 0, spacing: 40 },
    selectMode: 'POINT',
    autoKey: false,
    additiveDraw: false,
    propEdit: { enabled: false, radius: 120 },
    multiframe: false,
    sculpt: { brush: 'SMOOTH', radius: 50, strength: 0.5 },
    paint: { brush: 'DRAW', radius: 40, strength: 0.6 },
    weight: { radius: 40, strength: 0.5, target: 1 },
    background: [0.11, 0.11, 0.12],
  };
}
