import { Timer, parseLss, buildLss, fmt } from './timer.js';
import { Compositor, feedKey, openCamera, openScreen } from './compositor.js';
import { Mixer, openAudioInput } from './mixer.js';
import { Streamer } from './stream.js';
import { SplitsStore } from './splits-store.js';
import { MediaPlayer, mediaDefaults } from './media-player.js';

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const HOTKEYS = { split: 'Split / start', undo: 'Undo', skip: 'Skip', pause: 'Pause', reset: 'Reset' };
// Similarity and smoothness are relative to the key colour: 0 is the key, 1 is
// grey. These defaults key a typical green screen and leave people alone.
const CHROMA_DEFAULTS = { enabled: false, color: '#00ff00', similarity: 0.5, smoothness: 0.2, background: null, backgroundType: null };
const TWITCH_INGEST = 'rtmp://ingest.global-contribute.live-video.net/app';

let doc;                  // layouts, audio inputs, output and hotkeys; saved to the server
let settings;             // Twitch settings as the server reports them (never the key itself)
const missingAudio = new Set();
const timer = new Timer();
const mixer = new Mixer();
const compositor = new Compositor($('program'), $('overlay'), {
  layout: () => active(),
  timer,
  fps: () => doc.output.fps,
  onChange: () => save(),
  onSelect: () => { renderSources(); renderGreenscreen(); },
});
const streamer = new Streamer({ canvas: $('program'), mixer, onStatus: showStatus });
const media = new MediaPlayer({ mixer, state: () => doc.media, save, api, changed: mediaChanged });
let speakersPlaying = false, speakerTailTimer;

// ----------------------------------------------------------------- model

function defaultDoc() {
  const id = uid();
  return {
    version: 2,
    revision: 0,
    output: { width: 1280, height: 720, fps: 30, bitrate: 4500 },
    hotkeys: { split: 'Numpad1', undo: 'Numpad8', skip: 'Numpad2', pause: 'Numpad5', reset: 'Numpad3' },
    audio: [],
    media: mediaDefaults(),
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
  const d = { ...base, ...saved, output: { ...base.output, ...saved.output }, hotkeys: { ...base.hotkeys, ...saved.hotkeys } };
  d.media = mediaDefaults(saved.media);
  d.audio = (Array.isArray(d.audio) ? d.audio : []).map((a) => ({ ...a, mode: ['raw', 'echo', 'guard'].includes(a.mode) ? a.mode : 'echo' }));
  if (!d.layouts.some((l) => l.id === d.active)) d.active = d.layouts[0].id;
  for (const l of d.layouts) for (const s of l.sources) if (s.type === 'camera') {
    s.resolution = '1080p';
    s.chroma = { ...CHROMA_DEFAULTS, ...s.chroma, similarity: 0.5, smoothness: 0.2 };
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

const DRAFT_KEY = 'fstream-layout-draft';
let saveTimer, saving, savedDoc, syncing = false;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const content = (value) => { const { revision, ...rest } = value; return rest; };
const dirty = () => doc && !same(content(doc), content(savedDoc));

function saveState(message, state = 'saved') {
  $('saveStatus').textContent = message;
  $('saveStatus').dataset.state = state;
}

function cacheDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ doc, base: savedDoc })); } catch { /* Server saves still work without browser storage. */ }
}

function clearDraft(snapshot) {
  try {
    const cached = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (cached && same(content(cached.doc), content(snapshot))) localStorage.removeItem(DRAFT_KEY);
  } catch { /* Storage may be unavailable. */ }
}

