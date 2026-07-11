#!/usr/bin/env node
// threegrease bridge: WebSocket <-> UDP OSC relay (browser can't do UDP).
//   npm install && node index.js [--ws 8765] [--osc-out 127.0.0.1:57120] [--osc-in 9000]
// Browser frames are JSON {address, args}; they leave as OSC to --osc-out.
// OSC arriving on --osc-in is forwarded to every connected browser.
import { WebSocketServer } from 'ws';
import osc from 'osc';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const WS_PORT = Number(arg('ws', 8765));
const [OUT_HOST, OUT_PORT] = arg('osc-out', '127.0.0.1:57120').split(':');
const IN_PORT = Number(arg('osc-in', 9000));

const wss = new WebSocketServer({ port: WS_PORT });
const udp = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: IN_PORT });
udp.open();

udp.on('message', (msg) => {
  const frame = JSON.stringify({ address: msg.address, args: msg.args.map((a) => a.value ?? a) });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(frame);
  }
});
udp.on('error', (e) => console.error('osc:', e.message));

wss.on('connection', (sock) => {
  console.log('browser connected');
  sock.on('message', (raw) => {
    try {
      const { address, args = [] } = JSON.parse(raw);
      udp.send({
        address,
        args: args.map((v) => (typeof v === 'number'
          ? { type: 'f', value: v } : { type: 's', value: String(v) })),
      }, OUT_HOST, Number(OUT_PORT));
    } catch { /* ignore malformed frames */ }
  });
});

console.log(`threegrease bridge: ws://localhost:${WS_PORT}`
  + `  ->  osc udp ${OUT_HOST}:${OUT_PORT}   <-  osc udp :${IN_PORT}`);
