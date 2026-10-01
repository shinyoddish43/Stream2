// Twitch chat. In the page: reading Twitch's IRC lines, and a connection that
// joins, answers PINGs, follows moderators and comes back when dropped (the
// server here stands in for Twitch's chat server, speaking the same lines).
// On the server: the Twitch app, signing in with Twitch, sending as the account
// the stream key streams to, and Twitch's emote and badge lists (fake-twitch.mjs
// stands in for Twitch's sign-in and API servers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseIrc, messageParts, channelName, nameColor, chatMessage, TwitchChat } from '../public/chat.js';
import { startServer, login } from './helpers.mjs';
import { fakeTwitch, CLIENT_ID, CDN } from './fake-twitch.mjs';

test('IRC lines: tags (with their escapes), prefix, command and parameters', () => {
  const m = parseIrc('@badge-info=;badges=moderator/1,subscriber/12;color=#1E90FF;display-name=Some\\sOne;emotes=;id=abc-1;system-msg=a\\:b\\\\c\\n;flag :someone!someone@someone.tmi.twitch.tv PRIVMSG #chan :hi: there :)');
  assert.equal(m.tags['display-name'], 'Some One');
  assert.equal(m.tags['system-msg'], 'a;b\\c\n');
  assert.equal(m.tags.flag, '');
  assert.equal(m.tags['badge-info'], '');
  assert.equal(m.nick, 'someone');
  assert.equal(m.command, 'PRIVMSG');
  assert.deepEqual(m.params, ['#chan', 'hi: there :)']);

  assert.deepEqual(parseIrc('PING :tmi.twitch.tv'), { tags: {}, prefix: '', nick: '', command: 'PING', params: ['tmi.twitch.tv'] });
  const clear = parseIrc('@room-id=1;target-user-id=2 :tmi.twitch.tv CLEARCHAT #chan :spammer');
  assert.deepEqual([clear.nick, clear.command, clear.params], ['tmi.twitch.tv', 'CLEARCHAT', ['#chan', 'spammer']]);
  assert.deepEqual(parseIrc(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!').params, ['justinfan1', 'Welcome, GLHF!']);
  assert.equal(parseIrc('').command, '');
});

test('emote positions count characters, not UTF-16 units', () => {
  // "👋 Kappa hi Kappa": the wave is one character but two UTF-16 units.
  assert.deepEqual(messageParts('👋 Kappa hi Kappa', '25:2-6,11-15'), [
    { text: '👋 ' }, { emote: '25', name: 'Kappa' }, { text: ' hi ' }, { emote: '25', name: 'Kappa' },
  ]);
  assert.deepEqual(messageParts('LUL', '425618:0-2'), [{ emote: '425618', name: 'LUL' }]);
  assert.deepEqual(messageParts('no emotes', ''), [{ text: 'no emotes' }]);
  assert.deepEqual(messageParts('a b c', 'emotesv2_ab12:0-0/x y:2-2/9:4-99/7:3-2'), [{ emote: 'emotesv2_ab12', name: 'a' }, { text: ' b c' }],
    'odd ids and ranges past the end are left as text');
  assert.deepEqual(messageParts('abcd', '1:0-2/2:1-3'), [{ emote: '1', name: 'abc' }, { text: 'd' }], 'overlaps keep the first');
});

test('a channel is found in whatever people paste', () => {
  for (const input of ['SomeStreamer', '#somestreamer', '@SomeStreamer', ' twitch.tv/SomeStreamer ', 'https://www.twitch.tv/somestreamer',
    'https://m.twitch.tv/somestreamer/videos', 'www.twitch.tv/somestreamer?ref=x']) {
    assert.equal(channelName(input), 'somestreamer', input);
  }
  for (const input of ['', 'two words', 'a'.repeat(26), 'name;JOIN #other', 'https://example.com/somestreamer', null]) {
    assert.equal(channelName(input), '', String(input));
  }
});

test('names are always readable on the dark panel, in the colour their owner picked', () => {
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const panel = lum('#1f2227');
  for (const color of ['#0000FF', '#000000', '#8A2BE2', '#FF0000', '#00FF7F', '', 'red', '#12345']) {
    const out = nameColor(color, 'someone');
    assert.match(out, /^#[0-9a-f]{6}$/);
    assert.ok((lum(out) + 0.05) / (panel + 0.05) >= 4.5, `${color} became ${out}`);
  }
  assert.equal(nameColor('#00FF7F', 'x'), '#00ff7f', 'a colour that reads already is kept');
  assert.equal(nameColor('', 'someone'), nameColor(undefined, 'someone'), 'no colour: the same one for a name every time');
  const blue = nameColor('#0000ff');
  assert.ok(parseInt(blue.slice(5, 7), 16) > parseInt(blue.slice(1, 3), 16), `blue stays blue: ${blue}`);
});

test('a chat message: its name, /me, badges, first message and bits', () => {
  const m = chatMessage(parseIrc('@badges=broadcaster/1,subscriber/0,premium/1;bits=100;color=;display-name=홍길동;emotes=25:6-10;first-msg=1;id=m1;tmi-sent-ts=1700000000000 :hong!hong@hong.tmi.twitch.tv PRIVMSG #chan :\x01ACTION waves Kappa\x01'));
  assert.equal(m.name, '홍길동 (hong)');
  assert.equal(m.action, true);
  assert.equal(m.text, 'waves Kappa');
  assert.deepEqual(m.parts, [{ text: 'waves ' }, { emote: '25', name: 'Kappa' }]);
  assert.deepEqual(m.badges, ['broadcaster/1', 'subscriber/0', 'premium/1']);
  assert.deepEqual([m.first, m.bits, m.time, m.id, m.login], [true, 100, 1700000000000, 'm1', 'hong']);
  assert.equal(chatMessage(parseIrc(':plain!plain@x PRIVMSG #chan :hi')).name, 'plain');
  assert.equal(chatMessage(parseIrc('@display-name=Plain :plain!plain@x PRIVMSG #chan :hi')).name, 'Plain');
});

// A stand-in for Twitch's chat server. `script(line, socket)` answers each line.
async function fakeChatServer(script) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const heard = [];
  const sockets = [];
  wss.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => { const line = String(data); heard.push(line); script(line, socket); });
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, heard, sockets, close: () => { for (const s of wss.clients) s.terminate(); wss.close(); } };
}

