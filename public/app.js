import { Timer, parseLss, buildLss, fmt } from './timer.js';
import { Compositor, feedKey, openCamera, openScreen } from './compositor.js';
import { Mixer, openAudioInput } from './mixer.js';
import { Streamer } from './stream.js';

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const HOTKEYS = { split: 'Split / start', undo: 'Undo', skip: 'Skip', pause: 'Pause', reset: 'Reset' };
const CHROMA_DEFAULTS = { enabled: false, color: '#00ff00', background: null, backgroundType: null };
// What goes to Twitch, fixed: 720p30 at 4500 kbps suits a browser encoder and
// the server's re-encode, and needs about 6 Mbps of upload.
const OUTPUT = { width: 1280, height: 720, fps: 30, bitrate: 4500 };
// An audio input saved as DEFAULT_MIC is the default microphone of whichever
// browser and device the studio runs on, so it works everywhere.
const DEFAULT_MIC = 'default';
const NOT_HERE = 'not on this device';
// Changes not yet on the server, kept in this browser until they are.
const STASH = 'studio.unsaved';
const clientId = uid();

let doc;                  // layouts, audio inputs, output and hotkeys; saved to the server
let settings;             // Twitch settings as the server reports them (never the key itself)
let rev = 0;              // the server's revision of the layouts this page is working on
let dirty = false;        // changes the server does not have yet
let edits = 0;            // counts changes, to tell whether one came in during a save
let saving = null;        // the save in flight
const deletedLayouts = new Set();
const missingAudio = new Map();   // audio input id -> why it could not be opened here
const timer = new Timer();
const mixer = new Mixer();
const compositor = new Compositor($('program'), $('overlay'), {
  layout: () => active(),
  timer,
  fps: () => doc.output.fps,
  onChange: () => save(),
  onSelect: () => { renderSources(); renderGreen(); },
});
const streamer = new Streamer({ canvas: $('program'), mixer, onStatus: showStatus });

// ----------------------------------------------------------------- model

function defaultDoc() {
  const id = uid();
  return {
    version: 2,
    output: { ...OUTPUT },
    hotkeys: { split: 'Numpad1', undo: 'Numpad8', skip: 'Numpad2', pause: 'Numpad5', reset: 'Numpad3' },
    // Like OBS's Mic/Aux, a new studio starts with the default microphone.
    audio: [{ id: uid(), deviceId: DEFAULT_MIC, label: 'Default microphone', gain: 1, muted: false }],
    screenAudio: { gain: 1, muted: false },
    active: id,
    layouts: [{ id, name: 'Main', sources: [timerSource(1280, 720)] }],
  };
}

function timerSource(W, H) {
  const w = Math.round(W * 0.25);
  return { id: uid(), type: 'timer', name: 'Timer', visible: true, x: W - w - 16, y: 16, w, h: Math.round(H * 0.6) };
}

function migrate(saved) {
  const base = defaultDoc();
  if (!saved || !Array.isArray(saved.layouts) || !saved.layouts.length) return base;
  const { rev: _rev, savedAt: _at, savedBy: _by, ...rest } = saved;
  const d = { ...base, ...structuredClone(rest), output: { ...OUTPUT }, hotkeys: { ...base.hotkeys, ...rest.hotkeys } };
  if (!d.layouts.some((l) => l.id === d.active)) d.active = d.layouts[0].id;
  // Layouts made at another size (there used to be a setting) keep their proportions.
  const k = OUTPUT.width / (Number(rest.output && rest.output.width) || OUTPUT.width);
  for (const l of d.layouts) {
    if (k !== 1) for (const s of l.sources) for (const p of ['x', 'y', 'w', 'h']) s[p] = Math.round(s[p] * k);
    for (const s of l.sources) {
      if (s.type !== 'camera') continue;
      // Cameras open at fixed defaults, and keying strength is fixed: only
      // on/off, the colour and the background are settings.
      const { enabled, color, background, backgroundType } = { ...CHROMA_DEFAULTS, ...s.chroma };
      s.chroma = { enabled, color, background, backgroundType };
      delete s.resolution;
    }
  }
  return d;
}

const active = () => doc && doc.layouts.find((l) => l.id === doc.active);
const allSources = () => doc.layouts.flatMap((l) => l.sources);
const selected = () => active().sources.find((s) => s.id === compositor.selected);

// ----------------------------------------------------------------- server

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out.'); }
  // Behind the hub login, an expired sign-in comes back as a redirect to it.
  if (res.type === 'opaqueredirect') throw new Error('Your sign-in has expired. Reload the page to sign in again.');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status, body });
  return body;
}

