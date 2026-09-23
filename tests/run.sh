#!/usr/bin/env bash
# Run everything that can run here. Each suite is independent, so a missing
# tool (node, playwright) skips that suite rather than failing the run.
set -u
cd "$(dirname "$0")/.."
STATUS=0

echo "── timer engine"
if command -v node >/dev/null 2>&1; then node tests/timer.test.mjs || STATUS=1
else echo "skipped (node not installed)"; fi

echo "── php"
php tests/php.test.php || STATUS=1

echo "── api"
bash tests/api.test.sh || STATUS=1

echo "── browser"
if command -v node >/dev/null 2>&1; then node tests/browser.test.mjs || STATUS=1
else echo "skipped (node not installed)"; fi

echo
[ "$STATUS" -eq 0 ] && echo "all suites passed" || echo "some suites failed"
exit "$STATUS"
