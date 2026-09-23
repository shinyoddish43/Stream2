// Native speedrun timer. LiveSplit's model, implemented directly so the
// studio never needs a browser source or a second app to show splits.
//
// Timing uses performance.now() deltas, not Date.now(), so a clock change or
// an NTP step mid-run cannot corrupt a PB.

import { bus, clone } from '../core/util.js';
import { emptyRun } from './lss.js';

export const PHASE = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  ENDED: 'ended',
};

export class SpeedrunTimer {
  constructor() {
    this.run = emptyRun();
    this.comparison = 'Personal Best';
    this.phase = PHASE.IDLE;
    this.startedAt = 0;        // performance.now() at start
    this.pausedTotal = 0;      // accumulated paused milliseconds
    this.pausedAt = 0;
    this.startedIso = '';
    this.currentSplit = 0;
    this.splitTimes = [];      // cumulative seconds, null for skipped splits
    this.external = false;     // true while a LiveSplit bridge drives us
    this.externalTime = 0;
    this.resultsApplied = false;   // the attempt has already been recorded
    this._lastPublish = 0;
  }

  // ---------------------------------------------------------------- loading
  load(run) {
    this.reset(false);
    this.run = normalizeRun(run);
    this.splitTimes = new Array(this.run.segments.length).fill(null);
    bus.emit('timer:run', this.run);
    bus.emit('timer:state', this.snapshot());
  }

  get segments() { return this.run.segments; }

  /** Comparison names available on the loaded splits, PB first. */
  comparisonNames() {
    const names = new Set(['Personal Best', 'Best Segments']);
    for (const seg of this.run.segments) {
      for (const key of Object.keys(seg.comparisons || {})) names.add(key);
    }
    return Array.from(names);
  }

  /** Cumulative comparison time at split index, or null when unavailable. */
  comparisonAt(index, name = this.comparison) {
    const seg = this.run.segments[index];
    if (!seg) return null;
    if (name === 'Personal Best') return seg.pb ?? null;
    if (name === 'Best Segments') {
      let sum = 0;
      for (let i = 0; i <= index; i++) {
        const best = this.run.segments[i].best;
        if (best === null || best === undefined) return null;
        sum += best;
      }
      return sum;
    }
    const value = (seg.comparisons || {})[name];
    return value === undefined ? null : value;
  }

  /** Duration of a single segment in the comparison. */
  comparisonSegment(index, name = this.comparison) {
    const here = this.comparisonAt(index, name);
    if (here === null) return null;
    if (index === 0) return here;
    const before = this.comparisonAt(index - 1, name);
    return before === null ? null : here - before;
  }

  // ------------------------------------------------------------------ clock
  /** Seconds since the run started, including the (usually negative) offset. */
  now() {
    if (this.external) return this.externalTime;
    const offset = this.run.offset || 0;
    if (this.phase === PHASE.IDLE) return -offset;
    const end = this.phase === PHASE.PAUSED ? this.pausedAt
      : this.phase === PHASE.ENDED ? this.endedAt
      : performance.now();
    return (end - this.startedAt - this.pausedTotal) / 1000 - offset;
  }

  /** Time spent inside the current (unfinished) segment. */
  currentSegmentTime() {
    const previous = this.lastRealSplit();
    return this.now() - (previous === null ? 0 : previous);
  }

  lastRealSplit() {
    for (let i = this.currentSplit - 1; i >= 0; i--) {
      if (this.splitTimes[i] !== null && this.splitTimes[i] !== undefined) return this.splitTimes[i];
    }
    return null;
  }

  // ---------------------------------------------------------------- actions
  start() {
    if (this.phase !== PHASE.IDLE) return;
    this.startedAt = performance.now();
    this.pausedTotal = 0;
    this.pausedAt = 0;
    this.currentSplit = 0;
    this.splitTimes = new Array(this.run.segments.length).fill(null);
    this.startedIso = new Date().toISOString();
    this.phase = PHASE.RUNNING;
    this.resultsApplied = false;
    this.run.attempts = (this.run.attempts || 0) + 1;
    bus.emit('timer:started', this.snapshot());
    bus.emit('timer:state', this.snapshot());
  }