// What Twitch says when a signed-out viewer joins a channel that exists.
function twitchLike(line, socket) {
  if (line.startsWith('NICK ')) socket.send(`:tmi.twitch.tv 001 ${line.slice(5)} :Welcome, GLHF!`);
  const join = /^JOIN (#\w+)$/.exec(line);
  if (join) socket.send(`:justinfan1!justinfan1@justinfan1.tmi.twitch.tv JOIN ${join[1]}\r\n@room-id=1;slow=0 :tmi.twitch.tv ROOMSTATE ${join[1]}`);
}

function listen(chat) {
  const events = [];
  chat.on = (e) => events.push(e);
  events.next = async (match, timeout = 3000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const i = events.findIndex(match);
      if (i >= 0) return events.splice(0, i + 1).pop();
      if (Date.now() > end) throw new Error(`no such event in ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return events;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (s) => (e) => e.type === 'state' && e.state === s;

test('joins as a signed-out viewer, answers PINGs, and shows what moderators do', async () => {
  const twitch = await fakeChatServer(twitchLike);
  const chat = new TwitchChat({ url: twitch.url, delay: () => 20 });
  const events = listen(chat);
  try {
    chat.join('#SomeChannel');
    await events.next(state('joined'));
    assert.deepEqual(twitch.heard.filter((l) => !l.startsWith('NICK')), ['CAP REQ :twitch.tv/tags twitch.tv/commands', 'PASS SCHMOOPIIE', 'JOIN #somechannel']);
    assert.match(twitch.heard.find((l) => l.startsWith('NICK')), /^NICK justinfan\d+$/, 'no account: a signed-out viewer');

    const [socket] = twitch.sockets;
    socket.send('PING :tmi.twitch.tv');
    await until(() => twitch.heard.includes('PONG :tmi.twitch.tv'));

    socket.send('@color=#1E90FF;display-name=Fan;emotes=;id=a1 :fan!fan@fan.tmi.twitch.tv PRIVMSG #somechannel :hello\r\n'
      + '@id=x9 :fan!fan@fan.tmi.twitch.tv PRIVMSG #otherchannel :not this one');
    const { message } = await events.next((e) => e.type === 'message');
    assert.deepEqual([message.name, message.text, message.id, message.color], ['Fan', 'hello', 'a1', '#1e90ff']);

    socket.send('@login=fan;target-msg-id=a1 :tmi.twitch.tv CLEARMSG #somechannel :hello');
    assert.deepEqual(await events.next((e) => e.type === 'delete'), { type: 'delete', id: 'a1' });
    socket.send('@ban-duration=600 :tmi.twitch.tv CLEARCHAT #somechannel :fan');
    assert.deepEqual(await events.next((e) => e.type === 'clear'), { type: 'clear', login: 'fan' });
    socket.send(':tmi.twitch.tv CLEARCHAT #somechannel');
    assert.deepEqual(await events.next((e) => e.type === 'clear'), { type: 'clear', login: null });
    socket.send('@login=raider;display-name=Raider;msg-id=raid;system-msg=5\\sraiders\\sfrom\\sRaider\\shave\\sjoined! :tmi.twitch.tv USERNOTICE #somechannel');
    assert.deepEqual(await events.next((e) => e.type === 'notice'), { type: 'notice', text: '5 raiders from Raider have joined!', message: null });
    socket.send('@login=sub;display-name=Sub;msg-id=resub;system-msg=Sub\\ssubscribed\\sfor\\s3\\smonths! :tmi.twitch.tv USERNOTICE #somechannel :still here');
    const resub = await events.next((e) => e.type === 'notice');
    assert.deepEqual([resub.text, resub.message.name, resub.message.text], ['Sub subscribed for 3 months!', 'Sub', 'still here']);
    assert.equal(events.filter((e) => e.type === 'message').length, 0, 'other channels are not shown');
  } finally {
    chat.close();
    twitch.close();
  }
});

test('comes back after a dropped connection or a RECONNECT, and stops when told', async () => {
  const twitch = await fakeChatServer(twitchLike);
  const chat = new TwitchChat({ url: twitch.url, delay: () => 50 });
  const events = listen(chat);
  try {
    chat.join('somechannel');
    await events.next(state('joined'));
    twitch.sockets[0].terminate();
    assert.equal((await events.next(state('waiting'))).seconds, 0);
    await events.next(state('joined'));
    assert.equal(twitch.sockets.length, 2);

    twitch.sockets[1].send(':tmi.twitch.tv RECONNECT');
    await events.next(state('joined'));
    assert.equal(twitch.sockets.length, 3, 'a new connection straight away');
    assert.equal(twitch.heard.filter((l) => l === 'JOIN #somechannel').length, 3);

    chat.join('another');
    await events.next(state('joined'));
    assert.equal(twitch.heard.at(-1), 'JOIN #another');

    chat.close();
    assert.ok(events.some(state('off')));
    await wait(200);
    assert.equal(twitch.sockets.filter((s) => s.readyState === 1).length, 0, 'closed');
    assert.equal(twitch.sockets.length, 4, 'and not reopened');
  } finally {
    chat.close();
    twitch.close();
  }
});

test('a channel Twitch does not have is reported, since Twitch itself stays silent', async () => {
  const twitch = await fakeChatServer((line, socket) => {
    if (line.startsWith('NICK ')) socket.send(`:tmi.twitch.tv 001 ${line.slice(5)} :Welcome, GLHF!`);
  });
  const chat = new TwitchChat({ url: twitch.url, delay: () => 50, joinWait: 150 });
  const events = listen(chat);
  try {
    chat.join('nosuchchannel');
    await events.next(state('missing'));
    assert.equal(twitch.sockets[0].readyState, 1, 'it stays connected, in case the name starts to exist');
  } finally {
    chat.close();
    twitch.close();
  }
});

test('a server that cannot be reached is tried again, waiting longer each time', async () => {
  const waits = [];
  const chat = new TwitchChat({ url: 'ws://127.0.0.1:9', delay: (n) => { waits.push(n); return 30; } });
  const events = listen(chat);
  try {
    chat.join('somechannel');
    await events.next(state('waiting'));
    await events.next(state('waiting'));
    await events.next(state('waiting'));
    assert.deepEqual(waits.slice(0, 3), [0, 1, 2]);
    assert.equal(new TwitchChat().delay(0), 1000);
    assert.equal(new TwitchChat().delay(10), 30000, 'never more than 30 s');
  } finally {
    chat.close();
  }
});

async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${fn}`);
    await wait(10);
  }
}

// ------------------------------------------------------------------ server

/** A studio with the Twitch app set up, talking to a stand-in Twitch. */
async function studio(twitch, env = {}) {
  const server = await startServer({ ...twitch.env, ...env });
  const call = await login(server.url);
  const json = async (path, { method = 'GET', body } = {}) => {
    const res = await call(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { server, call, json };
}

async function signIn(twitch, json) {
  twitch.pending = true;
  const started = await json('/api/twitch/signin', { method: 'POST' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  twitch.pending = false;               // the owner presses Authorize on twitch.tv/activate
  return eventually(async () => {
    const s = (await json('/api/settings')).body;
    return s.twitch.account && !s.twitch.pending && s;
  });
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

test('the Twitch app: its Client ID is kept, its secret never comes back, and odd ones are refused', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    let res = await json('/api/settings');
    assert.deepEqual([res.body.twitch.app, res.body.twitch.account, res.body.twitch.pending], [false, null, null]);
    assert.equal((await json('/api/twitch/signin', { method: 'POST' })).status, 409, 'no app yet: nothing to sign in with');
    for (const bad of [{ twitchClientId: 'not an id' }, { twitchClientId: CLIENT_ID, twitchClientSecret: 'x; rm -rf /' }]) {
      assert.equal((await json('/api/settings', { method: 'PUT', body: bad })).status, 400, JSON.stringify(bad));
    }
    res = await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID, twitchClientSecret: 'secretsecretsecret0123456789' } });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.settings.twitch.app, res.body.settings.twitch.clientId], [true, CLIENT_ID]);
    const state = await (await fetch(`${server.url}/api/state`, { headers: { Cookie: (await login(server.url)).cookie } })).text();
    assert.ok(!state.includes('secretsecret'), 'the secret is never sent back');
    await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID, twitchClientSecret: '' } });
    assert.match(readFileSync(join(server.data, 'settings.json'), 'utf8'), /secretsecretsecret0123456789/, 'the same app saved again keeps its secret');
    assert.equal(statSync(join(server.data, 'settings.json')).mode & 0o077, 0);

    // Only the signed-in owner, and only from the studio's own pages.
    for (const [method, path] of [['GET', '/api/settings'], ['GET', '/api/chat/assets'], ['POST', '/api/chat'], ['POST', '/api/twitch/signin'], ['DELETE', '/api/twitch/signin'], ['POST', '/api/twitch/signout']]) {
      assert.equal((await fetch(`${server.url}${path}`, { method, headers: { Origin: server.url } })).status, 401, `${method} ${path} without a session`);
    }
    const other = await fetch(`${server.url}/api/chat`, { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: (await login(server.url)).cookie, 'Content-Type': 'application/json' }, body: '{"message":"hi"}' });
    assert.equal(other.status, 403, 'another site cannot write in the chat');
  } finally {
    server.stop();
    twitch.close();
  }
});

