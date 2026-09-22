// Source types and their runtimes.
//
// A "source" in the document is plain data (type, box, settings). A runtime is
// the live thing behind it: a <video> with a capture stream, a decoded image,
// or a pure-canvas painter like the timer. Runtimes are cached per source id
// and shared between the program and preview canvases, so a webcam is opened
// once no matter how many scenes use it.

import { bus, clamp, fmtClock, fmtTime, toast } from './util.js';

export const SOURCE_TYPES = {
  display: {
    label: 'Display / window capture',
    hint: 'Share a screen, a window, or a browser tab. The usual choice for gameplay.',
    defaults: { w: 1280, h: 720, settings: { cursor: 'motion', captureAudio: true, crop: null } },
    audio: true,
  },
  camera: {
    label: 'Webcam',
    hint: 'A camera device. Pick a small resolution on old hardware.',
    defaults: { w: 320, h: 240, settings: { deviceId: '', width: 640, height: 480, frameRate: 30, mirror: true } },
    audio: false,
  },
  timer: {
    label: 'Speedrun timer',
    hint: 'The built-in LiveSplit-style timer, drawn straight into the canvas. No browser source needed.',
    defaults: { w: 300, h: 420, settings: { bg: 'rgba(8,10,14,0.78)', accent: '#4a9eff', rows: 8, showTitle: true, showDeltas: true, showSob: true, font: 'system-ui' } },
  },
  text: {
    label: 'Text',
    hint: 'Static text or live tokens: {timer} {pb} {sob} {game} {category} {attempts} {split} {delta} {clock}.',
    defaults: { w: 480, h: 64, settings: { text: '{game} — {category}', size: 36, color: '#ffffff', font: 'system-ui', weight: '700', align: 'left', outline: 3, outlineColor: '#000000', bg: 'transparent' } },
  },
  image: {
    label: 'Image',
    hint: 'A PNG/JPG/GIF from a URL, or a file from this machine.',
    defaults: { w: 480, h: 270, settings: { url: '', fit: 'contain' } },
  },
  media: {
    label: 'Video / media file',
    hint: 'A video file or URL. Loops by default.',
    defaults: { w: 640, h: 360, settings: { url: '', loop: true, muted: false, volume: 1 } },
    audio: true,
  },
  color: {
    label: 'Colour / gradient',
    hint: 'A flat backdrop. Cheaper than an image and it never needs decoding.',
    defaults: { w: 1280, h: 720, settings: { color: '#101216', color2: '#1b1f27', gradient: false, radius: 0 } },
  },
  imagefeed: {
    label: 'Refreshing image',
    hint: 'Re-fetches an image URL on an interval — good for external alert/overlay renders without a browser source.',
    defaults: { w: 480, h: 120, settings: { url: '', interval: 5, fit: 'contain' } },
  },
};

const runtimes = new Map();

export function getRuntime(item) {
  let runtime = runtimes.get(item.id);
  if (runtime && runtime.type === item.type) { runtime.item = item; return runtime; }
  if (runtime) runtime.stop();
  runtime = createRuntime(item);
  runtimes.set(item.id, runtime);
  return runtime;
}

export function dropRuntime(id) {
  const runtime = runtimes.get(id);
  if (runtime) { runtime.stop(); runtimes.delete(id); }
}

export function allRuntimes() { return Array.from(runtimes.values()); }

export function stopAllRuntimes() {
  for (const runtime of runtimes.values()) runtime.stop();
  runtimes.clear();
}

function createRuntime(item) {
  switch (item.type) {
    case 'display': return new DisplayRuntime(item);
    case 'camera': return new CameraRuntime(item);
    case 'media': return new MediaRuntime(item);
    case 'image': return new ImageRuntime(item);
    case 'imagefeed': return new ImageFeedRuntime(item);
    case 'text': return new TextRuntime(item);
    case 'color': return new ColorRuntime(item);
    case 'timer': return new TimerRuntime(item);
    default: return new BaseRuntime(item);
  }
}

class BaseRuntime {
  constructor(item) {
    this.item = item;
    this.type = item.type;
    this.status = 'idle';   // idle | starting | ready | error
    this.error = '';
    this.stream = null;
  }
  get settings() { return this.item.settings || {}; }
  async start() { this.status = 'ready'; }
  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.status = 'idle';
  }
  /** Return a CanvasImageSource to blit, or null when the runtime paints itself. */
  frame() { return null; }
  /** Natural size, used by "fit to screen" and first placement. */
  naturalSize() { return null; }
  /** Custom painter for canvas-only sources. */
  paint() {}
  audioTracks() { return this.stream ? this.stream.getAudioTracks() : []; }
  fail(message) {
    this.status = 'error';
    this.error = message;
    bus.emit('source:error', { id: this.item.id, message });
  }
}

