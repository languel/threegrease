import type { GPScene } from './types';
import { bumpIdCounter } from './gpdata';

/** Snapshot undo, like Blender's global undo for GP data. */
export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private limit = 64;
  onChange: (() => void) | null = null;

  /** Call BEFORE mutating the scene. */
  push(scene: GPScene): void {
    this.undoStack.push(JSON.stringify(scene));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange?.();
  }

  undo(scene: GPScene): GPScene | null {
    const snap = this.undoStack.pop();
    if (!snap) return null;
    this.redoStack.push(JSON.stringify(scene));
    const restored = JSON.parse(snap) as GPScene;
    bumpIdCounter(restored);
    this.onChange?.();
    return restored;
  }

  redo(scene: GPScene): GPScene | null {
    const snap = this.redoStack.pop();
    if (!snap) return null;
    this.undoStack.push(JSON.stringify(scene));
    const restored = JSON.parse(snap) as GPScene;
    bumpIdCounter(restored);
    this.onChange?.();
    return restored;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}
