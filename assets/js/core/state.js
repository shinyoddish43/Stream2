// The studio document: scenes, sources, audio, output, timer settings.
// One object, one save path, autosaved to the server and mirrored to
// localStorage so a flaky connection never loses a layout.

import { bus, clone, uid, debounce, toast } from './util.js';
import { api } from './api.js';

const LOCAL_KEY = 'streamstudio.doc.v1';

export function defaultDoc() {
  const sceneId = uid('sc');
  return {
    version: 1,
    rev: 0,
    canvas: { w: 1280, h: 720, fps: 30 },
    lowPower: false,
    activeScene: sceneId,
    previewScene: sceneId,
    studioMode: false,
    transition: { type: 'fade', duration: 300 },
    scenes: [
      {
        id: sceneId,
        name: 'Gameplay',
        sources: [
          {
            id: uid('sr'), type: 'color', name: 'Background', visible: true, locked: true,
            x: 0, y: 0, w: 1280, h: 720, opacity: 1,
            settings: { color: '#101216', color2: '#1b1f27', gradient: true },
          },
          {
            id: uid('sr'), type: 'timer', name: 'Speedrun timer', visible: true, locked: false,
            x: 16, y: 16, w: 300, h: 420, opacity: 1,
            settings: {
              bg: 'rgba(8,10,14,0.78)', accent: '#4a9eff', rows: 8,
              showTitle: true, showDeltas: true, showSob: true, font: 'system-ui',
            },
          },
        ],
      },
    ],
    audio: { master: 1, inputs: [] },
    output: {
      mode: 'record',
      bitrate: 2500,
      audioBitrate: 128,
      container: 'auto',
      keyframe: 2,
      whipUrl: '',
      whipToken: '',
      recordName: 'stream',
      streamToDisk: true,
    },
    timer: {
      splitsId: '',
      comparison: 'Personal Best',
      decimals: 2,
      publishState: true,
      hotkeys: {
        split: 'Numpad1', reset: 'Numpad3', undo: 'Numpad8', skip: 'Numpad2', pause: 'Numpad5',
      },
      link: { mode: 'off', url: 'ws://127.0.0.1:16835' },
    },
  };
}

class DocStore {
  constructor() {
    this.doc = defaultDoc();
    this.dirty = false;
    this.saving = false;
    this.lastError = null;
    this.queueSave = debounce(() => this.save(), 900);
  }

  async load() {
    // Local copy first so the UI paints immediately, then reconcile with the
    // server. On a slow shared host that is the difference between "instant"
    // and "three seconds of grey".
    try {
      const localRaw = localStorage.getItem(LOCAL_KEY);
      if (localRaw) {
        const local = JSON.parse(localRaw);
        if (local && local.scenes) this.doc = migrate(local);
      }
    } catch (e) { /* corrupted local copy is not fatal */ }

    try {
      const res = await api.loadConfig();
      if (res.config && res.config.scenes && res.config.scenes.length) {
        const remote = migrate(res.config);
        if ((remote.rev | 0) >= (this.doc.rev | 0)) this.doc = remote;
      }
    } catch (e) {
      this.lastError = e.message;
      toast('Working offline: ' + e.message, 'err');
    }
    bus.emit('doc:loaded', this.doc);
    bus.emit('doc:changed', this.doc);
    return this.doc;
  }

  get() { return this.doc; }

  /** Apply a mutation, notify listeners, schedule a save. */
  update(fn, { silent = false, save = true } = {}) {
    const result = fn(this.doc);
    if (result && typeof result === 'object') this.doc = result;
    this.dirty = true;
    this.persistLocal();
    if (!silent) bus.emit('doc:changed', this.doc);
    if (save) this.queueSave();
    return this.doc;
  }

  persistLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.doc)); } catch (e) {}
  }

  async save() {
    if (this.saving) { this.queueSave(); return; }
    this.saving = true;
    try {
      const res = await api.saveConfig(this.doc);
      this.doc.rev = res.rev;
      this.dirty = false;
      this.lastError = null;
      bus.emit('doc:saved', this.doc);
    } catch (e) {
      this.lastError = e.message;
      bus.emit('doc:saveError', e);
    } finally {
      this.saving = false;
    }
  }

  // ---- scene helpers ----
  scene(id) { return this.doc.scenes.find((s) => s.id === (id || this.doc.activeScene)); }
  activeScene() { return this.scene(this.doc.activeScene) || this.doc.scenes[0]; }
  previewScene() {
    if (!this.doc.studioMode) return this.activeScene();
    return this.scene(this.doc.previewScene) || this.activeScene();
  }
  /** The scene the source dock edits: preview in studio mode, program otherwise. */
  editScene() { return this.previewScene(); }

  source(sourceId, sceneId) {
    const scene = this.scene(sceneId) || this.editScene();
    return scene ? scene.sources.find((s) => s.id === sourceId) : null;
  }

  addScene(name) {
    const scene = { id: uid('sc'), name: name || `Scene ${this.doc.scenes.length + 1}`, sources: [] };
    this.update((d) => { d.scenes.push(scene); if (d.studioMode) d.previewScene = scene.id; else { d.activeScene = scene.id; d.previewScene = scene.id; } });
    return scene;
  }

  removeScene(id) {
    if (this.doc.scenes.length <= 1) { toast('Keep at least one scene', 'err'); return; }
    this.update((d) => {
      d.scenes = d.scenes.filter((s) => s.id !== id);
      if (d.activeScene === id) d.activeScene = d.scenes[0].id;
      if (d.previewScene === id) d.previewScene = d.scenes[0].id;
    });
  }

  duplicateScene(id) {
    const scene = this.scene(id);
    if (!scene) return;
    const copy = clone(scene);
    copy.id = uid('sc');
    copy.name = scene.name + ' copy';
    copy.sources.forEach((s) => { s.id = uid('sr'); });
    this.update((d) => { d.scenes.splice(d.scenes.indexOf(scene) + 1, 0, copy); });
    return copy;
  }

  moveScene(id, delta) {
    this.update((d) => {
      const i = d.scenes.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= d.scenes.length) return;
      const [item] = d.scenes.splice(i, 1);
      d.scenes.splice(j, 0, item);
    });
  }

  addSource(item, sceneId) {
    const scene = this.scene(sceneId) || this.editScene();
    this.update(() => { scene.sources.push(item); });
    bus.emit('source:added', item);
    return item;
  }

  removeSource(sourceId, sceneId) {
    const scene = this.scene(sceneId) || this.editScene();
    this.update(() => { scene.sources = scene.sources.filter((s) => s.id !== sourceId); });
    bus.emit('source:removed', sourceId);
  }

  moveSource(sourceId, delta, sceneId) {
    const scene = this.scene(sceneId) || this.editScene();
    this.update(() => {
      const i = scene.sources.findIndex((s) => s.id === sourceId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= scene.sources.length) return;
      const [item] = scene.sources.splice(i, 1);
      scene.sources.splice(j, 0, item);
    });
  }

  reorderSource(sourceId, targetIndex, sceneId) {
    const scene = this.scene(sceneId) || this.editScene();
    this.update(() => {
      const i = scene.sources.findIndex((s) => s.id === sourceId);
      if (i < 0) return;
      const [item] = scene.sources.splice(i, 1);
      scene.sources.splice(Math.max(0, Math.min(scene.sources.length, targetIndex)), 0, item);
    });
  }
}

function migrate(doc) {
  const base = defaultDoc();
  const out = Object.assign({}, base, doc);
  out.canvas = Object.assign({}, base.canvas, doc.canvas);
  out.output = Object.assign({}, base.output, doc.output);
  out.timer = Object.assign({}, base.timer, doc.timer);
  out.timer.hotkeys = Object.assign({}, base.timer.hotkeys, (doc.timer || {}).hotkeys);
  out.timer.link = Object.assign({}, base.timer.link, (doc.timer || {}).link);
  out.audio = Object.assign({}, base.audio, doc.audio);
  out.transition = Object.assign({}, base.transition, doc.transition);
  if (!Array.isArray(out.scenes) || !out.scenes.length) out.scenes = base.scenes;
  out.scenes.forEach((scene) => {
    scene.sources = (scene.sources || []).map((s) => Object.assign(
      { visible: true, locked: false, opacity: 1, x: 0, y: 0, w: 640, h: 360, settings: {} }, s
    ));
  });
  if (!out.scenes.find((s) => s.id === out.activeScene)) out.activeScene = out.scenes[0].id;
  if (!out.scenes.find((s) => s.id === out.previewScene)) out.previewScene = out.activeScene;
  return out;
}

export const store = new DocStore();
