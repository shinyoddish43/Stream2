import { Timer, parseLss, buildLss, fmt } from './timer.js';
import { Compositor, feedKey, openCamera, openScreen } from './compositor.js';
import { Mixer, openAudioInput } from './mixer.js';
import { Streamer } from './stream.js';

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const HOTKEYS = { split: 'Split / start', undo: 'Undo', skip: 'Skip', pause: 'Pause', reset: 'Reset' };
// Similarity and smoothness are relative to the key colour: 0 is the key, 1 is
// grey. These defaults key a typical green screen and leave people alone.
const CHROMA_DEFAULTS = { enabled: false, color: '#00ff00', similarity: 0.5, smoothness: 0.2, background: null, backgroundType: null };

let doc;                  // layouts, audio inputs, output and hotkeys; saved to the server
let settings;             // Twitch settings as the server reports them (never the key itself)
const missingAudio = new Set();
const timer = new Timer();
const mixer = new Mixer();
const compositor = new Compositor($('program'), $('overlay'), {
  layout: () => active(),
  timer,
  fps: () => doc.output.fps,
  onChange: () => { save(); renderProps(); },
  onSelect: () => { renderSources(); renderProps(); },
});
const streamer = new Streamer({ canvas: $('program'), mixer, onStatus: showStatus });

// ----------------------------------------------------------------- model

function defaultDoc() {
  const id = uid();
  return {
    version: 2,
    output: { width: 1280, height: 720, fps: 30, bitrate: 4500 },
    hotkeys: { split: 'Numpad1', undo: 'Numpad8', skip: 'Numpad2', pause: 'Numpad5', reset: 'Numpad3' },
    audio: [],
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
  if (!d.layouts.some((l) => l.id === d.active)) d.active = d.layouts[0].id;
  for (const l of d.layouts) for (const s of l.sources) if (s.type === 'camera') s.chroma = { ...CHROMA_DEFAULTS, ...s.chroma };
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
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}
function flush(keepalive = false) {
  clearTimeout(saveTimer);
  return api('/api/layouts', { method: 'PUT', body: JSON.stringify(doc), keepalive }).catch((e) => showStatus({ state: 'error', message: `Not saved: ${e.message}` }));
}
const saveSplits = () => api('/api/splits', { method: 'PUT', body: JSON.stringify(timer.run) }).catch((e) => showStatus({ state: 'error', message: `Splits not saved: ${e.message}` }));

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
    feed.open(() => openCamera(src.deviceId, src.resolution)).then(() => { renderSources(); renderProps(); });
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
    renderSources(); renderProps(); renderMixer();
  });
}

async function openSavedAudio() {
  for (const input of doc.audio) {
    try {
      mixer.add(input.id, await openAudioInput(input.deviceId), input);
      missingAudio.delete(input.id);
    } catch {
      missingAudio.add(input.id);
    }
  }
  renderMixer();
}

// ---------------------------------------------------------------- layouts

function renderLayouts() {
  const select = $('layoutSelect');
  select.replaceChildren(...doc.layouts.map((l) => new Option(l.name, l.id, false, l.id === doc.active)));
}

function switchLayout(id) {
  doc.active = id;
  compositor.select(null);
  active().sources.filter((s) => s.type === 'camera').forEach(startCamera);
  save();
  renderAll();
}

$('layoutSelect').addEventListener('change', (e) => switchLayout(e.target.value));
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
  renderProps();
}

