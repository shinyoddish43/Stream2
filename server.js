#!/usr/bin/env node
'use strict';
/**
 * Stream Studio server.
 *
 * One process. It serves the studio behind a login, keeps your layouts and
 * splits, stores uploaded green-screen backgrounds, and relays what the
 * browser encodes to Twitch through ffmpeg (browsers cannot speak RTMP).
 *
 *   node server.js passwd    set the login (required once)
 *   node server.js           run
 *
 * Environment:
 *   PORT=8080  HOST=127.0.0.1  DATA_DIR=./data  FFMPEG=ffmpeg
 *   VIDEO_MODE=transcode|copy  X264_PRESET=veryfast  MAX_UPLOAD_MB=200
 *
 * Behind a reverse proxy that is not on loopback (Caddy in another container):
 *   TRUST_PROXY=10.67.0.2        its address(es), IPs or CIDRs, comma-separated
 *
 * Single sign-on, when that proxy checks a login of its own first (authentik):
 *   AUTH_HEADER=X-Authentik-Username   the header naming who signed in
 *   AUTH_USERS=Oddish                  optional: only these users get in
 *   LOGOUT_URL=/outpost.goauthentik.io/sign_out   where "Log out" goes
 * The header is believed only from TRUST_PROXY or loopback, and the proxy must
 * drop any copy of it the browser sends. The password login keeps working.
 *
 * Twitch's addresses, for tests that stand in for Twitch:
 *   TWITCH_AUTH_URL=https://id.twitch.tv/oauth2  TWITCH_API_URL=https://api.twitch.tv/helix
 *
 * A hub dashboard with a "Go live" button (the six7 hub):
 *   HUB_ORIGIN=https://sylveon.six7.pw   the one page origin whose messages may
 *   start a stream in an open studio window (see public/app.js); unset: off.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const readline = require('readline');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
// Loopback by default: reach it through Caddy (HTTPS) or an SSH tunnel.
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA = path.join(DATA, 'media');
const PUBLIC = path.join(__dirname, 'public');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const VIDEO_MODE = process.env.VIDEO_MODE === 'copy' ? 'copy' : 'transcode';
const X264_PRESET = process.env.X264_PRESET || 'veryfast';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024;
const SESSION_MS = 14 * 24 * 3600 * 1000;
// Twitch's global ingest: it routes each stream to the nearest server. The old
// single address is still accepted but moved over to this one.
const DEFAULT_INGEST = 'rtmp://ingest.global-contribute.live-video.net/app';
const LEGACY_INGEST = 'rtmp://live.twitch.tv/app';

// Proxies whose X-Forwarded-* and AUTH_HEADER are believed. Loopback always is.
const TRUSTED = new net.BlockList();
for (const entry of String(process.env.TRUST_PROXY || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [addr, bits] = entry.split('/');
  const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
  if (!net.isIP(addr) || (bits !== undefined && !/^\d+$/.test(bits))) {
    console.error(`TRUST_PROXY: not an address or CIDR: ${entry}`);
    process.exit(1);
  }
  if (bits === undefined) TRUSTED.addAddress(addr, type);
  else TRUSTED.addSubnet(addr, Number(bits), type);
}
const AUTH_HEADER = String(process.env.AUTH_HEADER || '').trim().toLowerCase();
const AUTH_USERS = new Set(String(process.env.AUTH_USERS || '').split(',').map((s) => s.trim()).filter(Boolean));
const LOGOUT_URL = process.env.LOGOUT_URL || '';
const HUB_ORIGIN = String(process.env.HUB_ORIGIN || '').trim();
if (HUB_ORIGIN) {
  let ok = false;
  try { const u = new URL(HUB_ORIGIN); ok = u.protocol === 'https:' && u.origin === HUB_ORIGIN; } catch { /* not a URL */ }
  if (!ok) {
    console.error(`HUB_ORIGIN: not an https origin like https://hub.example.com: ${HUB_ORIGIN}`);
    process.exit(1);
  }
}

// Pages and files reachable without logging in. Everything else needs a session.
const PUBLIC_FILES = new Set(['/login', '/login.html', '/login.js', '/app.css', '/favicon.svg']);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const UPLOAD_TYPES = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm',
};

// ------------------------------------------------------------------ storage

fs.mkdirSync(MEDIA, { recursive: true, mode: 0o700 });

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; }
}

