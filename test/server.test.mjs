// The server: login, storage, uploads, and the relay to ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { startServer, login, USER, PASSWORD, ROOT } from './helpers.mjs';

let server;
let api;
before(async () => { server = await startServer(); api = await login(server.url); });
after(() => server.stop());

const post = (path, body, headers = {}) => fetch(`${server.url}${path}`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: server.url, ...headers }, body: JSON.stringify(body),
});
const GLOBAL_INGEST = 'rtmp://ingest.global-contribute.live-video.net/app';

test('everything but the login page needs a session', async () => {
  const page = await fetch(`${server.url}/`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal((await fetch(`${server.url}/api/state`)).status, 401);
  assert.equal((await fetch(`${server.url}/app.js`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${server.url}/login`)).status, 200);
  assert.equal((await fetch(`${server.url}/app.css`)).status, 200);
});

test('the server refuses to start without a login', () => {
  const empty = mkdtempSync(join(tmpdir(), 'studio-empty-'));
  const result = spawnSync('node', [join(ROOT, 'server.js')], { env: { ...process.env, DATA_DIR: empty, PORT: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /node server\.js passwd/);
});

test('the password is stored hashed', () => {
  const auth = readFileSync(join(server.data, 'auth.json'), 'utf8');
  assert.ok(!auth.includes(PASSWORD));
  assert.match(auth, /"hash": "[0-9a-f]{128}"/);
});

test('a wrong password is refused, and repeated failures lock out', async () => {
  const bad = { user: USER, password: 'wrong' };
  const res = await post('/api/login', bad, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(res.status, 401);
  for (let i = 0; i < 5; i++) await post('/api/login', bad, { 'X-Forwarded-For': '203.0.113.9' });
  const locked = await post('/api/login', { user: USER, password: PASSWORD }, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(locked.status, 429, 'even the right password waits out a lockout');
  // Another address is unaffected.
  const other = await post('/api/login', { user: USER, password: PASSWORD }, { 'X-Forwarded-For': '198.51.100.4' });
  assert.equal(other.status, 200);
});

test('a login from another site is refused', async () => {
  const res = await post('/api/login', { user: USER, password: PASSWORD }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('the session cookie is HttpOnly and SameSite=Strict', async () => {
  const res = await post('/api/login', { user: USER, password: PASSWORD });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('changes need a same-site Origin', async () => {
  const res = await fetch(`${server.url}/api/layouts`, {
    method: 'PUT', headers: { Cookie: api.cookie, 'Content-Type': 'application/json' }, body: '{"layouts":[]}',
  });
  assert.equal(res.status, 403);
});

test('a new studio uses global Twitch ingest and layout revision zero', async () => {
  const state = await (await api('/api/state')).json();
  assert.equal(state.settings.ingest, GLOBAL_INGEST);
  assert.equal(state.layouts, null);
  assert.equal(state.layoutsRevision, 0);
  assert.equal(state.splitsRevision, 0);
});

test('layouts and splits are saved and read back', async () => {
  const doc = { layouts: [{ id: 'a', name: 'Main', sources: [] }], active: 'a' };
  const saved = await api('/api/layouts', { method: 'PUT', body: JSON.stringify(doc) });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, revision: 1 });
  const run = { game: 'Celeste', segments: [{ name: 'Forsaken City', pb: 130, best: 125 }] };
  assert.equal((await api('/api/splits', { method: 'PUT', body: JSON.stringify(run) })).status, 200);
  const state = await (await api('/api/state')).json();
  assert.equal(state.layouts.layouts[0].name, 'Main');
  assert.equal(state.layouts.revision, 1);
  assert.equal(state.layoutsRevision, 1);
  assert.equal(state.splits.game, 'Celeste');
  assert.equal(state.splits.revision, 1);
  assert.equal(state.splitsRevision, 1);
  assert.equal((await api('/api/layouts', { method: 'PUT', body: '{"nope":1}' })).status, 400);
});

test('concurrent split edits and invalid revisions cannot replace newer records', async () => {
  const original = (await (await api('/api/state')).json()).splits;
  const responses = await Promise.all(['Device A', 'Device B'].map((game) => api('/api/splits', {
    method: 'PUT', body: JSON.stringify({ ...original, game }),
  })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const saved = (await (await api('/api/state')).json()).splits;
  const conflict = await responses.find((r) => r.status === 409).json();
  assert.deepEqual(conflict.splits, saved);
  assert.equal(saved.revision, original.revision + 1);
  assert.equal(conflict.revision, saved.revision);
  for (const revision of [-1, 1.5, '1', null]) {
    const response = await api('/api/splits', { method: 'PUT', body: JSON.stringify({ ...saved, revision }) });
    assert.equal(response.status, 400);
  }
  const { revision, ...unversioned } = saved;
  assert.equal((await api('/api/splits', { method: 'PUT', body: JSON.stringify(unversioned) })).status, 409);
  assert.deepEqual(JSON.parse(readFileSync(join(server.data, 'splits.json'), 'utf8')), saved);
});

test('concurrent browsers cannot replace a newer saved layout', async () => {
  const secondBrowser = await login(server.url);
  const original = (await (await api('/api/state')).json()).layouts;
  const saveFrom = (call, name) => call('/api/layouts', {
    method: 'PUT', body: JSON.stringify({ ...original, layouts: [{ ...original.layouts[0], name }] }),
  });
  const responses = await Promise.all([saveFrom(api, 'First browser'), saveFrom(secondBrowser, 'Second browser')]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const saved = (await (await secondBrowser('/api/state')).json()).layouts;
  assert.equal(saved.revision, original.revision + 1);
  const conflict = await responses.find((r) => r.status === 409).json();
  assert.deepEqual(conflict.layouts, saved);
  assert.equal(conflict.revision, saved.revision);
  assert.deepEqual(JSON.parse(readFileSync(join(server.data, 'layouts.json'), 'utf8')), saved);
  assert.equal(readdirSync(server.data).some((name) => name.endsWith('.tmp')), false);
  // A stale client with no version must also be rejected once a revision exists.
  const { revision, ...unversioned } = original;
  assert.equal((await api('/api/layouts', { method: 'PUT', body: JSON.stringify(unversioned) })).status, 409);
  const updated = await secondBrowser('/api/layouts', {
    method: 'PUT', body: JSON.stringify({ ...saved, active: saved.layouts[0].id }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).revision, saved.revision + 1);
});

test('invalid layout revisions cannot bypass conflict checks', async () => {
  for (const revision of [-1, 1.5, '1', null]) {
    const res = await api('/api/layouts', { method: 'PUT', body: JSON.stringify({ layouts: [], revision }) });
    assert.equal(res.status, 400, `accepted revision ${JSON.stringify(revision)}`);
  }
});

test('legacy layouts migrate and acknowledged saves survive an abrupt restart', async () => {
  const first = await startServer();
  let restarted;
  try {
    const legacy = { layouts: [{ id: 'legacy', name: 'Old layout', sources: [] }], active: 'legacy' };
    writeFileSync(join(first.data, 'layouts.json'), JSON.stringify(legacy));
    const call = await login(first.url);
    const loaded = (await (await call('/api/state')).json()).layouts;
    assert.equal(loaded.revision, 0);
    loaded.layouts[0].name = 'Saved before closing';
    const response = await call('/api/layouts', { method: 'PUT', body: JSON.stringify(loaded) });
    assert.equal(response.status, 200);
    loaded.revision = (await response.json()).revision;
    const exited = once(first.proc, 'exit');
    first.proc.kill('SIGKILL');
    await exited;
    restarted = await startServer({ DATA_DIR: first.data }, { password: false });
    const reopened = await login(restarted.url);
    const state = await (await reopened('/api/state')).json();
    assert.deepEqual(state.layouts, loaded);
    assert.equal(statSync(join(first.data, 'layouts.json')).mode & 0o077, 0);
  } finally {
    first.stop();
    restarted?.stop();
  }
});

test('the stream key is stored but never sent back', async () => {
  let res = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ streamKey: 'live_123456_abcdefSECRET', ingest: 'rtmp://live.twitch.tv/app' }) });
  assert.equal(res.status, 200);
  const state = await (await api('/api/state')).text();
  assert.ok(!state.includes('SECRET'));
  assert.match(state, /"hasKey":true/);
  assert.equal(JSON.parse(state).settings.ingest, GLOBAL_INGEST);
  assert.equal(statSync(join(server.data, 'settings.json')).mode & 0o077, 0, 'settings.json is readable by others');
  res = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ streamKey: 'bad key; rm -rf /' }) });
  assert.equal(res.status, 400);
  res = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ingest: 'file:///etc/passwd' }) });
  assert.equal(res.status, 400);
});

test('saved legacy Twitch ingest migrates without changing custom servers or keys', async () => {
  const other = await startServer();
  try {
    const call = await login(other.url);
    const settingsFile = join(other.data, 'settings.json');
    const saved = { ingest: 'rtmp://live.twitch.tv/app/', streamKey: 'live_legacy_PRIVATE', testMode: true };
    writeFileSync(settingsFile, JSON.stringify(saved), { mode: 0o600 });
    let state = await (await call('/api/state')).json();
    assert.equal(state.settings.ingest, GLOBAL_INGEST);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { ...saved, ingest: GLOBAL_INGEST });
    const custom = { ...saved, ingest: 'rtmps://custom.example:443/my-app/' };
    writeFileSync(settingsFile, JSON.stringify(custom));
    state = await (await call('/api/state')).json();
    assert.equal(state.settings.ingest, custom.ingest);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), custom);
  } finally { other.stop(); }
});

test('backgrounds upload, are served with ranges, and need a session', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const res = await api('/api/media', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } });
  assert.equal(res.status, 200);
  const { url } = await res.json();
  assert.match(url, /^\/media\/[a-f0-9]{24}\.png$/);
  const back = await api(url);
  assert.equal(Buffer.from(await back.arrayBuffer()).compare(png), 0);
  const part = await api(url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(`${server.url}${url}`, { redirect: 'manual' })).status, 303);
  const refused = await api('/api/media', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/html' } });
  assert.equal(refused.status, 415);
});

test('files outside public/ cannot be fetched', async () => {
  for (const path of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/media/../auth.json']) {
    const res = await api(path);
    assert.notEqual(res.status, 200, path);
  }
  assert.equal((await api('/%E0%A4%A')).status, 400, 'a malformed path is a bad request, not a crash');
});

// ---- the relay

function openStream(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/stream`, { headers });
    const messages = [];
    ws.on('message', (d) => messages.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, messages, open: true }));
    ws.on('error', () => resolve({ ws, messages, open: false }));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the stream socket refuses strangers and other sites', async () => {
  assert.equal((await openStream({ Origin: server.url })).open, false);
  assert.equal((await openStream({ Origin: 'https://evil.example', Cookie: api.cookie })).open, false);
});

test('streaming pipes the browser’s bytes into ffmpeg, pointed at Twitch', async () => {
  const s = await openStream({ Origin: server.url, Cookie: api.cookie });
  assert.ok(s.open);
  s.ws.send(JSON.stringify({ type: 'start', fps: 60, bitrate: 6000, mimeType: 'video/webm;codecs=vp8,opus' }));
  await wait(300);
  assert.equal(s.messages[0].type, 'ready');
  const chunk = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(5000, 7)]);
  s.ws.send(chunk);
  s.ws.send(chunk);

  // A second window cannot start a second broadcast.
  const second = await openStream({ Origin: server.url, Cookie: api.cookie });
  second.ws.send(JSON.stringify({ type: 'start', fps: 30, bitrate: 3000 }));
  await wait(300);
  assert.match(second.messages[0].message, /Already streaming/);

  s.ws.send(JSON.stringify({ type: 'stop' }));
  await wait(500);
  const args = readFileSync(join(server.data, 'args.txt'), 'utf8').split('\n');
  assert.ok(args.includes(`${GLOBAL_INGEST}/live_123456_abcdefSECRET`), 'wrong target');
  assert.ok(args.includes('libx264'));
  assert.equal(args[args.indexOf('-g') + 1], '120', 'keyframe every two seconds at 60 fps');
  assert.equal(args[args.indexOf('-b:v') + 1], '6000k');
  const received = readFileSync(join(server.data, 'stdin.bin'));
  assert.equal(received.length, chunk.length * 2);
  assert.ok(received.subarray(0, 4).equals(chunk.subarray(0, 4)));
});

