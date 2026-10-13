import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login } from './helpers.mjs';
let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch { /* optional browser suite */ }
const skip = !chromium && 'playwright is not installed';
let server, browser, page;
const errors = [];
function wav(seconds = 8) {
  const length = 44100 * seconds, data = Buffer.alloc(44 + length * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(44100, 24); data.writeUInt32LE(88200, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 44100) * 10000), 44 + i * 2);
  return data;
}
before(async () => {
  if (skip) return;
  server = await startServer();
  const api = await login(server.url);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH === '' ? undefined : (process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'), args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await context.addCookies([{ name: 'ss', value: api.cookie.slice(3), url: server.url }]);
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept('1'));
  await page.goto(server.url);
  await page.waitForFunction(() => !!window.studio?.doc);
});
after(async () => { await browser?.close(); server?.stop(); });

test('uploaded media plays into the stream and speaker monitor with independent levels', { skip }, async () => {
  await page.setInputFiles('#mediaUploadInput', [{ name: 'Background.wav', mimeType: 'audio/wav', buffer: wav(30) }, { name: 'Second.wav', mimeType: 'audio/wav', buffer: wav(30) }]);
  await page.waitForFunction(() => window.studio.doc.media.items.length === 2);
  await page.click('#mediaPlay');
  await page.waitForFunction(() => !window.studio.media.audio.paused && window.studio.media.audio.currentTime > 0.3);
  const signals = await page.evaluate(async () => {
    const { mixer } = window.studio;
    const measure = (stream) => { const node = mixer.ctx.createMediaStreamSource(stream), analyser = mixer.ctx.createAnalyser(); node.connect(analyser); return { node, analyser }; };
    const stream = measure(mixer.out.stream), speakers = measure(mixer.monitor.audio.srcObject);
    const peak = (a) => { const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); return Math.max(...b.map(Math.abs)); };
    await new Promise((r) => setTimeout(r, 400));
    const both = [peak(stream.analyser), peak(speakers.analyser)];
    mixer.set('media', { muted: true });
    await new Promise((r) => setTimeout(r, 300));
    const muted = [peak(stream.analyser), peak(speakers.analyser)];
    mixer.set('media', { muted: false, monitorGain: 0 });
    await new Promise((r) => setTimeout(r, 450));
    const noSpeakers = [peak(stream.analyser), peak(speakers.analyser)];
    mixer.set('media', { monitorGain: 0.7 });
    stream.node.disconnect(); speakers.node.disconnect();
    return { both, muted, noSpeakers, inputs: mixer.strips.size };
  });
  assert.ok(signals.both.every((p) => p > 0.03), JSON.stringify(signals));
  assert.ok(signals.muted[0] < 0.001 && signals.muted[1] > 0.03, JSON.stringify(signals));
  assert.ok(signals.noSpeakers[0] > 0.03 && signals.noSpeakers[1] < 0.001, JSON.stringify(signals));
  assert.equal(signals.inputs, 1, 'playback uses exactly one mixer channel');
  await page.click('#mediaPlay');
});

test('microphone echo cancellation, raw capture, and speaker mute protection are selectable', { skip }, async () => {
  await page.click('#addAudio');
  await page.waitForFunction(() => window.studio.doc.audio.length === 1);
  const mode = page.getByRole('combobox', { name: /microphone protection/ });
  assert.equal(await page.evaluate(() => window.studio.mixer.strips.get(window.studio.doc.audio[0].id).track.getSettings().echoCancellation), true);
  await mode.selectOption('raw');
  await page.waitForFunction(() => window.studio.doc.audio[0].mode === 'raw');
  assert.equal(await page.evaluate(() => window.studio.mixer.strips.get(window.studio.doc.audio[0].id).track.getSettings().echoCancellation), false);
  await mode.selectOption('guard');
  await page.waitForFunction(() => window.studio.doc.audio[0].mode === 'guard');
  await page.click('#mediaPlay');
  await page.waitForFunction(() => window.studio.mixer.strips.get(window.studio.doc.audio[0].id).blocked);
  await page.waitForTimeout(120);
  assert.ok(await page.evaluate(() => window.studio.mixer.strips.get(window.studio.doc.audio[0].id).gainNode.gain.value < 0.001));
  await page.click('#mediaSpeakers');
  await page.waitForFunction(() => !window.studio.mixer.strips.get(window.studio.doc.audio[0].id).blocked);
  assert.equal(await page.evaluate(() => window.studio.media.audio.paused), false, 'turning speakers off does not stop the stream audio');
  await page.click('#mediaSpeakers');
  await page.waitForFunction(() => window.studio.mixer.strips.get(window.studio.doc.audio[0].id).blocked);
  // A manual mute survives the temporary protection gate.
  await page.evaluate(() => window.studio.mixer.set(window.studio.doc.audio[0].id, { muted: true }));
  await page.click('#mediaPlay');
  await page.waitForFunction(() => !window.studio.mixer.strips.get(window.studio.doc.audio[0].id).blocked);
  assert.equal(await page.evaluate(() => window.studio.mixer.strips.get(window.studio.doc.audio[0].id).muted), true);
});

