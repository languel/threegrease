import type { GPScene } from '../core/types';

export class Player {
  playing = false;
  private acc = 0;
  private lastT = 0;

  toggle(): void { this.playing ? this.stop() : this.play(); }
  play(): void { this.playing = true; this.lastT = performance.now(); this.acc = 0; }
  stop(): void { this.playing = false; }

  /** Advance scene.frame based on wall time; returns true if the frame changed. */
  tick(scene: GPScene): boolean {
    if (!this.playing) return false;
    const now = performance.now();
    this.acc += (now - this.lastT) / 1000;
    this.lastT = now;
    const frameDur = 1 / scene.fps;
    let changed = false;
    while (this.acc >= frameDur) {
      this.acc -= frameDur;
      scene.frame = scene.frame >= scene.frameEnd ? scene.frameStart : scene.frame + 1;
      changed = true;
    }
    return changed;
  }
}
