// Blender-style object constraints, evaluated every frame from App.loop.
// Any object (GP/mesh/splat/trigger) can carry a stack; FOLLOW_PATH makes
// it a traveler, TRIGGER makes it a proximity trigger — traveler/trigger
// are properties now, not special entity kinds. Pure data-in/data-out:
// constraints mutate translations/rotations via setObjectTransform, never
// meshes.
import * as THREE from 'three';
import type { GPScene, TGConstraint, ConstraintType } from '../core/types';
import {
  allRefs, getObjectTransform, parentWorldMatrixOf, setObjectTransform,
  worldMatrixOf, type ObjRef,
} from '../tools/objects';
import {
  advancePhase, fireMessages, samplePhase, type CursorState, type ScoreEngine,
} from './engine';
import { streamLandmarkWorld, streamStore, streamWorldMatrix } from '../mm/streams';
import { meshLocalBounds } from '../tools/objectops';

export function constraintsOf(scene: GPScene, ref: ObjRef): TGConstraint[] {
  const e =
    ref.kind === 'GP' ? scene.objects.find((o) => o.id === ref.id) :
    ref.kind === 'MESH' ? scene.meshes.find((m) => m.id === ref.id) :
    ref.kind === 'SPLAT' ? scene.splats.find((s) => s.id === ref.id) :
    ref.kind === 'TRIGGER' ? scene.score.triggers.find((t) => t.id === ref.id) :
    ref.kind === 'STREAM' ? scene.mmStreams.find((st) => st.id === ref.id) :
    undefined;
  return (e as { constraints?: TGConstraint[] } | undefined)?.constraints ?? [];
}

/** World position -> the object's parent-local translation. */
function worldToLocalTranslation(scene: GPScene, ref: ObjRef, world: THREE.Vector3): THREE.Vector3 {
  return world.clone().applyMatrix4(parentWorldMatrixOf(scene, ref).invert());
}

function worldPos(scene: GPScene, ref: ObjRef): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(worldMatrixOf(scene, ref));
}

export const CONSTRAINT_DEFS: Record<ConstraintType, { label: string; group: string }> = {
  FOLLOW_PATH: { label: 'Follow Path (traveler)', group: 'Relationship' },
  FOLLOW_STREAM: { label: 'Follow Stream (mm landmark)', group: 'Relationship' },
  TRIGGER: { label: 'Trigger (proximity/volume)', group: 'Relationship' },
  COPY_LOCATION: { label: 'Copy Location', group: 'Transform' },
  COPY_ROTATION: { label: 'Copy Rotation', group: 'Transform' },
  COPY_SCALE: { label: 'Copy Scale', group: 'Transform' },
  LIMIT_DISTANCE: { label: 'Limit Distance', group: 'Transform' },
  TRACK_TO: { label: 'Track To', group: 'Tracking' },
  SHRINKWRAP: { label: 'Shrinkwrap (surface)', group: 'Relationship' },
  FLOOR: { label: 'Floor', group: 'Relationship' },
  SPRING: { label: 'Spring (physics)', group: 'Physics' },
};

let nextConstraintId = 1;

export function createConstraint(type: ConstraintType): TGConstraint {
  const base: TGConstraint = {
    id: nextConstraintId++, type, name: CONSTRAINT_DEFS[type].label,
    enabled: true, influence: 1,
  };
  switch (type) {
    case 'FOLLOW_PATH':
      return { ...base, path: null, phase: 0, speed: 0.2, loop: 'LOOP', running: true, orient: false };
    case 'FOLLOW_STREAM':
      return { ...base, streamId: null, landmark: 0 };
    case 'TRIGGER':
      return {
        ...base, radius: 0.25, retrigger: true,
        messages: [{ address: '/trigger/{id}', argExprs: ['1'] }],
      };
    case 'LIMIT_DISTANCE':
      return { ...base, target: null, distance: 1 };
    case 'SPRING':
      return { ...base, target: null, stiffness: 12, damping: 4 };
    case 'SHRINKWRAP':
      return { ...base, offset: 0 };
    case 'FLOOR':
      return { ...base, offset: 0 };
    default:
      return { ...base, target: null };
  }
}