// Write-then-rename, so a crash mid-write can never leave a half file.
function writeJson(name, value) {
  const file = path.join(DATA, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function verifyLogin(user, password) {
  const auth = readJson('auth.json', null);
  if (!auth) return false;
  const key = await scrypt(String(password), Buffer.from(auth.salt, 'hex'));
  const userOk = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(user)).digest(),
    crypto.createHash('sha256').update(auth.user).digest());
  return crypto.timingSafeEqual(key, Buffer.from(auth.hash, 'hex')) && userOk;
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden) rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      if (hidden && process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function setPassword() {
  // STUDIO_USER / STUDIO_PASSWORD allow scripted installs; otherwise prompt.
  const user = process.env.STUDIO_USER || (await ask('Username [admin]: ')) || 'admin';
  const password = process.env.STUDIO_PASSWORD || (await ask('Password (at least 10 characters): ', true));
  if (!process.env.STUDIO_PASSWORD) {
    const again = await ask('Repeat password: ', true);
    if (again !== password) { console.error('Passwords did not match.'); process.exit(1); }
  }
  if (password.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  writeJson('auth.json', { user, salt: salt.toString('hex'), hash: key.toString('hex') });
  console.log(`Login saved for "${user}" in ${path.join(DATA, 'auth.json')}.`);
}

// ----------------------------------------------------------------- sessions

const sessions = new Map();   // token -> expiry

// Raw values, no decoding: the session token is base64url, and decoding a
// hostile cookie can throw — which, in the WebSocket upgrade handler, used to
// take the whole server down.
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionOf(req) {
  const token = cookies(req).ss;
  const expiry = token && sessions.get(token);
  if (!expiry) return null;
  if (expiry < Date.now()) { sessions.delete(token); return null; }
  return token;
}

function isHttps(req) {
  return req.socket.encrypted || (fromProxy(req) && req.headers['x-forwarded-proto'] === 'https');
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function fromProxy(req) {
  if (isLoopback(req)) return true;
  const a = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return net.isIP(a) !== 0 && TRUSTED.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
}

// Behind Caddy the real address is the last X-Forwarded-For entry, which
// Caddy itself adds. Only believe the header from the proxy.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && fromProxy(req)) return String(forwarded).split(',').pop().trim();
  return req.socket.remoteAddress || '';
}

// Single sign-on: the proxy has already checked the hub login and names the
// user. Anyone else sending the header is ignored.
function proxyUser(req) {
  if (!AUTH_HEADER || !fromProxy(req)) return null;
  const user = String(req.headers[AUTH_HEADER] || '').trim();
  if (!user || (AUTH_USERS.size && !AUTH_USERS.has(user))) return null;
  return user;
}

function signedIn(req) {
  return !!(proxyUser(req) || sessionOf(req));
}

// A request that changes something, or opens the stream socket, must come
// from this site. SameSite=Strict already keeps the cookie off cross-site
// requests; this is the belt to that pair of braces.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Login throttling: five free tries per address, then a doubling lockout.
const failures = new Map();

function lockedFor(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (f.count - 5));
  failures.set(ip, f);
  // Bound the table, but only by forgetting addresses that are not locked out:
  // a flood of new addresses must not be able to wipe the lockouts.
  if (failures.size > 10000) for (const [key, v] of failures) if (v.until < Date.now()) failures.delete(key);
}

// ------------------------------------------------------------------- http

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self'",
    // Twitch chat (public/chat.js): its server, and its emote pictures.
    "img-src 'self' data: blob: https://static-cdn.jtvnw.net",
    "media-src 'self' blob:", "connect-src 'self' wss://irc-ws.chat.twitch.tv", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(json);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(fail(413, 'too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit) {
  try { return JSON.parse((await readBody(req, limit)).toString('utf8')); }
  catch (e) { throw e.status ? e : fail(400, 'expected JSON'); }
}

function serveFile(req, res, file, cacheable) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { send(res, 404, { error: 'not found' }); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': cacheable ? 'private, max-age=86400' : 'no-cache', 'Accept-Ranges': 'bytes' };
    // Range support: a looping background video needs it to seek cleanly.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
}

const ingestOf = (s) => (!s.ingest || s.ingest === LEGACY_INGEST ? DEFAULT_INGEST : s.ingest);

function publicSettings() {
  const s = readJson('settings.json', {});
  return { ingest: ingestOf(s), hasKey: !!s.streamKey, testMode: !!s.testMode, hubOrigin: HUB_ORIGIN, twitch: twitchStatus(s) };
}

// Remove uploads no layout refers to any more. The grace period keeps a file
// that was just uploaded but whose layout has not been saved yet.
function collectMedia(layouts) {
  const used = new Set((JSON.stringify(layouts).match(/\/media\/[a-f0-9]+\.[a-z0-9]+/g) || []).map((m) => m.slice(7)));
  for (const name of fs.readdirSync(MEDIA)) {
    if (used.has(name)) continue;
    const file = path.join(MEDIA, name);
    try { if (Date.now() - fs.statSync(file).mtimeMs > 3600e3) fs.unlinkSync(file); } catch { /* raced */ }
  }
}

async function route(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const method = req.method;

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }

  if (p === '/api/login' && method === 'POST') {
    if (!sameOrigin(req)) throw fail(403, 'bad origin');
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait) throw fail(429, `Too many attempts. Try again in ${wait}s.`);
    const body = await readJsonBody(req, 4096);
    if (!(await verifyLogin(body.user || '', body.password || ''))) {
      recordFailure(ip);
      throw fail(401, 'Wrong username or password.');
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `ss=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`);
    send(res, 200, { ok: true });
    return;
  }

  if (p === '/api/logout' && method === 'POST') {
    const token = sessionOf(req);
    if (token) sessions.delete(token);
    // Under single sign-on /login would just sign you straight back in.
    const next = (proxyUser(req) && LOGOUT_URL) || '/login';
    res.writeHead(303, { Location: next, 'Set-Cookie': 'ss=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    res.end();
    return;
  }

  if ((p === '/login' || p === '/login.html') && method === 'GET' && proxyUser(req)) {
    res.writeHead(303, { Location: '/' });
    res.end();
    return;
  }

  if (PUBLIC_FILES.has(p) && method === 'GET') {
    serveFile(req, res, path.join(PUBLIC, p === '/login' ? 'login.html' : p.slice(1)), false);
    return;
  }

  // ---- everything below needs a session
  if (!signedIn(req)) {
    if (method === 'GET' && !p.startsWith('/api/')) { res.writeHead(303, { Location: '/login' }); res.end(); return; }
    throw fail(401, 'not logged in');
  }
  if (method !== 'GET' && !sameOrigin(req)) throw fail(403, 'bad origin');

  if (p === '/api/state' && method === 'GET') {
    send(res, 200, { layouts: readJson('layouts.json', null), splits: readJson('splits.json', null), settings: publicSettings() });
    return;
  }

  // Layouts carry a revision so every browser and device works on the same
  // copy: a save based on an older revision is refused with what is saved now,
  // and an open page asks for the revision now and then to pick up changes.
  if (p === '/api/layouts' && method === 'GET') {
    const saved = readJson('layouts.json', null);
    const rev = (saved && saved.rev) || 0;
    if (url.searchParams.get('since') === String(rev)) { send(res, 200, { rev }); return; }
    send(res, 200, { rev, doc: saved });
    return;
  }

  if (p === '/api/layouts' && method === 'PUT') {
    const doc = await readJsonBody(req, 1024 * 1024);
    if (!doc || !Array.isArray(doc.layouts)) throw fail(400, 'layouts must be a list');
    const saved = readJson('layouts.json', null);
    const rev = (saved && saved.rev) || 0;
    // A save without a revision (a page from before revisions) simply wins.
    if (doc.rev !== undefined && doc.rev !== rev) {
      send(res, 409, { error: 'Changed in another window or on another device.', rev, doc: saved });
      return;
    }
    const next = { ...doc, rev: rev + 1, savedAt: new Date().toISOString() };
    writeJson('layouts.json', next);
    collectMedia(next);
    send(res, 200, { ok: true, rev: next.rev });
    return;
  }

  if (p === '/api/splits' && method === 'PUT') {
    const run = await readJsonBody(req, 2 * 1024 * 1024);
    if (!run || !Array.isArray(run.segments)) throw fail(400, 'splits need segments');
    writeJson('splits.json', run);
    send(res, 200, { ok: true });
    return;
  }

  if (p === '/api/settings' && method === 'PUT') {
    const body = await readJsonBody(req, 4096);
    const s = readJson('settings.json', {});
    if (body.ingest !== undefined) {
      const ingest = String(body.ingest).trim().replace(/\/+$/, '');
      if (!/^rtmps?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._\/-]*)?$/.test(ingest)) throw fail(400, `The server address must look like ${DEFAULT_INGEST}`);
      s.ingest = ingest;
    }
    if (body.streamKey) {
      const key = String(body.streamKey).trim();
      if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) throw fail(400, 'That does not look like a Twitch stream key.');
      s.streamKey = key;
    }
    if (body.clearKey) delete s.streamKey;
    if (body.testMode !== undefined) s.testMode = !!body.testMode;
    // The studio's Twitch app, for the chat. Its secret, like the key, never goes back.
    if (body.twitchClientId !== undefined) {
      const id = String(body.twitchClientId).trim();
      const secret = String(body.twitchClientSecret || '').trim();
      if (!/^[A-Za-z0-9]{20,64}$/.test(id)) throw fail(400, 'That does not look like a Twitch Client ID: copy it from the app’s page on dev.twitch.tv.');
      if (secret && !/^[A-Za-z0-9]{20,64}$/.test(secret)) throw fail(400, 'That does not look like a Twitch client secret.');
      const sameApp = !!s.twitchApp && s.twitchApp.clientId === id;
      if (!sameApp) {
        // A sign-in belongs to the app it was made with.
        stopSignIn();
        if (s.twitchUser && s.twitchUser.access && s.twitchApp) revoke(s.twitchUser.access, s.twitchApp.clientId);
        delete s.twitchUser;
        chatAssets = null;
        twitchProblem = '';
      }
      // The same app saved again without its secret keeps the one it has.
      const clientSecret = secret || (sameApp && s.twitchApp.clientSecret) || '';
      s.twitchApp = clientSecret ? { clientId: id, clientSecret } : { clientId: id };
    }
    writeJson('settings.json', s);
    send(res, 200, { ok: true, settings: publicSettings() });
    return;
  }

  if (p === '/api/settings' && method === 'GET') { send(res, 200, publicSettings()); return; }

  if (p === '/api/twitch/signin' && method === 'POST') { await startSignIn(); send(res, 200, publicSettings()); return; }
  if (p === '/api/twitch/signin' && method === 'DELETE') { stopSignIn(); send(res, 200, publicSettings()); return; }
  if (p === '/api/twitch/signout' && method === 'POST') { signOut(); send(res, 200, publicSettings()); return; }
  if (p === '/api/chat/assets' && method === 'GET') { send(res, 200, await loadChatAssets()); return; }

  if (p === '/api/twitch/streamkey' && method === 'POST') { await keyFromTwitch(); send(res, 200, publicSettings()); return; }
  if (p === '/api/twitch/channel' && method === 'GET') { send(res, 200, await channelInfo()); return; }
  if (p === '/api/twitch/categories' && method === 'GET') {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 60);
    send(res, 200, { items: query ? await searchCategories(query) : [] });
    return;
  }
  if (p === '/api/twitch/channel' && method === 'PUT') {
    const body = (await readJsonBody(req, 4096)) || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const categoryId = String(body.categoryId || '');
    if ([...title].length > 140) throw fail(400, 'Twitch takes a title of at most 140 characters.');
    if (!/^\d{0,20}$/.test(categoryId)) throw fail(400, 'Pick a category from the list.');
    if (!title && !categoryId) throw fail(400, 'Give the stream a title or a category.');
    send(res, 200, await setChannel(title, categoryId));
    return;
  }

  if (p === '/api/chat' && method === 'POST') {
    const body = await readJsonBody(req, 8192);
    const message = body && typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) throw fail(400, 'Type a message first.');
    if ([...message].length > 500) throw fail(400, 'Twitch takes at most 500 characters.');
    send(res, 200, await sendChat(message));
    return;
  }

  if (p === '/api/media' && method === 'POST') {
    const ext = UPLOAD_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext) throw fail(415, 'Upload a PNG, JPEG, WebP, GIF, MP4 or WebM file.');
    const data = await readBody(req, MAX_UPLOAD);
    const name = crypto.randomBytes(12).toString('hex') + ext;
    fs.writeFileSync(path.join(MEDIA, name), data, { mode: 0o600 });
    send(res, 200, { url: `/media/${name}` });
    return;
  }

  const media = /^\/media\/([a-f0-9]{24}\.(png|jpg|webp|gif|mp4|webm))$/.exec(p);
  if (media && method === 'GET') { serveFile(req, res, path.join(MEDIA, media[1]), true); return; }

  if (method === 'GET') {
    // Static app files. Resolve inside public/ and refuse anything that escapes.
    let rel;
    try { rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, ''); } catch { throw fail(400, 'bad path'); }
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) throw fail(404, 'not found');
    serveFile(req, res, file, false);
    return;
  }

  throw fail(404, 'not found');
}

