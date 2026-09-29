// The studio in a real browser: sign in, add a capture device, key a green
// screen onto an uploaded background, run the timer, move splits in and out,
// keep layouts across a reload and between two browsers, and go live.
// Skipped without Playwright.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, USER, PASSWORD } from './helpers.mjs';

let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch { /* skipped below */ }
const skip = !chromium && 'playwright is not installed';

let server, browser, context, page;
const errors = [];

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH === '' ? undefined : (process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  // A synthetic "camera": solid green with a red square, standing in for a
  // person in front of a green screen. Switched on per test.
  await context.addInitScript(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (!window.fakeGreenScreen || !c.video) return real(c);
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const g = canvas.getContext('2d');
      const paint = () => {
        g.fillStyle = '#10c030'; g.fillRect(0, 0, 640, 360);       // lit screen
        g.fillStyle = '#1a7a36'; g.fillRect(560, 0, 80, 360);      // screen in shadow
        g.fillStyle = '#ff0000'; g.fillRect(220, 90, 200, 180);    // the subject...
        g.fillStyle = '#e8b896'; g.fillRect(60, 200, 40, 40);      // light skin
        g.fillStyle = '#8d5524'; g.fillRect(110, 200, 40, 40);     // dark skin
        g.fillStyle = '#2a3550'; g.fillRect(160, 200, 40, 40);     // navy shirt
        g.fillStyle = '#808080'; g.fillRect(60, 250, 40, 40);      // grey shirt
        g.fillStyle = '#1a1a1a'; g.fillRect(110, 250, 40, 40);     // black hair
      };
      paint();
      setInterval(paint, 50);
      return canvas.captureStream(20);
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', answer);
});

// prompt() and confirm() are accepted: with the next queued answer, or as offered.
const answers = [];
const answer = (d) => d.accept(answers.length ? answers.shift() : d.defaultValue() || undefined);

after(async () => { if (browser) await browser.close(); if (server) server.stop(); });

// Open the layout menu and pick an entry: a layout by position, or an action.
async function layoutMenu(p, pick) {
  await p.click('#layoutButton');
  await p.click(typeof pick === 'number' ? `.menu [role=menuitemradio] >> nth=${pick}` : `.menu [data-action=${pick}]`);
  await p.waitForTimeout(200);
}
const layoutNames = async (p) => {
  await p.click('#layoutButton');
  const names = await p.$$eval('.menu [role=menuitemradio]', (items) => items.map((i) => i.textContent));
  await p.keyboard.press('Escape');
  return names;
};
// Wait until fn(arg) is true in the page. Not page.waitForFunction: some
// Playwright versions run that through eval, which the studio's CSP refuses.
async function until(p, fn, arg, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await p.evaluate(fn, arg))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// A device button either adds the only device or offers a menu of them.
async function addDevice(p, button) {
  await p.click(button);
  await p.waitForTimeout(400);
  if (await p.$('.menu')) await p.click('.menu button >> nth=0');
}

const pixel = (x, y) => page.evaluate(([x, y]) => Array.from(document.getElementById('program').getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3), [x, y]);

test('sign in', { skip }, async () => {
  await page.goto(`${server.url}/`);
  assert.match(page.url(), /\/login$/);
  await page.fill('input[name=user]', USER);
  await page.fill('input[name=password]', 'wrong-password');
  await page.click('button');
  await page.waitForSelector('#loginError:not(:empty)');
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button');
  await page.waitForURL(`${server.url}/`);
  await page.waitForTimeout(1200);
  // The wrong password above is a deliberate 401, which Chrome logs. Count
  // errors from the studio itself, not from that.
  errors.length = 0;
});

test('the default layout draws the timer', { skip }, async () => {
  const sources = await page.$$eval('#sourceList li', (lis) => lis.map((li) => li.textContent));
  assert.equal(sources.length, 1);
  const [r, g, b] = await pixel(1100, 300);          // inside the timer panel
  assert.ok(r + g + b > 0 && r + g + b < 120, `timer background ${r},${g},${b}`);
});