  /** The one button a runner actually presses: start, then split, then done. */
  split() {
    if (this.phase === PHASE.IDLE) return this.start();
    if (this.phase !== PHASE.RUNNING) return;
    const t = this.now();
    if (t < 0) return;   // still inside the start offset
    this.splitTimes[this.currentSplit] = t;
    this.currentSplit++;
    if (this.currentSplit >= this.run.segments.length) this.finish();
    else bus.emit('timer:split', this.snapshot());
    bus.emit('timer:state', this.snapshot());
  }

  skip() {
    if (this.phase !== PHASE.RUNNING) return;
    if (this.currentSplit >= this.run.segments.length - 1) return; // never skip the last
    this.splitTimes[this.currentSplit] = null;
    this.currentSplit++;
    bus.emit('timer:state', this.snapshot());
  }

  undo() {
    if (this.phase === PHASE.ENDED) {
      // Un-finishing a run withdraws the record finishing just wrote, so the
      // attempt is logged once, when it actually ends. Golds and a new PB
      // stay: those were earned.
      if (this.resultsApplied && this.run.history.length) this.run.history.pop();
      this.resultsApplied = false;
      this.phase = PHASE.RUNNING;
      // Rejoin the running clock where the finish left off.
      this.startedAt = performance.now() - (this.endedAt - this.startedAt);
      this.currentSplit = Math.max(0, this.run.segments.length - 1);
      this.splitTimes[this.currentSplit] = null;
      bus.emit('timer:state', this.snapshot());
      return;
    }
    if (this.phase !== PHASE.RUNNING || this.currentSplit === 0) return;
    this.currentSplit--;
    this.splitTimes[this.currentSplit] = null;
    bus.emit('timer:state', this.snapshot());
  }

  pause() {
    if (this.phase === PHASE.RUNNING) {
      this.pausedAt = performance.now();
      this.phase = PHASE.PAUSED;
    } else if (this.phase === PHASE.PAUSED) {
      this.pausedTotal += performance.now() - this.pausedAt;
      this.pausedAt = 0;
      this.phase = PHASE.RUNNING;
    }
    bus.emit('timer:state', this.snapshot());
  }

  finish() {
    this.endedAt = performance.now();
    this.phase = PHASE.ENDED;
    const summary = this.applyResults();
    bus.emit('timer:finished', summary);
    bus.emit('timer:state', this.snapshot());
    return summary;
  }

  /** Reset back to idle; when keepResults is true the attempt is recorded. */
  reset(keepResults = true) {
    // Finishing already recorded this attempt. Resetting afterwards is how
    // most runners clear the timer, and it must not log the run twice.
    if (keepResults && this.phase !== PHASE.IDLE && !this.resultsApplied) {
      this.applyResults(this.phase !== PHASE.ENDED);
      bus.emit('timer:reset', this.snapshot());
    }
    this.phase = PHASE.IDLE;
    this.startedAt = 0;
    this.pausedTotal = 0;
    this.pausedAt = 0;
    this.endedAt = 0;
    this.currentSplit = 0;
    this.splitTimes = new Array(this.run.segments.length).fill(null);
    bus.emit('timer:state', this.snapshot());
  }

