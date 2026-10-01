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

## September 29: simpler UI, shared layouts

Deployed at t.six7.pw (data backed up first to
`~/six7-backups/streamstudio-data-20260929-103526.tgz` on the VPS).

- Twitch server defaults to the global ingest
  `rtmp://ingest.global-contribute.live-video.net/app`; a saved
  `rtmp://live.twitch.tv/app` is moved to it.
- Properties panel removed. Cameras open at fixed defaults (up to 1080p60,
  shape matched once); a small Green screen panel (on/off, colour, upload)
  works on the selected camera or else the first one; keying strength is
  fixed. The screen source has a Share button in Sources, a failed camera a
  Retry. Clicking the timer in Sources brings it to the front.
- Layout menu at the top left: layouts, new/duplicate/rename/delete, and a
  one-field Twitch stream key popup. The stream key left Settings; hotkeys
  moved to a ⌨ popup under the timer.
- Layouts carry a server revision (`rev`). Saves send the revision they were
  based on; a stale one gets 409 with the current copy and the page merges
  (keeps its edits plus layouts made elsewhere) and saves again. Pages poll
  `GET /api/layouts?since=rev` every 5 s while visible and on focus, and adopt
  newer copies when they have no unsaved changes (keeping their own active
  layout, and a live stream's output size). Every change is also stashed in
  localStorage until the server has it and restored on the next load if
  nothing newer was saved. Device ids differ per browser, so cameras fall back
  to the same name, then the default camera; audio inputs only to the same name.
- Preview is now sized with container units, so it is never cropped when the
  panel is narrower than 16:9 (it was before).
- `npm test`: 59/59 locally, including real ffmpeg and Chromium.

## September 29, later: one column, no settings, the default mic

Deployed (data backup `~/six7-backups/streamstudio-data-20260929T164542Z.tgz`),
CI 63/63.

- No header, no bottom bar: the preview fills the window's height at 16:9 on
  the left; the right column has the layout menu and Start streaming in the
  top-right corner, then status, timer, sources, green screen, audio. Log out
  is in the layout menu. Settings are gone (1280x720, 30 fps, 4500 kbps,
  global ingest; the server API still takes `ingest`/`testMode`, the tests use
  it).
- Audio: `deviceId: "default"` means the default mic of whichever computer
  the studio runs on; new studios start with it. Missing inputs say why (not
  on this device / blocked / in use); a mic from another computer offers
  "Use default mic". Meter is post-volume, pre-mute, in dB; sound resumes on
  the first pointerdown or keydown.
- The owner's saved doc has one input, "Internal Mic" (made on a ChromeOS-like
  device: "Front Camera (0408:4058)"), saved **muted**.
- "Default internal mic not detected" on odd-box (ThinkPad E14 Gen 4 AMD):
  the internal mic is the Realtek ALC257's analog "Internal Mic" (the
  card's only capture, `pro-input-0`; Chrome calls it "Family 17h/19h HD
  Audio Controller Pro"). It was unusable because its hardware gain sat at
  +60 dB (Capture +30, Internal Mic Boost +30: left from an earlier profile's
  100% input volume; the Pro Audio profile never resets it), which pinned it
  to full scale, and PipeWire had it muted. Fixed on odd-box: Capture 0 dB,
  Internal Mic Boost +20 dB (clean, room at about -41 dBFS), unmuted, default
  input; `alsa-restore` keeps the levels across reboots. A first guess (the
  AMD ACP digital mic, `options snd_rn_pci_acp3x dmic_acpi_check=1`) was
  wrong: that card appears but reads constant 0x80000000, nothing is wired to
  it; the owner can delete `/etc/modprobe.d/thinkpad-dmic.conf`.
- A mic that stops by itself (unplugged, sound system restarted) now shows
  "stopped" and is tried again once after 1.5 s.
- Audio inputs other than the default mic carry `computer` (a random id in
  that browser's localStorage, `studio.computer`). Another computer leaves
  them out instead of listing them missing; old inputs are claimed by the
  first computer that opens them. The Sources and Audio boxes size to
  their contents and grow as things are added. CI 65/65.

## September 30: Twitch chat

- A Chat panel under Audio takes the rest of the column. The page reads the
  chat straight from Twitch's chat server (`wss://irc-ws.chat.twitch.tv`,
  signed out as `justinfan…`; `public/chat.js`), and only the channel of the
  account the stream key streams to (keys are `live_<account id>_…`).
- Writing in it: the studio's own Twitch app (Client ID pasted in the chat
  panel, stored in `settings.json`; a secret only for a Confidential app,
  never sent back) signs the owner in with Twitch's device code flow (a code
  on twitch.tv/activate, scope `user:write:chat` only). Tokens stay in
  `settings.json`; messages go out through Helix `POST /chat/messages` as that
  account, and show when Twitch sends them round. The server checks the token
  on start and hourly (Twitch requires it), renews it two hours before it
  runs out (a Public app's refresh token lasts 30 days, so this keeps it
  alive) and follows a renamed account.
- The chat shows Twitch's badges (global, and the channel's own sub badges) as
  pictures, and only Twitch's **global** emotes as pictures: a channel's own
  emotes and BTTV/7TV ones show as their names, as the owner asked.
- CSP: `connect-src` adds `wss://irc-ws.chat.twitch.tv`, `img-src`
  `https://static-cdn.jtvnw.net`. A global `[hidden]{display:none!important}`
  rule: `.row{display:flex}` used to beat the `hidden` attribute.
- Tests: `test/chat.test.mjs`, `test/fake-twitch.mjs` (stand-in for Twitch's
  sign-in and API servers; `TWITCH_AUTH_URL`/`TWITCH_API_URL` point the server
  at it), and browser tests with Playwright's `routeWebSocket` as the chat
  server. 85/85 locally under Playwright 1.49; the browser file also passes
  under 1.62.
- Checked against real Twitch: reading a busy channel (messages, an emote, no
  CSP violations, real Chromium); a channel that does not exist gets no reply
  at all (hence the 10 s "channel not found"); an unknown Client ID gets
  `{"status":400,"message":"invalid client"}` from `/oauth2/device`.
- **Owner step:** create the Twitch app (the chat panel lists the steps), paste
  its Client ID, sign in with the account you stream from.

## Not done

- **Not yet done by a person:** signing in to the studio as the owner (the
  agent does not type passwords; at home use
  https://login.six7.pw/if/flow/six7-sign-in/ once, then t.six7.pw), and a
  real Twitch stream. Use the bandwidth-test option in Settings first.
- Shared login with the hub: done (authentik forward auth, see above).
  `deploy/install.sh` and `push.sh` remain for VPSes whose web server runs
  on the host; they were not used for six7.
- Known limit: timer hotkeys only fire while the studio tab has focus.
