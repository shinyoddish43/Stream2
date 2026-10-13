# Stream Studio

A barebones stream studio that runs in your browser. Plug in a capture card or
webcam, arrange it in an OBS-style layout with a built-in speedrun timer, mix
your audio, and stream to Twitch — through a small server on your own VPS.

```
 your PC, in the browser                       your VPS                      Twitch
┌─────────────────────────────────┐        ┌──────────────────────┐
│ HDMI/USB capture, webcam, screen │        │ server.js (login)    │
│ mic / capture-card audio         │──wss──▶│   └─ ffmpeg ─────────│──RTMP──▶ live
│ timer, green screen, mixer       │  WebM  │ layouts, splits, key │
└─────────────────────────────────┘        └──────────────────────┘
```

The browser does the compositing (your devices are plugged into your PC, not
the VPS). The VPS keeps you logged in, stores your layouts and splits, and
turns what the browser sends into the H.264/AAC stream Twitch wants.

## What it does

- **Sources** — any video device the browser can see (USB webcams, HDMI capture
  cards such as Elgato or AVerMedia), a screen/window share, and the timer. Drag
  to move, drag corners to resize.
- **Speedrun timer** — split, undo, skip, pause, reset; deltas against your PB in
  LiveSplit's colours; golds; sum of best. Drawn straight into the stream.
- **Splits** — import and export LiveSplit `.lss` files (PB, golds, attempt count
  and attempt history survive the round trip), or type segment names in. Undoing
  an accidental finish restores the previous PB while keeping earned golds.
  Split edits and records save independently of layouts; failed saves retry and
  keep a browser draft across reloads. A conflict with another browser keeps your
  local version available to export and asks which version to save.
- **Audio mixer** — any audio input (capture-card audio, mic) plus screen audio,
  each with volume, mute and a meter. Microphones use echo cancellation by
  default; choose **Raw audio / capture card** for an unprocessed input.
- **Media player** — upload audio (or play audio from MP4/WebM), or search the
  LibriVox public-domain audiobook collection on Internet Archive. Queue,
  chapter navigation, seek, repeat, stream volume/mute and separate speaker
  volume. Uploads and the queue save with your studio; playback position stays
  on this browser, and reloading always leaves playback paused.
- **Green screen** — select a camera, toggle the key, choose its colour, and
  upload a photo or video as the background. Camera and keying settings have
  permanent defaults.
- **Workspaces** — create, duplicate, rename, delete, and switch layouts from
  the top-left menu. Edits save automatically to the server across browsers
  and devices. Offline edits retry when you reconnect; conflicting edits keep
  both layouts, with a recovered copy of your changes.
- **Twitch** — stream key kept on the server (never sent back to the browser),
  and a bandwidth-test mode to try everything without going public.

That is the whole feature list, on purpose.

## Put it on your VPS

Needs Ubuntu 22.04+ or Debian 12, and Node 18 or newer (Ubuntu 24.04 and
Debian 12 ship it; on 22.04 install Node from nodejs.org first). Point the
domain's DNS at the VPS before you start.

**From your own computer**, if you can already `ssh` into the VPS, one command
copies the app up and installs it:

```bash
deploy/push.sh vps t.example.com                    # vps = your ssh host or alias
ALLOW_IP=<your home IP> deploy/push.sh vps t.example.com
```

**If the VPS's web server runs in Docker** (like the six7 hub), the installer
leaves it alone. Run the studio as a container beside it instead, signed in
through the hub's login: see [deploy/docker/six7-hub.md](deploy/docker/six7-hub.md),
then `deploy/docker/push.sh vps`.

**Or on the VPS itself:**

```bash
git clone https://github.com/shinyoddish43/Stream2 && cd Stream2
sudo bash deploy/install.sh t.example.com
```

`ALLOW_IP` is optional but worth it: with it, only your home connection can even
reach the login page. (If your home IP changes now and then, rerun with the new
one.) The first run asks you to choose the studio's username and password.

