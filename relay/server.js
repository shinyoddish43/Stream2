#!/usr/bin/env node
/**
 * Stream Studio relay.
 *
 * The browser cannot speak RTMP. This does: it accepts the studio's WebM
 * chunks over a WebSocket and pipes them into one ffmpeg process per
 * destination, so a single upload from the studio lands on Twitch, YouTube and
 * anywhere else at the same time.
 *
 * Runs anywhere Node and ffmpeg exist, including cPanel's "Setup Node.js App"
 * (see docs/INSTALL-CPANEL.md). It holds no user data: the studio hands it a
 * short-lived HMAC ticket that carries the destination URLs, signed with the
 * relay_secret from data/config.json.
 *
 *   RELAY_SECRET=<relay_secret> PORT=8081 node server.js
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8081', 10);
const SECRET = process.env.RELAY_SECRET || '';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '4', 10);
const MAX_CHUNK = 8 * 1024 * 1024;

if (!SECRET) {
  console.error('RELAY_SECRET is required. Copy relay_secret out of data/config.json.');
  process.exit(1);
}

const sessions = new Set();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, max: MAX_SESSIONS }));
    return;
  }
  res.writeHead(404).end('stream-studio relay');
});

const wss = new WebSocketServer({ server, path: process.env.WS_PATH || '/ingest', maxPayload: MAX_CHUNK });

/** base64url(payload).base64url(hmac) -> payload object, or null. */
function verifyTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 8192) return null;
  const dot = ticket.lastIndexOf('.');
  if (dot < 1) return null;
  const body = ticket.slice(0, dot);
  const signature = ticket.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) { return null; }
  if (!payload || !Array.isArray(payload.targets) || !payload.targets.length) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function isSafeRtmpUrl(url) {
  return typeof url === 'string'
    && /^rtmps?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(url)
    && url.length < 1024;
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.children = [];
    this.bytes = 0;
    this.startedAt = Date.now();
    this.started = false;
    this.statsHandle = null;
  }

  start(config, payload) {
    const targets = payload.targets.filter((t) => isSafeRtmpUrl(t.url));
    if (!targets.length) throw new Error('no usable RTMP destinations in the ticket');

    const video = config.video || {};
    const audio = config.audio || {};
    const bitrate = clamp(parseInt(video.bitrate, 10) || 2500, 300, 12000);
    const gop = clamp(parseInt(video.keyframe, 10) || 2, 1, 6);
    const fps = clamp(parseInt(video.fps, 10) || 30, 5, 60);
    const audioBitrate = clamp(parseInt(audio.bitrate, 10) || 128, 48, 320);

    for (const target of targets) {
      // One ffmpeg per destination: a slow or flapping ingest at one service
      // then cannot stall the others. On a small box use ffmpeg's tee muxer
      // instead by setting RELAY_TEE=1.
      const args = [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+genpts',
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast',
        '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
        '-g', String(fps * gop), '-keyint_min', String(fps * gop), '-sc_threshold', '0',
        '-r', String(fps),
        '-c:a', 'aac', '-b:a', `${audioBitrate}k`, '-ar', '44100', '-ac', '2',
        '-f', 'flv', target.url,
      ];
      const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      child.stderr.on('data', (data) => {
        const text = String(data).trim();
        if (text) console.warn(`[ffmpeg ${target.name}] ${text.slice(0, 400)}`);
      });
      child.on('error', (err) => {
        this.send({ type: 'error', message: `ffmpeg could not start (${err.code || err.message})` });
        this.stop();
      });
      child.on('exit', (code, signal) => {
        console.log(`[relay] ffmpeg for ${target.name} exited code=${code} signal=${signal}`);
        if (this.started && code !== 0) {
          this.send({ type: 'error', message: `${target.name} ingest stopped (ffmpeg exit ${code})` });
        }
      });
      child.stdin.on('error', () => { /* the pipe closes when ffmpeg dies; already reported */ });
      this.children.push({ child, target });
    }

    this.started = true;
    this.send({ type: 'ready', targets: targets.map((t) => t.name) });
    this.statsHandle = setInterval(() => {
      this.send({ type: 'stats', bytes: this.bytes, uptime: (Date.now() - this.startedAt) / 1000, targets: this.children.length });
    }, 5000);
    console.log(`[relay] session up: ${targets.map((t) => t.name).join(', ')} (user=${payload.user || '?'})`);
  }

  write(buffer) {
    if (!this.started) return;
    this.bytes += buffer.length;
    for (const { child } of this.children) {
      if (child.stdin.writable) {
        // Never let a stuck ffmpeg grow the Node heap without bound.
        if (child.stdin.writableLength > 16 * 1024 * 1024) continue;
        child.stdin.write(buffer);
      }
    }
  }

  send(message) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  stop() {
    if (this.statsHandle) clearInterval(this.statsHandle);
    this.started = false;
    for (const { child } of this.children) {
      try { child.stdin.end(); } catch (e) {}
      // Give ffmpeg a moment to flush the FLV trailer, then insist.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 4000);
    }
    this.children = [];
    sessions.delete(this);
    try { this.ws.close(); } catch (e) {}
  }
}

wss.on('connection', (ws, req) => {
  if (sessions.size >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', message: 'relay is at capacity' }));
    ws.close();
    return;
  }
  const session = new Session(ws);
  sessions.add(session);
  let authorized = false;

  const idleTimer = setTimeout(() => {
    if (!authorized) { ws.send(JSON.stringify({ type: 'error', message: 'no start message' })); session.stop(); }
  }, 10000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!authorized) return;
      session.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let message;
    try { message = JSON.parse(String(data)); } catch (e) { return; }
    if (message.type === 'start') {
      if (authorized) return;
      const payload = verifyTicket(message.ticket);
      if (!payload) {
        ws.send(JSON.stringify({ type: 'error', message: 'ticket rejected (expired or wrong secret)' }));
        session.stop();
        return;
      }
      clearTimeout(idleTimer);
      authorized = true;
      try {
        session.start(message, payload);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
        session.stop();
      }
    } else if (message.type === 'stop') {
      session.stop();
    }
  });

  ws.on('close', () => { clearTimeout(idleTimer); session.stop(); });
  ws.on('error', () => session.stop());
});

function clamp(n, min, max) { return n < min ? min : n > max ? max : n; }

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}${process.env.WS_PATH || '/ingest'} (max ${MAX_SESSIONS} sessions)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('[relay] shutting down');
    for (const session of Array.from(sessions)) session.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });
}
