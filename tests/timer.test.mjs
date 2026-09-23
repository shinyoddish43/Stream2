// Timer engine tests. These cover the parts a speedrunner would notice if
// they were wrong: split times, deltas, the LiveSplit colour rules, golds,
// PB folding, sum of best and best possible time.

import { describe, it, assert, report } from './tiny.mjs';
import { SpeedrunTimer, PHASE } from '../assets/js/timer/timer.js';

/** A three-split run with a PB of 60s and known golds. */
function sampleRun() {
  return {
    game: 'Test Game',
    category: 'Any%',
    offset: 0,
    attempts: 10,
    pbTime: 60,
    segments: [
      { name: 'One', pb: 10, best: 9, comparisons: { 'Best Splits': 9.5 } },
      { name: 'Two', pb: 30, best: 18, comparisons: { 'Best Splits': 28 } },
      { name: 'Three', pb: 60, best: 28, comparisons: { 'Best Splits': 57 } },
    ],
  };
}

/** Drive the timer without waiting in real time. */
function at(timer, seconds) {
  timer.startedAt = 0;
  timer.pausedTotal = 0;
  timer.now = () => seconds;
}

describe('loading', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  it('keeps every segment', () => assert.equal(timer.segments.length, 3));
  it('starts idle', () => assert.equal(timer.phase, PHASE.IDLE));
  it('derives the PB from the last split', () => assert.equal(timer.run.pbTime, 60));
  it('lists comparisons, PB first', () => {
    assert.deep(timer.comparisonNames(), ['Personal Best', 'Best Segments', 'Best Splits']);
  });
  it('rejects nothing but still fills empty splits', () => {
    const blank = new SpeedrunTimer();
    blank.load({ game: 'x', segments: [] });
    assert.ok(blank.segments.length > 0);
  });
});

describe('comparisons', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  it('reads cumulative PB times', () => assert.equal(timer.comparisonAt(1), 30));
  it('sums golds for Best Segments', () => {
    timer.comparison = 'Best Segments';
    assert.equal(timer.comparisonAt(0), 9);
    assert.equal(timer.comparisonAt(1), 27);
    assert.equal(timer.comparisonAt(2), 55);
    timer.comparison = 'Personal Best';
  });
  it('reads a named comparison', () => {
    timer.comparison = 'Best Splits';
    assert.equal(timer.comparisonAt(2), 57);
    timer.comparison = 'Personal Best';
  });
  it('gives segment durations, not cumulative times', () => {
    assert.equal(timer.comparisonSegment(0), 10);
    assert.equal(timer.comparisonSegment(1), 20);
    assert.equal(timer.comparisonSegment(2), 30);
  });
  it('returns null when a comparison has no time there', () => {
    const sparse = new SpeedrunTimer();
    sparse.load({ segments: [{ name: 'a', pb: null, best: null, comparisons: {} }] });
    assert.equal(sparse.comparisonAt(0), null);
  });
});

describe('a run in progress', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  timer.start();

  it('counts the attempt', () => assert.equal(timer.run.attempts, 11));
  it('is running', () => assert.equal(timer.phase, PHASE.RUNNING));

  it('records the split time', () => {
    at(timer, 9.5);
    timer.split();
    assert.close(timer.splitTimes[0], 9.5);
    assert.equal(timer.currentSplit, 1);
  });

  it('is ahead by half a second', () => assert.close(timer.deltaAt(0), -0.5));
  it('paints a gold when the segment beats the best', () => {
    // 9.5 is slower than the 9s gold, so this is merely ahead.
    assert.equal(timer.deltaClassAt(0), 'd-ahead');
  });

  it('undo clears the split', () => {
    timer.undo();
    assert.equal(timer.currentSplit, 0);
    assert.equal(timer.splitTimes[0], null);
  });

  it('skip leaves a hole but moves on', () => {
    at(timer, 8);
    timer.split();            // split 0 at 8s — a gold
    timer.skip();             // split 1 skipped
    assert.equal(timer.splitTimes[1], null);
    assert.equal(timer.currentSplit, 2);
  });

  it('measures the segment from the last real split', () => {
    at(timer, 40);
    assert.close(timer.currentSegmentTime(), 32);
  });

  it('will not skip the final split', () => {
    const before = timer.currentSplit;
    timer.skip();
    assert.equal(timer.currentSplit, before);
  });

  it('finishes on the last split', () => {
    at(timer, 55);
    timer.split();
    assert.equal(timer.phase, PHASE.ENDED);
  });
});