function save() {
  if (!doc) return;
  cacheDraft();
  saveState('Saving...', 'pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(), 350);
}

// Merge independent edits; keep both versions when two browsers edit a layout.
function recoverLayouts(local, base, remote) {
  const merged = structuredClone(remote);
  const ids = new Map();
  let recovered = false;
  for (const layout of local.layouts) {
    const original = base.layouts.find((l) => l.id === layout.id);
    const other = remote.layouts.find((l) => l.id === layout.id);
    if (same(layout, original) || same(layout, other)) continue;
    if (same(other, original)) {
      merged.layouts = merged.layouts.filter((l) => l.id !== layout.id);
      merged.layouts.push(structuredClone(layout));
    } else {
      const copy = structuredClone(layout);
      copy.id = uid();
      copy.name += ' (recovered)';
      copy.sources.forEach((s) => { s.id = uid(); });
      merged.layouts.push(copy);
      ids.set(layout.id, copy.id);
      recovered = true;
    }
  }
  for (const original of base.layouts) {
    if (!local.layouts.some((l) => l.id === original.id)) {
      merged.layouts = merged.layouts.filter((l) => l.id !== original.id || !same(l, original));
    }
  }
  for (const key of ['output', 'hotkeys', 'audio', 'screenAudio', 'media', 'active']) {
    if (!same(local[key], base[key])) merged[key] = structuredClone(local[key]);
  }
  if (ids.has(local.active)) merged.active = ids.get(local.active);
  if (!merged.layouts.length) merged.layouts = structuredClone(local.layouts);
  if (!merged.layouts.some((l) => l.id === merged.active)) merged.active = merged.layouts[0].id;
  return { doc: merged, recovered };
}

function applyDocument(next) {
  doc = next;
  compositor.select(null);
  compositor.resize(doc.output.width, doc.output.height);
  compositor.prune(allSources());
  active().sources.filter((s) => s.type === 'camera').forEach(startCamera);
  for (const id of mixer.strips.keys()) if (id !== 'screen' && id !== 'media') mixer.remove(id);
  mixer.set('screen', doc.screenAudio);
  media.restore();
  missingAudio.clear();
  openSavedAudio();
  renderAll();
}

async function flush(keepalive = false) {
  clearTimeout(saveTimer);
  if (!doc) return;
  // A closing page can send the newest draft even while an older save is pending.
  // The revision check prevents either request from overwriting a newer save.
  if (saving) {
    if (keepalive && dirty()) {
      cacheDraft();
      api('/api/layouts', { method: 'PUT', body: JSON.stringify(doc), keepalive: true }).catch(() => {});
    }
    return saving;
  }
  if (!dirty()) { clearDraft(doc); return; }
  saving = (async () => {
    let conflicts = 0;
    while (dirty()) {
      const snapshot = structuredClone(doc);
      cacheDraft();
      saveState('Saving...', 'pending');
      try {
        const result = await api('/api/layouts', { method: 'PUT', body: JSON.stringify(snapshot), keepalive });
        savedDoc = { ...snapshot, revision: result.revision };
        doc.revision = result.revision;
        clearDraft(snapshot);
        saveState('Saved');
      } catch (e) {
        if (e.status === 409 && conflicts++ < 3) {
          const remote = migrate(e.body.layouts);
          const merged = recoverLayouts(doc, savedDoc, remote);
          savedDoc = structuredClone(remote);
          applyDocument(merged.doc);
          cacheDraft();
          if (merged.recovered) $('saveStatus').title = 'Edits from another browser were kept. Your changes are in a recovered layout.';
          continue;
        }
        saveState('Save pending', 'error');
        $('saveStatus').title = e.message;
        return;
      }
    }
    clearDraft(doc);
    saveState('Saved');
  })();
  try { await saving; } finally { saving = null; }
}

async function syncLayouts() {
  if (!doc || document.hidden || syncing || saving) return;
  if (dirty()) { await flush(); return; }
  if (streamer.live) return;
  syncing = true;
  const revision = doc.revision;
  try {
    const state = await api('/api/state');
    if (!dirty() && !saving && doc.revision === revision && state.layouts && state.layouts.revision > revision) {
      savedDoc = migrate(state.layouts);
      applyDocument(structuredClone(savedDoc));
      saveState('Saved');
    }
    settings = state.settings;
  } catch { /* Pending edits retry on the next autosave or reconnect. */ }
  finally { syncing = false; }
}
const splitStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};
const splitsStore = new SplitsStore({
  put: (run, keepalive) => api('/api/splits', { method: 'PUT', body: JSON.stringify(run), keepalive }),
  storage: splitStorage,
  onStatus: ({ state, message }) => {
    $('splitsStatus').textContent = message;
    $('splitsStatus').dataset.state = state;
    $('splitsConflict').hidden = state !== 'conflict';
  },
});
const saveSplits = () => splitsStore.update(timer.run);