test('signing in with Twitch: a code for twitch.tv/activate, then the account; tokens stay on the server', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID } });
    twitch.pending = true;
    const started = await json('/api/twitch/signin', { method: 'POST' });
    assert.deepEqual(started.body.twitch.pending && [started.body.twitch.pending.code, started.body.twitch.pending.url],
      ['ABCD-EFGH', 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH']);
    await wait(500);
    assert.ok((await json('/api/settings')).body.twitch.pending, 'still waiting for the owner');
    twitch.pending = false;
    const s = await eventually(async () => { const b = (await json('/api/settings')).body; return b.twitch.account && b; });
    assert.deepEqual(s.twitch.account, { id: '123456', login: 'oddish', name: 'Oddish' });
    assert.deepEqual([s.twitch.canWrite, s.twitch.pending, s.twitch.problem], [true, null, '']);
    const asked = twitch.calls.find((c) => c.path === '/oauth2/device');
    assert.equal(new URLSearchParams(asked.body).get('scopes'), 'user:write:chat', 'asks for nothing but writing in the chat');
    const everything = JSON.stringify((await json('/api/state')).body);
    assert.ok(!/access-|refresh-/.test(everything), 'no token ever reaches the page');
    assert.match(readFileSync(join(server.data, 'settings.json'), 'utf8'), /access-1/, 'kept on the server');

    // Twitch says yes but then cannot say who: said so, and the server carries on.
    twitch.validateFails = true;
    await json('/api/twitch/signin', { method: 'POST' });
    const unknown = await eventually(async () => { const b = (await json('/api/settings')).body; return !b.twitch.pending && b; });
    assert.match(unknown.twitch.problem, /did not say which account/);
    assert.equal(unknown.twitch.account.login, 'oddish', 'the account from before is kept');
    twitch.validateFails = false;

    // Declined on Twitch: said so.
    twitch.decline = true;
    await json('/api/twitch/signin', { method: 'POST' });
    const declined = await eventually(async () => { const b = (await json('/api/settings')).body; return !b.twitch.pending && b; });
    assert.match(declined.twitch.problem, /declined/);
    twitch.decline = false;
    // Cancelled in the studio: nothing more is asked of Twitch.
    twitch.pending = true;
    await json('/api/twitch/signin', { method: 'POST' });
    assert.equal((await json('/api/twitch/signin', { method: 'DELETE' })).body.twitch.pending, null);
  } finally {
    server.stop();
    twitch.close();
  }
});