/** Shared plumbing for anything backed by a <video> element. */
class VideoRuntime extends BaseRuntime {
  constructor(item) {
    super(item);
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;         // audio is routed through the WebAudio mixer
    video.style.display = 'none';
    this.video = video;
  }
  frame() {
    return this.video.readyState >= 2 && this.video.videoWidth ? this.video : null;
  }
  naturalSize() {
    return this.video.videoWidth ? { w: this.video.videoWidth, h: this.video.videoHeight } : null;
  }
  stop() {
    try { this.video.pause(); } catch (e) {}
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    super.stop();
  }
  async attachStream(stream) {
    this.stream = stream;
    this.video.srcObject = stream;
    try { await this.video.play(); } catch (e) { /* autoplay policies; the frame still updates */ }
    this.status = 'ready';
    bus.emit('source:ready', this.item.id);
  }
}

class DisplayRuntime extends VideoRuntime {
  async start() {
    if (this.status === 'ready' || this.status === 'starting') return;
    this.status = 'starting';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return this.fail('This browser cannot capture a screen (needs HTTPS and a recent browser).');
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: this.settings.cursor || 'motion', frameRate: 60 },
        audio: this.settings.captureAudio !== false,
      });
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        this.status = 'idle';
        bus.emit('source:ended', this.item.id);
      });
      await this.attachStream(stream);
    } catch (e) {
      this.fail(e.name === 'NotAllowedError' ? 'Screen capture was cancelled.' : e.message);
    }
  }
}

class CameraRuntime extends VideoRuntime {
  async start() {
    if (this.status === 'ready' || this.status === 'starting') return;
    this.status = 'starting';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return this.fail('This browser cannot open a camera (needs HTTPS).');
    }
    const s = this.settings;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: s.deviceId ? { exact: s.deviceId } : undefined,
          width: { ideal: s.width || 640 },
          height: { ideal: s.height || 480 },
          frameRate: { ideal: s.frameRate || 30 },
        },
        audio: false,
      });
      await this.attachStream(stream);
    } catch (e) {
      this.fail(e.message || 'camera unavailable');
    }
  }
}

class MediaRuntime extends VideoRuntime {
  async start() {
    const url = this.settings.url || this.settings.objectUrl;
    if (!url) { this.status = 'idle'; return; }
    if (this.loadedUrl === url && this.status === 'ready') return;
    this.loadedUrl = url;
    this.video.src = url;
    this.video.loop = this.settings.loop !== false;
    this.video.muted = true;
    this.video.crossOrigin = 'anonymous';
    try {
      await this.video.play();
      this.status = 'ready';
    } catch (e) {
      // A muted video should always be allowed to play; if not, show the error.
      this.fail('could not play media: ' + (e.message || e.name));
    }
  }
}

class ImageRuntime extends BaseRuntime {
  async start() {
    const url = this.settings.url || this.settings.dataUrl;
    if (!url) { this.status = 'idle'; return; }
    if (this.loadedUrl === url && this.status === 'ready') return;
    this.loadedUrl = url;
    this.status = 'starting';
    await new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { this.img = img; this.status = 'ready'; resolve(); };
      img.onerror = () => { this.fail('could not load image'); resolve(); };
      img.src = url;
    });
  }
  frame() { return this.status === 'ready' ? this.img : null; }
  naturalSize() { return this.img ? { w: this.img.naturalWidth, h: this.img.naturalHeight } : null; }
  stop() { this.img = null; this.loadedUrl = null; super.stop(); }
}

class ImageFeedRuntime extends ImageRuntime {
  async start() {
    await super.start();
    clearInterval(this.pollHandle);
    const seconds = clamp(Number(this.settings.interval) || 5, 1, 3600);
    this.pollHandle = setInterval(() => {
      const url = this.settings.url;
      if (!url) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      // Cache-bust so the browser actually refetches the render.
      img.onload = () => { this.img = img; this.status = 'ready'; };
      img.src = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
    }, seconds * 1000);
  }
  stop() { clearInterval(this.pollHandle); super.stop(); }
}

class ColorRuntime extends BaseRuntime {
  paint(ctx, item) {
    const s = item.settings || {};
    const { x, y, w, h } = item;
    if (s.gradient) {
      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, s.color || '#101216');
      grad.addColorStop(1, s.color2 || '#000000');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = s.color || '#101216';
    }
    roundRect(ctx, x, y, w, h, Number(s.radius) || 0);
    ctx.fill();
  }
}

