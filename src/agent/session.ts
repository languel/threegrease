// The agent loop: prompt -> model -> tool calls -> results -> repeat.
//
// Bounded by ProviderSettings.maxSteps so a confused model cannot spin
// forever against a live scene, and every tool result is fed back as a real
// tool message so the model can correct its own mistakes rather than being
// told the turn failed.
import type { AgentHost, ChatMessage, ContentPart, ToolCall } from './types';
import { chat, getProvider, type ToolDef } from './providers';
import type { ProviderSettings } from './types';
import { runTool, toolCatalog } from './tools';

export interface SessionEvent {
  kind: 'assistant' | 'tool-call' | 'tool-result' | 'error' | 'done' | 'status';
  text?: string;
  call?: ToolCall;
  ok?: boolean;
  result?: unknown;
}

export type SessionListener = (ev: SessionEvent) => void;

const BASE_PROMPT = [
  'You are an agent embedded in threegrease, a 3D grease-pencil drawing application (Blender Grease Pencil',
  'reimplemented in three.js). You act by calling tools; you cannot click the UI.',
  '',
  'Working method:',
  '- Call scene.summary FIRST on any new request. It gives you the object/layer/material ids every other',
  '  tool needs. Never guess an id.',
  '- Coordinates: GP stroke points are in the GP object\'s OBJECT space. The world is Z-up by default, so the',
  '  ground plane is XY and Z is height. A stroke drawn in the XY plane lies flat on the ground; to draw',
  '  something standing up, vary Z.',
  '- Draw with stroke.create. Give it enough points to look intentional — a smooth curve wants 12+ points,',
  '  not 3. Compute the points; do not ask the user for coordinates.',
  '- After drawing something visual, consider view.screenshot to check your own work, but only if you can',
  '  actually see images.',
  '- app.command reaches anything without a dedicated tool. Call app.commands to discover what exists.',
  '- If a tool returns an error, read it and fix the call. Errors are information, not failure.',
  '',
  'Be concise in prose. Do the work rather than describing what you would do.',
].join('\n');

/** Tag protocol for models that ignore the native tool API. Deliberately
 *  strict: only a fenced block whose JSON has an explicit `tool` key counts,
 *  so ordinary Markdown code the model writes is never executed. */
const TAG_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;

export function parseTaggedCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const o = parsed as Record<string, unknown>;
    const name = typeof o.tool === 'string' ? o.tool : typeof o.action === 'string' ? o.action : '';
    if (!name) continue;
    const args = (o.args ?? o.payload ?? o.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || Array.isArray(args)) continue;
    out.push({ id: `tag_${out.length}`, name, args: args as Record<string, unknown> });
  }
  return out;
}

const TAG_INSTRUCTIONS = [
  '',
  'TOOL PROTOCOL (this model does not support native tool calls):',
  'To call a tool, emit a fenced json block containing exactly:',
  '```json',
  '{"tool": "scene.summary", "args": {}}',
  '```',
  'One block per call. Emit nothing else in that block. After the results come back, continue.',
].join('\n');

/** The {mediaType, base64} envelope view.screenshot returns, if that's what
 *  this is. */
function asImage(result: unknown): { mediaType: string; base64: string } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  return typeof r.base64 === 'string' && typeof r.mediaType === 'string'
    ? { mediaType: r.mediaType, base64: r.base64 } : null;
}

/** Keep a megabyte of base64 out of the UI transcript too. */
function summarize(result: unknown): unknown {
  const img = asImage(result);
  return img ? `<${img.mediaType}, ${Math.round(img.base64.length / 1024)}KB>` : result;
}

export class AgentSession {
  messages: ChatMessage[] = [];
  running = false;
  private abort: AbortController | null = null;
  /** Set once a provider has demonstrably ignored the native tool API, so
   *  the tag instructions are only paid for when they're actually needed. */
  private tagMode = false;

  constructor(private host: AgentHost, private settings: ProviderSettings) {}

  setSettings(s: ProviderSettings): void { this.settings = s; }

  reset(): void { this.messages = []; this.tagMode = false; }

