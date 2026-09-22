// Boot: wire the document, the compositor, the mixer, the timer and the UI
// together, then hand control to the event bus.

import { $, $$, el, bus, toast, fmtHMS, clamp } from './core/util.js';
import { api, setCsrf } from './core/api.js';
import { store } from './core/state.js';
import { Compositor, TransformLayer } from './core/compositor.js';
import { mixer } from './core/audio.js';
import { OutputManager } from './core/output.js';
import { getRuntime, stopAllRuntimes } from './core/sources.js';
import { timer, PHASE } from './timer/timer.js';
import { LiveSplitLink } from './timer/livesplit-link.js';
import { hotkeys } from './timer/hotkeys.js';
import { initPanels } from './ui/panels.js';
import { initTimerPanel } from './ui/timerpanel.js';
import {
  openSettings, openDestinations, openSplits, openOverlays,
  openHotkeys, openHelp, openLiveSplitConnect,
} from './ui/dialogs.js';
import { closeModal } from './ui/modal.js';

const boot = window.STUDIO_BOOT || {};
setCsrf(boot.csrf);

const compositor = new Compositor(store, timer);
const link = new LiveSplitLink(timer);
const output = new OutputManager(compositor, mixer, store);
const ctx = { store, compositor, mixer, output, timer, link, hotkeys, boot };

async function main() {
  await store.load();
  compositor.attach($('#programCanvas'), $('#previewCanvas'));
  compositor.start();

  const panels = initPanels(ctx);
  const timerPanel = initTimerPanel(ctx);

  // Editing targets whichever canvas shows the scene being edited.
  new TransformLayer($('#editLayer'), $('#programCanvas'), store, compositor, () => store.editScene());

  restoreSplits();
  applyStudioMode();
  wireMenu(panels, timerPanel);
  wireTransitions();
  wireHotkeys();
  wireStats();
  wireLifecycle();

  if (store.get().timer.link.mode && store.get().timer.link.mode !== 'off') {
    link.connect(store.get().timer.link.url, store.get().timer.link.mode);
  }
  toast('Studio ready', 'ok');
}

async function restoreSplits() {
  const id = store.get().timer.splitsId;
  if (!id) return;
  try {
    const run = (await api.getSplits(id)).run;
    timer.load(run);
  } catch (e) {
    // Splits may have been deleted server-side; the blank timer still works.
    store.update((d) => { d.timer.splitsId = ''; });
  }
}

function wireMenu(panels, timerPanel) {
  const actions = Object.assign({}, panels.actions, timerPanel.actions, {
    'open-settings': () => openSettings(ctx),
    'open-splits': () => openSplits(ctx),
    'open-destinations': () => openDestinations(ctx),
    'open-overlays': () => openOverlays(ctx),
    'open-hotkeys': () => openHotkeys(ctx),
    'open-help': () => openHelp(ctx),
    'timer-connect': () => openLiveSplitConnect(ctx),
    'modal-close': closeModal,
    'toggle-stream': toggleStream,
    'toggle-record': toggleRecord,
    'toggle-lowpower': () => {
      store.update((d) => { d.lowPower = !d.lowPower; });
      $('#btnLowPower').textContent = 'Low power: ' + (store.get().lowPower ? 'on' : 'off');
    },
    'do-transition': doTransition,
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = actions[target.dataset.action];
    if (!action) return;
    event.preventDefault();
    // Any click is a user gesture: a good moment to unlock audio.
    mixer.resume?.();
    action(event);
  });

  bus.on('ui:open-splits', () => openSplits(ctx));

  $('#logoutLink').addEventListener('click', async (event) => {
    event.preventDefault();
    if (output.streaming && !confirm('You are live. Sign out anyway?')) return;
    await api.logout().catch(() => {});
    location.href = 'login.php';
  });

  $('#btnLowPower').textContent = 'Low power: ' + (store.get().lowPower ? 'on' : 'off');
}

function wireTransitions() {
  const type = $('#transitionType');
  const duration = $('#transitionDuration');
  const durationOut = $('#transitionDurationOut');
  const studio = $('#studioModeToggle');
  const doc = store.get();
  type.value = doc.transition.type;
  duration.value = doc.transition.duration;
  durationOut.textContent = doc.transition.duration + ' ms';
  studio.checked = !!doc.studioMode;

  type.addEventListener('change', () => store.update((d) => { d.transition.type = type.value; }));
  duration.addEventListener('input', () => {
    durationOut.textContent = duration.value + ' ms';
    store.update((d) => { d.transition.duration = Number(duration.value); });
  });
  studio.addEventListener('change', () => {
    store.update((d) => {
      d.studioMode = studio.checked;
      if (d.studioMode) d.previewScene = d.activeScene;
      else d.previewScene = d.activeScene;
    });
    applyStudioMode();
  });
}

