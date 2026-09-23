// The speedrun timer: LiveSplit's model, native to the studio.
// Compares against your personal best, records golds, reads and writes .lss.

export class Timer {
  constructor() {
    this.load(null);
  }

  load(run) {
    this.run = normalize(run);
    this.phase = 'idle';            // idle | running | paused | ended
    this.times = this.run.segments.map(() => null);   // cumulative seconds per split
    this.index = 0;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.endedAt = 0;
    this.recorded = false;          // this attempt is already folded into the splits
  }

  // Seconds on the clock. performance.now(), so a system clock change cannot
  // touch a run.
  now() {
    if (this.phase === 'idle') return -(this.run.offset || 0);
    const end = this.phase === 'paused' ? this.pausedAt : this.phase === 'ended' ? this.endedAt : performance.now();
    return (end - this.startedAt - this.pausedTotal) / 1000 - (this.run.offset || 0);
  }

  split() {
    if (this.phase === 'idle') {
      this.phase = 'running';
      this.startedAt = performance.now();
      this.pausedTotal = 0;
      this.index = 0;
      this.times = this.run.segments.map(() => null);
      this.run.attempts = (this.run.attempts || 0) + 1;
      this.recorded = false;
      return 'start';
    }
    if (this.phase !== 'running') return null;
    const t = this.now();
    if (t < 0) return null;                          // still counting down the offset
    this.times[this.index++] = t;
    if (this.index >= this.run.segments.length) {
      this.phase = 'ended';
      this.endedAt = performance.now();
      this.record();
      return 'finish';
    }
    return 'split';
  }

  undo() {
    if (this.phase === 'ended') {
      // A misclicked last split: withdraw the finish, keep any golds earned.
      if (this.recorded && this.run.history.length) this.run.history.pop();
      this.recorded = false;
      this.phase = 'running';
      this.startedAt += performance.now() - this.endedAt;
    } else if (this.phase !== 'running' || this.index === 0) {
      return;
    }
    this.times[--this.index] = null;
  }

  skip() {
    if (this.phase === 'running' && this.index < this.run.segments.length - 1) this.times[this.index++] = null;
  }

  pause() {
    if (this.phase === 'running') { this.phase = 'paused'; this.pausedAt = performance.now(); }
    else if (this.phase === 'paused') { this.pausedTotal += performance.now() - this.pausedAt; this.phase = 'running'; }
  }

  // Back to idle. An unfinished attempt is recorded (its golds count); a
  // finished one was recorded when it finished and is not counted twice.
  reset() {
    if (this.phase !== 'idle' && !this.recorded) this.record();
    this.phase = 'idle';
    this.index = 0;
    this.times = this.run.segments.map(() => null);
  }

  record() {
    this.recorded = true;
    const segs = this.run.segments;
    let previous = 0;
    segs.forEach((seg, i) => {
      const t = this.times[i];
      if (t === null) return;
      const length = t - previous;
      previous = t;
      if (length > 0 && (seg.best === null || length < seg.best)) seg.best = length;
    });
    const final = this.phase === 'ended' ? this.times[segs.length - 1] : null;
    if (final !== null && (this.run.pb === null || final < this.run.pb)) {
      segs.forEach((seg, i) => { seg.pb = this.times[i]; });
      this.run.pb = final;
    }
    this.run.history.push({ id: this.run.attempts, real: final, ended: new Date().toISOString() });
    if (this.run.history.length > 500) this.run.history.shift();
  }

  sumOfBest() {
    let sum = 0;
    for (const seg of this.run.segments) { if (seg.best === null) return null; sum += seg.best; }
    return sum;
  }

  segmentTime(i) {
    if (this.times[i] === null) return null;
    let previous = 0;
    for (let j = i - 1; j >= 0; j--) if (this.times[j] !== null) { previous = this.times[j]; break; }
    return this.times[i] - previous;
  }

  pbSegment(i) {
    const segs = this.run.segments;
    if (segs[i].pb === null) return null;
    return i === 0 ? segs[i].pb : segs[i - 1].pb === null ? null : segs[i].pb - segs[i - 1].pb;
  }

