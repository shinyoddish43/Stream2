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
