// LLM provider layer: one registry, four wire protocols.
//
// Modelled on ~/dev/underscores' aiProviders.js — a frozen registry keyed by
// id where each entry declares a `protocol`, and generic functions switch on
// that rather than on the provider — but with two deliberate differences:
//
//  1. NATIVE TOOL CALLING. underscores parses XML tags out of the prose
//     because it targets weak local models. Every protocol here has a real
//     function-calling API, so tool calls come back as structured data and a
//     model cannot "describe" a tool call it didn't actually make. The tag
//     fallback still exists in session.ts for models that ignore the API.
//  2. Non-streaming for tool turns. Tool-call deltas are the messiest part of
//     every streaming format; the agent loop needs the whole call before it
//     can run anything anyway. Prose-only turns still stream.
import type {
  ChatMessage, ContentPart, ProviderDef, ProviderSettings, Protocol, ToolCall,
} from './types';
import type { JsonSchema } from './types';

const PROVIDERS: Record<string, ProviderDef> = Object.freeze({
  // ---- local -------------------------------------------------------------
  ollama: {
    id: 'ollama', label: 'Ollama', protocol: 'ollama', local: true,
    defaultUrl: 'http://localhost:11434', credentialLabel: null,
    instructions:
      'Runs locally through Ollama. Start the service and pick an installed model. For tool use choose a '
      + 'tool-capable model (llama3.1+, qwen2.5-coder, mistral-nemo); smaller models often ignore tools and '
      + 'fall back to the tag protocol. No API key needed.',
  },
  lmstudio: {
    id: 'lmstudio', label: 'LM Studio', protocol: 'openai', local: true,
    defaultUrl: 'http://localhost:1234', credentialLabel: null,
    instructions:
      'LM Studio\'s OpenAI-compatible server on port 1234. Start the local server in LM Studio; enable CORS '
      + 'if you opened threegrease from another origin. No API key needed.',
  },
  mlx: {
    id: 'mlx', label: 'MLX (Apple Silicon)', protocol: 'openai', local: true,
    defaultUrl: 'http://localhost:8080', credentialLabel: 'API key (optional)',
    instructions:
      'Apple-Silicon local inference over an OpenAI-compatible server — mlx_lm.server (default port 8080) or '
      + 'mlx-omni-server (10240). Enter the base URL without /v1. Fast on M-series; tool support depends on '
      + 'the model.',
  },
  unsloth: {
    id: 'unsloth', label: 'Unsloth', protocol: 'openai', local: true,
    defaultUrl: 'http://localhost:8001', credentialLabel: 'API key (optional)',
    instructions:
      'Unsloth\'s OpenAI-compatible local server (usually llama-server on 8001). Enter the base URL without '
      + '/v1. Accepts a placeholder key such as sk-no-key-required.',
  },
  'openai-compatible': {
    id: 'openai-compatible', label: 'OpenAI-compatible (custom)', protocol: 'openai', local: true,
    defaultUrl: 'http://localhost:8000', credentialLabel: 'API key (optional)',
    instructions:
      'Any server speaking the OpenAI REST dialect — vLLM, llama.cpp, TGI, LiteLLM, a proxy. Enter the base '
      + 'URL without /v1; threegrease appends the model and chat routes.',
  },
  // ---- hosted ------------------------------------------------------------
  anthropic: {
    id: 'anthropic', label: 'Claude (Anthropic)', protocol: 'anthropic',
    defaultUrl: 'https://api.anthropic.com', credentialLabel: 'Anthropic API key',
    defaultModel: 'claude-sonnet-4-20250514',
    instructions:
      'Anthropic\'s native Messages API with browser access enabled. Strong at multi-step tool use, which is '
      + 'what this interface is built around. Use a restricted key.',
  },
  openai: {
    id: 'openai', label: 'OpenAI', protocol: 'openai',
    defaultUrl: 'https://api.openai.com', credentialLabel: 'OpenAI API key',
    defaultModel: 'gpt-4o',
    instructions: 'Official OpenAI chat-completions API. Use a restricted project key and a tool-capable model.',
  },
  google: {
    id: 'google', label: 'Google Gemini', protocol: 'google',
    defaultUrl: 'https://generativelanguage.googleapis.com', credentialLabel: 'Google API key',
    defaultModel: 'gemini-2.0-flash',
    instructions: 'Google\'s native Gemini generateContent API. Create a key in Google AI Studio.',
  },
  openrouter: {
    id: 'openrouter', label: 'OpenRouter', protocol: 'openai',
    defaultUrl: 'https://openrouter.ai/api', credentialLabel: 'OpenRouter API key',
    instructions:
      'One key, most models. Good for comparing models against the same scene. Tool support and pricing vary '
      + 'by upstream model — prefer entries the catalog marks as tool-capable.',
  },
});

export const PROVIDER_LIST: ProviderDef[] = Object.values(PROVIDERS)
  .sort((a, b) => Number(!!b.local) - Number(!!a.local) || a.label.localeCompare(b.label));

