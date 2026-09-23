#!/usr/bin/env bash
# End-to-end test of the PHP API against a real PHP server, in a throwaway
# copy of the app so your own data/ is never touched.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${TEST_PORT:-8977}"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check <name> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then
    PASS=$((PASS+1)); printf '.'
  else
    FAIL=$((FAIL+1)); printf 'x'
    FAILURES="${FAILURES:-}
  FAIL $1
    wanted: $3
    got:    $(printf '%s' "$2" | head -c 300)"
  fi
}

reject() { # reject <name> <haystack> <needle that must be absent>
  if printf '%s' "$2" | grep -qF -- "$3"; then
    FAIL=$((FAIL+1)); printf 'x'
    FAILURES="${FAILURES:-}
  FAIL $1
    must not contain: $3
    got:              $(printf '%s' "$2" | head -c 300)"
  else
    PASS=$((PASS+1)); printf '.'
  fi
}

# --- isolated copy of the app
for item in api lib assets overlay index.php login.php install.php health.php config.sample.php .htaccess; do
  cp -r "$ROOT/$item" "$WORK/" 2>/dev/null
done
mkdir -p "$WORK/data"

# Several workers: PHP's built-in server is single-threaded otherwise, and the
# concurrency test below would measure that instead of what it means to.
PHP_CLI_SERVER_WORKERS=4 php -S "127.0.0.1:$PORT" -t "$WORK" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/index.php?r=health" >/dev/null 2>&1 && break
  sleep 0.25
done

