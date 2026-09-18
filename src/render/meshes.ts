// Mesh scene objects (object mode): primitive solids/planes and imported
// models, mirroring scene.meshes — reference geometry or Surface-placement
// draw targets. Same lifecycle pattern as SplatManager.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { resolveSrc, sourceExt } from '../io/blobstore';
import type { GPScene, TGMesh, Vec3 } from '../core/types';
import { worldMatrixOf } from '../tools/objects';
import { materialManager } from './materialmgr';
import { VrmManager, vrmManager } from './vrm';

function vec3Eq(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function primitiveGeometry(kind: TGMesh['kind']): THREE.BufferGeometry {
  switch (kind) {
    case 'PLANE': return new THREE.PlaneGeometry(2, 2);
    case 'BOX': return new THREE.BoxGeometry(1, 1, 1);
    // radius 0.5 = diameter 1, matching BOX's 1-unit edge and CYLINDER's
    // 1-unit diameter (radius 0.5 below) — a "unit sphere" here means
    // matching its sibling primitives' default footprint, not literally
    // radius 1 (which made it visibly 2x the size of the default box).
    case 'SPHERE': return new THREE.SphereGeometry(0.5, 32, 24);
    case 'CYLINDER': return new THREE.CylinderGeometry(0.5, 0.5, 1.2, 24);
    // a cone with four sides is a pyramid, and it needs no new geometry
    // path — flat-shaded so the four faces read as facets, not as a cone
    case 'PYRAMID': return new THREE.ConeGeometry(0.5, 1, 4, 1);
    // the remaining platonic solids, all unit-diameter like SPHERE so
    // "scale is size" keeps holding across the whole primitive family
    case 'TETRA': return new THREE.TetrahedronGeometry(0.5);
    case 'OCTA': return new THREE.OctahedronGeometry(0.5);
    case 'DODECA': return new THREE.DodecahedronGeometry(0.5);
    case 'ICOSA': return new THREE.IcosahedronGeometry(0.5);
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

/**
 * Outline width in SCREEN pixels.
 *
 * Not a scale factor. Fattening the shell by a percentage makes the rim
 * proportional to the object, so a crate 400 px across gets a fat band and a
 * marble 20 px across gets half a pixel — an outline that quietly vanishes on
 * exactly the small things you are hunting for. The shader below pushes each
 * vertex along its normal by a fixed number of pixels instead, which is what
 * every DCC outline does and why theirs stay legible at any distance.
 */
const OUTLINE_PX = 2.6;
/** outlines draw after everything else, two passes per object */
const OUTLINE_ORDER = 900;

const OUTLINE_VERT = `
uniform float uPx;
uniform vec2 uRes;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // the vertex normal, projected into the same clip space, is the direction
  // "outwards" reads as on screen
  vec3 n = normalize(normalMatrix * normal);
  vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy;
  if (length(dir) > 1e-6) {
    // clip.w undoes the perspective divide, so the offset lands as uPx
    // pixels whatever the depth
    clip.xy += normalize(dir) * (uPx / uRes) * clip.w * 2.0;
  }
  gl_Position = clip;
}`;

const OUTLINE_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
void main() { gl_FragColor = vec4(uColor, uOpacity); }`;

export class MeshManager {
  readonly group = new THREE.Group();
  private entries = new Map<number, { root: THREE.Object3D; src?: string; kind: string; unlit?: boolean; originOffset: Vec3; live?: boolean }>();
  readonly errors = new Map<number, string>();
  /**
   * Animation that came in with a MODEL. RUNTIME state, not scene data: the
   * clips belong to the file, and what the document keeps is whatever you
   * retargeted OUT of them (a TGClip). Keyed by mesh id.
   */
  readonly modelAnimations = new Map<number, {
    root: THREE.Object3D; clips: THREE.AnimationClip[];
  }>();

  /**
   * Hover silhouette — RUNTIME state, set by whichever tool is pointing at
   * something (see `AppCtx.highlightObject`).
   *
   * Drawn as an inverted hull: the object's own geometry again, slightly
   * fattened, back faces only, so what you see is exactly the silhouette of
   * the thing under the cursor whatever shape it is. A 2D ring or box on the
   * HUD has to re-derive that silhouette by projection, and every primitive
   * reports the same unit bounds, so the marker fits a sphere and misses
   * everything else. Here the geometry does the work and there is no
   * projection to get wrong.
   */
  private hover: { id: number; color: string } | null = null;
  /** selection outlines, id -> colour; hover wins where they overlap */
  private selected = new Map<number, string>();
  private hulls = new Map<number, { group: THREE.Group; color: string }>();
  /** rotating stencil value, so overlapping outlines do not mask each other */
  private nextStencilRef = 0;
  /** viewport size in CSS px, shared by every outline material (App.resize
   *  keeps it current — a stale one makes the outline width drift) */
  readonly outlineResolution = new THREE.Vector2(1, 1);

  setHover(id: number | null, color = '#7fd4ff'): void {
    this.hover = id === null ? null : { id, color };
  }

  /**
   * Outline the SELECTED objects the same way.
   *
   * A selection box is a lie about most shapes: it is world-axis-aligned, so
   * a tumbling dodecahedron wears a loose cage that grows and shrinks as it
   * rolls and has nothing to do with the thing inside it. The silhouette is
   * the object, always, and it costs one more shell.
   */
  setSelectionOutlines(map: Map<number, string>): void {
    this.selected = map;
  }

  /** Rebuild/update mesh objects to mirror scene.meshes (camera for view locks). */
  sync(scene: GPScene, camera?: THREE.Camera): void {
    for (const [id, entry] of this.entries) {
      const data = scene.meshes.find((m) => m.id === id);
      if (!data || data.src !== entry.src || data.kind !== entry.kind) {
        this.group.remove(entry.root);
        this.disposeTree(entry.root);
        this.entries.delete(id);
        this.errors.delete(id);
        this.modelAnimations.delete(id);
        vrmManager.forget(id);
      }
    }
    for (const data of scene.meshes) {
      let entry = this.entries.get(data.id);
      if (!entry) {
        // build() always makes a Standard material; unlit:false so the
        // first sync swaps it when the data says unlit
        entry = { root: this.build(data), src: data.src, kind: data.kind, unlit: false, originOffset: [0, 0, 0] };
        entry.root.userData.meshId = data.id;
        entry.root.traverse((o) => { o.userData.meshId = data.id; });
        this.group.add(entry.root);
        this.entries.set(data.id, entry);
      }
      // unlit toggles swap the material class on primitives (the flag comes
      // from the material datablock when assigned, else the legacy field)
      const wantUnlit = materialManager.wantsUnlit(scene, data.materialId, {
        color: data.color, opacity: data.opacity, texture: data.texture,
        unlit: data.unlit, doubleSided: data.doubleSided, wireframe: data.wireframe,
      });
      if (data.kind !== 'MODEL' && data.kind !== 'EMPTY' && entry.unlit !== wantUnlit) {
        const mesh = entry.root as THREE.Mesh;
        (mesh.material as THREE.Material)?.dispose?.();
        mesh.material = wantUnlit
          ? new THREE.MeshBasicMaterial()
          : new THREE.MeshStandardMaterial();
        entry.unlit = wantUnlit;
      }
      // Set Origin (primitives only, see objectops.ts meshLocalBounds): the
      // origin op writes translation + originOffset together so world-space
      // geometry doesn't jump; bake the offset DELTA into the procedural
      // geometry's vertex positions (it has no other persisted shape data).
      const off = data.originOffset ?? [0, 0, 0];
      if (data.kind !== 'MODEL' && data.kind !== 'EMPTY' && !vec3Eq(off, entry.originOffset)) {
        const geo = (entry.root as THREE.Mesh).geometry;
        geo.translate(off[0] - entry.originOffset[0], off[1] - entry.originOffset[1], off[2] - entry.originOffset[2]);
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        entry.originOffset = [...off];
      }
      this.apply(entry.root, data, scene, camera, entry.live);
    }
    this.syncHover();
  }

  /**
   * Build/move/drop the hover hull.
   *
   * It rides as a CHILD of the object's own root, so it inherits every
   * transform for free — including the physics that is moving the thing
   * while you point at it, which a HUD marker can only follow a frame late.
   * The clones share the original's geometry (never dispose it here) and
   * refuse raycasts, so nothing downstream can pick the outline instead of
   * the object.
   */
  private syncHover(): void {
    const want = new Map(this.selected);
    if (this.hover) want.set(this.hover.id, this.hover.color);

    for (const [id, hull] of this.hulls) {
      const colour = want.get(id);
      if (colour && this.entries.has(id)) continue;
      hull.group.removeFromParent();
      for (const o of hull.group.children) {
        (((o as THREE.Mesh).material) as THREE.Material)?.dispose();
      }
      this.hulls.delete(id);
    }
    for (const [id, colour] of want) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      let hull = this.hulls.get(id);
      if (!hull) {
        const group = new THREE.Group();
        group.userData.forId = id;
        // Each outlined object gets its OWN stencil value. With one shared
        // ref, the second object's mask would still be sitting in the buffer
        // where the two overlap and would eat the first object's rim; with a
        // ref each, every shell tests only against its own body, so all the
        // outlines survive on top of each other.
        const ref = (this.nextStencilRef = (this.nextStencilRef % 250) + 1);
        const order = OUTLINE_ORDER + (ref % 100) * 2;
        entry.root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.geometry || o.userData.hoverShell) return;
          const local = m === (entry.root as THREE.Mesh)
            ? new THREE.Matrix4() : (m.updateMatrix(), m.matrix.clone());
          // Pass 1: stamp the object's own pixels into the stencil buffer,
          // writing no colour. It is what keeps the shell to a RIM once the
          // depth test is gone.
          const mask = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({
            colorWrite: false, depthWrite: false, depthTest: false,
            side: THREE.DoubleSide,
            stencilWrite: true, stencilRef: ref,
            stencilFunc: THREE.AlwaysStencilFunc,
            stencilFail: THREE.ReplaceStencilOp,
            stencilZFail: THREE.ReplaceStencilOp,
            stencilZPass: THREE.ReplaceStencilOp,
          }));
          mask.raycast = () => {};
          mask.userData.hoverShell = true;
          mask.renderOrder = order;
          mask.matrixAutoUpdate = false;
          mask.matrix.copy(local);
          // Pass 2: the geometry again, fattened, back faces only — the
          // silhouette. Depth testing is OFF so a selected object stays
          // outlined from behind a wall (an outline you cannot see is the
          // one you are looking for), and the stencil is what stops that
          // from painting the whole shape as a solid blob.
          const shell = new THREE.Mesh(m.geometry, new THREE.ShaderMaterial({
            uniforms: {
              uColor: { value: new THREE.Color(colour) },
              uOpacity: { value: 0.95 },
              uPx: { value: OUTLINE_PX },
              uRes: { value: this.outlineResolution },
            },
            vertexShader: OUTLINE_VERT,
            fragmentShader: OUTLINE_FRAG,
            side: THREE.BackSide,
            transparent: true,
            depthWrite: false, depthTest: false,
            stencilWrite: true, stencilRef: ref,
            stencilFunc: THREE.NotEqualStencilFunc,
            stencilFail: THREE.KeepStencilOp,
            stencilZFail: THREE.KeepStencilOp,
            stencilZPass: THREE.KeepStencilOp,
          }));
          shell.raycast = () => {};
          shell.userData.hoverShell = true;
          shell.renderOrder = order + 1;
          shell.matrixAutoUpdate = false;
          shell.matrix.copy(local);
          group.add(mask, shell);
        });
        if (!group.children.length) continue;
        entry.root.add(group);
        hull = { group, color: colour };
        this.hulls.set(id, hull);
      }
      if (hull.color !== colour) hull.color = colour;
      for (const o of hull.group.children) {
        const mat = (o as THREE.Mesh).material as THREE.ShaderMaterial;
        mat.uniforms?.uColor?.value.set(colour);
      }
    }
  }

  private build(data: TGMesh): THREE.Object3D {
    if (data.kind === 'EMPTY') {
      // Blender "Plain Axes": six half-axes from the origin, plus an
      // invisible-but-raycastable sphere so it stays clickable
      const group = new THREE.Group();
      const r = 0.35;
      const pos = [
        -r, 0, 0, r, 0, 0,
        0, -r, 0, 0, r, 0,
        0, 0, -r, 0, 0, r,
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const axes = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbbbbc4 }));
      axes.userData.emptyHelper = true;
      const pick = new THREE.Mesh(
        new THREE.SphereGeometry(r * 0.5, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      pick.userData.emptyHelper = true;
      group.add(axes, pick);
      return group;
    }
    if (data.kind === 'MODEL' && data.src) {
      const holder = new THREE.Group();
      // The PARSER is chosen by the file's name, which for a stored file is
      // kept in its reference (`store:<hash>/<name>`) precisely because an
      // object URL has no extension to go on.
      const ext = sourceExt(data.src);
      const onLoad = (obj: THREE.Object3D) => {
        obj.traverse((o) => {
          o.userData.meshId = data.id;
          // A file with no normals (common in OBJ, and in anything exported
          // "as points") lights as solid BLACK — every face reports a zero
          // normal. Computing them is cheap and is what any viewer does.
          const g = (o as THREE.Mesh).geometry;
          if (g && !g.getAttribute('normal') && g.getAttribute('position')) g.computeVertexNormals();
          // OBJ and FBX arrive with PHONG materials, and Phong ignores the
          // scene's environment map — which is all the lighting Solid
          // shading has — so they render BLACK while a glTF beside them is
          // lit. Everything here is lit physically; convert to Standard,
          // keeping what the file actually said.
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            const conv = (m: THREE.Material) => {
              const ph = m as THREE.MeshPhongMaterial;
              if (!ph.isMeshPhongMaterial && !(m as THREE.MeshLambertMaterial).isMeshLambertMaterial) return m;
              const out = new THREE.MeshStandardMaterial({
                color: ph.color, map: ph.map, vertexColors: ph.vertexColors,
                transparent: ph.transparent, opacity: ph.opacity, side: ph.side,
                roughness: 0.75, metalness: 0,
              });
              out.name = m.name;
              m.dispose();
              return out;
            };
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
          }
        });
        holder.add(obj);
      };
      const onErr = (err: unknown) => this.errors.set(data.id, String(err));
      // a plain-geometry format arrives as a BufferGeometry, not a scene
      const asMesh = (geo: THREE.BufferGeometry) => {
        if (!geo.getAttribute('normal') && geo.index) geo.computeVertexNormals();
        const vc = !!geo.getAttribute('color');
        onLoad(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          vertexColors: vc, color: vc ? 0xffffff : 0xb8bcc6, side: THREE.DoubleSide,
        })));
      };
      void resolveSrc(data.src).then((url) => {
        if (ext === 'obj') new OBJLoader().load(url, onLoad, undefined, onErr);
        else if (ext === 'fbx') new FBXLoader().load(url, onLoad, undefined, onErr);
        else if (ext === 'stl') new STLLoader().load(url, asMesh, undefined, onErr);
        else if (ext === 'ply') new PLYLoader().load(url, asMesh, undefined, onErr);
        else {
          const loader = new GLTFLoader();
          // Always registered: a VRM IS a glTF, so rather than sniffing the
          // extension we let the plugin decide and check whether it
          // produced a humanoid.
          VrmManager.prepare(loader);
          loader.load(url, (g) => {
            onLoad(g.scene);
            vrmManager.adopt(data.id, g as unknown as { scene: THREE.Object3D });
            // Keep the animation. It used to be dropped here, which is why
            // a Mixamo export imported as a statue: the geometry arrived
            // and the motion was thrown away in the same line.
            if (g.animations?.length) {
              this.modelAnimations.set(data.id, { root: g.scene, clips: g.animations });
            }
          }, undefined, onErr);
        }
      }).catch(onErr);
      return holder;
    }
    const mesh = new THREE.Mesh(
      primitiveGeometry(data.kind),
      new THREE.MeshStandardMaterial(),
    );
    return mesh;
  }

  private apply(root: THREE.Object3D, data: TGMesh, scene: GPScene, camera?: THREE.Camera, live?: boolean): void {
    if (data.billboard === 'CAMERA' && camera) {
      // locked to the view: local transform is a camera-space offset
      camera.updateMatrixWorld();
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(...data.translation),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...data.rotation)),
        new THREE.Vector3(...data.scale),
      );
      root.matrixAutoUpdate = false;
      root.matrix.copy(camera.matrixWorld).multiply(local);
    } else if (data.billboard === 'FACE_VIEW' && camera) {
      root.matrixAutoUpdate = true;
      worldMatrixOf(scene, { kind: 'MESH', id: data.id })
        .decompose(root.position, root.quaternion, root.scale);
      root.quaternion.copy((camera as THREE.PerspectiveCamera).quaternion);
    } else {
      root.matrixAutoUpdate = false;
      root.matrix.copy(worldMatrixOf(scene, { kind: 'MESH', id: data.id }));
    }
    root.visible = data.visible;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // The hover shell rides inside the object's own tree so it inherits
      // every transform, which means this pass would otherwise repaint it
      // with the object's material — turning a thin silhouette into a solid
      // block of colour over the whole prop.
      if (!mesh.isMesh || o.userData.emptyHelper || o.userData.hoverShell) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat || Array.isArray(mat)) return;
      // shadows are per-light opt-in; meshes always participate so turning
      // a light's castShadow on Just Works with no per-object setup
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (data.kind !== 'MODEL') {
        // shared material datablock, falling back to this object's own
        // legacy flattened fields when it has no materialId yet
        materialManager.apply(mat, scene, data.materialId, {
          color: data.color, opacity: data.opacity, texture: data.texture,
          unlit: data.unlit, doubleSided: data.doubleSided, wireframe: data.wireframe,
        }, !!live);
      } else {
        // MODEL imports own their materials (from the GLTF/OBJ); only the
        // non-color display props are ours to set
        if (live) mat.color.setRGB(1, 1, 1);
        mat.wireframe = data.wireframe;
        mat.side = data.doubleSided !== false ? THREE.DoubleSide : THREE.FrontSide;
        mat.transparent = data.opacity < 1 || !!(mat.map);
        mat.opacity = data.opacity;
        mat.depthWrite = data.opacity >= 0.99;
      }
      // selection feedback is the Box3Helper outline (App.syncSelectionGlyphs)
      // only, Blender-style — no whole-object color wash here.
    });
  }

  rootFor(id: number): THREE.Object3D | null { return this.entries.get(id)?.root ?? null; }

  /**
   * The object's triangles in its OWN unscaled frame, for physics.
   *
   * A MODEL's geometry only exists here — the data layer knows a URL, not a
   * vertex — so a convex hull or a triangle-mesh collider for one has to
   * come from the render tree. The root's world matrix is divided back out
   * so the result is comparable to `primitiveGeometry`: local, unscaled, and
   * the caller applies the object's own scale.
   */
  collisionMesh(id: number): { positions: Float32Array; indices: Uint32Array } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.root.updateWorldMatrix(true, true);
    const toLocal = entry.root.matrixWorld.clone().invert();
    const pos: number[] = [];
    const idx: number[] = [];
    const v = new THREE.Vector3();
    entry.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || o.userData.hoverShell) return;
      const attr = mesh.geometry.getAttribute('position');
      if (!attr) return;
      const base = pos.length / 3;
      const m = toLocal.clone().multiply(mesh.matrixWorld);
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr as THREE.BufferAttribute, i).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
      }
      const index = mesh.geometry.getIndex();
      if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
      else for (let i = 0; i < attr.count; i++) idx.push(base + i);
    });
    if (pos.length < 9 || idx.length < 3) return null;
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  }

  /** Meshes flagged as draw targets, for ctx.surfaces (empties never). */
  drawTargets(scene: GPScene): THREE.Object3D[] {
    return scene.meshes
      .filter((m) => m.visible && m.drawTarget && m.kind !== 'EMPTY')
      .map((m) => this.entries.get(m.id)?.root)
      .filter((r): r is THREE.Object3D => !!r);
  }

  /** Texture painting: while a stroke is in flight the tool paints into
   *  an offscreen canvas and we show it live as a CanvasTexture; apply()
   *  leaves the map alone until endLiveTexture(). */
  beginLiveTexture(id: number, canvas: HTMLCanvasElement): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.live = true;
    const mesh = entry.root as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat || Array.isArray(mat)) return;
    if (!(mat.map instanceof THREE.CanvasTexture) || mat.map.image !== canvas) {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.transparent = true;
      mat.needsUpdate = true;
    }
  }

  /** Repaint after new stamps landed on the live canvas. */
  refreshLiveTexture(id: number): void {
    const mesh = this.entries.get(id)?.root as THREE.Mesh | undefined;
    const mat = mesh?.material as THREE.MeshStandardMaterial | undefined;
    if (mat?.map) mat.map.needsUpdate = true;
  }

  endLiveTexture(id: number): void {
    const entry = this.entries.get(id);
    if (entry) entry.live = false; // next sync re-applies data.texture
  }

  private disposeTree(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material;
      if (mat && !Array.isArray(mat)) mat.dispose?.();
    });
  }
}

export function createMeshObject(id: number, kind: TGMesh['kind'], at: [number, number, number], src?: string): TGMesh {
  return {
    id, name: src ? (src.split('/').pop() ?? 'model') : kind.toLowerCase(),
    kind, src,
    translation: [...at], rotation: [0, 0, 0], scale: [1, 1, 1],
    visible: true, select: false, drawTarget: kind !== 'EMPTY', wireframe: false,
    color: [0.62, 0.65, 0.72], opacity: 1,
    parent: null, texture: null, unlit: false, doubleSided: true, billboard: 'NONE',
    originOffset: [0, 0, 0],
  };
}
