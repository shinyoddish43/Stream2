// The whole streaming path, end to end:
//
//   canvas → MediaRecorder → WebSocket → relay → ffmpeg stdin
//
// ffmpeg is a stub that copies stdin to a file, so this asserts on the real
// bytes the studio produced. Everything else is the real thing: the PHP that
// mints the ticket, the relay that verifies it, the browser that encodes.
//
// Skips itself without Playwright.

import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = Number(process.env.TEST_PORT || 8982);
const RELAY_PORT = Number(process.env.RELAY_TEST_PORT || 8983);
const BASE = `http://127.0.0.1:${APP_PORT}`;

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (e) {
  console.log('stream: skipped (playwright not installed)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'studio-stream-'));
let passed = 0;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; process.stdout.write('.'); }
  else { failed++; process.stdout.write('x'); problems.push(`  FAIL ${name}${detail ? '\n    ' + detail : ''}`); }
};

// --- app
for (const item of ['api', 'lib', 'assets', 'overlay', 'index.php', 'login.php', 'install.php']) {
  cpSync(join(ROOT, item), join(work, item), { recursive: true });
}
mkdirSync(join(work, 'data'), { recursive: true });
const php = spawn('php', ['-S', `127.0.0.1:${APP_PORT}`, '-t', work], { stdio: 'ignore' });

// --- stub ffmpeg
const outDir = join(work, 'ingest');
mkdirSync(outDir);
const stub = join(work, 'fake-ffmpeg.sh');
writeFileSync(stub, `#!/usr/bin/env bash
target="\${@: -1}"
name=$(printf '%s' "$target" | tr -c 'a-zA-Z0-9' '_')
cat > "${outDir}/\${name}.bin"
`);
chmodSync(stub, 0o755);

