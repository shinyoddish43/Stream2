// LiveSplit bridge tests.
//
// The bridge speaks two hand-written protocols — LiveSplit's TCP line format
// and a from-scratch WebSocket server in the Python version — so both get
// exercised against a fake LiveSplit here. Node's built-in WebSocket client
// plays the part of the studio.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVESPLIT_PORT = Number(process.env.FAKE_LIVESPLIT_PORT || 16934);
const BRIDGE_PORT = Number(process.env.BRIDGE_TEST_PORT || 16935);

let Socket = globalThis.WebSocket;
if (!Socket) {
  try { const mod = await import('ws'); Socket = mod.WebSocket || mod.default; } catch (e) {}
}
if (!Socket) { console.log('bridge: skipped (no WebSocket client)'); process.exit(0); }

const python = process.env.PYTHON || 'python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; process.stdout.write('.'); }
  else { failed++; process.stdout.write('x'); problems.push(`  FAIL ${name}${detail ? '\n    ' + detail : ''}`); }
};

// ---- a fake LiveSplit Server: answers the three commands the bridge polls,
// and records anything else it is told to do.
const received = [];
let skipNext = false;
const state = { phase: 'Running', time: '00:01:23.45', index: '2' };
const livesplit = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '').trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      received.push(line);
      if (skipNext && line.startsWith('get')) { skipNext = false; continue; }  // a reply that never comes
      if (line === 'getcurrenttimerphase') socket.write(state.phase + '\r\n');
      else if (line === 'getcurrenttime') socket.write(state.time + '\r\n');
      else if (line === 'getsplitindex') socket.write(state.index + '\r\n');
      // Control commands (startorsplit, reset, …) get no reply, like the real one.
    }
  });
});
await new Promise((resolve) => livesplit.listen(LIVESPLIT_PORT, '127.0.0.1', resolve));

/** Can the Node bridge run here? It needs the `ws` package; the Python one
 *  needs nothing, which is why it is the one the docs lead with. */
let nodeBridgeOk = false;
try {
  // Resolve the way the bridge itself will: a CommonJS require, which also
  // honours NODE_PATH, unlike an ESM import.
  createRequire(join(ROOT, 'bridge', 'livesplit-bridge.js')).resolve('ws');
  nodeBridgeOk = true;
} catch (e) { /* the Node bridge simply does not run here */ }

const implementations = [
  ['python', python, [join(ROOT, 'bridge', 'livesplit_bridge.py'),
    '--port', '%PORT%', '--livesplit-port', String(LIVESPLIT_PORT), '--interval', '0.05']],
];
if (nodeBridgeOk) {
  implementations.push(['node', 'node', [join(ROOT, 'bridge', 'livesplit-bridge.js')]]);
}

for (const [label, command, args] of implementations) {
  const port = BRIDGE_PORT + implementations.indexOf(implementations.find((i) => i[0] === label));
  await runBridge(label, command, args.map((a) => a.replace('%PORT%', String(port))), port);
}

async function runBridge(label, command, args, port) {
  received.length = 0;
  state.phase = 'Running';
  state.time = '00:01:23.45';
  state.index = '2';
  const bridge = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BRIDGE_PORT: String(port), LIVESPLIT_PORT: String(LIVESPLIT_PORT), POLL_MS: '50' },
  });
  let log = '';
  bridge.stdout.on('data', (d) => { log += d; });
  bridge.stderr.on('data', (d) => { log += d; });
  await sleep(1200);

  const messages = [];
  let socketOpen = false;
  const ws = new Socket(`ws://127.0.0.1:${port}/`);
  ws.addEventListener('open', () => { socketOpen = true; });
  ws.addEventListener('message', (event) => {
  try { messages.push(JSON.parse(String(event.data))); } catch (e) {}
  });
  await sleep(1500);

  check(`${label}: the handshake completes`, socketOpen, log.slice(0, 300));
  check(`${label}: state is pushed without being asked`, messages.length > 3, `got ${messages.length} messages`);

  const last = messages[messages.length - 1] || {};
  check(`${label}: the phase comes through`, last.phase === 'running', JSON.stringify(last));
  check(`${label}: the clock is parsed into seconds`, Math.abs((last.time || 0) - 83.45) < 0.01, JSON.stringify(last));
  check(`${label}: the split index comes through`, last.currentSplit === 2, JSON.stringify(last));
  check(`${label}: the bridge polls LiveSplit`, received.includes('getcurrenttime'));

  // A phase change on the LiveSplit side reaches the studio.
  state.phase = 'Ended';
  state.time = '00:02:00';
  await sleep(700);
  const afterEnd = messages[messages.length - 1] || {};
  check(`${label}: a phase change propagates`, afterEnd.phase === 'ended', JSON.stringify(afterEnd));
  check(`${label}: a clock change propagates`, Math.abs((afterEnd.time || 0) - 120) < 0.01, JSON.stringify(afterEnd));

  // Commands travel the other way, mapped to LiveSplit's vocabulary.
  const before = received.length;
  ws.send(JSON.stringify({ cmd: 'split' }));
  await sleep(300);
  ws.send(JSON.stringify({ cmd: 'reset' }));
  await sleep(400);
  const commands = received.slice(before);
  check(`${label}: split maps to startorsplit`, commands.includes('startorsplit'), JSON.stringify(commands.slice(-6)));
  check(`${label}: reset maps to reset`, commands.includes('reset'), JSON.stringify(commands.slice(-6)));

  // Junk must not take the bridge down.
  ws.send('not json at all');
  ws.send(JSON.stringify({ cmd: 'rm -rf /' }));
  await sleep(400);
  check(`${label}: junk input is ignored`, bridge.exitCode === null);
  const stillLive = messages.length;
  await sleep(400);
  check(`${label}: the bridge keeps streaming after junk`, messages.length > stillLive);

  // Regression: replies are matched to requests by position, so one dropped
  // reply used to shift every later answer onto the wrong field — LiveSplit's
  // clock arriving where the phase belonged.
  skipNext = true;
  await sleep(2600);   // past the bridge's stuck-queue reset
  const afterGap = messages[messages.length - 1] || {};
  check(`${label}: a dropped reply does not shift later answers`,
    afterGap.phase === 'ended' && Math.abs((afterGap.time || 0) - 120) < 0.01, JSON.stringify(afterGap));
  check(`${label}: the split index survives a dropped reply`, afterGap.currentSplit === 2, JSON.stringify(afterGap));

  // A large frame exercises the 16-bit length path of the hand-written decoder.
  ws.send(JSON.stringify({ cmd: 'pause', padding: 'x'.repeat(400) }));
  await sleep(400);
  check(`${label}: an extended-length frame is decoded`, received.includes('pause'), JSON.stringify(received.slice(-4)));

  ws.close();
  await sleep(300);
  check(`${label}: the bridge survives a client leaving`, bridge.exitCode === null);

  bridge.kill();
  await sleep(200);
  if (failed && process.env.BRIDGE_TEST_DEBUG) console.log(`--- ${label} bridge log ---\n` + log);
}

livesplit.close();
await sleep(200);
process.stdout.write('\n');
for (const problem of problems) console.log(problem);
console.log(`bridge: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