test('bandwidth-test mode is passed to Twitch', async () => {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ testMode: true }) });
  const s = await openStream({ Origin: server.url, Cookie: api.cookie });
  s.ws.send(JSON.stringify({ type: 'start', fps: 30, bitrate: 3000 }));
  await wait(300);
  assert.equal(s.messages[0].testMode, true);
  s.ws.close();
  await wait(400);
  assert.match(readFileSync(join(server.data, 'args.txt'), 'utf8'), /\?bandwidthtest=true/);
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ testMode: false }) });
});

test('streaming without a key explains itself, and the key never reaches a message', async () => {
  const other = await startServer();
  const call = await login(other.url);
  const s = await new Promise((resolve) => {
    const ws = new WebSocket(`${other.url.replace('http', 'ws')}/api/stream`, { headers: { Origin: other.url, Cookie: call.cookie } });
    const messages = [];
    ws.on('message', (d) => messages.push(JSON.parse(d)));
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'start' })); setTimeout(() => resolve(messages), 400); });
  });
  assert.match(s[0].message, /stream key/i);
  other.stop();
});

test('an ffmpeg that dies reports why, with the key masked', async () => {
  const failing = await startServer({ FFMPEG: '/bin/false' });
  const call = await login(failing.url);
  await call('/api/settings', { method: 'PUT', body: JSON.stringify({ streamKey: 'live_999_TOPSECRETKEY' }) });
  const messages = await new Promise((resolve) => {
    const ws = new WebSocket(`${failing.url.replace('http', 'ws')}/api/stream`, { headers: { Origin: failing.url, Cookie: call.cookie } });
    const out = [];
    ws.on('message', (d) => out.push(JSON.parse(d)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start' })));
    ws.on('close', () => resolve(out));
  });
  const error = messages.find((m) => m.type === 'error');
  assert.ok(error, JSON.stringify(messages));
  assert.match(error.message, /connection to Twitch ended/);
  assert.ok(!JSON.stringify(messages).includes('TOPSECRETKEY'));
  failing.stop();
  assert.ok(existsSync(failing.data));
});

test('a malformed cookie cannot crash the server', async () => {
  // Regression: cookie values went through decodeURIComponent, which throws on
  // bad escapes — and the WebSocket upgrade handler would have died with it.
  const bad = 'ss=%E0%A4%A';
  await new Promise((resolve) => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/stream`, { headers: { Origin: server.url, Cookie: bad } });
    ws.on('error', resolve);
    ws.on('close', resolve);
  });
  const page = await fetch(`${server.url}/api/state`, { headers: { Cookie: bad } });
  assert.equal(page.status, 401);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200, 'the server is still up');
});
