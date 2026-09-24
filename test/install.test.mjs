// Runs test/install.test.sh: the deploy scripts against real Caddy and nginx
// in throwaway directories. Parts whose web server is not installed skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

test('the installer adds the studio to Caddy or nginx without disturbing other sites', { skip: process.platform === 'win32' && 'needs bash' }, () => {
  const run = spawnSync('bash', [join(ROOT, 'test', 'install.test.sh')], { encoding: 'utf8', env: process.env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /install: \d+ passed, 0 failed/);
});
