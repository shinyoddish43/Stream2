// Document store tests: the scene and source bookkeeping the docks drive.
// These run in plain Node — the store only touches the DOM through guarded
// calls, which is deliberate so this layer stays testable.

import './dom-stub.mjs';
import { describe, it, assert, report } from './tiny.mjs';
import { DocStore, defaultDoc } from '../assets/js/core/state.js';

// A fresh store per test, with saving disabled: this is about the data.
function freshStore() {
  const store = new DocStore();
  store.doc = defaultDoc();
  store.queueSave = () => {};
  return store;
}

const names = (store) => store.editScene().sources.map((s) => s.name);

function seed(store, count = 4) {
  const scene = store.editScene();
  scene.sources = [];
  for (let i = 1; i <= count; i++) {
    scene.sources.push({ id: 's' + i, name: 'S' + i, type: 'color', visible: true, x: 0, y: 0, w: 10, h: 10, settings: {} });
  }
  return scene;
}

describe('the default document', () => {
  it('has one scene', async () => assert.equal((freshStore()).get().scenes.length, 1));
  it('points activeScene at a scene that exists', () => {
    const store = freshStore();
    assert.ok(store.get().scenes.some((s) => s.id === store.get().activeScene));
  });
  it('starts with a backdrop and a timer', () => {
    const store = freshStore();
    const types = store.editScene().sources.map((s) => s.type);
    assert.deep(types, ['color', 'timer']);
  });
});

describe('scenes', () => {
  it('adds', () => {
    const store = freshStore();
    store.addScene('Second');
    assert.equal(store.get().scenes.length, 2);
    assert.equal(store.get().scenes[1].name, 'Second');
  });
  it('refuses to delete the last one', () => {
    const store = freshStore();
    store.removeScene(store.get().activeScene);
    assert.equal(store.get().scenes.length, 1);
  });
  it('moves the active pointer when the active scene goes', () => {
    const store = freshStore();
    const first = store.get().activeScene;
    const second = store.addScene('Second');
    store.update((d) => { d.activeScene = first; });
    store.removeScene(first);
    assert.equal(store.get().activeScene, second.id);
    assert.ok(store.get().scenes.every((s) => s.id !== first));
  });
  it('duplicates with fresh ids', () => {
    const store = freshStore();
    const original = store.activeScene();
    const copy = store.duplicateScene(original.id);
    assert.ok(copy.id !== original.id, 'scene id was reused');
    assert.equal(copy.sources.length, original.sources.length);
    const shared = copy.sources.filter((s) => original.sources.some((o) => o.id === s.id));
    assert.equal(shared.length, 0, 'a duplicated source kept its id, which would share one runtime');
  });
  it('inserts the duplicate right after the original', () => {
    const store = freshStore();
    store.addScene('Second');
    const first = store.get().scenes[0];
    store.duplicateScene(first.id);
    assert.equal(store.get().scenes[1].name, first.name + ' copy');
  });
  it('reorders', () => {
    const store = freshStore();
    const a = store.get().scenes[0].id;
    store.addScene('B');
    store.moveScene(a, 1);
    assert.equal(store.get().scenes[1].id, a);
    store.moveScene(a, -1);
    assert.equal(store.get().scenes[0].id, a);
  });
  it('ignores a move off either end', () => {
    const store = freshStore();
    const a = store.get().scenes[0].id;
    store.moveScene(a, -1);
    store.moveScene(a, 1);
    assert.equal(store.get().scenes[0].id, a);
  });
});

describe('source ordering', () => {
  // The dock shows the list reversed (front-most at the top), so the array is
  // back-to-front: index 0 is drawn first, i.e. furthest back.
  it('raises a source one layer', () => {
    const store = freshStore();
    seed(store);
    store.moveSource('s2', 1);
    assert.deep(names(store), ['S1', 'S3', 'S2', 'S4']);
  });
  it('lowers a source one layer', () => {
    const store = freshStore();
    seed(store);
    store.moveSource('s3', -1);
    assert.deep(names(store), ['S1', 'S3', 'S2', 'S4']);
  });
  it('will not push past the front', () => {
    const store = freshStore();
    seed(store);
    store.moveSource('s4', 1);
    assert.deep(names(store), ['S1', 'S2', 'S3', 'S4']);
  });
  it('will not push past the back', () => {
    const store = freshStore();
    seed(store);
    store.moveSource('s1', -1);
    assert.deep(names(store), ['S1', 'S2', 'S3', 'S4']);
  });
});

describe('drag to reorder', () => {
  // reorderSource takes the index the item should end up at, counted in the
  // list as the user sees it before the drag.
  it('drags a back source to the front', () => {
    const store = freshStore();
    seed(store);
    store.reorderSource('s1', 4);
    assert.deep(names(store), ['S2', 'S3', 'S4', 'S1']);
  });
  it('drags a front source to the back', () => {
    const store = freshStore();
    seed(store);
    store.reorderSource('s4', 0);
    assert.deep(names(store), ['S4', 'S1', 'S2', 'S3']);
  });
  it('drags one step forward', () => {
    const store = freshStore();
    seed(store);
    store.reorderSource('s2', 3);
    assert.deep(names(store), ['S1', 'S3', 'S2', 'S4']);
  });
  it('drags one step back', () => {
    const store = freshStore();
    seed(store);
    store.reorderSource('s3', 1);
    assert.deep(names(store), ['S1', 'S3', 'S2', 'S4']);
  });
  it('dropping an item where it already is changes nothing', () => {
    const store = freshStore();
    seed(store);
    store.reorderSource('s2', 1);
    assert.deep(names(store), ['S1', 'S2', 'S3', 'S4']);
  });
  it('ignores an unknown id', () => {
    const store = freshStore();
    seed(store);
    store.reorderSource('nope', 0);
    assert.deep(names(store), ['S1', 'S2', 'S3', 'S4']);
  });
});

describe('sources', () => {
  it('adds to the scene being edited', () => {
    const store = freshStore();
    seed(store);
    store.addSource({ id: 'new', name: 'New', type: 'text', visible: true, x: 0, y: 0, w: 1, h: 1, settings: {} });
    assert.deep(names(store), ['S1', 'S2', 'S3', 'S4', 'New']);
  });
  it('removes', () => {
    const store = freshStore();
    seed(store);
    store.removeSource('s2');
    assert.deep(names(store), ['S1', 'S3', 'S4']);
  });
  it('finds a source by id', () => {
    const store = freshStore();
    seed(store);
    assert.equal(store.source('s3').name, 'S3');
  });
});

describe('studio mode', () => {
  it('edits the program scene when it is off', () => {
    const store = freshStore();
    const second = store.addScene('Second');
    store.update((d) => { d.studioMode = false; d.activeScene = d.scenes[0].id; d.previewScene = second.id; });
    assert.equal(store.editScene().id, store.get().scenes[0].id);
  });
  it('edits the preview scene when it is on', () => {
    const store = freshStore();
    const second = store.addScene('Second');
    store.update((d) => { d.studioMode = true; d.activeScene = d.scenes[0].id; d.previewScene = second.id; });
    assert.equal(store.editScene().id, second.id);
  });
});

await report('document store');
