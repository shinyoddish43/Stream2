// The compositor: draws the active layout into the stream canvas, keys the
// green screen, and handles selecting, moving and resizing sources on a
// separate overlay canvas that never goes out on stream.

import { drawTimer } from './timer.js';

export const feedKey = (src) => (src.type === 'screen' ? 'screen' : `cam:${src.deviceId || 'default'}:${src.resolution || '1080p'}`);

const RESOLUTIONS = { '720p': [1280, 720], '1080p': [1920, 1080] };

/** A live video: a webcam, a USB/HDMI capture card, or a screen share. */
class Feed {
  constructor(key) {
    this.key = key;
    this.video = document.createElement('video');
    this.video.muted = true;          // sound goes through the mixer instead
    this.video.playsInline = true;
    this.stream = null;
    this.status = 'idle';             // idle | opening | live | ended | error
    this.error = '';
  }

  get ready() { return this.status === 'live' && this.video.readyState >= 2 && this.video.videoWidth > 0; }

  async open(getStream) {
    this.status = 'opening';
    try {
      this.stream = await getStream();
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
      this.status = 'live';
      this.stream.getVideoTracks()[0].addEventListener('ended', () => { this.status = 'ended'; });
    } catch (e) {
      this.status = 'error';
      this.error = e.name === 'NotAllowedError' ? 'Permission was refused.' : e.message || String(e);
    }
    return this;
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.stream = null;
    this.status = 'idle';
  }
}

export function openCamera(deviceId, resolution) {
  const [width, height] = RESOLUTIONS[resolution] || RESOLUTIONS['1080p'];
  return navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 60 },
    },
    audio: false,
  });
}

export function openScreen() {
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: true });
}

/**
 * Green screen, on the GPU. Alpha comes from the distance to the key colour in
 * the CbCr (colour, not brightness) plane, measured relative to how saturated
 * the key itself is: 0 is the key colour, 1 is grey. A real green screen is
 * never pure green, and with an absolute threshold a picked, duller green sits
 * so near grey that skin and dark clothes fall inside it and get keyed out.
 * Relative, everything that is not the screen measures 1 or more whichever
 * green you pick. Spill near the key colour is pulled toward grey so edges do
 * not glow green.
 */
