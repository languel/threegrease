// FLAT (unlit) projection: media thrown onto the room at its own brightness.
//
// The LIT path is three's own — a spot light carries the picture as its
// `map`, so the image is light: it falls off, it is tinted by the lamp, it
// mixes with everything else lighting that wall. That is what a projector
// physically does, and it is the right answer for judging a room.
//
// It is the wrong answer for judging the WORK. A video read through a
// diffuse surface at an angle, under whatever else is lit, tells you
// nothing about the piece. So a projector can be FLAT instead: its picture
// is ADDED to the surface after lighting, undimmed and untinted, exactly as
// authored — the way a projection looks in a blacked-out room, and the way
// you want to see media while placing it.
//
// It is projective texturing, patched into the materials the scene already
// uses (`onBeforeCompile`), not a separate pass: every mesh keeps its own
// material, and a flat projector costs one texture fetch per pixel it
// covers. Objects still block the beam, because occlusion is read from the
// light's OWN shadow map — the same one three renders for it — so a flat
// projection is only as honest as the light's `castShadow` setting.
import * as THREE from 'three';

/** How many flat projectors can be live at once. Fixed so the shader can
 *  unroll (a sampler array cannot be indexed dynamically) — more than a
 *  handful of projectors in one room is not a plan, it is a light show. */
export const MAX_FLAT = 4;

export interface FlatProjector {
  /** world -> the projector's [0,1] frustum (three's own shadow matrix) */
  matrix: THREE.Matrix4;
  map: THREE.Texture;
  /** brightness of the thrown picture */
  gain: number;
  /** softened edge of the beam, 0..1 of its radius */
  penumbra: number;
  /** the light's shadow map, when it casts one: what blocks the beam */
  shadow: THREE.Texture | null;
  shadowBias: number;
}

const dummy = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  c.getContext('2d')!.fillRect(0, 0, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
})();

/**
 * The uniforms every patched material shares. ONE object, so a frame's
 * update is a handful of writes rather than a walk over every material —
 * and so nothing recompiles when a projector moves or its picture changes.
 */
export const projectorUniforms = {
  uFlatCount: { value: 0 },
  uFlatMatrix: { value: Array.from({ length: MAX_FLAT }, () => new THREE.Matrix4()) },
  uFlatMap: { value: Array.from({ length: MAX_FLAT }, () => dummy as THREE.Texture) },
  uFlatShadow: { value: Array.from({ length: MAX_FLAT }, () => dummy as THREE.Texture) },
  /** x = gain, y = penumbra, z = 1 when the shadow map is real, w = bias */
  uFlatParams: { value: Array.from({ length: MAX_FLAT }, () => new THREE.Vector4(1, 0.1, 0, 0.0005)) },
};

const VERT_HEAD = /* glsl */`
varying vec3 vFlatWorld;
`;
const VERT_BODY = /* glsl */`
  vFlatWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAG_HEAD = /* glsl */`
varying vec3 vFlatWorld;
uniform int uFlatCount;
uniform mat4 uFlatMatrix[ ${MAX_FLAT} ];
uniform sampler2D uFlatMap[ ${MAX_FLAT} ];
uniform sampler2D uFlatShadow[ ${MAX_FLAT} ];
uniform vec4 uFlatParams[ ${MAX_FLAT} ];
`;

// Added to the outgoing colour, so it is not touched by lighting, by the
// surface's own colour, or by its roughness — the picture, as authored.
const FRAG_BODY = /* glsl */`
  #pragma unroll_loop_start
  for ( int i = 0; i < ${MAX_FLAT}; i ++ ) {
    if ( UNROLLED_LOOP_INDEX < uFlatCount ) {
      vec4 fpc = uFlatMatrix[ i ] * vec4( vFlatWorld, 1.0 );
      if ( fpc.w > 0.0 ) {
        vec3 fuv = fpc.xyz / fpc.w;
        if ( fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0 && fuv.z > 0.0 && fuv.z < 1.0 ) {
          vec4 fpx = texture2D( uFlatMap[ i ], fuv.xy );
          // the beam is the cone inscribed in its square frustum
          float fr = length( fuv.xy - 0.5 ) * 2.0;
          float fatt = 1.0 - smoothstep( 1.0 - uFlatParams[ i ].y, 1.0, fr );
          float fvis = 1.0;
          if ( uFlatParams[ i ].z > 0.5 ) {
            float fdepth = unpackRGBAToDepth( texture2D( uFlatShadow[ i ], fuv.xy ) );
            fvis = ( fuv.z - uFlatParams[ i ].w ) > fdepth ? 0.0 : 1.0;
          }
          outgoingLight += fpx.rgb * fpx.a * uFlatParams[ i ].x * fatt * fvis;
        }
      }
    }
  }
  #pragma unroll_loop_end
`;

/**
 * Teach a material to receive flat projections. Idempotent: a material is
 * patched once (three keys its program by the compiled source, so patching
 * the same way costs one compile per material family, not per object).
 */
export function receiveProjection(mat: THREE.Material): void {
  const m = mat as THREE.Material & { userData: Record<string, unknown> };
  if (m.userData.flatProjector) return;
  m.userData.flatProjector = true;
  const prev = mat.onBeforeCompile?.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, projectorUniforms);
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace(
      '#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`,
    );
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
      // (`packing`, which carries unpackRGBAToDepth for the occlusion test,
      // is already part of every material three builds — including it again
      // redefines every one of its functions and the shader fails to compile)
      .replace('#include <opaque_fragment>', `${FRAG_BODY}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'flatProjector';
  mat.needsUpdate = true;
}

/** Publish this frame's flat projectors to every patched material. */
export function setFlatProjectors(list: FlatProjector[]): void {
  const n = Math.min(list.length, MAX_FLAT);
  projectorUniforms.uFlatCount.value = n;
  for (let i = 0; i < MAX_FLAT; i++) {
    const p = list[i];
    if (i < n && p) {
      projectorUniforms.uFlatMatrix.value[i].copy(p.matrix);
      projectorUniforms.uFlatMap.value[i] = p.map;
      projectorUniforms.uFlatShadow.value[i] = p.shadow ?? dummy;
      projectorUniforms.uFlatParams.value[i].set(p.gain, p.penumbra, p.shadow ? 1 : 0, p.shadowBias);
    } else {
      projectorUniforms.uFlatMap.value[i] = dummy;
      projectorUniforms.uFlatShadow.value[i] = dummy;
    }
  }
}