// ----------------------------------------------------------- Twitch chat
//
// The page reads the chat straight from Twitch's chat server, signed out, but
// only the channel of the account the stream key streams to. Writing in it
// takes a sign-in: the studio's own Twitch app (its Client ID, pasted in the
// page) signs the owner in with Twitch's device code flow, and what they type
// goes out through the Twitch API as that account. Tokens stay on the server,
// like the stream key.

const TWITCH_AUTH = String(process.env.TWITCH_AUTH_URL || 'https://id.twitch.tv/oauth2').replace(/\/+$/, '');
const TWITCH_API = String(process.env.TWITCH_API_URL || 'https://api.twitch.tv/helix').replace(/\/+$/, '');
// Write in the chat; set the stream's title and category; read the stream key,
// so going live never has to ask for it.
const TWITCH_SCOPES = 'user:write:chat channel:manage:broadcast channel:read:stream_key';
const RECENT_SHOWN = 3;     // categories offered as "recently used", as on the hub
const RECENT_KEPT = 10;
const TWITCH_CDN = 'https://static-cdn.jtvnw.net/';

let signIn = null;          // the device code sign-in waiting for the owner on twitch.tv/activate
let twitchProblem = '';     // what went wrong last, for the page
let chatAssets = null;      // global emotes and badges: { at, account, failed, data }
let refreshing = null;      // the token refresh in flight: one at a time, the refresh token is single use

