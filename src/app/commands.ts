// Command registry (N1): one searchable surface over everything the app can
// do. The palette (F3) and the programmatic agent API both resolve here —
// `window.__tg.execute('title or id')` is the official automation entry.

export interface Command {
  id: string;
  title: string;
  /** extra match terms */
  keywords?: string;
  /** shortcut hint shown in the palette */
  key?: string;
  run: (args?: string) => unknown;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  /** called before each palette open / execute to add scene-dependent commands */
  dynamicSources: (() => Command[])[] = [];

  register(cmd: Command): void { this.commands.set(cmd.id, cmd); }

  all(): Command[] {
    const dyn = this.dynamicSources.flatMap((s) => {
      try { return s(); } catch { return []; }
    });
    return [...this.commands.values(), ...dyn];
  }

  /** substring + word-initials fuzzy score; higher = better, 0 = no match */
  static score(query: string, cmd: Command): number {
    const q = query.trim().toLowerCase();
    if (!q) return 1;
    const hay = `${cmd.title} ${cmd.id} ${cmd.keywords ?? ''}`.toLowerCase();
    if (hay.includes(q)) return 100 - hay.indexOf(q) * 0.1;
    const initials = cmd.title.toLowerCase().split(/[\s/-]+/).map((w) => w[0] ?? '').join('');
    if (initials.includes(q)) return 50;
    // all query words present somewhere
    const words = q.split(/\s+/);
    if (words.every((w) => hay.includes(w))) return 25;
    return 0;
  }

  search(query: string, limit = 12): Command[] {
    return this.all()
      .map((c) => ({ c, s: CommandRegistry.score(query, c) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.c);
  }

  /**
   * Agent API: run by exact id, exact title, or best fuzzy match.
   * Returns { ok, id, result | error }.
   */
  execute(query: string, args?: string): { ok: boolean; id?: string; result?: unknown; error?: string } {
    const all = this.all();
    const exact = all.find((c) => c.id === query)
      ?? all.find((c) => c.title.toLowerCase() === query.trim().toLowerCase());
    const cmd = exact ?? this.search(query, 1)[0];
    if (!cmd) return { ok: false, error: `no command matches '${query}'` };
    try {
      return { ok: true, id: cmd.id, result: cmd.run(args) };
    } catch (err) {
      return { ok: false, id: cmd.id, error: String(err) };
    }
  }
}
