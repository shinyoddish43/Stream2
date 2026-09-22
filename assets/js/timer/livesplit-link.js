// Optional link to a real LiveSplit running on the runner's PC.
//
// LiveSplit's Server component speaks a line protocol over raw TCP, which a
// browser cannot open. bridge/livesplit-bridge.(js|py) is a ~100 line relay
// that exposes it as a WebSocket. Two modes are supported:
//
//   bridge — our own JSON protocol (state pushed at 30 Hz, commands accepted)
//   raw    — any TCP-to-WebSocket proxy: we speak LiveSplit Server text
//            commands directly and poll getcurrenttimerphase/getcurrenttime
//
// Everything degrades to the built-in timer if the link is not there.

import { bus, toast } from '../core/util.js';
import { PHASE } from './timer.js';

const RAW_POLL_MS = 100;

export class LiveSplitLink {
  constructor(timer) {
    this.timer = timer;
    this.ws = null;
    this.mode = 'off';
    this.url = '';
    this.state = 'off';          // off | connecting | on | err
    this.retry = 0;
    this.pollHandle = null;
    this.rawBuffer = '';
    this.pendingRaw = [];
    this.manualClose = false;
  }

  connect(url, mode = 'bridge') {
    this.disconnect(true);
    if (!url) return;
    this.url = url;
    this.mode = mode;
    this.manualClose = false;
    this.setState('connecting');
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.setState('err', e.message);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.setState('on');
      this.timer.external = true;
      if (this.mode === 'raw') this.startRawPolling();
      else this.send({ cmd: 'hello', client: 'stream-studio' });
      toast('LiveSplit connected', 'ok');
    });

    ws.addEventListener('message', (event) => {
      if (this.mode === 'raw') this.onRawMessage(String(event.data));
      else this.onBridgeMessage(String(event.data));
    });

    ws.addEventListener('error', () => this.setState('err', 'connection error'));

    ws.addEventListener('close', () => {
      this.stopRawPolling();
      if (this.manualClose) { this.setState('off'); return; }
      this.setState('err', 'disconnected');
      this.timer.releaseExternal();
      // Reconnect with a backoff so a closed LiveSplit does not spin the CPU.
      this.retry = Math.min(this.retry + 1, 6);
      const delay = Math.min(30000, 1000 * Math.pow(2, this.retry - 1));
      this.retryHandle = setTimeout(() => this.connect(this.url, this.mode), delay);
    });
  }

  disconnect(silent = false) {
    this.manualClose = true;
    clearTimeout(this.retryHandle);
    this.stopRawPolling();
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    if (this.timer.external) this.timer.releaseExternal();
    if (!silent) this.setState('off');
  }

  get connected() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  setState(state, detail) {
    this.state = state;
    bus.emit('livesplit:state', { state, detail, url: this.url, mode: this.mode });
  }

  send(obj) {
    if (!this.connected) return false;
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    return true;
  }

  // ---- our bridge's JSON protocol ----
  onBridgeMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.type === 'state') {
      this.timer.applyExternal({
        time: msg.time,
        phase: mapPhase(msg.phase),
        currentSplit: msg.currentSplit,
        splitTimes: msg.splitTimes,
      });
      if (msg.run && msg.run.segments && msg.runHash !== this.lastRunHash) {
        this.lastRunHash = msg.runHash;
        this.timer.run = Object.assign(this.timer.run, msg.run);
        bus.emit('timer:run', this.timer.run);
      }
    } else if (msg.type === 'error') {
      this.setState('err', msg.message);
    }
  }

  /** Forward a studio button press to LiveSplit so both stay in step. */
  command(name) {
    if (!this.connected) return false;
    if (this.mode === 'raw') {
      const map = {
        split: 'startorsplit', start: 'starttimer', undo: 'unsplit',
        skip: 'skipsplit', pause: 'pause', reset: 'reset',
      };
      const cmd = map[name];
      if (!cmd) return false;
      this.ws.send(cmd + '\r\n');
      return true;
    }
    return this.send({ cmd: name });
  }

  // ---- raw LiveSplit Server text protocol over a TCP proxy ----
  startRawPolling() {
    this.stopRawPolling();
    this.pollHandle = setInterval(() => {
      if (!this.connected) return;
      this.pendingRaw.push('phase');
      this.ws.send('getcurrenttimerphase\r\n');
      this.pendingRaw.push('time');
      this.ws.send('getcurrenttime\r\n');
      this.pendingRaw.push('index');
      this.ws.send('getsplitindex\r\n');
    }, RAW_POLL_MS);
  }

  stopRawPolling() {
    if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = null; }
    this.pendingRaw = [];
  }

  onRawMessage(chunk) {
    this.rawBuffer += chunk;
    let index;
    while ((index = this.rawBuffer.search(/\r?\n/)) >= 0) {
      const line = this.rawBuffer.slice(0, index).trim();
      this.rawBuffer = this.rawBuffer.slice(index + (this.rawBuffer[index] === '\r' ? 2 : 1));
      const kind = this.pendingRaw.shift();
      if (!line) continue;
      if (kind === 'phase') {
        this.timer.applyExternal({ phase: mapPhase(line) });
      } else if (kind === 'time') {
        const seconds = parseClock(line);
        if (seconds !== null) this.timer.applyExternal({ time: seconds });
      } else if (kind === 'index') {
        const i = parseInt(line, 10);
        if (!Number.isNaN(i)) this.timer.applyExternal({ currentSplit: Math.max(0, i) });
      }
    }
  }
}

function mapPhase(phase) {
  switch (String(phase || '').toLowerCase()) {
    case 'running': return PHASE.RUNNING;
    case 'paused': return PHASE.PAUSED;
    case 'ended': return PHASE.ENDED;
    case 'notrunning':
    default: return PHASE.IDLE;
  }
}

/** "00:01:23.45" -> 83.45 */
function parseClock(text) {
  const parts = String(text).trim().split(':');
  if (!parts.length) return null;
  let total = 0;
  for (const part of parts) {
    const n = parseFloat(part);
    if (Number.isNaN(n)) return null;
    total = total * 60 + n;
  }
  return total;
}
