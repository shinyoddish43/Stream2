// Every modal dialog in the studio: source properties, settings, splits,
// destinations, overlays, hotkeys and help.

import { $, el, bus, toast, clamp, fmtTime, pickFile, readFileText, download } from '../core/util.js';
import { api } from '../core/api.js';
import { SOURCE_TYPES, getRuntime, dropRuntime, countdownRemaining, formatCountdown } from '../core/sources.js';
import { mixer } from '../core/audio.js';
import { pickMimeType } from '../core/output.js';
import { parseLss, buildLss, emptyRun } from '../timer/lss.js';
import { openModal, closeModal, field, input, select, checkbox, button, tabs } from './modal.js';

// --------------------------------------------------------- source properties

export function openSourceProperties(ctx, item) {
  const { store, compositor } = ctx;
  const spec = SOURCE_TYPES[item.type] || { label: item.type, hint: '' };
  const body = el('div');
  const apply = () => { store.update(() => {}); getRuntime(item).start?.(); };

  const nameBox = input({ value: item.name, maxlength: 64 });
  nameBox.addEventListener('input', () => { item.name = nameBox.value; apply(); });
  body.appendChild(field('Name', nameBox));

  const transform = el('div', { class: 'grid-2' });
  for (const key of ['x', 'y', 'w', 'h']) {
    const box = input({ type: 'number', value: Math.round(item[key]), step: 1 });
    box.addEventListener('input', () => {
      const value = Number(box.value);
      if (!Number.isNaN(value)) { item[key] = key === 'w' || key === 'h' ? Math.max(8, value) : value; apply(); }
    });
    transform.appendChild(field(key.toUpperCase(), box));
  }
  body.appendChild(el('h3', { text: 'Position' }));
  body.appendChild(transform);

  const opacity = input({ type: 'range', min: 0, max: 1, step: 0.01, value: item.opacity ?? 1 });
  opacity.addEventListener('input', () => { item.opacity = Number(opacity.value); apply(); });
  body.appendChild(field('Opacity', opacity));

  body.appendChild(el('h3', { text: spec.label + ' settings' }));
  body.appendChild(el('p', { class: 'muted', text: spec.hint }));
  body.appendChild(buildTypeSettings(ctx, item, apply));

  openModal({
    title: 'Properties — ' + item.name,
    body,
    footer: [
      button('Fit to canvas', { onclick: () => {
        const canvas = store.get().canvas;
        item.x = 0; item.y = 0; item.w = canvas.w; item.h = canvas.h;
        apply();
      } }),
      button('Reset size', { onclick: () => {
        const size = getRuntime(item).naturalSize?.();
        if (size) { item.w = size.w; item.h = size.h; apply(); } else toast('No natural size for this source');
      } }),
      button('Done', { class: 'btn primary', onclick: closeModal }),
    ],
  });
}

