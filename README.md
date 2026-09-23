# Stream Studio

A browser-based stream studio with a native speedrun timer. Think Restream's
multistreaming and OBS's layout, in a page that installs by dragging a folder
into cPanel — and a LiveSplit-compatible timer built into the compositor
rather than bolted on as a browser source.

```
┌───────────────────────────────────────────────┬──────────────┐
│                                               │  Speedrun    │
│                 Program                       │  timer       │
│              (canvas 1280×720)                │  splits      │
│                                               │  deltas      │
├──────────┬────────────┬──────────┬────────────┤  clock       │
│ Scenes   │ Sources    │ Mixer    │ Transitions│  SoB / BPT   │
└──────────┴────────────┴──────────┴────────────┴──────────────┘
```

## What it does

- **OBS-shaped UI** — scenes, a source list with drag-to-reorder, an audio
  mixer with live meters, transitions, studio mode with preview/program, and a
  one-click starter layout for speedrunning (starting-soon countdown, run,
  break, ending).
- **Native speedrun timer** — reads and writes real LiveSplit `.lss` files,
  keeps golds, comparisons and attempt counts, and uses LiveSplit's delta
  colour rules. It draws straight into the canvas as a source, so there is no
  second page being rendered just to show your splits.
- **Optional LiveSplit link** — if you want LiveSplit itself (global hotkeys,
  autosplitters) to drive the timer, a small bridge script relays its Server
  component to the studio.
- **Three honest outputs** — record to disk, push over WHIP (WebRTC), or fan
  one stream out to Twitch / YouTube / Kick at once through the relay.
- **Runs on old hardware** — Canvas2D compositor, capped frame rate, metering
  at 15 Hz, an explicit low-power mode, no build step, no framework, no fonts
  to download. The whole front end is about 120 KB of plain files.
- **Installs on shared hosting** — PHP 7.4+, flat JSON files, no database.
  Upload, open `install.php`, done.

## Try it without installing anything

```bash
deploy/build-demo.sh          # -> dist-demo/, a static copy with no server
```

Open `dist-demo/index.html` from any web server (or let
`.github/workflows/demo-pages.yml` publish it to GitHub Pages). The demo is the
real studio with the API served from the browser instead: scenes, sources, the
compositor, the timer and the overlays all work and are kept in localStorage.
Stream keys and multistreaming are not in it — a static page has nowhere safe
to keep a key.

## Requirements

| Piece | Needs |
| --- | --- |
| Studio (required) | PHP 7.4+ with `json`, `xml`; a writable `data/` directory |
| Browser | Chrome/Edge 94+, Firefox 100+, or Safari 16+. **HTTPS is required** for screen and camera capture (except on `localhost`) |
| Relay (optional) | Node 16+ and `ffmpeg`, on a host that allows long-running processes |
| LiveSplit bridge (optional) | Node 16+ or Python 3.8+, on the PC running LiveSplit |

The studio works with none of the optional pieces: you can record locally and
run the built-in timer with nothing but PHP.

## Install

See **[docs/INSTALL-CPANEL.md](docs/INSTALL-CPANEL.md)** for the click-by-click
version, and **[docs/QUICKSTART-SPEEDRUN.md](docs/QUICKSTART-SPEEDRUN.md)** for
going from an empty studio to streaming a run in ten minutes. The short form:

1. Upload the repository into `public_html/studio/` (or wherever you like).
2. Make `data/` writable — 0755 is usually enough, 0775 on some hosts.
3. Visit `https://yoursite/studio/install.php`, create the owner account.
4. Delete `install.php`.
5. Open `health.php` — it checks the things that are easy to get wrong on a
   live host, including whether the server is handing out your `data/`
   directory.
6. Open `index.php` and add a display capture.

Deploying to a real host, updating it, and the pre-flight checklist are in
**[docs/GO-LIVE.md](docs/GO-LIVE.md)**: a zip for File Manager, cPanel's Git
Version Control (there is a `.cpanel.yml` in the repository), `deploy/deploy.sh`
for rsync over SSH, or a manual GitHub Actions workflow that deploys over FTPS
or SSH and then calls `health.php` to confirm it worked. Every route excludes
`data/`, so an update never overwrites your scenes, splits or stream keys.

## The speedrun timer

Import the splits you already have: **Splits → Import .lss**. Everything
LiveSplit stores comes across — personal best splits, gold segments, extra
comparisons, the attempt count. Finishing a run updates the PB; resetting keeps
any golds you set. Export at any time and the file opens in LiveSplit.

Colour rules match LiveSplit exactly:

| Colour | Meaning |
| --- | --- |
| Bright green | Ahead of comparison, gaining time |
| Dark green | Ahead, but losing time on this segment |
| Red | Behind, losing time |
| Orange | Behind, but gaining |
| Gold | New best segment |

Hotkeys (Numpad 1/3/8/2/5 by default) work while the studio tab has focus.
Browsers cannot capture keys behind a full-screen game — that is a platform
limit, not an oversight. Two ways around it:

- Pop the timer out into its own small window (⧉ in the timer dock) and keep
  it on top.
- Run LiveSplit as usual and connect the bridge (see `bridge/README.md`); then
  LiveSplit's global hotkeys drive both.

## Outputs