test('one column on the right holds everything: no settings, no header, no bottom bar', { skip }, async () => {
  for (const gone of ['#props', '#layoutSelect', '#settingsButton', '#settingsDialog', 'header', 'footer', '.docks']) {
    assert.equal(await page.$(gone), null, `${gone} should be gone`);
  }
  assert.equal(await page.textContent('#layoutName'), 'Main');
  assert.equal(await page.$eval('#greenOn', (i) => i.disabled), true, 'no camera yet, nothing to key');
  const box = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const side = r('.side');
    const start = r('#streamButton');
    const menu = r('#layoutButton');
    const stage = r('.stage');
    const inSide = ['#timerSplit', '#hotkeysButton', '#sourceList', '#greenOn', '#mixer'].every((sel) => document.querySelector('.side').contains(document.querySelector(sel)));
    return {
      w: innerWidth, h: innerHeight, scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      startRight: start.right, startTop: start.top, menuGap: start.left - menu.right, menuTop: menu.top,
      sideBottom: side.bottom, sideLeft: side.left, stageRight: stage.right, ratio: stage.width / stage.height, inSide,
    };
  });
  assert.deepEqual(box.scroll, [box.w, box.h], 'the page does not scroll');
  assert.ok(box.w - box.startRight <= 8 && box.startTop <= 8, `Start streaming is in the top right corner: ${JSON.stringify(box)}`);
  assert.ok(box.menuGap >= 0 && box.menuGap <= 8 && Math.abs(box.menuTop - box.startTop) < 2, 'the layout menu is just left of it');
  assert.ok(box.inSide, 'timer, sources, green screen and audio are all in the column');
  assert.ok(box.h - box.sideBottom <= 8, 'the column runs to the bottom of the window');
  assert.ok(box.stageRight <= box.sideLeft, 'the preview is left of the column');
  assert.ok(Math.abs(box.ratio - 16 / 9) < 0.01, 'the preview is 16:9');
});

