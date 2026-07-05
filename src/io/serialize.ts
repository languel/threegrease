import type { GPScene } from '../core/types';
import { bumpIdCounter } from '../core/gpdata';

const FORMAT = 'threegrease-scene';
const VERSION = 1;

export function serializeScene(scene: GPScene): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, scene }, null, 0);
}

export function deserializeScene(json: string): GPScene {
  const data = JSON.parse(json);
  if (data?.format !== FORMAT) throw new Error('Not a threegrease scene file');
  const scene = data.scene as GPScene;
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