// Twitch stream keys look like live_<account id>_<secret>.
const keyAccount = (key) => (/^live_(\d+)_/.exec(String(key || '')) || [])[1] || null;

async function twitchCall(url, { method = 'GET', token, clientId, form, json, timeout = 15000 } = {}) {
  const headers = {};
  if (clientId) headers['Client-Id'] = clientId;
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  let res;
  try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) }); } catch { throw fail(502, 'Could not reach Twitch.'); }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data: data && typeof data === 'object' ? data : {} };
}

const twitchSaid = (res, what) => `${what}${res.data.message ? `: ${res.data.message}` : ` (${res.status})`}.`;

// Sign-ins from before the studio asked for more than the chat have only that.
const hasScope = (user, scope) => !!user && !!user.refresh && (Array.isArray(user.scopes) ? user.scopes : ['user:write:chat']).includes(scope);

/** A Helix call with the signed-in account's token, renewed once if Twitch says it ran out. */
async function helix(path, { method = 'GET', json, timeout } = {}) {
  const clientId = (readJson('settings.json', {}).twitchApp || {}).clientId;
  const call = async (token) => twitchCall(`${TWITCH_API}${path}`, { method, json, token, clientId, timeout });
  const res = await call(await accessToken());
  return res.status === 401 ? call(await accessToken(true)) : res;
}

function twitchStatus(s) {
  const user = s.twitchUser;
  return {
    app: !!(s.twitchApp && s.twitchApp.clientId),
    clientId: (s.twitchApp && s.twitchApp.clientId) || '',
    account: user ? { id: user.id, login: user.login, name: user.name } : null,
    canWrite: hasScope(user, 'user:write:chat'),
    canTitle: hasScope(user, 'channel:manage:broadcast'),
    canKey: hasScope(user, 'channel:read:stream_key'),
    keyAccount: keyAccount(s.streamKey),
    pending: signIn ? { code: signIn.code, url: signIn.url, expires: signIn.expires } : null,
    problem: twitchProblem,
  };
}

function stopSignIn() {
  if (signIn) clearTimeout(signIn.timer);
  signIn = null;
}

