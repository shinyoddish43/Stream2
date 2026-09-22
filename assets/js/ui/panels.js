// Scene list, source list, and the audio mixer strips.

import { $, el, bus, toast, clamp } from '../core/util.js';
import { SOURCE_TYPES, makeSource, dropRuntime, getRuntime } from '../core/sources.js';
import { mixer, toDb, openMicrophone, listAudioInputs } from '../core/audio.js';
import { openModal, closeModal, button, select, field, input } from './modal.js';
import { openSourceProperties } from './dialogs.js';

export function initPanels(ctx) {
  const { store, compositor } = ctx;

  // -------------------------------------------------------------- scenes
  function renderScenes() {
    const doc = store.get();
    const host = $('#sceneList');
    host.innerHTML = '';
    for (const scene of doc.scenes) {
      const isProgram = scene.id === doc.activeScene;
      const isPreview = doc.studioMode && scene.id === doc.previewScene;
      const row = el('div', {
        class: 'row-item' + (isPreview || (!doc.studioMode && isProgram) ? ' selected' : ''),
        title: isProgram ? 'On air' : 'Click to ' + (doc.studioMode ? 'preview' : 'switch'),
      }, [
        el('span', { class: 'row-name', text: scene.name }),
        isProgram ? el('span', { class: 'row-sub', text: 'LIVE', style: { color: 'var(--live)' } }) : null,
      ]);
      row.addEventListener('click', () => {
        if (doc.studioMode) store.update((d) => { d.previewScene = scene.id; });
        else compositor.transitionTo(scene.id, doc.transition);
        renderScenes();
        renderSources();
      });
      row.addEventListener('dblclick', () => renameScene(scene));
      host.appendChild(row);
    }
  }

  function renameScene(scene) {
    const box = input({ value: scene.name, maxlength: 48 });
    openModal({
      title: 'Rename scene',
      body: el('div', {}, [field('Name', box)]),
      footer: [
        button('Cancel', { onclick: closeModal }),
        button('Save', { class: 'btn primary', onclick: () => {
          store.update(() => { scene.name = box.value.trim() || scene.name; });
          closeModal();
        } }),
      ],
    });
  }

  // ------------------------------------------------------------- sources
  function editScene() { return store.editScene(); }

  function renderSources() {
    const scene = editScene();
    const host = $('#sourceList');
    host.innerHTML = '';
    if (!scene) return;
    // Top of the list is the front-most layer, matching what you see.
    const ordered = scene.sources.slice().reverse();
    ordered.forEach((item) => {
      const runtime = getRuntime(item);
      const row = el('div', {
        class: 'row-item' + (compositor.selection === item.id ? ' selected' : '') + (item.visible ? '' : ' hidden-src'),
        draggable: 'true',
      }, [
        el('button', {
          class: 'icon eye',
          title: item.visible ? 'Hide' : 'Show',
          text: item.visible ? '👁' : '—',
          onclick: (e) => { e.stopPropagation(); store.update(() => { item.visible = !item.visible; }); },
        }),
        el('span', { class: 'row-name', text: item.name }),
        el('span', { class: 'row-sub', text: runtime.status === 'error' ? '⚠' : (SOURCE_TYPES[item.type]?.label || item.type).split(' ')[0] }),
        el('button', {
          class: 'icon',
          title: item.locked ? 'Unlock' : 'Lock',
          text: item.locked ? '🔒' : '🔓',
          onclick: (e) => { e.stopPropagation(); store.update(() => { item.locked = !item.locked; }); },
        }),
      ]);
      row.addEventListener('click', () => { compositor.select(item.id); renderSources(); });
      row.addEventListener('dblclick', () => openSourceProperties(ctx, item));
      row.addEventListener('dragstart', (e) => {
        row.classList.add('dragging');
        e.dataTransfer.setData('text/plain', item.id);
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-before', 'drop-after');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === item.id) return;
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        // The list is reversed, so "above" in the UI is "later" in the array.
        const targetIndex = scene.sources.indexOf(item) + (before ? 1 : 0);
        store.reorderSource(draggedId, targetIndex);
        renderSources();
      });
      host.appendChild(row);
    });
  }

  function addSourceDialog() {
    const grid = el('div', { class: 'src-picker' });
    for (const [type, spec] of Object.entries(SOURCE_TYPES)) {
      grid.appendChild(el('button', {
        class: 'src-card',
        onclick: async () => {
          closeModal();
          const item = makeSource(type, null, store.get().canvas);
          if (type === 'display' || type === 'camera') {
            // Ask for the media first: adding a source that instantly fails is
            // worse than not adding it.
            const runtime = getRuntime(item);
            await runtime.start();
            if (runtime.status === 'error') { toast(runtime.error, 'err'); dropRuntime(item.id); return; }
            const size = runtime.naturalSize();
            if (size) {
              const canvas = store.get().canvas;
              const scale = Math.min(1, canvas.w / size.w, canvas.h / size.h);
              item.w = Math.round(size.w * scale);
              item.h = Math.round(size.h * scale);
              item.x = Math.round((canvas.w - item.w) / 2);
              item.y = Math.round((canvas.h - item.h) / 2);
            }
            if (type === 'display' && runtime.stream && runtime.stream.getAudioTracks().length) {
              mixer.addStream(runtime.stream, { id: item.id, name: item.name + ' (audio)', kind: 'desktop' });
            }
          }
          store.addSource(item);
          compositor.select(item.id);
          renderSources();
          if (!['display', 'camera', 'color'].includes(type)) openSourceProperties(ctx, item);
        },
      }, [el('b', { text: spec.label }), el('span', { text: spec.hint })]));
    }
    openModal({ title: 'Add source', body: grid, footer: [button('Cancel', { onclick: closeModal })] });
  }

  // --------------------------------------------------------------- mixer
  const meterNodes = new Map();

  function renderMixer() {
    const host = $('#mixerList');
    host.innerHTML = '';
    meterNodes.clear();
    const strips = mixer.list();
    if (!strips.length) {
      host.appendChild(el('div', { class: 'foot-note', style: { padding: '.5rem' },
        text: 'No audio yet. Add a microphone with ＋, or add a display capture with its audio.' }));
      return;
    }
    for (const strip of strips) {
      const meter = el('i');
      const peakMark = el('u');
      const db = el('span', { class: 'mix-db', text: '−∞ dB' });
      const muteBtn = el('button', {
        class: 'icon mix-mute' + (strip.muted ? ' on' : ''),
        text: strip.muted ? '🔇' : '🔊',
        title: strip.muted ? 'Unmute' : 'Mute',
        onclick: () => { mixer.setMuted(strip.id, !strip.muted); renderMixer(); },
      });
      const gain = el('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: strip.gain });
      gain.addEventListener('input', () => mixer.setGain(strip.id, Number(gain.value)));
      const name = el('span', { class: 'mix-name', text: strip.name, title: 'Double-click to rename' });
      name.addEventListener('dblclick', () => {
        const next = prompt('Rename audio input', strip.name);
        if (next) { mixer.rename(strip.id, next); renderMixer(); }
      });
      const removeBtn = el('button', {
        class: 'icon', text: '✕', title: 'Remove input',
        onclick: () => { mixer.removeStrip(strip.id); renderMixer(); },
      });
      host.appendChild(el('div', { class: 'mix-strip' }, [
        el('div', { class: 'mix-top' }, [name, db]),
        el('div', { class: 'meter' }, [meter, peakMark]),
        el('div', { class: 'mix-bottom' }, [muteBtn, gain, removeBtn]),
      ]));
      meterNodes.set(strip.id, { meter, peakMark, db });
    }
  }

  async function addAudioDialog() {
    await mixer.resume();
    let devices = [];
    try {
      // A permission prompt is needed before labels are readable.
      const probe = await openMicrophone();
      probe.getTracks().forEach((t) => t.stop());
      devices = await listAudioInputs();
    } catch (e) {
      toast('Microphone permission was declined.', 'err');
      return;
    }
    const picker = select(
      devices.map((d, i) => [d.deviceId, d.label || `Input ${i + 1}`]),
      devices[0] && devices[0].deviceId
    );
    openModal({
      title: 'Add audio input',
      body: el('div', {}, [
        field('Device', picker),
        el('p', { class: 'muted', text: 'Desktop audio comes in with a display capture when you tick "share audio" in the browser prompt.' }),
      ]),
      footer: [
        button('Cancel', { onclick: closeModal }),
        button('Add', { class: 'btn primary', onclick: async () => {
          try {
            const stream = await openMicrophone(picker.value);
            const label = devices.find((d) => d.deviceId === picker.value);
            mixer.addStream(stream, { name: (label && label.label) || 'Microphone', kind: 'mic' });
            renderMixer();
            closeModal();
          } catch (e) { toast(e.message, 'err'); }
        } }),
      ],
    });
  }

  bus.on('mixer:levels', (levels) => {
    for (const level of levels) {
      const nodes = meterNodes.get(level.id);
      if (!nodes) continue;
      const pct = clamp(level.rms * 140, 0, 100);
      nodes.meter.style.width = pct + '%';
      nodes.peakMark.style.left = clamp(level.peak * 140, 0, 100) + '%';
      const db = toDb(level.peak);
      nodes.db.textContent = db === -Infinity ? '−∞ dB' : db.toFixed(1) + ' dB';
      nodes.db.style.color = db > -1 ? 'var(--live)' : '';
    }
  });

  bus.on('mixer:changed', () => renderMixer());
  bus.on('doc:changed', () => { renderScenes(); renderSources(); });
  bus.on('selection:changed', () => renderSources());

  // ------------------------------------------------------------- actions
  const actions = {
    'scene-add': () => { store.addScene(); renderScenes(); },
    'scene-remove': () => {
      const doc = store.get();
      const id = doc.studioMode ? doc.previewScene : doc.activeScene;
      const scene = store.scene(id);
      if (scene && confirm(`Delete scene "${scene.name}"?`)) {
        scene.sources.forEach((s) => dropRuntime(s.id));
        store.removeScene(id);
      }
    },
    'scene-dup': () => store.duplicateScene(store.get().studioMode ? store.get().previewScene : store.get().activeScene),
    'scene-up': () => store.moveScene(store.get().activeScene, -1),
    'scene-down': () => store.moveScene(store.get().activeScene, 1),
    'source-add': addSourceDialog,
    'source-remove': () => {
      const scene = editScene();
      const item = scene && scene.sources.find((s) => s.id === compositor.selection);
      if (!item) return toast('Select a source first');
      if (!confirm(`Remove "${item.name}"?`)) return;
      dropRuntime(item.id);
      mixer.removeStrip(item.id);
      store.removeSource(item.id);
      compositor.select(null);
    },
    'source-props': () => {
      const scene = editScene();
      const item = scene && scene.sources.find((s) => s.id === compositor.selection);
      if (!item) return toast('Select a source first');
      openSourceProperties(ctx, item);
    },
    'source-up': () => compositor.selection && store.moveSource(compositor.selection, 1),
    'source-down': () => compositor.selection && store.moveSource(compositor.selection, -1),
    'source-fit': () => {
      const scene = editScene();
      const item = scene && scene.sources.find((s) => s.id === compositor.selection);
      if (!item) return toast('Select a source first');
      const canvas = store.get().canvas;
      store.update(() => { item.x = 0; item.y = 0; item.w = canvas.w; item.h = canvas.h; });
    },
    'mixer-add': addAudioDialog,
  };

  renderScenes();
  renderSources();
  renderMixer();

  return { actions, renderScenes, renderSources, renderMixer };
}