  /**
   * Fold the attempt into the splits: gold segments always, PB only on a
   * completed run that beat the old one. Returns a summary for the history.
   */
  applyResults(partial = false) {
    const finalTime = partial ? null : this.splitTimes[this.run.segments.length - 1];
    const golds = [];
    let previous = 0;
    for (let i = 0; i < this.run.segments.length; i++) {
      const t = this.splitTimes[i];
      if (t === null || t === undefined) { continue; }
      const segTime = t - previous;
      previous = t;
      const seg = this.run.segments[i];
      if (segTime > 0 && (seg.best === null || seg.best === undefined || segTime < seg.best)) {
        seg.best = segTime;
        golds.push({ index: i, name: seg.name, time: segTime });
      }
    }
    const oldPb = this.run.pbTime ?? (this.run.segments.length ? this.run.segments[this.run.segments.length - 1].pb : null);
    let isPb = false;
    if (finalTime !== null && finalTime !== undefined && (oldPb === null || oldPb === undefined || finalTime < oldPb)) {
      isPb = true;
      for (let i = 0; i < this.run.segments.length; i++) {
        this.run.segments[i].pb = this.splitTimes[i] ?? null;
      }
      this.run.pbTime = finalTime;
    }
    this.resultsApplied = true;
    const attempt = {
      id: (this.run.attempts || 0),
      started: this.startedIso,
      ended: new Date().toISOString(),
      real: finalTime ?? null,
      splits: this.splitTimes.slice(),
      game: this.run.game,
      category: this.run.category,
      isPb,
      golds: golds.length,
      reachedSplit: this.currentSplit,
    };
    this.run.history = (this.run.history || []).concat([attempt]).slice(-500);
    bus.emit('timer:results', { attempt, isPb, golds });
    return attempt;
  }

  // ------------------------------------------------------------- statistics
  sumOfBest() {
    let sum = 0;
    for (const seg of this.run.segments) {
      if (seg.best === null || seg.best === undefined) return null;
      sum += seg.best;
    }
    return sum;
  }

  /** Best possible time: elapsed so far plus gold segments for what's left. */
  bestPossible() {
    if (this.phase === PHASE.IDLE) return this.sumOfBest();
    let total = this.lastRealSplit() ?? this.now();
    if (this.currentSplit >= this.run.segments.length) return this.splitTimes[this.run.segments.length - 1];
    // Current segment: at least the time already spent in it.
    const spentHere = this.currentSegmentTime();
    const currentBest = this.run.segments[this.currentSplit].best;
    if (currentBest === null || currentBest === undefined) return null;
    total += Math.max(spentHere, currentBest);
    for (let i = this.currentSplit + 1; i < this.run.segments.length; i++) {
      const best = this.run.segments[i].best;
      if (best === null || best === undefined) return null;
      total += best;
    }
    return total;
  }

  /** Delta vs comparison at a completed split, or null. */
  deltaAt(index) {
    const actual = this.splitTimes[index];
    const compare = this.comparisonAt(index);
    if (actual === null || actual === undefined || compare === null) return null;
    return actual - compare;
  }

  /** Live delta for the split in progress (LiveSplit's "delta" behaviour). */
  liveDelta() {
    if (this.phase === PHASE.IDLE) return null;
    const compare = this.comparisonAt(this.currentSplit);
    if (compare === null) return null;
    const delta = this.now() - compare;
    // Only show a live delta once it is actually losing time, like LiveSplit.
    const previousDelta = this.currentSplit > 0 ? this.lastKnownDelta() : 0;
    if (delta < 0 && previousDelta !== null && delta < previousDelta) return null;
    return delta > 0 || previousDelta === null ? delta : null;
  }

  lastKnownDelta() {
    for (let i = this.currentSplit - 1; i >= 0; i--) {
      const d = this.deltaAt(i);
      if (d !== null) return d;
    }
    return null;
  }

  /**
   * LiveSplit's delta colouring:
   *   ahead + gaining, ahead + losing, behind + losing, behind + gaining, gold.
   */
  deltaClassAt(index) {
    const delta = this.deltaAt(index);
    if (delta === null) return '';
    const segTime = this.segmentTimeAt(index);
    const compareSeg = this.comparisonSegment(index);
    const best = this.run.segments[index].best;
    if (segTime !== null && (best === null || best === undefined || segTime < best)) return 'd-gold';
    const ahead = delta < 0;
    if (segTime === null || compareSeg === null) return ahead ? 'd-ahead' : 'd-behind';
    const gaining = segTime < compareSeg;
    if (ahead && gaining) return 'd-ahead';
    if (ahead && !gaining) return 'd-ahead-loss';
    if (!ahead && gaining) return 'd-behind-gain';
    return 'd-behind';
  }

