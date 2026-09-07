
// A stock, fully virtual gallery scene: room, props, cameras, and a visitor
// walking a loop — so an installation can be blocked out, wired and tested
// entirely with simulated sources, then have any ONE piece swapped for a
// real input (a photo plane, a splat scan, a live webcam) with nothing else
// changing. That swap is the point: every consumer downstream of a stream
// (zones, routes, clips) already can't tell a simulated source from a real
// one — see actor/simstream.ts — so this file's only job is to put a
// working example of each piece in front of you.
//
// Deliberately code, not a saved .json asset: it should stay in sync with
// whatever the current data shapes are (a saved file would silently rot the
// moment a field is added), and reading it is the fastest way to see a
// worked example of every piece it touches — a room, a walk path, a rigged
// actor on it, a security camera, a driven POSE stream, a driven DETECT
// stream, and a trigger zone.
import * as THREE from 'three';
import type { GPScene, TGConstraint, Vec3 } from '../core/types';
import {
  createDefaultCamera, createFrame, createObject, createPoint, createScene,
  createStroke, genId,
} from '../core/gpdata';
import { createMeshObject } from '../render/meshes';
import { createPaintCloud } from '../render/paintclouds';
import { createHumanoid } from '../actor/skeleton';
import type { TGActor } from '../core/types';
import type { Step } from '../actor/behaviour';
import { defaultBody } from '../actor/props';
import { createConstraint } from '../score/constraints';
import { createStream } from '../mm/streams';

export interface DemoWiring {
  /** the goal-driven second visitor, scripted by the caller */
  wandererId?: number;
  /** the stick figure, on its own shorter round */
  sketcherId?: number;
  scene: GPScene;
  /** ids the caller needs to wire the RUNTIME sim drivers, which live
   *  outside GPScene (they are live wiring, not document state — see
   *  App.setStreamDriver) */
  actorId: number;
  poseStreamId: number;
  detectStreamId: number;
  /** index into scene.cameras of the security cam the streams are driven
   *  through */
  camIndex: number;
}

/** Aim a scene camera at a point and return its rotation as the plain Euler
 *  GPCamera stores — matching exactly how App.applyCameraPose consumes it
 *  (a raw quaternion built from this Euler, copied onto a real THREE
 *  camera), so a camera built this way looks where it's told to on the
 *  first render rather than needing a manual nudge. */
function lookRotation(from: Vec3, at: Vec3, upZ: boolean): Vec3 {
  // MUST be a camera, not a plain Object3D. Object3D.lookAt branches on
  // `isCamera`: a camera is oriented so -Z faces the target (the direction
  // it actually looks), everything else so +Z does. Building this with a
  // bare Object3D yields a camera rotated 180 degrees — pointed at the wall
  // behind it — which reads as "tracking silently never sees anything"
  // rather than as an obviously wrong transform.
  const obj = new THREE.PerspectiveCamera();
  obj.position.set(...from);
  obj.up.set(0, upZ ? 0 : 1, upZ ? 1 : 0);
  obj.lookAt(new THREE.Vector3(...at));
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
  return [e.x, e.y, e.z];
}

/**
 * A procedural stand-in for a 3D scan: points scattered over the room's
 * floor and walls, packed as a paint cloud.
 *
 * The scan input needs a virtual placeholder like every other input does.
 * A real Kiri/splat capture arrives as noisy, unevenly-dense surface points
 * with colour, so that is what this fakes — jittered off the surface rather
 * than laid on a clean lattice, because the whole reason to test against a
 * scan is that scans are messy. Uses TGPaintCloud, which already renders
 * per-point colour/size and exports real 3DGS PLY, so this is the same
 * container a genuine scan-derived cloud lands in.
 */
