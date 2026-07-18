// P11: MediaMime integration — tracked-landmark positions arrive as plain
// bus events (WS/OSC, same bridge as MIDI) and become a live registry any
// scene object can bind to. No direct MediaPipe dependency here: threegrease
// only consumes '<prefix>/...' addresses whose trailing numeric args are a
// world-space (or normalized) x,y[,z] position — mediamime (or any other
// sender) owns the actual tracking.
import * as THREE from 'three';
import { bus } from '../events/bus';
import type { GPScene, Vec3 } from '../core/types';
import { getObjectTransform, parentWorldMatrixOf, setObjectTransform, type ObjRef } from '../tools/objects';

interface Landmark { pos: Vec3; t: number }

export class MediaMimeEngine {
  private landmarks = new Map<string, Landmark>();
  private unsub: (() => void) | null = null;
  private prefix = '/mp';

  /** Re-subscribe when the prefix changes (cheap; call whenever it might have). */
  setPrefix(prefix: string): void {
    if (prefix === this.prefix && this.unsub) return;
    this.prefix = prefix;
    this.unsub?.();
    this.unsub = prefix ? bus.on(`${prefix}/*`, (ev) => {
      const nums = ev.args.filter((a): a is number => typeof a === 'number');
      if (nums.length < 2) return; // need at least x,y
      this.landmarks.set(ev.address, { pos: [nums[0], nums[1], nums[2] ?? 0], t: ev.time });
    }) : null;
  }

  dispose(): void { this.unsub?.(); this.unsub = null; }

  get(address: string): Vec3 | null {
    return this.landmarks.get(address)?.pos ?? null;
  }

  /** Live addresses seen within maxAgeMs, for the MediaMime panel. */
  list(maxAgeMs = 4000): { address: string; pos: Vec3; age: number }[] {
    const now = performance.now();
    return [...this.landmarks.entries()]
      .filter(([, v]) => now - v.t < maxAgeMs)
      .map(([address, v]) => ({ address, pos: v.pos, age: now - v.t }))
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  /** Drive every enabled rig from the live registry. Call once per frame. */
  update(scene: GPScene): void {
    for (const rig of scene.mediamime.rigs) {
      if (!rig.enabled) continue;
      const p = this.get(rig.address);
      if (!p) continue;
      const ref = rig.target as ObjRef;
      const cur = getObjectTransform(scene, ref);
      if (!cur) continue;
      // offset in world space, then convert to the target's parent-local
      // frame (so a rigged child of a moving parent still lands on the
      // marker in world space), THEN apply scale — scale acts on the
      // resulting local offset rather than the raw landmark position, so
      // it scales the rig's motion around the parent instead of
      // distorting where the raw landmark data itself sits.
      const local = new THREE.Vector3(p[0] + rig.offset[0], p[1] + rig.offset[1], p[2] + rig.offset[2]);
      local.applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
      local.multiplyScalar(rig.scale);
      const resetTransform = rig.resetTransform !== false;
      setObjectTransform(scene, ref, {
        translation: [local.x, local.y, local.z],
        rotation: resetTransform ? [0, 0, 0] : cur.rotation,
        scale: resetTransform ? [1, 1, 1] : cur.scale,
      });
    }
  }
}

export const mediamime = new MediaMimeEngine();