$('addCamera').addEventListener('click', async () => {
  try {
    const cams = await devices('videoinput');
    if (!cams.length) { alert('No video devices found. Plug in the camera or capture card and try again.'); return; }
    const used = new Set(active().sources.map((s) => s.deviceId));
    const cam = cams.find((c) => !used.has(c.deviceId)) || cams[0];
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
  if (existing) { compositor.select(existing.id); return; }
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
    li.addEventListener('click', () => compositor.select(src.id));
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
}

// ------------------------------------------------------------- properties

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

function renderProps() {
  const host = $('props');
  const src = selected();
  if (!src) { host.innerHTML = '<p class="hint">Select a source in the list or on the preview.</p>'; return; }
  const parts = [
    field('Name', control('input', { value: src.name }, (el) => { src.name = el.value; save(); renderSources(); })),
  ];
  const size = document.createElement('div');
  size.className = 'row wrap';
  size.append(
    btn('Fit to canvas', () => { Object.assign(src, { x: 0, y: 0, w: doc.output.width, h: doc.output.height }); save(); }),
    btn('Centre', () => { src.x = Math.round((doc.output.width - src.w) / 2); src.y = Math.round((doc.output.height - src.h) / 2); save(); }),
  );
  if (src.type !== 'timer') size.append(btn('Match video shape', () => resetSize(src)));
  parts.push(size);

  if (src.type === 'camera') parts.push(...cameraProps(src));
  if (src.type === 'screen') {
    const feed = compositor.feeds.get('screen');
    const live = feed && feed.status === 'live';
    parts.push(btn(live ? 'Share a different screen' : 'Share screen', startScreen, live ? '' : 'primary'));
    if (feed && feed.status === 'error') parts.push(Object.assign(document.createElement('p'), { className: 'error', textContent: feed.error }));
  }
  if (src.type === 'timer') parts.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Drag the corners to resize. The timer draws straight into the stream.' }));
  host.replaceChildren(...parts);
}

function cameraProps(src) {
  const parts = [];
  const deviceSelect = control('select', {}, async (el) => {
    src.deviceId = el.value;
    src.name = el.selectedOptions[0].textContent;
    compositor.prune(allSources());
    fitWhenReady(src, startCamera(src));
    save();
    renderSources();
  });
  devices('videoinput').then((cams) => {
    deviceSelect.replaceChildren(...cams.map((c) => new Option(c.label || 'Video device', c.deviceId, false, c.deviceId === src.deviceId)));
  }).catch(() => {});
  parts.push(field('Device', deviceSelect));
  const res = control('select', {}, (el) => { src.resolution = el.value; compositor.prune(allSources()); startCamera(src); save(); });
  res.append(new Option('1920 × 1080', '1080p', false, src.resolution !== '720p'), new Option('1280 × 720', '720p', false, src.resolution === '720p'));
  parts.push(field('Capture resolution', res));
  const feed = compositor.feeds.get(feedKey(src));
  if (feed && feed.status === 'error') parts.push(Object.assign(document.createElement('p'), { className: 'error', textContent: feed.error }), btn('Try again', () => startCamera(src)));

  // --- green screen
  const c = src.chroma;
  const h3 = Object.assign(document.createElement('h3'), { textContent: 'Green screen' });
  parts.push(h3);
  if (!compositor.keyingAvailable) {
    parts.push(Object.assign(document.createElement('p'), { className: 'error', textContent: 'This browser has no WebGL, so keying is unavailable.' }));
    return parts;
  }
  const on = control('input', { type: 'checkbox', checked: c.enabled }, (el) => { c.enabled = el.checked; save(); });
  const onLabel = document.createElement('label');
  onLabel.className = 'check';
  onLabel.append(on, 'Replace the green with a background');
  parts.push(onLabel);

  const color = control('input', { type: 'color', value: c.color }, (el) => { c.color = el.value; save(); });
  const pick = btn('Pick from preview', () => {
    pick.textContent = 'Click the green…';
    compositor.pickColor(src, (hex) => { c.color = hex; color.value = hex; pick.textContent = 'Pick from preview'; save(); });
  });
  const colorRow = document.createElement('div');
  colorRow.className = 'row';
  colorRow.append(color, pick);
  parts.push(field('Key colour', colorRow));

  const slider = (label, key, max) => {
    const out = document.createElement('span');
    out.textContent = ` ${c[key].toFixed(2)}`;
    const input = control('input', { type: 'range', min: 0, max, step: 0.01, value: c[key] }, (el) => {
      c[key] = Number(el.value);
      out.textContent = ` ${c[key].toFixed(2)}`;
      save();
    });
    const l = document.createElement('label');
    l.append(label, out, input);
    return l;
  };
  parts.push(slider('Similarity', 'similarity', 0.9), slider('Smoothness', 'smoothness', 0.5));

  const bgRow = document.createElement('div');
  bgRow.className = 'row wrap';
  bgRow.append(btn(c.background ? 'Replace background…' : 'Upload photo or video…', () => uploadBackground(src)));
  if (c.background) bgRow.append(btn('Remove', () => { c.background = null; c.backgroundType = null; save(); renderProps(); }));
  parts.push(field('Background', bgRow));
  if (!c.background) parts.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'With no background the keyed area is see-through, showing whatever is behind the camera.' }));
  return parts;
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
      renderProps();
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
    host.innerHTML = '<p class="hint">No audio yet. Add your mic or your capture card’s audio, or share a screen with audio.</p>';
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
      if (strip.id !== 'screen') top.append(btn('✕', () => { mixer.remove(strip.id); doc.audio = doc.audio.filter((a) => a.id !== strip.id); save(); renderMixer(); }));
      const meter = document.createElement('div');
      meter.className = 'meter';
      meter.append(Object.assign(document.createElement('i'), { id: `meter-${strip.id}` }));
      const gain = control('input', { type: 'range', min: 0, max: 2, step: 0.01, value: strip.gain, title: 'Volume' }, (el) => {
        mixer.set(strip.id, { gain: Number(el.value) });
        remember(strip);
      });
      gain.setAttribute('aria-label', `${strip.label} volume`);
      div.append(top, meter, gain);
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
  if (strip.id === 'screen') doc.screenAudio = { gain: strip.gain, muted: strip.muted };
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
    const entry = { id: uid(), deviceId: device.deviceId, label: device.label || 'Audio input', gain: 1, muted: false };
    mixer.add(entry.id, await openAudioInput(device.deviceId), entry);
    doc.audio.push(entry);
    save();
    renderMixer();
  } catch (e) {
    alert(`Could not open that input: ${e.message}`);
  }
});

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
  if (e.target.closest('input, textarea, select, dialog') || e.repeat) return;
  const action = Object.keys(HOTKEYS).find((k) => doc.hotkeys[k] === e.code);
  if (action) { e.preventDefault(); timerAction(action); }
});

