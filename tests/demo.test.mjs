// The static demo build: no PHP, no account, everything in the browser.
//
// It is built from the real index.php rather than kept as a second copy, so
// this suite is what stops it drifting from the application.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-demo');
const PORT = Number(process.env.DEMO_TEST_PORT || 8998);
const BASE = `http://127.0.0.1:${PORT}`;

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (e) {
  console.log('demo: skipped (playwright not installed)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; process.stdout.write('.'); }
  else { failed++; process.stdout.write('x'); problems.push(`  FAIL ${name}${detail ? '\n    ' + detail : ''}`); }
};

// Build it the way a release would.
const build = spawn('bash', [join(ROOT, 'deploy', 'build-demo.sh'), OUT], { stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', (d) => { buildLog += d; });
build.stderr.on('data', (d) => { buildLog += d; });
const buildCode = await new Promise((resolve) => build.on('exit', resolve));
check('the demo builds', buildCode === 0, buildLog.slice(-400));
check('it has an index.html', existsSync(join(OUT, 'index.html')));
check('it carries the overlay page', existsSync(join(OUT, 'overlay', 'timer.html')));
check('it ships no PHP', !existsSync(join(OUT, 'api')) && !existsSync(join(OUT, 'index.php')));

let browser;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', OUT], { stdio: 'ignore' });
try {
  await sleep(1200);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH === '' ? undefined : (process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE + '/');
  await page.waitForTimeout(2500);

  const boot = await page.evaluate(() => ({
    scenes: document.querySelectorAll('#sceneList .row-item').length,
    sources: document.querySelectorAll('#sourceList .row-item').length,
    splits: document.querySelectorAll('#lsSplits li').length,
    note: !!document.querySelector('.demo-note'),
    signOut: !!document.getElementById('logoutLink'),
    painted: document.getElementById('programCanvas').getContext('2d').getImageData(900, 600, 1, 1).data[2] > 0,
  }));
  check('the studio boots with no server behind it', boot.scenes === 1 && boot.sources === 2, JSON.stringify(boot));
  check('the compositor paints', boot.painted);
  check('the timer dock is populated', boot.splits === 3, `splits=${boot.splits}`);
  check('it says it is a demo', boot.note);
  check('there is no sign-out, since there is no account', !boot.signOut);

  // The timer and the compositor are the real ones.
  await page.click('#btnSplit');
  await page.waitForTimeout(1800);
  const running = await page.evaluate(() => ({
    clock: document.getElementById('lsClock').textContent,
    fps: document.getElementById('statFps').textContent,
  }));
  check('the timer runs', parseFloat(running.clock.replace(':', '')) > 0, running.clock);
  check('the compositor keeps up', Number(running.fps) >= 20, `fps=${running.fps}`);

  // Scenes, and whether the browser remembers them.
  await page.click('[data-action="scene-starter"]');
  await page.waitForTimeout(300);
  await page.click('#modalRoot .modal-foot .btn.primary');
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForTimeout(2200);
  const remembered = await page.evaluate(() => document.querySelectorAll('#sceneList .row-item').length);
  check('scenes survive a reload without a server', remembered === 5, `scenes=${remembered}`);

  // Every dialog still opens.
  for (const action of ['open-settings', 'open-splits', 'open-destinations', 'open-overlays',
                        'open-hotkeys', 'open-help', 'timer-history']) {
    let ok = true;
    try {
      await page.click(`[data-action="${action}"]`);
      await page.waitForTimeout(350);
      ok = await page.evaluate(() => !document.getElementById('modalRoot').hidden);
      await page.click('#modalRoot .modal-head .icon');
      await page.waitForTimeout(200);
    } catch (e) { ok = false; }
    check(`dialog ${action} works in the demo`, ok);
  }

  // What needs a server must say so rather than failing strangely.
  const refusal = await page.evaluate(async () => {
    const { api } = await import('./assets/js/core/api.js');
    try { await api.relayTicket({}); return 'no error'; } catch (e) { return e.message; }
  });
  check('streaming explains that it needs the real install', /real install/.test(refusal), refusal);

  check('no console or page errors', errors.length === 0, errors.join('\n    '));
} catch (e) {
  failed++;
  problems.push('  FAIL harness\n    ' + String(e.message).split('\n')[0]);
}

if (browser) await browser.close().catch(() => {});
server.kill();
if (!process.env.KEEP_DEMO) rmSync(OUT, { recursive: true, force: true });
process.stdout.write('\n');
for (const problem of problems) console.log(problem);
console.log(`demo: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
