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
- **Not deployed yet**: the live steps (six7-hub.md §3) were blocked by the
  agent's permission classifier and wait for the owner.

## Not done

- **Not deployed.** Target: `t.six7.pw`, DNS → 46.62.200.78. The previous
  session ran in a sandbox with no SSH and no network access to that host.
  From a machine with `ssh vps` working:
  `ALLOW_IP=<home IP> deploy/push.sh vps t.six7.pw`
  It detects the web server already on the VPS and adds a site next to it.
  It has not yet been run on a real VPS or against real Twitch; use the
  bandwidth-test option in Settings for the first stream.
- **Shared login with the "six7 hub"** (open question from the owner). Not
  investigated: the hub was not reachable. Feasible if the hub's session
  cookie is scoped to `.six7.pw` and it can answer "is this session valid":
  put the check in the reverse proxy (Caddy `forward_auth` / nginx
  `auth_request`) and have server.js trust a user header from loopback only.
  Otherwise the hub needs a cookie-domain change or a redirect login. Keep
  the studio's own password until then: the studio can go live on the
  owner's Twitch with the saved key.
- Known limit: timer hotkeys only fire while the studio tab has focus.