// --------------------------------------------------------------- settings

$('settingsButton').addEventListener('click', () => {
  $('setKey').value = '';
  $('keyState').textContent = settings.hasKey ? 'A key is saved. Leave blank to keep it.' : 'No key saved yet.';
  $('setIngest').value = settings.ingest;
  $('setTest').checked = settings.testMode;
  $('setResolution').value = `${doc.output.width}x${doc.output.height}`;
  $('setFps').value = String(doc.output.fps);
  $('setBitrate').value = doc.output.bitrate;
  $('settingsError').textContent = '';
  $('hotkeyFields').replaceChildren(...Object.entries(HOTKEYS).map(([key, label]) => {
    const input = control('input', { value: doc.hotkeys[key], readOnly: true, id: `hotkey-${key}` });
    input.addEventListener('keydown', (e) => { e.preventDefault(); input.value = e.code === 'Escape' ? '' : e.code; });
    return field(label, input);
  }));
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
    const body = { ingest: $('setIngest').value.trim() || 'rtmp://live.twitch.tv/app', testMode: $('setTest').checked };
    if ($('setKey').value.trim()) body.streamKey = $('setKey').value.trim();
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
  for (const key of Object.keys(HOTKEYS)) doc.hotkeys[key] = $(`hotkey-${key}`).value;
  compositor.resize(width, height);
  save();
  renderHotkeyHint();
  $('settingsDialog').close();
});

function renderHotkeyHint() {
  $('hotkeyHint').textContent = `Hotkeys (while this tab is focused): split ${doc.hotkeys.split || '—'}, reset ${doc.hotkeys.reset || '—'}, undo ${doc.hotkeys.undo || '—'}.`;
}

// ------------------------------------------------------------------ live

$('streamButton').addEventListener('click', async () => {
  if (streamer.live) { if (confirm('Stop streaming?')) streamer.stop(); return; }
  await mixer.resume();
  streamer.start({ ...doc.output });
});

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
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flush(true); });

// ------------------------------------------------------------------ boot

function renderAll() {
  renderLayouts();
  renderSources();
  renderProps();
  renderMixer();
  renderTimer();
  renderHotkeyHint();
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
  settings = state.settings;
  timer.load(state.splits);
  compositor.resize(doc.output.width, doc.output.height);
  compositor.start();
  renderAll();
  // Devices come back on their own once the browser remembers the permission.
  allSources().filter((s) => s.type === 'camera').forEach(startCamera);
  openSavedAudio();
  setInterval(tick, 100);
  document.addEventListener('click', () => mixer.resume(), { once: true });
}

boot().catch((e) => showStatus({ state: 'error', message: e.message }));

// For the console, and for tests.
window.studio = { get doc() { return doc; }, timer, mixer, compositor, streamer, flush };
