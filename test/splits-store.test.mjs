import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SplitsStore } from '../public/splits-store.js';
import { normalizeRun } from '../public/timer.js';

const run = (game) => normalizeRun({ game, segments: [{ name: 'Finish', pb: 60 }] });
const memory = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key), data };
};
const fixture = (put, storage = memory()) => {
  const statuses = [];
  const store = new SplitsStore({ put, storage, onStatus: (value) => statuses.push(value) });
  return { store, storage, statuses };
};
const conflict = (remote, revision) => Object.assign(new Error('another browser changed splits'), { status: 409, body: { splits: remote, revision } });

test('failed saves survive a reload and retry without losing PB or history', async () => {
  const first = fixture(async () => { throw new Error('offline'); });
  first.store.initialize(run('Original'), 3);
  const edited = { ...run('Edited'), pb: 50, history: [{ id: 1, real: 50 }] };
  await first.store.update(edited);
  assert.equal(first.statuses.at(-1).state, 'pending');
  assert.ok(first.storage.data.size);
  let received;
  const next = fixture(async (payload) => { received = payload; return { revision: 4 }; }, first.storage);
  assert.deepEqual(next.store.initialize(run('Original'), 3), edited);
  await next.store.flush();
  assert.deepEqual(received, { ...edited, revision: 3 });
  assert.equal(next.statuses.at(-1).state, 'saved');
  assert.equal(next.storage.data.size, 0);
});

test('edits during a pending write are saved after acknowledgement of the older snapshot', async () => {
  let acknowledge;
  const sent = [];
  const { store } = fixture((payload) => {
    sent.push(payload);
    return sent.length === 1 ? new Promise((resolve) => { acknowledge = resolve; }) : Promise.resolve({ revision: 2 });
  });
  store.initialize(run('Original'), 0);
  const saving = store.update(run('First'));
  const newer = store.update(run('Newest'));
  acknowledge({ revision: 1 });
  await Promise.all([saving, newer]);
  assert.deepEqual(sent.map((r) => [r.game, r.revision]), [['First', 0], ['Newest', 1]]);
  assert.equal(store.saved.game, 'Newest');
});

test('an undo that returns to the baseline is not lost behind an in-flight finish save', async () => {
  let acknowledge;
  const sent = [];
  const { store } = fixture((payload) => {
    sent.push(payload);
    return sent.length === 1 ? new Promise((resolve) => { acknowledge = resolve; }) : Promise.resolve({ revision: 2 });
  });
  const original = run('Original');
  store.initialize(original, 0);
  const saving = store.update({ ...original, pb: 40 });
  const undo = store.update(original);
  acknowledge({ revision: 1 });
  await Promise.all([saving, undo]);
  assert.equal(sent[1].pb, 60);
  assert.equal(sent[1].revision, 1);
  assert.equal(store.saved.pb, 60);
});

test('a different unacknowledged remote version requires a choice before overwriting', async () => {
  const serverCopy = run('First');
  const sent = [];
  const { store } = fixture(async (payload) => {
    sent.push(payload);
    if (sent.length === 1) throw new Error('acknowledgement lost');
    if (sent.length === 2) throw conflict(serverCopy, 1);
    return { revision: 2 };
  });
  store.initialize(run('Original'), 0);
  await store.update(serverCopy);
  await store.update(run('Newest'));
  // The remote matches neither the newer snapshot nor the last acknowledgement:
  // asking the user to choose is safer than assuming the unacknowledged write.
  assert.equal(store.conflict.run.game, 'First');
  await store.keepLocal();
  assert.equal(store.saved.game, 'Newest');
  assert.equal(sent.at(-1).revision, 1);
});

test('retrying the same unacknowledged snapshot accepts its matching server copy', async () => {
  let calls = 0;
  const { store, storage } = fixture(async () => {
    if (++calls === 1) throw new Error('lost response');
    throw conflict(run('Edited'), 4);
  });
  store.initialize(run('Original'), 3);
  await store.update(run('Edited'));
  await store.flush();
  assert.equal(store.conflict, null);
  assert.equal(store.dirty, false);
  assert.equal(store.revision, 4);
  assert.equal(storage.data.size, 0);
});

test('conflicts keep both versions and remain conflicts across reloads', async () => {
  const first = fixture(async () => { throw conflict(run('Other browser'), 6); });
  first.store.initialize(run('Original'), 5);
  await first.store.update(run('My browser'));
  assert.equal(first.store.conflict.run.game, 'Other browser');
  assert.equal(first.store.run.game, 'My browser');
  const second = fixture(async () => assert.fail('must not silently overwrite'), first.storage);
  assert.equal(second.store.initialize(run('Other browser'), 6).game, 'My browser');
  await second.store.flush();
  assert.equal(second.store.conflict.revision, 6);
  const third = fixture(async () => assert.fail('must still be conflicted'), first.storage);
  third.store.initialize(run('Other browser'), 6);
  assert.ok(third.store.conflict);
  assert.equal(third.store.loadRemote().game, 'Other browser');
  assert.equal(first.storage.data.size, 0);
});

test('an explicit keep-local choice uses the remote revision, with later conflicts still protected', async () => {
  const sent = [];
  const { store } = fixture(async (payload) => {
    sent.push(payload);
    if (sent.length === 1) throw conflict(run('Remote'), 8);
    return { revision: 9 };
  });
  store.initialize(run('Original'), 7);
  await store.update(run('Local'));
  await store.keepLocal();
  assert.equal(sent[1].revision, 8);
  assert.equal(sent[1].game, 'Local');
  assert.equal(store.conflict, null);
});

test('unavailable browser storage does not block server persistence', async () => {
  const storage = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); }, removeItem() { throw new Error('disabled'); } };
  const { store, statuses } = fixture(async () => ({ revision: 1 }), storage);
  store.initialize(null, 0);
  await store.update(run('Saved without local storage'));
  assert.equal(statuses.at(-1).state, 'saved');
});

test('page-close flush carries the newest snapshot during an older request', async () => {
  let acknowledge;
  const sent = [];
  const { store } = fixture((payload, keepalive) => {
    sent.push({ payload, keepalive });
    return sent.length === 1 ? new Promise((resolve) => { acknowledge = resolve; }) : Promise.resolve({ revision: 2 });
  });
  store.initialize(run('Original'), 0);
  const initial = store.update(run('First'));
  store.update(run('Latest'));
  const closing = store.flush(true);
  assert.equal(sent[1].keepalive, true);
  assert.equal(sent[1].payload.game, 'Latest');
  acknowledge({ revision: 1 });
  await Promise.all([initial, closing]);
});

test('acknowledging one tab cannot erase a different tab’s pending draft', async () => {
  let acknowledge;
  const first = fixture(() => new Promise((resolve) => { acknowledge = resolve; }));
  first.store.initialize(run('Original'), 0);
  const saved = first.store.update(run('Tab A'));
  const second = fixture(async () => { throw new Error('offline'); }, first.storage);
  second.store.initialize(run('Original'), 0);
  await second.store.update(run('Tab B'));
  acknowledge({ revision: 1 });
  await saved;
  assert.equal(JSON.parse(first.storage.getItem('fstream-splits-draft')).run.game, 'Tab B');
});