  segmentTimeAt(index) {
    const t = this.splitTimes[index];
    if (t === null || t === undefined) return null;
    let previous = 0;
    for (let i = index - 1; i >= 0; i--) {
      if (this.splitTimes[i] !== null && this.splitTimes[i] !== undefined) { previous = this.splitTimes[i]; break; }
    }
    return t - previous;
  }

  /** Colour for the big clock: ahead/behind/gold/paused. */
  clockClass() {
    if (this.phase === PHASE.PAUSED) return 'paused';
    if (this.phase === PHASE.IDLE) return '';
    if (this.phase === PHASE.ENDED) {
      const final = this.splitTimes[this.run.segments.length - 1];
      const pb = this.comparisonAt(this.run.segments.length - 1);
      if (pb !== null && final !== null && final < pb) return 'gold';
      return final !== null && pb !== null && final > pb ? 'behind' : 'running';
    }
    const delta = this.lastKnownDelta();
    const live = this.liveDelta();
    if (live !== null && live > 0) return 'behind';
    if (delta === null) return 'running';
    return delta <= 0 ? 'running' : 'behind';
  }

  /** Compact object the overlays and the canvas timer source render from. */
  snapshot() {
    const segs = this.run.segments.map((seg, i) => ({
      name: seg.name,
      time: this.splitTimes[i] ?? null,
      compare: this.comparisonAt(i),
      delta: this.deltaAt(i),
      deltaClass: this.deltaClassAt(i),
      done: i < this.currentSplit,
      current: i === this.currentSplit && this.phase !== PHASE.IDLE,
    }));
    return {
      phase: this.phase,
      time: this.now(),
      clockClass: this.clockClass(),
      game: this.run.game,
      category: this.run.category,
      attempts: this.run.attempts || 0,
      comparison: this.comparison,
      currentSplit: this.currentSplit,
      segments: segs,
      sumOfBest: this.sumOfBest(),
      bestPossible: this.bestPossible(),
      pb: this.run.pbTime ?? null,
      previousSegment: this.previousSegmentDelta(),
      liveDelta: this.liveDelta(),
      external: this.external,
    };
  }

  /** Delta of the segment just completed vs the comparison's segment. */
  previousSegmentDelta() {
    const i = this.currentSplit - 1;
    if (i < 0) return null;
    const segTime = this.segmentTimeAt(i);
    const compareSeg = this.comparisonSegment(i);
    if (segTime === null || compareSeg === null) return null;
    return segTime - compareSeg;
  }

  /** Feed state in from a LiveSplit bridge instead of driving the clock here. */
  applyExternal(state) {
    this.external = true;
    if (typeof state.time === 'number') this.externalTime = state.time;
    if (state.phase) this.phase = state.phase;
    if (typeof state.currentSplit === 'number') this.currentSplit = state.currentSplit;
    if (Array.isArray(state.splitTimes)) this.splitTimes = state.splitTimes;
    bus.emit('timer:state', this.snapshot());
  }

  releaseExternal() {
    this.external = false;
    this.phase = PHASE.IDLE;
    bus.emit('timer:state', this.snapshot());
  }

  exportRun() { return clone(this.run); }
}

function normalizeRun(run) {
  const out = Object.assign(
    { game: '', category: '', offset: 0, attempts: 0, variables: {}, history: [], segments: [] },
    run || {}
  );
  out.segments = (out.segments || []).map((seg, i) => ({
    name: seg.name || `Split ${i + 1}`,
    pb: numOrNull(seg.pb),
    best: numOrNull(seg.best),
    comparisons: seg.comparisons || {},
  }));
  if (!out.segments.length) out.segments = emptyRun().segments;
  if (out.pbTime === undefined || out.pbTime === null) {
    out.pbTime = out.segments[out.segments.length - 1].pb ?? null;
  }
  return out;
}

const numOrNull = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export const timer = new SpeedrunTimer();