// ------------------------------------------------------------------ saving
//
// Every change is kept in this browser at once and sent to the server half a
// second later, and again every few seconds until the server has it. The
// server keeps one copy for every browser and device; each save names the
// revision it was based on, so a page that fell behind is told instead of
// overwriting newer work, and open pages pick up changes made elsewhere.

let saveTimer;
function save() {
  dirty = true;
  edits++;
  stash();
  showSave('pending', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}

function stash() {
  try { localStorage.setItem(STASH, JSON.stringify({ base: rev, client: clientId, at: Date.now(), doc })); } catch { /* storage off: the server copy is all there is */ }
}
function readStash() {
  try { return JSON.parse(localStorage.getItem(STASH)); } catch { return null; }
}
function dropStash(onlyOurs = true) {
  try { if (!onlyOurs || (readStash() || {}).client === clientId) localStorage.removeItem(STASH); } catch { /* storage off */ }
}

function flush() {
  clearTimeout(saveTimer);
  if (saving) return saving;
  if (!dirty) return Promise.resolve();
  saving = (async () => {
    let conflicts = 0;
    while (dirty) {
      const sent = edits;
      const body = JSON.stringify({ ...doc, rev, savedBy: clientId });
      try {
        // keepalive lets a save started as the page closes still arrive.
        const res = await api('/api/layouts', { method: 'PUT', body, keepalive: body.length < 60000 });
        rev = res.rev;
        if (edits === sent) { dirty = false; dropStash(); } else stash();
      } catch (e) {
        if (e.status === 409 && e.body && typeof e.body.rev === 'number' && ++conflicts <= 3) {
          // Saved elsewhere since this page loaded. This page's changes are
          // the newest, but keep any layout made there in the meantime.
          rev = e.body.rev;
          for (const l of migrate(e.body.doc).layouts) {
            if (!doc.layouts.some((x) => x.id === l.id) && !deletedLayouts.has(l.id)) doc.layouts.push(l);
          }
          stash();
          renderLayouts();
          continue;
        }
        showSave('error', `Not saved: ${e.message}`);
        return;
      }
    }
    showSave('saved', 'Saved');
  })().finally(() => { saving = null; });
  return saving;
}

function showSave(state, text) {
  const el = $('saveState');
  el.dataset.state = state;
  el.textContent = text;
  el.title = state === 'error' ? `${text}. Kept in this browser; retrying every few seconds.` : '';
}

// Changes from another browser or device, while this page has none of its own.
async function pull() {
  if (!doc || dirty || saving || compositor.drag || document.hidden) return;
  let res;
  try { res = await api(`/api/layouts?since=${rev}`); } catch { return; }
  if (!res.doc || res.rev === rev || dirty || saving || compositor.drag) return;
  adopt(res.doc, res.rev);
}

function adopt(saved, savedRev) {
  const shown = doc.active;
  doc = migrate(saved);
  rev = savedRev;
  if (doc.layouts.some((l) => l.id === shown)) doc.active = shown;       // this window keeps its layout
  if (!active().sources.some((s) => s.id === compositor.selected)) compositor.selected = null;
  compositor.prune(allSources());
  if (!allSources().some((s) => s.type === 'screen')) mixer.remove('screen');
  allSources().filter((s) => s.type === 'camera').forEach(startCamera);
  for (const id of [...mixer.strips.keys()]) if (id !== 'screen' && !doc.audio.some((a) => a.id === id)) mixer.remove(id);
  for (const a of doc.audio) mixer.set(a.id, a);
  mixer.set('screen', doc.screenAudio);
  for (const id of missingAudio.keys()) if (!doc.audio.some((a) => a.id === id)) missingAudio.delete(id);
  openSavedAudio();
  renderAll();
}

const saveSplits = () => api('/api/splits', { method: 'PUT', body: JSON.stringify(timer.run) }).catch((e) => showStatus({ state: 'error', message: `Splits not saved: ${e.message}` }));

// ------------------------------------------------------------------ menus

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu.anchor.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

/** A drop-down under `anchor`. Items: { label, run, checked?, action?, danger? } or '-'. */
function showMenu(anchor, items) {
  const again = openMenu && openMenu.anchor === anchor;
  closeMenu();
  if (again) return;                    // a second click on the button closes it
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === '-') { el.append(document.createElement('hr')); continue; }
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: item.label, title: item.label });
    b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
    if (item.action) b.dataset.action = item.action;
    if (item.danger) b.className = 'danger';
    b.addEventListener('click', () => { closeMenu(); item.run(); });
    el.append(b);
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const below = r.bottom + 4 + el.offsetHeight <= innerHeight;
  el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - el.offsetWidth - 4))}px`;
  el.style.top = `${below ? r.bottom + 4 : Math.max(4, r.top - 4 - el.offsetHeight)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor };
  (el.querySelector('[aria-checked="true"]') || el.querySelector('button')).focus();
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (!openMenu) return;
  if (e.key === 'Escape') { const { anchor } = openMenu; closeMenu(); anchor.focus(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const buttons = [...openMenu.el.querySelectorAll('button')];
  const i = buttons.indexOf(document.activeElement);
  buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
});
addEventListener('resize', closeMenu);

