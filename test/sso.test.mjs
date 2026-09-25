// Single sign-on: a proxy in front (Caddy + authentik) checks the hub login and
// names the user in a header. The studio must believe that header from the
// proxy and from nobody else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { startServer, login, ROOT } from './helpers.mjs';

const SSO = { AUTH_HEADER: 'X-Authentik-Username', AUTH_USERS: 'owner', LOGOUT_URL: '/outpost.goauthentik.io/sign_out' };
const as = (user) => ({ 'X-Authentik-Username': user });

// An address of this machine that is not loopback, so a request can come
// from somewhere other than 127.0.0.1. CI runners and home PCs have one.
const lan = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

let server;
before(async () => { server = await startServer(SSO, { password: false }); });
after(() => server.stop());

const get = (url, headers = {}) => fetch(url, { redirect: 'manual', headers });

test('a hub origin is passed to the page, and a bad one stops the server', async () => {
  const hub = await startServer({ ...SSO, HUB_ORIGIN: 'https://hub.example.com' }, { password: false });
  try {
    const state = await (await get(`${hub.url}/api/state`, as('owner'))).json();
    assert.equal(state.settings.hubOrigin, 'https://hub.example.com');
  } finally { hub.stop(); }
  const plain = await (await get(`${server.url}/api/state`, as('owner'))).json();
  assert.equal(plain.settings.hubOrigin, '', 'off unless set');
  for (const bad of ['http://hub.example.com', 'https://hub.example.com/path', 'hub.example.com']) {
    const run = spawnSync('node', [join(ROOT, 'server.js')], {
      env: { ...process.env, ...SSO, HUB_ORIGIN: bad, PORT: '1', DATA_DIR: mkdtempSync(join(tmpdir(), 'studio-hub-')) },
      encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(run.status, 0, bad);
    assert.match(run.stderr, /HUB_ORIGIN/);
  }
});

test('with single sign-on the server starts without a password of its own', async () => {
  assert.equal((await get(`${server.url}/healthz`)).status, 200);
});

test('the user the proxy names is signed in', async () => {
  assert.equal((await get(`${server.url}/`, as('owner'))).status, 200);
  assert.equal((await get(`${server.url}/api/state`, as('owner'))).status, 200);
  const put = await fetch(`${server.url}/api/layouts`, {
    method: 'PUT', headers: { ...as('owner'), Origin: server.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ layouts: [], active: null }),
  });
  assert.equal(put.status, 200, 'changes still need the same-site Origin, and have it');
});

test('the login page sends a signed-in user on to the studio', async () => {
  const res = await get(`${server.url}/login`, as('owner'));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('someone the proxy names but AUTH_USERS leaves out is not signed in', async () => {
  assert.equal((await get(`${server.url}/api/state`, as('guest'))).status, 401);
  assert.equal((await get(`${server.url}/`, as(''))).status, 303);
});

test('without the header it is the ordinary login page', async () => {
  const res = await get(`${server.url}/`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login');
});

test('log out goes back through the hub login', async () => {
  const res = await fetch(`${server.url}/api/logout`, { method: 'POST', redirect: 'manual', headers: as('owner') });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), SSO.LOGOUT_URL);
});

test('the stream socket opens for the signed-in user only', async () => {
  const open = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/stream`, { headers: { Origin: server.url, ...headers } });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
  assert.equal(await open(as('owner')), true);
  assert.equal(await open(as('guest')), false);
  assert.equal(await open({}), false);
});

test('without AUTH_HEADER the header means nothing', async () => {
  const plain = await startServer();
  try {
    assert.equal((await get(`${plain.url}/api/state`, as('owner'))).status, 401);
    await login(plain.url);   // the password login is unchanged
  } finally { plain.stop(); }
});

test('the header is ignored from any address but the proxy', { skip: !lan && 'no non-loopback IPv4 address' }, async () => {
  const open = await startServer({ ...SSO, HOST: '0.0.0.0' }, { password: false });
  const trusting = await startServer({ ...SSO, HOST: '0.0.0.0', TRUST_PROXY: `${lan}/32` }, { password: false });
  try {
    // Same header, but the request arrives from the LAN address, not loopback.
    assert.equal((await get(`http://${lan}:${open.port}/api/state`, as('owner'))).status, 401);
    assert.equal((await get(`http://${lan}:${trusting.port}/api/state`, as('owner'))).status, 200);
  } finally { open.stop(); trusting.stop(); }
});

test('a TRUST_PROXY that is not an address stops the server', () => {
  const empty = mkdtempSync(join(tmpdir(), 'studio-sso-'));
  const run = spawnSync('node', [join(ROOT, 'server.js')], {
    env: { ...process.env, ...SSO, DATA_DIR: empty, PORT: '1', TRUST_PROXY: 'caddy' }, encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /TRUST_PROXY/);
});
