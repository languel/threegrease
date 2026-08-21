// JSON-RPC 2.0 over WebSocket — how out-of-process agents reach the tools.
//
// threegrease runs in a browser; MCP and ACP are stdio protocols spoken by
// processes. The browser cannot listen on a socket, so it CONNECTS OUT to the
// relay in agent/ (same pattern as bridge/ for OSC) and answers requests over
// that link. agent/mcp-server.js and agent/acp-server.js translate their
// stdio protocol into these calls.
//
// Methods:
//   tools/list                          -> { tools: [...] }
//   tools/call { name, arguments }      -> { ok, result | error }
//   scene/summary                       -> shorthand for tools/call scene.summary
//   ping                                -> { pong: true, app: 'threegrease' }
import type { AgentHost } from './types';
import { runTool, toolCatalog } from './tools';

interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

export type RpcStatus = 'off' | 'connecting' | 'open';

export class AgentRpc {
  url = '';
  status: RpcStatus = 'off';
  onStatus: ((s: RpcStatus, detail?: string) => void) | null = null;
  /** Fired for every executed call, so the UI can show external activity. */
  onActivity: ((name: string, ok: boolean) => void) | null = null;

  private socket: WebSocket | null = null;
  private retry: number | null = null;
  private stopped = true;

  constructor(private host: AgentHost) {}

  connect(url: string): void {
    this.disconnect();
    this.stopped = false;
    this.url = url;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retry !== null) { clearTimeout(this.retry); this.retry = null; }
    const s = this.socket;
    this.socket = null;
    if (s) { s.onclose = null; s.close(); }
    this.setStatus('off');
  }

  private setStatus(s: RpcStatus, detail?: string): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s, detail);
  }

  private open(): void {
    if (!this.url || this.stopped) return;
    this.setStatus('connecting');
    try { this.socket = new WebSocket(this.url); } catch { this.scheduleRetry(); return; }
    this.socket.onopen = () => {
      this.setStatus('open');
      // announce so the relay knows a live app is attached
      this.socket?.send(JSON.stringify({ jsonrpc: '2.0', method: 'app/hello', params: { app: 'threegrease' } }));
    };
    this.socket.onclose = () => { this.setStatus('off'); this.scheduleRetry(); };
    this.socket.onerror = () => { /* close follows */ };
    this.socket.onmessage = (ev) => this.handle(String(ev.data));
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry !== null) return;
    this.retry = window.setTimeout(() => { this.retry = null; this.open(); }, 2000);
  }

  private reply(id: RpcRequest['id'], body: Record<string, unknown>): void {
    if (id === undefined || id === null) return; // notification
    this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
  }

  private handle(raw: string): void {
    let req: RpcRequest;
    try { req = JSON.parse(raw); } catch { return; }
    const { id, method, params = {} } = req;
    try {
      if (method === 'ping') {
        this.reply(id, { result: { pong: true, app: 'threegrease' } });
        return;
      }
      if (method === 'tools/list') {
        this.reply(id, { result: { tools: toolCatalog(true) } });
        return;
      }
      if (method === 'tools/call') {
        const name = String(params.name ?? '');
        const args = (params.arguments ?? params.args ?? {}) as Record<string, unknown>;
        const res = runTool(this.host, name, args);
        this.onActivity?.(name, res.ok);
        this.reply(id, { result: res });
        return;
      }
      if (method === 'scene/summary') {
        const res = runTool(this.host, 'scene.summary', {});
        this.reply(id, { result: res });
        return;
      }
      this.reply(id, { error: { code: -32601, message: `Unknown method "${method}"` } });
    } catch (err) {
      this.reply(id, { error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
