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
const DEFAULT_INGEST = 'rtmp://live.twitch.tv/app';

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
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
    "media-src 'self' blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
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

function publicSettings() {
  const s = readJson('settings.json', {});
  return { ingest: s.ingest || DEFAULT_INGEST, hasKey: !!s.streamKey, testMode: !!s.testMode };
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

  if (p === '/api/layouts' && method === 'PUT') {
    const doc = await readJsonBody(req, 1024 * 1024);
    if (!doc || !Array.isArray(doc.layouts)) throw fail(400, 'layouts must be a list');
    writeJson('layouts.json', doc);
    collectMedia(doc);
    send(res, 200, { ok: true });
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
      if (!/^rtmps?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._\/-]*)?$/.test(ingest)) throw fail(400, 'The server address must look like rtmp://live.twitch.tv/app');
      s.ingest = ingest;
    }
    if (body.streamKey) {
      const key = String(body.streamKey).trim();
      if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) throw fail(400, 'That does not look like a Twitch stream key.');
      s.streamKey = key;
    }
    if (body.clearKey) delete s.streamKey;
    if (body.testMode !== undefined) s.testMode = !!body.testMode;
    writeJson('settings.json', s);
    send(res, 200, { ok: true, settings: publicSettings() });
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

  ws.on('message', (data, isBinary) => {
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
    if (msg.type !== 'start' || ffmpeg) return;

    if (broadcasting && broadcasting !== ws) { stop('Already streaming from another window.'); return; }
    const s = readJson('settings.json', {});
    if (!s.streamKey) { stop('Add your Twitch stream key in Settings first.'); return; }
    key = s.streamKey;
    const target = `${(s.ingest || DEFAULT_INGEST).replace(/\/+$/, '')}/${s.streamKey}${s.testMode ? '?bandwidthtest=true' : ''}`;

    ffmpeg = spawn(FFMPEG, ffmpegArgs(msg, target), { stdio: ['pipe', 'ignore', 'pipe'] });
    broadcasting = ws;
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
  const sso = AUTH_HEADER ? `, sign-in: ${AUTH_HEADER}` : '';
  server.listen(PORT, HOST, () => console.log(`Stream Studio on http://${HOST}:${PORT}  (data: ${DATA}, video: ${VIDEO_MODE}${sso})`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { wss.clients.forEach((c) => c.close()); server.close(); process.exit(0); });
}

if (require.main === module) {
  if (process.argv[2] === 'passwd') setPassword().catch((e) => { console.error(e.message); process.exit(1); });
  else start();
}

module.exports = { ffmpegArgs };
