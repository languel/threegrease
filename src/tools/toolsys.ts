import type { AppCtx } from './context';

export interface ToolEvent {
  x: number; y: number;          // canvas px
  pressure: number;
  shift: boolean; ctrl: boolean; alt: boolean;
  clientX: number; clientY: number;
}

export interface Tool {
  id: string;
  cursor?: string;
  onDown(ctx: AppCtx, e: ToolEvent): void;
  onMove(ctx: AppCtx, e: ToolEvent): void;
  onUp(ctx: AppCtx, e: ToolEvent): void;
  /** Return true if the key was consumed. */
  onKey?(ctx: AppCtx, key: string, e: KeyboardEvent): boolean;
  /** Draw 2D overlay (guides, lasso, brush circle) onto the HUD canvas. */
  drawHud?(ctx: AppCtx, hud: CanvasRenderingContext2D): void;
  onCancel?(ctx: AppCtx): void;
}

export class ToolManager {
  private tools = new Map<string, Tool>();
  private activeId: string | null = null;
  private pointerDown = false;
  lastPointer = { x: 0, y: 0 };

  register(tool: Tool): void { this.tools.set(tool.id, tool); }
  get(id: string): Tool | undefined { return this.tools.get(id); }

  setActive(ctx: AppCtx, id: string): void {
    if (this.pointerDown && this.activeId) this.tools.get(this.activeId)?.onCancel?.(ctx);
    this.pointerDown = false;
    this.activeId = id;
    ctx.settings.activeTool = id;
  }
  get active(): Tool | undefined { return this.activeId ? this.tools.get(this.activeId) : undefined; }
  get isPointerDown(): boolean { return this.pointerDown; }

  handleDown(ctx: AppCtx, e: ToolEvent): void {
    this.pointerDown = true;
    this.lastPointer = { x: e.x, y: e.y };
    this.active?.onDown(ctx, e);
  }
  handleMove(ctx: AppCtx, e: ToolEvent): void {
    this.lastPointer = { x: e.x, y: e.y };
    this.active?.onMove(ctx, e);
  }
  handleUp(ctx: AppCtx, e: ToolEvent): void {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    this.active?.onUp(ctx, e);
  }
  handleKey(ctx: AppCtx, key: string, e: KeyboardEvent): boolean {
    return this.active?.onKey?.(ctx, key, e) ?? false;
  }
  cancel(ctx: AppCtx): void {
    if (this.pointerDown) this.active?.onCancel?.(ctx);
    this.pointerDown = false;
  }
}