let browser;
let relay;
const finish = async () => {
  if (browser) await browser.close().catch(() => {});
  if (relay) relay.kill();
  php.kill();
  await sleep(200);
  rmSync(work, { recursive: true, force: true });
  process.stdout.write('\n');
  for (const problem of problems) console.log(problem);
  console.log(`stream: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/api/index.php?r=health`); break; } catch (e) { await sleep(250); }
  }

  // --- install, log in, configure a relay destination through the real API
  await fetch(`${BASE}/install.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=tester&password=hunter2hunter2&password2=hunter2hunter2&site_name=Stream+Test',
  });
  const config = JSON.parse(readFileSync(join(work, 'data', 'config.json'), 'utf8'));

  relay = spawn('node', [join(ROOT, 'relay', 'server.js')], {
    env: { ...process.env, RELAY_SECRET: config.relay_secret, PORT: String(RELAY_PORT), FFMPEG_PATH: stub, MAX_SESSIONS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayLog = '';
  relay.stdout.on('data', (d) => { relayLog += d; });
  relay.stderr.on('data', (d) => { relayLog += d; });
  await sleep(1000);
  check('the relay is up', (await (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).json()).ok, relayLog.slice(0, 200));

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH === '' ? undefined : (process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The test kills the relay on purpose; the browser logs every refused
    // WebSocket itself and no page code can suppress that.
    if (/WebSocket connection to .* failed/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });

  await page.goto(`${BASE}/login.php`);
  await page.fill('input[name=username]', 'tester');
  await page.fill('input[name=password]', 'hunter2hunter2');
  await page.click('button[type=submit]');
  await page.waitForURL('**/index.php');
  await page.waitForTimeout(2000);

  // Point the studio at the relay and at one destination, through its own API.
  const setup = await page.evaluate(async (relayUrl) => {
    const csrf = window.STUDIO.boot.csrf;
    const post = (route, body) => fetch('api/index.php?r=' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post('settings', { relay_url: relayUrl });
    await post('destinations', { destinations: [{
      name: 'Local', service: 'custom', url: 'rtmp://127.0.0.1/live', key: 'testkey', enabled: true,
    }] });
    window.STUDIO.boot.relayUrl = relayUrl;
    window.STUDIO.store.update((d) => {
      d.output.mode = 'relay';
      d.output.bitrate = 800;      // keep the stub's output small
      d.canvas.fps = 15;
    });
    return true;
  }, `ws://127.0.0.1:${RELAY_PORT}/ingest`);
  check('the studio was configured for the relay', setup === true);

  // A moving source, so the encoder has something to compress.
  await page.evaluate(() => {
    const scene = window.STUDIO.store.editScene();
    window.STUDIO.store.update(() => {
      scene.sources.push({
        id: 'sr_clock', type: 'text', name: 'Clock', visible: true, locked: false,
        x: 80, y: 300, w: 900, h: 120, opacity: 1,
        settings: { text: '{clock} {timer}', size: 72, color: '#ffffff', outline: 3, outlineColor: '#000000', align: 'left' },
      });
    });
  });

  await page.click('#btnStream');
  await page.waitForTimeout(6000);

  const live = await page.evaluate(() => ({
    pill: document.getElementById('statLive').textContent,
    streaming: window.STUDIO.output.streaming,
    bitrate: Number(document.getElementById('statBitrate').textContent),
    fps: document.getElementById('statFps').textContent,
  }));
  check('the studio reports it is live', live.pill === 'LIVE' && live.streaming, JSON.stringify(live));
  check('the status bar shows a bitrate', live.bitrate > 0, JSON.stringify(live));
  check('the compositor keeps producing frames while live', Number(live.fps) >= 10, `fps=${live.fps}`);

  const relayHealth = await (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).json();
  check('the relay has a live session', relayHealth.sessions === 1, JSON.stringify(relayHealth));

  const files = readdirSync(outDir);
  check('the relay opened an encoder for the destination', files.length === 1, JSON.stringify(files));
  if (files.length) {
    const data = readFileSync(join(outDir, files[0]));
    check('real encoded video reached ffmpeg', data.length > 20000, `${data.length} bytes`);
    check('it is a WebM stream', data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), data.subarray(0, 8).toString('hex'));
    check('the stream key was applied to the RTMP URL', files[0].includes('testkey'), files[0]);
  }

  // Regression: one recorder handle used to serve both the file recording and
  // the relay, so hitting record mid-stream tore the stream's encoder out.
  const sizeBefore = readFileSync(join(outDir, readdirSync(outDir)[0])).length;
  await page.click('#btnRecord');
  await page.waitForTimeout(3000);
  const both = await page.evaluate(() => ({
    recording: window.STUDIO.output.recording,
    streaming: window.STUDIO.output.streaming,
    separateRecorders: window.STUDIO.output.fileRecorder !== window.STUDIO.output.relayRecorder
      && !!window.STUDIO.output.fileRecorder && !!window.STUDIO.output.relayRecorder,
  }));
  check('recording and streaming run together', both.recording && both.streaming, JSON.stringify(both));
  check('each output has its own encoder', both.separateRecorders, JSON.stringify(both));
  const sizeDuring = readFileSync(join(outDir, readdirSync(outDir)[0])).length;
  check('the relay keeps receiving while recording', sizeDuring > sizeBefore, `${sizeBefore} → ${sizeDuring}`);

  await page.click('#btnRecord');
  await page.waitForTimeout(1500);
  const afterRecord = await page.evaluate(() => ({
    recording: window.STUDIO.output.recording,
    streaming: window.STUDIO.output.streaming,
  }));
  check('stopping the recording leaves the stream up', !afterRecord.recording && afterRecord.streaming, JSON.stringify(afterRecord));
  const sizeAfter = readFileSync(join(outDir, readdirSync(outDir)[0])).length;
  check('and the relay is still being fed', sizeAfter > sizeDuring, `${sizeDuring} → ${sizeAfter}`);

  // --- the relay dies mid-broadcast: the studio must rebuild the session,
  // not silently drop the streamer off air.
  relay.kill();
  await sleep(1200);
  const dropped = await page.evaluate(() => ({
    pill: document.getElementById('statLive').textContent,
    streaming: window.STUDIO.output.streaming,
    reconnecting: window.STUDIO.output.reconnecting,
  }));
  check('a dropped relay puts the studio into reconnect, not offline',
    dropped.streaming && dropped.reconnecting && dropped.pill === 'RECONNECTING', JSON.stringify(dropped));

  relay = spawn('node', [join(ROOT, 'relay', 'server.js')], {
    env: { ...process.env, RELAY_SECRET: config.relay_secret, PORT: String(RELAY_PORT), FFMPEG_PATH: stub, MAX_SESSIONS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(9000);   // the backoff is 1s, 2s, 4s…
  const recovered = await page.evaluate(() => ({
    pill: document.getElementById('statLive').textContent,
    streaming: window.STUDIO.output.streaming,
    reconnecting: window.STUDIO.output.reconnecting,
  }));
  check('the studio gets itself back on air', recovered.streaming && !recovered.reconnecting && recovered.pill === 'LIVE',
    JSON.stringify(recovered));
  const relayBack = await (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).json();
  check('the relay has the rebuilt session', relayBack.sessions === 1, JSON.stringify(relayBack));
  const secondFiles = readdirSync(outDir);
  check('a fresh encoder received the resumed stream',
    secondFiles.length >= 1 && readFileSync(join(outDir, secondFiles[0])).length > 20000,
    JSON.stringify(secondFiles));

  await page.click('#btnStream');
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    pill: document.getElementById('statLive').textContent,
    streaming: window.STUDIO.output.streaming,
  }));
  check('stopping takes it off air', after.pill === 'OFFLINE' && !after.streaming, JSON.stringify(after));
  const relayAfter = await (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).json();
  check('the relay releases the session', relayAfter.sessions === 0, JSON.stringify(relayAfter));

  check('no console or page errors', errors.length === 0, errors.join('\n    '));
} catch (e) {
  failed++;
  problems.push('  FAIL harness\n    ' + String(e.message).split('\n')[0]);
}

await finish();
