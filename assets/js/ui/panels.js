// Scene list, source list, and the audio mixer strips.

import { $, el, bus, toast, clamp, uid } from '../core/util.js';
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
          'aria-label': (item.visible ? 'Hide ' : 'Show ') + item.name,
          text: item.visible ? '👁' : '—',
          onclick: (e) => { e.stopPropagation(); store.update(() => { item.visible = !item.visible; }); },
        }),
        el('span', { class: 'row-name', text: item.name }),
        el('span', {
          class: 'row-sub',
          title: runtime.status === 'error' ? runtime.error
            : runtime.status === 'ended' ? 'The capture was stopped — open properties to share again'
            : runtime.status === 'empty' ? 'Nothing selected yet — open properties'
            : '',
          text: runtime.status === 'error' ? '⚠'
            : runtime.status === 'ended' ? '⏹'
            : runtime.status === 'empty' ? '…'
            : (SOURCE_TYPES[item.type]?.label || item.type).split(' ')[0],
        }),
        el('button', {
          class: 'icon',
          title: item.locked ? 'Unlock' : 'Lock',
          'aria-label': (item.locked ? 'Unlock ' : 'Lock ') + item.name,
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

  /**
   * Four scenes a speedrunner actually needs, wired up and placed: a
   * countdown card, the run itself, a break card and an outro. Sources that
   * need a permission prompt (the game capture, a webcam) are left as a
   * labelled gap rather than a dialog fired at someone who just clicked a
   * button.
   */
  function addStarterScenes() {
    const canvas = store.get().canvas;
    const { w, h } = canvas;
    const card = (name, color2) => ({
      id: uid('sr'), type: 'color', name, visible: true, locked: true,
      x: 0, y: 0, w, h, opacity: 1,
      settings: { color: '#0d1015', color2: color2 || '#1b2230', gradient: true },
    });
    const label = (name, text, options = {}) => ({
      id: uid('sr'), type: 'text', name, visible: true, locked: false,
      x: options.x ?? Math.round(w * 0.08), y: options.y ?? Math.round(h * 0.4),
      w: options.w ?? Math.round(w * 0.84), h: options.h ?? Math.round(h * 0.14), opacity: 1,
      settings: {
        text, size: options.size ?? Math.round(h / 12), color: options.color || '#ffffff',
        font: 'system-ui', weight: '700', align: options.align || 'center',
        outline: 4, outlineColor: '#000000', bg: 'transparent',
      },
    });

    const scenes = [
      {
        id: uid('sc'), name: 'Starting soon',
        sources: [
          card('Backdrop'),
          label('Title', '{game}', { y: Math.round(h * 0.26), size: Math.round(h / 9) }),
          label('Category', '{category}', { y: Math.round(h * 0.40), size: Math.round(h / 18), color: '#9fb4d0' }),
          {
            id: uid('sr'), type: 'countdown', name: 'Countdown', visible: true, locked: false,
            x: Math.round(w * 0.2), y: Math.round(h * 0.55), w: Math.round(w * 0.6), h: Math.round(h * 0.16), opacity: 1,
            settings: { minutes: 10, endsAt: 0, size: Math.round(h / 7), color: '#ffffff',
              prefix: '', done: "Here we go", font: 'system-ui', align: 'center', outline: 5, outlineColor: '#000000' },
          },
          label('PB line', 'PB {pb}  ·  Attempt {attempts}', { y: Math.round(h * 0.78), size: Math.round(h / 26), color: '#8b9bb4' }),
        ],
      },
      {
        id: uid('sc'), name: 'Run',
        sources: [
          card('Backdrop'),
          label('Capture placeholder — delete once your game is in',
            'Add your game capture:  Sources → ＋ → Display',
            { y: Math.round(h * 0.45), size: Math.round(h / 30), color: '#5c6b82' }),
          {
            id: uid('sr'), type: 'timer', name: 'Speedrun timer', visible: true, locked: false,
            x: w - Math.round(w * 0.23) - 16, y: 16,
            w: Math.round(w * 0.23), h: Math.round(h * 0.62), opacity: 1,
            settings: { bg: 'rgba(8,10,14,0.78)', accent: '#4a9eff', rows: 8,
              showTitle: true, showDeltas: true, showSob: true, font: 'system-ui' },
          },
        ],
      },
      {
        id: uid('sc'), name: 'Break',
        sources: [card('Backdrop', '#2a1f2e'), label('Message', 'Back in a moment'),
          label('Sub', 'Resetting · {attempts} attempts today', { y: Math.round(h * 0.55), size: Math.round(h / 26), color: '#9fb4d0' })],
      },
      {
        id: uid('sc'), name: 'Ending',
        sources: [card('Backdrop', '#101f1a'), label('Message', 'Thanks for watching'),
          label('Final', 'Final time {timer}', { y: Math.round(h * 0.55), size: Math.round(h / 20), color: '#4ce0a0' })],
      },
    ];

    store.update((d) => {
      d.scenes.push(...scenes);
      if (!d.studioMode) d.activeScene = scenes[0].id;
      d.previewScene = scenes[0].id;
    });
    compositor.select(null);
    renderScenes();
    renderSources();
    toast('Added four scenes: Starting soon, Run, Break, Ending', 'ok');
  }

  // --------------------------------------------------------------- mixer
  const meterNodes = new Map();

  /**
   * Mirror the mixer into the document so a microphone survives a reload.
   * Only the description is stored — never the stream, obviously — and the
   * browser still decides whether it will hand the device back without a
   * fresh prompt.
   */
  function persistMixer() {
    const strips = mixer.list();
    store.update((d) => {
      d.audio.inputs = strips
        .filter((s) => s.kind === 'mic')
        .map((s) => ({
          id: s.id, name: s.name, kind: s.kind, gain: s.gain, muted: s.muted,
          deviceId: (mixer.strips.get(s.id) || {}).deviceId || '',
        }));
    }, { silent: true });
  }

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
        'aria-label': (strip.muted ? 'Unmute ' : 'Mute ') + strip.name,
        onclick: () => { mixer.setMuted(strip.id, !strip.muted); persistMixer(); renderMixer(); },
      });
      const gain = el('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: strip.gain });
      gain.addEventListener('input', () => mixer.setGain(strip.id, Number(gain.value)));
      gain.addEventListener('change', persistMixer);
      const name = el('span', { class: 'mix-name', text: strip.name, title: 'Double-click to rename' });
      name.addEventListener('dblclick', () => {
        const next = prompt('Rename audio input', strip.name);
        if (next) { mixer.rename(strip.id, next); persistMixer(); renderMixer(); }
      });
      const removeBtn = el('button', {
        class: 'icon', text: '✕', title: 'Remove input', 'aria-label': 'Remove ' + strip.name,
        onclick: () => { mixer.removeStrip(strip.id); persistMixer(); renderMixer(); },
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
            const strip = mixer.addStream(stream, { name: (label && label.label) || 'Microphone', kind: 'mic' });
            if (strip) strip.deviceId = picker.value;
            persistMixer();
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
    'scene-starter': () => {
      openModal({
        title: 'Add a speedrunning layout',
        body: el('div', {}, [
          el('p', { text: 'Adds four scenes, sized to your canvas:' }),
          el('ul', { html: `
            <li><b>Starting soon</b> — backdrop, game and category from your splits, and a countdown</li>
            <li><b>Run</b> — the speedrun timer placed top-right, with room for your capture</li>
            <li><b>Break</b> — a reset card</li>
            <li><b>Ending</b> — an outro showing the final time</li>` }),
          el('p', { class: 'muted', text: 'Your existing scenes are left alone. Screen and camera capture stay for you to add, so nothing prompts you here.' }),
        ]),
        footer: [
          button('Cancel', { onclick: closeModal }),
          button('Add them', { class: 'btn primary', onclick: () => { addStarterScenes(); closeModal(); } }),
        ],
      });
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

  /**
   * Re-open the microphones the layout remembers. The browser only hands a
   * device back without prompting when permission is still granted, so a
   * failure here is normal and gets one quiet line, not an error storm.
   */
  async function restoreAudioInputs() {
    const saved = (store.get().audio.inputs || []).filter((input) => input.kind === 'mic');
    if (!saved.length) return;
    let restored = 0;
    for (const input of saved) {
      try {
        const stream = await openMicrophone(input.deviceId);
        const strip = mixer.addStream(stream, {
          id: input.id, name: input.name, kind: 'mic',
          gain: input.gain ?? 1, muted: !!input.muted,
        });
        if (strip) strip.deviceId = input.deviceId;
        restored++;
      } catch (e) { /* permission not granted yet, or the device is gone */ }
    }
    renderMixer();
    if (restored < saved.length) {
      toast(`${saved.length - restored} saved audio input${saved.length - restored > 1 ? 's' : ''} could not reopen — add ${saved.length - restored > 1 ? 'them' : 'it'} again with ＋.`);
    }
  }

  renderScenes();
  renderSources();
  renderMixer();
  restoreAudioInputs();

  return { actions, renderScenes, renderSources, renderMixer, persistMixer };
}