// A click on the dim area around a dialog closes it.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
}

// ---------------------------------------------------------------- devices

async function devices(kind) {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  if (list.length && !list[0].label) {
    // Labels only appear once permission has been granted; ask once, then list.
    const probe = await navigator.mediaDevices.getUserMedia(kind === 'videoinput' ? { video: true } : { audio: true });
    probe.getTracks().forEach((t) => t.stop());
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  }
  return list;
}

function startCamera(src) {
  const feed = compositor.feed(src);
  if (['idle', 'error', 'ended'].includes(feed.status)) {
    feed.stop();
    feed.open(() => openCamera(src.deviceId, src.name)).then(() => { renderSources(); renderGreen(); });
  }
  return feed;
}

function startScreen() {
  // Must run straight from the click: the browser only allows the picker in a user gesture.
  const src = active().sources.find((s) => s.type === 'screen');
  if (!src) return;
  const feed = compositor.feed(src);
  feed.stop();
  feed.open(openScreen).then(() => {
    if (feed.stream && feed.stream.getAudioTracks().length) {
      mixer.add('screen', feed.stream, { label: 'Screen audio', owned: false, ...doc.screenAudio });
      feed.stream.getVideoTracks()[0].addEventListener('ended', () => { mixer.remove('screen'); renderMixer(); renderSources(); });
    }
    renderSources(); renderMixer();
  });
}

async function openSavedAudio(retry = false) {
  for (const input of doc.audio) {
    if (mixer.strips.has(input.id) || (!retry && missingAudio.has(input.id))) continue;
    try {
      const stream = await openAudioInput(input.deviceId, input.label);
      if (!doc.audio.some((a) => a.id === input.id)) { stream.getTracks().forEach((t) => t.stop()); continue; }
      mixer.add(input.id, stream, { ...input, label: inputName(input, stream) });
      missingAudio.delete(input.id);
    } catch (e) {
      missingAudio.set(input.id, audioProblem(e));
    }
  }
  renderMixer();
}

// The default microphone shows which device it is on this computer.
function inputName(input, stream) {
  if (input.deviceId !== DEFAULT_MIC) return input.label;
  const track = stream.getAudioTracks()[0];
  const device = track ? track.label.replace(/^Default( - )?/i, '').trim() : '';
  return device ? `Default mic · ${device}` : 'Default mic';
}

// Why an input could not be opened, in words that say what to do.
function audioProblem(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'blocked. Allow the microphone for this site (icon in the address bar)';
  if (name === 'NotReadableError' || name === 'AbortError') return 'could not be opened. Another app may be using it, or the system cannot';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return NOT_HERE;
  return (error && error.message) || 'could not be opened';
}

// ---------------------------------------------------------------- layouts

function renderLayouts() {
  $('layoutName').textContent = active().name;
}

function switchLayout(id) {
  if (id === doc.active) return;
  doc.active = id;
  compositor.select(null);
  active().sources.filter((s) => s.type === 'camera').forEach(startCamera);
  save();
  renderAll();
}

$('layoutButton').addEventListener('click', () => showMenu($('layoutButton'), [
  ...doc.layouts.map((l) => ({ label: l.name, checked: l.id === doc.active, run: () => switchLayout(l.id) })),
  '-',
  { label: 'New layout…', action: 'new', run: newLayout },
  { label: 'Duplicate', action: 'duplicate', run: duplicateLayout },
  { label: 'Rename…', action: 'rename', run: renameLayout },
  { label: 'Delete', action: 'delete', danger: true, run: deleteLayout },
  '-',
  { label: settings.hasKey ? 'Twitch stream key ✓' : 'Twitch stream key…', action: 'key', run: openKeyDialog },
  '-',
  { label: 'Log out', action: 'logout', run: () => $('logoutForm').submit() },
]));

function newLayout() {
  const name = (prompt('Name for the new layout', `Layout ${doc.layouts.length + 1}`) || '').trim();
  if (!name) return;
  const layout = { id: uid(), name, sources: [] };
  doc.layouts.push(layout);
  switchLayout(layout.id);
}

function duplicateLayout() {
  const copy = structuredClone(active());
  copy.id = uid();
  copy.name += ' copy';
  copy.sources.forEach((s) => { s.id = uid(); });
  doc.layouts.push(copy);
  switchLayout(copy.id);
}