async function startSignIn() {
  const app = readJson('settings.json', {}).twitchApp;
  if (!app || !app.clientId) throw fail(409, 'Add the Twitch app’s Client ID first.');
  stopSignIn();
  const res = await twitchCall(`${TWITCH_AUTH}/device`, { method: 'POST', form: { client_id: app.clientId, scopes: TWITCH_SCOPES } });
  if (!res.ok || !res.data.device_code) throw fail(502, twitchSaid(res, 'Twitch did not start the sign-in. Check the app’s Client ID'));
  const d = res.data;
  signIn = {
    code: String(d.user_code || ''),
    // The address fills the code in. Only ever a twitch.tv page.
    url: /^https:\/\/(www\.)?twitch\.tv\//.test(d.verification_uri) ? d.verification_uri : 'https://www.twitch.tv/activate',
    expires: Date.now() + (Number(d.expires_in) || 1800) * 1000,
    device: d.device_code,
    interval: Math.max(100, (Number(d.interval) || 5) * 1000),
  };
  twitchProblem = '';
  waitForSignIn(signIn);
}

// Ask Twitch every few seconds whether the owner has approved the sign-in yet.
function waitForSignIn(flow) {
  flow.timer = setTimeout(async () => {
    if (signIn !== flow) return;
    if (Date.now() > flow.expires) { stopSignIn(); twitchProblem = 'The sign-in code expired. Sign in again.'; return; }
    const app = readJson('settings.json', {}).twitchApp || {};
    const form = { client_id: app.clientId, scopes: TWITCH_SCOPES, device_code: flow.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' };
    if (app.clientSecret) form.client_secret = app.clientSecret;
    let res;
    try { res = await twitchCall(`${TWITCH_AUTH}/token`, { method: 'POST', form }); } catch { if (signIn === flow) waitForSignIn(flow); return; }
    if (signIn !== flow) return;
    const message = String(res.data.message || '');
    if (res.ok && res.data.access_token) {
      // Still "signing in" until the account and its stream key are saved, so
      // the page never sees one without the other.
      clearTimeout(flow.timer);
      try { await keepSignIn(res.data, app); } catch (e) { twitchProblem = e.message; }
      if (signIn === flow) stopSignIn();
    } else if (/authorization_pending/i.test(message)) {
      waitForSignIn(flow);
    } else if (/slow_down/i.test(message)) {
      flow.interval += 5000;
      waitForSignIn(flow);
    } else {
      stopSignIn();
      twitchProblem = /denied/i.test(message) ? 'The sign-in was declined on Twitch.' : twitchSaid(res, 'Twitch did not finish the sign-in');
    }
  }, flow.interval);
}

async function keepSignIn(tokens, app) {
  const v = await twitchCall(`${TWITCH_AUTH}/validate`, { token: tokens.access_token });
  if (!v.ok || !v.data.user_id) throw fail(502, 'Twitch signed in but did not say which account. Sign in again.');
  let name = v.data.login;
  const u = await twitchCall(`${TWITCH_API}/users?id=${encodeURIComponent(v.data.user_id)}`, { token: tokens.access_token, clientId: app.clientId }).catch(() => null);
  if (u && u.ok && Array.isArray(u.data.data) && u.data.data[0]) name = u.data.data[0].display_name || name;
  const s = readJson('settings.json', {});
  if (!s.twitchApp || s.twitchApp.clientId !== app.clientId) { revoke(tokens.access_token, app.clientId); return; }   // the app changed meanwhile
  if (s.twitchUser && s.twitchUser.access) revoke(s.twitchUser.access, app.clientId);
  s.twitchUser = {
    id: String(v.data.user_id), login: String(v.data.login), name: String(name),
    scopes: Array.isArray(v.data.scopes) ? v.data.scopes.map(String) : [],
    access: tokens.access_token, refresh: tokens.refresh_token, expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
  };
  writeJson('settings.json', s);
  twitchProblem = '';
  chatAssets = null;
  // The stream key comes with the sign-in: none saved yet, or this account's
  // (renewed). Another account's key stays; the chat panel offers to switch.
  if (!s.streamKey || keyAccount(s.streamKey) === s.twitchUser.id) await keyFromTwitch().catch(() => {});
}

/** The signed-in account's stream key, from Twitch, saved like a pasted one. */
async function keyFromTwitch({ timeout } = {}) {
  const user = readJson('settings.json', {}).twitchUser;
  if (!hasScope(user, 'channel:read:stream_key')) throw fail(409, 'Sign in with Twitch (Chat panel) to get the stream key from there.');
  const res = await helix(`/streams/key?broadcaster_id=${encodeURIComponent(user.id)}`, { timeout });
  const key = String((res.ok && Array.isArray(res.data.data) && res.data.data[0] && res.data.data[0].stream_key) || '');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) throw fail(502, twitchSaid(res, 'Twitch did not give the stream key'));
  const s = readJson('settings.json', {});
  if (!s.twitchUser || s.twitchUser.id !== user.id) throw fail(409, 'Signed out of Twitch meanwhile.');
  if (s.streamKey !== key) { s.streamKey = key; writeJson('settings.json', s); }
  return key;
}

// The key a stream starts with: the saved one, renewed from Twitch first when
// the studio is signed in to the account it streams to (so a key reset on
// Twitch just works). Whatever Twitch gives is saved.
async function keyForStream() {
  const s = readJson('settings.json', {});
  const user = s.twitchUser;
  if (hasScope(user, 'channel:read:stream_key') && (!s.streamKey || keyAccount(s.streamKey) === user.id)) {
    try { return await keyFromTwitch({ timeout: 5000 }); } catch { /* the saved one, if there is one */ }
  }
  return readJson('settings.json', {}).streamKey || null;
}

