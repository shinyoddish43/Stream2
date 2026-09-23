// The compositor: draws the active scene into the program canvas, keeps the
// preview canvas in step, runs transitions, and owns the interactive
// transform handles.
//
// Deliberately Canvas2D and not WebGL. On the machines this studio targets —
// integrated GPUs, 2-core laptops, whatever is spare in the corner — a plain
// 2D context with a capped frame rate is both faster to start and far more
// predictable than a shader pipeline, and it never loses its context when the
// driver hiccups mid-stream.

import { bus, clamp } from './util.js';
import { getRuntime, dropRuntime, roundRect } from './sources.js';

// Sources whose pixels change on their own.
const LIVE_TYPES = new Set(['display', 'camera', 'media', 'imagefeed']);
const DYNAMIC_TOKEN = /\{(timer|clock|delta|split|attempts|bpt|sob|date)\}/;

const HANDLES = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0],
  ['w', 0, 0.5], ['e', 1, 0.5],
  ['sw', 0, 1], ['s', 0.5, 1], ['se', 1, 1],
];

export class Compositor {
  constructor(store, timer) {
    this.store = store;
    this.timer = timer;
    this.running = false;
    this.programCanvas = null;
    this.previewCanvas = null;
    this.selection = null;
    this.transition = null;
    this.frames = 0;
    this.skipped = 0;
    this.fps = 0;
    this.renderMs = 0;
    this.lastFpsAt = 0;
    this.lastFrameAt = 0;
    this.previewEvery = 2;      // draw the studio-mode preview at half rate
    this.tickCount = 0;
    this.dirty = true;
    this.idleThisSecond = 0;
    // Set by the output manager: while something is being recorded or sent,
    // the canvas must keep producing frames even if nothing on it moves.
    this.needsFrames = () => false;
    this.idleFrames = 0;
    this._loop = this._loop.bind(this);
    bus.on('doc:changed', () => { this.dirty = true; });
    bus.on('selection:changed', () => { this.dirty = true; });
    bus.on('timer:state', () => { this.dirty = true; });
    bus.on('source:ready', () => { this.dirty = true; });
  }

  attach(programCanvas, previewCanvas) {
    this.programCanvas = programCanvas;
    this.previewCanvas = previewCanvas;
    // `desynchronized` lets the browser skip a compositing step; `alpha:false`
    // saves a per-frame blend we never need since the scene is opaque.
    this.programCtx = programCanvas.getContext('2d', { alpha: false, desynchronized: true });
    this.previewCtx = previewCanvas ? previewCanvas.getContext('2d', { alpha: false }) : null;
    this.resize();
  }