// Chromium's fake microphone beeps with silence between; wait for a beep.
// Each reading covers the analyser's last ~43 ms, so read every 20 ms: at
// 100 ms a short beep could fall between readings, again and again.
const meterMoves = (p) => p.evaluate(async () => {
  await window.studio.mixer.resume();
  for (let i = 0; i < 300; i++) {
    if (Object.values(window.studio.mixer.levels()).some((v) => v > 0.001)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
});

test('a new studio starts with this computer\'s default microphone, and its meter moves even when muted', { skip }, async () => {
  const names = await page.$$eval('#mixer .strip .name', (n) => n.map((x) => x.textContent));
  assert.match(names[0], /^Default mic · /, names.join());
  assert.equal(await page.evaluate(() => window.studio.doc.audio[0].deviceId), 'default');
  await page.click('#mixer .strip button:has-text("Mute")');
  assert.ok(await page.$('#mixer .strip.is-muted'));
  assert.ok(await meterMoves(page), 'a muted input still shows its level');
  await page.click('#mixer .strip button:has-text("Muted")');
  assert.equal(await page.$('#mixer .strip.is-muted'), null);
});

test('the mixer says when sound waits for the page to be used, and a key press starts it', { skip }, async () => {
  await page.evaluate(() => window.studio.mixer.ctx.suspend());
  await page.waitForSelector('#audioPaused:not([hidden])');
  await page.keyboard.press('Shift');
  await until(page, () => window.studio.mixer.ctx.state === 'running');
  await page.waitForSelector('#audioPaused', { state: 'hidden' });
});

test('a capture device can be added and shows up on the canvas', { skip }, async () => {
  await addDevice(page, '#addCamera');
  await page.waitForTimeout(2000);
  const count = await page.$$eval('#sourceList li', (lis) => lis.length);
  assert.equal(count, 2);
  const live = await page.evaluate(() => [...window.studio.compositor.feeds.values()].some((f) => f.ready));
  assert.ok(live, 'the fake camera did not start');
  assert.equal(await page.$eval('#greenOn', (i) => i.disabled), false, 'the green screen menu works on the new camera');
  const cam = await page.evaluate(() => window.studio.doc.layouts[0].sources.find((s) => s.type === 'camera'));
  assert.ok(cam.name.length > 0);
  assert.equal(cam.resolution, undefined, 'cameras open at fixed defaults');
});

test('green screen: the green becomes the uploaded background, the subject stays', { skip }, async () => {
  // Replace the camera with the synthetic green-screen feed.
  await page.evaluate(() => { window.fakeGreenScreen = true; });
  await page.evaluate(() => {
    const { compositor } = window.studio;
    for (const f of compositor.feeds.values()) f.stop();
  });
  await page.evaluate(async () => {
    const { compositor, doc } = window.studio;
    const cam = doc.layouts[0].sources.find((s) => s.type === 'camera');
    Object.assign(cam, { x: 0, y: 0, w: 640, h: 360 });
    const feed = compositor.feed(cam);
    feed.status = 'idle';
  });
  // Re-open through the app's own path: a stopped device offers Retry.
  await page.evaluate(() => { for (const f of window.studio.compositor.feeds.values()) f.status = 'ended'; });
  await page.click('#sourceList li[data-type=camera] .name');
  await page.click('#sourceList li[data-type=camera] button:has-text("Retry")');
  await page.waitForTimeout(1500);
  assert.deepEqual(await pixel(50, 50), [16, 192, 48], 'before keying the green is on screen');

  await page.check('#greenOn');
  // A solid blue picture as the background.
  const bg = join(server.data, 'blue.png');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d'); g.fillStyle = '#0000ff'; g.fillRect(0, 0, 64, 36); return c.toDataURL('image/png').split(',')[1]; });
  writeFileSync(bg, Buffer.from(png, 'base64'));
  const chooser = page.waitForEvent('filechooser');
  await page.click('#greenUpload');
  await (await chooser).setFiles(bg);
  await page.waitForTimeout(1500);
  assert.equal(await page.textContent('#greenUpload'), 'Change background');

  const [r1, g1, b1] = await pixel(50, 50);
  assert.ok(b1 > 200 && g1 < 60 && r1 < 60, `the green should now be blue, got ${r1},${g1},${b1}`);
  const [r2, g2, b2] = await pixel(320, 180);
  assert.ok(r2 > 200 && g2 < 60 && b2 < 60, `the subject should stay red, got ${r2},${g2},${b2}`);

  // A real screen is never pure green: the colour selector (its eyedropper,
  // in the browser's own picker) sets the green actually on camera.
  await page.fill('#greenColor', '#10c030');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.studio.doc.layouts[0].sources.find((s) => s.type === 'camera').chroma.color), '#10c030');

  // With that colour and the fixed keying strength, people must survive.
  const close = ([a, b, c], hex) => {
    const [x, y, z] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.abs(a - x) + Math.abs(b - y) + Math.abs(c - z) < 40;
  };
  for (const [name, x, y, hex] of [['light skin', 80, 220, '#e8b896'], ['dark skin', 130, 220, '#8d5524'],
    ['navy shirt', 180, 220, '#2a3550'], ['grey shirt', 80, 270, '#808080'], ['black hair', 130, 270, '#1a1a1a']]) {
    const got = await pixel(x, y);
    assert.ok(close(got, hex), `${name} was keyed out: expected about ${hex}, got ${got}`);
  }
  const shadow = await pixel(600, 180);
  assert.ok(shadow[2] > 200 && shadow[1] < 80, `the screen in shadow should be keyed too, got ${shadow}`);
});