API="http://127.0.0.1:$PORT/api/index.php?r="
JAR="$WORK/cookies.txt"
get() { curl -s -b "$JAR" -c "$JAR" "$API$1"; }
post() { curl -s -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: ${CSRF:-}" -d "$2" "$API$1"; }

# --- before install
check "health responds"              "$(get health)" '"ok":true'
check "health reports not installed" "$(get health)" '"installed":false'
check "api refuses work uninstalled"  "$(get config)" 'not installed'

# --- install
curl -s -c "$JAR" -d 'username=tester&password=hunter2hunter2&password2=hunter2hunter2&site_name=CI' \
  "http://127.0.0.1:$PORT/install.php" >/dev/null
check "installer created config" "$(cat "$WORK/data/config.json")" '"installed": true'
reject "password is not stored in the clear" "$(cat "$WORK/data/config.json")" 'hunter2hunter2'

# --- auth
check "wrong password is refused" "$(curl -s -H 'Content-Type: application/json' -d '{"username":"tester","password":"nope"}' "${API}session/login")" 'invalid credentials'
LOGIN="$(curl -s -c "$JAR" -H 'Content-Type: application/json' -d '{"username":"tester","password":"hunter2hunter2"}' "${API}session/login")"
check "login succeeds" "$LOGIN" '"ok":true'
CSRF="$(printf '%s' "$LOGIN" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p')"
TOKEN="$(printf '%s' "$LOGIN" | sed -n 's/.*"overlayToken":"\([^"]*\)".*/\1/p')"
check "session reports the user" "$(get session/me)" '"user":"tester"'

# --- csrf enforcement
check "a mutation without the token is refused" \
  "$(curl -s -b "$JAR" -H 'Content-Type: application/json' -d '{"config":{"scenes":[]}}' "${API}config")" 'bad csrf'

# --- config
check "config saves"  "$(post config '{"config":{"scenes":[{"id":"sc1","name":"Main","sources":[]}],"activeScene":"sc1"}}')" '"rev":1'
check "config loads"  "$(get config)" '"name":"Main"'
check "revision bumps" "$(post config '{"config":{"scenes":[{"id":"sc1","name":"Main","sources":[]}]}}')" '"rev":2'

# --- timer state and the overlay token
check "state publishes" "$(post state '{"state":{"phase":"running","time":12.5,"game":"Test","segments":[]}}')" '"ok":true'
check "overlay token reads state" "$(curl -s "${API}state&token=$TOKEN")" '"game":"Test"'
check "a bad overlay token is refused" "$(curl -s "${API}state&token=wrong")" 'not authenticated'
check "no token at all is refused"     "$(curl -s "${API}state")" 'not authenticated'

# --- a waiting overlay must not block the studio
# Regression: the long poll held the PHP session lock, so every other request
# from the same browser queued behind it — including the studio's own saves.
curl -s -b "$JAR" "${API}state&since=99999&wait=2500&token=$TOKEN" >/dev/null &
POLL_PID=$!
sleep 0.4
ELAPSED="$(curl -s -o /dev/null -w '%{time_total}' -b "$JAR" -c "$JAR" "${API}session/me")"
wait $POLL_PID 2>/dev/null
QUICK="$(python3 -c "print('quick' if float('$ELAPSED') < 1.0 else 'slow:$ELAPSED')")"
check "a long poll does not block other requests" "$QUICK" 'quick'

# --- splits
LSS='<?xml version="1.0"?><Run version="1.7.0"><GameName>Celeste</GameName><CategoryName>Any%</CategoryName><Offset>00:00:00</Offset><AttemptCount>77</AttemptCount><Segments><Segment><Name>Forsaken City</Name><SplitTimes><SplitTime name="Personal Best"><RealTime>00:02:10.5</RealTime></SplitTime></SplitTimes><BestSegmentTime><RealTime>00:02:05</RealTime></BestSegmentTime></Segment></Segments></Run>'
IMPORT="$(python3 -c "import json,sys;print(json.dumps({'xml':sys.argv[1]}))" "$LSS" | curl -s -b "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d @- "${API}splits/import")"
check "lss imports"          "$IMPORT" '"game":"Celeste"'
check "lss keeps the gold"   "$IMPORT" '"best":125'
printf '%s' "$IMPORT" | python3 -c "import sys,json;print(json.dumps({'run':json.load(sys.stdin)['run']}))" > "$WORK/run.json"
SAVED="$(curl -s -b "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d @"$WORK/run.json" "${API}splits/save")"
check "splits save" "$SAVED" '"ok":true'
SPLIT_ID="$(printf '%s' "$SAVED" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
check "splits list"     "$(get splits/list)" '"game":"Celeste"'
check "list shows a PB" "$(get splits/list)" '"pb":130.5'
check "splits export as lss" "$(get "splits/export&id=$SPLIT_ID")" '<GameName>Celeste</GameName>'
check "export keeps the gold" "$(get "splits/export&id=$SPLIT_ID")" '<BestSegmentTime>'
check "splits delete" "$(post splits/delete "{\"id\":\"$SPLIT_ID\"}")" '"ok":true'
reject "deleted splits leave the list" "$(get splits/list)" 'Celeste'

# --- runs
check "a run is recorded" "$(post runs/add '{"run":{"game":"Celeste","time":123.4,"isPb":true}}')" '"ok":true'
check "run history lists it" "$(get runs/list)" '"time":123.4'

# --- destinations
check "destination saves" "$(post destinations '{"destinations":[{"name":"Twitch","service":"twitch","url":"rtmp://live.twitch.tv/app","key":"live_secret_key","enabled":true}]}')" '"count":1'
reject "stream key never comes back" "$(get destinations)" 'live_secret_key'
check "stream key is masked"         "$(get destinations)" '••••••••'
reject "stream key is not on disk in the clear" "$(cat "$WORK/data/destinations.json")" 'live_secret_key'
check "a masked key round-trips without being re-encrypted as literal dots" \
  "$(post destinations '{"destinations":[{"id":"'"$(sed -n 's/.*"id": "\([^"]*\)".*/\1/p' "$WORK/data/destinations.json" | head -1)"'","name":"Twitch","service":"twitch","url":"rtmp://live.twitch.tv/app","key":"••••••••","enabled":true}]}')" '"count":1'

# --- the installer cannot be re-run against a live site
curl -s -d 'username=attacker&password=takeoverpassword&password2=takeoverpassword' \
  "http://127.0.0.1:$PORT/install.php" >/dev/null
check "a second install attempt is refused" \
  "$(curl -s -H 'Content-Type: application/json' -d '{"username":"attacker","password":"takeoverpassword"}' "${API}session/login")" 'invalid credentials'
check "the original owner survives" "$(cat "$WORK/data/config.json")" '"name": "tester"'

# --- destination URLs are validated where it matters: before ffmpeg sees them
check "a non-rtmp destination is refused" \
  "$(post destinations '{"destinations":[{"name":"bad","url":"file:///etc/passwd","key":"x","enabled":true}]}')" 'must be a plain rtmp'