function buildTypeSettings(ctx, item, apply) {
  const s = item.settings = item.settings || {};
  const host = el('div');
  const set = (key, value) => { s[key] = value; apply(); };
  const text = (label, key, placeholder) => {
    const box = input({ value: s[key] ?? '', placeholder: placeholder || '' });
    box.addEventListener('input', () => set(key, box.value));
    return field(label, box);
  };
  const number = (label, key, min, max, step = 1) => {
    const box = input({ type: 'number', value: s[key] ?? min, min, max, step });
    box.addEventListener('input', () => set(key, clamp(Number(box.value), min, max)));
    return field(label, box);
  };
  const colour = (label, key, fallback) => {
    const box = el('input', { type: 'color', value: toHex(s[key] || fallback) });
    box.addEventListener('input', () => set(key, box.value));
    return field(label, box);
  };

  switch (item.type) {
    case 'display':
      host.appendChild(el('p', { class: 'muted', text: 'The browser owns the picker — click re-share to choose a different screen or window.' }));
      host.appendChild(button('Re-share screen…', { onclick: async () => {
        dropRuntime(item.id);
        const runtime = getRuntime(item);
        await runtime.start();
        if (runtime.stream && runtime.stream.getAudioTracks().length) {
          mixer.addStream(runtime.stream, { id: item.id, name: item.name + ' (audio)', kind: 'desktop' });
        }
        apply();
      } }));
      host.appendChild(cropEditor(item, apply));
      break;

    case 'camera': {
      const deviceSelect = select([['', 'Default camera']], s.deviceId);
      navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
        for (const device of devices.filter((d) => d.kind === 'videoinput')) {
          const option = el('option', { value: device.deviceId, text: device.label || 'Camera' });
          if (device.deviceId === s.deviceId) option.selected = true;
          deviceSelect.appendChild(option);
        }
      });
      deviceSelect.addEventListener('change', () => { set('deviceId', deviceSelect.value); dropRuntime(item.id); getRuntime(item).start(); });
      host.appendChild(field('Device', deviceSelect));
      host.appendChild(number('Capture width', 'width', 160, 1920, 16));
      host.appendChild(number('Capture height', 'height', 120, 1080, 16));
      host.appendChild(number('Frame rate', 'frameRate', 5, 60, 1));
      host.appendChild(checkbox('Mirror horizontally', s.mirror !== false, (v) => set('mirror', v)));
      host.appendChild(cropEditor(item, apply));
      break;
    }

    case 'image':
    case 'imagefeed': {
      host.appendChild(text('Image URL', 'url', 'https://…/overlay.png'));
      host.appendChild(button('Use a local file…', { onclick: async () => {
        const file = await pickFile('image/*');
        if (!file) return;
        // Small images are inlined so they survive a reload; big ones stay as
        // an object URL for this session only.
        if (file.size < 512 * 1024) {
          const reader = new FileReader();
          reader.onload = () => { set('url', String(reader.result)); dropRuntime(item.id); getRuntime(item).start(); };
          reader.readAsDataURL(file);
        } else {
          set('url', URL.createObjectURL(file));
          toast('Large file: this image lasts for this session only.');
          dropRuntime(item.id);
        }
      } }));
      const fit = select([['stretch', 'Stretch'], ['contain', 'Fit inside'], ['cover', 'Fill and crop']], s.fit || 'contain');
      fit.addEventListener('change', () => set('fit', fit.value));
      host.appendChild(field('Scaling', fit));
      if (item.type === 'imagefeed') host.appendChild(number('Refresh every (s)', 'interval', 1, 3600, 1));
      break;
    }

    case 'media': {
      host.appendChild(text('Media URL', 'url', 'https://…/stinger.webm'));
      host.appendChild(button('Use a local file…', { onclick: async () => {
        const file = await pickFile('video/*,audio/*');
        if (!file) return;
        set('url', URL.createObjectURL(file));
        dropRuntime(item.id);
        const runtime = getRuntime(item);
        await runtime.start();
        toast('Local media is session-only — re-pick it after a reload.');
      } }));
      host.appendChild(checkbox('Loop', s.loop !== false, (v) => { set('loop', v); getRuntime(item).video.loop = v; }));
      host.appendChild(button('Route audio to the mixer', { onclick: () => {
        const runtime = getRuntime(item);
        mixer.addElement(runtime.video, { id: item.id, name: item.name });
        runtime.video.muted = false;
        toast('Added to the mixer', 'ok');
      } }));
      break;
    }

    case 'color':
      host.appendChild(colour('Colour', 'color', '#101216'));
      host.appendChild(checkbox('Gradient', !!s.gradient, (v) => set('gradient', v)));
      host.appendChild(colour('Second colour', 'color2', '#000000'));
      host.appendChild(number('Corner radius', 'radius', 0, 200, 1));
      break;

    case 'text': {
      const area = el('textarea', { rows: 3, style: { width: '100%' } });
      area.value = s.text || '';
      area.addEventListener('input', () => set('text', area.value));
      host.appendChild(el('label', { class: 'field', style: { gridTemplateColumns: '76px 1fr' } }, [el('span', { text: 'Text' }), area]));
      host.appendChild(el('p', { class: 'muted', text: 'Tokens: {timer} {pb} {sob} {bpt} {game} {category} {attempts} {split} {delta} {clock} {date}' }));
      host.appendChild(number('Size', 'size', 8, 200, 1));
      host.appendChild(colour('Colour', 'color', '#ffffff'));
      host.appendChild(number('Outline', 'outline', 0, 12, 1));
      host.appendChild(colour('Outline colour', 'outlineColor', '#000000'));
      const align = select([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], s.align || 'left');
      align.addEventListener('change', () => set('align', align.value));
      host.appendChild(field('Align', align));
      break;
    }

    case 'countdown': {
      host.appendChild(number('Length (minutes)', 'minutes', 1, 240, 1));
      host.appendChild(text('Prefix', 'prefix', 'Starting in '));
      host.appendChild(text('Text when it hits zero', 'done', "We're live"));
      host.appendChild(number('Size', 'size', 12, 200, 1));
      host.appendChild(colour('Colour', 'color', '#ffffff'));
      const status = el('p', { class: 'muted' });
      const refresh = () => {
        const left = countdownRemaining(s);
        status.textContent = left > 0 ? `Running — ${formatCountdown(left)} left` : 'Not running';
      };
      refresh();
      host.appendChild(el('div', {}, [
        button('Start', { class: 'btn primary', onclick: () => {
          set('endsAt', Date.now() + (Number(s.minutes) || 10) * 60000);
          refresh();
        } }),
        button('Stop', { onclick: () => { set('endsAt', 0); refresh(); } }),
        button('+1 min', { onclick: () => {
          const base = Math.max(Date.now(), Number(s.endsAt) || Date.now());
          set('endsAt', base + 60000);
          refresh();
        } }),
      ]));
      host.appendChild(status);
      break;
    }

    case 'timer':
      host.appendChild(colour('Accent', 'accent', '#4a9eff'));
      host.appendChild(number('Visible splits', 'rows', 1, 30, 1));
      host.appendChild(checkbox('Show game / category', s.showTitle !== false, (v) => set('showTitle', v)));
      host.appendChild(checkbox('Show deltas', s.showDeltas !== false, (v) => set('showDeltas', v)));
      host.appendChild(checkbox('Show sum of best', s.showSob !== false, (v) => set('showSob', v)));
      host.appendChild(el('p', { class: 'muted', text: 'This draws the same splits the dock shows, straight into the canvas — no browser source, no second render.' }));
      break;
  }
  return host;
}

