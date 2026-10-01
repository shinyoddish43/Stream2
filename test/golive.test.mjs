// Going live without being asked for the stream key, and setting the stream's
// title and category first. The studio signed in with Twitch gets the stream
// key from Twitch (and keeps it saved); fake-twitch.mjs stands in for Twitch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startServer, login } from './helpers.mjs';
import { fakeTwitch, CLIENT_ID } from './fake-twitch.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function studio(twitch, env = {}) {
  const server = await startServer({ ...twitch.env, ...env });
  const call = await login(server.url);
  const json = async (path, { method = 'GET', body } = {}) => {
    const res = await call(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { server, call, json };
}

async function eventually(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${fn}`);
    await wait(50);
  }
}

async function signIn(twitch, json) {
  await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID } });
  twitch.pending = false;
  await json('/api/twitch/signin', { method: 'POST' });
  return eventually(async () => { const b = (await json('/api/settings')).body; return b.twitch.account && !b.twitch.pending && b; });
}

/** Start a stream the way the page does, and say what ffmpeg was pointed at. */
async function goLive(server, call) {
  rmSync(join(server.data, 'args.txt'), { force: true });
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/stream`, { headers: { Origin: server.url, Cookie: call.cookie } });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'start', fps: 30, bitrate: 4500 }));
  await eventually(() => messages.length);
  ws.send(JSON.stringify({ type: 'stop' }));
  await wait(300);
  ws.close();
  const target = existsSync(join(server.data, 'args.txt')) ? readFileSync(join(server.data, 'args.txt'), 'utf8').trim().split('\n').pop() : null;
  return { first: messages[0], target };
}
const savedKey = (server) => JSON.parse(readFileSync(join(server.data, 'settings.json'), 'utf8')).streamKey;

test('signing in with Twitch brings the stream key: saved, never shown to the page, kept across restarts', async () => {
  const twitch = await fakeTwitch();
  let { server, json } = await studio(twitch);
  const data = server.data;
  try {
    assert.equal((await json('/api/settings')).body.hasKey, false);
    const s = await signIn(twitch, json);
    assert.equal(s.hasKey, true, 'no key to paste');
    assert.deepEqual([s.twitch.canKey, s.twitch.canTitle, s.twitch.keyAccount], [true, true, '123456']);
    assert.equal(savedKey(server), 'live_123456_fromtwitchKEY0123');
    assert.ok(!JSON.stringify((await json('/api/state')).body).includes('fromtwitchKEY'), 'the key never goes to the page');

    // A new version of the studio (or a restart) keeps it.
    server.stop();
    ({ server, json } = await studio(twitch, { DATA_DIR: data }));
    assert.equal((await json('/api/settings')).body.hasKey, true);
    assert.equal(savedKey({ data }), 'live_123456_fromtwitchKEY0123');
  } finally {
    server.stop();
    twitch.close();
  }
});

test('going live takes the key from Twitch when none is saved, follows a key reset, and never swaps in another account’s', async () => {
  const twitch = await fakeTwitch();
  const { server, call, json } = await studio(twitch);
  try {
    await signIn(twitch, json);
    await json('/api/settings', { method: 'PUT', body: { clearKey: true } });
    assert.equal((await json('/api/settings')).body.hasKey, false);
    let live = await goLive(server, call);
    assert.equal(live.first.type, 'ready', 'no key saved, none asked for');
    assert.match(live.target, /\/app\/live_123456_fromtwitchKEY0123$/);
    assert.equal(savedKey(server), 'live_123456_fromtwitchKEY0123', 'and kept');

    // Reset on Twitch: the next stream uses the new key, which is kept too.
    twitch.streamKey = 'live_123456_resetONtwitch99';
    live = await goLive(server, call);
    assert.match(live.target, /live_123456_resetONtwitch99$/);
    assert.equal(savedKey(server), 'live_123456_resetONtwitch99');

    // Twitch unreachable: the saved key still works.
    twitch.close();
    live = await goLive(server, call);
    assert.equal(live.first.type, 'ready');
    assert.match(live.target, /live_123456_resetONtwitch99$/);

    // A pasted key for another account is the owner's choice: it stays.
    await json('/api/settings', { method: 'PUT', body: { streamKey: 'live_999999_someoneelseskey' } });
    live = await goLive(server, call);
    assert.match(live.target, /live_999999_someoneelseskey$/);
  } finally {
    server.stop();
    twitch.close();
  }
});

