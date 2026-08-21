// Relay: one WebSocket server that a threegrease browser tab connects OUT to,
// and that the MCP/ACP servers connect to as clients.
//
// The browser cannot listen on a socket, so it dials in and then ANSWERS
// JSON-RPC requests over that link. This process owns the socket and routes
// request ids between the two sides.
//
//   node relay.js [--port 8787]
//
// Roles are self-declared on connect: a peer that sends {method:'app/hello'}
// is the app; everyone else is treated as an agent client. Only one app is
// live at a time (the most recent wins), which matches the reality that the
// tools mutate one visible document.
import { WebSocketServer } from 'ws';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};

const PORT = Number(arg('port', 8787));
const wss = new WebSocketServer({ port: PORT });

/** The connected threegrease tab, if any. */
let app = null;
/** id -> the agent socket waiting on it. Ids are rewritten so two agents
 *  can have in-flight calls with colliding ids of their own. */
const pending = new Map();
let seq = 0;

const send = (sock, obj) => {
  if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
};

wss.on('connection', (sock) => {
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    // ---- the app announcing itself
    if (msg.method === 'app/hello') {
      app = sock;
      sock.__isApp = true;
      console.error('[relay] threegrease connected');
      return;
    }

    // ---- a reply coming back from the app
    if (sock.__isApp && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      send(waiter.sock, { jsonrpc: '2.0', id: waiter.originalId, result: msg.result, error: msg.error });
      return;
    }

    // ---- a request from an agent client
    if (!msg.method) return;
    if (!app || app.readyState !== 1) {
      send(sock, {
        jsonrpc: '2.0', id: msg.id ?? null,
        error: { code: -32000, message: 'No threegrease tab is connected. Open the app and enable the Agent link.' },
      });
      return;
    }
    const routed = `r${seq++}`;
    pending.set(routed, { sock, originalId: msg.id ?? null });
    send(app, { jsonrpc: '2.0', id: routed, method: msg.method, params: msg.params ?? {} });
    // don't leak a pending entry if the app never answers
    setTimeout(() => {
      if (!pending.has(routed)) return;
      pending.delete(routed);
      send(sock, {
        jsonrpc: '2.0', id: msg.id ?? null,
        error: { code: -32001, message: 'threegrease did not respond in time' },
      });
    }, 30000);
  });

  sock.on('close', () => {
    if (sock === app) { app = null; console.error('[relay] threegrease disconnected'); }
    for (const [id, w] of pending) if (w.sock === sock) pending.delete(id);
  });
});

console.error(`[relay] listening on ws://localhost:${PORT}`);
console.error('[relay] point the threegrease Agent panel at this URL, then start mcp-server.js or acp-server.js');