  cancel(): void { this.abort?.abort(); this.running = false; }

  private systemPrompt(): string {
    const extra = this.settings.systemPrompt.trim();
    return [BASE_PROMPT, extra, this.tagMode ? TAG_INSTRUCTIONS : ''].filter(Boolean).join('\n');
  }

  /** Run one user turn to completion (prose, or tools until the model stops). */
  async send(userText: string, emit: SessionListener): Promise<void> {
    if (this.running) throw new Error('A turn is already running');
    this.running = true;
    this.abort = new AbortController();
    const { signal } = this.abort;

    // Only offer the screenshot tool when the user has said this model can
    // see. A text-only local model will otherwise call it, and the image that
    // comes back is at best wasted context and at worst a template error.
    const tools: ToolDef[] = toolCatalog(this.settings.sendScreenshot);
    const content: ContentPart[] = [{ kind: 'text', text: userText }];
    if (this.settings.sendScreenshot) {
      try {
        content.push({ kind: 'image', mediaType: 'image/png', base64: this.host.screenshot() });
      } catch { /* a failed screenshot must not block the turn */ }
    }
    this.messages.push({ role: 'user', content });

    try {
      for (let step = 0; step < Math.max(1, this.settings.maxSteps); step++) {
        const wire: ChatMessage[] = [
          { role: 'system', content: this.systemPrompt() },
          ...this.messages,
        ];
        const turn = await chat(this.settings, wire, this.tagMode ? [] : tools, signal);

        let calls = turn.toolCalls;
        // Fallback: a model that emitted tool JSON as prose instead of using
        // the API. Switch to the documented tag protocol for the rest of the
        // session rather than failing the turn.
        if (!calls.length && turn.text) {
          const tagged = parseTaggedCalls(turn.text);
          if (tagged.length) {
            calls = tagged;
            if (!this.tagMode) {
              this.tagMode = true;
              emit({ kind: 'status', text: 'Model is not using native tool calls — switched to the tag protocol.' });
            }
          }
        }

        if (turn.text) emit({ kind: 'assistant', text: turn.text });

        if (!calls.length) {
          this.messages.push({ role: 'assistant', content: turn.text });
          emit({ kind: 'done' });
          return;
        }

        this.messages.push({ role: 'assistant', content: turn.text, toolCalls: calls });

        for (const call of calls) {
          emit({ kind: 'tool-call', call });
          const res = runTool(this.host, call.name, call.args);
          emit({ kind: 'tool-result', call, ok: res.ok, result: res.ok ? summarize(res.result) : res.error });

          // An image result must NOT be stringified into the tool message.
          // Doing so pushes ~500KB of base64 into the transcript as text: it
          // is useless to the model, it dominates the context window, and it
          // broke Ollama's chat template outright. Acknowledge it as text and
          // deliver the pixels as a real image part, which is the only shape
          // every provider accepts (tool messages are text-only on OpenAI and
          // Gemini, so the image cannot ride inside the result).
          const image = asImage(res.result);
          if (res.ok && image) {
            this.messages.push({
              role: 'tool', toolCallId: call.id,
              content: 'Screenshot captured; the image follows in the next message.',
            });
            this.messages.push({
              role: 'user',
              content: [
                { kind: 'text', text: `Result of ${call.name}:` },
                { kind: 'image', mediaType: image.mediaType, base64: image.base64 },
              ],
            });
            continue;
          }
          this.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(res.ok ? res.result ?? null : { error: res.error }),
          });
        }
      }
      emit({ kind: 'status', text: `Stopped after ${this.settings.maxSteps} steps (step limit).` });
      emit({ kind: 'done' });
    } catch (err) {
      if (signal.aborted) emit({ kind: 'status', text: 'Cancelled.' });
      else emit({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      emit({ kind: 'done' });
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  /** Human-readable provider label, for the panel header. */
  describe(): string {
    const p = getProvider(this.settings.provider);
    return `${p.label}${this.settings.model ? ` · ${this.settings.model}` : ''}`;
  }
}
