// The WHIP output path against a stub ingest endpoint.
//
// A real WHIP server would have to answer with a working WebRTC answer, which
// is a whole media stack; what matters here is what the studio sends, and that
// it fails loudly rather than pretending to be live when the endpoint refuses.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = Number(process.env.TEST_PORT || 8984);
const WHIP_PORT = Number(process.env.WHIP_TEST_PORT || 8985);
const BASE = `http://127.0.0.1:${APP_PORT}`;

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (e) {
  console.log('whip: skipped (playwright not installed)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'studio-whip-'));
let passed = 0;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; process.stdout.write('.'); }
  else { failed++; process.stdout.write('x'); problems.push(`  FAIL ${name}${detail ? '\n    ' + detail : ''}`); }
};

for (const item of ['api', 'lib', 'assets', 'overlay', 'index.php', 'login.php', 'install.php']) {
  cpSync(join(ROOT, item), join(work, item), { recursive: true });
}
mkdirSync(join(work, 'data'), { recursive: true });
const php = spawn('php', ['-S', `127.0.0.1:${APP_PORT}`, '-t', work], { stdio: 'ignore' });

// Stub WHIP endpoint: records what arrives, answers however the test wants.
const received = [];
let mode = 'reject';
const whip = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'] || '',
      authorization: req.headers.authorization || '',
      body,
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Location');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (mode === 'reject') { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('no'); return; }
    // A syntactically plausible answer the browser will still refuse: proves
    // the failure surfaces instead of the studio claiming to be live.
    res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/session/1' });
    res.end('v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n');
  });
});
await new Promise((resolve) => whip.listen(WHIP_PORT, '127.0.0.1', resolve));

let browser;
try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/api/index.php?r=health`); break; } catch (e) { await sleep(250); }
  }
  await fetch(`${BASE}/install.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=tester&password=hunter2hunter2&password2=hunter2hunter2&site_name=WHIP+Test',
  });

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH === '' ? undefined : (process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/login.php`);
  await page.fill('input[name=username]', 'tester');
  await page.fill('input[name=password]', 'hunter2hunter2');
  await page.click('button[type=submit]');
  await page.waitForURL('**/index.php');
  await page.waitForTimeout(2000);

  await page.evaluate((url) => {
    window.STUDIO.store.update((d) => {
      d.output.mode = 'whip';
      d.output.whipUrl = url;
      d.output.whipToken = 'test-token';
      d.canvas.fps = 15;
    });
  }, `http://127.0.0.1:${WHIP_PORT}/whip`);

  // --- endpoint refuses
  await page.click('#btnStream');
  await page.waitForTimeout(5000);
  const refused = await page.evaluate(() => ({
    streaming: window.STUDIO.output.streaming,
    pill: document.getElementById('statLive').textContent,
    toast: Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' | '),
  }));
  check('a refused endpoint does not leave the studio claiming to be live',
    !refused.streaming && refused.pill === 'OFFLINE', JSON.stringify(refused));
  check('and it says why', /401|could not go live/i.test(refused.toast), refused.toast);

  const offer = received.find((r) => r.method === 'POST');
  check('the offer is POSTed', !!offer, JSON.stringify(received.map((r) => r.method)));
  if (offer) {
    check('with the SDP content type', offer.contentType === 'application/sdp', offer.contentType);
    check('with the bearer token', offer.authorization === 'Bearer test-token', offer.authorization);
    check('and a real SDP offer as the body', offer.body.startsWith('v=0'), offer.body.slice(0, 40));
    check('the offer carries video', /m=video/.test(offer.body), offer.body.slice(0, 200));
    check('the offer carries audio', /m=audio/.test(offer.body), offer.body.slice(0, 200));
    check('ICE candidates are gathered before sending', /a=candidate/.test(offer.body),
      'no candidates in the offer');
  }

  // --- endpoint accepts but answers with something unusable
  mode = 'accept';
  received.length = 0;
  await page.click('#btnStream');
  await page.waitForTimeout(5000);
  const bad = await page.evaluate(() => ({
    streaming: window.STUDIO.output.streaming,
    pill: document.getElementById('statLive').textContent,
  }));
  check('an unusable answer is treated as a failure, not a live stream',
    !bad.streaming && bad.pill === 'OFFLINE', JSON.stringify(bad));
  check('the endpoint was called again', received.some((r) => r.method === 'POST'));
} catch (e) {
  failed++;
  problems.push('  FAIL harness\n    ' + String(e.message).split('\n')[0]);
}

if (browser) await browser.close().catch(() => {});
whip.close();
php.kill();
await sleep(200);
rmSync(work, { recursive: true, force: true });
process.stdout.write('\n');
for (const problem of problems) console.log(problem);
console.log(`whip: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
