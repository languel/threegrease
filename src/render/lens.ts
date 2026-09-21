// LENSES: what a camera sees, and what a projector throws, when it is not a
// pinhole.
//
// Installations are full of curved optics — a dome, a fisheye projector, a
// 360 camera, a mirror ball — and none of them are a perspective frustum.
// One model serves both ends, because they are the same function read in
// opposite directions:
//
//   a CAMERA asks "this pixel is at radius r from the centre — which
//   direction did it come from?" (the model, inverted);
//   a PROJECTOR asks "this surface is at angle θ off my axis — where in the
//   picture is that?" (the model, forward).
//
// The projector side is therefore the easy one and needs no inversion at
// all; the camera side cannot be rasterised directly (a GPU draws straight
// lines), so the scene is rendered into a CUBE and each pixel of the final
// image samples the cube along the direction its lens gives it.
//
// The polynomial is Paul Bourke's fisheye-correction form
// (paulbourke.net/dome/fisheyecorrect), which is how real lenses are
// measured and published:
//
//     r(θ) = k0 + k1·θ + k2·θ² + k3·θ³ + k4·θ⁴
//
// with θ the angle from the optical axis in RADIANS and r NORMALISED, 1
// being the edge of the image circle. (Blender's "Fisheye Lens Polynomial"
// is the same polynomial with r in sensor millimetres; k0 is its offset
// term, kept here so published coefficient sets paste straight in.)
import * as THREE from 'three';
import type { TGLens } from '../core/types';

export const LENS_TYPES: [TGLens['type'], string][] = [
  ['PERSPECTIVE', 'Perspective (pinhole)'],
  ['FISHEYE_EQUIDISTANT', 'Fisheye — equidistant (r = f·θ)'],
  ['FISHEYE_EQUISOLID', 'Fisheye — equisolid (r = 2f·sin(θ/2))'],
  ['FISHEYE_POLY', 'Fisheye — polynomial (measured lens)'],
  ['EQUIRECT', 'Equirectangular (360 × 180)'],
  ['CYLINDRICAL', 'Cylindrical'],
  ['MIRRORBALL', 'Mirror ball'],
];

/** Published coefficient sets, ready to paste. `poly` is k0..k4. */
export const LENS_PRESETS: { name: string; lens: TGLens }[] = [
  {
    name: 'Fulldome 180° (ideal equidistant)',
    lens: { type: 'FISHEYE_EQUIDISTANT', fov: Math.PI },
  },
  {
    // Bourke's worked example: r(φ) = 0.7284φ - 0.1461φ² + 0.2896φ³ - 0.2109φ⁴
    name: '190° fisheye (Bourke measured)',
    lens: { type: 'FISHEYE_POLY', fov: THREE.MathUtils.degToRad(190), poly: [0, 0.7284, -0.1461, 0.2896, -0.2109] },
  },
  {
    name: 'Equisolid fisheye 180° (8 mm on full frame)',
    lens: { type: 'FISHEYE_EQUISOLID', fov: Math.PI, focal: 8, sensor: 36 },
  },
  { name: '360 × 180 equirectangular', lens: { type: 'EQUIRECT', fov: Math.PI * 2 } },
  { name: 'Mirror ball', lens: { type: 'MIRRORBALL', fov: Math.PI * 2 } },
];

/**
 * YOUR OWN LENSES, kept beside the published ones.
 *
 * A projector or a dome camera in a real room is a specific piece of glass,
 * measured once and then used for years — and often measured by the person
 * using it, from a photograph of a grid. Retyping five coefficients every
 * time that lens is wanted again is how a measurement gets lost, so a lens
 * can be SAVED by name. They live in localStorage rather than in the scene
 * because a lens belongs to the room's equipment, not to one plan of one
 * show.
 */
const CUSTOM_KEY = 'threegrease.lenses';

export function customLenses(): { name: string; lens: TGLens }[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.name === 'string' && e.lens) : [];
  } catch { return []; }
}

