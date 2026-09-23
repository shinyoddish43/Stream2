// Going live: the browser encodes the canvas and the mixed audio, and sends
// it over a WebSocket to the server, which hands it to ffmpeg and on to Twitch.

const TYPES = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export class Streamer {
  constructor({ canvas, mixer, onStatus }) {
    this.canvas = canvas;
    this.mixer = mixer;
    this.onStatus = onStatus;         // ({ state, message, kbps, seconds })
    this.live = false;
    this.retries = 0;
  }

  async start(output) {
    if (this.live) return;
    this.live = true;
    this.output = output;
    this.retries = 0;
    await this.connect();
  }

  async connect() {
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return this.fail('This browser cannot encode video. Use Chrome, Edge or Firefox.');
    this.onStatus({ state: 'connecting', message: this.retries ? `Reconnecting (try ${this.retries})…` : 'Connecting…' });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`);
    this.ws = ws;
    let sentBytes = 0;
    let lastBytes = 0;
    let lastAt = performance.now();

    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', mimeType, ...this.output }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ready') {
        this.retries = 0;
        this.record(ws, mimeType, (n) => { sentBytes += n; });
        this.onStatus({ state: 'live', message: msg.testMode ? 'LIVE (bandwidth test)' : 'LIVE' });
      } else if (msg.type === 'stats') {
        const now = performance.now();
        const kbps = Math.round(((sentBytes - lastBytes) * 8) / (now - lastAt));
        lastBytes = sentBytes;
        lastAt = now;
        this.onStatus({ state: 'live', kbps, seconds: msg.seconds, backlog: ws.bufferedAmount });
      } else if (msg.type === 'error') {
        this.fail(msg.message);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopRecorder();
      if (!this.live) return;
      // A dropped connection from home is usually a blip: rebuild the session.
      if (this.retries < 5) {
        this.retries++;
        setTimeout(() => { if (this.live) this.connect(); }, 1000 * 2 ** (this.retries - 1));
      } else {
        this.fail('Lost the connection to the server.');
      }
    };
  }

  record(ws, mimeType, count) {
    const video = this.canvas.captureStream(this.output.fps).getVideoTracks()[0];
    // Upload a little above the Twitch bitrate: the server re-encodes, and a
    // cleaner input survives that better.
    const upload = Math.min(12000, Math.round(this.output.bitrate * 1.25));
    this.recorder = new MediaRecorder(new MediaStream([video, this.mixer.track]), {
      mimeType, videoBitsPerSecond: upload * 1000, audioBitsPerSecond: 160000,
      // A keyframe every two seconds, which Twitch needs if the server passes
      // the video through untouched (VIDEO_MODE=copy). Ignored where unsupported.
      videoKeyFrameIntervalDuration: 2000,
    });
    this.recorder.ondataavailable = (e) => {
      if (!e.data.size || ws.readyState !== WebSocket.OPEN) return;
      // Never drop a chunk (it would corrupt the stream), but give up if the
      // upload is hopelessly behind rather than eating all memory.
      if (ws.bufferedAmount > 48 * 1024 * 1024) { this.fail('Your upload cannot keep up. Lower the bitrate in Settings.'); return; }
      ws.send(e.data);
      count(e.data.size);
    };
    this.recorder.start(250);
  }

  stopRecorder() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
  }

  stop() {
    this.live = false;
    this.stopRecorder();
    if (this.ws) {
      try { this.ws.send(JSON.stringify({ type: 'stop' })); } catch { /* closing */ }
      this.ws.close();
    }
    this.ws = null;
    this.onStatus({ state: 'offline', message: 'Offline' });
  }

  fail(message) {
    this.stop();
    this.onStatus({ state: 'error', message });
  }
}
