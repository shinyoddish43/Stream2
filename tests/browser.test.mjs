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
  const page = await browser.newPage({ viewport: { width: 1500, height: 860 } });
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
  check('a scene can be added', studio.scenes === 2, `scenes=${studio.scenes}`);
  check('studio mode shows the preview', studio.preview);
  check('a scene is on air', studio.live);

  // The layout survives a reload (it is saved server-side).
  await page.reload();
  await page.waitForTimeout(2500);
  const reloaded = await page.evaluate(() => document.querySelectorAll('#sceneList .row-item').length);
  check('the layout persists across a reload', reloaded === 2, `scenes=${reloaded}`);

  // The overlay page follows the studio. Start a run first: a reloaded page
  // is idle, and an idle clock proves nothing about the publish path.
  await page.click('#btnSplit');
  await page.waitForTimeout(1200);
  const token = await page.evaluate(() => window.STUDIO_BOOT.overlayToken);
  const overlay = await browser.newPage();
  await overlay.goto(`${BASE}/overlay/timer.html?token=${token}`);
  await overlay.waitForTimeout(3000);
  const overlayState = await overlay.evaluate(() => ({
    rows: document.querySelectorAll('#splits li').length,
    clock: document.getElementById('clock').textContent,
    offline: !document.getElementById('offline').hidden,
  }));
  check('the overlay renders the splits', overlayState.rows === 3, `rows=${overlayState.rows}`);
  check('the overlay clock follows the run', overlayState.clock !== '0.00' && overlayState.clock !== '0:00', overlayState.clock);
  check('the overlay is not stuck offline', !overlayState.offline);

  check('no console or page errors', errors.length === 0, errors.join('\n    '));
} catch (e) {
  failed++;
  problems.push('  FAIL harness\n    ' + e.message.split('\n')[0]);
}

await finish(browser);