function cropEditor(item, apply) {
  const s = item.settings;
  const host = el('div');
  host.appendChild(el('h3', { text: 'Crop (source pixels)' }));
  const crop = s.crop || { x: 0, y: 0, w: 0, h: 0 };
  const grid = el('div', { class: 'grid-2' });
  for (const key of ['x', 'y', 'w', 'h']) {
    const box = input({ type: 'number', value: crop[key] || 0, min: 0, step: 1 });
    box.addEventListener('input', () => {
      crop[key] = Math.max(0, Number(box.value) || 0);
      s.crop = crop.w > 0 && crop.h > 0 ? crop : null;
      apply();
    });
    grid.appendChild(field(key.toUpperCase(), box));
  }
  host.appendChild(grid);
  host.appendChild(el('p', { class: 'muted', text: 'Leave width/height at 0 for no crop. Cropping in the compositor costs nothing extra.' }));
  return host;
}

const toHex = (value) => (/^#[0-9a-f]{6}$/i.test(String(value)) ? value : '#000000');

// -------------------------------------------------------------- settings

export function openSettings(ctx) {
  const { store, compositor } = ctx;
  const doc = store.get();
  const body = el('div');
  const panels = {};
  const names = ['Video', 'Output', 'Audio', 'Server', 'Account'];
  const host = el('div');
  body.appendChild(tabs(names, (name) => {
    host.innerHTML = '';
    host.appendChild(panels[name]);
  }));
  body.appendChild(host);

  // --- video
  const video = el('div');
  const resolution = select(
    [['1920x1080', '1920 × 1080'], ['1600x900', '1600 × 900'], ['1280x720', '1280 × 720 (recommended)'],
     ['960x540', '960 × 540'], ['854x480', '854 × 480'], ['640x360', '640 × 360 (very low spec)']],
    `${doc.canvas.w}x${doc.canvas.h}`
  );
  resolution.addEventListener('change', () => {
    const [w, h] = resolution.value.split('x').map(Number);
    store.update((d) => { d.canvas.w = w; d.canvas.h = h; });
    compositor.resize();
  });
  video.appendChild(field('Canvas', resolution));
  const fps = select([[60, '60'], [30, '30 (recommended)'], [24, '24'], [20, '20'], [15, '15 (low spec)'], [10, '10']], doc.canvas.fps);
  fps.addEventListener('change', () => store.update((d) => { d.canvas.fps = Number(fps.value); }));
  video.appendChild(field('Frame rate', fps));
  video.appendChild(checkbox('Low power mode (half frame rate, no smoothing)', doc.lowPower, (v) =>
    store.update((d) => { d.lowPower = v; })));
  video.appendChild(el('p', { class: 'muted', text:
    'On a dual-core machine, 720p30 with two or three sources is the sweet spot. Every extra source is another blit per frame.' }));
  const theme = select([['dark', 'Dark'], ['light', 'Light'], ['auto', 'Follow the system']], doc.theme || 'dark');
  theme.addEventListener('change', () => {
    store.update((d) => { d.theme = theme.value; });
    document.documentElement.dataset.theme = theme.value;
  });
  video.appendChild(el('h3', { text: 'Appearance' }));
  video.appendChild(field('Theme', theme));
  video.appendChild(el('p', { class: 'muted', text: 'This is the studio interface only — it never touches what goes out on stream.' }));
  panels.Video = video;

  // --- output
  const output = el('div');
  const mode = select([['record', 'Record to this computer'], ['relay', 'Stream via RTMP relay (multistream)'], ['whip', 'Stream via WHIP (WebRTC)']], doc.output.mode);
  mode.addEventListener('change', () => { store.update((d) => { d.output.mode = mode.value; }); refreshOutputHint(); });
  output.appendChild(field('Mode', mode));
  const bitrate = input({ type: 'number', value: doc.output.bitrate, min: 300, max: 12000, step: 100 });
  bitrate.addEventListener('input', () => store.update((d) => { d.output.bitrate = clamp(Number(bitrate.value), 300, 12000); }));
  output.appendChild(field('Video kb/s', bitrate));
  const audioBitrate = select([[64, '64'], [96, '96'], [128, '128'], [160, '160'], [192, '192']], doc.output.audioBitrate);
  audioBitrate.addEventListener('change', () => store.update((d) => { d.output.audioBitrate = Number(audioBitrate.value); }));
  output.appendChild(field('Audio kb/s', audioBitrate));
  const whipUrl = input({ value: doc.output.whipUrl, placeholder: 'https://…/whip' });
  whipUrl.addEventListener('input', () => store.update((d) => { d.output.whipUrl = whipUrl.value.trim(); }));
  output.appendChild(field('WHIP URL', whipUrl));
  const whipToken = input({ value: doc.output.whipToken, placeholder: 'bearer token (optional)' });
  whipToken.addEventListener('input', () => store.update((d) => { d.output.whipToken = whipToken.value.trim(); }));
  output.appendChild(field('WHIP token', whipToken));
  const recordName = input({ value: doc.output.recordName });
  recordName.addEventListener('input', () => store.update((d) => { d.output.recordName = recordName.value; }));
  output.appendChild(field('File prefix', recordName));
  output.appendChild(checkbox(
    'Write recordings straight to disk (asks where to save; keeps memory flat)',
    doc.output.streamToDisk !== false,
    (v) => store.update((d) => { d.output.streamToDisk = v; })
  ));
  if (typeof window.showSaveFilePicker !== 'function') {
    output.appendChild(el('p', { class: 'muted', text:
      'This browser has no save-to-disk API, so recordings are held in memory until you stop. Chrome or Edge can stream to disk.' }));
  }
  output.appendChild(el('p', { class: 'muted', text: 'Encoder in use: ' + (pickMimeType() || 'none — this browser cannot record') }));
  panels.Output = output;

  // --- audio
  const audio = el('div');
  const master = input({ type: 'range', min: 0, max: 1.5, step: 0.01, value: doc.audio.master ?? 1 });
  master.addEventListener('input', () => { mixer.setMaster(Number(master.value)); store.update((d) => { d.audio.master = Number(master.value); }); });
  audio.appendChild(field('Master', master));
  audio.appendChild(el('p', { class: 'muted', text: 'Inputs live in the mixer dock. Desktop audio arrives with a display capture when the browser prompt offers "share audio".' }));
  panels.Audio = audio;

  // --- server
  const server = el('div');
  const relayUrl = input({ value: ctx.boot.relayUrl || '', placeholder: 'wss://relay.example.com/ingest' });
  const siteName = input({ value: ctx.boot.siteName || 'Stream Studio' });
  server.appendChild(field('Studio name', siteName));
  server.appendChild(field('Relay URL', relayUrl));
  server.appendChild(button('Save server settings', { class: 'btn primary', onclick: async () => {
    try {
      const res = await api.saveSettings({ relay_url: relayUrl.value.trim(), site_name: siteName.value.trim() });
      ctx.boot.relayUrl = relayUrl.value.trim();
      toast('Saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  } }));
  server.appendChild(el('p', { class: 'muted', text: 'The relay is optional. Without it you can still record locally or push to a WHIP endpoint.' }));
  panels.Server = server;

  // --- account
  const account = el('div');
  const currentPw = input({ type: 'password', autocomplete: 'current-password' });
  const nextPw = input({ type: 'password', autocomplete: 'new-password' });
  account.appendChild(field('Current password', currentPw));
  account.appendChild(field('New password', nextPw));
  account.appendChild(button('Change password', { onclick: async () => {
    try { await api.changePassword(currentPw.value, nextPw.value); toast('Password changed', 'ok'); currentPw.value = nextPw.value = ''; }
    catch (e) { toast(e.message, 'err'); }
  } }));
  account.appendChild(el('h3', { text: 'Backup' }));
  account.appendChild(el('p', { class: 'muted', text:
    'A scene collection is one JSON file: scenes, sources, audio and output settings. Take one before you change a working layout.' }));
  account.appendChild(button('Export scene collection', { onclick: () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`stream-studio-layout-${stamp}.json`, JSON.stringify(store.get(), null, 2), 'application/json');
  } }));
  account.appendChild(button('Import scene collection…', { onclick: async () => {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    let incoming;
    try { incoming = JSON.parse(await readFileText(file)); } catch (e) { return toast('That is not valid JSON', 'err'); }
    if (!incoming || !Array.isArray(incoming.scenes) || !incoming.scenes.length) {
      return toast('That file has no scenes in it', 'err');
    }
    if (!confirm(`Replace the current layout with ${incoming.scenes.length} scene(s) from this file?`)) return;
    // Keep the server revision so the save is an update, not a conflict.
    const rev = store.get().rev;
    store.update((d) => Object.assign(incoming, { rev }));
    compositor.resize();
    toast('Layout imported', 'ok');
    closeModal();
  } }));

  account.appendChild(el('h3', { text: 'Danger zone' }));
  account.appendChild(button('Reset the studio layout', { class: 'btn danger', onclick: () => {
    if (!confirm('Delete all scenes and sources and start fresh?')) return;
    localStorage.removeItem('streamstudio.doc.v1');
    location.reload();
  } }));
  panels.Account = account;

  host.appendChild(panels.Video);
  openModal({ title: 'Settings', body, wide: true, footer: [button('Close', { class: 'btn primary', onclick: closeModal })] });
}

function refreshOutputHint() {
  const hint = $('#outputHint');
  if (hint) bus.emit('output:state', null);
}

// ------------------------------------------------------------ destinations

export async function openDestinations(ctx) {
  let destinations = [];
  try { destinations = (await api.getDestinations()).destinations; } catch (e) { toast(e.message, 'err'); }
  const body = el('div');
  const table = el('table', { class: 'grid' });
  const head = el('tr', {}, [
    el('th', { text: 'On' }), el('th', { text: 'Name' }), el('th', { text: 'Service' }),
    el('th', { text: 'RTMP URL' }), el('th', { text: 'Stream key' }), el('th', { text: '' }),
  ]);
  table.appendChild(el('thead', {}, [head]));
  const tbody = el('tbody');
  table.appendChild(tbody);

  const PRESETS = {
    twitch: 'rtmp://live.twitch.tv/app',
    youtube: 'rtmp://a.rtmp.youtube.com/live2',
    kick: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app',
    trovo: 'rtmp://livepush.trovo.live/live',
    custom: '',
  };

  function addRow(dest) {
    const enabled = el('input', { type: 'checkbox' });
    enabled.checked = !!dest.enabled;
    const name = input({ value: dest.name || '' });
    const service = select(Object.keys(PRESETS).map((k) => [k, k]), dest.service || 'custom');
    const url = input({ value: dest.url || '', placeholder: 'rtmp://…' });
    const key = input({ value: dest.hasKey ? '••••••••' : '', type: 'password', placeholder: 'stream key' });
    service.addEventListener('change', () => {
      if (PRESETS[service.value]) url.value = PRESETS[service.value];
      if (!name.value) name.value = service.value;
    });
    const row = el('tr', {}, [
      el('td', {}, [enabled]), el('td', {}, [name]), el('td', {}, [service]),
      el('td', {}, [url]), el('td', {}, [key]),
      el('td', {}, [button('✕', { onclick: () => row.remove() })]),
    ]);
    row._read = () => ({
      id: dest.id, enabled: enabled.checked, name: name.value, service: service.value,
      url: url.value.trim(), key: key.value,
    });
    tbody.appendChild(row);
  }

  destinations.forEach(addRow);
  if (!destinations.length) addRow({ service: 'twitch', url: PRESETS.twitch, name: 'Twitch', enabled: true });

  body.appendChild(el('p', { class: 'muted', text:
    'Keys are encrypted on the server and never sent back to the browser. Enabled destinations all receive the same stream through the relay.' }));
  body.appendChild(table);
  body.appendChild(button('Add destination', { onclick: () => addRow({ service: 'custom' }) }));

  openModal({
    title: 'Stream destinations',
    body,
    wide: true,
    footer: [
      button('Cancel', { onclick: closeModal }),
      button('Save', { class: 'btn primary', onclick: async () => {
        const payload = Array.from(tbody.children).map((row) => row._read());
        try { await api.saveDestinations(payload); toast('Destinations saved', 'ok'); closeModal(); }
        catch (e) { toast(e.message, 'err'); }
      } }),
    ],
  });
}

// ------------------------------------------------------------------ splits

export async function openSplits(ctx) {
  const { timer, store } = ctx;
  const body = el('div');
  const listHost = el('div');
  body.appendChild(el('p', { class: 'muted', text:
    'Import the .lss files you already run with. The studio reads and writes the real LiveSplit format, including golds, comparisons and attempt counts.' }));
  body.appendChild(listHost);

  async function refresh() {
    listHost.innerHTML = '';
    let splits = [];
    try { splits = (await api.listSplits()).splits; } catch (e) { toast(e.message, 'err'); }
    if (!splits.length) {
      listHost.appendChild(el('p', { class: 'muted', text: 'Nothing saved yet.' }));
      return;
    }
    const table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Game' }), el('th', { text: 'Category' }), el('th', { text: 'Splits' }),
      el('th', { text: 'Attempts' }), el('th', { text: 'PB' }), el('th', { text: '' }),
    ])]));
    const tbody = el('tbody');
    for (const entry of splits) {
      tbody.appendChild(el('tr', {}, [
        el('td', { text: entry.game || '—' }),
        el('td', { text: entry.category || '—' }),
        el('td', { text: String(entry.segments) }),
        el('td', { text: String(entry.attempts) }),
        el('td', { text: entry.pb ? fmtTime(entry.pb, { decimals: 0 }) : '—' }),
        el('td', {}, [
          button('Load', { class: 'btn primary', onclick: async () => {
            const run = (await api.getSplits(entry.id)).run;
            timer.load(run);
            store.update((d) => { d.timer.splitsId = entry.id; });
            toast(`Loaded ${run.game} — ${run.category}`, 'ok');
            closeModal();
          } }),
          button('Edit', { onclick: async () => {
            const run = (await api.getSplits(entry.id)).run;
            openSplitEditor(ctx, run, refresh);
          } }),
          button('.lss', { title: 'Download as a LiveSplit file', onclick: async () => {
            const run = (await api.getSplits(entry.id)).run;
            download(`${run.game || 'splits'} - ${run.category || ''}.lss`.trim(), buildLss(run), 'application/xml');
          } }),
          button('✕', { class: 'btn danger', onclick: async () => {
            if (!confirm('Delete these splits?')) return;
            await api.deleteSplits(entry.id);
            refresh();
          } }),
        ]),
      ]));
    }
    table.appendChild(tbody);
    listHost.appendChild(table);
  }

  await refresh();

  openModal({
    title: 'Splits',
    body,
    wide: true,
    footer: [
      button('Import .lss…', { onclick: async () => {
        const file = await pickFile('.lss,application/xml,text/xml');
        if (!file) return;
        try {
          const run = parseLss(await readFileText(file));
          const saved = await api.saveSplits(run);
          toast(`Imported ${run.segments.length} splits`, 'ok');
          await refresh();
        } catch (e) { toast('Import failed: ' + e.message, 'err'); }
      } }),
      button('New splits…', { onclick: () => openSplitEditor(ctx, emptyRun(), refresh) }),
      button('Export current', { onclick: () => {
        const run = timer.exportRun();
        download(`${run.game || 'splits'} - ${run.category || ''}.lss`.trim(), buildLss(run), 'application/xml');
      } }),
      button('Close', { class: 'btn primary', onclick: closeModal }),
    ],
  });
}

