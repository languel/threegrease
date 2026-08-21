# Agent interface

*threegrease is branded **3𝜻** in the app UI; both names refer to the same project.*

Drive a threegrease scene from a language model — either the built-in chat
panel, or an external agent (Claude Code, Claude Desktop, Zed) over MCP/ACP.

## Why it is shaped this way

threegrease runs in a browser. MCP and ACP are stdio protocols spoken by
*processes*. A browser tab cannot listen on a socket, so:

```
BROWSER (the app)                           NODE (agent/)
┌──────────────────────────────┐            ┌────────────────────────┐
│ src/agent/tools.ts           │            │ relay.js               │
│   the ONE tool registry      │◄──── ws ──►│   routes JSON-RPC      │
│ src/agent/providers.ts       │            │      ▲            ▲    │
│ src/agent/session.ts         │            │      │ stdio      │    │
│ src/agent/rpc.ts  (dials out)│            │ mcp-server  acp-server │
│ src/agent/panel.ts (chat UI) │            └────────────────────────┘
└──────────────────────────────┘                 ▲            ▲
                                            Claude Code      Zed
```

The tool registry needs `AppCtx` (the live scene, renderer and undo stack),
so it lives in the browser and the app **dials out** to the relay. The Node
servers are pure translators: they fetch tool definitions live from the
running app, so **a tool added in `src/agent/tools.ts` is immediately visible
to Claude Code and Zed with no change on the Node side.**

## Quick start — in-app chat

1. Run a local model server, e.g. `ollama serve` (or LM Studio, oMLX, Unsloth).
2. Open the **Agent** tab (sparkles icon) in the properties sidebar.
3. Pick a provider — local ones are listed first and need no key.
4. Click the refresh icon beside **Model** to list installed models.
5. Ask for something: *"Draw a five-pointed star lying flat on the ground."*

Pick a **tool-capable** model. Small models often ignore the tool API; the
session detects that and falls back to a fenced-JSON tag protocol, but native
tool calling is far more reliable. Known-good locally: `llama3.1+`,
`qwen2.5-coder`, `qwen3`, `mistral-nemo`.

## Quick start — external agents (MCP)

Every client runs the **same bridge**; only the registration syntax differs.
Start the relay once and connect the tab, then register with whichever client
you use.

```bash
cd agent && npm install
node relay.js                    # leave running
```

In the app: **Agent tab → Agent link → Connect** (default `ws://localhost:8787`).

Then register `agent/mcp-server.js`. Run these from the repo root so `$PWD`
resolves — every client needs an **absolute** path.

**Claude Code and Codex** take the same `--` form:

```bash
claude mcp add threegrease -- node "$PWD/agent/mcp-server.js"
codex  mcp add threegrease -- node "$PWD/agent/mcp-server.js"
```

**Hermes** names the command and its arguments explicitly:

```bash
hermes mcp add threegrease --command node --args "$PWD/agent/mcp-server.js"
```

**opencode** prompts for the details:

```bash
opencode mcp add threegrease
```

…or add it to `~/.config/opencode/opencode.json` directly. Note the shape
differs from everyone else's: the key is `mcp` (not `mcpServers`), entries
need `"type": "local"`, and `command` is an **array**, not a string:

```json
{ "mcp": {
    "threegrease": {
      "type": "local",
      "command": ["node", "/abs/path/agent/mcp-server.js"],
      "enabled": true } } }
```

**Config-file clients** — Claude Desktop, Cursor, and most others — share one
JSON shape, in `claude_desktop_config.json`, `~/.cursor/mcp.json`, or a
project `.mcp.json`:

```json
{ "mcpServers": {
    "threegrease": { "command": "node", "args": ["/abs/path/agent/mcp-server.js"] } } }
```

Verify the connection with `claude mcp list`, `codex mcp list`,
`hermes mcp list`, or `opencode mcp list` — the tools only appear while a
threegrease tab is connected to the relay, since the bridge fetches them live.

## Quick start — editors (ACP)

Same relay, different bridge — point the editor at `agent/acp-server.js`:

```bash
node /abs/path/agent/acp-server.js
```

Zed reaches it through its agent-server setting. opencode and Hermes are
themselves ACP agents (`opencode acp`, `hermes acp`), so for those, prefer the
MCP route above — that gives them threegrease's tools, rather than putting two
agents on the same wire.

`acp-server.js` deliberately embeds **no LLM**: it exposes the same tool
surface for the editor's own model to drive, so there is one tool registry and
one set of credentials rather than a second provider stack in the bridge.

## Using it — worked examples

The agent works by calling tools, so **give it a goal, not coordinates**. It
computes the geometry itself. Everything below is a prompt you can paste into
the Agent panel, or say to Claude Code once the MCP bridge is registered.

### Ask before you act

```
What is in the scene right now?
```

Calls `scene.summary` and reports objects, layers, materials and ids. Worth
doing first in a busy scene — the model needs real ids, and this is how it
gets them.

### Draw something parametric

```
Draw a five-pointed star centred at the origin, lying flat on the ground,
about 2 units across. One closed stroke.
```

```
Draw a spiral staircase: 24 steps rising 3 units over two full turns,
each step a short horizontal stroke.
```

Parametric shapes are where this is genuinely faster than drawing by hand.
Say how many points you want if smoothness matters — "a smooth circle from 48
points" beats "a circle".

