import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewName = 'FRONT' | 'BACK' | 'RIGHT' | 'LEFT' | 'TOP' | 'BOTTOM';
export type UpAxis = 'Y' | 'Z';

/** [camera offset direction from target, view up] per world-up convention. */
export function viewDirs(up: UpAxis): Record<ViewName, [THREE.Vector3, THREE.Vector3]> {
  if (up === 'Z') {
    // Blender: front looks along +Y, top looks down -Z
    return {
      FRONT: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)],
      BACK: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
      RIGHT: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
      LEFT: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)],
      TOP: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
      BOTTOM: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)],
    };
  }
  return {
    FRONT: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
    BACK: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
    RIGHT: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    LEFT: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
    TOP: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)],
    BOTTOM: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)],
  };
}

/** One frame of first-person input, handed to a `walkDriver`. */
export interface WalkInput {
  /** heading in the up-frame, radians — 0 looks along the frame's -Z */
  yaw: number;
  pitch: number;
  /** currently-held keys: w/a/s/d/q/e/shift */
  keys: Set<string>;
  dt: number;
}

interface GizmoBall { x: number; y: number; z: number; view: ViewName; label: string; color: string }

/**
 * Viewport navigation: preset views with animated transitions, ortho/persp
 * toggle, manual orbit/pan/dolly (drives Blender-style Alt+LMB emulation and
 * numpad 2/4/6/8), flythrough mode, and the corner axis gizmo.
 */
/** Fly speed in metres per second, and the floor the wheel ratchet clamps
 *  to. The floor is 3% of the default, which is slow enough to read as
 *  "movement is broken" — so `onNotice` says the number out loud whenever
 *  the wheel changes it. */
const DEFAULT_FLY_SPEED = 3;
const FLY_SPEED_MIN = 0.1;

export class Navigation {
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  active: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls; // reassigned by the app when the up axis changes
  private canvas: HTMLCanvasElement;
  private aspect = 1;
  upAxis: UpAxis = 'Y';
  readonly up = new THREE.Vector3(0, 1, 0);

  // view transition animation
  private anim: {
    t: number; dur: number;
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    fromQuat: THREE.Quaternion; toQuat: THREE.Quaternion;
  } | null = null;

  // fly mode
  flying = false;
  private flyKeys = new Set<string>();
  private flySpeed = DEFAULT_FLY_SPEED;
  private yaw = 0;
  private pitch = 0;
  private flyStart = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private flyStopping = false; // deliberate exit in progress (Enter/click)
  /** whether this flight actually holds the pointer lock — see startFly */
  private lockHeld = false;
  onFlyChange: ((flying: boolean) => void) | null = null;
  /** One-line status messages (fly speed, a refused pointer lock). */
  onNotice: ((text: string) => void) | null = null;
  /**
   * Possession hook. Fly mode already owns the hard parts of a first-person
   * rig — pointer lock, mouse-look in the up-frame, WASD key state, and the
   * Esc-through-pointer-lock dance — so driving a CHARACTER reuses all of
   * it and only replaces the last step: instead of translating the camera,
   * the driver is handed the look angles and key state and decides where
   * both the character and the camera go. Set it BEFORE startFly().
   */
  walkDriver: ((input: WalkInput) => void) | null = null;

  // gizmo hit areas, rebuilt every draw
  private gizmoBalls: GizmoBall[] = [];
  gizmoCenter = { x: 0, y: 0, r: 40 };