export function openSplitEditor(ctx, run, onSaved) {
  const { timer, store } = ctx;
  const working = JSON.parse(JSON.stringify(run));
  const body = el('div');
  const game = input({ value: working.game || '' });
  const category = input({ value: working.category || '' });
  const offset = input({ type: 'number', value: working.offset || 0, step: 0.1 });
  const attempts = input({ type: 'number', value: working.attempts || 0, min: 0, step: 1 });
  body.appendChild(field('Game', game));
  body.appendChild(field('Category', category));
  body.appendChild(field('Start offset (s)', offset, 'negative = countdown'));
  body.appendChild(field('Attempts', attempts));

  const table = el('table', { class: 'grid' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '#' }), el('th', { text: 'Segment' }),
    el('th', { text: 'PB split (s)' }), el('th', { text: 'Gold (s)' }), el('th', { text: '' }),
  ])]));
  const tbody = el('tbody');
  table.appendChild(tbody);

  function addRow(seg = { name: '', pb: null, best: null, comparisons: {} }) {
    const name = input({ value: seg.name || '' });
    const pb = input({ type: 'number', value: seg.pb ?? '', step: 0.01, placeholder: '—' });
    const best = input({ type: 'number', value: seg.best ?? '', step: 0.01, placeholder: '—' });
    const row = el('tr', {}, [
      el('td', { class: 'num', text: String(tbody.children.length + 1) }),
      el('td', {}, [name]),
      el('td', { class: 'num' }, [pb]),
      el('td', { class: 'num' }, [best]),
      el('td', {}, [
        button('↑', { onclick: () => { const prev = row.previousElementSibling; if (prev) tbody.insertBefore(row, prev); renumber(); } }),
        button('↓', { onclick: () => { const next = row.nextElementSibling; if (next) tbody.insertBefore(next, row); renumber(); } }),
        button('✕', { onclick: () => { row.remove(); renumber(); } }),
      ]),
    ]);
    row._read = () => ({
      name: name.value.trim() || 'Split',
      pb: pb.value === '' ? null : Number(pb.value),
      best: best.value === '' ? null : Number(best.value),
      comparisons: seg.comparisons || {},
    });
    tbody.appendChild(row);
  }
  const renumber = () => Array.from(tbody.children).forEach((row, i) => { row.firstChild.textContent = String(i + 1); });

  (working.segments || []).forEach(addRow);
  body.appendChild(el('h3', { text: 'Segments' }));
  body.appendChild(table);
  body.appendChild(button('Add segment', { onclick: () => { addRow(); renumber(); } }));
  body.appendChild(el('p', { class: 'muted', text: 'PB split times are cumulative from the start of the run; golds are per-segment.' }));

  const collect = () => Object.assign(working, {
    game: game.value.trim(),
    category: category.value.trim(),
    offset: Number(offset.value) || 0,
    attempts: Number(attempts.value) || 0,
    segments: Array.from(tbody.children).map((row) => row._read()),
  });

  openModal({
    title: working.id ? 'Edit splits' : 'New splits',
    body,
    wide: true,
    footer: [
      button('Cancel', { onclick: closeModal }),
      button('Save & load', { class: 'btn primary', onclick: async () => {
        const data = collect();
        data.pbTime = data.segments.length ? data.segments[data.segments.length - 1].pb : null;
        try {
          const saved = await api.saveSplits(data);
          data.id = saved.id;
          timer.load(data);
          store.update((d) => { d.timer.splitsId = saved.id; });
          toast('Splits saved', 'ok');
          closeModal();
          if (onSaved) onSaved();
        } catch (e) { toast(e.message, 'err'); }
      } }),
    ],
  });
}

