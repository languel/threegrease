// Scene world: the environment behind everything, and the light it casts.
//
// Every mode funnels into ONE equirectangular texture. That is the whole
// design: three.js can use an equirect map as both `scene.background` and
// (via PMREM) `scene.environment`, so a single source drives what you see
// AND what lights the meshes. A gradient or a solid colour is just a 2x256
// canvas; the physical sky is rendered to a cube target; a 360 video is a
// VideoTexture. Nothing downstream has to know which.
//
// Rotation/blur/intensity are three.js scene properties (r155+), not shader
// work — `backgroundRotation`, `backgroundBlurriness`, `backgroundIntensity`,
// `environmentRotation`, `environmentIntensity`.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { GPScene, TGWorld, ViewportShading } from '../core/types';

/** How often the IBL is re-derived from a moving video source. A PMREM pass
 *  is far too expensive per frame, and environment light from footage does
 *  not need to be frame-accurate to read as correct. */
const VIDEO_IBL_INTERVAL_MS = 400;

/** Resolution the IBL is derived at, whatever the source's own size.
 *  Irradiance is low-frequency by nature — detail here buys nothing and
 *  a PMREM pass scales with input size. 2:1, like any lat-long map. */
const IBL_W = 256;
const IBL_H = 128;

/** Longitude offset lining the sky mesh up with the static background.
 *  Measured by sweeping Rotation in both paths and matching where a marker
 *  lands: SphereGeometry's own U happens to agree with three's `equirectUv`
 *  once the pole is re-framed, so no offset is needed. Kept named because
 *  it is an empirical fact about two independent mappings, not an identity
 *  — if either side changes, re-measure rather than assume it stays 0. */
/** Sky cube face size. 512 left the sun a visible staircase; the cost of
 *  1024 is one render of six faces, paid only when a sky value changes. */
const SKY_CUBE = 1024;
/** minimum gap between IBL rebuilds while sky values are being dragged */
const SKY_ENV_MS = 140;

const SKY_LON_OFFSET = 0;

/** Scale applied to the physical sky before capture (see renderSky). Chosen
 *  so a midday zenith lands in the middle of the range rather than clipping,
 *  with headroom left for the sun disc to read as brighter than the sky. */
const SKY_EXPOSURE = 0.2;

/** Neutral studio light for SOLID shading — deliberately independent of the
 *  scene's world, so Solid mode looks the same whatever the world is doing.
 *  That is the point of Blender's Solid mode: a stable modelling light. */
function studioEquirect(): THREE.DataTexture {
  // bright above, dim below (row 0 = nadir, see verticalRamp) — a softbox
  return verticalRamp(RAMP_W, RAMP_H, (t) => {
    const v = Math.min(1, 0.22 + 0.75 * Math.pow(t, 1.4));
    return [v, v, Math.min(1, v * 1.02)];
  });
}

export class WorldManager {
  private pmrem: THREE.PMREMGenerator;
  private renderer: THREE.WebGLRenderer;

  /** the equirect source for the current mode (owned; disposed on change) */
  private source: THREE.Texture | null = null;
  /** PMREM-filtered version of `source`, used as scene.environment */
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** studio light for SOLID shading, built once, never rebuilt */
  private studioRT: THREE.WebGLRenderTarget | null = null;
  /** cube capture backing the SKY mode's background */
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  /** inside-out sphere carrying a moving (video/live) background */
  private skyMesh: THREE.Mesh | null = null;

  /** what `source` was built from, so we only rebuild when it actually changed */
  private key = '';
  private videoEl: HTMLVideoElement | null = null;
  private lastVideoIbl = 0;
  /** downscale target for IBL from a moving source (see refreshVideoIbl) */
  private iblCanvas: HTMLCanvasElement | null = null;
  private iblTex: THREE.CanvasTexture | null = null;
  /** set when a source is loading/failed, surfaced in the UI */
  status: 'ok' | 'loading' | 'error' = 'ok';
  error = '';
  /**
   * Told when the panel needs redrawing — which is NOT every time the world
   * changes.
   *
   * It is wired to a full sidebar rebuild, and the only thing the panel has
   * to learn about is a STATUS transition (loading -> ok, or an error), so
   * firing it on every rebuild meant a sky slider replaced its own DOM node
   * on every pixel of a drag. The pointer then had nothing left to drag and
   * the gesture died — the "stutter and halt" that looked like a physics or
   * a render cost and was neither.
   */
  onChange: (() => void) | null = null;
  private notified = '';