$('splitsKeepLocal').addEventListener('click', () => {
  if (confirm('Replace the saved splits with this browser’s version? Export the saved version from the other browser first if you want to keep it.')) splitsStore.keepLocal();
});
$('splitsLoadRemote').addEventListener('click', () => {
  if (!confirm('Load the saved splits and discard this browser’s unsaved changes and current attempt? Export your splits first if you want to keep them.')) return;
  const run = splitsStore.loadRemote();
  if (run) { timer.load(run); renderTimer(); }
});

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
  if (feed.status === 'idle' || feed.status === 'error') {
    feed.open(() => openCamera(src.deviceId, '1080p')).then(() => { renderSources(); renderGreenscreen(); });
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
      feed.stream.getVideoTracks()[0].addEventListener('ended', () => { mixer.remove('screen'); renderMixer(); });
    }
    renderSources(); renderGreenscreen(); renderMixer();
  });
}

async function openSavedAudio() {
  for (const input of doc.audio) {
    try {
      mixer.add(input.id, await openAudioInput(input.deviceId, input.mode), input);
      missingAudio.delete(input.id);
      syncInputProtection();
    } catch {
      missingAudio.add(input.id);
    }
  }
  renderMixer();
}

// ---------------------------------------------------------------- layouts

function renderLayouts() {
  $('workspaceName').textContent = active().name;
  $('layoutList').replaceChildren(...doc.layouts.map((layout) => {
    const button = btn(layout.name, () => switchLayout(layout.id));
    button.setAttribute('aria-pressed', String(layout.id === doc.active));
    return button;
  }));
  $('layoutDelete').disabled = doc.layouts.length < 2;
}

function switchLayout(id) {
  doc.active = id;
  compositor.select(null);
  active().sources.filter((s) => s.type === 'camera').forEach(startCamera);
  save();
  renderAll();
}

$('workspaceMenu').addEventListener('click', (e) => {
  if (e.target.closest('button')) $('workspaceMenu').open = false;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#workspaceMenu')) $('workspaceMenu').open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('workspaceMenu').open) {
    $('workspaceMenu').open = false;
    $('workspaceMenu').querySelector('summary').focus();
  }
});
$('layoutNew').addEventListener('click', () => {
  const name = prompt('Name for the new layout', `Layout ${doc.layouts.length + 1}`);
  if (!name) return;
  const layout = { id: uid(), name, sources: [] };
  doc.layouts.push(layout);
  switchLayout(layout.id);
});
$('layoutCopy').addEventListener('click', () => {
  const copy = structuredClone(active());
  copy.id = uid();
  copy.name += ' copy';
  copy.sources.forEach((s) => { s.id = uid(); });
  doc.layouts.push(copy);
  switchLayout(copy.id);
});
$('layoutRename').addEventListener('click', () => {
  const name = prompt('Layout name', active().name);
  if (name) { active().name = name; save(); renderLayouts(); }
});
$('layoutDelete').addEventListener('click', () => {
  if (doc.layouts.length < 2) { alert('Keep at least one layout.'); return; }
  if (!confirm(`Delete the layout "${active().name}"?`)) return;
  doc.layouts = doc.layouts.filter((l) => l !== active());
  compositor.prune(allSources());
  switchLayout(doc.layouts[0].id);
});

// ---------------------------------------------------------------- sources

function addSource(src) {
  active().sources.push(src);
  compositor.select(src.id);
  save();
  renderSources();
  renderGreenscreen();
}