class TextRuntime extends BaseRuntime {
  paint(ctx, item, context) {
    const s = item.settings || {};
    const value = resolveTokens(s.text || '', context);
    const size = Number(s.size) || 32;
    ctx.save();
    ctx.beginPath();
    ctx.rect(item.x, item.y, item.w, item.h);
    ctx.clip();
    if (s.bg && s.bg !== 'transparent') {
      ctx.fillStyle = s.bg;
      ctx.fillRect(item.x, item.y, item.w, item.h);
    }
    ctx.font = `${s.weight || '700'} ${size}px ${s.font || 'system-ui'}, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = s.align || 'left';
    const lines = String(value).split('\n');
    const lineHeight = size * 1.18;
    let cursorX = item.x + 6;
    if (ctx.textAlign === 'center') cursorX = item.x + item.w / 2;
    if (ctx.textAlign === 'right') cursorX = item.x + item.w - 6;
    lines.forEach((line, i) => {
      const cursorY = item.y + 4 + i * lineHeight;
      if (Number(s.outline) > 0) {
        ctx.lineWidth = Number(s.outline);
        ctx.strokeStyle = s.outlineColor || '#000';
        ctx.lineJoin = 'round';
        ctx.strokeText(line, cursorX, cursorY);
      }
      ctx.fillStyle = s.color || '#fff';
      ctx.fillText(line, cursorX, cursorY);
    });
    ctx.restore();
  }
}

/**
 * The speedrun timer, painted directly into the program canvas.
 * This is the piece that replaces "add a browser source pointing at
 * LiveSplit One" — one less page to render, which matters on old hardware.
 */
class TimerRuntime extends BaseRuntime {
  paint(ctx, item, context) {
    const s = item.settings || {};
    const snap = context.timer;
    if (!snap) return;
    const { x, y, w, h } = item;
    const pad = 8;
    const font = s.font || 'system-ui';
    const accent = s.accent || '#4a9eff';

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, 6);
    ctx.clip();
    ctx.fillStyle = s.bg || 'rgba(8,10,14,0.78)';
    ctx.fillRect(x, y, w, h);

    let cursorY = y + pad;
    const titleH = s.showTitle === false ? 0 : 46;
    if (titleH) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.min(20, w / 14)}px ${font}, sans-serif`;
      ctx.fillText(trimTo(ctx, snap.game || '—', w - pad * 2), x + w / 2, cursorY);
      ctx.fillStyle = 'rgba(255,255,255,.66)';
      ctx.font = `400 ${Math.min(14, w / 20)}px ${font}, sans-serif`;
      ctx.fillText(trimTo(ctx, snap.category || '', w - pad * 2), x + w / 2, cursorY + 22);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.font = `400 ${Math.min(12, w / 24)}px ${font}, sans-serif`;
      ctx.fillText(String(snap.attempts || 0), x + w - pad, cursorY + 24);
      cursorY += titleH;
    }

