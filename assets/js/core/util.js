// Small shared helpers. Kept dependency-free on purpose.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const uid = (prefix = 'x') =>
  prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const clamp = (n, min, max) => (n < min ? min : n > max ? max : n);

/** 92.4 -> "1:32.40" ; the studio shows hours only once the run needs them. */
export function fmtTime(seconds, { decimals = 2, forceSign = false, forceHours = false } = {}) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const sign = seconds < 0 ? '-' : forceSign ? '+' : '';
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = decimals > 0
    ? (sec < 10 ? '0' : '') + sec.toFixed(decimals)
    : String(Math.floor(sec)).padStart(2, '0');
  if (h > 0 || forceHours) return `${sign}${h}:${String(m).padStart(2, '0')}:${secStr}`;
  if (m > 0 || decimals === 0) return `${sign}${m}:${secStr}`;
  // Sub-minute times keep the bare seconds only when decimals are shown, so a
  // split column never degrades to a lone "0".
  return `${sign}${sec.toFixed(decimals)}`;
}

/** Clock face for the big timer: always minutes, seconds, and 2 decimals. */
export function fmtClock(seconds, decimals = 2) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '0.00';
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = (sec < 10 ? '0' : '') + sec.toFixed(decimals);
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
  return (neg ? '-' : '') + body;
}

export function fmtHMS(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function throttle(fn, ms = 100) {
  let last = 0, timer = null, lastArgs;
  return (...args) => {
    lastArgs = args;
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...args); }
    else if (!timer) {
      timer = setTimeout(() => { timer = null; last = performance.now(); fn(...lastArgs); }, ms - (now - last));
    }
  };
}

/** Minimal event bus — the panels talk to each other through this. */
export class Bus {
  constructor() { this.map = new Map(); }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this.map.get(evt)?.delete(fn); }
  emit(evt, payload) {
    const set = this.map.get(evt);
    if (set) for (const fn of Array.from(set)) {
      try { fn(payload); } catch (e) { console.error('[bus]', evt, e); }
    }
    const all = this.map.get('*');
    if (all) for (const fn of Array.from(all)) { try { fn(evt, payload); } catch (e) {} }
  }
}

export const bus = new Bus();

export function toast(message, kind = '') {
  const root = document.getElementById('toasts');
  if (!root) { console.log('[toast]', message); return; }
  const node = el('div', { class: 'toast ' + kind, text: message });
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, kind === 'err' ? 6000 : 3200);
}

export function download(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: accept || '', style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** deep clone that works everywhere, including the old browsers we target */
export const clone = (obj) => (typeof structuredClone === 'function'
  ? structuredClone(obj)
  : JSON.parse(JSON.stringify(obj)));