/** Save (or replace by name) a lens. Returns the new list. */
export function saveCustomLens(name: string, lens: TGLens): { name: string; lens: TGLens }[] {
  const list = customLenses().filter((e) => e.name !== name);
  list.push({ name, lens: JSON.parse(JSON.stringify(lens)) as TGLens });
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* full or blocked */ }
  return list;
}

export function deleteCustomLens(name: string): { name: string; lens: TGLens }[] {
  const list = customLenses().filter((e) => e.name !== name);
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* full or blocked */ }
  return list;
}

export function lensTypeIndex(t: TGLens['type'] | undefined): number {
  return ['PERSPECTIVE', 'FISHEYE_EQUIDISTANT', 'FISHEYE_EQUISOLID', 'FISHEYE_POLY', 'EQUIRECT', 'CYLINDRICAL', 'MIRRORBALL']
    .indexOf(t ?? 'PERSPECTIVE');
}

/**
 * The angle the image circle actually covers. An equisolid lens is sold as
 * a focal length and a sensor size, and those two decide it:
 * r = 2f·sin(θ/2) reaches the sensor's edge at θ = 4·asin(sensor / 4f).
 */
export function effectiveFov(lens: TGLens | undefined): number {
  if (!lens) return Math.PI;
  if (lens.type === 'FISHEYE_EQUISOLID' && lens.focal && lens.sensor) {
    const s = Math.min(1, lens.sensor / (4 * lens.focal));
    return Math.min(Math.PI * 2, 4 * Math.asin(s));
  }
  return lens.fov ?? Math.PI;
}

export function isCurved(lens: TGLens | undefined): boolean {
  return !!lens && lens.type !== 'PERSPECTIVE';
}

export function polyOf(lens: TGLens | undefined): number[] {
  const p = lens?.poly ?? [];
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0, p[4] ?? 0];
}

/**
 * The lens, as GLSL, shared by the camera remap and the flat projector.
 *
 * `lensRadius` is the FORWARD model — angle to normalised image radius —
 * and `lensAngle` is its inverse, found by Newton's method for the
 * polynomial (there is no closed form, and four iterations are plenty for a
 * monotone quartic over the half-angle of a lens).
 */