// ------------------------------------------- the stream's title and category

/** The account whose title and category the studio sets: the one it streams to. */
function broadcastAccount() {
  const s = readJson('settings.json', {});
  const user = s.twitchUser;
  if (!user || !user.refresh) throw fail(409, 'Sign in with Twitch (Chat panel) to set the title and category from here.');
  if (!hasScope(user, 'channel:manage:broadcast')) throw fail(409, 'Sign in with Twitch again (Chat panel, ⋯ → Sign out, then sign in) to let the studio set the title and category.');
  if (s.streamKey && keyAccount(s.streamKey) !== user.id) throw fail(409, `The stream key is for another Twitch account than ${user.name}.`);
  return user;
}

function recentCategories() {
  return (readJson('settings.json', {}).twitchRecent || []).slice(0, RECENT_SHOWN).map(({ id, name }) => ({ id, name }));
}

/** Note a category the stream used, however it was set (here or on Twitch). */
function rememberCategory(category) {
  if (!category || !/^\d{1,20}$/.test(category.id) || !category.name) return;
  const s = readJson('settings.json', {});
  const list = (s.twitchRecent || []).filter((c) => c.id !== category.id);
  s.twitchRecent = [{ id: category.id, name: String(category.name).slice(0, 200) }, ...list].slice(0, RECENT_KEPT);
  writeJson('settings.json', s);
}

async function channelInfo() {
  const user = broadcastAccount();
  const res = await helix(`/channels?broadcaster_id=${encodeURIComponent(user.id)}`);
  if (!res.ok) throw fail(502, twitchSaid(res, 'Twitch did not say what the stream is set to'));
  const row = (Array.isArray(res.data.data) && res.data.data[0]) || {};
  const category = row.game_id ? { id: String(row.game_id), name: String(row.game_name || '') } : null;
  if (category) rememberCategory(category);
  return { title: String(row.title || ''), category, recent: recentCategories() };
}

async function searchCategories(query) {
  const res = await helix(`/search/categories?query=${encodeURIComponent(query)}&first=10`);
  if (!res.ok) throw fail(502, twitchSaid(res, 'Twitch did not search its categories'));
  const found = (Array.isArray(res.data.data) ? res.data.data : [])
    .filter((c) => c && c.id && c.name)
    .map((c) => ({ id: String(c.id), name: String(c.name) }));
  // Twitch ranks by relevance; a category named exactly what was typed goes first.
  const wanted = query.toLowerCase();
  return found.sort((a, b) => (a.name.toLowerCase() !== wanted) - (b.name.toLowerCase() !== wanted));
}

async function setChannel(title, categoryId) {
  const user = broadcastAccount();
  const body = {};
  if (title) body.title = title;
  if (categoryId) body.game_id = categoryId;
  const res = await helix(`/channels?broadcaster_id=${encodeURIComponent(user.id)}`, { method: 'PATCH', json: body });
  if (!res.ok) throw fail(502, twitchSaid(res, 'Twitch did not change the title and category'));
  if (categoryId) {
    // The name comes from Twitch, not the page. The change is made either way;
    // only the recent list would miss it.
    const game = await helix(`/games?id=${encodeURIComponent(categoryId)}`).catch(() => null);
    const row = game && game.ok && Array.isArray(game.data.data) && game.data.data[0];
    if (row && String(row.id) === categoryId) rememberCategory({ id: categoryId, name: String(row.name || '') });
  }
  return { saved: true, recent: recentCategories() };
}

function revoke(token, clientId) {
  twitchCall(`${TWITCH_AUTH}/revoke`, { method: 'POST', form: { client_id: clientId, token } }).catch(() => { /* it expires anyway */ });
}

// Keep the account (the chat still shows) but drop what lets the studio write.
function forgetTokens(problem) {
  const s = readJson('settings.json', {});
  if (!s.twitchUser) return;
  s.twitchUser.access = null;
  s.twitchUser.refresh = null;
  writeJson('settings.json', s);
  twitchProblem = problem;
}

function signOut() {
  stopSignIn();
  const s = readJson('settings.json', {});
  if (s.twitchUser && s.twitchUser.access && s.twitchApp) revoke(s.twitchUser.access, s.twitchApp.clientId);
  delete s.twitchUser;
  writeJson('settings.json', s);
  twitchProblem = '';
  chatAssets = null;
}

