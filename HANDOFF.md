# Handoff

State of the branch `claude/browser-stream-studio-r66c2c`, for whoever picks this up.

## What this is

A minimal browser stream studio: capture devices + screen in an OBS-style
layout, a native LiveSplit-style timer (.lss import/export), an audio mixer,
a GPU green screen, and streaming to Twitch through a Node server on a VPS.
See README.md for features, install and tests.

- `server.js` — the whole backend: login, storage (`data/`), uploads, and the
  WebSocket → ffmpeg → RTMP relay. One dependency (`ws`).
- `public/` — the client, plain ES modules, no build step.
- `deploy/install.sh` — VPS installer (systemd + Caddy or nginx, HTTPS).
  `deploy/push.sh <ssh-host> <domain>` runs it from your own machine.
- `test/` — `npm test` (Node 20+). Real-ffmpeg and Playwright suites skip if
  those tools are absent.

## Verified

- Full suite passed (41 tests) on commit 740d965, including a real ffmpeg
  pushing to a local RTMP server (H.264/AAC, 2 s keyframes) and green-screen
  pixel checks in Chromium.
- Installer changes since then (coexisting with an existing Caddy/nginx,
  rollback on a failed config check, port 8787, IPv6 only where available,
  `push.sh` quoting) passed `test/install.test.sh` (28 checks, real Caddy
  2.8.4 and nginx 1.24) and shellcheck. The last fresh run of the *entire*
  suite after those changes was interrupted, so run `npm test` once first.

## Since then (September 24)

- The failing test was the test, not push.sh: it stubbed ssh/scp/env but not
  sudo, so it only passed as root. Fixed.
- The six7 VPS runs Caddy **in Docker** (`six7-proxy-1`), so install.sh sees
  no Caddy/nginx and skips the web side. New container deploy for that case:
  `deploy/docker/` (Dockerfile, compose, `push.sh`, `authentik_setup.py`,
  and `six7-hub.md` with the hub changes and the order of work).
- Single sign-on with the hub: the hub login is authentik (login.six7.pw).
  server.js accepts `AUTH_HEADER` (+ `AUTH_USERS`, `LOGOUT_URL`) from a proxy
  listed in `TRUST_PROXY`; see test/sso.test.mjs. Password login still works
  when the header is absent.
- Home network: the owner chose "every device at home is signed in to a
  shared guest account; anyone can sign in to their real account, which then
  stays on that device". That lives in the hub repo
  (`scripts/home_network_sign_in.py`, `docs/SECURITY-WATCHLIST.md`); the
  guest is refused by the studio, so going live needs a real sign-in.
- Reviewed adversarially before deploy (4 independent reviewers, read-only on
  the VPS). Fixed from it: the proxy provider now gets authentik's OAuth
  defaults (without them sign-in failed with a redirect URI error); authentik
  must trust `X-Forwarded-For` from the hub Caddy alone (else the VPS host
  could claim the home IP); guest lock-down; fixed-address ranges;
  push.sh aborts on a failed unpack; 30-minute upload timeout; an expired
  hub sign-in in an open tab now says so instead of a CORS error.
- **Deployed September 24, 2026** at https://t.six7.pw (container
  `streamstudio-studio-1`, commit df2dfaf; later commits change only tests
  and CI). Checked live: Let's Encrypt certificate; anonymous requests and a
  forged `X-Authentik-Username` + `X-Forwarded-For` from outside home both
  go to the hub login; only Caddy (10.67.0.2) and the studio share
  `six7_studio-edge`; no host ports; ffmpeg 7.1.5 in the image. The home
  guest is refused (authentik "Permission denied"), as intended.
- CI is green for the first time since 740d965 (52/52). Two old failures
  fixed: nginx -t needs to bind port 80, which CI's ordinary user could not
  (the workflow now lowers the unprivileged port range; elsewhere that part
  skips with the reason), and the audio meter test sampled too sparsely.

## Not done

- **Not yet done by a person:** signing in to the studio as the owner (the
  agent does not type passwords; at home use
  https://login.six7.pw/if/flow/six7-sign-in/ once, then t.six7.pw), and a
  real Twitch stream. Use the bandwidth-test option in Settings first.
- Shared login with the hub: done (authentik forward auth, see above).
  `deploy/install.sh` and `push.sh` remain for VPSes whose web server runs
  on the host; they were not used for six7.
- Known limit: timer hotkeys only fire while the studio tab has focus.
