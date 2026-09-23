// Relay tests: ticket verification, the ffmpeg pipe, and the failure paths.
//
// ffmpeg is replaced by a stub that copies stdin to a file, so this runs
// anywhere and still proves the bytes the studio sends reach the encoder's
// stdin in order. Skips itself when `ws` is not installed.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RELAY_TEST_PORT || 8979);
const SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex');

// Node 22 ships a WebSocket client; older Node can borrow the relay's own
// `ws` dependency. Either way the test needs nothing installed for itself.
let Socket = globalThis.WebSocket;
if (!Socket) {
  try {
    const mod = await import(process.env.WS_PATH || 'ws');
    Socket = mod.WebSocket || mod.default;
  } catch (e) { /* handled below */ }
}
if (!Socket) {
  console.log('relay: skipped (no WebSocket client: Node 22+, or npm install ws)');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'studio-relay-'));
let passed = 0;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; process.stdout.write('.'); }
  else { failed++; process.stdout.write('x'); problems.push(`  FAIL ${name}${detail ? '\n    ' + detail : ''}`); }
};

// A stand-in for ffmpeg: writes whatever arrives on stdin to a file named
// after the RTMP target, so the test can prove the pipe carried the bytes.
const stub = join(work, 'fake-ffmpeg.sh');
writeFileSync(stub, `#!/usr/bin/env bash
target="\${@: -1}"
name=$(printf '%s' "$target" | tr -c 'a-zA-Z0-9' '_')
cat > "${work}/out-\${name}.bin"
`);
chmodSync(stub, 0o755);