class Keyer {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    this.gl = gl;
    if (!gl) return;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, `
      attribute vec2 p; varying vec2 uv;
      void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 uv;
      uniform sampler2D tex;
      uniform vec3 key;
      uniform float similarity, smoothness;
      vec2 cbcr(vec3 c) {
        return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
      }
      void main() {
        vec4 px = texture2D(tex, uv);
        vec2 k = cbcr(key);
        float d = distance(cbcr(px.rgb), k) / max(length(k), 0.05);
        float a = smoothstep(similarity, similarity + smoothness, d);
        float spill = 1.0 - smoothstep(similarity, similarity + smoothness + 0.3, d);
        vec3 rgb = mix(px.rgb, vec3(dot(px.rgb, vec3(0.299, 0.587, 0.114))), spill * 0.7);
        gl_FragColor = vec4(rgb * a, a);
      }`));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.u = {
      key: gl.getUniformLocation(program, 'key'),
      similarity: gl.getUniformLocation(program, 'similarity'),
      smoothness: gl.getUniformLocation(program, 'smoothness'),
    };
  }

  /** Key a video frame at the size it will be drawn; returns a canvas. */
  render(video, chroma, width, height) {
    const gl = this.gl;
    if (!gl) return null;
    // No bigger than the box it lands in: keying 1080p for a small corner cam is waste.
    const w = Math.max(2, Math.min(video.videoWidth, width));
    const h = Math.max(2, Math.min(video.videoHeight, height));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    const hex = /^#?([0-9a-f]{6})$/i.exec(chroma.color || '') ? chroma.color.replace('#', '') : '00ff00';
    gl.uniform3f(this.u.key, ...[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));
    gl.uniform1f(this.u.similarity, Number(chroma.similarity ?? 0.5));
    gl.uniform1f(this.u.smoothness, Math.max(0.001, Number(chroma.smoothness ?? 0.2)));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

/** Draw `media` to fill the box, cropping the overflow, like CSS cover. */
function drawCover(ctx, media, box) {
  const mw = media.videoWidth || media.naturalWidth;
  const mh = media.videoHeight || media.naturalHeight;
  if (!mw || !mh) return;
  const scale = Math.max(box.w / mw, box.h / mh);
  const sw = box.w / scale;
  const sh = box.h / scale;
  ctx.drawImage(media, (mw - sw) / 2, (mh - sh) / 2, sw, sh, box.x, box.y, box.w, box.h);
}

export class Compositor {
  constructor(program, overlay, { layout, timer, fps, onChange, onSelect }) {
    this.program = program;
    this.overlay = overlay;
    this.ctx = program.getContext('2d', { alpha: false });
    this.octx = overlay.getContext('2d');
    this.layout = layout;             // () => the active layout
    this.timer = timer;
    this.fps = fps;                   // () => target frame rate
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.feeds = new Map();
    this.backgrounds = new Map();
    this.keyer = new Keyer();
    this.selected = null;
    this.drag = null;
    this.picking = null;              // eyedropper callback
    this.lastFrame = 0;
    this.bindPointer();
  }

  get keyingAvailable() { return !!this.keyer.gl; }

  resize(width, height) {
    for (const c of [this.program, this.overlay]) { c.width = width; c.height = height; }
  }

  feed(src) {
    const key = feedKey(src);
    if (!this.feeds.has(key)) this.feeds.set(key, new Feed(key));
    return this.feeds.get(key);
  }

  /** Stop feeds no layout uses any more. */
  prune(allSources) {
    const used = new Set(allSources.filter((s) => s.type !== 'timer').map(feedKey));
    for (const [key, feed] of this.feeds) if (!used.has(key)) { feed.stop(); this.feeds.delete(key); }
  }

  background(url, type) {
    if (!url) return null;
    let media = this.backgrounds.get(url);
    if (!media) {
      if (type === 'video') {
        media = document.createElement('video');
        Object.assign(media, { muted: true, loop: true, playsInline: true, autoplay: true, src: url });
        media.play().catch(() => {});
      } else {
        media = new Image();
        media.src = url;
      }
      this.backgrounds.set(url, media);
    }
    return media;
  }

  // ---------------------------------------------------------------- drawing

  start() {
    // requestAnimationFrame stops in a background tab and ordinary timers are
    // throttled to once a second, either of which would freeze the stream.
    // A worker's timer is not throttled, so it drives frames while hidden.
    const ticker = new Worker('/ticker.js');
    ticker.onmessage = () => {
      if (!document.hidden) return;
      const started = performance.now();
      this.frame();
      // Ask for the next tick only now, so there is never more than one queued.
      ticker.postMessage(Math.max(1, 1000 / this.fps() - (performance.now() - started)));
    };
    let looping = false;             // one animation loop, however often visibility flips
    const loop = (now) => {
      if (document.hidden) { looping = false; return; }
      if (now - this.lastFrame >= 1000 / this.fps() - 2) { this.lastFrame = now; this.frame(); }
      requestAnimationFrame(loop);
    };
    const onVisibility = () => {
      ticker.postMessage(document.hidden ? 1000 / this.fps() : 0);
      if (!document.hidden && !looping) { looping = true; requestAnimationFrame(loop); }
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
  }

  frame() {
    const { ctx, program } = this;
    const layout = this.layout();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, program.width, program.height);
    if (!layout) return;
    const snapshot = this.timer.snapshot();
    for (const src of layout.sources) {
      if (!src.visible) continue;
      if (src.type === 'timer') { drawTimer(ctx, snapshot, src); continue; }
      const feed = this.feeds.get(feedKey(src));
      if (!feed || !feed.ready) continue;
      if (src.type === 'camera' && src.chroma && src.chroma.enabled) this.drawKeyed(src, feed);
      else ctx.drawImage(feed.video, src.x, src.y, src.w, src.h);
    }
    this.drawOverlay(layout);
  }

  drawKeyed(src, feed) {
    const bg = this.background(src.chroma.background, src.chroma.backgroundType);
    if (bg) drawCover(this.ctx, bg, src);
    const keyed = this.keyer.render(feed.video, src.chroma, Math.round(src.w), Math.round(src.h));
    this.ctx.drawImage(keyed || feed.video, src.x, src.y, src.w, src.h);
  }

  /** Selection, handles, and labels for sources that are not showing yet. */
  drawOverlay(layout) {
    const { octx, overlay } = this;
    const s = this.scale();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.font = `${Math.round(14 * s)}px system-ui, sans-serif`;
    octx.textBaseline = 'top';
    for (const src of layout.sources) {
      if (!src.visible || src.type === 'timer') continue;
      const feed = this.feeds.get(feedKey(src));
      if (feed && feed.ready) continue;
      octx.setLineDash([8 * s, 6 * s]);
      octx.strokeStyle = 'rgba(255,255,255,0.35)';
      octx.lineWidth = 2 * s;
      octx.strokeRect(src.x, src.y, src.w, src.h);
      octx.setLineDash([]);
      octx.fillStyle = 'rgba(255,255,255,0.7)';
      const why = !feed || feed.status === 'idle' ? (src.type === 'screen' ? 'click Share screen in Properties' : 'not started')
        : feed.status === 'opening' ? 'starting…' : feed.status === 'ended' ? 'sharing stopped' : feed.error;
      octx.fillText(`${src.name}: ${why}`, src.x + 10 * s, src.y + 10 * s);
    }
    const sel = layout.sources.find((x) => x.id === this.selected);
    if (!sel) return;
    octx.strokeStyle = '#4c9aff';
    octx.lineWidth = 2 * s;
    octx.strokeRect(sel.x, sel.y, sel.w, sel.h);
    octx.fillStyle = '#fff';
    const hs = 10 * s;
    for (const [hx, hy] of this.corners(sel)) octx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
  }

  corners(src) {
    return [[src.x, src.y], [src.x + src.w, src.y], [src.x, src.y + src.h], [src.x + src.w, src.y + src.h]];
  }

  scale() {
    const width = this.overlay.getBoundingClientRect().width;
    return width ? this.overlay.width / width : 1;
  }

  // ------------------------------------------------------------ interaction

  select(id) {
    this.selected = id;
    this.onSelect(id);
  }

  /** Next click on the preview samples a colour from this source's raw video. */
  pickColor(src, callback) {
    this.picking = { src, callback };
    this.overlay.classList.add('picking');
  }

  bindPointer() {
    const el = this.overlay;
    const at = (e) => {
      const r = el.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (el.width / r.width), y: (e.clientY - r.top) * (el.height / r.height) };
    };
    el.addEventListener('pointerdown', (e) => {
      const p = at(e);
      const layout = this.layout();
      if (!layout) return;
      if (this.picking) { this.samplePick(p); return; }
      const sel = layout.sources.find((x) => x.id === this.selected);
      const grab = 14 * this.scale();
      if (sel) {
        const corner = this.corners(sel).findIndex(([cx, cy]) => Math.abs(cx - p.x) < grab && Math.abs(cy - p.y) < grab);
        if (corner >= 0) { this.drag = { mode: 'resize', corner, src: sel, start: p, box: { ...sel } }; el.setPointerCapture(e.pointerId); return; }
      }
      const hit = [...layout.sources].reverse().find((x) => x.visible && p.x >= x.x && p.x <= x.x + x.w && p.y >= x.y && p.y <= x.y + x.h);
      this.select(hit ? hit.id : null);
      if (hit) { this.drag = { mode: 'move', src: hit, start: p, box: { ...hit } }; el.setPointerCapture(e.pointerId); }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = at(e);
      const { src, box, start } = this.drag;
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (this.drag.mode === 'move') {
        src.x = this.snap(box.x + dx, box.w, this.program.width);
        src.y = this.snap(box.y + dy, box.h, this.program.height);
      } else {
        const left = this.drag.corner % 2 === 0;
        const up = this.drag.corner < 2;
        let w = Math.max(40, box.w + (left ? -dx : dx));
        let h = Math.max(30, box.h + (up ? -dy : dy));
        // Video keeps its shape unless Shift is held; the timer resizes freely.
        if ((src.type !== 'timer') !== e.shiftKey) {
          const ratio = box.w / box.h;
          if (Math.abs(dx) > Math.abs(dy)) h = w / ratio; else w = h * ratio;
        }
        src.w = Math.round(w);
        src.h = Math.round(h);
        src.x = Math.round(left ? box.x + box.w - w : box.x);
        src.y = Math.round(up ? box.y + box.h - h : box.y);
      }
    });
    const end = () => { if (this.drag) { this.drag = null; this.onChange(); } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // Edges within a few pixels of the canvas edge stick to it.
  snap(pos, size, limit) {
    const t = 12 * this.scale();
    if (Math.abs(pos) < t) return 0;
    if (Math.abs(pos + size - limit) < t) return limit - size;
    return Math.round(pos);
  }

  samplePick(p) {
    const { src, callback } = this.picking;
    this.picking = null;
    this.overlay.classList.remove('picking');
    const feed = this.feeds.get(feedKey(src));
    if (!feed || !feed.ready || p.x < src.x || p.y < src.y || p.x > src.x + src.w || p.y > src.y + src.h) return;
    const v = feed.video;
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(v, ((p.x - src.x) / src.w) * v.videoWidth, ((p.y - src.y) / src.h) * v.videoHeight, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
    callback('#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join(''));
  }
}