| Mode | What happens | Needs |
| --- | --- | --- |
| **Record** | `MediaRecorder` writes a `.webm`/`.mp4` to your computer when you stop | nothing |
| **WHIP** | One WebRTC stream to a WHIP ingest endpoint | a WHIP host |
| **Relay** | WebM chunks over WebSocket → `ffmpeg` → every enabled RTMP destination | `relay/` on a Node host |

If the relay connection drops mid-broadcast the studio does not go offline: it
rebuilds the session — fresh ticket, socket and encoder — with a backoff, and
says so in the status bar. It gives up after eight tries.

Stream keys are encrypted at rest in `data/destinations.json` and never sent
back to the browser. When you go live, the studio asks PHP for a 120-second
HMAC ticket that carries the destination URLs; the relay verifies the ticket
and never stores anything.

## Performance notes

The studio is written for the machine you have, not the one you wish you had.

- 720p30 is the default because it is what a dual-core laptop can actually
  sustain while a game is running. 1080p60 is available and will disappoint you.
- Every *visible* source costs one blit per frame. Hidden sources cost nothing.
- Low-power mode halves the frame rate and turns off image smoothing.
- The preview canvas in studio mode renders at half the program rate.
- Audio metering is a single 15 Hz poll for all strips, not a loop per strip.
- The timer dock stops updating entirely when no run is going.
- A background tab is throttled by the browser; the compositor falls back to a
  timer-driven loop so the stream keeps producing frames, but keep the tab
  visible if you can.

## Layout

```
index.php            studio shell            api/index.php     one-file JSON API
health.php           post-deploy self-check  deploy/           deploy + demo build scripts
login.php            sign in                 lib/             Store, Auth, Lss
install.php          setup wizard            assets/js/core/  state, compositor, audio, output, sources
overlay/timer.html   browser source for OBS  assets/js/timer/ timer engine, .lss, bridge client, hotkeys
relay/               WebSocket → RTMP fanout assets/js/ui/    docks, dialogs, modals
bridge/              LiveSplit Server → WS   data/            your scenes, splits and keys (git-ignored)
```

## Security

- Passwords are hashed with `password_hash` (bcrypt); login attempts are
  throttled per IP with an exponential backoff.
- Every mutating request needs a session **and** a CSRF token.
- Overlay pages authenticate with a rotatable token so OBS can read the timer
  without holding a login.
- `data/` ships with an `.htaccess` deny and an empty `index.html`; the
  installer writes them again in case the upload dropped dotfiles. On nginx,
  where `.htaccess` means nothing, copy `config.sample.php` to `config.php` and
  point `STUDIO_DATA_DIR` outside the web root.
- `install.php` refuses to run once a config exists, so a forgotten copy cannot
  be used to mint a second owner account.
- Destination URLs are validated as plain `rtmp://` / `rtmps://` addresses on
  the server before they are ever handed to `ffmpeg`.
- The relay accepts only signed, short-lived tickets and validates every RTMP
  URL before handing it to `ffmpeg`.

## Licence

MIT.

## Tests

```bash
tests/run.sh
```

369 assertions across ten suites, no dependencies beyond PHP and (optionally)
Node:

| Suite | Covers |
| --- | --- |
| `tests/store.test.mjs` | the scene and source bookkeeping: add, remove, duplicate, layer order, and every drag-to-reorder case |
| `tests/timer.test.mjs` | the timer engine: splits, undo/skip, deltas, all five LiveSplit colour rules, golds, PB folding, sum of best, best possible, offsets, external control |
| `tests/php.test.php` | `.lss` parsing and writing (including an XXE attempt), the flat-file store, stream-key encryption, password hashing |
| `tests/api.test.sh` | every API route against a real PHP server in a throwaway copy: auth, CSRF, throttling, overlay tokens, splits import/export, key masking, relay-ticket signatures verified independently, the health check, and that a long poll never blocks the studio |
| `tests/relay.test.mjs` | the relay against a stub ffmpeg: ticket signatures, expiry, non-RTMP and shell-injection targets, that the bytes reach the encoder's stdin unmangled and in order, the session cap, and cleanup on disconnect |
| `tests/bridge.test.mjs` | both LiveSplit bridges against a fake LiveSplit Server: the hand-written WebSocket handshake and frame decoding, state push, command mapping, and that junk input cannot kill either one |
| `tests/browser.test.mjs` | the studio in headless Chromium: compositing, cropping, idle-frame skipping, the timer, every dialog, drag-to-move, scenes, studio mode, the starter layout, persistence across a reload, every overlay mode and what a token does — and fails on any console error |

| `tests/demo.test.mjs` | builds the static demo and drives it: boots with no server, paints, runs the timer, remembers scenes across a reload, every dialog opens, and the parts that need a server say so |
| `tests/whip.test.mjs` | the WHIP output against a stub ingest: the offer is POSTed as `application/sdp` with the bearer token and gathered ICE candidates, and a refused or unusable answer leaves the studio offline with a reason |
| `tests/stream.test.mjs` | the whole streaming path with ffmpeg stubbed: the studio encodes its canvas, PHP mints the ticket, the relay verifies it, and real WebM lands on the encoder's stdin with the stream key applied — then the relay is killed mid-broadcast and the studio has to get itself back on air |

The browser and streaming suites skip themselves when Playwright is absent, so the project stays
installable without npm. Point it at an existing install with
`PLAYWRIGHT_PATH=/path/to/playwright/index.mjs`.