const relay = spawn('node', [join(ROOT, 'relay', 'server.js')], {
  env: {
    ...process.env,
    RELAY_SECRET: SECRET,
    PORT: String(PORT),
    FFMPEG_PATH: stub,
    MAX_SESSIONS: '2',
    NODE_PATH: process.env.NODE_PATH || join(tmpdir(), '..', 'node_modules'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayLog = '';
relay.stdout.on('data', (d) => { relayLog += d; });
relay.stderr.on('data', (d) => { relayLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ticket(payload, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

const validTargets = [{ name: 'Twitch', url: 'rtmp://127.0.0.1/app/key1' }];
const freshTicket = (over = {}) => ticket({
  iss: 'stream-studio', user: 'tester',
  exp: Math.floor(Date.now() / 1000) + 120,
  targets: validTargets,
  ...over,
});

/** Open a socket, send a start message, collect replies for a moment. */
function open(onOpen) {
  return new Promise((resolve) => {
    const messages = [];
    const ws = new Socket(`ws://127.0.0.1:${PORT}/ingest`);
    ws.addEventListener('message', (event) => {
      try { messages.push(JSON.parse(String(event.data))); } catch (e) { /* not for us */ }
    });
    ws.addEventListener('open', async () => {
      await onOpen(ws);
      resolve({ messages, ws });
    });
    ws.addEventListener('error', (event) => resolve({ messages, ws: null, error: event.message || 'socket error' }));
  });
}

function session(startMessage, { chunks = [], settle = 600 } = {}) {
  return open(async (ws) => {
    ws.send(JSON.stringify(startMessage));
    for (const chunk of chunks) { await sleep(40); ws.send(chunk); }
    await sleep(settle);
  });
}

// Wait for the relay's HTTP side to answer.
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (res.ok) { up = true; break; }
  } catch (e) { await sleep(150); }
}
check('the relay starts and answers /health', up, relayLog.slice(0, 300));

if (up) {
  const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  check('health reports capacity', health.max === 2, JSON.stringify(health));

  // --- a good session
  const webmMagic = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const payloadChunk = Buffer.concat([webmMagic, crypto.randomBytes(4096)]);
  const good = await session(
    { type: 'start', ticket: freshTicket(), mimeType: 'video/webm;codecs=vp8,opus',
      video: { width: 1280, height: 720, fps: 30, bitrate: 2500, keyframe: 2 }, audio: { bitrate: 128 } },
    { chunks: [payloadChunk, crypto.randomBytes(2048)] }
  );
  check('a valid ticket is accepted', good.messages.some((m) => m.type === 'ready'), JSON.stringify(good.messages));
  check('the accepted session names its target',
    good.messages.some((m) => m.type === 'ready' && (m.targets || []).includes('Twitch')),
    JSON.stringify(good.messages));
  good.ws?.send(JSON.stringify({ type: 'stop' }));
  await sleep(500);

  const outFile = join(work, 'out-rtmp___127_0_0_1_app_key1.bin');
  const wrote = existsSync(outFile) ? readFileSync(outFile) : Buffer.alloc(0);
  check('the encoder received the stream', wrote.length >= 6144, `${wrote.length} bytes`);
  check('bytes arrive unmangled and in order', wrote.subarray(0, 4).equals(webmMagic), wrote.subarray(0, 8).toString('hex'));

  // --- rejections
  const unsigned = await session({ type: 'start', ticket: 'not-a-ticket' });
  check('an unsigned ticket is rejected',
    unsigned.messages.some((m) => m.type === 'error' && /ticket rejected/.test(m.message)),
    JSON.stringify(unsigned.messages));

  const wrongKey = await session({ type: 'start', ticket: ticket({ exp: Math.floor(Date.now() / 1000) + 60, targets: validTargets }, 'the-wrong-secret') });
  check('a ticket signed with the wrong secret is rejected',
    wrongKey.messages.some((m) => m.type === 'error'), JSON.stringify(wrongKey.messages));

  const expired = await session({ type: 'start', ticket: freshTicket({ exp: Math.floor(Date.now() / 1000) - 5 }) });
  check('an expired ticket is rejected',
    expired.messages.some((m) => m.type === 'error'), JSON.stringify(expired.messages));

  const badUrl = await session({ type: 'start', ticket: freshTicket({ targets: [{ name: 'evil', url: 'file:///etc/passwd' }] }) });
  check('a non-rtmp target is rejected',
    badUrl.messages.some((m) => m.type === 'error' && /destination/.test(m.message)),
    JSON.stringify(badUrl.messages));

  const injection = await session({ type: 'start', ticket: freshTicket({ targets: [{ name: 'evil', url: 'rtmp://host/app/key; touch ' + join(work, 'pwned') }] }) });
  check('a shell-injection target is rejected',
    injection.messages.some((m) => m.type === 'error'), JSON.stringify(injection.messages));
  check('nothing was executed from the target string', !existsSync(join(work, 'pwned')));

  // --- binary before authorisation is ignored, not piped anywhere
  const early = await open(async (ws) => {
    ws.send(crypto.randomBytes(1024));         // no start message first
    await sleep(400);
    ws.close();
  });
  check('unauthorised binary is dropped without an ffmpeg',
    !early.messages.some((m) => m.type === 'ready'), JSON.stringify(early.messages));

  // --- capacity
  const held = [];
  for (let i = 0; i < 2; i++) {
    const s = await session({ type: 'start', ticket: freshTicket({ targets: [{ name: 'T' + i, url: `rtmp://127.0.0.1/app/hold${i}` }] }) }, { settle: 200 });
    held.push(s);
  }
  const overflow = await session({ type: 'start', ticket: freshTicket() }, { settle: 300 });
  check('the relay refuses work past its session cap',
    overflow.messages.some((m) => m.type === 'error' && /capacity/.test(m.message)),
    JSON.stringify(overflow.messages));
  for (const s of held) s.ws?.close();
  await sleep(400);

  const after = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  check('sessions are released when the socket closes', after.sessions === 0, JSON.stringify(after));
}

relay.kill();
await sleep(200);
if (failed && process.env.RELAY_TEST_DEBUG) console.log('\n--- relay log ---\n' + relayLog);
rmSync(work, { recursive: true, force: true });
process.stdout.write('\n');
for (const problem of problems) console.log(problem);
console.log(`relay: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