  private notify(): void {
    const stamp = `${this.status}|${this.error}`;
    if (stamp === this.notified) return;
    this.notified = stamp;
    this.onChange?.();
  }

  /** Provides the live capture element for videoSource CAMERA (wired by App
   *  so this module doesn't depend on the capture stack). */
  liveSource: (() => HTMLVideoElement | HTMLCanvasElement | null) | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  /** Apply the world + shading mode to the three.js scene. Cheap to call
   *  every frame: the source is only rebuilt when its inputs change. */
  update(scene3: THREE.Scene, scene: GPScene, shading: ViewportShading, upAxisZ: boolean): void {
    const w = scene.world;
    const key = this.keyOf(scene, w);
    if (key !== this.key) {
      this.key = key;
      this.rebuild(scene, w);
    }
    if (this.skyEnvPending && w.lighting && this.source
      && performance.now() - this.skyEnvAt >= SKY_ENV_MS) {
      this.skyEnvAt = performance.now();
      this.skyEnvPending = false;
      this.envRT?.dispose();
      this.envRT = this.pmrem.fromCubemap(this.source as THREE.CubeTexture);
    }
    // A VideoTexture uploads itself each frame; a CanvasTexture (the live
    // capture path, which has no readyState for VideoTexture to gate on)
    // does not — without this the "live" world freezes on frame one.
    const moving = this.source instanceof THREE.VideoTexture
      || this.source instanceof THREE.CanvasTexture;
    if (this.source instanceof THREE.CanvasTexture) this.source.needsUpdate = true;
    // Re-deriving IBL from a moving source costs a full PMREM pass, so skip
    // it entirely when the world isn't lighting anything.
    if (moving && w.lighting) this.refreshVideoIbl();

    // SOLID uses its own studio light and ignores the world entirely, so a
    // modelling view stays readable no matter what the environment is.
    const useStudio = shading === 'SOLID' || shading === 'WIREFRAME';
    const env = useStudio ? this.studio() : (w.lighting ? this.envRT?.texture ?? null : null);
    scene3.environment = env;
    scene3.environmentIntensity = useStudio ? 1 : w.strength;

    // The world is only *visible* in modes that show it. Solid/Wireframe keep
    // the flat colour so the drawing reads against a calm ground.
    //
    // SOLID mode never uses the texture path even when visible: a uniform
    // equirect samples to exactly the flat colour anyway, so a plain Color
    // is the same image for less work per pixel. The ramp still exists for
    // IBL, which does need a texture.
    const spatial = w.mode !== 'SOLID';
    const showWorld = (shading === 'MATERIAL' || shading === 'RENDERED')
      && w.backgroundVisible && spatial;
    //
    // A MOVING source cannot use scene.background at all. three converts an
    // equirect background to a cube ONCE and caches it (WebGLCubeMaps), and
    // it skips the conversion entirely when `image.height` is 0 — which is
    // exactly what a <video> element reports, since its real size lives on
    // videoWidth/videoHeight. So video backgrounds came out pure black, and
    // even with the size fixed they would freeze on frame one. Those get a
    // sky mesh we own and re-texture every frame instead.
    const useMesh = showWorld && moving && !!this.source;
    if (showWorld && this.source && !useMesh) {
      scene3.background = this.source;
      scene3.backgroundIntensity = w.backgroundIntensity;
      scene3.backgroundBlurriness = w.blur;
    } else {
      if (!(scene3.background instanceof THREE.Color)) scene3.background = new THREE.Color();
      (scene3.background as THREE.Color).setRGB(...w.color, THREE.SRGBColorSpace);
      scene3.backgroundBlurriness = 0;
      scene3.backgroundIntensity = 1;
    }
    this.syncSkyMesh(scene3, useMesh ? this.source : null, w, upAxisZ);

    // three ALWAYS puts an equirect's zenith at world +Y (`equirectUv` reads
    // `direction.y` as latitude), so in our Z-up world the environment lands
    // on its side — poles on the horizon — unless we re-frame it. Both
    // rotations are Eulers that three negates and applies to the *lookup*
    // direction, so the spin sign is flipped relative to the image.
    //   Z-up:  sample = Rx(-90) * Rz(-rotation) * dir  ->  euler (PI/2, 0, rot)
    //   Y-up:  sample = Ry(-rotation) * dir            ->  euler (0, rot, 0)
    const rot = scene3.backgroundRotation;
    if (upAxisZ) rot.set(Math.PI / 2, 0, w.rotation);
    else rot.set(0, w.rotation, 0);
    scene3.environmentRotation.copy(rot);
  }