test('the chat is only the stream key’s account: messages go out as it, and only to it', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID, streamKey: 'live_999999_someoneelseskey' } });
    let s = await signIn(twitch, json);
    assert.deepEqual([s.twitch.keyAccount, s.twitch.account.id], ['999999', '123456']);
    const refused = await json('/api/chat', { method: 'POST', body: { message: 'hi' } });
    assert.equal(refused.status, 409, 'signed in with another account than the stream key’s');
    assert.equal(twitch.sent.length, 0);

    s = (await json('/api/settings', { method: 'PUT', body: { streamKey: 'live_123456_oddishsownkey' } })).body.settings;
    assert.equal(s.twitch.keyAccount, '123456');
    const res = await json('/api/chat', { method: 'POST', body: { message: '  hello chat Kappa  ' } });
    assert.deepEqual(res.body, { sent: true });
    assert.deepEqual(twitch.sent, [{ broadcaster_id: '123456', sender_id: '123456', message: 'hello chat Kappa' }]);
    const call = twitch.calls.findLast((c) => c.path === '/helix/chat/messages');
    assert.deepEqual([call.headers['client-id'], call.headers.authorization], [CLIENT_ID, 'Bearer access-1']);

    assert.equal((await json('/api/chat', { method: 'POST', body: { message: '   ' } })).status, 400);
    assert.equal((await json('/api/chat', { method: 'POST', body: null })).status, 400);
    assert.equal((await json('/api/chat', { method: 'POST', body: { message: 'x'.repeat(501) } })).status, 400);
    assert.equal((await json('/api/chat', { method: 'POST', body: { message: '👋'.repeat(500) } })).status, 200, '500 characters, however many bytes');
  } finally {
    server.stop();
    twitch.close();
  }
});

