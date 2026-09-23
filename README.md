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
  and attempt history survive the round trip), or type segment names in.
- **Audio mixer** — any audio input (capture-card audio, mic) plus screen audio,
  each with volume, mute and a meter. No processing is applied to anything.
- **Green screen** — on a camera: pick the key colour from the preview, set
  similarity and smoothness, upload a photo or video as the background.
- **Layouts** — as many as you like, saved on the server automatically.
- **Twitch** — stream key kept on the server (never sent back to the browser),
  and a bandwidth-test mode to try everything without going public.

That is the whole feature list, on purpose.

## Put it on your VPS

Needs Ubuntu 22.04+ or Debian 12, and Node 18 or newer (Ubuntu 24.04 and
Debian 12 ship it; on 22.04 install Node from nodejs.org first).

```bash
git clone https://github.com/shinyoddish43/Stream2 && cd Stream2
```

Then pick one:

**A. Your own domain, HTTPS, login** (recommended). Point a DNS record at the
VPS, then:

```bash
sudo ALLOW_IP=<your home IP> bash deploy/install.sh studio.example.com
```

`ALLOW_IP` is optional but worth it: with it, nobody but your home connection
can even reach the login page. Caddy is installed and gets the HTTPS
certificate by itself. Open `https://studio.example.com` from home.

**B. No domain, nothing exposed.** Only reachable through SSH:

```bash
sudo bash deploy/install.sh
```

then from your PC:

```bash
ssh -N -L 8080:127.0.0.1:8080 you@your-vps
```

and open `http://localhost:8080`. (Browsers allow cameras on `localhost`, and on
HTTPS — never on plain `http://` to a remote address.)

Either way the installer asks you to choose the username and password. Change
it later with `sudo -u streamstudio DATA_DIR=/var/lib/streamstudio node /opt/streamstudio/server.js passwd`.

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

1. **Settings** → paste your stream key (Twitch → Creator Dashboard → Settings →
   Stream). Tick **Bandwidth test** for a dry run that never goes public.
2. **+ Video device**, then choose your capture card under **Properties →
   Device**. Leave capture resolution at 1080p unless your card struggles.
3. **+ Audio input** for the capture card's audio (it shows up as its own input,
   e.g. "Game Capture HD60 S+"), and again for your mic.
4. **Timer** → **Import .lss**, or **Edit segments** to type them in.
5. **Start streaming.** The status shows time live and upload rate.

### Green screen

Select the camera → tick **Replace the green with a background** → **Pick from
preview** and click on the green → nudge **Similarity** until the green is gone
and **Smoothness** until the edges look right → **Upload photo or video**.

### Timer hotkeys

Numpad 1 split, 3 reset, 8 undo, 2 skip, 5 pause — change them in Settings.
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
- **Updating.** `git pull && sudo bash deploy/install.sh <same arguments>`. Your
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
| `test/server.test.mjs` | login, lockout, origin checks, storage, the write-only stream key, uploads, path traversal, the relay to ffmpeg |
| `test/twitch.test.mjs` | a real ffmpeg pushes to a local RTMP server standing in for Twitch; checks H.264 + AAC, frame rate, and a keyframe every 2 s (skipped without ffmpeg) |
| `test/browser.test.mjs` | the studio in Chromium: sign in, add a device, key a green screen onto an uploaded background and check the pixels, drag, layouts, timer hotkeys, `.lss` round trip, mixer meters, going live (skipped without Playwright) |
