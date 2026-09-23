#!/usr/bin/env bash
#
# Build a static, server-free copy of the studio for publishing as a plain web
# page: no PHP, no account, no install. Everything the demo does is kept in the
# visitor's own browser.
#
#   deploy/build-demo.sh [output-dir]      # default: dist-demo
#
# The shell is rendered by the real index.php rather than kept as a second
# copy, so the demo cannot drift from the application.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-demo}"
PORT="${DEMO_BUILD_PORT:-8996}"
WORK="$(mktemp -d)"
cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

# Render the shell from a throwaway install.
for item in api lib assets overlay index.php login.php install.php; do
  cp -r "$ROOT/$item" "$WORK/"
done
mkdir -p "$WORK/data"
php -S "127.0.0.1:$PORT" -t "$WORK" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/index.php?r=health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -s -c "$WORK/jar" -d 'username=demo&password=demodemodemo&password2=demodemodemo&site_name=Stream+Studio' \
  "http://127.0.0.1:$PORT/install.php" >/dev/null
curl -s -b "$WORK/jar" -c "$WORK/jar" -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demodemodemo"}' \
  "http://127.0.0.1:$PORT/api/index.php?r=session/login" >/dev/null
curl -s -b "$WORK/jar" "http://127.0.0.1:$PORT/index.php" -o "$WORK/index.html"
grep -q 'id="programCanvas"' "$WORK/index.html" || { echo "The shell did not render." >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$ROOT/assets" "$OUT/"
cp -r "$ROOT/overlay" "$OUT/"

python3 - "$WORK/index.html" "$OUT/index.html" <<'PY'
import re, sys

source, target = sys.argv[1], sys.argv[2]
html = open(source, encoding='utf-8').read()

# Demo boot: no CSRF, no account, and the flag api.js switches on.
html = re.sub(
    r'<script>window\.STUDIO_BOOT = .*?</script>',
    '<script>window.STUDIO_BOOT = {"demo":true,"user":"you","csrf":"demo",'
    '"siteName":"Stream Studio","overlayToken":"demo","relayUrl":"","version":"1.0.0"};</script>',
    html, flags=re.S)

# Nothing to sign out of.
html = html.replace(
    '<a class="mb" href="api/index.php?r=session/logout" id="logoutLink" title="Sign out" aria-label="Sign out">⎋</a>',
    '<a class="mb" href="https://github.com/shinyoddish43/Stream2" target="_blank" rel="noopener" '
    'title="Source and installer">Get it</a>')

# Say what this is, once, where it cannot be missed.
html = html.replace('</head>', '''<style>
  .demo-note {
    background: #2a2416; border-bottom: 1px solid #5a4a20; color: #e8d9a8;
    font-size: .76rem; padding: .3rem .6rem; display: flex; gap: .5rem; align-items: center;
  }
  .demo-note b { color: #ffd76e; }
  .demo-note a { color: #ffd76e; }
  .app-shell { grid-template-rows: auto 34px 1fr var(--dock-h); }
  @media (max-width: 1100px) { .app-shell { grid-template-rows: auto 34px 1fr auto; } }
</style></head>''')
html = html.replace('<body class="app-shell">', '''<body class="app-shell">
<div class="demo-note">
  <b>Demo.</b>
  <span id="demoNoteText">Scenes, sources, the speedrun timer and the overlays are the real thing, kept in this
  browser and nowhere else. Streaming needs the installed version.</span>
  <a href="https://github.com/shinyoddish43/Stream2" target="_blank" rel="noopener">Install your own &rarr;</a>
</div>
<script>
  // Say what this particular page can do. A sandboxed preview or plain HTTP
  // refuses capture outright, and claiming otherwise wastes the visitor's time.
  (function () {
    var media = navigator.mediaDevices || {};
    var canCapture = typeof media.getDisplayMedia === 'function';
    var canRecord = typeof window.MediaRecorder === 'function';
    var missing = [];
    if (!canCapture) missing.push('screen and camera capture');
    if (!canRecord) missing.push('recording');
    if (missing.length) {
      document.getElementById('demoNoteText').textContent =
        'Scenes, sources, the speedrun timer and the overlays are the real thing. This page cannot do '
        + missing.join(' or ') + ' \u2014 whatever is showing it does not allow that. The installed version does.';
    }
  })();
</script>''')
open(target, 'w', encoding='utf-8').write(html)
print(f'wrote {target} ({len(html)} bytes)')
PY

# The demo has no API directory; leave nothing behind that implies one.
find "$OUT" -name '*.php' -delete
echo "Demo built in $OUT"
du -sh "$OUT"