/** A working access token; refreshed first when it is about to run out, or when `force`. */
function accessToken(force = false) {
  const user = readJson('settings.json', {}).twitchUser;
  if (!user || !user.refresh) return Promise.reject(fail(409, 'Sign in with Twitch to write in the chat.'));
  if (!force && user.access && user.expires - Date.now() > 60e3) return Promise.resolve(user.access);
  if (!refreshing) refreshing = refreshTokens().finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshTokens() {
  const s = readJson('settings.json', {});
  const app = s.twitchApp || {};
  const user = s.twitchUser;
  const form = { client_id: app.clientId, grant_type: 'refresh_token', refresh_token: user.refresh };
  if (app.clientSecret) form.client_secret = app.clientSecret;
  const res = await twitchCall(`${TWITCH_AUTH}/token`, { method: 'POST', form });
  if (!res.ok || !res.data.access_token) {
    // Revoked, or (a Public app's) not used for 30 days: only a new sign-in helps.
    if (res.status === 400 || res.status === 401) forgetTokens('Twitch ended the studio’s sign-in. Sign in again to write in the chat.');
    throw fail(502, twitchSaid(res, 'Twitch did not renew the sign-in'));
  }
  const now = readJson('settings.json', {});
  if (!now.twitchUser || now.twitchUser.id !== user.id) throw fail(409, 'Signed out of Twitch meanwhile.');
  Object.assign(now.twitchUser, {
    access: res.data.access_token,
    refresh: res.data.refresh_token || user.refresh,
    expires: Date.now() + (Number(res.data.expires_in) || 3600) * 1000,
  });
  writeJson('settings.json', now);
  return now.twitchUser.access;
}

// Twitch asks apps to check their tokens when they start and every hour. It
// also renews the token well before its four hours are up, which keeps a
// Public app's sign-in (its refresh token lasts 30 days) alive indefinitely,
// and follows a renamed account.
async function checkTwitch() {
  const user = readJson('settings.json', {}).twitchUser;
  if (!user || !user.refresh) return;
  try {
    let v = user.access ? await twitchCall(`${TWITCH_AUTH}/validate`, { token: user.access }) : { status: 401, ok: false, data: {} };
    if (v.status === 401 || (v.ok && Number(v.data.expires_in) < 2 * 3600)) v = await twitchCall(`${TWITCH_AUTH}/validate`, { token: await accessToken(true) });
    let before = readJson('settings.json', {}).twitchUser;
    if (v.ok && before && before.id === String(v.data.user_id) && Array.isArray(v.data.scopes)
      && v.data.scopes.join(' ') !== (before.scopes || []).join(' ')) {
      const s = readJson('settings.json', {});
      s.twitchUser.scopes = v.data.scopes.map(String);
      writeJson('settings.json', s);
      before = s.twitchUser;
    }
    if (!v.ok || !v.data.login || !before || before.id !== String(v.data.user_id) || before.login === v.data.login) return;
    const app = readJson('settings.json', {}).twitchApp || {};
    const u = await twitchCall(`${TWITCH_API}/users?id=${encodeURIComponent(before.id)}`, { token: await accessToken(), clientId: app.clientId });
    const s = readJson('settings.json', {});
    if (!s.twitchUser || s.twitchUser.id !== before.id) return;
    s.twitchUser.login = String(v.data.login);
    s.twitchUser.name = String((u.ok && Array.isArray(u.data.data) && u.data.data[0] && u.data.data[0].display_name) || v.data.login);
    writeJson('settings.json', s);
  } catch { /* Twitch unreachable: next hour */ }
}

/** Twitch's global emotes, and the global and this channel's badges: only those show as pictures. */
async function loadChatAssets() {
  const s = readJson('settings.json', {});
  const user = s.twitchUser;
  const empty = { emotes: {}, badges: {} };
  if (!user || !s.twitchApp) return empty;
  const fresh = chatAssets && chatAssets.account === user.id && Date.now() - chatAssets.at < (chatAssets.failed ? 5 * 60e3 : 12 * 3600e3);
  if (fresh) return chatAssets.data;
  const data = { emotes: {}, badges: {} };
  let failed = true;
  try {
    const token = await accessToken();
    const get = (p) => twitchCall(`${TWITCH_API}${p}`, { token, clientId: s.twitchApp.clientId });
    const [emotes, global, channel] = await Promise.all([
      get('/chat/emotes/global'), get('/chat/badges/global'), get(`/chat/badges?broadcaster_id=${encodeURIComponent(user.id)}`),
    ]);
    for (const e of Array.isArray(emotes.data.data) ? emotes.data.data : []) {
      if (/^[A-Za-z0-9_]+$/.test(String(e.id)) && typeof e.name === 'string') data.emotes[e.id] = e.name;
    }
    // The channel's own badges (its subscriber badges, say) replace the global ones.
    for (const set of [global, channel].flatMap((r) => (Array.isArray(r.data.data) ? r.data.data : []))) {
      for (const v of Array.isArray(set.versions) ? set.versions : []) {
        const x1 = String(v.image_url_1x || '');
        const x2 = String(v.image_url_2x || '');
        if (!x1.startsWith(TWITCH_CDN)) continue;
        data.badges[`${set.set_id}/${v.id}`] = { title: String(v.title || set.set_id), x1, x2: x2.startsWith(TWITCH_CDN) ? x2 : x1 };
      }
    }
    failed = !emotes.ok || !global.ok;
  } catch { /* shown as text until the next try */ }
  chatAssets = { at: Date.now(), account: user.id, failed, data };
  return data;
}

async function sendChat(message) {
  const s = readJson('settings.json', {});
  const user = s.twitchUser;
  if (!user || !user.refresh) throw fail(409, 'Sign in with Twitch to write in the chat.');
  // No key saved yet is fine when it will come from this account.
  const streamsHere = s.streamKey ? keyAccount(s.streamKey) === user.id : hasScope(user, 'channel:read:stream_key');
  if (!streamsHere) throw fail(409, 'The chat is the stream key’s account, and you are signed in with another one.');
  const res = await helix('/chat/messages', { method: 'POST', json: { broadcaster_id: user.id, sender_id: user.id, message } });
  if (res.ok) {
    const d = (Array.isArray(res.data.data) && res.data.data[0]) || {};
    if (d.is_sent) return { sent: true };
    return { sent: false, reason: String((d.drop_reason && (d.drop_reason.message || d.drop_reason.code)) || 'Twitch did not send it.') };
  }
  if (res.status === 429) throw fail(429, 'Twitch says that is too many messages for now. Wait a moment.');
  throw fail(502, twitchSaid(res, 'Twitch did not take the message'));
}

// ------------------------------------------------------------ the relay

let broadcasting = null;   // one stream at a time

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function ffmpegArgs(opts, target) {
  const fps = clampInt(opts.fps, 10, 60, 30);
  const kbps = clampInt(opts.bitrate, 500, 8000, 4500);
  // Twitch wants H.264, CBR, a keyframe every two seconds and a constant frame
  // rate. The browser sends variable-rate WebM, so by default we re-encode.
  const video = VIDEO_MODE === 'copy' && /h264|avc1/i.test(String(opts.mimeType))
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', X264_PRESET, '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
      '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-x264-params', 'nal-hrd=cbr'];
  return ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-i', 'pipe:0', ...video,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-f', 'flv', '-flvflags', 'no_duration_filesize', target];
}