  resize() {
    const { w, h } = this.store.get().canvas;
    for (const canvas of [this.programCanvas, this.previewCanvas]) {
      if (!canvas) continue;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFpsAt = performance.now();
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
  }

  targetFps() {
    const doc = this.store.get();
    const base = clamp(doc.canvas.fps || 30, 1, 60);
    return doc.lowPower ? Math.max(10, Math.round(base / 2)) : base;
  }

  _schedule() {
    if (!this.running) return;
    // rAF while the tab is visible (smooth, vsync-aligned), a timer when it is
    // not — a hidden tab stops rAF, and a stream that stops producing frames
    // is a dropped stream.
    if (document.hidden) {
      this.timeoutHandle = setTimeout(this._loop, 1000 / this.targetFps());
    } else {
      this.rafHandle = requestAnimationFrame(this._loop);
    }
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    const interval = 1000 / this.targetFps();
    const elapsed = now - this.lastFrameAt;
    if (elapsed + 1.5 < interval) { this._schedule(); return; }
    // A frame later than two intervals means we could not keep up.
    if (this.lastFrameAt && elapsed > interval * 2.2) this.skipped++;
    this.lastFrameAt = now;

    // A still scene — a "starting soon" card, say — does not need repainting
    // sixty times a second while nobody is watching. Skip the draw unless
    // something moves, something changed, or an output is consuming frames.
    if (!this.dirty && !this.needsFrames() && !this.transition && !this.sceneIsAnimated()) {
      this.idleFrames++;
      this.idleThisSecond++;
      if (now - this.lastFpsAt >= 1000) this.emitStats(now);
      this._schedule();
      return;
    }
    this.dirty = false;

    const t0 = performance.now();
    try { this.renderFrame(now); } catch (e) { console.error('[compositor]', e); }
    this.renderMs = this.renderMs * 0.9 + (performance.now() - t0) * 0.1;

    this.frames++;
    this.tickCount++;
    if (now - this.lastFpsAt >= 1000) this.emitStats(now);
    this._schedule();
  }

  emitStats(now) {
    const seconds = (now - this.lastFpsAt) / 1000;
    this.fps = Math.round(this.frames / seconds);
    // "Idle" is not "broken": it means the scene is a still image and the
    // compositor is deliberately not repainting it.
    const idle = this.idleThisSecond > this.frames;
    this.frames = 0;
    this.idleThisSecond = 0;
    this.lastFpsAt = now;
    bus.emit('compositor:stats', { fps: this.fps, skipped: this.skipped, renderMs: this.renderMs, idle });
  }

  context() {
    return { timer: this.timer ? this.timer.snapshot() : null, now: performance.now() };
  }

  /** Does anything on the current scene change by itself? */
  sceneIsAnimated() {
    const doc = this.store.get();
    const scenes = doc.studioMode
      ? [doc.activeScene, doc.previewScene]
      : [doc.activeScene];
    for (const sceneId of scenes) {
      const scene = doc.scenes.find((s) => s.id === sceneId);
      if (!scene) continue;
      for (const item of scene.sources) {
        if (!item.visible) continue;
        if (LIVE_TYPES.has(item.type)) return true;
        if (item.type === 'timer') {
          const phase = this.timer && this.timer.phase;
          if (phase === 'running' || this.timer.external) return true;
        }
        if (item.type === 'text' && DYNAMIC_TOKEN.test((item.settings || {}).text || '')) return true;
      }
    }
    return false;
  }

  renderFrame(now) {
    const doc = this.store.get();
    const ctx = this.programCtx;
    if (!ctx) return;
    const context = this.context();
    const programScene = doc.scenes.find((s) => s.id === doc.activeScene) || doc.scenes[0];

    if (this.transition) {
      const progress = clamp((now - this.transition.startedAt) / this.transition.duration, 0, 1);
      this.renderTransition(ctx, this.transition, progress, context);
      if (progress >= 1) {
        const finished = this.transition;
        this.transition = null;
        bus.emit('transition:done', finished);
      }
    } else {
      this.renderScene(ctx, programScene, context);
    }

    // Preview canvas: only in studio mode, and at half the program rate.
    if (doc.studioMode && this.previewCtx && this.tickCount % this.previewEvery === 0) {
      const previewScene = doc.scenes.find((s) => s.id === doc.previewScene) || programScene;
      this.renderScene(this.previewCtx, previewScene, context);
    }

    if (this.onOverlay) this.onOverlay();
  }

  renderScene(ctx, scene, context) {
    const { w, h } = this.store.get().canvas;
    ctx.save();
    ctx.imageSmoothingEnabled = !this.store.get().lowPower;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (!scene) { ctx.restore(); return; }
    for (const item of scene.sources) {
      if (!item.visible) continue;
      this.drawSource(ctx, item, context);
    }
    ctx.restore();
  }

  drawSource(ctx, item, context) {
    const runtime = getRuntime(item);
    if (runtime.status === 'idle' && runtime.start) runtime.start();
    const opacity = item.opacity === undefined ? 1 : Number(item.opacity);
    if (opacity <= 0) return;
    ctx.save();
    if (opacity < 1) ctx.globalAlpha = opacity;
    if (item.rotation) {
      ctx.translate(item.x + item.w / 2, item.y + item.h / 2);
      ctx.rotate((item.rotation * Math.PI) / 180);
      ctx.translate(-(item.x + item.w / 2), -(item.y + item.h / 2));
    }
    const frame = runtime.frame ? runtime.frame() : null;
    if (frame) {
      const settings = item.settings || {};
      if (settings.mirror) {
        ctx.translate(item.x * 2 + item.w, 0);
        ctx.scale(-1, 1);
      }
      const crop = settings.crop;
      try {
        if (crop && crop.w > 0 && crop.h > 0) {
          ctx.drawImage(frame, crop.x, crop.y, crop.w, crop.h, item.x, item.y, item.w, item.h);
        } else if (settings.fit === 'contain' || settings.fit === 'cover') {
          drawFitted(ctx, frame, item, settings.fit);
        } else {
          ctx.drawImage(frame, item.x, item.y, item.w, item.h);
        }
      } catch (e) { /* a frame can be momentarily unusable while a track restarts */ }
    } else if (runtime.paint) {
      runtime.paint(ctx, item, context);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ transitions
  transitionTo(sceneId, spec) {
    const doc = this.store.get();
    if (doc.activeScene === sceneId) return;
    const from = doc.scenes.find((s) => s.id === doc.activeScene);
    const to = doc.scenes.find((s) => s.id === sceneId);
    if (!to) return;
    const type = (spec && spec.type) || doc.transition.type || 'cut';
    const duration = Math.max(0, (spec && spec.duration) !== undefined ? spec.duration : doc.transition.duration);
    this.store.update((d) => { d.activeScene = sceneId; });
    if (type === 'cut' || duration < 16 || !from) { bus.emit('transition:done', { to: sceneId }); return; }
    this.transition = { from, to, type, duration, startedAt: performance.now() };
  }

  scratch(index) {
    if (!this._scratch) this._scratch = [];
    const { w, h } = this.store.get().canvas;
    if (!this._scratch[index]) this._scratch[index] = document.createElement('canvas');
    const canvas = this._scratch[index];
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return canvas;
  }

  renderTransition(ctx, transition, progress, context) {
    const { w, h } = this.store.get().canvas;
    const eased = progress * progress * (3 - 2 * progress);   // smoothstep
    if (transition.type === 'fade') {
      this.renderScene(ctx, transition.from, context);
      const scratch = this.scratch(0);
      this.renderScene(scratch.getContext('2d'), transition.to, context);
      ctx.save();
      ctx.globalAlpha = eased;
      ctx.drawImage(scratch, 0, 0);
      ctx.restore();
    } else if (transition.type === 'fade_black') {
      if (progress < 0.5) {
        this.renderScene(ctx, transition.from, context);
        ctx.fillStyle = `rgba(0,0,0,${progress * 2})`;
      } else {
        this.renderScene(ctx, transition.to, context);
        ctx.fillStyle = `rgba(0,0,0,${(1 - progress) * 2})`;
      }
      ctx.fillRect(0, 0, w, h);
    } else if (transition.type === 'slide') {
      const scratchA = this.scratch(0);
      const scratchB = this.scratch(1);
      this.renderScene(scratchA.getContext('2d'), transition.from, context);
      this.renderScene(scratchB.getContext('2d'), transition.to, context);
      const offset = Math.round(eased * w);
      ctx.drawImage(scratchA, -offset, 0);
      ctx.drawImage(scratchB, w - offset, 0);
    } else {
      this.renderScene(ctx, transition.to, context);
    }
  }

  // -------------------------------------------------------------- selection
  select(id) {
    this.selection = id;
    bus.emit('selection:changed', id);
  }

  /** A MediaStream of the program canvas, for recording or streaming. */
  captureStream(fps) {
    return this.programCanvas.captureStream(fps || this.targetFps());
  }

  /** Called when a source leaves the document so its media can be released. */
  release(id) { dropRuntime(id); }
}

function drawFitted(ctx, frame, item, mode) {
  const sw = frame.videoWidth || frame.naturalWidth || frame.width;
  const sh = frame.videoHeight || frame.naturalHeight || frame.height;
  if (!sw || !sh) return;
  const scale = mode === 'cover'
    ? Math.max(item.w / sw, item.h / sh)
    : Math.min(item.w / sw, item.h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = item.x + (item.w - dw) / 2;
  const dy = item.y + (item.h - dh) / 2;
  if (mode === 'cover') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(item.x, item.y, item.w, item.h);
    ctx.clip();
    ctx.drawImage(frame, dx, dy, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(frame, dx, dy, dw, dh);
  }
}

/**
 * Mouse-driven move/resize of the selected source, drawn as an HTML overlay on
 * top of the canvas (cheaper than repainting handles into the stream, and the
 * handles never end up on air).
 */
export class TransformLayer {
  constructor(layerEl, canvasEl, store, compositor, sceneGetter) {
    this.layer = layerEl;
    this.canvas = canvasEl;
    this.store = store;
    this.compositor = compositor;
    this.sceneGetter = sceneGetter;
    this.drag = null;
    this.layer.classList.add('active');
    this.layer.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    bus.on('selection:changed', () => this.render());
    bus.on('doc:changed', () => this.render());
    window.addEventListener('resize', () => this.render());
  }

  /** Canvas pixel coordinates for a pointer event. */
  toCanvas(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY, rect, scaleX, scaleY };
  }

  onDown(event) {
    const scene = this.sceneGetter();
    if (!scene) return;
    const pos = this.toCanvas(event);
    const handle = event.target.dataset && event.target.dataset.handle;
    const selected = scene.sources.find((s) => s.id === this.compositor.selection);
    if (handle && selected) {
      this.drag = { mode: 'resize', handle, item: selected, start: pos, box: { ...selected } };
      this.layer.setPointerCapture?.(event.pointerId);
      return;
    }
    // Topmost source under the cursor wins, like every editor ever.
    for (let i = scene.sources.length - 1; i >= 0; i--) {
      const item = scene.sources[i];
      if (!item.visible || item.locked) continue;
      if (pos.x >= item.x && pos.x <= item.x + item.w && pos.y >= item.y && pos.y <= item.y + item.h) {
        this.compositor.select(item.id);
        this.drag = { mode: 'move', item, start: pos, box: { ...item } };
        return;
      }
    }
    this.compositor.select(null);
  }

  onMove(event) {
    if (!this.drag) return;
    const pos = this.toCanvas(event);
    const dx = pos.x - this.drag.start.x;
    const dy = pos.y - this.drag.start.y;
    const item = this.drag.item;
    const box = this.drag.box;
    const snap = event.ctrlKey ? 1 : 8;   // hold Ctrl for pixel-exact placement
    if (this.drag.mode === 'move') {
      item.x = Math.round((box.x + dx) / snap) * snap;
      item.y = Math.round((box.y + dy) / snap) * snap;
    } else {
      const keepRatio = event.shiftKey;
      const ratio = box.w / box.h;
      let { x, y, w, h } = box;
      if (this.drag.handle.includes('e')) w = box.w + dx;
      if (this.drag.handle.includes('s')) h = box.h + dy;
      if (this.drag.handle.includes('w')) { w = box.w - dx; x = box.x + dx; }
      if (this.drag.handle.includes('n')) { h = box.h - dy; y = box.y + dy; }
      if (keepRatio) {
        if (Math.abs(w - box.w) > Math.abs(h - box.h)) h = w / ratio; else w = h * ratio;
      }
      item.x = Math.round(x);
      item.y = Math.round(y);
      item.w = Math.max(16, Math.round(w));
      item.h = Math.max(16, Math.round(h));
    }
    this.render();
  }

  onUp() {
    if (!this.drag) return;
    this.drag = null;
    this.store.update(() => {}, { silent: true });   // persist, no full redraw
    bus.emit('source:transformed');
  }

  render() {
    const scene = this.sceneGetter();
    const item = scene && scene.sources.find((s) => s.id === this.compositor.selection);
    this.layer.innerHTML = '';
    if (!item) return;
    const rect = this.canvas.getBoundingClientRect();
    const holder = this.layer.getBoundingClientRect();
    const sx = rect.width / this.canvas.width;
    const sy = rect.height / this.canvas.height;
    const offX = rect.left - holder.left;
    const offY = rect.top - holder.top;
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.left = offX + item.x * sx + 'px';
    box.style.top = offY + item.y * sy + 'px';
    box.style.width = item.w * sx + 'px';
    box.style.height = item.h * sy + 'px';
    this.layer.appendChild(box);
    if (item.locked) return;
    for (const [name, fx, fy] of HANDLES) {
      const handle = document.createElement('div');
      handle.className = 'handle';
      handle.dataset.handle = name;
      handle.style.left = offX + (item.x + item.w * fx) * sx + 'px';
      handle.style.top = offY + (item.y + item.h * fy) * sy + 'px';
      handle.style.cursor = name.length === 2 ? name + '-resize' : name + '-resize';
      this.layer.appendChild(handle);
    }
  }
}

export { roundRect };
