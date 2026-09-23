// The real thing, minus Twitch: a real ffmpeg on our side pushes to a second
// ffmpeg listening as an RTMP server, and we check what arrives is what
// Twitch asks for — H.264 + AAC, the chosen frame rate, a keyframe every two
// seconds. Skipped when no ffmpeg is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startServer, login } from './helpers.mjs';

const FFMPEG = process.env.REAL_FFMPEG || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;

test('a stream reaches an RTMP server as H.264/AAC with 2-second keyframes', { skip: !hasFfmpeg && 'no ffmpeg installed', timeout: 90000 }, async () => {
  const server = await startServer({ FFMPEG });
  const dir = server.data;
  try {
    // What a browser would send: VP8 + Opus in WebM, variable frame timing.
    const clip = join(dir, 'clip.webm');
    const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '7', '-c:v', 'libvpx', '-deadline', 'realtime',
      '-b:v', '2M', '-c:a', 'libopus', clip]);
    assert.equal(made.status, 0, String(made.stderr));

    // Stand-in for Twitch's ingest.
    const port = server.port + 1000;
    const received = join(dir, 'received.flv');
    const ingest = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-listen', '1',
      '-i', `rtmp://127.0.0.1:${port}/app/live_test_KEY123`, '-c', 'copy', received]);
    await new Promise((r) => setTimeout(r, 800));

    const api = await login(server.url);
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ingest: `rtmp://127.0.0.1:${port}/app`, streamKey: 'live_test_KEY123' }) });

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/stream`, { headers: { Origin: server.url, Cookie: api.cookie } });
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'start', fps: 30, bitrate: 2500, mimeType: 'video/webm;codecs=vp8,opus' })));
      ws.on('message', async (d) => {
        const msg = JSON.parse(d);
        if (msg.type === 'error') reject(new Error(msg.message));
        if (msg.type !== 'ready') return;
        // Feed it in browser-sized chunks, about as fast as a browser would.
        const data = readFileSync(clip);
        for (let i = 0; i < data.length; i += 64 * 1024) {
          ws.send(data.subarray(i, i + 64 * 1024));
          await new Promise((r) => setTimeout(r, 40));
        }
        await new Promise((r) => setTimeout(r, 1500));
        ws.send(JSON.stringify({ type: 'stop' }));
        ws.close();
        resolve();
      });
    });
    await new Promise((resolve) => { ingest.on('exit', resolve); setTimeout(() => { ingest.kill(); resolve(); }, 15000); });

    assert.ok(existsSync(received) && statSync(received).size > 100000, 'nothing arrived at the ingest');
    const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', received], { encoding: 'utf8' }).stderr;
    assert.match(probe, /Video: h264/, probe);
    assert.match(probe, /Audio: aac/, probe);
    assert.match(probe, /1280x720/, probe);
    assert.match(probe, /30 fps/, probe);

    // Keyframe timestamps: every two seconds, as Twitch requires.
    const keys = spawnSync(FFMPEG, ['-hide_banner', '-skip_frame', 'nokey', '-i', received, '-vf', 'showinfo', '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const times = [...keys.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
    assert.ok(times.length >= 3, `only ${times.length} keyframes`);
    for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i] - times[i - 1] - 2) < 0.05, `keyframe gap ${times[i] - times[i - 1]}`);
  } finally {
    server.stop();
  }
});