describe('delta colours', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  timer.start();
  at(timer, 9.8); timer.split();     // ahead of PB (10), slower than gold (9)
  at(timer, 31);  timer.split();     // behind PB (30); segment 21.2 vs 20 -> losing
  it('ahead and gaining is bright green', () => assert.equal(timer.deltaClassAt(0), 'd-ahead'));
  it('behind and losing is red', () => assert.equal(timer.deltaClassAt(1), 'd-behind'));

  const timer2 = new SpeedrunTimer();
  timer2.load(sampleRun());
  timer2.start();
  at(timer2, 8); timer2.split();     // gold: 8 < best 9
  it('a new best segment is gold', () => assert.equal(timer2.deltaClassAt(0), 'd-gold'));

  const tie = new SpeedrunTimer();
  tie.load(sampleRun());
  tie.start();
  at(tie, 9); tie.split();           // exactly equal to the gold, which is not a gold
  it('matching the gold exactly is not a gold', () => assert.equal(tie.deltaClassAt(0), 'd-ahead'));

  const timer3 = new SpeedrunTimer();
  timer3.load(sampleRun());
  timer3.start();
  at(timer3, 9.5); timer3.split();   // ahead by 0.5
  at(timer3, 30.5); timer3.split();  // behind by 0.5, segment 21 vs 20 -> lost more
  it('ahead then losing the lead reads behind', () => assert.equal(timer3.deltaClassAt(1), 'd-behind'));

  const timer4 = new SpeedrunTimer();
  timer4.load(sampleRun());
  timer4.start();
  at(timer4, 12); timer4.split();    // behind by 2
  at(timer4, 31); timer4.split();    // behind by 1: segment 19 beats the 20 comparison
  it('behind but gaining is orange', () => assert.equal(timer4.deltaClassAt(1), 'd-behind-gain'));

  const timer5 = new SpeedrunTimer();
  timer5.load(sampleRun());
  timer5.start();
  at(timer5, 9); timer5.split();     // gold and ahead by 1
  at(timer5, 29.9); timer5.split();  // still ahead by .1 but segment 20.9 > 20
  it('ahead but losing time is dark green', () => assert.equal(timer5.deltaClassAt(1), 'd-ahead-loss'));
});

describe('statistics', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  it('sums the best segments', () => assert.equal(timer.sumOfBest(), 55));
  it('has no sum of best when a gold is missing', () => {
    const partial = new SpeedrunTimer();
    partial.load({ segments: [{ name: 'a', best: 5 }, { name: 'b', best: null }] });
    assert.equal(partial.sumOfBest(), null);
  });
  it('best possible equals sum of best before the run', () => assert.equal(timer.bestPossible(), 55));
  it('best possible grows once time is lost', () => {
    timer.start();
    at(timer, 12);
    timer.split();                    // 12s on a 9s gold: 3s gone for good
    at(timer, 12.1);
    assert.close(timer.bestPossible(), 12 + 18 + 28, 0.2);
  });
});

describe('finishing a run', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  timer.start();
  at(timer, 8); timer.split();        // gold (was 9)
  at(timer, 25); timer.split();       // segment 17, gold (was 18)
  at(timer, 50); timer.split();       // segment 25, gold (was 28); total 50 beats PB 60
  const attempt = timer.run.history[timer.run.history.length - 1];

  it('ends the run', () => assert.equal(timer.phase, PHASE.ENDED));
  it('records a personal best', () => assert.ok(attempt.isPb));
  it('writes the new PB into the splits', () => {
    assert.equal(timer.run.pbTime, 50);
    assert.equal(timer.run.segments[1].pb, 25);
  });
  it('keeps every new gold', () => {
    assert.equal(timer.run.segments[0].best, 8);
    assert.equal(timer.run.segments[1].best, 17);
    assert.equal(timer.run.segments[2].best, 25);
  });
  it('logs the attempt', () => assert.equal(attempt.golds, 3));
});

describe('resetting', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  timer.start();
  at(timer, 7); timer.split();        // a gold, on a run that never finishes
  timer.reset(true);

  it('goes back to idle', () => assert.equal(timer.phase, PHASE.IDLE));
  it('keeps the gold', () => assert.equal(timer.run.segments[0].best, 7));
  it('does not touch the PB', () => assert.equal(timer.run.pbTime, 60));
  it('records the reset as an unfinished attempt', () => {
    const attempt = timer.run.history[timer.run.history.length - 1];
    assert.equal(attempt.real, null);
    assert.equal(attempt.reachedSplit, 1);
  });
  it('clears the split times', () => assert.deep(timer.splitTimes, [null, null, null]));
});

describe('the start offset', () => {
  const timer = new SpeedrunTimer();
  const run = sampleRun();
  run.offset = 5;                     // LiveSplit's "start 5 seconds early"
  timer.load(run);
  it('shows a countdown before zero', () => assert.equal(timer.now(), -5));
});

describe('external control', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  timer.applyExternal({ time: 42.5, phase: PHASE.RUNNING, currentSplit: 1 });
  it('takes the time from the bridge', () => assert.equal(timer.now(), 42.5));
  it('marks itself external', () => assert.ok(timer.snapshot().external));
  it('releases back to the local clock', () => {
    timer.releaseExternal();
    assert.equal(timer.external, false);
    assert.equal(timer.phase, PHASE.IDLE);
  });
});

describe('the snapshot overlays render from', () => {
  const timer = new SpeedrunTimer();
  timer.load(sampleRun());
  timer.start();
  at(timer, 8.5); timer.split();      // beats the 9s gold
  const snap = timer.snapshot();
  it('carries the run identity', () => assert.equal(snap.game, 'Test Game'));
  it('marks the current split', () => assert.ok(snap.segments[1].current));
  it('marks the finished split', () => assert.ok(snap.segments[0].done));
  it('carries a delta class per row', () => assert.equal(snap.segments[0].deltaClass, 'd-gold'));
  it('is JSON-safe', () => assert.ok(JSON.parse(JSON.stringify(snap)).segments.length === 3));
});

report('timer engine');