  // LiveSplit's colours: gold beats your best segment; green is ahead of PB,
  // red behind, each lighter when that segment gained time and darker when lost.
  deltaColor(i) {
    const seg = this.run.segments[i];
    const length = this.segmentTime(i);
    if (length !== null && seg.best !== null && length < seg.best) return 'gold';
    const delta = this.times[i] - seg.pb;
    const pbLength = this.pbSegment(i);
    const gained = length !== null && pbLength !== null ? length < pbLength : delta < 0;
    if (delta < 0) return gained ? 'ahead' : 'ahead-losing';
    return gained ? 'behind-gaining' : 'behind';
  }

  snapshot() {
    const time = this.now();
    const rows = this.run.segments.map((seg, i) => {
      const t = this.times[i];
      const hasDelta = t !== null && seg.pb !== null;
      return {
        name: seg.name,
        time: t !== null ? t : seg.pb,
        delta: hasDelta ? t - seg.pb : null,
        color: hasDelta ? this.deltaColor(i) : null,
        current: this.phase !== 'idle' && this.phase !== 'ended' && i === this.index,
      };
    });
    // While running, show the delta on the current split once it is losing time.
    const current = this.run.segments[this.index];
    if (this.phase === 'running' && current && current.pb !== null && time > current.pb) {
      rows[this.index].delta = time - current.pb;
      rows[this.index].color = 'behind';
    }
    const lastDone = this.index - 1;
    const prevSeg = lastDone >= 0 && this.segmentTime(lastDone) !== null && this.pbSegment(lastDone) !== null
      ? this.segmentTime(lastDone) - this.pbSegment(lastDone) : null;
    let clock = 'running';
    if (this.phase === 'idle') clock = 'idle';
    else if (this.phase === 'paused') clock = 'paused';
    else if (this.phase === 'ended') clock = this.run.pb !== null && this.times[this.times.length - 1] <= this.run.pb ? 'gold' : 'behind';
    else if (rows[this.index] && rows[this.index].color === 'behind') clock = 'behind';
    else for (let i = lastDone; i >= 0; i--) if (rows[i].delta !== null) { if (rows[i].delta > 0) clock = 'behind'; break; }
    return {
      game: this.run.game, category: this.run.category, attempts: this.run.attempts,
      phase: this.phase, time, clock, rows, index: this.index,
      sumOfBest: this.sumOfBest(), pb: this.run.pb, prevSeg,
    };
  }
}

