// UI smoke test. Boots a real PHP server in a throwaway copy of the app,
// drives the studio in headless Chromium, and fails on any console error.
//
// Playwright is optional — this test skips itself when it is not installed,
// because the project must stay installable without npm.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.TEST_PORT || 8978;
const BASE = `http://127.0.0.1:${PORT}`;

let chromium;
try {
  // PLAYWRIGHT_PATH lets a CI box point at a playwright installed elsewhere,
  // so the project itself never needs a node_modules directory.
  ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (e) {
  console.log('browser: skipped (playwright not installed)');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'studio-browser-'));
for (const item of ['api', 'lib', 'assets', 'overlay', 'index.php', 'login.php', 'install.php']) {
  cpSync(join(ROOT, item), join(work, item), { recursive: true });
}
mkdirSync(join(work, 'data'), { recursive: true });

const server = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', work], { stdio: 'ignore' });
let passed = 0;
let failed = 0;
const problems = [];

const check = (name, condition, detail = '') => {
  if (condition) { passed++; process.stdout.write('.'); }
  else { failed++; process.stdout.write('x'); problems.push(`  FAIL ${name}${detail ? '\n    ' + detail : ''}`); }
};

const finish = async (browser) => {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  rmSync(work, { recursive: true, force: true });
  process.stdout.write('\n');
  for (const problem of problems) console.log(problem);
  console.log(`browser: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

// Wait for PHP to come up.
for (let i = 0; i < 40; i++) {
  try { await fetch(`${BASE}/api/index.php?r=health`); break; } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
}

// Install through the real installer, the way a user would.
await fetch(`${BASE}/install.php`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'username=tester&password=hunter2hunter2&password2=hunter2hunter2&site_name=CI+Studio',
});

let browser;
try {
  // Use the browser Playwright installed unless a path is given. The default
  // below is where this project's container keeps Chromium.
  const executablePath = process.env.CHROMIUM_PATH === ''
    ? undefined
    : (process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium');
  browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  // An explicit context, so the overlay page later can share it — pages in
  // separate contexts cannot see each other's BroadcastChannel.
  const context = await browser.newContext({ viewport: { width: 1500, height: 860 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(`${BASE}/login.php`);
  await page.fill('input[name=username]', 'tester');
  await page.fill('input[name=password]', 'hunter2hunter2');
  await page.click('button[type=submit]');
  await page.waitForURL('**/index.php');
  await page.waitForTimeout(2500);

  const boot = await page.evaluate(() => ({
    fps: document.getElementById('statFps').textContent,
    scenes: document.querySelectorAll('#sceneList .row-item').length,
    sources: document.querySelectorAll('#sourceList .row-item').length,
    splits: document.querySelectorAll('#lsSplits li').length,
    comparisons: document.querySelectorAll('#lsComparison option').length,
    // The default scene paints a gradient backdrop and the timer panel.
    background: document.getElementById('programCanvas').getContext('2d').getImageData(900, 600, 1, 1).data[2],
    timerPanel: document.getElementById('programCanvas').getContext('2d').getImageData(60, 60, 1, 1).data[2],
  }));
  check('a still scene idles instead of burning frames', boot.fps === 'idle' || Number(boot.fps) < 5, `fps=${boot.fps}`);
  check('the default scene loads', boot.scenes === 1 && boot.sources === 2, JSON.stringify(boot));
  check('the timer dock lists splits', boot.splits === 3, `splits=${boot.splits}`);
  check('the comparison picker is populated', boot.comparisons >= 2, `options=${boot.comparisons}`);
  check('the backdrop is composited', boot.background > 0, `blue=${boot.background}`);
  check('the timer source is composited', boot.timerPanel > 0, `blue=${boot.timerPanel}`);

  // Run the timer.
  await page.click('#btnSplit');
  await page.waitForTimeout(700);
  await page.click('#btnSplit');
  await page.waitForTimeout(300);
  const running = await page.evaluate(() => ({
    clock: document.getElementById('lsClock').textContent,
    label: document.getElementById('btnSplit').textContent,
    current: document.querySelectorAll('#lsSplits li.current').length,
    done: document.querySelectorAll('#lsSplits li.done').length,
  }));
  check('the clock advances', parseFloat(running.clock.replace(':', '')) > 0, `clock=${running.clock}`);
  await page.waitForTimeout(1500);   // let a full stats window elapse
  const runningFps = await page.evaluate(() => document.getElementById('statFps').textContent);
  check('a running timer wakes the compositor', Number(runningFps) >= 24, `fps=${runningFps}`);
  check('the split button becomes Split', running.label === 'Split', running.label);
  check('one split is marked done', running.done === 1, `done=${running.done}`);
  check('the next split is highlighted', running.current === 1, `current=${running.current}`);

  // Every dialog opens and closes.
  for (const action of ['open-settings', 'open-splits', 'open-destinations', 'open-overlays',
                        'open-hotkeys', 'open-help', 'timer-history', 'source-add']) {
    let ok = true;
    try {
      await page.click(`[data-action="${action}"]`);
      await page.waitForTimeout(400);
      ok = await page.evaluate(() => !document.getElementById('modalRoot').hidden);
      await page.click('#modalRoot .modal-head .icon');
      await page.waitForTimeout(200);
      ok = ok && await page.evaluate(() => document.getElementById('modalRoot').hidden);
    } catch (e) { ok = false; }
    check(`dialog ${action} opens and closes`, ok);
  }

  // Add a source through the picker.
  const before = await page.evaluate(() => document.querySelectorAll('#sourceList .row-item').length);
  await page.click('[data-action="source-add"]');
  await page.waitForTimeout(300);
  await page.click('.src-card >> nth=3');
  await page.waitForTimeout(600);
  await page.click('#modalRoot .modal-foot .btn.primary').catch(() => {});
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => document.querySelectorAll('#sourceList .row-item').length);
  check('a source can be added', after === before + 1, `${before} -> ${after}`);

  // The starter layout: four scenes, placed and drawn.
  await page.click('[data-action="scene-starter"]');
  await page.waitForTimeout(300);
  await page.click('#modalRoot .modal-foot .btn.primary');
  await page.waitForTimeout(900);
  const starter = await page.evaluate(() => {
    const doc = window.STUDIO.store.get();
    const names = doc.scenes.map((s) => s.name);
    const run = doc.scenes.find((s) => s.name === 'Run');
    const soon = doc.scenes.find((s) => s.name === 'Starting soon');
    return {
      names,
      runHasTimer: !!run && run.sources.some((s) => s.type === 'timer'),
      soonHasCountdown: !!soon && soon.sources.some((s) => s.type === 'countdown'),
      // Every source must land inside the canvas, whatever the resolution.
      inBounds: doc.scenes.every((s) => s.sources.every((i) =>
        i.x >= 0 && i.y >= 0 && i.x + i.w <= doc.canvas.w && i.y + i.h <= doc.canvas.h)),
    };
  });
  check('the starter layout adds its four scenes',
    ['Starting soon', 'Run', 'Break', 'Ending'].every((n) => starter.names.includes(n)), JSON.stringify(starter.names));
  check('the run scene carries the timer', starter.runHasTimer);
  check('the starting scene carries a countdown', starter.soonHasCountdown);
  check('every placed source fits the canvas', starter.inBounds);

  // A running countdown paints and counts down.
  const counting = await page.evaluate(async () => {
    const doc = window.STUDIO.store.get();
    const soon = doc.scenes.find((s) => s.name === 'Starting soon');
    window.STUDIO.store.update((d) => {
      d.activeScene = soon.id;
      d.previewScene = soon.id;
      soon.sources.find((s) => s.type === 'countdown').settings.endsAt = Date.now() + 65000;
    });
    await new Promise((r) => setTimeout(r, 1400));
    const canvas = document.getElementById('programCanvas');
    const ctx = canvas.getContext('2d');
    // Anything drawn in the countdown band makes it non-empty.
    const band = ctx.getImageData(0, Math.round(canvas.height * 0.55), canvas.width, Math.round(canvas.height * 0.16)).data;
    let bright = 0;
    for (let i = 0; i < band.length; i += 4) if (band[i] > 200 && band[i + 1] > 200) bright++;
    const fps = document.getElementById('statFps').textContent;
    return { bright, fps };
  });
  check('the countdown is painted into the canvas', counting.bright > 50, `bright pixels=${counting.bright}`);
  check('a running countdown keeps the compositor awake', Number(counting.fps) >= 10, `fps=${counting.fps}`);

  // Scenes and studio mode.
  await page.click('[data-action="scene-add"]');
  await page.waitForTimeout(400);
  await page.check('#studioModeToggle');
  await page.waitForTimeout(400);
  await page.click('#btnTransition');
  await page.waitForTimeout(800);
  const studio = await page.evaluate(() => ({
    scenes: document.querySelectorAll('#sceneList .row-item').length,
    preview: !document.getElementById('viewPreview').hidden,
    live: !!document.querySelector('#sceneList .row-sub'),
  }));
  check('a scene can be added', studio.scenes === 6, `scenes=${studio.scenes}`);
  check('studio mode shows the preview', studio.preview);
  check('a scene is on air', studio.live);

  // The layout survives a reload (it is saved server-side).
  await page.reload();
  await page.waitForTimeout(2500);
  const reloaded = await page.evaluate(() => document.querySelectorAll('#sceneList .row-item').length);
  check('the layout persists across a reload', reloaded === 6, `scenes=${reloaded}`);

  // Image sources: composited, croppable, and a feed with no URL must not
  // arm a timer on every rendered frame (it used to).
  const images = await page.evaluate(async () => {
    // A 100x100 PNG, left half red and right half blue. Big enough that
    // scaling cannot blend the halves into each other.
    const src = document.createElement('canvas');
    src.width = 100; src.height = 100;
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#ff0000'; sctx.fillRect(0, 0, 50, 100);
    sctx.fillStyle = '#0000ff'; sctx.fillRect(50, 0, 50, 100);
    const dataUrl = src.toDataURL('image/png');

    const store = window.STUDIO.store;
    store.update((d) => {
      const scene = { id: 'sc_img', name: 'Image test', sources: [{
        id: 'sr_img', type: 'image', name: 'Test image', visible: true, locked: false,
        x: 0, y: 0, w: 1280, h: 720, opacity: 1, settings: { url: dataUrl, fit: 'stretch' },
      }] };
      d.scenes.push(scene);
      d.studioMode = false;
      d.activeScene = scene.id;
      d.previewScene = scene.id;
    });
    await new Promise((r) => setTimeout(r, 1200));
    const ctx = document.getElementById('programCanvas').getContext('2d');
    const left = Array.from(ctx.getImageData(200, 360, 1, 1).data).slice(0, 3);
    const right = Array.from(ctx.getImageData(1000, 360, 1, 1).data).slice(0, 3);

    // Crop to the right-hand (blue) pixel: the whole box should turn blue.
    const item = store.editScene().sources[0];
    store.update(() => { item.settings.crop = { x: 50, y: 0, w: 50, h: 100 }; });
    await new Promise((r) => setTimeout(r, 800));
    const cropped = Array.from(ctx.getImageData(200, 360, 1, 1).data).slice(0, 3);

    // A refreshing-image source with no URL, watched for timer churn.
    const realSetInterval = window.setInterval;
    let intervals = 0;
    window.setInterval = function (...args) { intervals++; return realSetInterval.apply(window, args); };
    store.update((d) => {
      d.scenes[d.scenes.length - 1].sources.push({
        id: 'sr_feed', type: 'imagefeed', name: 'Feed', visible: true, locked: false,
        x: 0, y: 0, w: 100, h: 100, opacity: 1, settings: { url: '', interval: 5 },
      });
    });
    await new Promise((r) => setTimeout(r, 1500));
    window.setInterval = realSetInterval;

    return { left, right, cropped, intervals };
  });
  check('an image source is composited', images.left.join(',') === '255,0,0', JSON.stringify(images));
  check('across its whole box', images.right.join(',') === '0,0,255', JSON.stringify(images));
  check('cropping selects part of the source', images.cropped.join(',') === '0,0,255', JSON.stringify(images));
  check('a feed with no URL does not arm a timer per frame', images.intervals <= 1, `${images.intervals} intervals`);

  // Regression: dragging a source on a still scene moved the handles but not
  // the picture, because the drag path skips the event bus that marks the
  // canvas dirty.
  const dragged = await page.evaluate(async () => {
    const store = window.STUDIO.store;
    const compositor = window.STUDIO.compositor;
    // A scene that does not animate: one flat colour block, nothing else.
    store.update((d) => {
      const scene = { id: 'sc_drag', name: 'Drag test', sources: [{
        id: 'sr_drag', type: 'color', name: 'Block', visible: true, locked: false,
        x: 40, y: 40, w: 200, h: 200, opacity: 1, settings: { color: '#ff0000' },
      }] };
      d.scenes.push(scene);
      d.studioMode = false;
      d.activeScene = scene.id;
      d.previewScene = scene.id;
    });
    compositor.select('sr_drag');
    await new Promise((r) => setTimeout(r, 900));      // let it settle into idle
    // Turning studio mode off through the document alone must be enough: the
    // panes and the transform layers follow the document, not the checkbox.
    if (!window.STUDIO.transformLayers.program.enabled) return { skipped: 'program layer not enabled' };
    const ctx = document.getElementById('programCanvas').getContext('2d');
    // (200,200) sits inside the block where it starts and outside it after the
    // drag moves it up and left, so it is the pixel that proves a repaint.
    const before = { probe: ctx.getImageData(200, 200, 1, 1).data[0] };

    // Move it the way a pointer drag does, through the transform layer.
    const layer = window.STUDIO.transformLayers.program;
    const item = store.editScene().sources[0];
    layer.drag = { mode: 'move', item, start: { x: 100, y: 100 }, box: { ...item } };
    layer.onMove({ clientX: 0, clientY: 0, ctrlKey: true,
      target: document.getElementById('programCanvas') });
    await new Promise((r) => setTimeout(r, 400));
    const after = { probe: ctx.getImageData(200, 200, 1, 1).data[0] };
    layer.drag = null;
    return { before, after, moved: item.x !== 40 || item.y !== 40, box: { x: item.x, y: item.y } };
  });
  check('the panes follow studio mode however it changed', !dragged.skipped, JSON.stringify(dragged));
  check('a drag moves the source', dragged.moved, JSON.stringify(dragged));
  check('and the still scene repaints to match',
    dragged.before.probe === 255 && dragged.after.probe !== 255, JSON.stringify(dragged));

  // Regression: removing an audio strip used to stop every track on the
  // stream it came from, which killed a display capture's video with it.
  const audio = await page.evaluate(async () => {
    const { mixer } = await import('./assets/js/core/audio.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    const stream = canvas.captureStream(5);          // stands in for a screen share
    const ctx = new AudioContext();
    const destination = ctx.createMediaStreamDestination();
    ctx.createOscillator().connect(destination);
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    mixer.addStream(stream, { id: 'test-strip', name: 'Test' });
    const before = stream.getVideoTracks()[0].readyState;
    mixer.removeStrip('test-strip');
    return {
      before,
      videoAfter: stream.getVideoTracks()[0].readyState,
      audioAfter: stream.getAudioTracks()[0].readyState,
    };
  });
  check('removing an audio strip leaves the video capture running',
    audio.before === 'live' && audio.videoAfter === 'live', JSON.stringify(audio));
  check('removing an audio strip does stop its own audio track',
    audio.audioAfter === 'ended', JSON.stringify(audio));

  // Regression: in studio mode the handles sat on the program canvas but
  // edited the preview scene.
  const layers = await page.evaluate(() => {
    const on = window.STUDIO.store.get().studioMode;
    return {
      on,
      program: document.getElementById('editLayer').classList.contains('active'),
      preview: document.getElementById('previewEditLayer').classList.contains('active'),
    };
  });
  check('editing follows the canvas that shows the edited scene',
    layers.on ? (layers.preview && !layers.program) : (layers.program && !layers.preview), JSON.stringify(layers));

  // Regression: a transition in studio mode left preview and program on the
  // same scene instead of swapping them.
  const swap = await page.evaluate(async () => {
    const d = window.STUDIO.store.get();
    const [a, b] = d.scenes;
    window.STUDIO.store.update((doc) => { doc.studioMode = true; doc.activeScene = a.id; doc.previewScene = b.id; });
    document.getElementById('btnTransition').click();
    await new Promise((r) => setTimeout(r, 900));
    const after = window.STUDIO.store.get();
    return { program: after.activeScene === b.id, preview: after.previewScene === a.id };
  });
  check('a studio-mode transition puts the cued scene on air', swap.program, JSON.stringify(swap));
  check('and cues up what was on air', swap.preview, JSON.stringify(swap));

  // Scene hotkeys: Ctrl+Shift+N, because Ctrl+N belongs to the browser.
  const hotkey = await page.evaluate(() => {
    window.STUDIO.store.update((d) => { d.studioMode = false; d.activeScene = d.scenes[0].id; });
    return window.STUDIO.store.get().scenes[2].id;
  });
  await page.keyboard.press('Control+Shift+Digit3');
  await page.waitForTimeout(700);
  const switched = await page.evaluate(() => window.STUDIO.store.get().activeScene);
  check('Ctrl+Shift+3 switches to the third scene', switched === hotkey, `${switched} vs ${hotkey}`);

  // The splits editor speaks clock time, not raw seconds.
  await page.click('[data-action="open-splits"]');
  await page.waitForTimeout(400);
  const newSplits = page.locator('#modalRoot .modal-foot button', { hasText: 'New splits' });
  await newSplits.click();
  await page.waitForTimeout(400);
  await page.fill('#modalRoot .field:nth-of-type(1) input', 'Test Game');
  const rows = await page.evaluate(() => document.querySelectorAll('#modalRoot table.grid tbody tr').length);
  check('the editor opens with the blank run', rows === 3, `rows=${rows}`);
  // Segment 1: PB typed as a clock time; segment 2: plain seconds.
  await page.fill('#modalRoot table.grid tbody tr:nth-child(1) td:nth-child(3) input', '1:02.5');
  await page.fill('#modalRoot table.grid tbody tr:nth-child(1) td:nth-child(4) input', '58');
  await page.fill('#modalRoot table.grid tbody tr:nth-child(2) td:nth-child(3) input', '2:30');
  await page.click('#modalRoot table.grid tbody tr:nth-child(1) td:nth-child(2) input');   // blur the last field
  await page.waitForTimeout(200);
  const normalised = await page.evaluate(() =>
    document.querySelector('#modalRoot table.grid tbody tr:nth-child(1) td:nth-child(3) input').value);
  check('a typed clock time is normalised in place', normalised === '1:02.50', normalised);

  const saveBtn = page.locator('#modalRoot .modal-foot button', { hasText: 'Save & load' });
  await saveBtn.click();
  await page.waitForTimeout(900);
  const loaded = await page.evaluate(() => {
    const run = window.STUDIO.timer.exportRun();
    return { game: run.game, first: run.segments[0].pb, gold: run.segments[0].best, second: run.segments[1].pb };
  });
  check('the clock time is stored as seconds', Math.abs(loaded.first - 62.5) < 0.01, JSON.stringify(loaded));
  check('plain seconds still work', Math.abs(loaded.gold - 58) < 0.01, JSON.stringify(loaded));
  check('and so does mm:ss', Math.abs(loaded.second - 150) < 0.01, JSON.stringify(loaded));
  check('the splits are loaded into the timer', loaded.game === 'Test Game', JSON.stringify(loaded));

  // Theme switching touches the interface only.
  const themed = await page.evaluate(async () => {
    window.STUDIO.store.update((d) => { d.theme = 'light'; });
    document.documentElement.dataset.theme = 'light';
    await new Promise((r) => setTimeout(r, 200));
    const body = getComputedStyle(document.body).backgroundColor;
    const canvas = document.getElementById('programCanvas');
    const pixel = canvas.getContext('2d').getImageData(5, 5, 1, 1).data;
    window.STUDIO.store.update((d) => { d.theme = 'dark'; });
    document.documentElement.dataset.theme = 'dark';
    return { body, pixel: Array.from(pixel) };
  });
  check('the light theme repaints the interface', themed.body === 'rgb(238, 240, 244)', themed.body);
  check('the theme does not touch the composited output', themed.pixel[0] < 60, JSON.stringify(themed.pixel));

  // Every icon button announces itself.
  const unlabelled = await page.evaluate(() => Array.from(document.querySelectorAll('button.icon'))
    .filter((b) => !b.getAttribute('aria-label') && !b.textContent.trim().match(/[a-z]/i)).length);
  check('icon buttons have accessible names', unlabelled === 0, `${unlabelled} unlabelled`);

  // The overlay page follows the studio. Start a run first: a reloaded page
  // is idle, and an idle clock proves nothing about the publish path.
  await page.click('#btnSplit');
  await page.waitForTimeout(1200);
  const token = await page.evaluate(() => window.STUDIO_BOOT.overlayToken);
  // Same context as the studio: a BroadcastChannel does not cross Playwright's
  // isolated contexts, and neither would two separate browser profiles.
  const overlay = await context.newPage();
  await overlay.goto(`${BASE}/overlay/timer.html?token=${token}`);
  await overlay.waitForTimeout(3000);
  const overlayState = await overlay.evaluate(() => ({
    rows: document.querySelectorAll('#splits li').length,
    clock: document.getElementById('clock').textContent,
    offline: !document.getElementById('offline').hidden,
    source: document.body.dataset.source,
  }));
  check('the overlay renders the splits', overlayState.rows === 3, `rows=${overlayState.rows}`);
  check('the overlay clock follows the run', overlayState.clock !== '0.00' && overlayState.clock !== '0:00', overlayState.clock);
  check('the overlay is not stuck offline', !overlayState.offline);
  check('an overlay in the same browser is fed directly, not by polling',
    overlayState.source === 'channel', `updated via ${overlayState.source}`);

  // The overlay's display modes are what people actually put in OBS.
  const modes = await context.newPage();
  await modes.goto(`${BASE}/overlay/timer.html?token=${token}&mode=clock`);
  await modes.waitForTimeout(2000);
  const clockOnly = await modes.evaluate(() => ({
    clock: getComputedStyle(document.querySelector('.clock')).display,
    splits: getComputedStyle(document.querySelector('ol')).display,
    title: getComputedStyle(document.querySelector('.title')).display,
  }));
  check('clock mode shows only the clock',
    clockOnly.clock !== 'none' && clockOnly.splits === 'none' && clockOnly.title === 'none',
    JSON.stringify(clockOnly));

  await modes.goto(`${BASE}/overlay/timer.html?token=${token}&mode=splits`);
  await modes.waitForTimeout(1500);
  const splitsOnly = await modes.evaluate(() => ({
    clock: getComputedStyle(document.querySelector('.clock')).display,
    splits: getComputedStyle(document.querySelector('ol')).display,
  }));
  check('splits mode drops the clock',
    splitsOnly.clock === 'none' && splitsOnly.splits !== 'none', JSON.stringify(splitsOnly));

  await modes.goto(`${BASE}/overlay/timer.html?token=${token}&compact=1&scale=2`);
  await modes.waitForTimeout(1500);
  const compact = await modes.evaluate(() => ({
    title: getComputedStyle(document.querySelector('.title')).display,
    rootSize: getComputedStyle(document.documentElement).fontSize,
    background: getComputedStyle(document.body).backgroundColor,
  }));
  check('compact mode drops the title block', compact.title === 'none', JSON.stringify(compact));
  check('scale is applied', compact.rootSize === '30px', compact.rootSize);
  check('the overlay background stays transparent for OBS',
    compact.background === 'rgba(0, 0, 0, 0)', compact.background);

  // A token is what lets an overlay on another machine read the timer. In the
  // same browser the BroadcastChannel feeds it regardless, which is the point
  // of that path and is same-origin either way — so test the token from a
  // separate context, which is what someone else's OBS really is.
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(`${BASE}/overlay/timer.html`);
  await strangerPage.waitForTimeout(3000);
  let strangerRequests = 0;
  strangerPage.on('request', (r) => { if (r.url().includes('r=state')) strangerRequests++; });
  await strangerPage.reload();
  await strangerPage.waitForTimeout(3000);
  const noToken = await strangerPage.evaluate(() => ({
    offline: !document.getElementById('offline').hidden,
    game: document.getElementById('game').textContent,
    message: document.getElementById('offline').textContent,
  }));
  noToken.requests = strangerRequests;
  check('an overlay with no token gets nothing from another browser',
    noToken.offline && noToken.game === '—', JSON.stringify(noToken));
  check('and it says what is wrong with the link', /token/i.test(noToken.message), noToken.message);
  check('rather than retrying as fast as it can', noToken.requests < 15, `${noToken.requests} requests in 3s`);

  await strangerPage.goto(`${BASE}/overlay/timer.html?token=${token}`);
  await strangerPage.waitForTimeout(3000);
  const withToken = await strangerPage.evaluate(() => ({
    offline: !document.getElementById('offline').hidden,
    rows: document.querySelectorAll('#splits li').length,
    source: document.body.dataset.source,
  }));
  check('and the token makes it work from there', !withToken.offline && withToken.rows > 0, JSON.stringify(withToken));
  check('which is the polling path, not the channel', withToken.source === 'poll', JSON.stringify(withToken));
  await stranger.close();

  check('no console or page errors', errors.length === 0, errors.join('\n    '));
} catch (e) {
  failed++;
  problems.push('  FAIL harness\n    ' + e.message.split('\n')[0]);
}

await finish(browser);