export function getProvider(id: string): ProviderDef { return PROVIDERS[id] ?? PROVIDERS.ollama; }

export function providerNeedsKey(id: string): boolean { return !!getProvider(id).credentialLabel; }

export function defaultProviderSettings(): ProviderSettings {
  return {
    provider: 'ollama',
    model: '',
    urls: {},
    keys: {},
    temperature: 0.7,
    maxTokens: 4096,
    maxSteps: 12,
    sendScreenshot: false,
    systemPrompt: '',
  };
}

/** Base URL for a provider, trimmed of a trailing slash and any /v1 the user
 *  pasted (every builder below adds its own path). */
export function baseUrl(s: ProviderSettings): string {
  const def = getProvider(s.provider);
  const raw = (s.urls[s.provider] || def.defaultUrl).trim();
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function keyFor(s: ProviderSettings): string { return (s.keys[s.provider] || '').trim(); }

function headers(s: ProviderSettings): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = keyFor(s);
  const p = getProvider(s.provider);
  if (!key) return h;
  if (p.protocol === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
    // without this the browser request is rejected outright
    h['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (p.protocol === 'google') {
    h['x-goog-api-key'] = key;
  } else {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

// ---- model discovery ------------------------------------------------------

export async function listModels(s: ProviderSettings): Promise<string[]> {
  const p = getProvider(s.provider);
  const base = baseUrl(s);
  let url: string;
  if (p.protocol === 'ollama') url = `${base}/api/tags`;
  else if (p.protocol === 'google') url = `${base}/v1beta/models?pageSize=1000`;
  else url = `${base}/v1/models`;

  const res = await fetch(url, { headers: headers(s) });
  if (!res.ok) throw new Error(`${p.label} model list failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  const payload = await res.json();

  if (p.protocol === 'ollama') {
    return (payload?.models ?? []).map((m: { name?: string }) => m?.name).filter(Boolean);
  }
  if (p.protocol === 'google') {
    return (payload?.models ?? [])
      .filter((m: { supportedGenerationMethods?: string[] }) =>
        !m?.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m: { name?: string }) => String(m?.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  const entries = Array.isArray(payload) ? payload : payload?.data ?? payload?.models ?? [];
  return entries.map((m: { id?: string; name?: string }) => m?.id ?? m?.name).filter(Boolean);
}

// ---- content conversion ---------------------------------------------------

function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text).join('\n');
}

function openaiContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.kind === 'text'
    ? { type: 'text', text: p.text }
    : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.base64}` } }));
}

function anthropicContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.kind === 'text'
    ? { type: 'text', text: p.text }
    : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } }));
}

function googleParts(content: string | ContentPart[]): unknown[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((p) => (p.kind === 'text'
    ? { text: p.text }
    : { inline_data: { mime_type: p.mediaType, data: p.base64 } }));
}

export interface ToolDef { name: string; description: string; inputSchema: JsonSchema }

export interface ChatTurn {
  /** assistant prose (may be empty when the model went straight to tools) */
  text: string;
  toolCalls: ToolCall[];
  /** raw finish reason, for diagnostics */
  stop?: string;
}

// ---- request building -----------------------------------------------------

function buildBody(s: ProviderSettings, messages: ChatMessage[], tools: ToolDef[]): { url: string; init: RequestInit } {
  const p = getProvider(s.provider);
  const base = baseUrl(s);
  const model = s.model || p.defaultModel || 'default';

  if (p.protocol === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
    const rest: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        rest.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: textOf(m.content) }] });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: unknown[] = [];
        const t = textOf(m.content);
        if (t) blocks.push({ type: 'text', text: t });
        for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
        rest.push({ role: 'assistant', content: blocks });
        continue;
      }
      rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: anthropicContent(m.content) });
    }
    return {
      url: `${base}/v1/messages`,
      init: {
        method: 'POST', headers: headers(s),
        body: JSON.stringify({
          model, system: system || undefined, messages: rest,
          max_tokens: s.maxTokens, temperature: s.temperature,
          ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
        }),
      },
    };
  }

  if (p.protocol === 'google') {
    const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
    const contents: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: m.toolCallId, response: { result: textOf(m.content) } } }],
        });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        contents.push({
          role: 'model',
          parts: m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
        });
        continue;
      }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: googleParts(m.content) });
    }
    return {
      url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: 'POST', headers: headers(s),
        body: JSON.stringify({
          contents,
          ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { temperature: s.temperature, maxOutputTokens: s.maxTokens },
          ...(tools.length ? {
            tools: [{ function_declarations: tools.map((t) => ({
              name: t.name, description: t.description, parameters: stripSchema(t.inputSchema),
            })) }],
          } : {}),
        }),
      },
    };
  }

  if (p.protocol === 'ollama') {
    return {
      url: `${base}/api/chat`,
      init: {
        method: 'POST', headers: headers(s),
        body: JSON.stringify({
          model, stream: false,
          options: { temperature: s.temperature },
          messages: messages.map((m) => (m.role === 'tool'
            ? { role: 'tool', content: textOf(m.content) }
            : {
              role: m.role,
              content: textOf(m.content),
              ...(m.toolCalls?.length
                ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) }
                : {}),
            })),
          ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
        }),
      },
    };
  }

  // openai dialect
  return {
    url: `${base}/v1/chat/completions`,
    init: {
      method: 'POST', headers: headers(s),
      body: JSON.stringify({
        model, temperature: s.temperature, max_tokens: s.maxTokens,
        messages: messages.map((m) => {
          if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: textOf(m.content) };
          if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
              role: 'assistant', content: textOf(m.content) || null,
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id, type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            };
          }
          return { role: m.role, content: openaiContent(m.content) };
        }),
        ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
      }),
    },
  };
}