export const LENS_GLSL = /* glsl */`
// This chunk is prepended BEFORE a material's own source, which is where
// three's <common> defines PI — so it carries its own constant rather than
// relying on one that is not there yet.
#ifndef LENS_PI
#define LENS_PI 3.141592653589793
#endif
// types: 0 perspective, 1 equidistant, 2 equisolid, 3 polynomial,
//        4 equirect, 5 cylindrical, 6 mirror ball
float lensRadius( int type, float theta, float halfFov, float k[5] ) {
  if ( type == 1 ) return theta / max( halfFov, 1e-4 );
  if ( type == 2 ) return sin( theta * 0.5 ) / max( sin( halfFov * 0.5 ), 1e-4 );
  if ( type == 3 ) {
    // NORMALISED TO ITS OWN EDGE. The polynomial gives the SHAPE of the
    // mapping, not an absolute radius: a published set is a fit over the
    // lens's own range in whatever units it was measured in, and Bourke's
    // 190 degree example only ever reaches r = 0.73 (it turns over at about
    // 72 degrees and goes negative by 180). Read as screen radius directly,
    // everything past r = 0.73 has NO solution — Newton walks off, the
    // pixels sample backwards, and the picture collapses into a small disc
    // in the middle of a black frame. Dividing by its value at the half
    // field puts the edge of the image circle exactly at the half field,
    // which is also what makes Field of view mean something for this type.
    float e = k[0] + k[1] * halfFov + k[2] * halfFov * halfFov
      + k[3] * halfFov * halfFov * halfFov + k[4] * halfFov * halfFov * halfFov * halfFov;
    if ( abs( e ) < 1e-5 ) return theta / max( halfFov, 1e-4 );
    float t = theta;
    return ( k[0] + k[1] * t + k[2] * t * t + k[3] * t * t * t + k[4] * t * t * t * t ) / e;
  }
  if ( type == 6 ) return sin( theta * 0.5 ) / max( sin( halfFov * 0.5 ), 1e-4 );
  return theta / max( halfFov, 1e-4 );
}

float lensAngle( int type, float r, float halfFov, float k[5] ) {
  if ( type == 1 ) return r * halfFov;
  if ( type == 2 || type == 6 ) return 2.0 * asin( clamp( r * sin( halfFov * 0.5 ), -1.0, 1.0 ) );
  if ( type == 3 ) {
    // the inverse of the NORMALISED forward model above: solve
    // poly(t) = r * poly(halfFov) by Newton, seeded equidistant
    float e = k[0] + k[1] * halfFov + k[2] * halfFov * halfFov
      + k[3] * halfFov * halfFov * halfFov + k[4] * halfFov * halfFov * halfFov * halfFov;
    if ( abs( e ) < 1e-5 ) return r * halfFov;
    float goal = r * e;
    float t = r * halfFov;
    for ( int i = 0; i < 6; i ++ ) {
      float f = k[0] + k[1] * t + k[2] * t * t + k[3] * t * t * t + k[4] * t * t * t * t - goal;
      float d = k[1] + 2.0 * k[2] * t + 3.0 * k[3] * t * t + 4.0 * k[4] * t * t * t;
      if ( abs( d ) < 1e-6 ) break;
      t = clamp( t - f / d, 0.0, halfFov * 1.2 );
    }
    return t;
  }
  return r * halfFov;
}

/** Screen point (-1..1, aspect applied) -> the direction it looks along, in
 *  the lens's own frame (-Z forward, +Y up). Returns false outside the
 *  image circle, which is black on a fisheye and is NOT the same as "far". */
bool lensDirection( int type, vec2 p, float halfFov, float k[5], out vec3 dir ) {
  if ( type == 4 ) {                       // equirectangular: the whole sphere
    float lon = p.x * LENS_PI;
    float lat = p.y * LENS_PI * 0.5;
    dir = vec3( sin( lon ) * cos( lat ), sin( lat ), -cos( lon ) * cos( lat ) );
    return true;
  }
  if ( type == 5 ) {                       // cylindrical: panoramic across, flat up
    float lon = p.x * halfFov;
    dir = normalize( vec3( sin( lon ), p.y * tan( min( halfFov, 1.2 ) ), -cos( lon ) ) );
    return true;
  }
  float r = length( p );
  if ( r > 1.0 ) return false;             // outside the circle the lens draws
  float theta = lensAngle( type, r, halfFov, k );
  if ( theta > LENS_PI ) return false;
  vec2 d = r > 1e-6 ? p / r : vec2( 0.0, 0.0 );
  dir = vec3( d.x * sin( theta ), d.y * sin( theta ), -cos( theta ) );
  return true;
}

/** Direction in the lens's frame -> where it lands in the picture (-1..1),
 *  the forward model. False when it is behind the lens or off its image. */
bool lensProject( int type, vec3 dir, float halfFov, float k[5], out vec2 uv ) {
  vec3 d = normalize( dir );
  if ( type == 4 ) {
    float lat = asin( clamp( d.y, -1.0, 1.0 ) );
    float lon = atan( d.x, -d.z );
    uv = vec2( lon / LENS_PI, lat / ( LENS_PI * 0.5 ) );
    return true;
  }
  if ( type == 5 ) {
    float lon = atan( d.x, -d.z );
    if ( abs( lon ) > halfFov ) return false;
    float h = d.y / max( length( d.xz ), 1e-5 );
    uv = vec2( lon / halfFov, h / tan( min( halfFov, 1.2 ) ) );
    return abs( uv.y ) <= 1.0;
  }
  float theta = acos( clamp( -d.z, -1.0, 1.0 ) );
  if ( theta > halfFov ) return false;
  float r = lensRadius( type, theta, halfFov, k );
  if ( r > 1.0 ) return false;
  vec2 a = vec2( d.x, d.y );
  float l = length( a );
  uv = l > 1e-6 ? ( a / l ) * r : vec2( 0.0 );
  return true;
}
`;

