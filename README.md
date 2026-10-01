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
  to move, drag corners to resize. Devices open at the best they offer up to
  1080p60; there are no per-device settings. Clicking the timer in the list
  brings it to the front.
- **Speedrun timer** — split, undo, skip, pause, reset; deltas against your PB in
  LiveSplit's colours; golds; sum of best. Drawn straight into the stream.
- **Splits** — import and export LiveSplit `.lss` files (PB, golds, attempt count
  and attempt history survive the round trip), or type segment names in.
- **Audio mixer** — any audio input (capture-card audio, mic) plus screen audio,
  each with volume (up to 4×), mute and a meter (in dB; it keeps moving while
  muted, so you can see an input is alive). No processing is applied to
  anything. A new studio starts with the **default microphone**, which means
  the default mic of whichever computer the studio is open on; a mic saved on
  another computer offers **Use default mic**. When an input cannot be opened
  the mixer says why (not on this device, blocked for this site, in use).
- **Green screen** — on a camera: on/off, the key colour (the browser's colour
  picker has an eyedropper), and a photo or video as the background. The keying
  strength is fixed.
- **Layouts** — as many as you like, in the menu at the top right, left of
  **Start streaming** (new, duplicate, rename, delete; also the stream key and
  log out). Saved automatically on the server, so the same
  layouts open in any browser on any device: each change is kept in the browser
  at once, sent within a second and retried every few seconds until the server
  has it; open pages pick up changes made elsewhere; a page that fell behind
  merges instead of overwriting newer work; changes that never reached the
  server (network or sign-in dropped, page closed) are sent on the next visit.
- **Twitch** — 1280×720 at 30 fps and 4500 kbps to Twitch's global ingest
  (`ingest.global-contribute.live-video.net`); there are no settings. The
  stream key is asked for once and kept on the server (never sent back to the
  browser); signed in with Twitch (see Chat), the studio takes it from Twitch
  and saves it, so it is never asked for at all, and a key reset on Twitch is
  picked up when the next stream starts. **Start streaming** asks for the
  stream title and category first (the category field searches Twitch as you
  type and offers the three used most recently, as on the six7 hub), sets them
  on Twitch, then goes live. A hub's **Go live** skips that: the hub has its
  own title and category.

- **Chat** — the Twitch chat of the account you stream from, under the audio
  mixer, with Twitch's badges and its global emotes (a channel's own emotes,
  and BTTV/7TV ones, show as their names), and a box to write in it. Moderators'
  deletions and timeouts take messages away as they do on Twitch. It needs a
  Twitch app of your own once (the chat panel says how: a Client ID from
  dev.twitch.tv, client type Public) and a sign-in with Twitch (a code on
  twitch.tv/activate). The chat shows only when the signed-in account is the
  stream key's; messages go out through the Twitch API as that account, and
  the sign-in stays on the server like the stream key.

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

1. Layout menu (top right) → **Twitch stream key** → paste it (Twitch → Creator
   Dashboard → Settings → Stream) → **Save**.
2. **+ Video** and pick your capture card from the list.
3. **+ Input** for the capture card's audio (it shows up as its own input,
   e.g. "Game Capture HD60 S+"). The default mic is already there.
4. Timer → **Import** an `.lss`, or **Edit** to type segments in.
5. **Start streaming.** The status shows time live and upload rate.

### Green screen

Select the camera → tick **On** → set the colour to your screen's green (open
the colour box and use its eyedropper on the preview) → **Upload background**.

### Timer hotkeys

Numpad 1 split, 3 reset, 8 undo, 2 skip, 5 pause — change them with the ⌨
button under the timer.
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
| `test/server.test.mjs` | login, lockout, origin checks, storage and layout revisions, the global ingest, the write-only stream key, uploads, path traversal, the relay to ffmpeg |
| `test/sso.test.mjs` | single sign-on: the user a trusted proxy names is signed in (pages, API, stream socket), others and other addresses are not, log out goes back through the hub, the password login still works |
| `test/install.test.mjs` | the installer against real Caddy and nginx in scratch folders: another site already on the server is kept, a clash or a broken config is rolled back without a reload, reruns are idempotent, IPv6 only where the kernel has it; `push.sh`'s remote command, quoting included; and `deploy/docker/push.sh` shipping the working tree without touching your git index |
| `test/twitch.test.mjs` | a real ffmpeg pushes to a local RTMP server standing in for Twitch; checks H.264 + AAC, frame rate, and a keyframe every 2 s (skipped without ffmpeg) |
| `test/chat.test.mjs` | Twitch chat: IRC lines, emote positions, readable name colours, the connection (join signed out, PING, moderators, RECONNECT, retry, a channel Twitch does not have) against a stand-in chat server; and on the server, against a stand-in Twitch (`test/fake-twitch.mjs`): the app's Client ID and secret, the device code sign-in, tokens never leaving the server, sending only as the stream key's account, dropped messages, token renewal, sign-out, the hourly check, global emotes and badges |
| `test/golive.test.mjs` | the stream key from Twitch (saved at sign-in, kept across restarts, a reset on Twitch followed, another account's key never swapped in silently), and the title and category: what Twitch has, category search, the change made only on the account the key streams to |
| `test/browser.test.mjs` | the studio in Chromium: the one-column layout, the default mic (meter while muted, a mic from another computer, a blocked mic), sign in, add a device, key a green screen onto an uploaded background and check the pixels, drag, the layout menu, layouts shared with a second browser (live updates, a stale save merged), unsaved changes restored, timer hotkeys, `.lss` round trip, mixer meters, the stream key popup and going live, the chat (set up, sign in, badges and emotes, moderators, a busy chat, writing in it, another account's key, sign-out), Start streaming's title and category picker, going live without being asked for a saved key, and a hub's Go live (skipped without Playwright) |