  /**
   * Show/hide/orient the sky mesh used for moving sources (see update()).
   *
   * It is an inside-out unit sphere pinned to the camera, drawn first with
   * depth off so it never occludes anything. `backgroundBlurriness` has no
   * equivalent here — that is a property of three's own background pass —
   * so Blur is disabled in the UI while a moving source is active rather
   * than silently doing nothing.
   */
  private syncSkyMesh(
    scene3: THREE.Scene, tex: THREE.Texture | null, w: TGWorld, upAxisZ: boolean,
  ): void {
    if (!tex) {
      if (this.skyMesh) this.skyMesh.visible = false;
      return;
    }
    if (!this.skyMesh) {
      const mat = new THREE.MeshBasicMaterial({
        side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
      });
      this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), mat);
      this.skyMesh.frustumCulled = false;
      this.skyMesh.renderOrder = -1e6;
      // three's own background box uses this trick: keep the sphere centred
      // on the camera so it reads as infinitely far away.
      this.skyMesh.onBeforeRender = function (_r, _s, camera) {
        this.matrixWorld.copyPosition(camera.matrixWorld);
      };
    }
    if (!this.skyMesh.parent) scene3.add(this.skyMesh);
    this.skyMesh.visible = true;

    const mat = this.skyMesh.material as THREE.MeshBasicMaterial;
    if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
    mat.color.setScalar(w.backgroundIntensity);

    // SphereGeometry's own UVs are lat-long, so the only work is putting its
    // pole on the world up axis and applying the user's spin.
    //
    // Order matters and is easy to get backwards: the sphere's pole is
    // object +Y, so the SPIN must happen about object Y (rightmost in the
    // XYZ euler, i.e. applied first) and the up-axis re-frame about X after
    // it. Spinning about Z instead tips the pole onto the horizon and the
    // whole 360 renders on its side.
    this.skyMesh.rotation.set(
      upAxisZ ? Math.PI / 2 : 0, w.rotation + SKY_LON_OFFSET, 0, 'XYZ');
  }

  /** Identity of the current source inputs. */
  private keyOf(scene: GPScene, w: TGWorld): string {
    switch (w.mode) {
      case 'SOLID': return `solid:${w.color.join(',')}`;
      case 'GRADIENT': return `grad:${w.skyColor.join(',')}|${w.groundColor.join(',')}`;
      case 'EQUIRECT': {
        const img = scene.images.find((i) => i.id === w.imageId);
        return `img:${w.imageId}:${img?.src.length ?? 0}`;
      }
      // CAMERA folds in whether a live element EXISTS: picking Live before
      // starting the Capture tab must re-resolve once capture comes up,
      // and the key is the only thing that triggers a rebuild.
      case 'VIDEO': return w.videoSource === 'CAMERA'
        ? `vid:cam:${this.liveSource?.() ? 'on' : 'off'}`
        : `vid:url:${w.videoUrl}`;
      case 'SKY': return `sky:${w.sunElevation},${w.sunAzimuth},${w.turbidity},${w.rayleigh}`
        + `,${w.sunDisc !== false},${!!w.skyStylize},${(w.skyTintZenith ?? []).join('/')}`
        + `,${(w.skyTintHorizon ?? []).join('/')},${w.lighting}`;
      default: return 'none';
    }
  }

  /** The physical-sky mesh, BUILT ONCE.
   *
   *  Rebuilding it per change is what made the sun/turbidity sliders stutter:
   *  every tick constructed a fresh `Sky`, which is a new ShaderMaterial, so
   *  the browser recompiled the shader and reallocated a cube target before
   *  rendering six faces. Keeping the mesh and the target means a drag only
   *  costs the six face renders it actually needs. */
  private skyObj: Sky | null = null;
  private skyRT: THREE.WebGLCubeRenderTarget | null = null;
  private skyCam: THREE.CubeCamera | null = null;
  private skyScene: THREE.Scene | null = null;
  /** last time the IBL was re-derived from the sky, for drag throttling */
  private skyEnvAt = 0;
  /** a throttled IBL rebuild still owed. Without this the LAST change of a
   *  drag would keep whatever lighting the second-to-last one produced,
   *  because the key already matches and nothing would rebuild. */
  private skyEnvPending = false;

  private disposeSource(): void {
    // a VideoTexture's <video> is owned here; an image texture is not shared
    this.source?.dispose();
    this.source = null;
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
      this.videoEl.removeAttribute('src');
      this.videoEl = null;
    }
    this.envRT?.dispose();
    this.envRT = null;
    // NOT the sky target: it is reused across every sky change (see skyObj).
    this.cubeRT?.dispose();
    this.cubeRT = null;
  }

  private rebuild(scene: GPScene, w: TGWorld): void {
    this.disposeSource();
    this.status = 'ok';
    this.error = '';
    switch (w.mode) {
      case 'SOLID': this.setSource(rampTexture([w.color, w.color])); break;
      case 'GRADIENT': this.setSource(rampTexture([w.skyColor, w.groundColor])); break;
      case 'SKY': {
        const tex = this.renderSky(w);
        // The IBL is the expensive half and it is only ever LOOKED at when
        // the world lights the scene. Dragging the sun with lighting off
        // should cost one cube render and nothing else; with it on, the pass
        // is throttled so a drag stays interactive and the last change still
        // lands (the trailing rebuild comes from the next update()).
        const now = performance.now();
        const skipEnv = !w.lighting || now - this.skyEnvAt < SKY_ENV_MS;
        if (!skipEnv) this.skyEnvAt = now;
        this.skyEnvPending = skipEnv && w.lighting;
        this.setSource(tex, skipEnv);
        break;
      }
      case 'EQUIRECT': this.loadImage(scene, w); break;
      case 'VIDEO': this.loadVideo(w); break;
      default: break;
    }
  }

  /** Adopt a texture as the environment source and derive its IBL.
   *  A CubeTexture keeps its own mapping — forcing equirect mapping onto a
   *  cube (or onto PMREM's packed atlas) renders a garbled swirl rather
   *  than the image, which is exactly what the first sky attempt did. */
  private setSource(tex: THREE.Texture | null, envAlreadyBuilt = false): void {
    this.source = tex;
    if (!tex) { this.envRT = null; return; }
    const moving = tex instanceof THREE.VideoTexture || tex instanceof THREE.CanvasTexture;
    if (!(tex as THREE.CubeTexture).isCubeTexture) {
      // Equirect mapping is what sends a texture through three's one-shot
      // cube conversion. A moving source draws on our own sky mesh, whose
      // sphere UVs are already lat-long, so leave it a plain UV map.
      tex.mapping = moving
        ? THREE.UVMapping : THREE.EquirectangularReflectionMapping;
    }
    if (!envAlreadyBuilt) {
      this.envRT?.dispose();
      this.envRT = null;
      if ((tex as THREE.CubeTexture).isCubeTexture) {
        this.envRT = this.pmrem.fromCubemap(tex as THREE.CubeTexture);
      } else if (usableWidth(tex)) {
        this.envRT = this.pmrem.fromEquirectangular(tex);
      }
      // A video with no decoded frame yet reports width 0 and would build a
      // degenerate atlas (see refreshVideoIbl); leaving env null for a tick
      // until the throttled refresh picks it up is the safe path.
    }
    this.notify();
  }

  /**
   * three.js physical sky, rendered into a cube we keep.
   *
   * Sky is a Mesh with a shader, so it has to go through a scene render — it
   * cannot be sampled as a texture directly. Everything expensive about that
   * (the material, its compiled program, the render target, the camera) is
   * built on the first call and reused, because these are SLIDERS: the cost
   * of a change has to be one render, not a shader compile plus two
   * allocations.
   */
  private renderSky(w: TGWorld): THREE.Texture {
    if (!this.skyObj) {
      const sky = new Sky();
      sky.scale.setScalar(10000);
      // Preetham's model outputs open-ended radiance — three's own example
      // pairs it with ACES tone mapping. This app renders with NoToneMapping,
      // and tone mapping is skipped for render targets regardless, so the
      // capture would clip to flat white. Scale it down in the shader instead.
      // Inlined as a literal, NOT a uniform: three generates uniform
      // declarations only for its built-in materials, so adding one to a
      // ShaderMaterial's `uniforms` without also declaring it in the GLSL
      // fails to compile and the capture comes back black. Our own uniforms
      // below are therefore declared by hand.
      let frag = sky.material.fragmentShader;
      frag = `uniform float uSunDisc;\nuniform float uStylize;\nuniform vec3 uTintZenith;\nuniform vec3 uTintHorizon;\n${frag}`;
      // The sun is a hard-edged disc in the original — at any cube resolution
      // that reads as a pixelated blob, so widen the falloff into a soft
      // limb and let uSunDisc turn it off entirely.
      frag = frag.replace(
        'float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );',
        'float sundisk = uSunDisc * smoothstep( sunAngularDiameterCos - 0.00012, sunAngularDiameterCos + 0.00016, cosTheta );');
      frag = frag.replace(
        'gl_FragColor = vec4( retColor, 1.0 );',
        `vec3 tinted = retColor * ${SKY_EXPOSURE.toFixed(3)};
         // Stylised sky: keep the physical BRIGHTNESS (the gradient, the
         // glow around the sun, the darkening overhead) and replace only the
         // hue, so a pink or white sky still reads as a sky rather than as a
         // flat wash. Mixing the two tints by height puts the horizon colour
         // where the horizon is.
         float luma = dot( tinted, vec3( 0.2126, 0.7152, 0.0722 ) );
         float up = clamp( normalize( vWorldPosition - cameraPosition ).y * 0.5 + 0.5, 0.0, 1.0 );
         vec3 styled = mix( uTintHorizon, uTintZenith, up ) * luma;
         gl_FragColor = vec4( mix( tinted, styled, uStylize ), 1.0 );`);
      sky.material.fragmentShader = frag;
      sky.material.uniforms.uSunDisc = { value: 1 };
      sky.material.uniforms.uStylize = { value: 0 };
      sky.material.uniforms.uTintZenith = { value: new THREE.Color(1, 1, 1) };
      sky.material.uniforms.uTintHorizon = { value: new THREE.Color(1, 1, 1) };
      this.skyObj = sky;
      this.skyScene = new THREE.Scene();
      this.skyScene.add(sky);
      this.skyRT = new THREE.WebGLCubeRenderTarget(SKY_CUBE, { generateMipmaps: false });
      this.skyRT.texture.minFilter = THREE.LinearFilter;
      this.skyCam = new THREE.CubeCamera(0.1, 100000, this.skyRT);
    }
    const u = this.skyObj.material.uniforms;
    u.turbidity.value = w.turbidity;
    u.rayleigh.value = w.rayleigh;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    u.uSunDisc.value = w.sunDisc === false ? 0 : 1;
    u.uStylize.value = w.skyStylize ? 1 : 0;
    const zen = w.skyTintZenith ?? [0.55, 0.72, 1];
    const hor = w.skyTintHorizon ?? [1, 0.85, 0.72];
    (u.uTintZenith.value as THREE.Color).setRGB(zen[0], zen[1], zen[2]);
    (u.uTintHorizon.value as THREE.Color).setRGB(hor[0], hor[1], hor[2]);
    // Sky is authored Y-up internally, so build the sun vector in ITS frame
    // and let the scene rotation handle the app's up-axis convention.
    const phi = THREE.MathUtils.degToRad(90 - w.sunElevation);
    const theta = THREE.MathUtils.degToRad(w.sunAzimuth);
    u.sunPosition.value.setFromSphericalCoords(1, phi, theta);

    // Capture to a CUBE, not straight to PMREM: PMREM's output is a packed
    // octahedral atlas that is only meaningful to the IBL sampler, so using
    // it as a background draws a swirl. A cube target is both a valid
    // scene.background and a valid PMREM input.
    this.skyCam!.update(this.renderer, this.skyScene!);
    return this.skyRT!.texture;
  }

  private loadImage(scene: GPScene, w: TGWorld): void {
    const rec = scene.images.find((i) => i.id === w.imageId);
    if (!rec) { this.status = 'error'; this.error = 'No environment image selected.'; return; }
    this.status = 'loading';
    const loader = new THREE.TextureLoader();
    loader.load(rec.src, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      this.setSource(tex);
      this.status = 'ok';
      this.notify();
    }, undefined, () => {
      this.status = 'error';
      this.error = `Could not decode "${rec.name}".`;
      this.notify();
    });
  }

  private loadVideo(w: TGWorld): void {
    if (w.videoSource === 'CAMERA') {
      const el = this.liveSource?.();
      if (!el) {
        this.status = 'error';
        this.error = 'No live capture running — start it in the Capture tab.';
        return;
      }
      // a canvas source needs CanvasTexture; VideoTexture gates on readyState
      const tex = el instanceof HTMLCanvasElement
        ? new THREE.CanvasTexture(el) : new THREE.VideoTexture(el);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.setSource(tex);
      return;
    }
    if (!w.videoUrl.trim()) {
      this.status = 'error';
      this.error = 'Enter a video URL or load a file.';
      return;
    }
    const video = document.createElement('video');
    video.src = w.videoUrl;
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    this.videoEl = video;
    this.status = 'loading';
    video.addEventListener('loadeddata', () => {
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.setSource(tex);
      this.status = 'ok';
      this.notify();
    }, { once: true });
    video.addEventListener('error', () => {
      this.status = 'error';
      this.error = 'Video failed to load (check the URL, format, and CORS).';
      this.notify();
    }, { once: true });
    void video.play().catch(() => { /* autoplay blocked until a gesture */ });
  }

  /**
   * Re-derive IBL from a moving source, throttled.
   *
   * The frame is copied into a small fixed-size canvas first, for two
   * reasons. Perf is the obvious one — PMREM of a 4K 360 clip several times
   * a second is pointless when the result is a 256px irradiance atlas.
   * The other is correctness: PMREM picks its cube size from
   * `texture.image.width`, and for a VideoTexture `image` is the <video>
   * ELEMENT, whose `.width` attribute is 0 (the real size is `videoWidth`).
   * Feeding one in directly yields a zero-height atlas, which compiles to
   * `CUBEUV_MAX_MIP = Infinity` — the fragment shader then fails to build
   * and the ENTIRE viewport goes black, background and meshes together.
   */
  private refreshVideoIbl(): void {
    const now = performance.now();
    if (now - this.lastVideoIbl < VIDEO_IBL_INTERVAL_MS) return;
    if (!this.source) return;
    const src = this.source.image as HTMLVideoElement | HTMLCanvasElement | undefined;
    if (!src) return;
    const sw = (src as HTMLVideoElement).videoWidth || src.width;
    const sh = (src as HTMLVideoElement).videoHeight || src.height;
    if (!sw || !sh) return;   // not decoded yet — try again next tick
    this.lastVideoIbl = now;

    if (!this.iblCanvas) {
      this.iblCanvas = document.createElement('canvas');
      this.iblCanvas.width = IBL_W;
      this.iblCanvas.height = IBL_H;
      this.iblTex = new THREE.CanvasTexture(this.iblCanvas);
      this.iblTex.mapping = THREE.EquirectangularReflectionMapping;
      this.iblTex.colorSpace = THREE.SRGBColorSpace;
    }
    const g = this.iblCanvas.getContext('2d');
    if (!g) return;
    g.drawImage(src, 0, 0, IBL_W, IBL_H);
    this.iblTex!.needsUpdate = true;

    this.envRT?.dispose();
    this.envRT = this.pmrem.fromEquirectangular(this.iblTex!);
  }

  private studio(): THREE.Texture {
    if (!this.studioRT) {
      const tex = studioEquirect();
      this.studioRT = this.pmrem.fromEquirectangular(tex);
      tex.dispose();
    }
    return this.studioRT.texture;
  }

  /** Play/pause a URL-backed environment video with the transport. */
  setPlaying(playing: boolean): void {
    if (!this.videoEl) return;
    if (playing) void this.videoEl.play().catch(() => {});
    else this.videoEl.pause();
  }

  dispose(): void {
    this.disposeSource();
    this.skyMesh?.geometry.dispose();
    (this.skyMesh?.material as THREE.Material | undefined)?.dispose();
    this.skyMesh?.removeFromParent();
    this.skyMesh = null;
    this.iblTex?.dispose();
    this.iblTex = null;
    this.iblCanvas = null;
    this.studioRT?.dispose();
    this.studioRT = null;
    this.pmrem.dispose();
  }
}

