// Shared types for the agent interface.
//
// One tool registry, three consumers:
//   - the in-app Agent panel (talks to an LLM provider directly)
//   - MCP clients (Claude Code/Desktop) via agent/mcp-server.js over WebSocket
//   - ACP clients (Zed) via agent/acp-server.js over the same socket
//
// Tools therefore have to be describable as data (JSON Schema in, JSON out)
// rather than as closures over UI state — MCP and ACP both need to enumerate
// and validate them from another process.

/** The JSON Schema subset MCP tool definitions actually use. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  /** tuple-ish vectors: [x, y, z] */
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
}

/** Everything a tool is allowed to touch. Narrower than App on purpose: a
 *  tool that needs something not listed here is a signal to widen this
 *  deliberately rather than to reach into globals. */
export interface AgentHost {
  ctx: import('../tools/context').AppCtx;
  /** Fuzzy command execution — the pre-existing string automation surface. */
  execute(query: string, args?: string): { ok: boolean; id?: string; result?: unknown; error?: string };
  setMode(mode: import('../render/GPSceneRenderer').EditorMode): void;
  setShading(mode: import('../core/types').ViewportShading): void;
  setTool(id: string): void;
  snapView(view: 'FRONT' | 'BACK' | 'RIGHT' | 'LEFT' | 'TOP' | 'BOTTOM'): void;
  addMeshObject(kind: 'PLANE' | 'BOX' | 'SPHERE' | 'CYLINDER' | 'EMPTY', src?: string, at?: [number, number, number]): void;
  addGPObject(): void;
  addLight(kind: import('../core/types').TGLight['kind'], at?: [number, number, number]): void;
  /** base64 PNG of the current viewport — the vision channel */
  screenshot(): string;
  viewAll(): void;
  refreshWidget(): void;
}

export interface AgentTool {
  /** Stable dotted id. This is the wire name for MCP/ACP too. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Mutating tools get pushUndo() before and requestRender() after, so a
   *  handler never has to remember either. Read-only tools skip both, which
   *  is what keeps `scene.summary` from polluting the undo stack. */
  mutates?: boolean;
  /** Long/large output (screenshots) — excluded from the compact catalog
   *  echoed into system prompts. */
  heavy?: boolean;
  handler(host: AgentHost, args: Record<string, unknown>): unknown;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ---- chat / provider types ------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** An image part, for vision-capable models. */
export interface ImagePart { kind: 'image'; mediaType: string; base64: string }
export interface TextPart { kind: 'text'; text: string }
export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  /** provider-assigned id, echoed back with the result */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  /** assistant turns that requested tools */
  toolCalls?: ToolCall[];
  /** role: 'tool' — which call this answers */
  toolCallId?: string;
}

/** Wire dialect. Providers differ in transport, not in capability. */
export type Protocol = 'openai' | 'anthropic' | 'google' | 'ollama';

export interface ProviderDef {
  id: string;
  label: string;
  protocol: Protocol;
  defaultUrl: string;
  /** null = no credential needed (local servers) */
  credentialLabel: string | null;
  /** local servers are reachable without a key and are listed first */
  local?: boolean;
  defaultModel?: string;
  /** shown in the UI when the provider is selected */
  instructions: string;
}

export interface ProviderSettings {
  provider: string;
  model: string;
  /** per-provider base URL overrides */
  urls: Record<string, string>;
  /** per-provider API keys. Browser-local only — see the UI warning. */
  keys: Record<string, string>;
  temperature: number;
  maxTokens: number;
  /** cap on agent loop iterations, so a confused model can't spin forever */
  maxSteps: number;
  /** send a viewport screenshot with each user turn (vision models) */
  sendScreenshot: boolean;
  systemPrompt: string;
}
