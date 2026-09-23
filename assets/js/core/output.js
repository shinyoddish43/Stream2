// Outputs: local recording, WHIP (WebRTC ingest), and the RTMP relay.
//
// The browser cannot speak RTMP — nothing in a page can. So there are three
// honest paths out of here, and the UI says which is which:
//
//   record  MediaRecorder writes a .webm (or .mp4 where supported) to disk.
//           Works everywhere, needs no server at all.
//   whip    Standard WebRTC-HTTP ingest. Cloudflare Stream, Dolby, OBS-ng,
//           any WHIP endpoint. Lowest latency, single destination.
//   relay   MediaRecorder chunks over a WebSocket to relay/server.js, which
//           runs one ffmpeg per destination and fans out to Twitch/YouTube/
//           Kick at once. This is the "restream" path.

import { bus, toast, download, fmtBytes } from './util.js';

const CANDIDATE_TYPES = [
  'video/webm;codecs=vp8,opus',       // cheapest to encode: first choice on old CPUs
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
];

export function pickMimeType(preferred) {
  if (typeof MediaRecorder === 'undefined') return '';
  const list = preferred ? [preferred].concat(CANDIDATE_TYPES) : CANDIDATE_TYPES;
  for (const type of list) {
    if (type && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export class OutputManager {
  constructor(compositor, mixer, store) {
    this.compositor = compositor;
    this.mixer = mixer;
    this.store = store;
    this.fileRecorder = null;    // writes a file for the user
    this.relayRecorder = null;   // feeds the relay socket
    this.recording = false;
    this.streaming = false;
    this.chunks = [];
    this.bytes = 0;
    this.startedAt = 0;
    this.pc = null;
    this.ws = null;
    this.resourceUrl = '';
    this.lastBitrateAt = 0;
    this.lastBitrateBytes = 0;
    this.bitrate = 0;
    this.statsHandle = null;
    this.getTicket = null;
    this.reconnectAttempt = 0;
    this.reconnectHandle = null;
    this.reconnecting = false;
    this.maxReconnects = 8;
  }

  /** Canvas video + mixed audio, the stream every output consumes. */
  buildStream() {
    const doc = this.store.get();
    const stream = this.compositor.captureStream(doc.canvas.fps);
    const audioTrack = this.mixer.outputTrack;
    if (audioTrack) stream.addTrack(audioTrack);
    return stream;
  }

  // ------------------------------------------------------------- recording

  /**
   * Ask for a file handle up front where the browser supports it, so chunks
   * go straight to disk. A two-hour stream is several gigabytes; holding that
   * in a Blob array is exactly how a 4 GB laptop dies mid-run.
   */
  async openRecordingFile(mimeType) {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    const doc = this.store.get();
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${doc.output.recordName || 'stream'}-${stamp}.${extension}`,
        types: [{ description: 'Video', accept: { [mimeType.split(';')[0]]: ['.' + extension] } }],
      });
      return await handle.createWritable();
    } catch (e) {
      // The picker was dismissed, or the host blocks it: fall back to memory.
      if (e.name !== 'AbortError') console.warn('[output] save picker unavailable', e);
      return null;
    }
  }

  async startRecording() {
    if (this.recording) return;
    const doc = this.store.get();
    const stream = this.buildStream();
    const mimeType = pickMimeType(doc.output.container === 'auto' ? '' : doc.output.container);
    if (!mimeType) { toast('This browser cannot record video (no MediaRecorder support).', 'err'); return; }
    this.chunks = [];
    this.bytes = 0;
    this.writer = doc.output.streamToDisk === false ? null : await this.openRecordingFile(mimeType);
    this.writeQueue = Promise.resolve();
    this.warnedMemory = false;
    try {
      this.fileRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: (doc.output.bitrate || 2500) * 1000,
        audioBitsPerSecond: (doc.output.audioBitrate || 128) * 1000,
      });
    } catch (e) {
      toast('Recorder refused those settings: ' + e.message, 'err');
      return;
    }
    this.fileRecorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      this.bytes += event.data.size;
      this.tickBitrate(event.data.size);
      if (this.writer) {
        // Serialise the writes: FileSystemWritableFileStream rejects
        // overlapping write() calls.
        this.writeQueue = this.writeQueue
          .then(() => this.writer.write(event.data))
          .catch((e) => { toast('Write to disk failed: ' + e.message, 'err'); });
        return;
      }
      this.chunks.push(event.data);
      if (!this.warnedMemory && this.bytes > 512 * 1024 * 1024) {
        this.warnedMemory = true;
        toast('Recording is over 512 MB in memory. Stop and save soon, or use a browser that supports saving straight to disk.', 'err');
      }
    };
    this.fileRecorder.onstop = () => this.finishRecording(mimeType);
    this.fileRecorder.onerror = (event) => toast('Recorder error: ' + (event.error && event.error.name), 'err');
    this.fileRecorder.start(1000);
    this.recording = true;
    this.startedAt = Date.now();
    bus.emit('output:state', this.state());
    toast('Recording started', 'ok');
  }

  stopRecording() {
    if (!this.recording || !this.fileRecorder) return;
    this.recording = false;
    try { this.fileRecorder.stop(); } catch (e) {}
    bus.emit('output:state', this.state());
  }

  async finishRecording(mimeType) {
    if (this.writer) {
      const writer = this.writer;
      this.writer = null;
      try {
        await this.writeQueue;
        await writer.close();
        toast(`Recording saved (${fmtBytes(this.bytes)})`, 'ok');
      } catch (e) {
        toast('Could not close the recording file: ' + e.message, 'err');
      }
      this.fileRecorder = null;
      return;
    }
    if (!this.chunks.length) { this.fileRecorder = null; return; }
    const doc = this.store.get();
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob(this.chunks, { type: mimeType });
    download(`${doc.output.recordName || 'stream'}-${stamp}.${extension}`, blob, mimeType);
    toast(`Recording saved (${fmtBytes(blob.size)})`, 'ok');
    this.chunks = [];
    this.fileRecorder = null;
  }

  // ------------------------------------------------------------------ WHIP
  async startWhip() {
    const doc = this.store.get();
    const url = (doc.output.whipUrl || '').trim();
    if (!url) { toast('Set a WHIP endpoint in Settings → Output first.', 'err'); return; }
    const stream = this.buildStream();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc = pc;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.addEventListener('connectionstatechange', () => {
      bus.emit('output:state', this.state());
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        toast('WHIP connection ' + pc.connectionState, 'err');
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc, 2500);
    const headers = { 'Content-Type': 'application/sdp' };
    if (doc.output.whipToken) headers.Authorization = 'Bearer ' + doc.output.whipToken;
    const res = await fetch(url, { method: 'POST', headers, body: pc.localDescription.sdp });
    if (!res.ok) throw new Error(`WHIP endpoint said ${res.status}`);
    this.resourceUrl = res.headers.get('Location') || '';
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    this.startStats();
  }

  async stopWhip() {
    this.stopStats();
    if (this.resourceUrl) {
      const absolute = new URL(this.resourceUrl, this.store.get().output.whipUrl).href;
      fetch(absolute, { method: 'DELETE' }).catch(() => {});
      this.resourceUrl = '';
    }
    if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
  }

  // ----------------------------------------------------------------- relay
  async startRelay(ticket, relayUrl) {
    const doc = this.store.get();
    const stream = this.buildStream();
    const mimeType = pickMimeType('video/webm;codecs=vp8,opus');
    if (!mimeType) throw new Error('this browser cannot encode video');
    const ws = new WebSocket(relayUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('relay did not answer in 8s')), 8000);
      ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('could not reach the relay')); });
    });

    ws.send(JSON.stringify({
      type: 'start',
      ticket,
      mimeType,
      video: { width: doc.canvas.w, height: doc.canvas.h, fps: doc.canvas.fps, bitrate: doc.output.bitrate, keyframe: doc.output.keyframe },
      audio: { bitrate: doc.output.audioBitrate },
    }));

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch (e) { return; }
      if (msg.type === 'error') { toast('Relay: ' + msg.message, 'err'); this.stopStream(); }
      else if (msg.type === 'ready') toast('Relay is live on ' + (msg.targets || []).join(', '), 'ok');
      else if (msg.type === 'stats') bus.emit('relay:stats', msg);
    });
    ws.addEventListener('close', () => {
      // A dropped relay mid-stream is a network blip, not the end of the
      // broadcast. Rebuild the session rather than dumping the streamer off
      // air and making them notice.
      if (this.streaming && this.ws === ws) this.scheduleReconnect();
    });

    this.relayRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: (doc.output.bitrate || 2500) * 1000,
      audioBitsPerSecond: (doc.output.audioBitrate || 128) * 1000,
    });
    this.relayRecorder.ondataavailable = async (event) => {
      if (!event.data || !event.data.size || ws.readyState !== WebSocket.OPEN) return;
      // Backpressure: if the socket is congested, drop the chunk rather than
      // buffering the browser into a swap death spiral.
      if (ws.bufferedAmount > 4 * 1024 * 1024) { bus.emit('relay:congested', ws.bufferedAmount); return; }
      ws.send(await event.data.arrayBuffer());
      this.tickBitrate(event.data.size);
    };
    // 250 ms chunks keep glass-to-glass latency reasonable without flooding
    // the socket with tiny frames.
    this.relayRecorder.start(250);
  }

  /**
   * Rebuild a dropped relay session: fresh ticket, fresh socket, fresh
   * recorder. The recorder has to restart because each ffmpeg on the other
   * side needs a WebM header, and the old one went with the old process.
   */
  scheduleReconnect() {
    if (!this.streaming || this.reconnectHandle) return;
    if (this.reconnectAttempt >= this.maxReconnects) {
      toast('Relay is unreachable after several tries — going offline.', 'err');
      this.stopStream();
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempt++;
    this.teardownRelaySockets();
    const delay = Math.min(10000, 1000 * Math.pow(2, this.reconnectAttempt - 1));
    toast(`Relay dropped — reconnecting in ${Math.round(delay / 1000)}s (try ${this.reconnectAttempt})`, 'err');
    bus.emit('output:state', this.state());
    this.reconnectHandle = setTimeout(async () => {
      this.reconnectHandle = null;
      if (!this.streaming) return;
      try {
        const { ticket, relay } = await this.getTicket();
        await this.startRelay(ticket, relay);
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        toast('Back on the relay', 'ok');
        bus.emit('output:state', this.state());
      } catch (e) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Drop the socket and recorder without ending the broadcast. */
  teardownRelaySockets() {
    if (this.relayRecorder) {
      try { this.relayRecorder.ondataavailable = null; this.relayRecorder.stop(); } catch (e) {}
      this.relayRecorder = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }

  stopRelay() {
    clearTimeout(this.reconnectHandle);
    this.reconnectHandle = null;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    if (this.relayRecorder) { try { this.relayRecorder.stop(); } catch (e) {} this.relayRecorder = null; }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop' }));
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  }

  // ---------------------------------------------------------------- driving
  async startStream(getTicket) {
    if (this.streaming) return;
    const doc = this.store.get();
    this.streaming = true;
    this.startedAt = Date.now();
    bus.emit('output:state', this.state());
    try {
      if (doc.output.mode === 'whip') {
        await this.startWhip();
      } else if (doc.output.mode === 'relay') {
        this.getTicket = getTicket;
        this.reconnectAttempt = 0;
        const { ticket, relay } = await getTicket();
        await this.startRelay(ticket, relay);
      } else {
        await this.startRecording();
      }
      bus.emit('output:state', this.state());
    } catch (e) {
      this.streaming = false;
      bus.emit('output:state', this.state());
      toast('Could not go live: ' + e.message, 'err');
      throw e;
    }
  }

  async stopStream() {
    if (!this.streaming) return;
    this.streaming = false;
    const mode = this.store.get().output.mode;
    if (mode === 'whip') await this.stopWhip();
    else if (mode === 'relay') this.stopRelay();
    else this.stopRecording();   // in record mode the stream *is* the recording
    this.stopStats();
    bus.emit('output:state', this.state());
  }

  tickBitrate(bytes) {
    const now = performance.now();
    this.lastBitrateBytes += bytes;
    if (now - this.lastBitrateAt >= 1000) {
      const seconds = (now - this.lastBitrateAt) / 1000;
      this.bitrate = Math.round((this.lastBitrateBytes * 8) / 1000 / seconds);
      this.lastBitrateAt = now;
      this.lastBitrateBytes = 0;
      bus.emit('output:bitrate', this.bitrate);
    }
  }

  startStats() {
    this.stopStats();
    this.statsHandle = setInterval(async () => {
      if (!this.pc) return;
      const stats = await this.pc.getStats();
      let bytes = 0;
      stats.forEach((report) => {
        if (report.type === 'outbound-rtp' && !report.isRemote) bytes += report.bytesSent || 0;
      });
      if (this.prevBytes !== undefined) {
        this.bitrate = Math.round(((bytes - this.prevBytes) * 8) / 1000);
        bus.emit('output:bitrate', this.bitrate);
      }
      this.prevBytes = bytes;
    }, 1000);
  }

  stopStats() {
    if (this.statsHandle) { clearInterval(this.statsHandle); this.statsHandle = null; }
    this.prevBytes = undefined;
  }

  state() {
    return {
      recording: this.recording,
      streaming: this.streaming,
      reconnecting: this.reconnecting,
      mode: this.store.get().output.mode,
      bitrate: this.bitrate,
      uptime: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
      bytes: this.bytes,
    };
  }
}

function waitForIce(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(timer); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, timeoutMs);   // trickle-less servers still work
    pc.addEventListener('icegatheringstatechange', check);
  });
}