/**
 * Size of the synthetic (solid/gradient/studio) equirect maps.
 *
 * The CONTENT of these is constant along each row, so one pixel of width
 * would carry it — but PMREMGenerator derives its whole cube resolution
 * from `texture.image.width / 4`. A 2-px-wide ramp therefore asks for a
 * half-pixel cube and the IBL comes back as a 336x2 sliver that lights
 * every mesh pure black. Keep the width real; it is the *only* thing
 * setting the environment's quality. 2:1 to stay a well-formed lat-long.
 */
const RAMP_W = 256;
const RAMP_H = 128;

/** Does this texture know its own pixel size? A <video> element reports
 *  `width` 0 until you set the attribute — `videoWidth` is the real one —
 *  and PMREM reads `image.width`, so anything falling back to 0 must not
 *  be handed to it. */
function usableWidth(tex: THREE.Texture): boolean {
  const img = tex.image as { width?: number; videoWidth?: number } | undefined;
  return !!img && !!(img.videoWidth || img.width);
}

/** Build an equirect map whose colour depends only on elevation.
 *  `f(t)` receives 0 at the nadir and 1 at the zenith. */
function verticalRamp(
  w: number, h: number, f: (t: number) => [number, number, number],
): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    // Row 0 is the NADIR, not the zenith: DataTexture defaults to
    // flipY:false, so row 0 is v=0, and three's equirectUv maps v=0 to
    // dir.y = -1. Filling top-first renders the sky upside down.
    const rgb = f(y / (h - 1));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        data[i + c] = Math.round(Math.min(1, Math.max(0, rgb[c])) * 255);
      }
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

/** A vertical ramp as an equirect map: top colour at the zenith, bottom at
 *  the nadir. Enough for solid and gradient worlds, and it goes through the
 *  same PMREM path as a real HDRI so lighting behaves the same. */
function rampTexture(stops: [number, number, number][]): THREE.DataTexture {
  const [top, bottom] = stops.length > 1 ? stops : [stops[0], stops[0]];
  return verticalRamp(RAMP_W, RAMP_H, (t) => [
    bottom[0] * (1 - t) + top[0] * t,
    bottom[1] * (1 - t) + top[1] * t,
    bottom[2] * (1 - t) + top[2] * t,
  ]);
}