function roomScanPoints(w: number, d: number, h: number, upZ: boolean): number[] {
  const pts: number[] = [];
  // deterministic jitter: a fixed LCG, so the placeholder is identical
  // every load and a bug is reproducible rather than reshuffling each time
  let seed = 1337;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const push = (x: number, y: number, z: number, c: Vec3): void => {
    const p: Vec3 = upZ ? [x, y, z] : [x, z, -y];
    pts.push(p[0], p[1], p[2], 0.012 + rnd() * 0.01, c[0], c[1], c[2], 1);
  };
  const N_FLOOR = 2600, N_WALL = 900;
  for (let i = 0; i < N_FLOOR; i++) {
    const g = 0.42 + rnd() * 0.1;
    push((rnd() - 0.5) * w, (rnd() - 0.5) * d, rnd() * 0.012, [g, g * 0.97, g * 0.92]);
  }
  for (const [ax, sign] of [[0, 1], [0, -1], [1, 1], [1, -1]] as [number, number][]) {
    for (let i = 0; i < N_WALL; i++) {
      const t = (rnd() - 0.5);
      const up = rnd() * h;
      const g = 0.72 + rnd() * 0.12;
      const jitter = (rnd() - 0.5) * 0.03;
      if (ax === 0) push(t * w, (sign * d) / 2 + jitter, up, [g, g, g * 0.96]);
      else push((sign * w) / 2 + jitter, t * d, up, [g, g, g * 0.96]);
    }
  }
  return pts;
}

/**
 * The Walker's route: a hand-authored circuit that threads the gallery.
 *
 * NOT an oval any more, and it cannot be. A FOLLOW_PATH constraint sets the
 * transform outright — it does not collide with anything, because collision
 * belongs to the walking body that steering and possession share. So a path
 * IS the author's promise that the route is walkable, and the previous oval
 * quietly broke that promise: measured against the props, it passed through
 * the ziggurat, the stairs, the platform and a column.
 *
 * These points were checked against every prop's footprint plus the walker's
 * own body radius. If you move the furniture, re-check the route.
 */
function walkLoopPoints(): Vec3[] {
  return [
    [-3.6, -2.6, 0], [-3.6, 1.0, 0], [-2.6, 3.6, 0], [0.6, 4.2, 0],
    [3.2, 3.4, 0], [3.4, 1.4, 0], [2.6, -0.2, 0], [2.0, -1.8, 0],
    [0.4, -2.9, 0], [-1.6, -3.2, 0], [-3.2, -3.2, 0],
  ];
}

/**
 * What the goal-driven visitor intends to do, in its own words.
 *
 * A tour of the things the scene is built to exercise: open-floor steering,
 * walking around furniture, climbing the ziggurat, taking the ramp up to the
 * platform and the stairs back down, and standing still long enough for the
 * idle to show. Every line is spoken at the moment the goal is set, so the
 * log cannot drift from what is actually happening.
 */
/**
 * The stick figure's round: shorter than the Wanderer's, and deliberately
 * overlapping it — two scripted characters that have to share a floor is a
 * more honest test than two that never meet.
 */
export function sketcherScript(upAxisZ: boolean): Step[] {
  const P = (x: number, y: number, up = 0): Vec3 => (upAxisZ ? [x, y, up] : [x, up, y]);
  return [
    { say: 'Standing where I can see the whole room.', goto: P(6.5, -5.0), style: 'walk' },
    { say: 'This angle, I think.', face: P(0, 0) },
    { say: 'Holding still while I get the proportions.', wait: 2.4 },
    { say: 'Closer, for the columns.', goto: P(2.2, -1.6), style: 'walk' },
    { say: 'Blocking it in.', perform: 'a person waving one arm slowly', hold: 3.0 },
    { say: 'And round the other side.', goto: P(-2.0, -6.0), style: 'walk' },
    { say: 'That will do for now.', face: P(0, 2) },
  ];
}