test('dragging moves a source and it stays put after a reload', { skip }, async () => {
  const before = await page.evaluate(() => { const s = window.studio.doc.layouts[0].sources.find((x) => x.type === 'camera'); return { x: s.x, y: s.y }; });
  const box = await page.$eval('#overlay', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, k: r.width / c.width }; });
  await page.mouse.move(box.x + 300 * box.k, box.y + 200 * box.k);
  await page.mouse.down();
  await page.mouse.move(box.x + 500 * box.k, box.y + 300 * box.k, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => { const s = window.studio.doc.layouts[0].sources.find((x) => x.type === 'camera'); return { x: s.x, y: s.y }; });
  assert.ok(after.x > before.x + 150 && after.y > before.y + 50, JSON.stringify({ before, after }));

  await page.evaluate(() => window.studio.flush());
  await page.reload();
  await page.waitForTimeout(1500);
  const reloaded = await page.evaluate(() => { const s = window.studio.doc.layouts[0].sources.find((x) => x.type === 'camera'); return { x: s.x, y: s.y, chroma: s.chroma.enabled, bg: !!s.chroma.background }; });
  assert.equal(reloaded.x, after.x);
  assert.ok(reloaded.chroma && reloaded.bg, 'green-screen settings survive a reload');
});

test('the timer comes to the front when picked in the source list', { skip }, async () => {
  const order = () => page.evaluate(() => window.studio.doc.layouts[0].sources.map((s) => s.type));
  assert.deepEqual(await order(), ['timer', 'camera'], 'the camera was added on top');
  await page.click('#sourceList li[data-type=timer] .name');
  assert.deepEqual(await order(), ['camera', 'timer']);
  assert.equal(await page.evaluate(() => window.studio.compositor.selected), await page.evaluate(() => window.studio.doc.layouts[0].sources[1].id));
});

test('layouts: new, duplicate, rename and delete live in the layout menu, and are remembered', { skip }, async () => {
  await layoutMenu(page, 'new');                        // prompt() accepted with its default
  assert.deepEqual(await layoutNames(page), ['Main', 'Layout 2']);
  assert.equal(await page.textContent('#layoutName'), 'Layout 2');
  assert.equal(await page.$$eval('#sourceList li', (lis) => lis.length), 0, 'a new layout starts empty');

  await layoutMenu(page, 0);
  await layoutMenu(page, 'duplicate');
  assert.deepEqual(await layoutNames(page), ['Main', 'Layout 2', 'Main copy']);
  assert.equal(await page.$$eval('#sourceList li', (lis) => lis.length), 2, 'the copy has the sources');
  answers.push('Speedrun');
  await layoutMenu(page, 'rename');
  assert.equal(await page.textContent('#layoutName'), 'Speedrun');
  await layoutMenu(page, 'delete');                     // confirm() accepted
  assert.deepEqual(await layoutNames(page), ['Main', 'Layout 2']);

  await page.evaluate(() => window.studio.flush());
  await page.reload();
  await page.waitForTimeout(1200);
  assert.deepEqual(await layoutNames(page), ['Main', 'Layout 2']);
  assert.equal(await page.textContent('#layoutName'), 'Main', 'the layout in use is remembered too');
  assert.equal(await page.textContent('#saveState'), 'Saved');
});

