// Agent panel: provider/model configuration, the chat transcript, and the
// out-of-process link status.
//
// Kept out of ui.ts (already 4k lines) because it owns real state — a session,
// a transcript, an in-flight request — rather than being rebuilt from the
// scene on every refresh like every other panel. UI.refresh() re-mounts the
// container, but the session and transcript survive because they live here.
import type { ChatMessage, ProviderSettings, ToolCall } from './types';
import type { AgentHost } from './types';
import { AgentSession } from './session';
import { PROVIDER_LIST, defaultProviderSettings, getProvider, listModels } from './providers';
import { AgentRpc } from './rpc';
import { webMcp } from './webmcp';

const PREFS_KEY = 'threegrease.agent';

export function loadAgentSettings(): ProviderSettings {
  const base = defaultProviderSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { ...base, ...saved, urls: { ...saved.urls }, keys: { ...saved.keys } };
  } catch { return base; }
}

export function saveAgentSettings(s: ProviderSettings): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

interface Entry {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'status';
  text: string;
  call?: ToolCall;
  ok?: boolean;
  /** who invoked it — absent for the in-app chat's own calls */
  source?: 'relay' | 'webmcp';
}

export class AgentPanel {
  settings: ProviderSettings = loadAgentSettings();
  private session: AgentSession;
  private transcript: Entry[] = [];
  private models: string[] = [];
  private modelError = '';
  private busy = false;
  private draft = '';
  /** Set by the panel builder each refresh so async work can re-render. */
  private rerender: (() => void) | null = null;

  constructor(private host: AgentHost, readonly rpc: AgentRpc) {
    this.session = new AgentSession(host, this.settings);
    this.rpc.onStatus = () => this.rerender?.();
    this.rpc.onActivity = (name, ok) => {
      this.transcript.push({ role: 'tool', text: name, source: 'relay', ok });
      this.rerender?.();
    };
    // The browser's own agent drives the same tools; surface its calls in
    // the same transcript so the panel shows everything acting on the scene,
    // not only what was typed into it.
    webMcp.onStatus = () => this.rerender?.();
    webMcp.onActivity = (name, ok) => {
      this.transcript.push({ role: 'tool', text: name, source: 'webmcp', ok });
      this.rerender?.();
    };
  }

  setRerender(fn: () => void): void { this.rerender = fn; }

  get state() {
    return {
      settings: this.settings, transcript: this.transcript, models: this.models,
      modelError: this.modelError, busy: this.busy, draft: this.draft,
      rpcStatus: this.rpc.status,
    };
  }

  setDraft(v: string): void { this.draft = v; }

  update(patch: Partial<ProviderSettings>): void {
    const switched = patch.provider !== undefined && patch.provider !== this.settings.provider;
    this.settings = { ...this.settings, ...patch };
    // Switching provider invalidates the cached model list, and the old
    // model id almost certainly doesn't exist on the new one. Only clear it
    // when the caller did NOT supply a model in the same patch — otherwise
    // setting provider+model together silently discards the model and the
    // request goes out as 'default'.
    if (switched) {
      this.models = [];
      this.modelError = '';
      if (patch.model === undefined) this.settings.model = getProvider(this.settings.provider).defaultModel ?? '';
    }
    this.session.setSettings(this.settings);
    saveAgentSettings(this.settings);
    this.rerender?.();
  }

  setUrl(url: string): void {
    this.update({ urls: { ...this.settings.urls, [this.settings.provider]: url } });
  }

  setKey(key: string): void {
    this.update({ keys: { ...this.settings.keys, [this.settings.provider]: key } });
  }

  clear(): void { this.transcript = []; this.session.reset(); this.rerender?.(); }

  cancel(): void { this.session.cancel(); }

  async refreshModels(): Promise<void> {
    this.modelError = '';
    this.models = [];
    this.rerender?.();
    try {
      this.models = await listModels(this.settings);
      if (!this.settings.model && this.models.length) this.update({ model: this.models[0] });
    } catch (err) {
      this.modelError = err instanceof Error ? err.message : String(err);
    }
    this.rerender?.();
  }

  async send(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.busy) return;
    this.draft = '';
    this.busy = true;
    this.transcript.push({ role: 'user', text: prompt });
    this.rerender?.();
    await this.session.send(prompt, (ev) => {
      if (ev.kind === 'assistant' && ev.text) this.transcript.push({ role: 'assistant', text: ev.text });
      else if (ev.kind === 'tool-call' && ev.call) {
        this.transcript.push({ role: 'tool', text: summarizeCall(ev.call), call: ev.call });
      } else if (ev.kind === 'tool-result') {
        const last = this.transcript[this.transcript.length - 1];
        if (last?.role === 'tool') {
          last.ok = ev.ok;
          if (!ev.ok) last.text += ` — ${String(ev.result).slice(0, 200)}`;
        }
      } else if (ev.kind === 'error') this.transcript.push({ role: 'error', text: ev.text ?? 'error' });
      else if (ev.kind === 'status') this.transcript.push({ role: 'status', text: ev.text ?? '' });
      this.rerender?.();
    });
    this.busy = false;
    this.rerender?.();
  }

  /** Transcript as plain text, for the copy button. */
  asText(): string {
    return this.transcript.map((e) => `${e.role}: ${e.text}`).join('\n\n');
  }

  describeProvider(): string { return this.session.describe(); }
}

function summarizeCall(call: ToolCall): string {
  const args = Object.entries(call.args ?? {})
    .map(([k, v]) => {
      const s = Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? '{…}' : String(v);
      return `${k}=${s.length > 24 ? `${s.slice(0, 24)}…` : s}`;
    })
    .join(' ');
  return `${call.name}${args ? ` ${args}` : ''}`;
}

export type { ChatMessage };