// ----------------------------------------------------------- LiveSplit link

export function openLiveSplitConnect(ctx) {
  const { store, link } = ctx;
  const doc = store.get();
  const body = el('div');
  const url = input({ value: doc.timer.link.url || 'ws://127.0.0.1:16835' });
  const mode = select([['bridge', 'Studio bridge (recommended)'], ['raw', 'Raw LiveSplit Server over a TCP proxy']], doc.timer.link.mode === 'raw' ? 'raw' : 'bridge');
  body.appendChild(el('p', { class: 'muted', text:
    'The built-in timer works on its own. Connect only if you want LiveSplit itself — with its global hotkeys and autosplitters — to drive the splits shown on stream.' }));
  body.appendChild(field('Bridge URL', url));
  body.appendChild(field('Protocol', mode));
  body.appendChild(el('h3', { text: 'How to set it up' }));
  body.appendChild(el('ol', { html: `
    <li>In LiveSplit, right-click → Control → Start Server (the LiveSplit.Server component).</li>
    <li>On the same PC, run <code>node livesplit-bridge.js</code> (or <code>python3 livesplit_bridge.py</code>) from the <code>bridge/</code> folder of this app.</li>
    <li>Leave the URL as <code>ws://127.0.0.1:16835</code> and press Connect.</li>
    <li>A browser on HTTPS will refuse a plain <code>ws://</code> link — open the studio over http:// on the same machine, or give the bridge a certificate and use <code>wss://</code>.</li>
  ` }));

  openModal({
    title: 'Connect LiveSplit',
    body,
    footer: [
      button('Disconnect', { onclick: () => { link.disconnect(); store.update((d) => { d.timer.link.mode = 'off'; }); closeModal(); } }),
      button('Connect', { class: 'btn primary', onclick: () => {
        store.update((d) => { d.timer.link.url = url.value.trim(); d.timer.link.mode = mode.value; });
        link.connect(url.value.trim(), mode.value);
        closeModal();
      } }),
    ],
  });
}