function normalize(run) {
  const r = run || {};
  const segments = (Array.isArray(r.segments) && r.segments.length ? r.segments : [{ name: 'Split 1' }, { name: 'Split 2' }, { name: 'Finish' }])
    .map((s, i) => ({ name: String(s.name || `Split ${i + 1}`), pb: num(s.pb), best: num(s.best), comparisons: s.comparisons || {} }));
  return {
    game: r.game || 'Untitled', category: r.category || 'Any%',
    attempts: Number(r.attempts) || 0, offset: Number(r.offset) || 0,
    platform: r.platform || '', region: r.region || '', variables: r.variables || {},
    history: Array.isArray(r.history) ? r.history : [],
    segments,
    pb: num(r.pb) ?? segments[segments.length - 1].pb,
  };
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ----------------------------------------------------------------- display

export function fmt(seconds, decimals = 0, sign = false) {
  if (seconds === null || seconds === undefined) return '—';
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s %= 60;
  const sec = decimals ? s.toFixed(decimals).padStart(decimals + 3, '0') : String(Math.floor(s)).padStart(2, '0');
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  return (neg ? '-' : sign ? '+' : '') + body;
}

// Short delta: "-4.2", "+1:03".
function fmtDelta(d) {
  const a = Math.abs(d);
  return (d < 0 ? '-' : '+') + (a < 60 ? a.toFixed(1) : fmt(a));
}

const COLORS = {
  gold: '#e8c547', ahead: '#43d18a', 'ahead-losing': '#2f9b67',
  behind: '#e5534b', 'behind-gaining': '#e89150', idle: '#ffffff', running: '#43d18a', paused: '#9aa3ad',
};

/** Paint the timer into a box on the stream canvas. */
export function drawTimer(ctx, snap, box) {
  const { x, y, w, h } = box;
  const pad = Math.max(6, w * 0.03);
  const font = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const row = Math.max(14, Math.min(26, w / 13));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = 'rgba(10, 12, 16, 0.82)';
  ctx.fillRect(x, y, w, h);

  // Title
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${row * 0.95}px ${font}`;
  ctx.fillText(trim(ctx, snap.game, w - pad * 2), x + w / 2, y + pad);
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = `400 ${row * 0.75}px ${font}`;
  ctx.fillText(trim(ctx, snap.category, w - pad * 6), x + w / 2, y + pad + row * 1.15);
  ctx.textAlign = 'right';
  ctx.fillText(String(snap.attempts), x + w - pad, y + pad + row * 1.15);

  const top = y + pad + row * 2.3;
  const footer = row * 3.6;
  const visible = Math.max(1, Math.floor((h - (top - y) - footer) / row));
  const rows = snap.rows;
  let first = 0;
  if (rows.length > visible) {
    const focus = snap.phase === 'idle' || snap.phase === 'ended' ? rows.length - 1 : snap.index;
    first = Math.max(0, Math.min(rows.length - visible, focus - Math.floor(visible / 2)));
  }
  ctx.textBaseline = 'middle';
  for (let i = 0; i < visible && first + i < rows.length; i++) {
    const r = rows[first + i];
    const cy = top + i * row + row / 2;
    if (r.current) { ctx.fillStyle = 'rgba(80, 140, 255, 0.25)'; ctx.fillRect(x, cy - row / 2, w, row); }
    ctx.font = `400 ${row * 0.7}px ${font}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(trim(ctx, r.name, w * 0.5), x + pad, cy);
    ctx.textAlign = 'right';
    ctx.font = `500 ${row * 0.66}px ui-monospace, Consolas, monospace`;
    if (r.delta !== null) { ctx.fillStyle = COLORS[r.color] || '#fff'; ctx.fillText(fmtDelta(r.delta), x + w - pad - w * 0.25, cy); }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(fmt(r.time), x + w - pad, cy);
  }

  // Clock and footer
  const clockSize = row * 1.9;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS[snap.clock] || '#fff';
  ctx.font = `700 ${clockSize}px ui-monospace, Consolas, monospace`;
  ctx.fillText(fmt(snap.time, snap.time >= 3600 ? 1 : 2), x + w - pad, y + h - row * 1.35);
  ctx.font = `400 ${row * 0.62}px ${font}`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.textAlign = 'left';
  ctx.fillText(`Prev ${snap.prevSeg === null ? '—' : fmtDelta(snap.prevSeg)}`, x + pad, y + h - pad * 0.8);
  ctx.textAlign = 'right';
  ctx.fillText(`SoB ${fmt(snap.sumOfBest)}  ·  PB ${fmt(snap.pb)}`, x + w - pad, y + h - pad * 0.8);
  ctx.restore();
}