test('a dropped message says why; a token that ran out is renewed; a sign-in Twitch ended asks for a new one', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID, streamKey: 'live_123456_oddishsownkey' } });
    await signIn(twitch, json);
    twitch.drop = { code: 'msg_duplicate', message: 'Your message is identical to the one you sent less than 30 seconds ago.' };
    assert.deepEqual((await json('/api/chat', { method: 'POST', body: { message: 'again' } })).body,
      { sent: false, reason: 'Your message is identical to the one you sent less than 30 seconds ago.' });

    twitch.expire();
    assert.deepEqual((await json('/api/chat', { method: 'POST', body: { message: 'after four hours' } })).body, { sent: true });
    assert.equal(twitch.serial, 2, 'renewed once');
    assert.equal(twitch.sent.at(-1).message, 'after four hours');

    twitch.expire();
    twitch.refreshFails = true;
    assert.equal((await json('/api/chat', { method: 'POST', body: { message: 'lost' } })).status, 502);
    const s = (await json('/api/settings')).body;
    assert.deepEqual([s.twitch.canWrite, s.twitch.account.login], [false, 'oddish'], 'the chat still shows; writing needs a sign-in');
    assert.match(s.twitch.problem, /Sign in again/);
    assert.equal((await json('/api/chat', { method: 'POST', body: { message: 'still lost' } })).status, 409);
  } finally {
    server.stop();
    twitch.close();
  }
});