export function wandererScript(upAxisZ: boolean): Step[] {
  const P = (x: number, y: number, up = 0): Vec3 => (upAxisZ ? [x, y, up] : [x, up, y]);
  return [
    { say: 'Let me have a look at the piece on the far plinth.',
      goto: P(-5.5, 2.0), style: 'walk' },
    { say: 'Standing here a moment.', wait: 3 },

    { say: 'I want to see the room from higher up \u2014 the ziggurat first.',
      goto: P(6.0, -3.5, 1.7), style: 'walk' },
    { say: 'Made it to the top. Looking back across the gallery.',
      face: P(-6.0, 4.0) },
    { say: 'Nobody is watching. A little dance, then.',
      perform: 'dancing on the spot', hold: 7, seconds: 4 },

    { say: 'Back down, and around the columns.', goto: P(-4.0, -5.0), style: 'walk' },
    { say: 'Now the ramp up to the platform.', goto: P(-7.0, 3.5), style: 'sneak' },
    { say: 'Up the slope.', goto: P(-7.0, 5.6, 1.8), style: 'walk' },
    { say: 'On the platform. Turning to face the projection.',
      face: P(1.5, 8.6) },
    { say: 'Watching for a bit.', wait: 4 },
    { say: 'Waving at whoever is on the other side of that screen.',
      perform: 'waving hello', hold: 6, seconds: 3 },

    { say: 'Down the stairs on the east side.', goto: P(-1.0, 6.2, 1.8), style: 'walk' },
    { say: 'And back to the floor.', goto: P(2.0, 6.2), style: 'walk' },

    { say: 'Round to the front of the partition.', goto: P(1.5, 7.4), style: 'walk' },
    { say: 'Facing it properly.', face: P(1.5, 9.4) },
    { say: 'Seeing how long I can hold this.',
      perform: 'standing on one leg, balancing', hold: 8, seconds: 4 },
    { say: 'Both arms up, then. Stretching it out.',
      perform: 'stretching, both arms up', hold: 5, seconds: 3 },

    { say: 'Circling round to the bench.', goto: P(0, -6.0), style: 'shuffle' },
    { say: 'Sitting this one out.', wait: 5 },
    { say: 'Round again.', goto: P(4.0, -8.0), style: 'walk' },
  ];
}

/**
 * The same gallery, plus a floor full of things that fall over.
 *
 * A second scene rather than more props in the first: the demo scene is
 * about a character reading a SPACE, and this one is about a character
 * disturbing it. Mixing them would make both harder to watch.
 */
export function buildPlaygroundScene(upAxisZ: boolean): DemoWiring {
  const wiring = buildDemoScene(upAxisZ);
  const { scene } = wiring;
  const at = (x: number, y: number, up: number): Vec3 =>
    (upAxisZ ? [x, y, up] : [x, up, y]);
  // the gallery already filed itself into categories; join the right one
  const propsGroup = scene.meshes.find((m) => m.kind === 'EMPTY' && m.name === 'Props');

  const loose = (
    kind: 'SPHERE' | 'BOX' | 'TETRA' | 'OCTA' | 'DODECA' | 'ICOSA',
    name: string, x: number, y: number, size: number, color: Vec3,
  ): void => {
    const m = createMeshObject(genId(), kind, at(x, y, size * 0.5 + 0.02));
    if (propsGroup) m.parent = { kind: 'MESH', id: propsGroup.id };
    m.name = name;
    m.scale = [size, size, size];
    m.color = color;
    m.drawTarget = true;
    m.body = defaultBody(size * 0.5);
    scene.meshes.push(m);
  };

  // Ten balls, deliberately across a wide size range: the mass model is
  // roughly volume, so the small ones scatter off a shin while the big one
  // has to be leaned into. That contrast is the whole demonstration.
  const balls: [number, number, number][] = [
    [-2.2, -1.0, 0.30], [-1.4, -1.6, 0.42], [-0.5, -0.9, 0.24],
    [0.3, -1.8, 0.55], [1.1, -1.1, 0.34], [1.9, -2.0, 0.28],
    [-2.6, -2.4, 0.66], [0.0, -0.3, 0.20], [2.6, -1.4, 0.48],
    [-1.0, -2.8, 0.38],
  ];
  const hue: Vec3[] = [
    [0.85, 0.35, 0.30], [0.35, 0.50, 0.80], [0.90, 0.70, 0.28],
    [0.40, 0.72, 0.50], [0.70, 0.42, 0.78],
  ];
  balls.forEach(([x, y, d], i) => loose('SPHERE', `Ball ${i + 1}`, x, y, d, hue[i % hue.length]));

  // ...and the solids, which behave the same way and look like they should
  // not, which is exactly the honest limit of a sphere-only simulation.
  loose('BOX', 'Crate', 3.4, -3.0, 0.7, [0.72, 0.60, 0.44]);
  loose('TETRA', 'Tetrahedron', -3.6, -0.4, 0.6, [0.85, 0.55, 0.35]);
  loose('OCTA', 'Octahedron', 2.2, 0.4, 0.6, [0.45, 0.70, 0.85]);
  loose('DODECA', 'Dodecahedron', -3.2, 1.4, 0.66, [0.80, 0.45, 0.60]);
  loose('ICOSA', 'Icosahedron', 0.9, 1.2, 0.58, [0.55, 0.75, 0.45]);

  return wiring;
}