/**
 * A camera with a curved lens: render the scene into a cube once, then draw
 * one full-screen pass that asks the lens where every pixel looks.
 *
 * Six faces is the honest cost of a lens that sees more than a frustum —
 * and the only way to do it in a rasteriser. The cube is square and modest
 * (a fisheye's pixels are spread over a hemisphere, so a bigger cube buys
 * less than it looks like it should).
 */
export class LensCamera {
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  private cubeCam: THREE.CubeCamera | null = null;
  private size = 0;
  private readonly quad: THREE.Mesh;
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCube: { value: null },
        uType: { value: 1 },
        uHalfFov: { value: Math.PI / 2 },
        uK: { value: [0, 0, 0, 0, 0] },
        uAspect: { value: 1 },
        uShift: { value: new THREE.Vector2() },
        uOrient: { value: new THREE.Matrix3() },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform samplerCube uCube;
        uniform int uType;
        uniform float uHalfFov;
        uniform float uK[5];
        uniform float uAspect;
        uniform vec2 uShift;
        uniform mat3 uOrient;
        ${LENS_GLSL}
        void main() {
          vec2 p = vUv * 2.0 - 1.0 + uShift;
          // the image circle fits the SHORT side, the way a fisheye lands on
          // a sensor; an equirect/cylindrical image fills the frame instead
          if ( uType == 4 || uType == 5 ) p.y = p.y;
          else if ( uAspect > 1.0 ) p.x *= uAspect;
          else p.y /= max( uAspect, 1e-4 );
          float k[5];
          for ( int i = 0; i < 5; i ++ ) k[ i ] = uK[ i ];
          vec3 dir;
          if ( !lensDirection( uType, p, uHalfFov, k, dir ) ) {
            gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
            return;
          }
          // the cube is drawn axis-aligned in WORLD space, so the lens's own
          // direction is turned into world space here rather than the cube
          // being re-rendered whenever the camera turns
          gl_FragColor = vec4( textureCube( uCube, uOrient * dir ).rgb, 1.0 );
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
  }

  /** Render `scene` through `lens` from `pose`'s position and orientation. */
  render(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, pose: THREE.Object3D,
    lens: TGLens, target: THREE.WebGLRenderTarget | null, near = 0.05, far = 500,
  ): void {
    const wanted = Math.min(1024, Math.max(256, Math.round(
      (target?.width ?? renderer.domElement.width) * 0.75)));
    if (!this.cubeRT || this.size !== wanted) {
      this.cubeRT?.dispose();
      this.cubeRT = new THREE.WebGLCubeRenderTarget(wanted, { generateMipmaps: false });
      this.cubeRT.texture.colorSpace = THREE.SRGBColorSpace;
      this.cubeCam = new THREE.CubeCamera(near, far, this.cubeRT);
      this.size = wanted;
    }
    const cam = this.cubeCam!;
    cam.position.setFromMatrixPosition(pose.matrixWorld);
    // the cube is axis-aligned in WORLD space, so the lens turns the
    // direction into the camera's frame rather than the cube being turned
    cam.rotation.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    const savedBg = scene.background;
    cam.update(renderer, scene);
    scene.background = savedBg;

    const w = target?.width ?? renderer.domElement.width;
    const h = target?.height ?? renderer.domElement.height;
    this.material.uniforms.uCube.value = this.cubeRT!.texture;
    this.material.uniforms.uType.value = lensTypeIndex(lens.type);
    this.material.uniforms.uHalfFov.value = Math.max(0.05, effectiveFov(lens) / 2);
    this.material.uniforms.uK.value = polyOf(lens);
    this.material.uniforms.uAspect.value = w / Math.max(1, h);
    this.material.uniforms.uShift.value.set(lens.shiftX ?? 0, lens.shiftY ?? 0);
    (this.material.uniforms.uOrient.value as THREE.Matrix3).setFromMatrix4(
      new THREE.Matrix4().extractRotation(pose.matrixWorld));
    renderer.setRenderTarget(target);
    renderer.render(this.quad, this.quadCam);
  }

  dispose(): void {
    this.cubeRT?.dispose();
    this.material.dispose();
    (this.quad.geometry as THREE.BufferGeometry).dispose();
  }
}
