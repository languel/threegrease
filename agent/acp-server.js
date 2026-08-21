// ACP (Agent Client Protocol) server for threegrease.
//
//   node acp-server.js [--relay ws://localhost:8787]
//
// ACP is the editor<->agent protocol used by Zed: newline-delimited JSON-RPC
// over stdio, where the EDITOR is the client and this process is the agent.
// The shape is close enough to MCP that both share the relay, but the roles
// differ — MCP exposes tools TO a model, while ACP exposes an agent that runs
// its own turns and reports progress back to the editor.
//
// This implementation deliberately does not embed an LLM. It exposes the
// threegrease tool surface as an agent that the editor's own model drives, by
// advertising the tools through `session/new` and executing whatever the
// client asks for. That keeps one tool registry and one set of credentials
// (the app's) rather than a second provider stack out here.
import WebSocket from 'ws';
import { createInterface } from 'node:readline';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const RELAY = arg('relay', 'ws://localhost:8787');
const PROTOCOL_VERSION = 1;

let socket = null;
let connecting = null;
const waiting = new Map();
let seq = 0;

function connect() {
  if (socket && socket.readyState === 1) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const s = new WebSocket(RELAY);
    s.on('open', () => { socket = s; connecting = null; resolve(s); });
    s.on('error', (err) => { connecting = null; reject(err); });
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
  const id = `a${seq++}`;
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

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, result }); };
const fail = (id, code, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } }); };
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

const sessions = new Map();
let sessionSeq = 0;

async function handle(msg) {
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true } },
      authMethods: [],
    });
    return;
  }

  if (method === 'authenticate') { reply(id, {}); return; }

  if (method === 'session/new') {
    const sessionId = `tg-${sessionSeq++}`;
    sessions.set(sessionId, { cwd: params.cwd ?? null });
    reply(id, { sessionId });
    return;
  }

  // The editor asks the agent to act. threegrease's agent surface is its
  // tools, so a prompt is answered by listing what is available and letting
  // the editor's model drive tools/call — rather than embedding a second LLM
  // and a second set of credentials out here.
  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    if (!sessions.has(sessionId)) { fail(id, -32602, `Unknown session ${sessionId}`); return; }
    try {
      const list = await call('tools/list');
      const summary = await call('tools/call', { name: 'scene.summary', arguments: {} });
      const names = (list?.tools ?? []).map((t) => t.name).join(', ');
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: [
              'threegrease is connected.',
              `Tools: ${names}`,
              '',
              'Current scene:',
              '```json',
              JSON.stringify(summary?.result ?? summary, null, 2),
              '```',
            ].join('\n'),
          },
        },
      });
      reply(id, { stopReason: 'end_turn' });
    } catch (err) {
      notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `threegrease error: ${err.message}` } },
      });
      reply(id, { stopReason: 'end_turn' });
    }
    return;
  }

  if (method === 'session/cancel') { reply(id, {}); return; }

  // Direct tool access, for editors that surface agent tools to their model.
  if (method === 'tools/list') {
    try { reply(id, await call('tools/list')); }
    catch (err) { fail(id, -32000, err.message); }
    return;
  }
  if (method === 'tools/call') {
    try { reply(id, await call('tools/call', { name: params.name, arguments: params.arguments ?? {} })); }
    catch (err) { fail(id, -32000, err.message); }
    return;
  }

  fail(id, -32601, `Unknown method: ${method}`);
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

process.stderr.write(`[threegrease-acp] relay ${RELAY}\n`);