export class ConstraintEngine {
  /** SPRING velocity state, keyed `${kind}:${id}:${constraintId}` */
  private velocities = new Map<string, THREE.Vector3>();
  private triggerInside = new Map<string, boolean>();
  private triggerFired = new Set<string>();
  /** PLANE zones: last side (+1/-1) of each probe, for crossing detection */
  private planeSide = new Map<string, number>();
  /** zone fire events from the LAST update, for visual feedback (the App
   *  flashes the carrier object's outline) — replaced every frame */
  fired: { ref: ObjRef; kind: 'enter' | 'leave' }[] = [];

  reset(): void {
    this.velocities.clear();
    this.triggerInside.clear();
    this.triggerFired.clear();
    this.planeSide.clear();
  }

  /**
   * Evaluate every object's constraint stack in order. `surfaces` are the
   * SHRINKWRAP raycast targets; `score` supplies path sampling and legacy
   * traveler states for TRIGGER proximity.
   */
  update(scene: GPScene, dt: number, score: ScoreEngine, surfaces: THREE.Object3D[]): void {
    const tmp: CursorState = {
      position: new THREE.Vector3(), tangent: new THREE.Vector3(1, 0, 0), valid: false,
    };
    const up = new THREE.Vector3(0, 0, 1); // FLOOR uses scene Z-up convention via caller? keep Z
    const ray = new THREE.Raycaster();

    // pass 1: transforms — also collect traveler positions for pass 2
    const travelers: { key: string; pos: THREE.Vector3 }[] = [];
    for (const ref of allRefs(scene)) {
      if (ref.kind === 'CANVAS') continue;
      const stack = constraintsOf(scene, ref);
      if (!stack.length) continue;
      for (const c of stack) {
        if (!c.enabled) continue;
        const t = getObjectTransform(scene, ref);
        if (!t) break;
        const selfWorld = worldPos(scene, ref);

        if (c.type === 'FOLLOW_PATH' && c.path) {
          if (c.running) {
            const [p, running] = advancePhase(c.phase ?? 0, c.speed ?? 0.2, dt, c.loop ?? 'LOOP');
            c.phase = p;
            if (!running) c.running = false;
          }
          if (score.sample(scene, c.path, samplePhase(c.phase ?? 0, c.loop ?? 'LOOP'), tmp)) {
            const local = worldToLocalTranslation(scene, ref, tmp.position);
            const cur = new THREE.Vector3(...t.translation);
            cur.lerp(local, c.influence);
            t.translation = [cur.x, cur.y, cur.z];
            if (c.orient) {
              // yaw/pitch from tangent (roll-free)
              const d = tmp.tangent;
              t.rotation = [Math.atan2(-d.z, Math.hypot(d.x, d.y)), 0, Math.atan2(d.y, d.x)];
            }
            setObjectTransform(scene, ref, t);
            travelers.push({ key: `${ref.kind}:${ref.id}`, pos: tmp.position.clone() });
          }
        } else if (c.type === 'FOLLOW_STREAM' && c.streamId != null) {
          const st = scene.mmStreams.find((s) => s.id === c.streamId);
          const world = st ? streamLandmarkWorld(scene, st, c.landmark ?? 0) : null;
          if (world) {
            const local = worldToLocalTranslation(scene, ref, new THREE.Vector3(...world));
            const cur = new THREE.Vector3(...t.translation);
            cur.lerp(local, c.influence);
            t.translation = [cur.x, cur.y, cur.z];
            setObjectTransform(scene, ref, t);
            travelers.push({ key: `${ref.kind}:${ref.id}`, pos: new THREE.Vector3(...world) });
          }
        } else if (c.type === 'COPY_LOCATION' && c.target) {
          const tp = worldPos(scene, c.target as ObjRef);
          const local = worldToLocalTranslation(scene, ref, tp);
          const cur = new THREE.Vector3(...t.translation);
          cur.lerp(local, c.influence);
          t.translation = [cur.x, cur.y, cur.z];
          setObjectTransform(scene, ref, t);
        } else if (c.type === 'COPY_ROTATION' && c.target) {
          const tt = getObjectTransform(scene, c.target as ObjRef);
          if (tt) {
            t.rotation = [
              THREE.MathUtils.lerp(t.rotation[0], tt.rotation[0], c.influence),
              THREE.MathUtils.lerp(t.rotation[1], tt.rotation[1], c.influence),
              THREE.MathUtils.lerp(t.rotation[2], tt.rotation[2], c.influence),
            ];
            setObjectTransform(scene, ref, t);
          }
        } else if (c.type === 'COPY_SCALE' && c.target) {
          const tt = getObjectTransform(scene, c.target as ObjRef);
          if (tt) {
            t.scale = [
              THREE.MathUtils.lerp(t.scale[0], tt.scale[0], c.influence),
              THREE.MathUtils.lerp(t.scale[1], tt.scale[1], c.influence),
              THREE.MathUtils.lerp(t.scale[2], tt.scale[2], c.influence),
            ];
            setObjectTransform(scene, ref, t);
          }
        } else if (c.type === 'TRACK_TO' && c.target) {
          const tp = worldPos(scene, c.target as ObjRef);
          const d = tp.sub(selfWorld);
          if (d.lengthSq() > 1e-12) {
            d.normalize();
            t.rotation = [Math.atan2(-d.z, Math.hypot(d.x, d.y)), 0, Math.atan2(d.y, d.x)];
            setObjectTransform(scene, ref, t);
          }
        } else if (c.type === 'LIMIT_DISTANCE' && c.target) {
          const tp = worldPos(scene, c.target as ObjRef);
          const d = selfWorld.clone().sub(tp);
          const maxD = Math.max(0.001, c.distance ?? 1);
          if (d.length() > maxD) {
            const clamped = tp.clone().addScaledVector(d.normalize(), maxD);
            const local = worldToLocalTranslation(scene, ref, clamped);
            t.translation = [local.x, local.y, local.z];
            setObjectTransform(scene, ref, t);
          }
        } else if (c.type === 'SHRINKWRAP' && surfaces.length) {
          // cast straight down onto the nearest draw-target surface
          ray.set(selfWorld.clone().addScaledVector(up, 100), up.clone().negate());
          const hits = ray.intersectObjects(surfaces, true);
          if (hits.length) {
            const target = hits[0].point.clone().addScaledVector(up, c.offset ?? 0);
            const local = worldToLocalTranslation(scene, ref, target);
            t.translation = [local.x, local.y, local.z];
            setObjectTransform(scene, ref, t);
          }
        } else if (c.type === 'FLOOR') {
          const minZ = c.offset ?? 0;
          if (selfWorld.z < minZ) {
            const lifted = selfWorld.clone().setZ(minZ);
            const local = worldToLocalTranslation(scene, ref, lifted);
            t.translation = [local.x, local.y, local.z];
            setObjectTransform(scene, ref, t);
          }
        } else if (c.type === 'SPRING' && c.target) {
          const key = `${ref.kind}:${ref.id}:${c.id}`;
          let v = this.velocities.get(key);
          if (!v) { v = new THREE.Vector3(); this.velocities.set(key, v); }
          const tp = worldPos(scene, c.target as ObjRef);
          const clampedDt = Math.min(dt, 0.05); // stability under tab stalls
          v.addScaledVector(tp.sub(selfWorld), (c.stiffness ?? 12) * clampedDt);
          v.multiplyScalar(Math.max(0, 1 - (c.damping ?? 4) * clampedDt));
          const next = selfWorld.clone().addScaledVector(v, clampedDt);
          const local = worldToLocalTranslation(scene, ref, next);
          t.translation = [local.x, local.y, local.z];
          setObjectTransform(scene, ref, t);
        }
      }
    }

    // pass 2: TRIGGER constraints — the CARRIER OBJECT is the trigger zone,
    // and its kind defines the SHAPE: BOX/SPHERE/CYLINDER mesh primitives
    // test their actual (local-bounds) volume, PLANE fires on side-crossing
    // within its extent, everything else is a radius sphere at the origin.
    // Probes: FOLLOW_PATH/FOLLOW_STREAM travelers, legacy score cursors,
    // and every landmark of probe-enabled MM streams — so "right hand
    // enters a virtual box" is just a box mesh with a TRIGGER constraint.
    this.fired = [];
    const probes: { key: string; pos: THREE.Vector3 }[] = [...travelers];
    for (const [id, state] of score.states) {
      if (state.valid) probes.push({ key: `cursor:${id}`, pos: state.position });
    }
    for (const st of scene.mmStreams) {
      if (st.probeEvents === false || !st.visible) continue;
      const frame = streamStore.get(st.id);
      if (!frame?.count) continue;
      const m = streamWorldMatrix(scene, st);
      for (let i = 0; i < frame.count; i++) {
        probes.push({
          key: `mm:${st.id}:${i}`,
          pos: new THREE.Vector3(
            frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2],
          ).applyMatrix4(m),
        });
      }
    }

