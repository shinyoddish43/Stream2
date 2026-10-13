// The timer engine: what a runner would notice if it were wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timer, fmt, parseTime, formatTime } from '../public/timer.js';

const run = () => ({
  game: 'Test', category: 'Any%', attempts: 10,
  segments: [
    { name: 'One', pb: 10, best: 9 },
    { name: 'Two', pb: 30, best: 18 },
    { name: 'Three', pb: 60, best: 28 },
  ],
});

// Drive the clock by hand instead of waiting in real time.
function at(timer, seconds) { timer.now = () => seconds; }

test('starts, splits and finishes', () => {
  const t = new Timer();
  t.load(run());
  assert.equal(t.split(), 'start');
  assert.equal(t.run.attempts, 11);
  at(t, 9.5); assert.equal(t.split(), 'split');
  at(t, 29); assert.equal(t.split(), 'split');
  at(t, 58); assert.equal(t.split(), 'finish');
  assert.equal(t.phase, 'ended');
  assert.deepEqual(t.times, [9.5, 29, 58]);
});

test('a faster finish becomes the PB, and golds are kept', () => {
  const t = new Timer();
  t.load(run());
  t.split();
  at(t, 8); t.split();       // 8 beats the 9 gold
  at(t, 25); t.split();      // segment 17 beats 18
  at(t, 50); t.split();      // 50 beats the 60 PB
  assert.equal(t.run.pb, 50);
  assert.deepEqual(t.run.segments.map((s) => s.pb), [8, 25, 50]);
  assert.deepEqual(t.run.segments.map((s) => s.best), [8, 17, 25]);
});

test('a slower finish leaves the PB alone', () => {
  const t = new Timer();
  t.load(run());
  t.split();
  at(t, 12); t.split();
  at(t, 40); t.split();
  at(t, 70); t.split();
  assert.equal(t.run.pb, 60);
  assert.equal(t.run.segments[2].pb, 60);
});

test('a finished run is recorded once, even after reset', () => {
  const t = new Timer();
  t.load(run());
  t.split(); at(t, 9); t.split(); at(t, 29); t.split(); at(t, 59); t.split();
  assert.equal(t.run.history.length, 1);
  t.reset();
  assert.equal(t.run.history.length, 1);
  assert.equal(t.phase, 'idle');
});

test('resetting mid-run records the attempt and keeps golds', () => {
  const t = new Timer();
  t.load(run());
  t.split(); at(t, 7); t.split();
  t.reset();
  assert.equal(t.run.segments[0].best, 7);
  assert.equal(t.run.pb, 60);
  assert.equal(t.run.history.at(-1).real, null);
});

test('undo and skip', () => {
  const t = new Timer();
  t.load(run());
  t.split(); at(t, 9); t.split();
  t.undo();
  assert.equal(t.index, 0);
  assert.equal(t.times[0], null);
  at(t, 9); t.split();
  t.skip();
  assert.equal(t.times[1], null);
  assert.equal(t.index, 2);
  t.skip();                                   // never skips the last split
  assert.equal(t.index, 2);
});

test('undoing a finish withdraws its record', () => {
  const t = new Timer();
  t.load(run());
  t.split(); at(t, 9); t.split(); at(t, 29); t.split(); at(t, 59); t.split();
  t.undo();
  assert.equal(t.phase, 'running');
  assert.equal(t.run.history.length, 0);
});

test('undoing an accidental PB restores comparisons before a corrected finish', () => {
  const t = new Timer();
  t.load(run());
  t.split(); at(t, 8); t.split(); at(t, 25); t.split(); at(t, 40); t.split();
  assert.equal(t.run.pb, 40);
  assert.equal(t.undo(), 'undo-finish');
  assert.equal(t.run.pb, 60);
  assert.deepEqual(t.run.segments.map((s) => s.pb), [10, 30, 60]);
  assert.deepEqual(t.run.segments.map((s) => s.best), [8, 17, 15], 'earned golds remain');
  at(t, 70); t.split();
  assert.equal(t.run.pb, 60, 'the accidental PB must not survive the correction');
  assert.equal(t.run.history.at(-1).real, 70);
  t.undo(); at(t, 50); t.split();
  assert.equal(t.run.pb, 50, 'a corrected genuine PB can still be recorded');
});

test('withdrawing a finish restores capped history and a previously unset PB', () => {
  const t = new Timer();
  const history = Array.from({ length: 500 }, (_, id) => ({ id, real: null }));
  t.load({ attempts: 500, history, segments: [{ name: 'Finish', best: null }] });
  t.split(); at(t, 10); t.split(); t.undo();
  assert.equal(t.run.pb, null);
  assert.equal(t.run.segments[0].pb, null);
  assert.deepEqual(t.run.history, history, 'undo also recovers the oldest capped entry');
  t.reset();
  assert.equal(t.run.history.at(-1).real, null);
  assert.equal(t.run.history.length, 500);
});

test('delta colours follow LiveSplit', () => {
  const t = new Timer();
  t.load(run());
  t.split();
  at(t, 8); t.split();      // gold
  at(t, 31); t.split();     // behind PB (30), segment 23 vs 20: losing
  const rows = t.snapshot().rows;
  assert.equal(rows[0].color, 'gold');
  assert.equal(rows[1].color, 'behind');
  assert.equal(Math.round(rows[1].delta), 1);
});

test('sum of best and the snapshot', () => {
  const t = new Timer();
  t.load(run());
  assert.equal(t.sumOfBest(), 55);
  const snap = t.snapshot();
  assert.equal(snap.game, 'Test');
  assert.equal(snap.rows.length, 3);
  assert.equal(snap.clock, 'idle');
  assert.ok(JSON.stringify(snap));
});

test('blank and broken splits still give a usable timer', () => {
  const t = new Timer();
  t.load(null);
  assert.ok(t.run.segments.length > 0);
  t.load({ segments: [{ name: 'A', pb: 'garbage', best: null }] });
  assert.equal(t.run.segments[0].pb, null);
});

test('time formatting and .lss time parsing', () => {
  assert.equal(fmt(62.5, 2), '1:02.50');
  assert.equal(fmt(3723), '1:02:03');
  assert.equal(fmt(null), '—');
  assert.equal(parseTime('01:02:03.5'), 3723.5);
  assert.equal(parseTime('1.00:00:10'), 86410);
  assert.equal(parseTime(''), null);
  assert.equal(formatTime(3723.5), '01:02:03.5000000');
});

test('rounded timer and LSS durations carry across minutes and hours', () => {
  assert.equal(fmt(59.999, 2), '1:00.00');
  assert.equal(fmt(3599.999, 2), '1:00:00.00');
  assert.equal(fmt(-59.999, 2), '-1:00.00');
  assert.equal(fmt(59.999), '0:59', 'whole-second display still truncates');
  assert.equal(fmt(59.994, 2), '0:59.99');
  assert.equal(formatTime(59.99999999), '00:01:00.0000000');
  assert.equal(formatTime(3599.99999999), '01:00:00.0000000');
  assert.equal(parseTime(formatTime(59.99999999)), 60);
});