check "a shell-flavoured destination is refused" \
  "$(post destinations '{"destinations":[{"name":"bad","url":"rtmp://host/app; rm -rf /","key":"x","enabled":true}]}')" 'must be a plain rtmp'
check "rtmps is accepted" \
  "$(post destinations '{"destinations":[{"name":"Kick","service":"kick","url":"rtmps://fa723fc1b171.global-contribute.live-video.net:443/app","key":"k","enabled":true}]}')" '"count":1'
# put the twitch destination back for the ticket test below
post destinations '{"destinations":[{"name":"Twitch","service":"twitch","url":"rtmp://live.twitch.tv/app","key":"live_secret_key","enabled":true}]}' >/dev/null

# --- relay ticket
check "no relay configured yet" "$(post relay/ticket '{}')" 'no relay configured'
check "relay url saves"         "$(post settings '{"relay_url":"wss://relay.example.com/ingest"}')" '"ok":true'
check "relay url must be a websocket" "$(post settings '{"relay_url":"http://nope"}')" 'must start with ws'
TICKET_JSON="$(post relay/ticket '{"video":{"w":1280,"h":720,"fps":30}}')"
check "ticket is issued" "$TICKET_JSON" '"ticket":'
TICKET="$(printf '%s' "$TICKET_JSON" | sed -n 's/.*"ticket":"\([^"]*\)".*/\1/p')"
SECRET="$(python3 -c "import json;print(json.load(open('$WORK/data/config.json'))['relay_secret'])")"
VERIFY="$(python3 - "$TICKET" "$SECRET" <<'PY'
import base64, hmac, hashlib, json, sys
ticket, secret = sys.argv[1], sys.argv[2]
body, sig = ticket.rsplit('.', 1)
pad = lambda s: s + '=' * (-len(s) % 4)
expected = base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
payload = json.loads(base64.urlsafe_b64decode(pad(body)))
print('SIG_OK' if hmac.compare_digest(sig, expected) else 'SIG_BAD', json.dumps(payload))
PY
)"
check "ticket signature verifies"        "$VERIFY" 'SIG_OK'
check "ticket carries the full rtmp url" "$VERIFY" 'rtmp://live.twitch.tv/app/live_secret_key'
check "ticket expires soon"              "$VERIFY" '"exp"'

# --- password change
check "wrong current password is refused" "$(post password '{"current":"nope","next":"anotherpassword"}')" 'current password is wrong'
check "a short password is refused"       "$(post password '{"current":"hunter2hunter2","next":"short"}')" 'at least 8'
check "password changes"                  "$(post password '{"current":"hunter2hunter2","next":"anotherpassword"}')" '"ok":true'
check "the new password works"            "$(curl -s -c "$WORK/jar2" -H 'Content-Type: application/json' -d '{"username":"tester","password":"anotherpassword"}' "${API}session/login")" '"ok":true'

# --- login throttling
for _ in 1 2 3 4 5 6; do
  curl -s -H 'Content-Type: application/json' -d '{"username":"tester","password":"bad"}' "${API}session/login" >/dev/null
done
check "repeated failures are throttled" "$(curl -s -H 'Content-Type: application/json' -d '{"username":"tester","password":"bad"}' "${API}session/login")" 'too many attempts'

# --- logout
check "logout works"                "$(post session/logout '{}')" '"ok":true'
check "config is closed after logout" "$(curl -s "${API}config")" 'not authenticated'

# --- the health check
check "health check needs a login once installed" \
  "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health.php?format=json")" '302'
HEALTH="$(curl -s -b "$WORK/jar2" "http://127.0.0.1:$PORT/health.php?format=json")"
check "health check reports the PHP version" "$HEALTH" '"label":"PHP version"'
check "health check notices the data directory is servable here" "$HEALTH" 'SERVED YOUR CONFIG'
check "health check notices install.php is still present" "$HEALTH" 'install.php is still here'

# --- unknown route
check "unknown routes 404"          "$(get bogus/route)" 'unknown route'

printf '\n'
[ -n "${FAILURES:-}" ] && printf '%s\n' "$FAILURES"
echo "api: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