    const local = new THREE.Vector3();
    for (const ref of allRefs(scene)) {
      if (ref.kind === 'CANVAS') continue;
      for (const c of constraintsOf(scene, ref)) {
        if (!c.enabled || c.type !== 'TRIGGER') continue;
        const zoneCenter = worldPos(scene, ref);
        const radius = c.radius ?? 0.25;
        // shape from the carrier: primitive mesh = volume/plane, else sphere
        const mesh = ref.kind === 'MESH' ? scene.meshes.find((m) => m.id === ref.id) : undefined;
        const bounds = mesh && mesh.kind !== 'MODEL' ? meshLocalBounds(mesh) : null;
        const isPlane = mesh?.kind === 'PLANE';
        const inv = bounds ? worldMatrixOf(scene, ref).invert() : null;

        for (const probe of probes) {
          if (probe.key === `${ref.kind}:${ref.id}`) continue; // not itself
          const key = `${ref.kind}:${ref.id}:${c.id}:${probe.key}`;
          let inside: boolean;
          if (bounds && inv) {
            local.copy(probe.pos).applyMatrix4(inv);
            if (isPlane) {
              // crossing detector: sign of local z flips while inside the
              // plane's XY extent ("body part crosses a defined plane")
              const withinExtent = local.x >= bounds.min.x && local.x <= bounds.max.x
                && local.y >= bounds.min.y && local.y <= bounds.max.y;
              const side = local.z >= 0 ? 1 : -1;
              const sideKey = `${key}:side`;
              const lastSide = this.planeSide.get(sideKey);
              inside = withinExtent && lastSide !== undefined && lastSide !== side;
              if (withinExtent) this.planeSide.set(sideKey, side);
              else this.planeSide.delete(sideKey);
            } else {
              inside = local.x >= bounds.min.x && local.x <= bounds.max.x
                && local.y >= bounds.min.y && local.y <= bounds.max.y
                && local.z >= bounds.min.z && local.z <= bounds.max.z;
            }
          } else {
            inside = probe.pos.distanceTo(zoneCenter) < radius;
          }
          const wasInside = this.triggerInside.get(key) ?? false;
          const msgCtx = {
            id: c.id, name: c.name, probe: probe.key,
            x: +probe.pos.x.toFixed(4), y: +probe.pos.y.toFixed(4), z: +probe.pos.z.toFixed(4),
            t: 0,
          };
          if (inside && !wasInside) {
            const allowed = c.retrigger !== false || !this.triggerFired.has(key);
            if (allowed) {
              this.triggerFired.add(key);
              fireMessages(`constraint:${c.id}`, c.messages ?? [], msgCtx);
              this.fired.push({ ref, kind: 'enter' });
            }
          } else if (!inside && wasInside) {
            if (c.leaveMessages?.length) fireMessages(`constraint:${c.id}`, c.leaveMessages, msgCtx);
            this.fired.push({ ref, kind: 'leave' });
          }
          this.triggerInside.set(key, inside);
        }
      }
    }
  }
}

export const constraintEngine = new ConstraintEngine();