// ---------------------------------------------------------------- overlays

export function openOverlays(ctx) {
  const token = ctx.boot.overlayToken;
  const base = location.href.replace(/[^/]*$/, '');
  const body = el('div');
  body.appendChild(el('p', { class: 'muted', text:
    'These pages are for OBS or a second machine. Inside this studio you do not need them — the timer source draws straight into the canvas.' }));
  const rows = [
    ['Timer overlay', `${base}overlay/timer.html?token=${token}`],
    ['Timer overlay (compact)', `${base}overlay/timer.html?token=${token}&compact=1`],
    ['Splits only', `${base}overlay/timer.html?token=${token}&mode=splits`],
    ['Big clock only', `${base}overlay/timer.html?token=${token}&mode=clock`],
  ];
  for (const [label, url] of rows) {
    const box = input({ value: url, readonly: true });
    body.appendChild(el('div', {}, [
      el('h3', { text: label }),
      el('div', { class: 'copyrow' }, [
        box,
        button('Copy', { onclick: () => { box.select(); navigator.clipboard?.writeText(url); toast('Copied', 'ok'); } }),
        button('Open', { onclick: () => window.open(url, '_blank', 'width=360,height=560') }),
      ]),
    ]));
  }
  body.appendChild(el('h3', { text: 'Token' }));
  body.appendChild(el('p', { class: 'muted', text: 'Anyone with these links can read your timer state. Rotate the token if a link leaks.' }));
  body.appendChild(button('Rotate overlay token', { class: 'btn danger', onclick: async () => {
    if (!confirm('Rotate the token? Existing overlay links will stop working.')) return;
    const res = await api.saveSettings({ rotate_overlay_token: true });
    ctx.boot.overlayToken = res.overlay_token;
    toast('Token rotated — update your browser sources', 'ok');
    closeModal();
  } }));

  openModal({ title: 'Overlay / browser source links', body, footer: [button('Close', { class: 'btn primary', onclick: closeModal })] });
}