/** Gemini rejects some JSON Schema keywords the others accept. */
function stripSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === 'default' || k === 'minItems' || k === 'maxItems') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, JsonSchema>).map(([pk, pv]) => [pk, stripSchema(pv)]));
    } else if (k === 'items' && v && typeof v === 'object') {
      out.items = stripSchema(v as JsonSchema);
    } else out[k] = v;
  }
  return out as JsonSchema;
}

// ---- response parsing -----------------------------------------------------

let callSeq = 0;
const nextId = () => `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`;

function parseResponse(protocol: Protocol, payload: Record<string, unknown>): ChatTurn {
  if (protocol === 'anthropic') {
    const blocks = (payload.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id ?? nextId(), name: b.name ?? '', args: (b.input ?? {}) as Record<string, unknown>,
      })),
      stop: String(payload.stop_reason ?? ''),
    };
  }
  if (protocol === 'google') {
    const cand = ((payload.candidates ?? []) as Record<string, unknown>[])[0] ?? {};
    const parts = (((cand.content ?? {}) as Record<string, unknown>).parts ?? []) as Record<string, unknown>[];
    return {
      text: parts.map((p) => String(p.text ?? '')).join(''),
      toolCalls: parts.filter((p) => p.functionCall).map((p) => {
        const fc = p.functionCall as { name?: string; args?: Record<string, unknown> };
        return { id: fc.name ?? nextId(), name: fc.name ?? '', args: fc.args ?? {} };
      }),
      stop: String(cand.finishReason ?? ''),
    };
  }
  if (protocol === 'ollama') {
    const msg = (payload.message ?? {}) as Record<string, unknown>;
    const calls = (msg.tool_calls ?? []) as { function?: { name?: string; arguments?: unknown } }[];
    return {
      text: String(msg.content ?? ''),
      toolCalls: calls.map((c) => ({
        id: nextId(), name: c.function?.name ?? '',
        // Ollama sends an object; some builds send a JSON string.
        args: typeof c.function?.arguments === 'string'
          ? safeJson(c.function.arguments) : (c.function?.arguments ?? {}) as Record<string, unknown>,
      })),
      stop: String(payload.done_reason ?? ''),
    };
  }
  const choice = ((payload.choices ?? []) as Record<string, unknown>[])[0] ?? {};
  const msg = (choice.message ?? {}) as Record<string, unknown>;
  const calls = (msg.tool_calls ?? []) as { id?: string; function?: { name?: string; arguments?: string } }[];
  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: calls.map((c) => ({
      id: c.id ?? nextId(), name: c.function?.name ?? '', args: safeJson(c.function?.arguments ?? '{}'),
    })),
    stop: String(choice.finish_reason ?? ''),
  };
}

function safeJson(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

// ---- the one call the session loop makes ----------------------------------

export async function chat(
  s: ProviderSettings, messages: ChatMessage[], tools: ToolDef[], signal?: AbortSignal,
): Promise<ChatTurn> {
  const p = getProvider(s.provider);
  const { url, init } = buildBody(s, messages, tools);
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(explainFailure(p, res.status, body));
  }
  return parseResponse(p.protocol, await res.json());
}

/** Turn the usual failures into something actionable rather than a bare code. */
function explainFailure(p: ProviderDef, status: number, body: string): string {
  const detail = (() => {
    try {
      const j = JSON.parse(body);
      return j?.error?.message ?? j?.error ?? j?.message ?? '';
    } catch { return body.slice(0, 300); }
  })();
  if (status === 401 || status === 403) {
    return `${p.label} rejected the credentials (${status}). ${p.credentialLabel ? `Check the ${p.credentialLabel}.` : ''} ${detail}`.trim();
  }
  if (status === 404 && p.local) {
    return `${p.label} returned 404 — is the model pulled/loaded, and is the base URL right? ${detail}`.trim();
  }
  if (status === 0 || status >= 500) {
    return `${p.label} error ${status}. ${p.local ? 'Is the local server running?' : ''} ${detail}`.trim();
  }
  return `${p.label} error ${status}: ${detail}`;
}
