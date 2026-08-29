// WebMCP: expose this app's tools to an agent running in the BROWSER.
//
// Same registry as everything else. `AGENT_TOOLS` already backs the in-app
// chat, the MCP relay and ACP; WebMCP is simply a fourth consumer, so a tool
// added in tools.ts reaches Chrome's built-in agent with no work here.
//
// Spec: https://webmachinelearning.github.io/webmcp/
//   document.modelContext.registerTool(tool, { signal })
//   tool.execute(inputObject, { signal }) -> Promise<any>, JSON-serialized
//   unregister by aborting the signal — there is no unregisterTool()
//
// Two shapes are accepted at runtime because the entry point moved during
// incubation: the spec and Chrome's origin trial both use
// `document.modelContext`, while earlier prototypes hung it off `navigator`.
// Feature-detect rather than assume, since guessing wrong here fails
// silently — registerTool just never runs and the page looks tool-less.
import { AGENT_TOOLS, runTool } from './tools';
import type { AgentHost, AgentTool } from './types';

/** MCP content block, which is what `execute` resolves to. */
interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}
interface ToolReply { content: ContentBlock[]; isError?: boolean }

interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ToolReply>;
}
interface ModelContextLike {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void>;
}

export type WebMcpStatus = 'unsupported' | 'insecure' | 'off' | 'on' | 'error';

/** Where the browser exposes the API, or null if it does not. */
function modelContext(): ModelContextLike | null {
  const fromDoc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (fromDoc?.registerTool) return fromDoc;
  const fromNav = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (fromNav?.registerTool) return fromNav;
  return null;
}

/**
 * Tool names are constrained to 1–128 chars of [A-Za-z0-9_.-] by the spec.
 * Ours are dotted ids like `scene.summary`, which already comply — this
 * guards against a future tool name that would make registerTool reject the
 * WHOLE batch and take every other tool down with it.
 */
function nameOk(name: string): boolean {
  return name.length > 0 && name.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(name);
}

/** Our ToolResult -> MCP content blocks. */
function toReply(result: { ok: boolean; result?: unknown; error?: string }): ToolReply {
  if (!result.ok) {
    return { content: [{ type: 'text', text: result.error ?? 'tool failed' }], isError: true };
  }
  const value = result.result;
  // A screenshot is an image, not 500KB of base64 pasted into a text block —
  // the same distinction the in-app session makes when it converts a tool
  // result into a real image part.
  if (value && typeof value === 'object' && 'base64' in value && 'mediaType' in value) {
    const img = value as { base64: string; mediaType: string };
    return { content: [{ type: 'image', data: img.base64, mimeType: img.mediaType }] };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true });
  // Some handlers RETURN an error object rather than throwing (a missing id
  // is information for the model, not an exception). runTool reports those
  // as ok, so without this they would reach the agent as a success whose
  // body happens to say "error" — flag them properly instead.
  const returnedError = !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { error?: unknown }).error === 'string';
  return returnedError ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

export class WebMcp {
  status: WebMcpStatus = 'off';
  error = '';
  /** how many tools are currently registered with the browser */
  count = 0;
  /** aborting this unregisters every tool at once (the spec's only way) */
  private controller: AbortController | null = null;
  private host: AgentHost | null = null;

  onStatus: (() => void) | null = null;
  /** fires when the browser's agent calls one of our tools, so the chat
   *  transcript can show external activity the way the relay link does */
  onActivity: ((name: string, ok: boolean) => void) | null = null;

  /** Available at all, in this browser and this context? */
  probe(): WebMcpStatus {
    if (!modelContext()) return 'unsupported';
    // registerTool is SecureContext-gated; http:// on a LAN address is the
    // usual way to hit this, and the failure is otherwise opaque.
    if (!window.isSecureContext) return 'insecure';
    return this.status === 'on' ? 'on' : 'off';
  }

  bind(host: AgentHost): void { this.host = host; }

  get connected(): boolean { return this.status === 'on'; }

  async enable(): Promise<void> {
    if (this.status === 'on') return;
    const mc = modelContext();
    if (!mc) { this.set('unsupported'); return; }
    if (!window.isSecureContext) { this.set('insecure'); return; }
    if (!this.host) { this.set('error', 'agent host not ready'); return; }

    const controller = new AbortController();
    this.controller = controller;
    let registered = 0;
    try {
      for (const tool of AGENT_TOOLS) {
        if (!nameOk(tool.name)) continue;
        await mc.registerTool(this.descriptor(tool), { signal: controller.signal });
        registered++;
      }
      this.count = registered;
      this.set('on');
    } catch (err) {
      controller.abort();
      this.controller = null;
      this.count = 0;
      this.set('error', err instanceof Error ? err.message : String(err));
    }
  }

  disable(): void {
    this.controller?.abort();
    this.controller = null;
    this.count = 0;
    if (this.status !== 'error') this.set('off');
    else this.set('off');
  }

  private descriptor(tool: AgentTool): ModelContextTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        // A read-only tool lets the agent call it without a confirmation
        // prompt. `mutates` is already the flag that decides whether the
        // dispatcher pushes undo, so the two can never drift apart.
        readOnlyHint: !tool.mutates,
      },
      execute: async (input) => {
        const host = this.host;
        if (!host) return { content: [{ type: 'text', text: 'app not ready' }], isError: true };
        // Straight through runTool, so an external agent gets the same undo
        // push, the same re-render and the same error handling as the
        // in-app chat. No second dispatch path to keep in sync.
        const result = runTool(host, tool.name, (input ?? {}) as Record<string, unknown>);
        const reply = toReply(result);
        // Report the SAME verdict the agent sees. Taking `result.ok` here
        // instead would mark a handler that returned an error object as a
        // success in the transcript while the agent was told it failed.
        this.onActivity?.(tool.name, !reply.isError);
        return reply;
      },
    };
  }

  private set(status: WebMcpStatus, error = ''): void {
    this.status = status;
    this.error = error;
    this.onStatus?.();
  }
}

export const webMcp = new WebMcp();
