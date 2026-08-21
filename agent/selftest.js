// End-to-end check of the agent bridge. Drives mcp-server.js and
// acp-server.js over stdio exactly as Claude Code / Zed would, against a
// live threegrease tab connected to the relay.
//
//   node relay.js &                 # then enable the Agent link in the app
//   node selftest.js
//
// Exits non-zero on the first failed expectation so it can gate a commit.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const relay = process.argv.includes('--relay')
  ? process.argv[process.argv.indexOf('--relay') + 1] : 'ws://localhost:8787';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

/** Send a scripted list of requests to a stdio server, collect the replies. */
function drive(script, requests) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [join(here, script), '--relay', relay], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) { if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* stderr noise */ } } }
    });
    proc.on('error', reject);
    proc.on('close', () => resolve(out));
    for (const r of requests) proc.stdin.write(`${JSON.stringify(r)}\n`);
    // give the relay round-trips time, then close stdin so the server exits
    setTimeout(() => proc.stdin.end(), 4000);
    setTimeout(() => proc.kill(), 12000);
  });
}

console.log(`\nthreegrease agent selftest (relay ${relay})\n`);

// ---- MCP ------------------------------------------------------------------
console.log('MCP (mcp-server.js)');
const mcp = await drive('mcp-server.js', [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scene.summary', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stroke.create', arguments: { points: [[0, 0, 0], [1, 0, 0.5], [2, 0, 0]], lineWidth: 10 } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no.such.tool', arguments: {} } },
]);
const byId = (id) => mcp.find((m) => m.id === id);

const init = byId(1)?.result;
check('initialize returns protocolVersion', init?.protocolVersion === '2024-11-05', init?.protocolVersion);
check('initialize advertises tools capability', !!init?.capabilities?.tools);
check('serverInfo names threegrease', init?.serverInfo?.name === 'threegrease');

const tools = byId(2)?.result?.tools;
check('tools/list returns tools', Array.isArray(tools) && tools.length > 0, `${tools?.length ?? 0} tools`);
check('every tool has an inputSchema', !!tools?.every((t) => t.name && t.description && t.inputSchema));
check('stroke.create is exposed', !!tools?.some((t) => t.name === 'stroke.create'));

const summary = byId(3)?.result;
check('scene.summary succeeds', summary?.isError === false);
let parsed = null;
try { parsed = JSON.parse(summary?.content?.[0]?.text ?? '{}'); } catch { /* reported below */ }
check('scene.summary returns real scene data', Array.isArray(parsed?.gpObjects), `gpObjects=${parsed?.gpObjects?.length}`);

const drew = byId(4)?.result;
let drewData = null;
try { drewData = JSON.parse(drew?.content?.[0]?.text ?? '{}'); } catch { /* reported below */ }
check('stroke.create draws through MCP', drew?.isError === false && drewData?.points === 3, JSON.stringify(drewData));

const bad = byId(5)?.result;
check('unknown tool reports isError, does not crash', bad?.isError === true,
  (bad?.content?.[0]?.text ?? '').slice(0, 60));

// ---- ACP ------------------------------------------------------------------
console.log('\nACP (acp-server.js)');
const acp = await drive('acp-server.js', [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
  { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } },
  { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'tg-0', prompt: [{ type: 'text', text: 'what is in the scene?' }] } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'scene.summary', arguments: {} } },
]);
const aById = (id) => acp.find((m) => m.id === id);

check('ACP initialize returns protocolVersion', aById(1)?.result?.protocolVersion === 1);
check('ACP advertises image prompts', aById(1)?.result?.agentCapabilities?.promptCapabilities?.image === true);
check('session/new returns a sessionId', typeof aById(2)?.result?.sessionId === 'string', aById(2)?.result?.sessionId);
check('session/prompt completes', aById(3)?.result?.stopReason === 'end_turn');
const update = acp.find((m) => m.method === 'session/update');
check('session/prompt streams a session/update', !!update);
check('update carries live scene text',
  String(update?.params?.update?.content?.text ?? '').includes('threegrease is connected'));
check('ACP tools/call reaches the app', aById(4)?.result?.ok === true);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