function relay(ws) {
  let ffmpeg = null;
  let bytes = 0;
  let started = 0;
  let timer = null;
  let key = '';
  const say = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const hide = (text) => (key ? String(text).split(key).join('***') : String(text));

  const stop = (error) => {
    if (error) say({ type: 'error', message: hide(error) });
    clearInterval(timer);
    if (ffmpeg) {
      const proc = ffmpeg;
      ffmpeg = null;
      try { proc.stdin.end(); } catch { /* closed */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    }
    if (broadcasting === ws) broadcasting = null;
    if (error) ws.close();
  };

  let starting = false;
  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (!ffmpeg || !ffmpeg.stdin.writable) return;
      // A stuck ffmpeg must not grow memory without bound.
      if (ffmpeg.stdin.writableLength > 32 * 1024 * 1024) { stop('The server could not keep up with the stream. Lower the bitrate.'); return; }
      bytes += data.length;
      ffmpeg.stdin.write(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'stop') { stop(); ws.close(); return; }
    if (msg.type !== 'start' || ffmpeg || starting) return;

    if (broadcasting && broadcasting !== ws) { stop('Already streaming from another window.'); return; }
    broadcasting = ws;
    starting = true;
    let streamKey;
    try { streamKey = await keyForStream(); } finally { starting = false; }
    if (ws.readyState !== 1 || broadcasting !== ws) return;          // stopped or closed meanwhile
    if (!streamKey) { stop('Add your Twitch stream key first (the layout menu), or sign in with Twitch in the Chat panel.'); return; }
    const s = readJson('settings.json', {});
    key = streamKey;
    const target = `${ingestOf(s).replace(/\/+$/, '')}/${streamKey}${s.testMode ? '?bandwidthtest=true' : ''}`;

    ffmpeg = spawn(FFMPEG, ffmpegArgs(msg, target), { stdio: ['pipe', 'ignore', 'pipe'] });
    started = Date.now();
    let lastError = '';
    ffmpeg.stderr.on('data', (chunk) => {
      const line = hide(chunk).trim().split('\n').pop();
      if (line) { lastError = line; console.warn('[ffmpeg]', line); }
    });
    ffmpeg.stdin.on('error', () => { /* reported through exit */ });
    ffmpeg.on('error', (err) => stop(err.code === 'ENOENT' ? 'ffmpeg is not installed on the server.' : err.message));
    const proc = ffmpeg;
    ffmpeg.on('exit', (code) => {
      if (ffmpeg !== proc) return;       // we stopped it ourselves
      stop(`The connection to Twitch ended${lastError ? `: ${lastError}` : ` (ffmpeg exit ${code})`}.`);
    });
    timer = setInterval(() => say({ type: 'stats', bytes, seconds: Math.round((Date.now() - started) / 1000) }), 2000);
    say({ type: 'ready', testMode: !!s.testMode });
    console.log(`[stream] started${s.testMode ? ' (bandwidth test)' : ''}`);
  });

  ws.on('close', () => { stop(); console.log('[stream] ended'); });
  ws.on('error', () => stop());
}

// ----------------------------------------------------------------- start

function start() {
  if (!AUTH_HEADER && !readJson('auth.json', null)) {
    console.error('No login is set. Run:  node server.js passwd');
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!e.status) console.error(e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    });
  });
  // Node's default 5-minute limit per request would cut off a 200 MB
  // background upload on a home uplink slower than about 5 Mbit/s.
  server.requestTimeout = 30 * 60e3;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let allowed = false;
    try { allowed = new URL(req.url, 'http://local').pathname === '/api/stream' && signedIn(req) && sameOrigin(req); } catch { /* refused below */ }
    if (!allowed) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, relay);
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : e.message);
    process.exit(1);
  });
  checkTwitch();
  setInterval(checkTwitch, 3600e3).unref();
  const sso = AUTH_HEADER ? `, sign-in: ${AUTH_HEADER}` : '';
  server.listen(PORT, HOST, () => console.log(`Stream Studio on http://${HOST}:${PORT}  (data: ${DATA}, video: ${VIDEO_MODE}${sso})`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { wss.clients.forEach((c) => c.close()); server.close(); process.exit(0); });
}

if (require.main === module) {
  if (process.argv[2] === 'passwd') setPassword().catch((e) => { console.error(e.message); process.exit(1); });
  else start();
}

module.exports = { ffmpegArgs };