  constructor(persp: THREE.PerspectiveCamera, controls: OrbitControls, canvas: HTMLCanvasElement) {
    this.persp = persp;
    this.active = persp;
    this.controls = controls;
    this.canvas = canvas;
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);

    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === this.canvas) { this.lockHeld = true; return; }
      // Esc is swallowed by pointer lock: losing a lock we actually HELD,
      // without a deliberate stopFly(), means the user cancelled -> teleport
      // back. A flight that never got a lock has nothing to lose here, and
      // must not be cancelled by someone else's lock ending.
      if (this.flying && this.lockHeld && !this.flyStopping) this.stopFly(false);
      this.lockHeld = false;
    });
    // A REFUSED lock fires this and NOT pointerlockchange, so without it
    // nothing ever learns the request failed — see `startFly`.
    document.addEventListener('pointerlockerror', () => {
      if (this.flying) this.lockRefused();
    });
    // A window that is not focused never delivers KEYUP, so a key held as
    // the mouse leaves stays held forever: the camera flies off on its own,
    // or — worse, because it looks like nothing rather than like a bug —
    // a stuck W silently cancels every S you press and movement reads as
    // dead. The key set is not state worth preserving across a blur.
    window.addEventListener('blur', () => { this.flyKeys.clear(); });
    document.addEventListener('mousemove', (e) => {
      if (!this.flying) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.flying) {
        this.flySpeed *= e.deltaY > 0 ? 0.85 : 1.18;
        this.flySpeed = Math.max(FLY_SPEED_MIN, Math.min(50, this.flySpeed));
        // SAY IT. This is a persistent scalar with no other display, and one
        // trackpad flick moves it 25 ticks — from 3 m/s to the floor, 3% of
        // normal, where it stays for the rest of the session. An invisible
        // number that a stray gesture can ratchet is a number that will one
        // day read as "the app broke".
        this.onNotice?.(`Fly speed ${this.flySpeed.toFixed(2)} m/s`
          + (this.flySpeed <= FLY_SPEED_MIN ? ' (slowest — scroll up to speed up)' : ''));
        e.preventDefault();
      }
    }, { passive: false });
  }

  setAspect(w: number, h: number): void {
    this.aspect = w / h;
    this.persp.aspect = this.aspect;
    this.persp.updateProjectionMatrix();
    this.syncOrthoFrustum();
  }

  private get target(): THREE.Vector3 { return this.controls.target; }
  private get distance(): number { return this.active.position.distanceTo(this.target); }

  private syncOrthoFrustum(): void {
    const halfH = this.distance * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.left = -halfH * this.aspect;
    this.ortho.right = halfH * this.aspect;
    this.ortho.updateProjectionMatrix();
  }

  get isOrtho(): boolean { return this.active === this.ortho; }

  setUpAxis(axis: UpAxis): void {
    this.upAxis = axis;
    this.up.set(0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0);
    this.persp.up.copy(this.up);
    this.ortho.up.copy(this.up);
    this.active.lookAt(this.target); // fix roll for the new convention
    this.controls.update();
  }

  /** Rotation taking the Y-up reference frame into the current up frame. */
  private frameQuat(): THREE.Quaternion {
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.up);
  }

  toggleOrtho(): void {
    if (this.flying) return;
    if (this.isOrtho) {
      // preserve apparent size: fold ortho.zoom into perspective distance
      const halfH = (this.ortho.top - this.ortho.bottom) / 2 / this.ortho.zoom;
      const dist = halfH / Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      const dir = this.ortho.position.clone().sub(this.target).normalize();
      this.persp.position.copy(this.target).addScaledVector(dir, dist);
      this.persp.quaternion.copy(this.ortho.quaternion);
      this.active = this.persp;
    } else {
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.ortho.zoom = 1;
      this.syncOrthoFrustum();
      this.active = this.ortho;
    }
    this.controls.object = this.active;
    this.controls.update();
  }

  snapView(view: ViewName): void {
    if (this.flying) return;
    const [dir, up] = viewDirs(this.upAxis)[view];
    const dist = this.distance;
    const toPos = this.target.clone().addScaledVector(dir, dist);
    const m = new THREE.Matrix4().lookAt(toPos, this.target, up);
    const toQuat = new THREE.Quaternion().setFromRotationMatrix(m);
    this.startAnim(toPos, toQuat);
  }

  /** Fit the view to a bounding box, keeping the current view direction. */
  frameAll(box: THREE.Box3): void {
    if (this.flying || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(0.5, sphere.radius);
    const dist = (radius / Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 1.25;
    let dir = this.active.position.clone().sub(this.target);
    if (dir.lengthSq() < 1e-9) dir = new THREE.Vector3(0, -1, 0.35);
    dir.normalize();
    this.target.copy(sphere.center);
    const toPos = sphere.center.clone().addScaledVector(dir, dist);
    const m = new THREE.Matrix4().lookAt(toPos, sphere.center, this.up);
    this.startAnim(toPos, new THREE.Quaternion().setFromRotationMatrix(m));
  }

  /** Flip to the opposite side of the current view (numpad 9). */
  flipView(): void {
    if (this.flying) return;
    const offset = this.active.position.clone().sub(this.target).negate();
    const toPos = this.target.clone().add(offset);
    const m = new THREE.Matrix4().lookAt(toPos, this.target, this.active.up);
    this.startAnim(toPos, new THREE.Quaternion().setFromRotationMatrix(m));
  }

  private startAnim(toPos: THREE.Vector3, toQuat: THREE.Quaternion): void {
    this.anim = {
      t: 0, dur: 0.25,
      fromPos: this.active.position.clone(), toPos,
      fromQuat: this.active.quaternion.clone(), toQuat,
    };
    this.controls.enabled = false;
  }

  orbitBy(dAzimuth: number, dPolar: number): void {
    // spherical math in the Y-up reference frame, transformed to/from world up
    const qFrame = this.frameQuat();
    const qInv = qFrame.clone().invert();
    const offset = this.active.position.clone().sub(this.target).applyQuaternion(qInv);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta -= dAzimuth;
    sph.phi = Math.max(0.001, Math.min(Math.PI - 0.001, sph.phi - dPolar));
    offset.setFromSpherical(sph).applyQuaternion(qFrame);
    this.active.position.copy(this.target).add(offset);
    this.active.up.copy(this.up);
    this.active.lookAt(this.target);
    this.controls.update();
  }

  panBy(dxPx: number, dyPx: number): void {
    const dist = this.distance;
    const h = this.canvas.clientHeight || 1;
    const factor = this.isOrtho
      ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h
      : (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / h;
    const right = new THREE.Vector3().setFromMatrixColumn(this.active.matrix, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(this.active.matrix, 1);
    const move = right.multiplyScalar(-dxPx * factor).add(upv.multiplyScalar(dyPx * factor));
    this.active.position.add(move);
    this.target.add(move);
    this.controls.update();
  }

  dollyBy(factor: number): void {
    if (this.isOrtho) {
      this.ortho.zoom = Math.max(0.05, this.ortho.zoom / factor);
      this.ortho.updateProjectionMatrix();
    } else {
      const offset = this.active.position.clone().sub(this.target).multiplyScalar(factor);
      this.active.position.copy(this.target).add(offset);
    }
    this.controls.update();
  }

  // -------------------------------------------------------------- fly mode

  /**
   * The lock was asked for and refused.
   *
   * Fly mode without pointer lock is the worst of both worlds and was the
   * cause of a real bug: the app believes it is flying, so `mousemove`
   * spins the view from a mouse that is free to wander off the window, and
   * every scroll is eaten by the fly-speed ratchet instead of zooming —
   * which drags `flySpeed` to its floor and leaves it there for the rest of
   * the session, since nothing else ever writes it. Stop, and say so.
   */
  private lockRefused(): void {
    this.lockHeld = false;
    this.onNotice?.('Flying without pointer lock — the cursor stays visible · Enter accepts, Esc cancels');
  }

  startFly(): void {
    if (this.flying) return;
    if (this.isOrtho) this.toggleOrtho();
    this.flying = true;
    this.flyStopping = false;
    this.flyStart.pos.copy(this.persp.position);
    this.flyStart.quat.copy(this.persp.quaternion);
    // yaw/pitch extracted in the up-frame so mouse-look works for any up axis
    const local = this.frameQuat().invert().multiply(this.persp.quaternion);
    const euler = new THREE.Euler().setFromQuaternion(local, 'YXZ');
    this.yaw = euler.y;
    this.pitch = euler.x;
    this.flyKeys.clear();
    this.controls.enabled = false;
    // requestPointerLock CAN FAIL, and the failure is silent: Chrome refuses
    // when the document is not focused and enforces a cooldown after an
    // Esc-driven exit ("requested too soon after exiting"), and an embedded
    // or previewing browser may not offer it at all. That is worth KNOWING
    // about — it is why the cursor can wander off mid-flight — but it is not
    // worth refusing to fly over: mouse-look reads `movementX/Y`, which a
    // free cursor still reports, so the mode degrades rather than breaking.
    // It returns a promise in current browsers and undefined in older ones,
    // so both paths are handled, and `pointerlockerror` covers the rest.
    this.lockHeld = false;
    const req = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    req?.catch?.(() => { if (this.flying) this.lockRefused(); });
    this.onFlyChange?.(true);
  }

  /**
   * Blender semantics: Enter/click accepts the new position; Esc cancels
   * and teleports back to where the flyover started (inspect, don't move).
   */
  stopFly(accept = true): void {
    if (!this.flying) return;
    this.flying = false;
    this.flyStopping = true;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (!accept) {
      this.persp.position.copy(this.flyStart.pos);
      this.persp.quaternion.copy(this.flyStart.quat);
    }
    // rebuild an orbit target ahead of the camera
    const fwd = this.persp.getWorldDirection(new THREE.Vector3());
    this.target.copy(this.persp.position).addScaledVector(fwd, 4);
    this.controls.enabled = true;
    this.controls.update();
    this.flyStopping = false;
    this.onFlyChange?.(false);
  }

  /** Returns true if the key was consumed by fly mode. */
  handleFlyKey(e: KeyboardEvent, down: boolean): boolean {
    if (!this.flying) return false;
    const k = e.key.toLowerCase();
    if (down && e.key === 'Escape') { this.stopFly(false); return true; }
    if (down && e.key === 'Enter') { this.stopFly(true); return true; }
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) {
      down ? this.flyKeys.add(k) : this.flyKeys.delete(k);
      return true;
    }
    return down; // swallow everything else while flying
  }

  update(dt: number): void {
    if (this.anim) {
      this.anim.t += dt;
      const k = Math.min(1, this.anim.t / this.anim.dur);
      const e = k * k * (3 - 2 * k);
      this.active.position.lerpVectors(this.anim.fromPos, this.anim.toPos, e);
      this.active.quaternion.slerpQuaternions(this.anim.fromQuat, this.anim.toQuat, e);
      if (k >= 1) {
        this.anim = null;
        this.controls.enabled = true;
        this.controls.update();
        if (this.isOrtho) this.syncOrthoFrustum();
      }
      return;
    }
    if (this.flying) {
      const cam = this.persp;
      cam.quaternion.copy(this.frameQuat())
        .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')));
      // possessed: the driver moves a body, not the camera. The orientation
      // above still applies — it IS the aim — so the driver only has to
      // place the camera relative to whatever it drives.
      if (this.walkDriver) {
        this.walkDriver({ yaw: this.yaw, pitch: this.pitch, keys: this.flyKeys, dt });
        return;
      }
      const speed = this.flySpeed * (this.flyKeys.has('shift') ? 3 : 1) * dt;
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
      if (this.flyKeys.has('w')) cam.position.addScaledVector(fwd, speed);
      if (this.flyKeys.has('s')) cam.position.addScaledVector(fwd, -speed);
      if (this.flyKeys.has('a')) cam.position.addScaledVector(right, -speed);
      if (this.flyKeys.has('d')) cam.position.addScaledVector(right, speed);
      if (this.flyKeys.has('e')) cam.position.addScaledVector(this.up, speed);
      if (this.flyKeys.has('q')) cam.position.addScaledVector(this.up, -speed);
    }
  }

  // ---------------------------------------------------------------- gizmo

  drawGizmo(g: CanvasRenderingContext2D, viewW: number): void {
    const R = 38;
    const cx = viewW - R - 14, cy = R + 14;
    this.gizmoCenter = { x: cx, y: cy, r: R + 10 };
    this.gizmoBalls = [];

    const q = this.active.quaternion.clone().invert();
    // clicking a ball places the camera along that axis — view names depend
    // on the world-up convention
    const axes: [THREE.Vector3, ViewName, ViewName, string, string][] = this.upAxis === 'Z'
      ? [
        [new THREE.Vector3(1, 0, 0), 'RIGHT', 'LEFT', 'X', '#e5605e'],
        [new THREE.Vector3(0, 1, 0), 'BACK', 'FRONT', 'Y', '#7db32b'],
        [new THREE.Vector3(0, 0, 1), 'TOP', 'BOTTOM', 'Z', '#4f8cff'],
      ]
      : [
        [new THREE.Vector3(1, 0, 0), 'RIGHT', 'LEFT', 'X', '#e5605e'],
        [new THREE.Vector3(0, 1, 0), 'TOP', 'BOTTOM', 'Y', '#7db32b'],
        [new THREE.Vector3(0, 0, 1), 'FRONT', 'BACK', 'Z', '#4f8cff'],
      ];
    for (const [axis, posView, negView, label, color] of axes) {
      const v = axis.clone().applyQuaternion(q);
      this.gizmoBalls.push({ x: cx + v.x * R, y: cy - v.y * R, z: v.z, view: posView, label, color });
      this.gizmoBalls.push({ x: cx - v.x * R, y: cy + v.y * R, z: -v.z, view: negView, label: `-${label}`, color });
    }
    this.gizmoBalls.sort((a, b) => a.z - b.z);

    g.save();
    g.beginPath();
    g.arc(cx, cy, R + 10, 0, Math.PI * 2);
    g.fillStyle = 'rgba(30,30,34,0.45)';
    g.fill();
    for (const b of this.gizmoBalls) {
      // axis line for positive balls
      if (!b.label.startsWith('-')) {
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(b.x, b.y);
        g.strokeStyle = b.color;
        g.lineWidth = 1.5;
        g.globalAlpha = 0.8;
        g.stroke();
      }
      const front = b.z >= 0;
      g.globalAlpha = front ? 1 : 0.45;
      g.beginPath();
      g.arc(b.x, b.y, 7, 0, Math.PI * 2);
      g.fillStyle = front ? b.color : '#2c2c31';
      g.fill();
      if (!front) { g.strokeStyle = b.color; g.lineWidth = 1.2; g.stroke(); }
      if (front && !b.label.startsWith('-')) {
        g.fillStyle = '#111';
        g.font = 'bold 9px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(b.label, b.x, b.y + 0.5);
      }
    }
    g.globalAlpha = 1;
    // ortho/persp indicator
    g.fillStyle = '#9a9aa2';
    g.font = '9px sans-serif';
    g.textAlign = 'center';
    g.fillText(this.isOrtho ? 'ortho' : 'persp', cx, cy + R + 20);
    g.restore();
  }

  /** Is the point inside the gizmo disc? (drag there = trackball orbit) */
  inGizmo(x: number, y: number): boolean {
    const { x: cx, y: cy, r } = this.gizmoCenter;
    return Math.hypot(x - cx, y - cy) <= r;
  }

  /** Axis ball under the point, or null (empty disc area). */
  gizmoBallAt(x: number, y: number): ViewName | null {
    let best: GizmoBall | null = null;
    let bestD = 12;
    for (const b of this.gizmoBalls) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best ? best.view : null;
  }
}
