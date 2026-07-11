// Typed pub/sub at the heart of the platform: cursors, triggers, MIDI/OSC/WS
// IO, and property routes all speak TGEvent. Keep emit allocation-light —
// it runs at message rate during performance.

export interface TGEvent {
  time: number;                  // performance.now() at emit
  source: string;                // 'cursor:12' | 'midi:in' | 'ws' | 'ui' ...
  address: string;               // '/cursor/12/pos', '/midi/cc/1/74', ...
  args: (number | string)[];
}

export type BusListener = (ev: TGEvent) => void;

/** '*' wildcard segments, '/foo/*' prefix matching. */
export function addressMatches(pattern: string, address: string): boolean {
  if (pattern === '*' || pattern === address) return true;
  const ps = pattern.split('/');
  const as = address.split('/');
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*') {
      if (i === ps.length - 1) return true; // trailing * matches rest
      continue;
    }
    if (ps[i] !== as[i]) return false;
  }
  return ps.length === as.length;
}

export class EventBus {
  private listeners: { pattern: string; cb: BusListener }[] = [];
  private ring: TGEvent[] = [];
  private ringMax = 500;
  /** monotonically increasing count, cheap change detection for UIs */
  count = 0;

  on(pattern: string, cb: BusListener): () => void {
    const entry = { pattern, cb };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(ev: TGEvent): void {
    this.count++;
    this.ring.push(ev);
    if (this.ring.length > this.ringMax) this.ring.shift();
    for (let i = 0; i < this.listeners.length; i++) {
      const l = this.listeners[i];
      if (addressMatches(l.pattern, ev.address)) {
        try { l.cb(ev); } catch (err) { console.error('bus listener:', err); }
      }
    }
  }

  send(source: string, address: string, ...args: (number | string)[]): void {
    this.emit({ time: performance.now(), source, address, args });
  }

  history(n = 50): TGEvent[] { return this.ring.slice(-n); }
}

/** The app-wide singleton bus. */
export const bus = new EventBus();