test('without a key or a Twitch sign-in, going live says what to do', async () => {
  const twitch = await fakeTwitch();
  const { server, call } = await studio(twitch);
  try {
    const live = await goLive(server, call);
    assert.equal(live.first.type, 'error');
    assert.match(live.first.message, /stream key.*sign in with Twitch/i);
    assert.equal(live.target, null, 'ffmpeg never started');
  } finally {
    server.stop();
    twitch.close();
  }
});

test('“Use this account’s stream key”: the signed-in account’s key replaces another one', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    await json('/api/settings', { method: 'PUT', body: { streamKey: 'live_999999_someoneelseskey' } });
    const s = await signIn(twitch, json);
    assert.equal(s.twitch.keyAccount, '999999', 'another account’s key is not replaced by signing in');
    const swapped = await json('/api/twitch/streamkey', { method: 'POST' });
    assert.equal(swapped.body.twitch.keyAccount, '123456');
    assert.equal(savedKey(server), 'live_123456_fromtwitchKEY0123');
  } finally {
    server.stop();
    twitch.close();
  }
});

test('title and category: what Twitch has, its categories as you type, and the change made on the account you stream to', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    assert.equal((await json('/api/twitch/channel')).status, 409, 'not signed in');
    await signIn(twitch, json);
    let info = (await json('/api/twitch/channel')).body;
    assert.deepEqual(info, { title: 'Any% practice', category: { id: '1', name: 'Super Metroid' }, recent: [{ id: '1', name: 'Super Metroid' }] },
      'the category the stream has counts as recently used, however it was set');

    const found = (await json('/api/twitch/categories?q=metroid')).body.items;
    assert.equal(found[0].name, 'Metroid', 'the exact name first');
    assert.deepEqual(found.map((c) => c.name).sort(), ['Metroid', 'Metroid Dread', 'Metroid Prime', 'Super Metroid']);
    assert.deepEqual((await json('/api/twitch/categories?q=%20')).body, { items: [] });

    let saved = await json('/api/twitch/channel', { method: 'PUT', body: { title: '  100% run, first try  ', categoryId: '2' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(twitch.patches.at(-1), { broadcaster: '123456', title: '100% run, first try', game_id: '2' });
    assert.deepEqual(saved.body.recent.map((c) => c.name), ['Metroid Prime', 'Super Metroid']);
    for (const id of ['3', '509658', '5']) await json('/api/twitch/channel', { method: 'PUT', body: { categoryId: id } });
    info = (await json('/api/twitch/channel')).body;
    assert.deepEqual(info.recent.map((c) => c.name), ['Metroid Dread', 'Just Chatting', 'Super Mario 64'], 'the three most recent, newest first');
    assert.deepEqual(twitch.patches.at(-1), { broadcaster: '123456', game_id: '5' }, 'a category alone leaves the title');

    for (const bad of [{}, { title: '   ' }, { categoryId: 'abc' }, { title: 'x'.repeat(141) }]) {
      assert.equal((await json('/api/twitch/channel', { method: 'PUT', body: bad })).status, 400, JSON.stringify(bad));
    }

    // The stream key is another account's: this account's channel is not touched.
    await json('/api/settings', { method: 'PUT', body: { streamKey: 'live_999999_someoneelseskey' } });
    const other = await json('/api/twitch/channel', { method: 'PUT', body: { title: 'nope' } });
    assert.equal(other.status, 409);
    assert.match(other.body.error, /another Twitch account/);
  } finally {
    server.stop();
    twitch.close();
  }
});

test('a sign-in from before the studio asked to set the title says to sign in again', async () => {
  const twitch = await fakeTwitch();
  twitch.scopes = ['user:write:chat'];
  const { server, json } = await studio(twitch);
  try {
    const s = await signIn(twitch, json);
    assert.deepEqual([s.twitch.canWrite, s.twitch.canTitle, s.twitch.canKey, s.hasKey], [true, false, false, false]);
    const res = await json('/api/twitch/channel');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Sign in with Twitch again/);
  } finally {
    server.stop();
    twitch.close();
  }
});
