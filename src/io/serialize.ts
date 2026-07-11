import type { GPScene } from '../core/types';
import { bumpIdCounter, createDefaultCamera } from '../core/gpdata';
import { defaultStyle } from '../core/brushes';

const FORMAT = 'threegrease-scene';
const VERSION = 2; // v2: StrokeStyle on strokes, canvases select/drawTarget

export function serializeScene(scene: GPScene): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, scene }, null, 0);
}

export function deserializeScene(json: string): GPScene {
  const data = JSON.parse(json);
  if (data?.format !== FORMAT) throw new Error('Not a threegrease scene file');
  const scene = data.scene as GPScene;
  scene.canvases ??= []; // older saves predate canvas planes
  for (const c of scene.canvases) {
    c.select ??= false;
    c.drawTarget ??= true;
  }
  // migrate single-camera saves to the camera list
  const legacy = (scene as unknown as { camera?: import('../core/types').GPCamera }).camera;
  scene.cameras ??= legacy ? [{ ...createDefaultCamera(), ...legacy, name: 'Camera 1' }] : [createDefaultCamera()];
  scene.activeCamera ??= 0;
  scene.io ??= { wsUrl: '', midiInId: null, midiOutId: null };
  scene.score ??= { cursors: [], triggers: [], attachments: [] };
  // v1 -> v2: strokes gain baked style
  for (const ob of scene.objects) {
    for (const layer of ob.layers) {
      for (const f of layer.frames) {
        for (const s of f.strokes) s.style ??= defaultStyle();
      }
    }
  }
  bumpIdCounter(scene);
  return scene;
}

export function downloadScene(scene: GPScene, filename = 'scene.threegrease.json'): void {
  const blob = new Blob([serializeScene(scene)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function openSceneFile(): Promise<GPScene> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));
      try { resolve(deserializeScene(await file.text())); }
      catch (e) { reject(e); }
    };
    input.click();
  });
}