function renameLayout() {
  const name = (prompt('Layout name', active().name) || '').trim();
  if (name) { active().name = name; save(); renderLayouts(); }
}

function deleteLayout() {
  if (doc.layouts.length < 2) { alert('Keep at least one layout.'); return; }
  if (!confirm(`Delete the layout "${active().name}"?`)) return;
  deletedLayouts.add(doc.active);
  doc.layouts = doc.layouts.filter((l) => l !== active());
  compositor.prune(allSources());
  switchLayout(doc.layouts[0].id);
}

// ---------------------------------------------------------------- sources

function addSource(src) {
  active().sources.push(src);
  compositor.select(src.id);
  save();
}

$('addCamera').addEventListener('click', async (e) => {
  const anchor = e.currentTarget;
  let cams;
  try { cams = await devices('videoinput'); } catch (err) { alert(`Could not open a video device: ${err.message}`); return; }
  if (!cams.length) { alert('No video devices found. Plug in the camera or capture card and try again.'); return; }
  if (cams.length === 1) { addCamera(cams[0]); return; }
  const used = new Set(active().sources.map((s) => s.deviceId));
  showMenu(anchor, cams.map((c) => ({ label: `${c.label || 'Video device'}${used.has(c.deviceId) ? ' (in this layout)' : ''}`, run: () => addCamera(c) })));
});

function addCamera(cam) {
  const { width: W, height: H } = doc.output;
  const src = {
    id: uid(), type: 'camera', name: cam.label || 'Video device', visible: true,
    deviceId: cam.deviceId, x: W / 4, y: H / 4, w: W / 2, h: H / 2, chroma: { ...CHROMA_DEFAULTS },
  };
  addSource(src);
  fitWhenReady(src, startCamera(src));
}

$('addScreen').addEventListener('click', () => {
  if (!active().sources.some((s) => s.type === 'screen')) {
    const { width: W, height: H } = doc.output;
    addSource({ id: uid(), type: 'screen', name: 'Screen', visible: true, x: 0, y: 0, w: W, h: H });
  }
  startScreen();
});

$('addTimer').addEventListener('click', () => {
  const existing = active().sources.find((s) => s.type === 'timer');
  if (existing) { bringToFront(existing); compositor.select(existing.id); return; }
  addSource(timerSource(doc.output.width, doc.output.height));
});

// Once the device reports its size, give the box the video's shape.
function fitWhenReady(src, feed, tries = 40) {
  if (feed.ready) { resetSize(src); return; }
  if (tries > 0 && feed.status !== 'error') setTimeout(() => fitWhenReady(src, feed, tries - 1), 150);
}

function resetSize(src) {
  const feed = compositor.feeds.get(feedKey(src));
  if (!feed || !feed.ready) return;
  src.h = Math.round(src.w * (feed.video.videoHeight / feed.video.videoWidth));
  save();
}

function bringToFront(src) {
  const list = active().sources;
  if (list[list.length - 1] === src) return;
  list.splice(list.indexOf(src), 1);
  list.push(src);
  save();
}