$('addCamera').addEventListener('click', async () => {
  try {
    const cams = await devices('videoinput');
    if (!cams.length) { alert('No video devices found. Plug in the camera or capture card and try again.'); return; }
    const used = new Set(active().sources.map((s) => s.deviceId));
    const preferred = cams.find((c) => !used.has(c.deviceId)) || cams[0];
    const pick = cams.length === 1 ? 1 : Number(prompt(`Video device\n\n${cams.map((c, i) => `${i + 1}. ${c.label || 'Camera'}`).join('\n')}`, String(cams.indexOf(preferred) + 1)));
    const cam = cams[pick - 1];
    if (!cam) return;
    const { width: W, height: H } = doc.output;
    const src = {
      id: uid(), type: 'camera', name: cam.label || 'Video device', visible: true,
      deviceId: cam.deviceId, resolution: '1080p', x: W / 4, y: H / 4, w: W / 2, h: H / 2,
      chroma: { ...CHROMA_DEFAULTS },
    };
    addSource(src);
    const feed = startCamera(src);
    fitWhenReady(src, feed);
  } catch (e) {
    alert(`Could not open a video device: ${e.message}`);
  }
});

$('addScreen').addEventListener('click', () => {
  if (!active().sources.some((s) => s.type === 'screen')) {
    const { width: W, height: H } = doc.output;
    addSource({ id: uid(), type: 'screen', name: 'Screen', visible: true, x: 0, y: 0, w: W, h: H });
  }
  startScreen();
});

