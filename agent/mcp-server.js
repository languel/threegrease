// MCP server for threegrease: stdio JSON-RPC in, WebSocket relay out.
//
//   node mcp-server.js [--relay ws://localhost:8787]
//
// Register with Claude Code:
//   claude mcp add threegrease -- node /abs/path/to/agent/mcp-server.js
// or in claude_desktop_config.json / .mcp.json:
//   { "mcpServers": { "threegrease": { "command": "node", "args": ["/abs/path/agent/mcp-server.js"] } } }
//
// Implements MCP 2024-11-05 over stdio directly rather than pulling in the
// SDK — the surface we need is initialize + tools/list + tools/call, and a
// dependency-free server is one less thing to keep in sync for a bridge whose
// only job is forwarding.
//
// Tool definitions and results are NOT duplicated here: they are fetched live
// from the running app, so a tool added in src/agent/tools.ts is immediately
// visible to MCP clients with no change on this side.
import WebSocket from 'ws';
import { createInterface } from 'node:readline';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const RELAY = arg('relay', 'ws://localhost:8787');
const PROTOCOL_VERSION = '2024-11-05';

// ---- relay link -----------------------------------------------------------

let socket = null;
let connecting = null;
const waiting = new Map();
let seq = 0;

function connect() {
  if (socket && socket.readyState === 1) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const s = new WebSocket(RELAY);
    const fail = (err) => { connecting = null; reject(err); };
    s.on('open', () => { socket = s; connecting = null; resolve(s); });
    s.on('error', fail);
    s.on('close', () => {
      socket = null;
      for (const [, w] of waiting) w.reject(new Error('relay connection closed'));
      waiting.clear();
    });
    s.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message || 'relay error'));
      else w.resolve(msg.result);
    });
  });
  return connecting;
}

async function call(method, params = {}) {
  const s = await connect();
  const id = `m${seq++}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    s.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      reject(new Error(`${method} timed out — is the threegrease tab open with the Agent link enabled?`));
    }, 30000);
  });
}

// ---- stdio JSON-RPC -------------------------------------------------------

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, result }); };
const fail = (id, code, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } }); };

async function handle(msg) {
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'threegrease', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // notification

  if (method === 'tools/list') {
    try {
      const res = await call('tools/list');
      reply(id, {
        tools: (res?.tools ?? []).map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
        })),
      });
    } catch (err) {
      // Surface the disconnected app as an empty catalog plus a clear error
      // rather than killing the client's session at startup.
      fail(id, -32000, err.message);
    }
    return;
  }

  if (method === 'tools/call') {
    const name = params.name;
    try {
      const res = await call('tools/call', { name, arguments: params.arguments ?? {} });
      if (!res?.ok) {
        // MCP convention: tool-level failures come back as content with
        // isError, so the model can read and correct them.
        reply(id, { content: [{ type: 'text', text: String(res?.error ?? 'tool failed') }], isError: true });
        return;
      }
      reply(id, { content: [toContent(res.result)], isError: false });
    } catch (err) {
      reply(id, { content: [{ type: 'text', text: err.message }], isError: true });
    }
    return;
  }

  if (method === 'ping') { reply(id, {}); return; }
  fail(id, -32601, `Unknown method: ${method}`);
}

/** Screenshots come back as {mediaType, base64} — hand those to MCP as a
 *  real image block so vision-capable clients can actually see the viewport
 *  instead of a wall of base64 text. */
function toContent(result) {
  if (result && typeof result === 'object' && typeof result.base64 === 'string' && result.mediaType) {
    return { type: 'image', data: result.base64, mimeType: result.mediaType };
  }
  return { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
}

const rl = createInterface({ input: process.stdin });
// A stdio server must die with its client: when the editor/host closes the
// pipe there is nobody left to answer, and the open relay socket would
// otherwise keep the process alive forever.
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  handle(msg).catch((err) => fail(msg?.id, -32603, err.message));
});

process.stderr.write(`[threegrease-mcp] relay ${RELAY}\n`);