function trim(ctx, text, max) {
  let t = String(text || '');
  if (ctx.measureText(t).width <= max) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

// ------------------------------------------------------------------ .lss

export function parseTime(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let days = 0;
  const d = /^(\d+)\.(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  if (d) { days = Number(d[1]); s = d[2]; }
  let total = 0;
  for (const part of s.split(':')) total = total * 60 + Number(part);
  if (!Number.isFinite(total)) return null;
  return (neg ? -1 : 1) * (total + days * 86400);
}

export function formatTime(seconds) {
  const s = Math.abs(seconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${seconds < 0 ? '-' : ''}${hh}:${mm}:${(s % 60).toFixed(7).padStart(10, '0')}`;
}

/** LiveSplit .lss text -> run. Keeps comparisons and attempt history intact. */
export function parseLss(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root.nodeName !== 'Run') throw new Error('That is not a LiveSplit splits file.');
  const child = (node, tag) => (node ? Array.from(node.children).find((c) => c.nodeName === tag) : null);
  const text = (node, tag) => { const c = child(node, tag); return c ? c.textContent : ''; };
  const meta = child(root, 'Metadata');
  const variables = {};
  for (const v of child(meta, 'Variables') ? child(meta, 'Variables').children : []) variables[v.getAttribute('name')] = v.textContent;
  const segments = Array.from(child(root, 'Segments') ? child(root, 'Segments').children : []).map((seg) => {
    const comparisons = {};
    let pb = null;
    for (const st of child(seg, 'SplitTimes') ? child(seg, 'SplitTimes').children : []) {
      const value = parseTime(text(st, 'RealTime'));
      if (st.getAttribute('name') === 'Personal Best') pb = value;
      else if (value !== null) comparisons[st.getAttribute('name')] = value;
    }
    return { name: text(seg, 'Name'), pb, best: parseTime(text(child(seg, 'BestSegmentTime'), 'RealTime')), comparisons };
  });
  if (!segments.length) throw new Error('Those splits have no segments.');
  const history = Array.from(child(root, 'AttemptHistory') ? child(root, 'AttemptHistory').children : []).map((a) => ({
    id: Number(a.getAttribute('id')) || 0, started: a.getAttribute('started') || '',
    ended: a.getAttribute('ended') || '', real: parseTime(text(a, 'RealTime')),
  }));
  return {
    game: text(root, 'GameName'), category: text(root, 'CategoryName'),
    attempts: Number(text(root, 'AttemptCount')) || 0, offset: parseTime(text(root, 'Offset')) || 0,
    platform: text(meta, 'Platform'), region: text(meta, 'Region'), variables, segments, history,
    pb: segments[segments.length - 1].pb,
  };
}

/** Run -> .lss text LiveSplit will open. */
export function buildLss(run) {
  const doc = document.implementation.createDocument('', 'Run', null);
  const root = doc.documentElement;
  root.setAttribute('version', '1.7.0');
  const add = (parent, tag, value, attrs = {}) => {
    const n = doc.createElement(tag);
    if (value !== null && value !== undefined && value !== '') n.textContent = String(value);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };
  add(root, 'GameIcon');
  add(root, 'GameName', run.game);
  add(root, 'CategoryName', run.category);
  const meta = add(root, 'Metadata');
  add(meta, 'Run', null, { id: '' });
  add(meta, 'Platform', run.platform, { usesEmulator: 'False' });
  add(meta, 'Region', run.region);
  const vars = add(meta, 'Variables');
  for (const [k, v] of Object.entries(run.variables || {})) add(vars, 'Variable', v, { name: k });
  add(root, 'Offset', formatTime(run.offset || 0));
  add(root, 'AttemptCount', run.attempts || 0);
  const hist = add(root, 'AttemptHistory');
  for (const a of run.history || []) {
    const attrs = { id: String(a.id || 0) };
    if (a.started) Object.assign(attrs, { started: a.started, isStartedSynced: 'True' });
    if (a.ended) Object.assign(attrs, { ended: a.ended, isEndedSynced: 'True' });
    const node = add(hist, 'Attempt', null, attrs);
    if (a.real !== null && a.real !== undefined) add(node, 'RealTime', formatTime(a.real));
  }
  const segs = add(root, 'Segments');
  for (const s of run.segments) {
    const seg = add(segs, 'Segment');
    add(seg, 'Name', s.name);
    add(seg, 'Icon');
    const times = add(seg, 'SplitTimes');
    for (const [name, value] of [['Personal Best', s.pb], ...Object.entries(s.comparisons || {})]) {
      const st = add(times, 'SplitTime', null, { name });
      if (value !== null && value !== undefined) add(st, 'RealTime', formatTime(value));
    }
    const best = add(seg, 'BestSegmentTime');
    if (s.best !== null && s.best !== undefined) add(best, 'RealTime', formatTime(s.best));
    add(seg, 'SegmentHistory');
  }
  add(root, 'AutoSplitterSettings');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc);
}