**It shares the server politely.** If Caddy or nginx already runs other sites
on the VPS, the installer adds `t.example.com` as one more site, checks the
combined configuration with the web server itself, and puts everything back
if that check fails — your other sites are never replaced. With nginx it also
gets the HTTPS certificate through certbot; Caddy does that on its own. With
no web server yet, it installs Caddy. With some other web server it leaves it
alone and tells you what to proxy. The app listens on `127.0.0.1:8787`; set
`PORT=` if that is taken.

**No domain, nothing exposed:** `sudo bash deploy/install.sh` with no domain,
then from your PC `ssh -N -L 8787:127.0.0.1:8787 you@your-vps` and open
`http://localhost:8787`. (Browsers allow cameras on `localhost` and on HTTPS —
never on plain `http://` to a remote address.)

Change the password later with
`sudo -u streamstudio DATA_DIR=/var/lib/streamstudio node /opt/streamstudio/server.js passwd`.

### What protects it

- The app listens on `127.0.0.1` only; the world reaches it through Caddy or
  your SSH tunnel.
- A login with a scrypt-hashed password; five wrong tries from one address and
  it locks that address out, doubling each time.
- Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS;
  every change and the stream socket must come from the studio's own origin.
- A strict Content-Security-Policy; the systemd unit can write to its data
  directory and nothing else.
- Your stream key sits in `/var/lib/streamstudio/settings.json` (mode 600) and is
  masked in every log and error message.

## First stream

1. Open the workspace menu at the top left → **Twitch stream key** → paste
   your key (Twitch → Creator Dashboard → Settings → Stream) → **Save**.
   **Output settings** in the same menu has **Bandwidth test** for a dry run
   that never goes public. Twitch uses the global ingest server by default.
2. **+ Video device** adds the next available camera or capture card with
   automatic settings. Select its source to move or resize it in the preview.
3. **+ Audio input** for the capture card's audio (it shows up as its own input,
   e.g. "Game Capture HD60 S+"), and again for your mic.
4. **LiveSplit** → **Import** for a `.lss` file, or **Edit** to type segments in.
   Select **Timer** in Sources to make it visible and bring it to the front.
5. **Start streaming.** The status shows time live and upload rate.

### Background media and audiobooks

Use **Media player → Upload** for MP3, M4A/M4B, OGG/Opus, WAV, FLAC, AAC,
MP4 or WebM (browser codec support applies; the default upload limit is 200 MB,
configurable with `MAX_UPLOAD_MB`). Video files play their audio only. Use
**Audiobooks** to search LibriVox by title or author, then **Add book** to queue
its chapters and **Play** to begin. Chapters advance automatically. Removing a
track removes it from the queue; unreferenced uploads are cleaned up after the
existing one-hour grace period.

The **Media player** channel in the existing mixer controls the audio sent to
the stream. **Speakers on/off** and **Speaker volume** separately control what
you hear on the device's current default output. Stream mute does not mute the
speakers, and turning speakers off does not mute the stream. Microphones are
never monitored back to the speakers. Avoid including this studio's playback
in a screen/system-audio capture as that would send a second copy to the stream.

Each audio input has a protection selector:

- **Mic: echo cancellation** enables browser echo cancellation and noise
  suppression, without automatic gain. Speaker monitoring passes through a
  local WebRTC connection so the echo canceller receives the media reference;
  it has no signaling/STUN service or remote peer. This reduces speaker pickup
  while you talk, but effectiveness depends on your browser, device and room.
- **Mic: mute during speaker playback** temporarily closes that input while
  media plays on speakers, including a short tail after stopping. Your voice
  is also muted during that time. It preserves your manual mute and volume.
- **Raw audio / capture card** disables processing. Use this for capture cards
  or a microphone with headphones when echo cancellation is not wanted.

