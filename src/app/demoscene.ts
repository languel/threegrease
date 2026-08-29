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
import { createHumanoid } from '../actor/skeleton';
import { createConstraint } from '../score/constraints';
import { createStream } from '../mm/streams';

export interface DemoWiring {
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

/** A short oval walking loop between the two pedestals, as GP stroke points
 *  on the floor. */
function walkLoopPoints(): Vec3[] {
  const pts: Vec3[] = [];
  const cx = 0, cy = 0, rx = 2.4, ry = 1.5;
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 0]);
  }
  return pts;
}

export function buildDemoScene(upAxisZ: boolean): DemoWiring {
  const scene = createScene();

  // ---- room shell: floor + four walls, sized to a small gallery room ----
  // 7 x 5 x 2.6 m — real dimensions, since 1 unit = 1 metre is the scene's
  // own convention (see the measure tool). Walls are unlit PLANE meshes so
  // they read as a room without needing real lighting to look right.
  const ROOM_W = 7, ROOM_D = 5, ROOM_H = 2.6;
  const wallColor: Vec3 = [0.86, 0.85, 0.81];
  const room: ReturnType<typeof createMeshObject>[] = [];
  const addWall = (name: string, at: Vec3, rot: Vec3, w: number, h: number): void => {
    const id = genId();
    const m = createMeshObject(id, 'PLANE', at);
    m.name = name;
    m.rotation = rot;
    m.scale = [w, h, 1];
    m.color = wallColor;
    m.unlit = false;
    m.doubleSided = true;
    m.drawTarget = true;
    room.push(m);
  };
  if (upAxisZ) {
    addWall('Floor', [0, 0, 0], [0, 0, 0], ROOM_W, ROOM_D);
    addWall('Wall North', [0, ROOM_D / 2, ROOM_H / 2], [Math.PI / 2, 0, 0], ROOM_W, ROOM_H);
    addWall('Wall South', [0, -ROOM_D / 2, ROOM_H / 2], [Math.PI / 2, 0, Math.PI], ROOM_W, ROOM_H);
    addWall('Wall East', [ROOM_W / 2, 0, ROOM_H / 2], [Math.PI / 2, 0, -Math.PI / 2], ROOM_D, ROOM_H);
    addWall('Wall West', [-ROOM_W / 2, 0, ROOM_H / 2], [Math.PI / 2, 0, Math.PI / 2], ROOM_D, ROOM_H);
  } else {
    addWall('Floor', [0, 0, 0], [-Math.PI / 2, 0, 0], ROOM_W, ROOM_D);
    addWall('Wall North', [0, ROOM_H / 2, ROOM_D / 2], [0, Math.PI, 0], ROOM_W, ROOM_H);
    addWall('Wall South', [0, ROOM_H / 2, -ROOM_D / 2], [0, 0, 0], ROOM_W, ROOM_H);
    addWall('Wall East', [ROOM_W / 2, ROOM_H / 2, 0], [0, -Math.PI / 2, 0], ROOM_D, ROOM_H);
    addWall('Wall West', [-ROOM_W / 2, ROOM_H / 2, 0], [0, Math.PI / 2, 0], ROOM_D, ROOM_H);
  }

  // ---- props: two pedestals the walk loop threads between ----
  const pedAt = (x: number, y: number): Vec3 => (upAxisZ ? [x, y, 0.55] : [x, 0.55, y]);
  const ped1 = createMeshObject(genId(), 'BOX', pedAt(-1.6, 0));
  ped1.name = 'Pedestal A';
  ped1.scale = [0.5, 0.5, 1.1];
  ped1.color = [0.93, 0.92, 0.9];
  const ped2 = createMeshObject(genId(), 'BOX', pedAt(1.6, 0));
  ped2.name = 'Pedestal B';
  ped2.scale = [0.5, 0.5, 1.1];
  ped2.color = [0.93, 0.92, 0.9];

  // ---- an interactive zone: TRIGGER on pedestal A, so the demo shows a
  // probe firing as the walking visitor passes near it, exactly the way a
  // real installation would react to someone approaching an exhibit ----
  const zone: TGConstraint = createConstraint('TRIGGER');
  zone.radius = 0.9;
  zone.messages = [{ address: '/gallery/near/{name}', argExprs: ['{x}', '{y}', '{z}'] }];
  zone.leaveMessages = [{ address: '/gallery/leave/{name}', argExprs: ['1'] }];
  ped1.constraints = [zone];

  // ---- the walk path: a GP stroke loop the visitor follows ----
  const pathObj = createObject('Walk Path');
  const pathLayer = pathObj.layers[0];
  const frame = createFrame(1);
  const stroke = createStroke(4, 3); // material 4 = Stroke Blue, seeded by createObject
  stroke.cyclic = true;
  for (const p of walkLoopPoints()) stroke.points.push(createPoint(p));
  frame.strokes.push(stroke);
  pathLayer.frames.push(frame);

  // ---- the visitor: a rigged actor walking the loop ----
  const actor = createHumanoid(genId(), 'Visitor', upAxisZ);
  actor.physics.enabled = true;
  actor.physics.tone = 0.08; // holds a walking stance rather than ragdolling
  const follow = createConstraint('FOLLOW_PATH');
  follow.path = { objectIndex: 1, layerId: pathLayer.id, strokeId: stroke.id }; // index 1: pathObj is scene.objects[1]
  follow.speed = 0.12;
  follow.loop = 'LOOP';
  follow.running = true;
  follow.orient = true;
  actor.constraints = [follow];

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
  scene.mmStreams.push(poseStream);
  const detectStream = createStream(scene, 'DETECT', 'CAMERA', upAxisZ ? 'Z' : 'Y');
  detectStream.name = 'Security Cam · Detect (sim)';
  if (detectStream.detect) detectStream.detect.queries = ['a person'];
  scene.mmStreams.push(detectStream);

  scene.objects.push(pathObj);
  scene.meshes.push(...room, ped1, ped2);
  scene.actors.push(actor);
  scene.cameras.push(secCam);
  scene.activeCamera = 0; // keep the user's main camera active; security cam is a second view
  scene.frameEnd = Math.max(scene.frameEnd, 250);

  return {
    scene, actorId: actor.id, poseStreamId: poseStream.id, detectStreamId: detectStream.id,
    camIndex: scene.cameras.length - 1,
  };
}
