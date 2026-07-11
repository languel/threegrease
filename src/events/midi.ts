// Web MIDI in/out wired to the bus. Feature-detected; degrades to no-op.
// Incoming:  /midi/note/<ch>/<key> [vel]   (noteoff => vel 0)
//            /midi/cc/<ch>/<num> [val]
// Outgoing:  bus events with source != 'midi:in' whose address starts with
//            /midi/... are sent to the selected output.
import { bus, type TGEvent } from './bus';

type MIDIAccessT = /* WebMidi.MIDIAccess */ any;

export class MidiIO {
  access: MIDIAccessT | null = null;
  available = false;
  inputs: { id: string; name: string }[] = [];
  outputs: { id: string; name: string }[] = [];
  inputId: string | null = null;   // null = all inputs
  outputId: string | null = null;
  private unsub: (() => void) | null = null;

  async init(): Promise<boolean> {
    const nav = navigator as unknown as { requestMIDIAccess?: () => Promise<MIDIAccessT> };
    if (!nav.requestMIDIAccess) return false;
    try {
      this.access = await nav.requestMIDIAccess();
    } catch {
      return false;
    }
    this.available = true;
    this.refreshPorts();
    this.access.onstatechange = () => this.refreshPorts();
    this.bindInputs();
    // outgoing: forward /midi/* bus traffic not originated by midi input
    this.unsub = bus.on('/midi/*', (ev) => {
      if (ev.source !== 'midi:in') this.sendFromEvent(ev);
    });
    return true;
  }

  dispose(): void { this.unsub?.(); }

  refreshPorts(): void {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()].map((p: any) => ({ id: p.id, name: p.name ?? p.id }));
    this.outputs = [...this.access.outputs.values()].map((p: any) => ({ id: p.id, name: p.name ?? p.id }));
    this.bindInputs();
  }

  private bindInputs(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (this.inputId === null || input.id === this.inputId)
        ? (msg: any) => this.onMessage(msg)
        : null;
    }
  }

  setInput(id: string | null): void { this.inputId = id; this.bindInputs(); }
  setOutput(id: string | null): void { this.outputId = id; }

  private onMessage(msg: { data: Uint8Array }): void {
    const [status, d1, d2] = msg.data;
    const type = status & 0xf0;
    const ch = (status & 0x0f) + 1;
    if (type === 0x90 || type === 0x80) {
      const vel = type === 0x80 ? 0 : d2;
      bus.send('midi:in', `/midi/note/${ch}/${d1}`, vel);
    } else if (type === 0xb0) {
      bus.send('midi:in', `/midi/cc/${ch}/${d1}`, d2);
    } else if (type === 0xe0) {
      bus.send('midi:in', `/midi/bend/${ch}`, ((d2 << 7) | d1) - 8192);
    }
  }

  /** /midi/note/<ch>/<key> [vel] and /midi/cc/<ch>/<num> [val] -> port. */
  private sendFromEvent(ev: TGEvent): void {
    if (!this.access) return;
    const out = this.outputId
      ? this.access.outputs.get(this.outputId)
      : [...this.access.outputs.values()][0];
    if (!out) return;
    const parts = ev.address.split('/'); // '', 'midi', kind, ch, num
    const kind = parts[2];
    const ch = Math.max(1, Math.min(16, Number(parts[3]) || 1)) - 1;
    const num = Math.max(0, Math.min(127, Number(parts[4]) || 0));
    const val = Math.max(0, Math.min(127, Math.round(Number(ev.args[0]) || 0)));
    if (kind === 'note') out.send([val > 0 ? 0x90 | ch : 0x80 | ch, num, val]);
    else if (kind === 'cc') out.send([0xb0 | ch, num, val]);
  }
}

export const midi = new MidiIO();