// ----------------------------------------------------------------- hotkeys

export function openHotkeys(ctx) {
  const { store, hotkeys } = ctx;
  const doc = store.get();
  const body = el('div');
  body.appendChild(el('p', { class: 'muted', text:
    'Hotkeys work while this tab has focus. For keys that work inside a full-screen game, use LiveSplit with the bridge, or pop the timer out into its own always-on-top window.' }));
  const table = el('table', { class: 'grid' });
  const tbody = el('tbody');
  const labels = { split: 'Split / start', reset: 'Reset', undo: 'Undo split', skip: 'Skip split', pause: 'Pause' };
  for (const [action, label] of Object.entries(labels)) {
    const value = el('span', { class: 'kbd', text: doc.timer.hotkeys[action] || 'unbound' });
    tbody.appendChild(el('tr', {}, [
      el('td', { text: label }),
      el('td', {}, [value]),
      el('td', {}, [
        button('Rebind', { onclick: async () => {
          value.textContent = 'press a key…';
          const code = await hotkeys.capture();
          store.update((d) => { d.timer.hotkeys[action] = code; });
          value.textContent = code || 'unbound';
          hotkeys.setBindings(store.get().timer.hotkeys);
        } }),
        button('Clear', { onclick: () => {
          store.update((d) => { d.timer.hotkeys[action] = ''; });
          value.textContent = 'unbound';
          hotkeys.setBindings(store.get().timer.hotkeys);
        } }),
      ]),
    ]));
  }
  table.appendChild(tbody);
  body.appendChild(table);
  openModal({ title: 'Hotkeys', body, footer: [button('Close', { class: 'btn primary', onclick: closeModal })] });
}


// ----------------------------------------------------------- run history