### Work in three dimensions

The world is **Z-up**: the ground plane is XY, Z is height. Be explicit, or
you will get a flat drawing:

```
Draw three vertical strokes standing up from the ground at x = -1, 0 and 1,
each 2 units tall.
```

### Restyle what is already there

```
List the materials, then set material 1 to a red-to-yellow linear gradient
and make every stroke on the active layer use it.
```

```
Set the brush to Pencil Soft and turn on draw-speed variation.
```

### Compose with objects

```
Add a box at the origin and a sun light above it, then frame everything
from the front.
```

### Reach anything else

Anything without a dedicated tool is still reachable through the command
palette:

```
Use app.commands to find the export commands, then export a PNG.
```

### Iterate visually (vision models only)

Turn on **Send viewport screenshot**, then:

```
Look at the viewport and tell me whether the star is centred. If it is off,
move it.
```

Without that setting the `view.screenshot` tool is withheld, because a
text-only model that calls it chokes on the result.

### Prompts that work less well

- *"Make it look nicer"* — no measurable target; it will guess.
- *"Draw a cat"* — freehand representational drawing from coordinates is
  something current models are bad at. Parametric and structural work is
  where they earn their keep.
- Very small local models often ignore the tool API entirely. The session
  falls back to a tag protocol, but a tool-capable model is far better.

## Providers

| | Provider | Protocol | Default URL | Key |
|---|---|---|---|---|
| local | Ollama | ollama | `http://localhost:11434` | — |
| local | LM Studio | openai | `http://localhost:1234` | — |
| local | oMLX (Apple Silicon) | openai | `http://localhost:8000` | optional |
| local | Unsloth | openai | `http://localhost:8001` | optional |
| local | OpenAI-compatible (vLLM, llama.cpp, LiteLLM…) | openai | custom | optional |
| hosted | Claude (Anthropic) | anthropic | `https://api.anthropic.com` | required |
| hosted | OpenAI | openai | `https://api.openai.com` | required |
| hosted | Google Gemini | google | `https://generativelanguage.googleapis.com` | required |
| hosted | OpenRouter | openai | `https://openrouter.ai/api` | required |

Four wire protocols cover all of them; adding a provider is usually one entry
in the `PROVIDERS` registry in `providers.ts`, not new transport code.

> **Credentials.** Keys entered in the panel are stored in this browser's
> localStorage only. That is a development convenience, not a secret store —
> anything with access to the page can read them. Prefer local providers, or a
> proxy that injects credentials server-side.

## Tools

Run `tools/list`, or ask the model, for the live set. Currently 20:

- **Query** — `scene.summary`, `scene.strokes`, `scene.materials`, `view.screenshot`
- **Draw** — `stroke.create`, `stroke.delete`, `stroke.transform`
- **Objects** — `object.create`, `object.transform`, `object.delete`, `object.select`
- **Style** — `material.update`, `brush.set`, `layer.create`, `layer.update`
- **App** — `app.command`, `app.commands`, `app.set_mode`, `view.set`, `scene.set_frame`

`app.command` reaches the whole command palette by fuzzy match, so anything
without a dedicated tool is still callable.

### Conventions

- GP stroke points are in the GP object's **object space**; scene objects use
  **world space**. Each schema says which.
- The world is **Z-up** by default: the ground plane is XY, Z is height.
- Tools marked `mutates` get `pushUndo()` before and `requestRender()` after
  from the dispatcher, so every agent edit is undoable and no handler can skip
  the undo stack. Note this is **per tool call, not per prompt**: a model that
  draws a 24-step staircase issues 24 `stroke.create` calls, and unwinding it
  takes 24 undos. Save before a large request.
- Tool errors are **returned, not thrown** — a failed call is information the
  model corrects from, not a crashed turn.

## Adding a tool

Append to `AGENT_TOOLS` in `src/agent/tools.ts`:

```ts
{
  name: 'thing.do',
  description: 'What it does, and when to reach for it.',
  inputSchema: obj({ amount: num('How much.') }, ['amount']),
  mutates: true,
  handler: ({ ctx }, args) => { /* mutate ctx.scene */ return { ok: 1 }; },
}
```

That is the whole change: the in-app chat, MCP, and ACP all pick it up.
Write the description for a model that cannot see the UI — say what it is for,
not just what it is.

## Testing

```bash
node agent/relay.js &            # with the app connected
node agent/selftest.js
```

Drives both servers over stdio exactly as Claude Code and Zed do, and checks
the handshake, tool enumeration, a real `stroke.create` into the live scene,
and that an unknown tool reports `isError` rather than crashing the session.

## Gotchas

- **Image results never go into a tool message as text.** A screenshot is
  ~500KB of base64; stringifying it dominates the context window and broke
  Ollama's chat template outright. The session converts image results into a
  short text ack plus a real image part in a following user message — the only
  shape every provider accepts, since tool messages are text-only on OpenAI
  and Gemini.
- **`view.screenshot` is withheld unless "Send viewport screenshot" is on.**
  Text-only models otherwise call it and choke on the result.
- **Both stdio servers exit when stdin closes.** Without that they outlive
  their client, because the open relay socket keeps the event loop alive.
- **Only one app tab is live at a time** in the relay (most recent wins),
  matching the reality that the tools mutate one visible document.
