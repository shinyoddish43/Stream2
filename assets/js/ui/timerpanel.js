// The timer dock: LiveSplit's layout, rendered as DOM so it stays crisp and
// costs nothing on the canvas side. Updates at 20 Hz while a run is live and
// stops entirely when it is not — an idle timer should not wake the CPU.

import { $, el, bus, fmtClock, fmtTime, toast } from '../core/util.js';
import { api } from '../core/api.js';
import { PHASE } from '../timer/timer.js';

const UI_HZ = 20;
const PUBLISH_HZ = 5;

export function initTimerPanel(ctx) {
  const { timer, store, link } = ctx;
  const nodes = {
    game: $('#lsGame'), category: $('#lsCategory'), attempts: $('#lsAttempts'),
    splits: $('#lsSplits'), clock: $('#lsClock'), prevSeg: $('#lsPrevSeg'),
    sob: $('#lsSob'), bpt: $('#lsBpt'), pb: $('#lsPb'), split: $('#btnSplit'),
    conn: $('#lsConn'),
  };
  let rows = [];
  let lastSignature = '';
  let lastPublish = 0;
  let publishing = false;

  function buildRows() {
    const snap = timer.snapshot();
    nodes.splits.innerHTML = '';
    rows = snap.segments.map((seg, i) => {
      const name = el('span', { class: 'sp-name', text: seg.name });
      const delta = el('span', { class: 'sp-delta' });
      const time = el('span', { class: 'sp-time' });
      const li = el('li', {}, [name, delta, time]);
      li.addEventListener('dblclick', () => {
        // Jumping the run to a split is a recovery tool, not a feature to hide.
        if (timer.phase === PHASE.RUNNING && confirm(`Jump the run to "${seg.name}"?`)) {
          timer.currentSplit = i;
          bus.emit('timer:state', timer.snapshot());
        }
      });
      nodes.splits.appendChild(li);
      return { li, name, delta, time };
    });
  }

  function renderStatic() {
    const snap = timer.snapshot();
    nodes.game.textContent = snap.game || 'No splits loaded';
    nodes.category.textContent = snap.category || '—';
    nodes.attempts.textContent = String(snap.attempts || 0);
    nodes.pb.textContent = snap.pb === null || snap.pb === undefined ? '—' : fmtTime(snap.pb, { decimals: 0 });
    buildRows();
    renderLive();
  }

  function renderLive() {
    const snap = timer.snapshot();
    const decimals = snap.time >= 3600 ? 1 : (store.get().timer.decimals ?? 2);
    nodes.clock.textContent = fmtClock(snap.time, decimals);
    nodes.clock.className = 'ls-time ' + (snap.clockClass || '');
    nodes.sob.textContent = snap.sumOfBest === null ? '—' : fmtTime(snap.sumOfBest, { decimals: 0 });
    nodes.bpt.textContent = snap.bestPossible === null || snap.bestPossible === undefined
      ? '—' : fmtTime(snap.bestPossible, { decimals: 0 });
    nodes.prevSeg.textContent = snap.previousSegment === null || snap.previousSegment === undefined
      ? '—' : fmtTime(snap.previousSegment, { decimals: 1, forceSign: true });
    nodes.prevSeg.className = deltaClass(snap.previousSegment);

    snap.segments.forEach((seg, i) => {
      const row = rows[i];
      if (!row) return;
      row.li.className = (seg.current ? 'current' : '') + (seg.done ? ' done' : '');
      const showLive = seg.current && snap.liveDelta !== null && snap.liveDelta !== undefined;
      if (seg.delta !== null && seg.delta !== undefined) {
        row.delta.textContent = fmtTime(seg.delta, { decimals: Math.abs(seg.delta) < 60 ? 1 : 0, forceSign: true });
        row.delta.className = 'sp-delta ' + seg.deltaClass;
      } else if (showLive) {
        row.delta.textContent = fmtTime(snap.liveDelta, { decimals: 0, forceSign: true });
        row.delta.className = 'sp-delta d-behind';
      } else {
        row.delta.textContent = '';
        row.delta.className = 'sp-delta';
      }
      const shown = seg.time ?? seg.compare;
      row.time.textContent = shown === null || shown === undefined ? '—' : fmtTime(shown, { decimals: 0 });
    });

    nodes.split.textContent = {
      [PHASE.IDLE]: 'Start',
      [PHASE.RUNNING]: 'Split',
      [PHASE.PAUSED]: 'Resume',
      [PHASE.ENDED]: 'Done',
    }[snap.phase] || 'Split';

    // Keep the current split visible without thrashing scroll on every frame.
    const current = rows[snap.currentSplit];
    if (current && snap.phase === PHASE.RUNNING) {
      const host = nodes.splits;
      const top = current.li.offsetTop;
      if (top < host.scrollTop || top > host.scrollTop + host.clientHeight - 24) {
        host.scrollTop = Math.max(0, top - host.clientHeight / 2);
      }
    }
    maybePublish(snap);
  }

  /** Mirror the timer to the server so overlay pages can follow it. */
  async function maybePublish(snap) {
    if (!store.get().timer.publishState) return;
    const now = performance.now();
    if (publishing || now - lastPublish < 1000 / PUBLISH_HZ) return;
    const signature = snap.phase + '|' + snap.currentSplit + '|' + Math.round(snap.time * 10) + '|' + snap.game;
    if (signature === lastSignature && snap.phase !== PHASE.RUNNING) return;
    lastSignature = signature;
    lastPublish = now;
    publishing = true;
    try { await api.publishState(snap); } catch (e) { /* overlays simply lag */ }
    publishing = false;
  }

  // A single interval drives the dock; it idles when nothing is running.
  let handle = null;
  function ensureTicking() {
    const live = timer.phase === PHASE.RUNNING || timer.external;
    if (live && !handle) handle = setInterval(renderLive, 1000 / UI_HZ);
    if (!live && handle) { clearInterval(handle); handle = null; renderLive(); }
  }

  bus.on('timer:run', renderStatic);
  bus.on('timer:state', () => { ensureTicking(); renderLive(); });
  bus.on('timer:results', ({ attempt, isPb, golds }) => {
    if (isPb) toast('New personal best! ' + fmtTime(attempt.real, { decimals: 2 }), 'ok');
    else if (golds.length) toast(`${golds.length} new best segment${golds.length > 1 ? 's' : ''}`, 'ok');
    // Persist the improved splits and the attempt so nothing is lost on reload.
    const splitsId = store.get().timer.splitsId;
    const run = timer.exportRun();
    if (splitsId) { run.id = splitsId; api.saveSplits(run).catch(() => {}); }
    api.addRun({
      game: run.game, category: run.category, time: attempt.real,
      isPb, golds: golds.length, reachedSplit: attempt.reachedSplit, splits: attempt.splits,
    }).catch(() => {});
  });

  bus.on('livesplit:state', ({ state, detail }) => {
    nodes.conn.dataset.state = state === 'on' ? 'on' : state === 'err' ? 'err' : 'off';
    nodes.conn.textContent = state === 'on' ? 'LiveSplit linked'
      : state === 'connecting' ? 'connecting…'
      : state === 'err' ? (detail || 'link error')
      : 'local timer';
  });

  const actions = {
    'timer-split': () => { timer.split(); link.command('split'); },
    'timer-undo': () => { timer.undo(); link.command('undo'); },
    'timer-skip': () => { timer.skip(); link.command('skip'); },
    'timer-pause': () => { timer.pause(); link.command('pause'); },
    'timer-reset': () => {
      if (timer.phase === PHASE.IDLE) return;
      if (!confirm('Reset the run? Best segments are kept.')) return;
      timer.reset(true);
      link.command('reset');
    },
    'timer-popout': () => {
      const token = ctx.boot.overlayToken;
      const url = location.href.replace(/[^/]*$/, '') + 'overlay/timer.html?token=' + token;
      window.open(url, 'studio-timer', 'width=340,height=560,menubar=no,toolbar=no');
    },
    'timer-settings': () => bus.emit('ui:open-splits'),
  };

  renderStatic();
  return { actions, renderStatic, renderLive };
}

function deltaClass(delta) {
  if (delta === null || delta === undefined) return '';
  return delta <= 0 ? 'd-ahead' : 'd-behind';
}