function renderSources() {
  const list = $('sourceList');
  const sources = [...active().sources].reverse();     // front-most at the top, like OBS
  list.replaceChildren(...sources.map((src) => {
    const li = document.createElement('li');
    li.className = (src.id === compositor.selected ? 'selected ' : '') + (src.visible ? '' : 'hidden-source');
    li.dataset.type = src.type;
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: src.name, title: src.name });
    const button = (text, title, fn) => {
      const b = Object.assign(document.createElement('button'), { textContent: text, title });
      b.setAttribute('aria-label', `${title} ${src.name}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    li.append(button(src.visible ? 'Hide' : 'Show', src.visible ? 'Hide' : 'Show', () => { src.visible = !src.visible; save(); renderSources(); }), name);
    const feed = src.type === 'timer' ? null : compositor.feeds.get(feedKey(src));
    if (src.type === 'screen' && !(feed && feed.status === 'live')) li.append(button('Share', 'Share a screen for', startScreen));
    if (src.type === 'camera' && feed && ['error', 'ended'].includes(feed.status)) {
      name.title = feed.error || 'The device stopped.';
      li.append(button('Retry', `${name.title} Try again:`, () => startCamera(src)));
    }
    li.append(
      button('↑', 'Bring forward', () => move(src, 1)),
      button('↓', 'Send backward', () => move(src, -1)),
      button('✕', 'Remove', () => remove(src)),
    );
    // The timer comes to the front when picked here, so nothing covers it.
    li.addEventListener('click', () => { if (src.type === 'timer') bringToFront(src); compositor.select(src.id); });
    return li;
  }));
}

function move(src, delta) {
  const list = active().sources;
  const i = list.indexOf(src);
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  save();
  renderSources();
}

function remove(src) {
  if (!confirm(`Remove "${src.name}"?`)) return;
  active().sources = active().sources.filter((s) => s !== src);
  if (compositor.selected === src.id) compositor.select(null);
  compositor.prune(allSources());
  if (!allSources().some((s) => s.type === 'screen')) { mixer.remove('screen'); renderMixer(); }
  save();
  renderSources();
  renderGreen();
}

// ------------------------------------------------------------ green screen

// The selected camera, or else the first one in the layout.
function greenTarget() {
  const sel = selected();
  return sel && sel.type === 'camera' ? sel : active().sources.find((s) => s.type === 'camera');
}

function renderGreen() {
  const cam = greenTarget();
  const usable = !!cam && compositor.keyingAvailable;
  for (const id of ['greenOn', 'greenColor', 'greenUpload']) $(id).disabled = !usable;
  $('greenName').textContent = cam && active().sources.filter((s) => s.type === 'camera').length > 1 ? cam.name : '';
  $('greenHint').hidden = usable;
  $('greenHint').textContent = cam ? 'This browser has no WebGL, so keying is unavailable.' : 'Add a video device to key out its green screen.';
  $('greenOn').checked = !!(cam && cam.chroma.enabled);
  $('greenColor').value = cam ? cam.chroma.color : CHROMA_DEFAULTS.color;
  $('greenUpload').textContent = cam && cam.chroma.background ? 'Change background' : 'Upload background';
  $('greenClear').hidden = !(usable && cam.chroma.background);
}

$('greenOn').addEventListener('change', (e) => {
  const cam = greenTarget();
  if (cam) { cam.chroma.enabled = e.target.checked; save(); }
});
$('greenColor').addEventListener('input', (e) => {
  const cam = greenTarget();
  if (cam) { cam.chroma.color = e.target.value; save(); }
});
$('greenUpload').addEventListener('click', () => { const cam = greenTarget(); if (cam) uploadBackground(cam); });
$('greenClear').addEventListener('click', () => {
  const cam = greenTarget();
  if (!cam) return;
  cam.chroma.background = null;
  cam.chroma.backgroundType = null;
  save();
  renderGreen();
});

function uploadBackground(src) {
  pickFile('image/*,video/*', async (file) => {
    $('greenUpload').disabled = true;
    $('greenUpload').textContent = 'Uploading…';
    try {
      const { url } = await api('/api/media', { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
      src.chroma.background = url;
      src.chroma.backgroundType = file.type.startsWith('video/') ? 'video' : 'image';
      src.chroma.enabled = true;
      save();
    } catch (e) {
      alert(`Upload failed: ${e.message}`);
    }
    renderGreen();
  });
}

function pickFile(accept, onFile) {
  const input = $('fileInput');
  input.accept = accept;
  input.value = '';
  input.onchange = () => { if (input.files[0]) onFile(input.files[0]); };
  input.click();
}

// ------------------------------------------------------------------ audio

function btn(text, fn, className = '') {
  const b = Object.assign(document.createElement('button'), { textContent: text, className });
  b.addEventListener('click', fn);
  return b;
}

function renderMixer() {
  const host = $('mixer');
  const strips = [...mixer.strips.values()];
  const missing = doc.audio.filter((a) => missingAudio.has(a.id) && !mixer.strips.has(a.id));
  $('audioPaused').hidden = !strips.length || mixer.ctx.state === 'running';
  if (!strips.length && !missing.length) {
    host.innerHTML = '<p class="hint">No audio yet: add a mic or capture card, or share a screen with sound.</p>';
    return;
  }
  const name = (text) => Object.assign(document.createElement('span'), { className: 'name', textContent: text, title: text });
  const hasDefault = doc.audio.some((a) => a.deviceId === DEFAULT_MIC);
  host.replaceChildren(
    ...strips.map((strip) => {
      const div = document.createElement('div');
      div.className = strip.muted ? 'strip is-muted' : 'strip';
      // Up to four times louder: a laptop's built-in mic is quiet without processing.
      const gain = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 4, step: 0.01, value: strip.gain, title: 'Volume' });
      gain.setAttribute('aria-label', `${strip.label} volume`);
      gain.addEventListener('input', () => { mixer.set(strip.id, { gain: Number(gain.value) }); remember(strip); });
      const mute = btn(strip.muted ? 'Muted' : 'Mute', () => { mixer.set(strip.id, { muted: !strip.muted }); remember(strip); renderMixer(); }, strip.muted ? 'muted' : '');
      const drop = strip.id === 'screen' ? document.createElement('span')
        : btn('✕', () => { mixer.remove(strip.id); doc.audio = doc.audio.filter((a) => a.id !== strip.id); save(); renderMixer(); });
      drop.title = 'Remove';
      const meter = document.createElement('div');
      meter.className = 'meter';
      meter.title = 'Level (it moves even while muted)';
      meter.append(Object.assign(document.createElement('i'), { id: `meter-${strip.id}` }));
      div.append(name(strip.label), mute, drop, gain, meter);
      return div;
    }),
    ...missing.map((a) => {
      const div = document.createElement('div');
      div.className = 'strip missing';
      div.append(name(`${a.label}: ${missingAudio.get(a.id)}`));
      // A mic saved on another computer: this computer's default one instead.
      if (missingAudio.get(a.id) === NOT_HERE && a.deviceId !== DEFAULT_MIC && !hasDefault) {
        div.append(btn('Use default mic', () => {
          Object.assign(a, { deviceId: DEFAULT_MIC, label: 'Default microphone' });
          missingAudio.delete(a.id);
          save();
          openSavedAudio(true);
        }));
      }
      div.append(btn('Retry', () => openSavedAudio(true)),
        btn('Forget', () => { doc.audio = doc.audio.filter((x) => x !== a); missingAudio.delete(a.id); save(); renderMixer(); }));
      return div;
    }),
  );
}

function remember(strip) {
  if (strip.id === 'screen') doc.screenAudio = { gain: strip.gain, muted: strip.muted };
  else {
    const saved = doc.audio.find((a) => a.id === strip.id);
    if (saved) Object.assign(saved, { gain: strip.gain, muted: strip.muted });
  }
  save();
}

$('addAudio').addEventListener('click', async (e) => {
  const anchor = e.currentTarget;
  await mixer.resume();
  let inputs;
  try {
    inputs = await devices('audioinput');
  } catch (err) {
    alert(`The microphone ${audioProblem(err)}.`);
    return;
  }
  const used = new Set(doc.audio.map((a) => a.deviceId));
  const choices = [];
  if (!used.has(DEFAULT_MIC)) choices.push({ deviceId: DEFAULT_MIC, label: 'Default microphone' });
  // Chrome also lists the default and communications devices under those ids.
  for (const d of inputs) if (d.deviceId && !['default', 'communications'].includes(d.deviceId) && !used.has(d.deviceId)) choices.push(d);
  if (!choices.length) { alert('Every audio input is already in the mixer.'); return; }
  showMenu(anchor, choices.map((d) => ({ label: d.deviceId === DEFAULT_MIC ? 'Default microphone (this computer’s)' : d.label || 'Audio input', run: () => addAudioInput(d) })));
});

async function addAudioInput(device) {
  const entry = { id: uid(), deviceId: device.deviceId, label: device.label || 'Audio input', gain: 1, muted: false };
  try {
    const stream = await openAudioInput(entry.deviceId, entry.label);
    mixer.add(entry.id, stream, { ...entry, label: inputName(entry, stream) });
    doc.audio.push(entry);
    save();
    renderMixer();
  } catch (e) {
    alert(`${entry.label} ${audioProblem(e)}.`);
  }
}

// ------------------------------------------------------------------ timer

function timerAction(action) {
  const result = action === 'split' ? timer.split()
    : action === 'undo' ? timer.undo()
    : action === 'skip' ? timer.skip()
    : action === 'pause' ? timer.pause()
    : action === 'reset' && timer.phase !== 'idle' ? (timer.reset(), 'reset') : null;
  if (result === 'finish' || result === 'reset') saveSplits();
  renderTimer();
}

function renderTimer() {
  $('timerGame').textContent = timer.run.game;
  $('timerCategory').textContent = timer.run.category;
  $('timerSplit').textContent = { idle: 'Start', running: 'Split', paused: 'Split', ended: 'Finished' }[timer.phase];
  $('timerPause').textContent = timer.phase === 'paused' ? 'Resume' : 'Pause';
  $('hotkeysButton').title = `Hotkeys: split ${doc.hotkeys.split || '—'}, reset ${doc.hotkeys.reset || '—'}, undo ${doc.hotkeys.undo || '—'}`;
}

$('timerSplit').addEventListener('click', () => timerAction('split'));
$('timerUndo').addEventListener('click', () => timerAction('undo'));
$('timerSkip').addEventListener('click', () => timerAction('skip'));
$('timerPause').addEventListener('click', () => timerAction('pause'));
$('timerReset').addEventListener('click', () => {
  if (timer.phase === 'running' && !confirm('Reset the run? Golds you set are kept.')) return;
  timerAction('reset');
});

$('splitsImport').addEventListener('click', () => {
  if (timer.run.attempts && !confirm('Importing replaces the current splits. Export them first if you want to keep them. Continue?')) return;
  pickFile('.lss,application/xml,text/xml', async (file) => {
    try {
      timer.load(parseLss(await file.text()));
      saveSplits();
      renderTimer();
    } catch (e) {
      alert(e.message);
    }
  });
});

$('splitsExport').addEventListener('click', () => {
  const blob = new Blob([buildLss(timer.run)], { type: 'application/xml' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `${timer.run.game} - ${timer.run.category}.lss`.replace(/[\\/:*?"<>|]/g, ''),
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('splitsEdit').addEventListener('click', () => {
  $('editGame').value = timer.run.game;
  $('editCategory').value = timer.run.category;
  $('editSegments').value = timer.run.segments.map((s) => s.name).join('\n');
  $('splitsDialog').returnValue = '';
  $('splitsDialog').showModal();
});

$('splitsDialog').addEventListener('close', () => {
  if ($('splitsDialog').returnValue !== 'save') return;
  const names = $('editSegments').value.split('\n').map((n) => n.trim()).filter(Boolean);
  if (!names.length) return;
  const old = [...timer.run.segments];
  const segments = names.map((name) => {
    const i = old.findIndex((s) => s.name === name);
    return i >= 0 ? old.splice(i, 1)[0] : { name, pb: null, best: null, comparisons: {} };
  });
  const run = { ...timer.run, game: $('editGame').value.trim() || 'Untitled', category: $('editCategory').value.trim() || 'Any%', segments };
  run.pb = segments[segments.length - 1].pb;
  timer.load(run);
  saveSplits();
  renderTimer();
});

$('hotkeysButton').addEventListener('click', () => {
  $('hotkeyFields').replaceChildren(...Object.entries(HOTKEYS).map(([key, label]) => {
    const input = Object.assign(document.createElement('input'), { value: doc.hotkeys[key], readOnly: true, id: `hotkey-${key}` });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Escape') return;
      e.preventDefault();
      input.value = e.key === 'Backspace' || e.key === 'Delete' ? '' : e.code;
    });
    const l = document.createElement('label');
    l.append(label, input);
    return l;
  }));
  $('hotkeysDialog').returnValue = '';
  $('hotkeysDialog').showModal();
});

$('hotkeysDialog').addEventListener('close', () => {
  if ($('hotkeysDialog').returnValue !== 'save') return;
  for (const key of Object.keys(HOTKEYS)) doc.hotkeys[key] = $(`hotkey-${key}`).value;
  save();
  renderTimer();
});

// Hotkeys work while this tab has focus: a USB numpad next to the controller is enough.
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog') || e.repeat || openMenu) return;
  const action = Object.keys(HOTKEYS).find((k) => doc.hotkeys[k] === e.code);
  if (action) { e.preventDefault(); timerAction(action); }
});

// ------------------------------------------------------------- stream key

function openKeyDialog() {
  const input = $('streamKey');
  input.value = '';
  input.setCustomValidity('');
  input.placeholder = settings.hasKey ? 'Saved. Paste a new key to replace it' : 'Twitch stream key';
  $('keyDialog').showModal();
  input.focus();
}

$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('streamKey');
  const key = input.value.trim();
  if (!key && settings.hasKey) { $('keyDialog').close(); return; }
  try {
    if (!key) throw new Error('Paste the key from your Twitch Creator Dashboard: Settings → Stream.');
    settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ streamKey: key }) })).settings;
    input.value = '';
    $('keyDialog').close();
  } catch (err) {
    input.setCustomValidity(err.message);
    input.reportValidity();
  }
});
$('streamKey').addEventListener('input', (e) => e.target.setCustomValidity(''));

// ------------------------------------------------------------------ live

$('streamButton').addEventListener('click', async () => {
  if (streamer.live) { if (confirm('Stop streaming?')) streamer.stop(); return; }
  if (!(await hasKey())) { openKeyDialog(); return; }
  await mixer.resume();
  streamer.start({ ...doc.output });
});

// The key may have been saved in another window since this one loaded.
async function hasKey() {
  if (!settings.hasKey) settings = (await api('/api/state').catch(() => ({ settings }))).settings;
  return settings.hasKey;
}

// "Go live" from a hub dashboard (HUB_ORIGIN on the server, the six7 hub). The
// hub opens this studio in a window of its own; when the page is ready it says
// so to the window that opened it, and only a message from the hub's origin
// starts the stream. A link alone never starts anything.
function hubLink(hubOrigin) {
  if (!hubOrigin) return;
  window.addEventListener('message', async (event) => {
    if (event.origin !== hubOrigin || !event.data || event.data.type !== 'six7-golive') return;
    const reply = (state) => {
      try { event.source.postMessage({ type: 'six7-golive-ack', state }, hubOrigin); } catch { /* hub closed */ }
    };
    if (streamer.live) { reply('already-live'); return; }
    reply(await goLive());
  });
  if (window.opener) {
    try { window.opener.postMessage({ type: 'six7-studio-ready' }, hubOrigin); } catch { /* opener gone */ }
  }
}

// Start as if "Start streaming" was clicked. Browsers keep sound off until a
// page has been clicked once; if that is why the mixer is still asleep, one
// full-window button asks for the click instead of streaming silence.
async function goLive() {
  if (!(await hasKey())) { openKeyDialog(); return 'needs-key'; }
  await Promise.race([mixer.resume(), new Promise((resolve) => setTimeout(resolve, 500))]);
  if (mixer.ctx.state !== 'running') {
    $('goLiveOverlay').hidden = false;
    $('goLiveNow').focus();
    return 'needs-click';
  }
  streamer.start({ ...doc.output });
  return 'starting';
}

$('goLiveNow').addEventListener('click', async () => {
  $('goLiveOverlay').hidden = true;
  await mixer.resume();
  if (!streamer.live) streamer.start({ ...doc.output });
});
$('goLiveCancel').addEventListener('click', () => { $('goLiveOverlay').hidden = true; });

function showStatus({ state, message, kbps, seconds, backlog }) {
  const el = $('streamStatus');
  el.dataset.state = state;
  if (state === 'live' && seconds !== undefined) {
    const behind = backlog > 4 * 1024 * 1024 ? ' · upload falling behind' : '';
    el.textContent = `LIVE · ${fmt(seconds).padStart(5, '0')} · ${kbps} kb/s${behind}`;
  } else if (message) {
    el.textContent = message;
  }
  el.title = message || '';
  const button = $('streamButton');
  const on = state === 'live' || state === 'connecting';
  button.textContent = on ? 'Stop streaming' : 'Start streaming';
  button.className = on ? 'live' : 'primary';
}

window.addEventListener('beforeunload', (e) => {
  if (streamer.live) { e.preventDefault(); e.returnValue = ''; }
});
// Leaving or hiding the page sends what is unsaved straight away; coming back
// fetches what other devices saved meanwhile.
window.addEventListener('pagehide', () => { if (dirty) flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (dirty) flush(); } else pull(); });
window.addEventListener('focus', pull);

// ------------------------------------------------------------------ boot

function renderAll() {
  renderLayouts();
  renderSources();
  renderGreen();
  renderMixer();
  renderTimer();
}

function tick() {
  const snap = timer.snapshot();
  $('timerClock').textContent = fmt(snap.time, 2);
  const levels = mixer.levels();
  for (const [id, peak] of Object.entries(levels)) {
    const bar = document.getElementById(`meter-${id}`);
    if (!bar) continue;
    // -60 dBFS to 0 dBFS across the bar, so a quiet mic still shows.
    bar.style.width = `${peak > 0.001 ? Math.min(100, ((20 * Math.log10(peak) + 60) / 60) * 100) : 0}%`;
    bar.classList.toggle('clip', peak >= 0.99);
  }
}

// Changes that never reached the server (the page closed, the network or the
// sign-in dropped) come back, as long as nothing newer was saved since.
function unsavedChanges(saved) {
  const pending = readStash();
  if (!pending || !pending.doc || !Array.isArray(pending.doc.layouts)) return null;
  const serverRev = (saved && saved.rev) || 0;
  const nothingSince = pending.base === serverRev;
  const ourSaveLanded = saved && saved.savedBy === pending.client && serverRev === pending.base + 1;
  return nothingSince || ourSaveLanded ? pending.doc : null;
}

async function boot() {
  const state = await api('/api/state');
  settings = state.settings;
  rev = (state.layouts && state.layouts.rev) || 0;
  const unsaved = unsavedChanges(state.layouts);
  doc = migrate(unsaved || state.layouts);
  if (unsaved) { save(); } else dropStash(false);
  timer.load(state.splits);
  compositor.resize(doc.output.width, doc.output.height);
  compositor.start();
  renderAll();
  // Devices come back on their own once the browser remembers the permission.
  allSources().filter((s) => s.type === 'camera').forEach(startCamera);
  openSavedAudio();
  setInterval(tick, 100);
  // Autosave: retry anything unsaved, and pick up other devices' changes.
  setInterval(() => { if (dirty) flush(); else pull(); }, 5000);
  // Browsers keep sound off until the page is used: any click or key starts it.
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => mixer.resume(), true);
  mixer.ctx.addEventListener('statechange', renderMixer);
  hubLink(settings.hubOrigin);
}

boot().catch((e) => showStatus({ state: 'error', message: e.message }));

// For the console, and for tests.
window.studio = {
  get doc() { return doc; }, get rev() { return rev; }, get dirty() { return dirty; },
  timer, mixer, compositor, streamer, flush, pull, save,
};