test('layouts save across browsers: another one picks up changes, and a stale one merges instead of overwriting', { skip }, async () => {
  // A second browser with its own cookies and storage: another device.
  const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const b = await other.newPage();
  b.on('pageerror', (e) => errors.push(`second browser: ${e.message}`));
  b.on('dialog', answer);
  await b.request.post(`${server.url}/api/login`, { data: { user: USER, password: PASSWORD }, headers: { Origin: server.url } });
  await b.goto(`${server.url}/`);
  await b.waitForTimeout(1200);
  assert.deepEqual(await layoutNames(b), ['Main', 'Layout 2'], 'the same layouts on the other device');
  const camOnA = await page.evaluate(() => window.studio.doc.layouts[0].sources.find((s) => s.type === 'camera'));
  const camOnB = await b.evaluate(() => window.studio.doc.layouts[0].sources.find((s) => s.type === 'camera'));
  assert.equal(camOnB.x, camOnA.x, 'with the same positions');
  // Device ids differ between browsers: the camera is found again by its name.
  assert.notEqual(await b.evaluate(() => navigator.mediaDevices.enumerateDevices().then((d) => d.find((x) => x.kind === 'videoinput').deviceId)), camOnA.deviceId);
  await until(b, () => [...window.studio.compositor.feeds.values()].some((f) => f.ready));

  // A change here shows up there by itself, within the autosave interval.
  answers.push('Main (desk)');
  await layoutMenu(page, 'rename');
  await until(b, () => window.studio.doc.layouts[0].name === 'Main (desk)', null, 12000);
  assert.equal(await b.textContent('#layoutName'), 'Main (desk)');

  // Now B stops listening (hidden), A adds a layout, and B, still on the old
  // copy, renames: B's save is refused, then merged, so both changes survive.
  await b.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  await layoutMenu(page, 'new');                        // "Layout 3"
  await page.evaluate(() => window.studio.flush());
  answers.push('Main (laptop)');
  await layoutMenu(b, 'rename');
  await b.evaluate(() => window.studio.flush());
  const saved = (await (await page.request.get(`${server.url}/api/state`)).json()).layouts;
  assert.deepEqual(saved.layouts.map((l) => l.name), ['Main (laptop)', 'Layout 2', 'Layout 3']);
  await page.evaluate(() => window.studio.pull());
  assert.equal(await page.evaluate(() => window.studio.doc.layouts[0].name), 'Main (laptop)');
  assert.equal(await page.textContent('#layoutName'), 'Layout 3', 'this window stays on its own layout');
  await other.close();
  answers.length = 0;
  await layoutMenu(page, 'delete');
  await layoutMenu(page, 0);
  await page.evaluate(() => window.studio.flush());
});

