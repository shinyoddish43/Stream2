import { normalizeRun } from './timer.js';

const DRAFT_KEY = 'fstream-splits-draft';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const revisionOf = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// The timer owns the running attempt; this store owns durable run data only.
// Serialize writes, cache edits before sending, and never overwrite another
// browser's changes without an explicit choice from the user.
export class SplitsStore {
  constructor({ put, storage, onStatus }) {
    this.put = put;
    this.storage = storage;
    this.onStatus = onStatus;
    this.saving = null;
    this.conflict = null;
  }

  get dirty() { return this.run && !same(this.run, this.saved); }

  initialize(run, revision) {
    this.run = normalizeRun(run);
    this.saved = structuredClone(this.run);
    this.revision = revisionOf(revision);
    try {
      const draft = JSON.parse(this.storage.getItem(DRAFT_KEY));
      if (draft?.run?.segments?.length) {
        const restored = normalizeRun(draft.run);
        if (!same(restored, this.saved)) {
          this.run = restored;
          if (revisionOf(draft.revision) !== this.revision) {
            this.conflict = { run: structuredClone(this.saved), revision: this.revision };
          }
          this.revision = revisionOf(draft.revision);
        }
      }
    } catch { /* Server data remains usable without browser storage. */ }
    if (this.dirty) this.cache(); else this.clearCache();
    this.status();
    return structuredClone(this.run);
  }

  cache() {
    try {
      this.storage.setItem(DRAFT_KEY, JSON.stringify({ run: this.run, revision: this.revision }));
    } catch { /* The persistent pending notice still reports failed server saves. */ }
  }

  clearCache() {
    try {
      const draft = JSON.parse(this.storage.getItem(DRAFT_KEY));
      // Another tab in this browser can have cached newer, different edits.
      if (draft && same(normalizeRun(draft.run), this.run)) this.storage.removeItem(DRAFT_KEY);
    } catch { /* Storage may be disabled. */ }
  }

  status(error = '') {
    const state = this.conflict ? 'conflict' : error ? 'pending' : this.dirty ? 'saving' : 'saved';
    const message = {
      conflict: 'Splits changed in another browser. Export yours or choose which version to keep.',
      pending: `Splits save pending: ${error}`,
      saving: 'Saving splits…',
      saved: 'Splits saved',
    }[state];
    this.onStatus({ state, message });
  }

  update(run) {
    this.run = structuredClone(normalizeRun(run));
    this.cache();
    this.status();
    return this.flush();
  }

  async flush(keepalive = false) {
    if (!this.run || this.conflict) return;
    if (this.saving) {
      // A closing tab may have newer edits than the in-flight snapshot.
      // A stale revision cannot overwrite an acknowledged newer save.
      if (keepalive && this.dirty) {
        this.cache();
        this.put({ ...this.run, revision: this.revision }, true).catch(() => {});
      }
      return this.saving;
    }
    if (!this.dirty) { this.clearCache(); this.status(); return; }
    this.saving = this.writePending(keepalive);
    try { await this.saving; } finally { this.saving = null; }
  }

  async writePending(keepalive) {
    let conflicts = 0;
    while (this.dirty) {
      const snapshot = structuredClone(this.run);
      this.cache();
      this.status();
      try {
        const result = await this.put({ ...snapshot, revision: this.revision }, keepalive);
        this.saved = snapshot;
        this.revision = revisionOf(result.revision);
      } catch (error) {
        if (error.status === 409) {
          const remote = { run: normalizeRun(error.body.splits), revision: revisionOf(error.body.revision) };
          // An acknowledgement can be lost even though the server saved it.
          // A revision with identical content is safe to continue from.
          if (conflicts++ < 3 && (same(remote.run, snapshot) || same(remote.run, this.saved))) {
            this.saved = remote.run;
            this.revision = remote.revision;
            continue;
          }
          this.conflict = remote;
        }
        this.cache();
        this.status(error.message);
        return;
      }
    }
    this.clearCache();
    this.status();
  }

  async keepLocal() {
    if (!this.conflict) return;
    this.saved = this.conflict.run;
    this.revision = this.conflict.revision;
    this.conflict = null;
    this.cache();
    return this.flush();
  }

  loadRemote() {
    if (!this.conflict) return;
    this.clearCache();
    this.run = structuredClone(this.conflict.run);
    this.saved = structuredClone(this.run);
    this.revision = this.conflict.revision;
    this.conflict = null;
    this.status();
    return structuredClone(this.run);
  }
}