The catalog uses Internet Archive's [search](https://archive.org/advancedsearch.php)
and [metadata](https://archive.org/developers/md-read.html) APIs, restricted to
`librivoxaudio`. Chapters stream through the authenticated studio server with
byte-range seeking. No API key is needed. Library outages show a retryable
error; uploaded files remain usable. [LibriVox recordings](https://librivox.org/)
are public domain in the US; status can vary elsewhere.

### Green screen

Select the camera in Sources → enable **Green screen** → choose the key colour
with the colour selector → **Upload** a photo or video background.

### Timer hotkeys

Numpad 1 split, 3 reset, 8 undo, 2 skip, 5 pause. Change them using the
**Timer hotkeys** button beside LiveSplit. Backspace or Delete clears a binding.
They work while the studio tab has focus, which is fine for console games
through a capture card. A browser cannot catch keys while another program has
focus.

## Good to know

- **Upload speed.** Your PC uploads about 1.25× the bitrate you set (the server
  re-encodes, and a cleaner input survives that better). 4500 kbps on Twitch
  needs roughly 6 Mbps of upload.
- **VPS size.** Re-encoding 720p30 at x264 `veryfast` wants roughly one modern
  CPU core, 1080p60 several. On a small VPS add `Environment=X264_PRESET=superfast`
  to the service, or `Environment=VIDEO_MODE=copy` to pass the browser's H.264
  straight through with no encoding at all. Copy mode only helps when the browser
  records H.264 (Chrome and Edge usually do); if it sends VP8 the server re-encodes
  anyway. The browser is asked for a keyframe every 2 s either way.
- **Browser.** Chrome or Edge. Give the studio its own window. It keeps drawing
  frames when the window is in the background, and if the machine cannot keep up
  the frame rate drops rather than the stream stalling.
- **Updating.** Run `deploy/push.sh` (or `install.sh`) again with the same arguments. Your
  login, layouts, splits, key and backgrounds live in `/var/lib/streamstudio` and
  are left alone. Back up that directory.
- **Logs.** `journalctl -u streamstudio -f`

## Running it locally

```bash
npm install
node server.js passwd
node server.js            # http://localhost:8080
```

## Tests

```bash
npm test
```

| | |
| --- | --- |
| `test/timer.test.mjs` | splits, PB, golds, undo/skip/reset, delta colours, time formats |
| `test/splits-store.test.mjs` | durable drafts, failed-save retry, queued edits, finish undo during a save, revision conflicts and recovery across reloads |
| `test/server.test.mjs` | login, lockout, origin checks, storage, the write-only stream key, uploads, path traversal, the relay to ffmpeg |
| `test/sso.test.mjs` | single sign-on: the user a trusted proxy names is signed in (pages, API, stream socket), others and other addresses are not, log out goes back through the hub, the password login still works |
| `test/install.test.mjs` | the installer against real Caddy and nginx in scratch folders: another site already on the server is kept, a clash or a broken config is rolled back without a reload, reruns are idempotent, IPv6 only where the kernel has it; `push.sh`'s remote command, quoting included; and `deploy/docker/push.sh` shipping the working tree without touching your git index |
| `test/twitch.test.mjs` | a real ffmpeg pushes to a local RTMP server standing in for Twitch; checks H.264 + AAC, frame rate, and a keyframe every 2 s (skipped without ffmpeg) |
| `test/audiobooks.test.mjs` | catalog restrictions, chapter order, caching and retries, redirect safety, streaming byte ranges, audio uploads and queue storage |
| `test/media-browser.test.mjs` | real audio signal in stream and speakers, independent levels, microphone modes, pause/seek/queue/repeat, saved media, catalog UI and responsive layout |
| `test/browser.test.mjs` | the studio in Chromium: sign in, green-screen pixels, dragging, compact menus, timer ordering and hotkeys, `.lss` round trip, mixer meters, going live, mobile overflow, and workspace saves across navigation, offline reconnect, and conflicting browser edits (skipped without Playwright) |

Set `PLAYWRIGHT_PATH` to an installed Playwright module when it is outside this
project and `CHROMIUM_PATH` to your Chromium executable. For example:

```bash
PLAYWRIGHT_PATH=/path/to/playwright/index.mjs CHROMIUM_PATH=/usr/bin/chromium npm test
```