export async function openHistory(ctx) {
  const body = el('div');
  let runs = [];
  try { runs = (await api.listRuns()).runs; } catch (e) { toast(e.message, 'err'); }

  if (!runs.length) {
    body.appendChild(el('p', { class: 'muted', text: 'No attempts recorded yet. Finish or reset a run and it lands here.' }));
    openModal({ title: 'Attempt history', body, footer: [button('Close', { class: 'btn primary', onclick: closeModal })] });
    return;
  }

  const finished = runs.filter((r) => r.time !== null && r.time !== undefined);
  const best = finished.length ? Math.min.apply(null, finished.map((r) => r.time)) : null;
  const golds = runs.reduce((sum, r) => sum + (r.golds || 0), 0);
  const rate = Math.round((finished.length / runs.length) * 100);

  body.appendChild(el('div', { class: 'stat-row' }, [
    statTile('Attempts', String(runs.length)),
    statTile('Finished', `${finished.length} (${rate}%)`),
    statTile('Best', best === null ? '—' : fmtTime(best, { decimals: 2 })),
    statTile('Golds set', String(golds)),
  ]));

  // Where runs die: the split that ends the most attempts is the one worth
  // practising, so it is worth surfacing rather than making people count.
  const deaths = new Map();
  for (const run of runs) {
    if (run.time !== null && run.time !== undefined) continue;
    const key = run.reachedSplit ?? 0;
    deaths.set(key, (deaths.get(key) || 0) + 1);
  }
  if (deaths.size) {
    const worst = Array.from(deaths.entries()).sort((a, b) => b[1] - a[1])[0];
    const segName = (ctx.timer.segments[worst[0]] || {}).name || `split ${worst[0] + 1}`;
    body.appendChild(el('p', { class: 'muted', text:
      `Most resets happen on "${segName}" — ${worst[1]} of ${runs.length - finished.length}.` }));
  }

  const table = el('table', { class: 'grid' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: 'When' }), el('th', { text: 'Game' }), el('th', { text: 'Category' }),
    el('th', { text: 'Time' }), el('th', { text: 'Result' }),
  ])]));
  const tbody = el('tbody');
  for (const run of runs.slice(0, 200)) {
    const done = run.time !== null && run.time !== undefined;
    tbody.appendChild(el('tr', {}, [
      el('td', { text: run.at ? new Date(run.at).toLocaleString() : '—' }),
      el('td', { text: run.game || '—' }),
      el('td', { text: run.category || '—' }),
      el('td', { text: done ? fmtTime(run.time, { decimals: 2 }) : '—' }),
      el('td', { html: run.isPb ? '<b style="color:var(--gold)">personal best</b>'
        : done ? 'finished' : `reset on split ${(run.reachedSplit || 0) + 1}`
          + (run.golds ? ` · ${run.golds} gold` : '') }),
    ]));
  }
  table.appendChild(tbody);
  body.appendChild(table);

  openModal({
    title: 'Attempt history',
    body,
    wide: true,
    footer: [
      button('Download CSV', { onclick: () => {
        const rows = [['when', 'game', 'category', 'seconds', 'is_pb', 'golds', 'reached_split']]
          .concat(runs.map((r) => [r.at || '', r.game || '', r.category || '', r.time ?? '',
            r.isPb ? 1 : 0, r.golds || 0, r.reachedSplit ?? '']));
        const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
        download('attempt-history.csv', csv, 'text/csv');
      } }),
      button('Close', { class: 'btn primary', onclick: closeModal }),
    ],
  });
}

function statTile(label, value) {
  return el('div', { class: 'stat-tile' }, [
    el('span', { text: label }),
    el('b', { text: value }),
  ]);
}

// -------------------------------------------------------------------- help

export function openHelp(ctx) {
  const body = el('div', { html: `
    <h3>What this is</h3>
    <p>A stream studio that runs in the browser: scenes, sources, an audio mixer, a speedrun timer, and one output — recorded locally, pushed over WHIP, or fanned out to several RTMP services through the optional relay.</p>
    <h3>Keeping the stream clean on old hardware</h3>
    <ul>
      <li>720p30 beats 1080p60 that stutters. Change it in Settings → Video.</li>
      <li>Every visible source costs a blit per frame. Hide what is not on screen.</li>
      <li>Low power mode halves the frame rate and turns off image smoothing.</li>
      <li>Keep this tab visible; a background tab is throttled by the browser (the compositor falls back to a timer, but frames get coarse).</li>
      <li>Prefer the built-in timer source over a browser-source overlay: it is one draw call, not a second page being rendered.</li>
    </ul>
    <h3>The speedrun timer</h3>
    <ul>
      <li>Import your existing <code>.lss</code> splits: Splits → Import. Golds, comparisons and attempt counts come with them.</li>
      <li>The timer keeps the LiveSplit colour rules: green ahead, dark green ahead-but-losing, red behind, orange behind-but-gaining, gold for a new best segment.</li>
      <li>Finishing a run updates the PB; resetting still keeps any golds you set.</li>
      <li>Runs are written back as real <code>.lss</code> files you can open in LiveSplit.</li>
    </ul>
    <h3>Where things are stored</h3>
    <p>Scenes, splits and settings live in <code>data/</code> on your host as plain JSON. Stream keys are encrypted there. Nothing leaves your server except the video you send to your own destinations.</p>
  ` });
  openModal({ title: 'Help', body, wide: true, footer: [button('Close', { class: 'btn primary', onclick: closeModal })] });
}