$('addTimer').addEventListener('click', () => {
  const existing = active().sources.find((s) => s.type === 'timer');
  if (existing) { selectSource(existing); return; }
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

function renderSources() {
  const list = $('sourceList');
  const sources = [...active().sources].reverse();     // front-most at the top, like OBS
  list.replaceChildren(...sources.map((src) => {
    const li = document.createElement('li');
    li.className = (src.id === compositor.selected ? 'selected ' : '') + (src.visible ? '' : 'hidden-source');
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: src.name });
    const button = (text, title, fn) => {
      const b = Object.assign(document.createElement('button'), { textContent: text, title });
      b.setAttribute('aria-label', `${title} ${src.name}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    li.append(
      button(src.visible ? 'Hide' : 'Show', src.visible ? 'Hide' : 'Show', () => { src.visible = !src.visible; save(); renderSources(); }),
      name,
      button('↑', 'Bring forward', () => move(src, 1)),
      button('↓', 'Send backward', () => move(src, -1)),
      button('✕', 'Remove', () => remove(src)),
    );
    li.tabIndex = 0;
    li.setAttribute('aria-label', src.name);
    li.addEventListener('click', () => selectSource(src));
    li.addEventListener('keydown', (e) => {
      if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectSource(src); }
    });
    const feed = src.type !== 'timer' && compositor.feeds.get(feedKey(src));
    if (feed && (feed.status === 'error' || feed.status === 'ended')) {
      li.title = feed.error || 'Source disconnected';
      li.append(button('Reconnect', 'Reconnect', () => reconnectSource(src)));
    }
    return li;
  }));
}

function selectSource(src) {
  if (src.type === 'timer') {
    active().sources = active().sources.filter((s) => s !== src);
    active().sources.push(src);
    src.visible = true;
    save();
  }
  compositor.select(src.id);
}

async function reconnectSource(src) {
  if (src.type === 'screen') { startScreen(); return; }
  try {
    const cams = await devices('videoinput');
    if (!cams.length) throw new Error('No video devices found.');
    const matching = cams.find((c) => c.label === src.name) || cams[0];
    const index = cams.length === 1 ? 0 : Number(prompt(`Video device\n\n${cams.map((c, i) => `${i + 1}. ${c.label || 'Camera'}`).join('\n')}`, String(cams.indexOf(matching) + 1))) - 1;
    if (!cams[index]) return;
    src.deviceId = cams[index].deviceId;
    src.name = cams[index].label || src.name;
    compositor.prune(allSources());
    startCamera(src);
    save();
  } catch (e) { alert(e.message); }
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
}

// ----------------------------------------------------------- green screen

function field(label, input) {
  const l = document.createElement('label');
  l.append(label, input);
  return l;
}

function control(tag, props = {}, onInput) {
  const el = Object.assign(document.createElement(tag), props);
  if (onInput) el.addEventListener(tag === 'select' ? 'change' : 'input', () => onInput(el));
  return el;
}

function btn(text, fn, className = '') {
  const b = Object.assign(document.createElement('button'), { textContent: text, className });
  b.addEventListener('click', fn);
  return b;
}

function renderGreenscreen() {
  const host = $('greenscreen');
  const src = selected();
  const camera = src?.type === 'camera' ? src : null;
  const c = camera?.chroma || CHROMA_DEFAULTS;
  const disabled = !camera || !compositor.keyingAvailable;
  const on = control('input', { type: 'checkbox', checked: c.enabled, disabled }, (el) => { c.enabled = el.checked; save(); });
  on.setAttribute('aria-label', 'Enable green screen');
  const onLabel = field('Enabled', on);
  onLabel.className = 'check';
  const color = control('input', { type: 'color', value: c.color, disabled, title: 'Key color' }, (el) => { c.color = el.value; save(); });
  color.setAttribute('aria-label', 'Key color');
  const upload = btn('Upload', () => uploadBackground(camera));
  upload.title = 'Upload photo or video';
  upload.disabled = disabled;
  const row = document.createElement('div');
  row.className = 'row green-controls';
  row.append(onLabel, color, upload);
  if (camera && c.background) {
    const remove = btn('×', () => { c.background = null; c.backgroundType = null; save(); renderGreenscreen(); });
    remove.title = 'Remove background';
    remove.setAttribute('aria-label', 'Remove background');
    row.append(remove);
  }
  host.replaceChildren(row);
  host.title = !camera ? 'Select a camera' : !compositor.keyingAvailable ? 'Green screen requires WebGL' : camera.name;
}

function uploadBackground(src) {
  pickFile('image/*,video/*', async (file) => {
    try {
      showStatus({ state: 'connecting', message: 'Uploading…' });
      const { url } = await api('/api/media', { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
      src.chroma.background = url;
      src.chroma.backgroundType = file.type.startsWith('video/') ? 'video' : 'image';
      src.chroma.enabled = true;
      save();
      renderGreenscreen();
      showStatus(streamer.live ? { state: 'live', message: 'LIVE' } : { state: 'offline', message: 'Offline' });
    } catch (e) {
      showStatus({ state: 'error', message: `Upload failed: ${e.message}` });
    }
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

function renderMixer() {
  const host = $('mixer');
  const strips = [...mixer.strips.values()];
  const missing = doc.audio.filter((a) => missingAudio.has(a.id));
  if (!strips.length && !missing.length) {
    host.replaceChildren();
    return;
  }
  host.replaceChildren(
    ...strips.map((strip) => {
      const div = document.createElement('div');
      div.className = 'strip';
      const top = document.createElement('div');
      top.className = 'top';
      const mute = btn(strip.muted ? 'Muted' : 'Mute', () => {
        mixer.set(strip.id, { muted: !strip.muted });
        remember(strip);
        renderMixer();
      }, strip.muted ? 'muted' : '');
      top.append(Object.assign(document.createElement('span'), { className: 'name', textContent: strip.label }), mute);
      if (strip.id !== 'screen' && strip.id !== 'media') top.append(btn('✕', () => { mixer.remove(strip.id); doc.audio = doc.audio.filter((a) => a.id !== strip.id); save(); renderMixer(); }));
      const meter = document.createElement('div');
      meter.className = 'meter';
      meter.append(Object.assign(document.createElement('i'), { id: `meter-${strip.id}` }));
      const gain = control('input', { type: 'range', min: 0, max: 2, step: 0.01, value: strip.gain, title: 'Volume' }, (el) => {
        mixer.set(strip.id, { gain: Number(el.value) });
        remember(strip);
      });
      gain.setAttribute('aria-label', `${strip.label} volume`);
      div.append(top, meter, gain);
      if (strip.media) {
        gain.setAttribute('aria-label', 'Media stream volume');
        gain.title = 'Volume sent to the stream';
        const streamLabel = document.createElement('label');
        streamLabel.className = 'strip-label';
        streamLabel.append('Stream volume', gain);
        div.append(streamLabel);
        const monitor = btn(strip.monitor ? 'Speakers on' : 'Speakers off', () => media.setMonitor(!strip.monitor), strip.monitor ? '' : 'muted');
        monitor.setAttribute('aria-pressed', String(strip.monitor));
        monitor.id = 'mediaSpeakers';
        const speakerVolume = control('input', { type: 'range', min: 0, max: 1, step: 0.01, value: strip.monitorGain }, (el) => {
          doc.media.monitorGain = Number(el.value);
          syncInputProtection();
          mixer.set('media', { monitorGain: Number(el.value) });
          save();
        });
        speakerVolume.setAttribute('aria-label', 'Media speaker volume');
        const label = document.createElement('label');
        label.className = 'strip-label';
        label.append('Speaker volume', speakerVolume);
        div.append(monitor, label);
      } else if (strip.id !== 'screen') {
        const input = doc.audio.find((a) => a.id === strip.id);
        if (input) {
          const mode = document.createElement('select');
          mode.setAttribute('aria-label', `${strip.label} microphone protection`);
          for (const [value, textContent] of [['echo', 'Mic: echo cancellation'], ['guard', 'Mic: mute during speaker playback'], ['raw', 'Raw audio / capture card']]) {
            mode.append(Object.assign(document.createElement('option'), { value, textContent }));
          }
          mode.value = input.mode || 'echo';
          mode.onchange = async () => {
            const next = mode.value;
            mode.disabled = true;
            try {
              // Chromium may resolve applyConstraints without changing its
              // audio processing. Reopen the device with the chosen mode.
              const stream = await openAudioInput(input.deviceId, next);
              if (!doc.audio.includes(input) || mixer.strips.get(strip.id) !== strip) {
                stream.getTracks().forEach((track) => track.stop());
                return;
              }
              input.mode = next;
              mixer.add(input.id, stream, input);
              syncInputProtection();
              save();
            } catch (e) { alert(`Could not change microphone protection: ${e.message}`); }
            renderMixer();
          };
          const status = document.createElement('p');
          status.className = 'protection-status';
          status.textContent = strip.blocked ? 'Mic muted while media plays on speakers'
            : input.mode === 'guard' ? 'Mic will mute during speaker playback'
            : input.mode === 'raw' ? 'Raw input · speaker pickup is possible'
            : strip.track.getSettings().echoCancellation === false ? 'Echo cancellation unavailable · use mute during playback'
            : 'Echo cancellation reduces speaker pickup; results vary by device.';
          div.append(mode, status);
        }
      }
      return div;
    }),
    ...missing.map((a) => {
      const div = document.createElement('div');
      div.className = 'strip';
      div.append(Object.assign(document.createElement('p'), { className: 'error', textContent: `${a.label}: not available` }),
        btn('Try again', openSavedAudio), btn('Forget', () => { doc.audio = doc.audio.filter((x) => x !== a); missingAudio.delete(a.id); save(); renderMixer(); }));
      return div;
    }),
  );
}

function remember(strip) {
  if (strip.id === 'media') Object.assign(doc.media, { gain: strip.gain, muted: strip.muted, monitor: strip.monitor, monitorGain: strip.monitorGain });
  else if (strip.id === 'screen') doc.screenAudio = { gain: strip.gain, muted: strip.muted };
  else {
    const saved = doc.audio.find((a) => a.id === strip.id);
    if (saved) Object.assign(saved, { gain: strip.gain, muted: strip.muted });
  }
  save();
}

$('addAudio').addEventListener('click', async () => {
  await mixer.resume();
  let inputs;
  try { inputs = await devices('audioinput'); } catch (e) { alert(`Microphone permission is needed: ${e.message}`); return; }
  const used = new Set(doc.audio.map((a) => a.deviceId));
  const choices = inputs.filter((d) => !used.has(d.deviceId));
  if (!choices.length) { alert('Every audio input is already in the mixer.'); return; }
  const list = choices.map((d, i) => `${i + 1}. ${d.label || 'Audio input'}`).join('\n');
  const pickIndex = choices.length === 1 ? 1 : Number(prompt(`Which audio input?\n\n${list}`, '1'));
  const device = choices[pickIndex - 1];
  if (!device) return;
  try {
    const entry = { id: uid(), deviceId: device.deviceId, label: device.label || 'Audio input', gain: 1, muted: false, mode: 'echo' };
    mixer.add(entry.id, await openAudioInput(device.deviceId, entry.mode), entry);
    doc.audio.push(entry);
    syncInputProtection();
    save();
    renderMixer();
  } catch (e) {
    alert(`Could not open that input: ${e.message}`);
  }
});

function syncInputProtection() {
  if (!doc) return;
  if (media.speakersActive) {
    clearTimeout(speakerTailTimer);
    speakerTailTimer = null;
    speakersPlaying = true;
  } else if (speakersPlaying && !speakerTailTimer) {
    // Let queued speaker audio and room reverberation finish before reopening.
    speakerTailTimer = setTimeout(() => {
      speakersPlaying = false;
      speakerTailTimer = null;
      syncInputProtection();
      renderMixer();
    }, 600);
  }
  for (const input of doc.audio) mixer.set(input.id, { blocked: input.mode === 'guard' && speakersPlaying });
}

function mediaChanged() {
  if (!doc) return;
  syncInputProtection();
  renderMixer();
}

// ------------------------------------------------------------------ timer

function timerAction(action) {
  const result = action === 'split' ? timer.split()
    : action === 'undo' ? timer.undo()
    : action === 'skip' ? timer.skip()
    : action === 'pause' ? timer.pause()
    : action === 'reset' && timer.phase !== 'idle' ? (timer.reset(), 'reset') : null;
  if (['start', 'finish', 'reset', 'undo-finish'].includes(result)) saveSplits();
  renderTimer();
}

function renderTimer() {
  $('timerGame').textContent = timer.run.game;
  $('timerCategory').textContent = timer.run.category;
  $('timerSplit').textContent = { idle: 'Start', running: 'Split', paused: 'Split', ended: 'Finished' }[timer.phase];
  $('timerPause').textContent = timer.phase === 'paused' ? 'Resume' : 'Pause';
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

// Hotkeys work while this tab has focus: a USB numpad next to the controller is enough.
window.addEventListener('keydown', (e) => {
  if (!doc || document.querySelector('dialog[open]') || e.target.closest('input, textarea, select, dialog') || e.repeat) return;
  const action = Object.keys(HOTKEYS).find((k) => doc.hotkeys[k] === e.code);
  if (action) { e.preventDefault(); timerAction(action); }
});

// --------------------------------------------------------------- settings

$('settingsButton').addEventListener('click', () => {
  $('setIngest').value = settings.ingest;
  $('setTest').checked = settings.testMode;
  $('setResolution').value = `${doc.output.width}x${doc.output.height}`;
  $('setFps').value = String(doc.output.fps);
  $('setBitrate').value = doc.output.bitrate;
  $('settingsError').textContent = '';
  $('settingsDialog').showModal();
});

$('settingsSave').addEventListener('click', async (e) => {
  e.preventDefault();
  const [width, height] = $('setResolution').value.split('x').map(Number);
  if (streamer.live && (width !== doc.output.width || height !== doc.output.height)) {
    $('settingsError').textContent = 'Stop streaming before changing the resolution.';
    return;
  }
  try {
    const body = { ingest: $('setIngest').value.trim() || TWITCH_INGEST, testMode: $('setTest').checked };
    settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) })).settings;
  } catch (err) {
    $('settingsError').textContent = err.message;
    return;
  }
  if (width !== doc.output.width) {
    // Keep the layout proportional when the canvas size changes.
    const k = width / doc.output.width;
    for (const s of allSources()) for (const p of ['x', 'y', 'w', 'h']) s[p] = Math.round(s[p] * k);
  }
  doc.output = { width, height, fps: Number($('setFps').value), bitrate: Math.min(8000, Math.max(500, Number($('setBitrate').value) || 4500)) };
  compositor.resize(width, height);
  save();
  $('settingsDialog').close();
});

$('streamKeyButton').addEventListener('click', () => {
  $('setKey').value = '';
  $('setKey').placeholder = settings.hasKey ? 'Replace saved stream key' : 'Twitch stream key';
  $('setKey').setCustomValidity('');
  $('streamKeyDialog').showModal();
});
$('setKey').addEventListener('input', () => $('setKey').setCustomValidity(''));
$('streamKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('setKey').value.trim();
  if (!key) { $('setKey').setCustomValidity('Enter a stream key.'); $('setKey').reportValidity(); return; }
  $('streamKeySave').disabled = true;
  try {
    settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ streamKey: key }) })).settings;
    $('setKey').value = '';
    $('streamKeyDialog').close();
  } catch (error) {
    $('setKey').setCustomValidity(error.message);
    $('setKey').reportValidity();
  } finally { $('streamKeySave').disabled = false; }
});
$('streamKeyDialog').addEventListener('close', () => { $('setKey').value = ''; });

$('hotkeysButton').addEventListener('click', () => {
  $('hotkeyFields').replaceChildren(...Object.entries(HOTKEYS).map(([key, label]) => {
    const input = control('input', { value: doc.hotkeys[key], readOnly: true, id: `hotkey-${key}` });
    input.title = 'Press a key; Backspace or Delete clears';
    input.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Escape') return;
      e.preventDefault();
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
      const code = ['Backspace', 'Delete'].includes(e.code) ? '' : e.code;
      if (code) for (const other of $('hotkeyFields').querySelectorAll('input')) if (other !== input && other.value === code) other.value = '';
      input.value = code;
    });
    return field(label, input);
  }));
  $('hotkeysDialog').showModal();
});
$('hotkeysForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  for (const key of Object.keys(HOTKEYS)) doc.hotkeys[key] = $(`hotkey-${key}`).value;
  save();
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close('cancel');
  });
}

// ------------------------------------------------------------------ live

$('streamButton').addEventListener('click', async () => {
  if (streamer.live) { if (confirm('Stop streaming?')) streamer.stop(); return; }
  if (!settings.hasKey) { $('streamKeyButton').click(); return; }
  await mixer.resume();
  streamer.start({ ...doc.output });
});

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
  flush(true);
  splitsStore.flush(true);
});
window.addEventListener('pagehide', () => { flush(true); splitsStore.flush(true); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flush(true); splitsStore.flush(true); }
  else { syncLayouts(); splitsStore.flush(); }
});
window.addEventListener('online', () => { flush().then(syncLayouts); splitsStore.flush(); });
window.addEventListener('focus', syncLayouts);

// ------------------------------------------------------------------ boot

function renderAll() {
  renderLayouts();
  renderSources();
  renderGreenscreen();
  renderMixer();
  renderTimer();
}

function tick() {
  const snap = timer.snapshot();
  $('timerClock').textContent = fmt(snap.time, 2);
  const levels = mixer.levels();
  for (const [id, peak] of Object.entries(levels)) {
    const bar = document.getElementById(`meter-${id}`);
    if (bar) bar.style.width = `${Math.min(100, peak * 100)}%`;
  }
}

async function boot() {
  const state = await api('/api/state');
  doc = migrate(state.layouts);
  savedDoc = structuredClone(doc);
  let restored = false;
  try {
    const cached = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (cached?.doc?.layouts?.length && cached?.base?.layouts?.length) {
      const recovered = recoverLayouts(migrate(cached.doc), migrate(cached.base), doc);
      doc = recovered.doc;
      restored = dirty();
    }
  } catch { /* An unavailable or invalid local draft never blocks the server layout. */ }
  settings = state.settings;
  timer.load(splitsStore.initialize(state.splits, state.splitsRevision ?? state.splits?.revision ?? 0));
  compositor.resize(doc.output.width, doc.output.height);
  compositor.start();
  media.restore();
  renderAll();
  // Devices come back on their own once the browser remembers the permission.
  allSources().filter((s) => s.type === 'camera').forEach(startCamera);
  openSavedAudio();
  saveState('Saved');
  if (!state.layouts) {
    // The first default layout also needs a durable server copy.
    savedDoc = { ...savedDoc, layouts: [] };
    save();
  } else if (restored) save();
  else clearDraft(doc);
  setInterval(tick, 100);
  setInterval(syncLayouts, 5000);
  setInterval(() => splitsStore.flush(), 5000);
  splitsStore.flush();
  document.addEventListener('click', () => mixer.resume(), { once: true });
  hubLink(settings.hubOrigin);
}

boot().catch((e) => showStatus({ state: 'error', message: e.message }));

// For the console, and for tests.
window.studio = { get doc() { return doc; }, timer, mixer, media, compositor, streamer, flush };
