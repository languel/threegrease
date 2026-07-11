// WebSocket link: JSON {address, args} frames both ways. Pairs with the
// bridge/ Node relay for UDP OSC and hardware MIDI. Auto-reconnects.
import { bus, type TGEvent } from './bus';

export class WsLink {
  url = '';
  private socket: WebSocket | null = null;
  private unsub: (() => void) | null = null;
  private retryTimer: number | null = null;
  status: 'off' | 'connecting' | 'open' = 'off';
  onStatus: ((s: WsLink['status']) => void) | null = null;

  connect(url: string): void {
    this.disconnect();
    this.url = url;
    this.open();
    // forward outgoing traffic (anything not from the ws itself) — scoped
    // to /osc/* and /ws/* so MIDI-only users don't spam the socket
    this.unsub = bus.on('*', (ev) => {
      if (ev.source === 'ws:in') return;
      if (!ev.address.startsWith('/osc/') && !ev.address.startsWith('/ws/')
        && !ev.address.startsWith('/cursor/') && !ev.address.startsWith('/trigger/')) return;
      this.send(ev);
    });
  }

  private open(): void {
    if (!this.url) return;
    this.setStatus('connecting');
    try {
      this.socket = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket.onopen = () => this.setStatus('open');
    this.socket.onclose = () => { this.setStatus('off'); this.scheduleRetry(); };
    this.socket.onerror = () => { /* close handler follows */ };
    this.socket.onmessage = (m) => {
      try {
        const data = JSON.parse(String(m.data));
        if (typeof data.address === 'string') {
          bus.send('ws:in', data.address, ...(Array.isArray(data.args) ? data.args : []));
        }
      } catch { /* non-JSON frame: ignore */ }
    };
  }

  private scheduleRetry(): void {
    if (!this.url || this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, 2000);
  }

  private setStatus(s: WsLink['status']): void {
    this.status = s;
    this.onStatus?.(s);
  }

  send(ev: TGEvent): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ address: ev.address, args: ev.args }));
    }
  }

  disconnect(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.socket?.close();
    this.socket = null;
    this.url = '';
    this.setStatus('off');
  }
}

export const wsLink = new WsLink();