test('seek, chapter advance, repeat, reload, and saved media work without autoplay', { skip }, async () => {
  await page.evaluate(() => window.studio.media.seek(12));
  assert.ok(await page.evaluate(() => window.studio.media.audio.currentTime >= 12));
  await page.click('#mediaNext');
  assert.match(await page.textContent('#mediaTitle'), /Second/);
  await page.check('#mediaRepeat');
  await page.evaluate(() => { window.studio.media.audio.currentTime = 29.8; });
  await page.click('#mediaPlay');
  await page.waitForFunction(() => window.studio.doc.media.currentId === window.studio.doc.media.items[0].id && !window.studio.media.audio.paused);
  await page.click('#mediaPlay');
  await page.evaluate(() => { window.studio.media.seek(10); return window.studio.flush(); });
  await page.reload();
  await page.waitForFunction(() => window.studio?.media.audio.readyState >= 1);
  assert.equal(await page.evaluate(() => window.studio.media.audio.paused), true);
  assert.equal(await page.locator('#mediaQueue option').count(), 2);
  assert.ok(await page.evaluate(() => window.studio.media.audio.currentTime >= 10));
  assert.equal(await page.isChecked('#mediaRepeat'), true);
});

test('audiobook search loads ordered chapters into the player and handles failures', { skip }, async () => {
  const urls = await page.evaluate(() => window.studio.doc.media.items.map((t) => t.url));
  await page.route('**/api/audiobooks?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') === 'offline') return route.fulfill({ status: 502, json: { error: 'Library unavailable' } });
    return route.fulfill({ json: { total: 1, page: 1, books: [{ id: 'alice', title: 'Alice <b>Wonderland</b>', author: 'Lewis Carroll', language: 'English' }] } });
  });
  await page.route('**/api/audiobooks/alice', (route) => route.fulfill({ json: { id: 'alice', title: 'Alice in Wonderland', tracks: urls.map((url, i) => ({ id: `alice:${i}`, title: `Chapter ${i + 1}`, url })) } }));
  await page.click('#mediaLibrary');
  await page.getByRole('button', { name: 'Add book', exact: true }).waitFor();
  assert.equal(await page.locator('#audiobookResults b').count(), 0, 'catalog metadata is rendered as text');
  await page.getByRole('button', { name: 'Add book', exact: true }).click();
  await page.waitForFunction(() => window.studio.doc.media.currentId === 'alice:0');
  assert.equal(await page.locator('#mediaQueue option').count(), 4);
  assert.match(await page.textContent('#mediaTitle'), /Alice in Wonderland/);
  await page.click('#mediaPlay');
  await page.waitForFunction(() => !window.studio.media.audio.paused);
  await page.click('#mediaPlay');
  await page.click('#mediaLibrary');
  await page.fill('#audiobookQuery', 'offline');
  await page.locator('#audiobookSearch button').click();
  await page.waitForFunction(() => document.getElementById('audiobookStatus').textContent.includes('Library unavailable'));
  await page.click('#audiobookClose');
});

test('player and audiobook dialog fit desktop and mobile and have no uncaught errors', { skip }, async () => {
  for (const [name, width, height] of [['desktop', 1500, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `/tmp/studio-media-${name}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.click('#mediaLibrary');
    const bounds = await page.locator('#audiobookDialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.click('#audiobookClose');
  }
  assert.deepEqual(errors, []);
});