test('changes that could not be saved are kept in the browser and saved on the next visit', { skip }, async () => {
  await page.route('**/api/layouts', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
  try {
    answers.push('Main');
    await layoutMenu(page, 'rename');
    await until(page, () => document.getElementById('saveState').dataset.state === 'error');
    assert.match(await page.textContent('#saveState'), /Not saved/);
  } finally {
    await page.unroute('**/api/layouts');
  }
  errors.length = 0;                                    // the aborted saves above, on purpose
  await page.reload();
  await page.waitForTimeout(1500);
  assert.equal(await page.textContent('#layoutName'), 'Main');
  const saved = (await (await page.request.get(`${server.url}/api/state`)).json()).layouts;
  assert.equal(saved.layouts[0].name, 'Main', 'and the server has it now');
  assert.equal(await page.textContent('#saveState'), 'Saved');
});

test('the timer runs from its hotkey and splits import and export as .lss', { skip }, async () => {
  const lss = `<?xml version="1.0" encoding="UTF-8"?><Run version="1.7.0"><GameName>Super Metroid</GameName>
    <CategoryName>Any%</CategoryName><Offset>00:00:00</Offset><AttemptCount>412</AttemptCount>
    <AttemptHistory><Attempt id="411"><RealTime>00:42:13.4500000</RealTime></Attempt></AttemptHistory><Segments>
    <Segment><Name>Ceres</Name><SplitTimes><SplitTime name="Personal Best"><RealTime>00:01:02.3400000</RealTime></SplitTime></SplitTimes>
    <BestSegmentTime><RealTime>00:00:59.1200000</RealTime></BestSegmentTime></Segment>
    <Segment><Name>Brinstar</Name><SplitTimes><SplitTime name="Personal Best"><RealTime>00:08:44.1000000</RealTime></SplitTime></SplitTimes>
    <BestSegmentTime><RealTime>00:07:30.0000000</RealTime></BestSegmentTime></Segment></Segments></Run>`;
  const file = join(server.data, 'splits.lss');
  writeFileSync(file, lss);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#splitsImport');
  await (await chooser).setFiles(file);
  await page.waitForTimeout(500);
  assert.equal(await page.textContent('#timerGame'), 'Super Metroid');

  // Hotkeys are set in their own small popup.
  await page.click('#hotkeysButton');
  await page.click('#hotkey-split');
  await page.keyboard.press('KeyS');
  await page.click('#hotkeysDialog button.primary');
  await until(page, () => window.studio.doc.hotkeys.split === 'KeyS');
  await page.click('.timer-clock');
  await page.keyboard.press('KeyS');
  await page.waitForTimeout(1200);
  assert.notEqual(await page.textContent('#timerClock'), '0:00.00');
  assert.equal(await page.textContent('#timerSplit'), 'Split');
  await page.keyboard.press('Numpad3');                 // reset
  assert.equal(await page.textContent('#timerSplit'), 'Start');

  const download = page.waitForEvent('download');
  await page.click('#splitsExport');
  const saved = await (await download).path();
  const out = readFileSync(saved, 'utf8');
  assert.match(out, /<GameName>Super Metroid<\/GameName>/);
  assert.match(out, /<AttemptCount>413<\/AttemptCount>/);
  assert.match(out, /00:00:59\.1200000/, 'golds survive the round trip');
  assert.match(out, /<Attempt id="411"/, 'LiveSplit attempt history is kept');

  const state = await (await page.request.get(`${server.url}/api/state`)).json();
  assert.equal(state.splits.game, 'Super Metroid', 'the imported splits are saved on the server');
});

test('audio inputs appear in the mixer with a live meter', { skip }, async () => {
  await addDevice(page, '#addAudio');
  await page.waitForTimeout(1500);
  const strips = await page.$$eval('#mixer .strip', (s) => s.length);
  assert.ok(strips >= 2, 'no second mixer strip');
  assert.ok(await meterMoves(page), 'the meter never moved');
});

test('a mic saved on another computer can become this computer\'s default mic', { skip }, async () => {
  await page.evaluate(() => {
    const { studio } = window;
    studio.doc.audio = [{ id: 'elsewhere1', deviceId: 'a-device-this-browser-never-had', label: 'Internal Mic', gain: 1.5, muted: false }];
    studio.save();
    return studio.flush();
  });
  await page.reload();
  await page.waitForSelector('#mixer .strip.missing');
  assert.match(await page.textContent('#mixer .strip.missing'), /Internal Mic: not on this device/);
  await page.click('#mixer .strip.missing button:has-text("Use default mic")');
  await page.waitForSelector('#mixer .strip:not(.missing)');
  assert.match(await page.textContent('#mixer .strip .name'), /^Default mic · /);
  const input = await page.evaluate(() => window.studio.doc.audio[0]);
  assert.deepEqual([input.id, input.deviceId, input.gain], ['elsewhere1', 'default', 1.5], 'the same input, its volume kept');
});

test('a blocked microphone says so, instead of "not found"', { skip }, async () => {
  await page.evaluate(() => window.studio.flush());
  const other = await browser.newContext();
  await other.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  const b = await other.newPage();
  await b.request.post(`${server.url}/api/login`, { data: { user: USER, password: PASSWORD }, headers: { Origin: server.url } });
  await b.goto(`${server.url}/`);
  await b.waitForSelector('#mixer .strip.missing');
  const text = await b.textContent('#mixer .strip.missing');
  assert.match(text, /^Default microphone: blocked\. Allow the microphone for this site/);
  assert.doesNotMatch(text, /Use default mic/, 'the default mic would be blocked too');
  await other.close();
});

test('going live asks for the stream key, then sends the stream to Twitch\'s global ingest', { skip }, async () => {
  await page.click('#streamButton');
  await page.waitForSelector('#keyDialog[open]');
  assert.deepEqual(await page.$$eval('#keyDialog input, #keyDialog button, #keyDialog select, #keyDialog textarea', (els) => els.map((e) => e.id || e.textContent)), ['streamKey', 'Save'],
    'the key popup has one field and one button');
  await page.fill('#streamKey', 'live_123456_abcdefghij');
  await page.keyboard.press('Enter');
  await until(page, () => !document.getElementById('keyDialog').open);
  await page.click('#layoutButton');
  assert.equal(await page.textContent('.menu [data-action=key]'), 'Twitch stream key ✓');
  await page.keyboard.press('Escape');
  await page.click('#streamButton');
  await page.waitForTimeout(4500);
  assert.match(await page.textContent('#streamStatus'), /LIVE/);
  await page.click('#streamButton');                     // confirm() accepted
  await page.waitForTimeout(800);
  assert.equal(await page.textContent('#streamStatus'), 'Offline');
  const args = readFileSync(join(server.data, 'args.txt'), 'utf8');
  assert.match(args, /^rtmp:\/\/ingest\.global-contribute\.live-video\.net\/app\/live_123456_abcdefghij$/m);
  const bytes = readFileSync(join(server.data, 'stdin.bin'));
  assert.ok(bytes.length > 20000, `only ${bytes.length} bytes reached ffmpeg`);
  assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'not WebM');
});