function applyStudioMode() {
  const on = !!store.get().studioMode;
  $('#viewPreview').hidden = !on;
  $('#btnTransition').disabled = !on;
  $('#btnTransition').title = on ? 'Send preview to program' : 'Turn on studio mode to use this';
  compositor.resize();
}

function doTransition() {
  const doc = store.get();
  if (!doc.studioMode) return;
  compositor.transitionTo(doc.previewScene, doc.transition);
}

function wireHotkeys() {
  hotkeys.setBindings(store.get().timer.hotkeys);
  bus.on('hotkey', (action) => {
    switch (action) {
      case 'split': timer.split(); link.command('split'); break;
      case 'reset': if (timer.phase !== PHASE.IDLE && confirm('Reset the run?')) { timer.reset(true); link.command('reset'); } break;
      case 'undo': timer.undo(); link.command('undo'); break;
      case 'skip': timer.skip(); link.command('skip'); break;
      case 'pause': timer.pause(); link.command('pause'); break;
    }
  });
  // Scene hotkeys: Ctrl+1..9 switch scenes, the one shortcut every streamer
  // reaches for without looking.
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const index = parseInt(event.key, 10);
    if (Number.isNaN(index) || index < 1) return;
    const scene = store.get().scenes[index - 1];
    if (!scene) return;
    event.preventDefault();
    compositor.transitionTo(scene.id, store.get().transition);
  });
}

function wireStats() {
  const fpsNode = $('#statFps');
  const droppedNode = $('#statDropped');
  const bitrateNode = $('#statBitrate');
  const renderNode = $('#statRender');
  const uptimeNode = $('#statUptime');
  const liveNode = $('#statLive');

  bus.on('compositor:stats', ({ fps, skipped, renderMs }) => {
    fpsNode.textContent = String(fps);
    droppedNode.textContent = String(skipped);
    renderNode.textContent = renderMs.toFixed(1);
    const target = compositor.targetFps();
    fpsNode.style.color = fps < target * 0.8 ? 'var(--warn)' : '';
  });

  bus.on('output:bitrate', (kbps) => { bitrateNode.textContent = String(kbps); });

  bus.on('output:state', () => {
    const state = output.state();
    liveNode.dataset.state = state.streaming ? 'live' : state.recording ? 'rec' : 'off';
    liveNode.textContent = state.streaming ? 'LIVE' : state.recording ? 'REC' : 'OFFLINE';
    $('#btnStream').textContent = state.streaming ? 'Stop streaming' : 'Start streaming';
    $('#btnStream').classList.toggle('live', state.streaming);
    $('#btnRecord').textContent = state.recording && !state.streaming ? 'Stop recording' : 'Start recording';
    $('#outputHint').textContent = hintFor(store.get().output.mode);
  });

  setInterval(() => {
    const state = output.state();
    uptimeNode.textContent = state.streaming || state.recording ? fmtHMS(state.uptime) : '00:00:00';
  }, 1000);

  bus.on('doc:saveError', (e) => { toast('Could not save layout: ' + e.message, 'err'); });
  bus.on('source:error', ({ message }) => toast(message, 'err'));
  bus.on('source:ended', (id) => toast('A capture was stopped by the browser.', 'err'));
  bus.on('relay:congested', () => toast('Relay is behind — dropping a chunk. Lower the bitrate.', 'err'));

  $('#outputHint').textContent = hintFor(store.get().output.mode);
}

function hintFor(mode) {
  if (mode === 'record') return 'Recording writes a file to this computer when you stop.';
  if (mode === 'whip') return 'WHIP sends one WebRTC stream to the endpoint in Settings → Output.';
  return 'The relay fans one stream out to every enabled destination.';
}

async function toggleStream() {
  if (output.streaming) { await output.stopStream(); return; }
  const mode = store.get().output.mode;
  if (mode === 'record') {
    toast('Output mode is "record" — use Start recording, or pick a streaming mode in Settings.');
    return;
  }
  await mixer.resume();
  try {
    await output.startStream(async () => {
      const res = await api.relayTicket({
        video: store.get().canvas,
        audio: { bitrate: store.get().output.audioBitrate },
      });
      return { ticket: res.ticket, relay: res.relay };
    });
  } catch (e) { /* already reported */ }
}

async function toggleRecord() {
  await mixer.resume();
  if (output.recording) output.stopRecording();
  else await output.startRecording();
}

function wireLifecycle() {
  window.addEventListener('beforeunload', (event) => {
    if (output.streaming || output.recording) {
      event.preventDefault();
      event.returnValue = 'You are still live.';
      return event.returnValue;
    }
    if (store.dirty) store.save();
  });

  // Save on tab hide: mobile and low-memory machines kill background tabs.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && store.dirty) store.save();
  });

  window.addEventListener('resize', () => bus.emit('doc:changed', store.get()));
}

main().catch((e) => {
  console.error(e);
  toast('Studio failed to start: ' + e.message, 'err');
});
