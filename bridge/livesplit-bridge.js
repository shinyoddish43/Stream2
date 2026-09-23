#!/usr/bin/env node
/**
 * LiveSplit bridge (Node).
 *
 * LiveSplit's Server component listens on TCP 16834 and speaks a line
 * protocol. A browser cannot open a TCP socket, so this sits in between:
 * it polls LiveSplit and pushes state to the studio over WebSocket 16835,
 * and forwards split/reset commands back the other way.
 *
 * Run it on the machine LiveSplit is on:
 *   npm install ws && node livesplit-bridge.js
 *
 * No dependencies beyond `ws`. If you would rather not install anything,
 * use livesplit_bridge.py — it needs only the Python standard library.
 */

'use strict';

const net = require('net');
const http = require('http');
const { WebSocketServer } = require('ws');

const LIVESPLIT_HOST = process.env.LIVESPLIT_HOST || '127.0.0.1';
const LIVESPLIT_PORT = parseInt(process.env.LIVESPLIT_PORT || '16834', 10);
const LISTEN_PORT = parseInt(process.env.BRIDGE_PORT || '16835', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '33', 10);   // ~30 Hz

let socket = null;
let connected = false;
let queue = [];
let buffer = '';
const clients = new Set();

const state = { phase: 'idle', time: 0, currentSplit: 0, splitTimes: [] };

function connectLiveSplit() {
  socket = net.connect(LIVESPLIT_PORT, LIVESPLIT_HOST);
  socket.setEncoding('utf8');
  socket.setNoDelay(true);

  socket.on('connect', () => {
    connected = true;
    console.log(`[bridge] connected to LiveSplit at ${LIVESPLIT_HOST}:${LIVESPLIT_PORT}`);
    broadcast({ type: 'link', connected: true });
  });

  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      const want = queue.shift();
      if (!want) continue;
      if (want === 'phase') state.phase = mapPhase(line);
      else if (want === 'time') { const t = parseClock(line); if (t !== null) state.time = t; }
      else if (want === 'index') { const i = parseInt(line, 10); if (!Number.isNaN(i)) state.currentSplit = Math.max(0, i); }
    }
  });

  const retry = () => {
    if (connected) console.log('[bridge] lost LiveSplit, retrying…');
    connected = false;
    queue = [];
    buffer = '';
    broadcast({ type: 'link', connected: false });
    setTimeout(connectLiveSplit, 2000);
  };
  socket.on('error', () => {});
  socket.on('close', retry);
}

function ask(command, tag) {
  if (!connected) return;
  queue.push(tag);
  socket.write(command + '\r\n');
}

let outstandingSince = 0;

setInterval(() => {
  if (!connected || !clients.size) return;
  // Never overlap batches. Replies are matched to requests by position, so a
  // second batch sent before the first was answered would shift every later
  // answer onto the wrong field — a clock read as a phase.
  if (queue.length) {
    if (!outstandingSince) outstandingSince = Date.now();
    // A reply that never comes would wedge the bridge, so start clean.
    if (Date.now() - outstandingSince > 2000) {
      console.warn('[bridge] LiveSplit stopped answering; resetting the queue');
      queue = [];
      buffer = '';
      outstandingSince = 0;
    }
    return;
  }
  outstandingSince = 0;
  ask('getcurrenttimerphase', 'phase');
  ask('getcurrenttime', 'time');
  ask('getsplitindex', 'index');
  broadcast({ type: 'state', phase: state.phase, time: state.time, currentSplit: state.currentSplit });
}, POLL_MS);

function broadcast(message) {
  const text = JSON.stringify(message);
  for (const client of clients) if (client.readyState === 1) client.send(text);
}

const COMMANDS = {
  split: 'startorsplit', start: 'starttimer', undo: 'unsplit',
  skip: 'skipsplit', pause: 'pause', resume: 'resume', reset: 'reset',
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, livesplit: connected, clients: clients.size, state }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Loopback-only by default: this exposes control of your timer.
  const address = req.socket.remoteAddress || '';
  if (process.env.ALLOW_REMOTE !== '1' && !/^(::1|::ffff:127\.|127\.)/.test(address)) {
    ws.send(JSON.stringify({ type: 'error', message: 'remote clients are disabled (set ALLOW_REMOTE=1)' }));
    ws.close();
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'link', connected }));
  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(String(data)); } catch (e) { return; }
    const command = COMMANDS[message.cmd];
    if (command && connected) socket.write(command + '\r\n');
  });
  ws.on('close', () => clients.delete(ws));
});

function mapPhase(text) {
  switch (String(text).trim().toLowerCase()) {
    case 'running': return 'running';
    case 'paused': return 'paused';
    case 'ended': return 'ended';
    default: return 'idle';
  }
}

function parseClock(text) {
  const parts = String(text).trim().split(':');
  let total = 0;
  for (const part of parts) {
    const n = parseFloat(part);
    if (Number.isNaN(n)) return null;
    total = total * 60 + n;
  }
  return total;
}

server.listen(LISTEN_PORT, process.env.BIND || '127.0.0.1', () => {
  console.log(`[bridge] websocket on ws://127.0.0.1:${LISTEN_PORT} — point the studio here`);
  connectLiveSplit();
});
