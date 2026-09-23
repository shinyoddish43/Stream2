// Shared test plumbing: a throwaway server with its own data directory.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const USER = 'runner';
export const PASSWORD = 'correct-horse-battery';

let nextPort = 9100 + Math.floor(Math.random() * 400);

/** A fake ffmpeg that records its arguments and everything piped into it. */
export function stubFfmpeg(dir) {
  const stub = join(dir, 'ffmpeg');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat > "${dir}/stdin.bin"\n`);
  chmodSync(stub, 0o755);
  return stub;
}

export async function startServer(env = {}) {
  const data = mkdtempSync(join(tmpdir(), 'studio-test-'));
  const port = nextPort++;
  const base = { ...process.env, DATA_DIR: data, PORT: String(port), FFMPEG: stubFfmpeg(data), ...env };
  execFileSync('node', [join(ROOT, 'server.js'), 'passwd'], { env: { ...base, STUDIO_USER: USER, STUDIO_PASSWORD: PASSWORD } });
  const proc = spawn('node', [join(ROOT, 'server.js')], { env: base, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${url}/healthz`)).ok) break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { url, data, port, proc, log: () => log, stop: () => proc.kill() };
}

/** Log in and return a fetch that carries the session and a same-site Origin. */
export async function login(url) {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ user: USER, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = (path, opts = {}) => fetch(`${url}${path}`, {
    ...opts, redirect: 'manual',
    headers: { Origin: url, Cookie: cookie, ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
  });
  call.cookie = cookie;
  return call;
}
