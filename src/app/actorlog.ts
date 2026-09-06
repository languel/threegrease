// The viewport log: what the characters are doing, in their own words.
//
// An installation sim spends most of its time running unattended, and the
// hardest question to answer while watching one is not "where is everyone"
// — you can see that — but "why". A character standing still might be
// waiting, might have arrived, might be wedged in a corner. The pose is the
// same in all three cases.
//
// So the log is written in the FIRST PERSON, and it is not decoration: a
// line is emitted where a decision is actually made, which means the log
// cannot drift from behaviour the way a hand-maintained commentary would.
// If a character says "I'm going to climb the stairs" it is because
// something set that goal.
export interface LogLine {
  /** which actor said it, for colour-coding */
  actorId: number;
  who: string;
  text: string;
  t: number;
}

const MAX_LINES = 8;
const FADE_MS = 14000;

export class ActorLog {
  private lines: LogLine[] = [];
  private host: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  /** suppress an identical line repeated back-to-back by the same actor */
  private lastKey = '';

  enabled = true;

  say(actorId: number, who: string, text: string): void {
    const key = `${actorId}:${text}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lines.push({ actorId, who, text, t: performance.now() });
    if (this.lines.length > MAX_LINES) this.lines.shift();
    this.render();
  }

  clear(): void {
    this.lines = [];
    this.lastKey = '';
    this.render();
  }

  /** Called from the frame loop so old lines fade without a timer. */
  tick(): void {
    if (!this.lines.length) return;
    const now = performance.now();
    const before = this.lines.length;
    this.lines = this.lines.filter((l) => now - l.t < FADE_MS);
    if (this.lines.length !== before) this.render();
    else this.fade(now);
  }

  private ensure(): HTMLElement | null {
    if (this.box?.isConnected) return this.box;
    this.host = document.querySelector('#viewport');
    if (!this.host) return null;
    const box = document.createElement('div');
    box.id = 'actor-log';
    box.className = 'actor-log';
    this.host.append(box);
    this.box = box;
    return box;
  }

  private render(): void {
    const box = this.ensure();
    if (!box) return;
    box.replaceChildren();
    box.hidden = !this.enabled || this.lines.length === 0;
    for (const l of this.lines) {
      const row = document.createElement('div');
      row.className = 'actor-log-line';
      const who = document.createElement('span');
      who.className = 'actor-log-who';
      // two actors, two hues — enough to tell who is speaking at a glance
      who.style.color = l.actorId % 2 === 0 ? '#8fd2ff' : '#ffc98f';
      who.textContent = l.who;
      const what = document.createElement('span');
      what.textContent = l.text;
      row.append(who, what);
      box.append(row);
    }
    this.fade(performance.now());
  }

  private fade(now: number): void {
    if (!this.box) return;
    const rows = this.box.children;
    for (let i = 0; i < rows.length && i < this.lines.length; i++) {
      const age = (now - this.lines[i].t) / FADE_MS;
      (rows[i] as HTMLElement).style.opacity = String(Math.max(0.25, 1 - age * 0.9));
    }
  }
}

export const actorLog = new ActorLog();
