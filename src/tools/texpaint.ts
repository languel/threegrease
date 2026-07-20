// Texture Paint: brush strokes land DIRECTLY in a mesh's texture — the
// 2D complement to painting in 3D. Raycasts the mesh under the pointer,
// takes the hit UV, and stamps soft circles into an offscreen canvas
// shown live as a CanvasTexture (MeshManager.beginLiveTexture seam); on
// release the canvas persists as the mesh's `texture` dataURL, so it
// saves with the scene and survives reload. Brush mappings: Size = stamp
// diameter in TEXTURE pixels, Strength = stamp opacity, vertex color =
// paint color. One undo step per stroke. One mesh per stroke (the one
// first hit); meshes without UVs (imported models sometimes) are skipped.
import * as THREE from 'three';
import type { AppCtx } from './context';
import type { Tool, ToolEvent } from './toolsys';
import type { MeshManager } from '../render/meshes';

const TEX_SIZE = 1024;

let meshMgr: MeshManager | null = null;
/** Wired once from App init (keeps the manager out of AppCtx). */
export function setTexPaintMeshManager(m: MeshManager): void { meshMgr = m; }

const raycaster = new THREE.Raycaster();

interface Session {
  meshId: number;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  lastUv: THREE.Vector2 | null;
}

export class TexturePaintTool implements Tool {
  id = 'texpaint';
  cursor = 'crosshair';
  private session: Session | null = null;

  private hit(ctx: AppCtx, e: ToolEvent): { meshId: number; uv: THREE.Vector2 } | null {
    const rect = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((e.x / rect.width) * 2 - 1, -(e.y / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.camera);
    for (const h of raycaster.intersectObjects(ctx.pickableMeshes, true)) {
      if (!h.uv) continue;
      let cur: THREE.Object3D | null = h.object;
      while (cur) {
        if (cur.userData.meshId !== undefined) {
          const m = ctx.scene.meshes.find((x) => x.id === cur!.userData.meshId);
          if (!m || m.lock || m.kind === 'EMPTY') return null;
          return { meshId: m.id, uv: h.uv.clone() };
        }
        cur = cur.parent;
      }
    }
    return null;
  }

  private beginSession(ctx: AppCtx, meshId: number): Session {
    const m = ctx.scene.meshes.find((x) => x.id === meshId)!;
    const canvas = document.createElement('canvas');
    canvas.width = TEX_SIZE;
    canvas.height = TEX_SIZE;
    const g = canvas.getContext('2d')!;
    // start from the mesh's current look: its texture if present (drawn
    // when the image decodes — stamps before that land on the base color),
    // else a solid fill of the object color
    g.fillStyle = `rgb(${m.color.map((c) => Math.round(c * 255)).join(',')})`;
    g.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
    if (m.texture) {
      const img = new Image();
      img.onload = () => {
        g.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
        meshMgr?.refreshLiveTexture(meshId);
      };
      img.src = m.texture;
    }
    meshMgr?.beginLiveTexture(meshId, canvas);
    return { meshId, canvas, g, lastUv: null };
  }

  private stamp(ctx: AppCtx, s: Session, uv: THREE.Vector2, pressure: number): void {
    const b = ctx.settings.brush;
    const radius = Math.max(1, (b.size / 2) * (TEX_SIZE / 512) * Math.max(0.2, pressure));
    const [r, g2, bl] = b.vertexColor;
    const draw = (u: number, v: number) => {
      const x = u * TEX_SIZE;
      const y = (1 - v) * TEX_SIZE; // canvas y is flipped vs UV
      const grad = s.g.createRadialGradient(x, y, 0, x, y, radius);
      const rgb = `${Math.round(r * 255)},${Math.round(g2 * 255)},${Math.round(bl * 255)}`;
      grad.addColorStop(0, `rgba(${rgb},${b.strength})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      s.g.fillStyle = grad;
      s.g.beginPath();
      s.g.arc(x, y, radius, 0, Math.PI * 2);
      s.g.fill();
    };
    if (s.lastUv) {
      // fill the segment so fast drags don't leave gaps (UV space)
      const stepLen = (radius * 0.4) / TEX_SIZE;
      const d = uv.clone().sub(s.lastUv);
      const n = Math.max(1, Math.ceil(d.length() / stepLen));
      for (let i = 1; i <= n; i++) draw(s.lastUv.x + (d.x * i) / n, s.lastUv.y + (d.y * i) / n);
    } else {
      draw(uv.x, uv.y);
    }
    s.lastUv = uv.clone();
    meshMgr?.refreshLiveTexture(s.meshId);
  }

  onDown(ctx: AppCtx, e: ToolEvent): void {
    const hit = this.hit(ctx, e);
    if (!hit) return;
    ctx.pushUndo(); // one undo step per stroke (texture dataURL snapshot)
    this.session = this.beginSession(ctx, hit.meshId);
    this.stamp(ctx, this.session, hit.uv, e.pressure || 1);
  }

  onMove(ctx: AppCtx, e: ToolEvent): void {
    if (!this.session) return;
    const hit = this.hit(ctx, e);
    if (!hit || hit.meshId !== this.session.meshId) {
      this.session.lastUv = null; // brush left the surface: lift
      return;
    }
    this.stamp(ctx, this.session, hit.uv, e.pressure || 1);
  }

  onUp(ctx: AppCtx): void {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    const m = ctx.scene.meshes.find((x) => x.id === s.meshId);
    if (m) {
      m.texture = s.canvas.toDataURL('image/png');
      m.unlit ??= false;
    }
    meshMgr?.endLiveTexture(s.meshId);
    ctx.refreshUI();
  }

  onCancel(ctx: AppCtx): void {
    // discard the in-flight canvas; next sync restores the data texture
    if (this.session) meshMgr?.endLiveTexture(this.session.meshId);
    this.session = null;
    void ctx;
  }
}