    const clockH = 48;
    const infoH = s.showSob === false ? 0 : 34;
    const listH = Math.max(40, h - (cursorY - y) - clockH - infoH - pad);
    const rowH = 20;
    const visibleRows = Math.max(1, Math.min(Number(s.rows) || 8, Math.floor(listH / rowH)));
    const segments = snap.segments || [];
    // Window the list so the current split stays in view, LiveSplit style.
    let first = 0;
    if (segments.length > visibleRows) {
      first = clamp(snap.currentSplit - Math.floor(visibleRows / 2), 0, segments.length - visibleRows);
      if (snap.phase === 'ended' || snap.phase === 'idle') {
        first = clamp(segments.length - visibleRows, 0, segments.length - visibleRows);
      }
    }
    ctx.textBaseline = 'middle';
    for (let i = 0; i < visibleRows && first + i < segments.length; i++) {
      const seg = segments[first + i];
      const rowY = cursorY + i * rowH + rowH / 2;
      if (seg.current) {
        ctx.fillStyle = hexToRgba(accent, 0.22);
        ctx.fillRect(x, cursorY + i * rowH, w, rowH);
      }
      ctx.font = `500 ${Math.min(13, w / 22)}px ${font}, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = seg.done ? 'rgba(255,255,255,.72)' : '#fff';
      ctx.fillText(trimTo(ctx, seg.name, w * 0.52), x + pad, rowY);
      ctx.textAlign = 'right';
      if (s.showDeltas !== false && seg.delta !== null && seg.delta !== undefined) {
        ctx.fillStyle = deltaColor(seg.deltaClass);
        ctx.font = `600 ${Math.min(12, w / 24)}px ${font}, monospace`;
        ctx.fillText(fmtTime(seg.delta, { decimals: Math.abs(seg.delta) < 60 ? 1 : 0, forceSign: true }), x + w - pad - 62, rowY);
      }
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.font = `500 ${Math.min(12, w / 24)}px ${font}, monospace`;
      const shown = seg.time ?? seg.compare;
      ctx.fillText(shown === null || shown === undefined ? '—' : fmtTime(shown, { decimals: 0 }), x + w - pad, rowY);
    }
    cursorY += listH;

    // Big clock
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = clockColor(snap.clockClass);
    const clockSize = Math.min(38, w / 6.4);
    ctx.font = `700 ${clockSize}px ${font}, monospace`;
    ctx.fillText(fmtClock(snap.time, snap.time >= 3600 ? 1 : 2), x + w - pad, cursorY + clockSize);
    cursorY += clockH;

    if (infoH) {
      ctx.font = `400 ${Math.min(11, w / 26)}px ${font}, sans-serif`;
      const rows = [
        ['Previous segment', snap.previousSegment === null || snap.previousSegment === undefined
          ? '—' : fmtTime(snap.previousSegment, { decimals: 1, forceSign: true })],
        ['Sum of best', snap.sumOfBest === null ? '—' : fmtTime(snap.sumOfBest, { decimals: 0 })],
      ];
      rows.forEach(([label, value], i) => {
        const rowY = cursorY + 12 + i * 14;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.fillText(label, x + pad, rowY);
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.fillText(value, x + w - pad, rowY);
      });
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- helpers

export function resolveTokens(text, context) {
  const snap = context.timer || {};
  const current = (snap.segments || [])[snap.currentSplit] || {};
  const map = {
    timer: fmtClock(snap.time || 0),
    pb: snap.pb === null || snap.pb === undefined ? '—' : fmtTime(snap.pb, { decimals: 0 }),
    sob: snap.sumOfBest === null || snap.sumOfBest === undefined ? '—' : fmtTime(snap.sumOfBest, { decimals: 0 }),
    bpt: snap.bestPossible === null || snap.bestPossible === undefined ? '—' : fmtTime(snap.bestPossible, { decimals: 0 }),
    game: snap.game || '',
    category: snap.category || '',
    attempts: String(snap.attempts || 0),
    split: current.name || '',
    delta: snap.previousSegment === null || snap.previousSegment === undefined
      ? '' : fmtTime(snap.previousSegment, { decimals: 1, forceSign: true }),
    clock: new Date().toLocaleTimeString(),
    date: new Date().toLocaleDateString(),
  };
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in map ? map[key] : match));
}

function deltaColor(cls) {
  switch (cls) {
    case 'd-ahead': return '#4ce0a0';
    case 'd-ahead-loss': return '#2d9c6f';
    case 'd-behind': return '#e06060';
    case 'd-behind-gain': return '#e09a4c';
    case 'd-gold': return '#d8af3c';
    default: return 'rgba(255,255,255,.7)';
  }
}

function clockColor(cls) {
  switch (cls) {
    case 'behind': return '#e06060';
    case 'gold': return '#d8af3c';
    case 'paused': return '#8b93a1';
    case 'running': return '#4ce0a0';
    default: return '#ffffff';
  }
}

function trimTo(ctx, text, maxWidth) {
  let value = String(text || '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  while (value.length > 1 && ctx.measureText(value + '…').width > maxWidth) value = value.slice(0, -1);
  return value + '…';
}

export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  if (!radius) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  if (!m) return `rgba(74,158,255,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/** Create a document item for a new source of the given type. */
export function makeSource(type, name, canvas) {
  const spec = SOURCE_TYPES[type];
  const defaults = (spec && spec.defaults) || { w: 640, h: 360, settings: {} };
  const w = defaults.w;
  const h = defaults.h;
  return {
    id: 'sr_' + Math.random().toString(36).slice(2, 9),
    type,
    name: name || (spec ? spec.label : type),
    visible: true,
    locked: false,
    opacity: 1,
    x: Math.round(((canvas ? canvas.w : 1280) - w) / 2),
    y: Math.round(((canvas ? canvas.h : 720) - h) / 2),
    w,
    h,
    settings: JSON.parse(JSON.stringify(defaults.settings || {})),
  };
}