export function buildDemoScene(upAxisZ: boolean): DemoWiring {
  const scene = createScene();

  // ---- room shell: floor + four walls -----------------------------------
  // 20 x 20 x 5 m — real dimensions, since 1 unit = 1 metre is the scene's
  // own convention (see the measure tool). A gallery-sized box rather than a
  // room-sized one: the point of the demo is walking a space with things in
  // it, and at 7 x 5 the visitor crossed the whole floor in four strides.
  //
  // The perimeter walls are WIREFRAME. A solid box you are standing outside
  // of is just a grey rectangle — you cannot see the thing you are staging.
  // Wireframe keeps the walls present for collision and for placing
  // projections against, while leaving the space readable from any angle.
  const ROOM_W = 20, ROOM_D = 20, ROOM_H = 5;
  const wallColor: Vec3 = [0.86, 0.85, 0.81];
  const room: ReturnType<typeof createMeshObject>[] = [];
  const addWall = (name: string, at: Vec3, rot: Vec3, w: number, h: number): void => {
    const id = genId();
    const m = createMeshObject(id, 'PLANE', at);
    m.name = name;
    m.rotation = rot;
    // PlaneGeometry is 2x2 (see render/meshes.ts), so a plane's scale is its
    // HALF size. Passing the full size here made the demo room exactly twice
    // its stated dimensions — invisible in a screenshot of a big empty room,
    // but the scan placeholder and the walk loop are both authored at the
    // real 7 x 5 m and sat well inside the walls.
    m.scale = [w / 2, h / 2, 1];
    m.color = wallColor;
    m.unlit = false;
    m.doubleSided = true;
    m.drawTarget = true;
    m.wireframe = name !== 'Floor';
    room.push(m);
  };
  if (upAxisZ) {
    // Stand the plane up with Rx(90), THEN spin it about the (now vertical)
    // Y of the tilted frame — which in XYZ Euler order (Rx.Ry.Rz) is simply
    // (90, yaw, 0). Putting the yaw in the Z slot instead applies it FIRST,
    // which tips the east/west walls onto their sides: they end up spanning
    // the room's height in X and its width in Z, i.e. a plane slicing
    // through the middle of the room rather than a wall at its edge.
    addWall('Floor', [0, 0, 0], [0, 0, 0], ROOM_W, ROOM_D);
    addWall('Wall North', [0, ROOM_D / 2, ROOM_H / 2], [Math.PI / 2, 0, 0], ROOM_W, ROOM_H);
    addWall('Wall South', [0, -ROOM_D / 2, ROOM_H / 2], [Math.PI / 2, Math.PI, 0], ROOM_W, ROOM_H);
    addWall('Wall East', [ROOM_W / 2, 0, ROOM_H / 2], [Math.PI / 2, -Math.PI / 2, 0], ROOM_D, ROOM_H);
    addWall('Wall West', [-ROOM_W / 2, 0, ROOM_H / 2], [Math.PI / 2, Math.PI / 2, 0], ROOM_D, ROOM_H);
  } else {
    addWall('Floor', [0, 0, 0], [-Math.PI / 2, 0, 0], ROOM_W, ROOM_D);
    addWall('Wall North', [0, ROOM_H / 2, ROOM_D / 2], [0, Math.PI, 0], ROOM_W, ROOM_H);
    addWall('Wall South', [0, ROOM_H / 2, -ROOM_D / 2], [0, 0, 0], ROOM_W, ROOM_H);
    addWall('Wall East', [ROOM_W / 2, ROOM_H / 2, 0], [0, -Math.PI / 2, 0], ROOM_D, ROOM_H);
    addWall('Wall West', [-ROOM_W / 2, ROOM_H / 2, 0], [0, Math.PI / 2, 0], ROOM_D, ROOM_H);
  }

  // ---- the installations -------------------------------------------------
  // A gallery, not an obstacle course: a handful of things with clear space
  // between them, so there is somewhere to walk TO and something to walk
  // AROUND. Everything here is a primitive with real bounds, which is what
  // makes it collide and what makes it stand on.
  const props: ReturnType<typeof createMeshObject>[] = [];
  /** place in the scene's up-axis convention: (x, y) is the floor plane. */
  const at = (x: number, y: number, up: number): Vec3 =>
    (upAxisZ ? [x, y, up] : [x, up, y]);
  /** size in the scene's up-axis convention. */
  const size = (w: number, d: number, h: number): Vec3 =>
    (upAxisZ ? [w, d, h] : [w, h, d]);

  const prop = (
    kind: 'BOX' | 'CYLINDER' | 'SPHERE' | 'PYRAMID' | 'PLANE',
    name: string, pos: Vec3, sc: Vec3, color: Vec3,
  ): ReturnType<typeof createMeshObject> => {
    const m = createMeshObject(genId(), kind, pos);
    m.name = name;
    m.scale = sc;
    m.color = color;
    m.drawTarget = true;
    props.push(m);
    return m;
  };

  const stone: Vec3 = [0.93, 0.92, 0.90];
  const plinth: Vec3 = [0.88, 0.87, 0.85];
  const screen: Vec3 = [0.20, 0.21, 0.24];

  // Two plinths, as before — the pieces the visitor is here to look at.
  prop('BOX', 'Plinth A', at(-5.5, 2.0, 0.55), size(0.5, 0.5, 1.1), plinth);
  prop('BOX', 'Plinth B', at(8.2, 1.2, 0.55), size(0.5, 0.5, 1.1), plinth);

  // A bench: low enough to sit on, which for a character means low enough to
  // STEP onto — 0.45 is under the 0.35 step height plus a bit of leg, so the
  // walker treats it as ground rather than as a wall.
  prop('BOX', 'Bench', at(0, -6.5, 0.22), size(2.4, 0.5, 0.45), plinth);

  // Two free-standing partitions. These are the projection surfaces: solid,
  // double-sided, dark enough that a projected image would read on them.
  // Clear of the platform and the stairs: it used to sit across both, which
  // is what made the top of the room unreadable.
  const p1 = prop('BOX', 'Partition (projection)', at(1.5, 8.6, 1.6), size(6.0, 0.2, 3.2), screen);
  p1.doubleSided = true;
  const p2 = prop('BOX', 'Partition (projection) 2', at(4.5, -7.5, 1.6), size(5.0, 0.2, 3.2), screen);
  p2.doubleSided = true;

  // Columns, floor to ceiling.
  //
  // NOTE the rotation, which is not optional. Primitive geometries are
  // authored Y-UP (three's convention): CylinderGeometry's axis and
  // ConeGeometry's apex both run along +Y. In a Z-up scene an UNROTATED
  // cylinder therefore lies on its side, and scaling it "tall" widens the
  // disc instead — which is exactly what these were, 4 m saucers lying on
  // the floor. Stand them up with +90 degrees about X, and remember that
  // scale is then in the primitive's OWN axes: Y is the height.
  const upright: Vec3 = upAxisZ ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  const COLUMN_H = 4.8;
  for (const [name, x, y] of [
    ['Column A', -6.0, -5.0], ['Column B', -2.0, -5.0], ['Column C', 2.0, -5.0],
  ] as [string, number, number][]) {
    const c = prop('CYLINDER', name, at(x, y, COLUMN_H / 2),
      [0.62, COLUMN_H / 1.2, 0.62], stone);
    c.rotation = upright;
  }

  const pyr = prop('PYRAMID', 'Pyramid', at(7.0, 7.0, 1.1), [2.6, 2.2, 2.6], stone);
  pyr.rotation = upright;

  // Balls. NOTE: these do not roll — there is no rigid-body simulation for
  // props, only the actor's own collision against their bounds. They are
  // scenery you can walk around, and a target for "go to that object".
  prop('SPHERE', 'Ball', at(0.2, 1.4, 0.45), size(0.9, 0.9, 0.9), [0.80, 0.35, 0.30]);
  prop('SPHERE', 'Ball 2', at(1.3, 0.4, 0.30), size(0.6, 0.6, 0.6), [0.35, 0.45, 0.75]);

  // ---- the ziggurat: a snub pyramid you can actually climb ---------------
  // A smooth frustum would be a lie here. Collision tests world AABBs, so a
  // tapered solid presents one box and the character would stand on thin air
  // out at its corners. Tiers are honest: each is a real ledge, each riser
  // is inside the step height, and the shape still reads as a snub pyramid
  // from across the room.
  const ZIG_TIERS = 5;
  const ZIG_RISE = 0.34;
  for (let i = 0; i < ZIG_TIERS; i++) {
    const w = 5.2 - i * 0.9;
    const top = ZIG_RISE * (i + 1);
    prop('BOX', `Ziggurat ${i + 1}`, at(6.0, -3.5, top / 2), size(w, w, top), plinth);
  }

  // ---- ramp and stairs ---------------------------------------------------
  // Both are built as STACKED BOXES rather than as one tilted slab, and that
  // is a deliberate consequence of how collision works here: the walking
  // body tests world-space AABBs, so a rotated ramp would present one flat
  // top at its highest point and the character would step onto the whole
  // thing at once. Stepping is the rule that already works — anything whose
  // top is within a step height counts as ground — so a ramp is simply a
  // staircase with risers too small to notice, and a staircase is the same
  // construction with honest ones.
  const RAMP_STEPS = 12;
  const RAMP_RISE = 1.8 / RAMP_STEPS;      // 0.15 m — reads as a slope
  const RAMP_RUN = 0.55;
  for (let i = 0; i < RAMP_STEPS; i++) {
    const top = RAMP_RISE * (i + 1);
    prop('BOX', `Ramp ${i + 1}`,
      at(-7.0, -1.0 + i * RAMP_RUN, top / 2),
      size(2.2, RAMP_RUN, top), plinth);
  }
  const STAIR_STEPS = 6;
  const STAIR_RISE = 1.8 / STAIR_STEPS;    // 0.30 m — a real stair
  for (let i = 0; i < STAIR_STEPS; i++) {
    const top = STAIR_RISE * (i + 1);
    // ascending in -x so the top step lands against the platform's edge;
    // stairs that stop short of what they climb to are just furniture
    prop('BOX', `Stair ${i + 1}`,
      // the top step OVERLAPS the platform edge. A 7.5 cm gap between them
      // is invisible and completely impassable: the walker sees floor level
      // under that sliver, reads a 1.8 m drop, and refuses to cross.
      at(-0.5 - i * 0.35, 6.2, top / 2),
      size(0.35, 2.4, top), plinth);
  }
  // The raised platform both approaches arrive at, sized to MEET them both:
  // west to -8.1 so the ramp's full width lands on it, east to -2.4 so the
  // top stair overlaps its edge. A platform that stops short of what climbs
  // to it is a 1.8 m drop the walker will (correctly) refuse to cross.
  prop('BOX', 'Platform', at(-5.25, 6.2, 0.9), size(5.7, 3.2, 1.8), plinth);

  // ---- an interactive zone: a proximity bubble beside Pedestal A, so the
  // demo shows a probe firing as the walking visitor passes, exactly the way
  // a real installation reacts to someone approaching an exhibit.
  //
  // The carrier is an EMPTY, NOT the pedestal box, and that matters: the
  // constraint engine takes a zone's SHAPE from its carrier, and for a
  // primitive mesh (box/sphere/cylinder) it tests that primitive's own
  // bounds and ignores `radius` entirely. Hanging this off the pedestal
  // therefore produced a zone the size of the pedestal — the visitor walked
  // past 0.8 units away and nothing ever fired. An EMPTY has no bounds, so
  // it falls through to the sphere test where `radius` is the thing that
  // actually decides. Kept at floor level to match where the walking
  // visitor's root probe is.
  const zoneObj = createMeshObject(genId(), 'EMPTY', at(-5.5, 2.0, 0));
  zoneObj.name = 'Zone · near Plinth A';
  const zone: TGConstraint = createConstraint('TRIGGER');
  // `{name}` substitutes the CONSTRAINT's name into the address, so the name
  // has to be OSC-safe: no spaces, since an OSC address pattern is
  // whitespace-delimited on the wire and 'near Pedestal A' would split into
  // an address plus a stray argument at the far end.
  zone.name = 'pedestalA';
  zone.radius = 1.6;
  zone.messages = [{ address: '/gallery/enter/{name}', argExprs: ['{x}', '{y}', '{z}'] }];
  zone.leaveMessages = [{ address: '/gallery/leave/{name}', argExprs: ['1'] }];
  zoneObj.constraints = [zone];

  // ---- the walk path: a GP stroke loop the visitor follows ----
  const pathObj = createObject('Walk Path');
  const pathLayer = pathObj.layers[0];
  const frame = createFrame(1);
  const stroke = createStroke(4, 3); // material 4 = Stroke Blue, seeded by createObject
  stroke.cyclic = true;
  for (const p of walkLoopPoints()) stroke.points.push(createPoint(p));
  frame.strokes.push(stroke);
  pathLayer.frames.push(frame);

  // ---- two visitors --------------------------------------------------
  // TWO on purpose. One walks a fixed route, the other is given goals and
  // finds its own way — the two halves of how a character can be driven,
  // side by side and running at once, which is the thing that is hard to
  // believe until you watch them share a room.
  const makeVisitor = (name: string, at0: Vec3, look: NonNullable<TGActor['look']>,
    color: Vec3): TGActor => {
    const a = createHumanoid(genId(), name, upAxisZ);
    a.translation = at0;
    a.physics.enabled = true;
    a.physics.tone = 0.08;   // holds a walking stance rather than ragdolling
    if (a.gait) a.gait.enabled = true;
    a.look = look;
    a.color = color;
    return a;
  };

  // Walker: on rails, following the drawn loop.
  const walker = makeVisitor('Walker', at(-7.0, 0, 0), 'WOOD', [0.78, 0.58, 0.34]);
  const follow = createConstraint('FOLLOW_PATH');
  follow.path = { objectIndex: 1, layerId: pathLayer.id, strokeId: stroke.id }; // index 1: pathObj is scene.objects[1]
  // Phase is a fraction of the loop per second, so it must be re-derived
  // whenever the route changes: this circuit is 24.2 m around, and 0.0476 of
  // it per second is a ~1.15 m/s walk.
  follow.speed = 0.0476;
  follow.loop = 'LOOP';
  follow.running = true;
  follow.orient = true;
  walker.constraints = [follow];

  // Wanderer: no path at all. It is handed goals by a behaviour script and
  // has to steer, climb and avoid its own way there.
  const wanderer = makeVisitor('Wanderer', at(4.0, -8.0, 0), 'CLAY', [0.91, 0.70, 0.58]);
  // A third register: drawn rather than modelled. Unlit and thin, it reads
  // as a diagram standing in a room of solids — which is the point of having
  // looks at all, and it survives every scene style (a line drawing of a
  // line drawing is still a line drawing).
  const sketcher = makeVisitor('Sketcher', at(7.0, -6.0, 0), 'MINIMAL', [0.16, 0.16, 0.2]);

  // ---- the security camera: a fixed, elevated corner camera looking
  // across the room — the "installed webcam" the sim streams are seen
  // through, independent of wherever the user's own viewport is pointed ----
  const camAt: Vec3 = upAxisZ ? [-ROOM_W / 2 + 0.4, -ROOM_D / 2 + 0.4, ROOM_H - 0.3]
    : [-ROOM_W / 2 + 0.4, ROOM_H - 0.3, -ROOM_D / 2 + 0.4];
  const secCam = createDefaultCamera('Security Cam 1');
  secCam.translation = camAt;
  secCam.rotation = lookRotation(camAt, [0, 0, upAxisZ ? 0.9 : 0.9], upAxisZ);
  secCam.fov = 70; // wider than a portrait lens — a fixed room camera, not a cinema shot

  // ---- streams: a POSE stream (full skeleton) and a DETECT stream (one
  // tracked point) — both CAMERA-source so they read exactly like a real
  // capture would, both left to the caller to wire to the security camera
  // via App.setStreamDriver (that wiring is runtime state, not scene data)
  const poseStream = createStream(scene, 'POSE', 'CAMERA', upAxisZ ? 'Z' : 'Y');
  poseStream.name = 'Security Cam · Pose (sim)';
  // 33 landmarks per frame onto the event bus is a firehose that buries the
  // zone messages this demo exists to show. Streams still PROBE zones with
  // emitBus off — that is a separate switch — so the demo loses nothing but
  // noise. Turn it back on in the stream row to see raw landmark traffic.
  poseStream.emitBus = false;
  scene.mmStreams.push(poseStream);
  const detectStream = createStream(scene, 'DETECT', 'CAMERA', upAxisZ ? 'Z' : 'Y');
  detectStream.name = 'Security Cam · Detect (sim)';
  detectStream.emitBus = false;   // same reason as the pose stream above
  if (detectStream.detect) detectStream.detect.queries = ['a person'];
  scene.mmStreams.push(detectStream);

  // ---- the scan placeholder: hidden by default, because the modelled room
  // above is the thing you author against. Turn it on to check that zones,
  // snapping and measurement behave against scan-like data BEFORE a real
  // capture exists — the point of a placeholder is to de-risk the swap.
  const scan = createPaintCloud(genId(), 'Room scan (simulated)', [0, 0, 0]);
  scan.points = roomScanPoints(ROOM_W, ROOM_D, ROOM_H, upAxisZ);
  scan.visible = false;
  scene.paintClouds.push(scan);

  // ---- categories -------------------------------------------------------
  // Empties at the ORIGIN with no rotation or scale, so parenting to one
  // changes nothing about where anything sits — it is filing, not a
  // transform. Sixty objects in a flat list is a scene you navigate by
  // reading names; four collapsible groups is one you navigate by shape.
  const group = (name: string) => {
    const g = createMeshObject(genId(), 'EMPTY', at(0, 0, 0));
    g.name = name;
    return g;
  };
  const gRoom = group('Room');
  const gProps = group('Props');
  const gCast = group('Cast');
  const gDrawing = group('Drawing');
  const gSensors = group('Sensors');
  const parentTo = (g: { id: number }) => ({ kind: 'MESH' as const, id: g.id });

  for (const m of room) m.parent = parentTo(gRoom);
  for (const m of props) m.parent = parentTo(gProps);
  zoneObj.parent = parentTo(gSensors);
  scan.parent = parentTo(gRoom);
  pathObj.parent = parentTo(gDrawing);
  walker.parent = parentTo(gCast);
  wanderer.parent = parentTo(gCast);
  sketcher.parent = parentTo(gCast);

  scene.objects.push(pathObj);
  scene.meshes.push(gRoom, gProps, gCast, gDrawing, gSensors, ...room, ...props, zoneObj);
  scene.actors.push(walker, wanderer, sketcher);
  scene.cameras.push(secCam);
  scene.activeCamera = 0; // keep the user's main camera active; security cam is a second view
  scene.frameEnd = Math.max(scene.frameEnd, 250);

  return {
    scene, actorId: walker.id, wandererId: wanderer.id, sketcherId: sketcher.id,
    poseStreamId: poseStream.id, detectStreamId: detectStream.id,
    camIndex: scene.cameras.length - 1,
  };
}