test('frames keep coming when the window is hidden', { skip }, async () => {
  // A hidden page gets no animation frames and throttled timers; the worker
  // clock must take over. Headless Chromium does not throttle for real, so this
  // checks the hand-over: animation frames stop, worker frames continue.
  // On the empty layout, so software rendering in CI does not set the pace.
  await layoutMenu(page, 1);
  const result = await page.evaluate(async () => {
    const c = window.studio.compositor;
    const original = c.frame.bind(c);
    let frames = 0;
    c.frame = () => { frames++; original(); };
    const realRaf = window.requestAnimationFrame;
    let rafCalls = 0;
    window.requestAnimationFrame = (fn) => { rafCalls++; return realRaf(fn); };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 300));    // let the last animation frame drain
    frames = 0; rafCalls = 0;
    await new Promise((r) => setTimeout(r, 1000));
    const hidden = { frames, rafCalls };
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));   // a second flip must not start a second loop
    await new Promise((r) => setTimeout(r, 300));
    frames = 0; rafCalls = 0;
    await new Promise((r) => setTimeout(r, 1000));
    const visible = { frames, rafCalls };
    c.frame = original;
    window.requestAnimationFrame = realRaf;
    return { hidden, visible, fps: window.studio.doc.output.fps };
  });
  assert.equal(result.hidden.rafCalls, 0, 'the animation loop should stop while hidden');
  assert.ok(result.hidden.frames >= result.fps * 0.8, `only ${result.hidden.frames} frames while hidden`);
  assert.ok(result.visible.frames >= result.fps * 0.8, `only ${result.visible.frames} frames once visible again: ${JSON.stringify(result)}`);
  assert.ok(result.visible.rafCalls <= 70, `${result.visible.rafCalls} animation frames a second: two loops running`);
});

test('a slow frame while hidden lowers the frame rate instead of piling up', { skip }, async () => {
  // Regression: the hidden-tab clock used to tick on a fixed interval, so a
  // frame slower than the interval queued ticks without bound and starved
  // everything else on the page — including sending the stream.
  const result = await page.evaluate(async () => {
    const c = window.studio.compositor;
    const original = c.frame.bind(c);
    let frames = 0;
    c.frame = () => { frames++; const end = performance.now() + 60; while (performance.now() < end) { /* a 60 ms frame */ } original(); };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 1000));
    const elapsed = Date.now() - started;
    const counted = frames;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    c.frame = original;
    return { elapsed, frames: counted };
  });
  assert.ok(result.elapsed < 1500, `a one-second wait took ${result.elapsed} ms: the page was backed up`);
  assert.ok(result.frames <= 20, `${result.frames} frames of 60 ms in about a second is not possible without a backlog`);
  await layoutMenu(page, 0);
});

test('no errors in the console', { skip }, () => {
  assert.equal(errors.length, 0, errors.join('\n'));
});