test('Twitch’s global emotes and badges, the channel’s own badges, and pictures only from Twitch', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    assert.deepEqual((await json('/api/chat/assets')).body, { emotes: {}, badges: {} }, 'nothing before a sign-in');
    await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID } });
    await signIn(twitch, json);
    const { body } = await json('/api/chat/assets');
    assert.deepEqual(body.emotes, { 25: 'Kappa', emotesv2_global1: 'GlobalHype' });
    assert.deepEqual(body.badges['moderator/1'], { title: 'Moderator', x1: `${CDN}/badges/v1/mod/1`, x2: `${CDN}/badges/v1/mod/2` });
    assert.equal(body.badges['subscriber/0'].x1, `${CDN}/badges/v1/oddishsub/1`, 'the channel’s own sub badge wins');
    assert.equal(body.badges['evil/1'], undefined, 'a picture from anywhere but Twitch’s image server is left out');
    assert.match(twitch.calls.find((c) => c.path === '/helix/chat/badges').query, /broadcaster_id=123456/);
  } finally {
    server.stop();
    twitch.close();
  }
});

test('signing out, or another Twitch app, forgets the sign-in and tells Twitch', async () => {
  const twitch = await fakeTwitch();
  const { server, json } = await studio(twitch);
  try {
    await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID } });
    await signIn(twitch, json);
    let s = (await json('/api/twitch/signout', { method: 'POST' })).body;
    assert.equal(s.twitch.account, null);
    await eventually(() => twitch.revoked.includes('access-1'));
    assert.ok(!readFileSync(join(server.data, 'settings.json'), 'utf8').includes('refresh-1'));

    await signIn(twitch, json);
    s = (await json('/api/settings', { method: 'PUT', body: { twitchClientId: 'zyxwvutsrq9876543210abcdef' } })).body.settings;
    assert.deepEqual([s.twitch.account, s.twitch.clientId], [null, 'zyxwvutsrq9876543210abcdef']);
    await eventually(() => twitch.revoked.includes('access-2'));
  } finally {
    server.stop();
    twitch.close();
  }
});

test('on start the sign-in is checked with Twitch: renewed before it runs out, and a renamed account followed', async () => {
  const twitch = await fakeTwitch();
  let { server, json } = await studio(twitch);
  try {
    await json('/api/settings', { method: 'PUT', body: { twitchClientId: CLIENT_ID } });
    await signIn(twitch, json);
    server.stop();
    twitch.user = { id: '123456', login: 'oddish_renamed', display_name: 'Oddish_Renamed' };
    twitch.expiresIn = 600;               // ten minutes left on the token
    ({ server, json } = await studio(twitch, { DATA_DIR: server.data }));
    const s = await eventually(async () => { const b = (await json('/api/settings')).body; return b.twitch.account.login === 'oddish_renamed' && b; });
    assert.equal(s.twitch.account.name, 'Oddish_Renamed');
    assert.equal(twitch.serial, 2, 'renewed');
    assert.equal(s.twitch.canWrite, true);
  } finally {
    server.stop();
    twitch.close();
  }
});
