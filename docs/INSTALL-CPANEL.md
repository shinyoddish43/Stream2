# Installing on cPanel (or any shared host)

The studio is plain PHP and plain files. There is nothing to compile, no
Composer, no npm, and no database. If you can upload a zip, you can install it.

---

## 1. Upload

**File Manager route**

1. cPanel → **File Manager** → open `public_html`.
2. **+ Folder** → `studio`.
3. Open `studio` → **Upload** → drop the zip of this repository.
4. Right-click the zip → **Extract** → delete the zip.

**Git route** (cPanel → *Git™ Version Control*)

- Clone URL: your fork of this repository
- Repository path: `/home/USER/public_html/studio`

**FTP route** — upload the folder as-is. Make sure hidden files (`.htaccess`)
come along; in FileZilla that is *Server → Force showing hidden files*.

## 2. Permissions

The app needs to write to one directory.

1. In File Manager, select the `data` folder → **Permissions**.
2. Set **0755** (if the installer still says "not writable", use **0775**).

Everything else can stay at 0644 / 0755.

## 3. PHP version

cPanel → **Select PHP Version** → choose **8.0 or newer** (7.4 works).
Make sure these extensions are ticked — they are on by default almost
everywhere:

- `json`
- `xml` / `simplexml` — used to read and write LiveSplit `.lss` files
- `openssl` — optional, used to encrypt stream keys at rest

## 4. HTTPS

Screen capture, cameras and microphones are **only available on HTTPS**
(or `http://localhost`). Turn on AutoSSL:

cPanel → **SSL/TLS Status** → select the domain → **Run AutoSSL**.

Then force HTTPS: cPanel → **Domains** → toggle *Force HTTPS Redirect*.

Without HTTPS the studio still loads, but "Display capture" and "Webcam" will
refuse to start and tell you why.

## 5. Run the installer

Open `https://yourdomain.com/studio/install.php`.

The page checks your environment, then asks for a username and password.
After it succeeds:

> **Delete `install.php`.** It refuses to run twice, but there is no reason to
> leave it on the server.

## 6. First scene

1. Open `https://yourdomain.com/studio/`.
2. **Sources → ＋ → Display / window capture**, pick your game window.
   Tick *share audio* in the browser prompt if you want desktop sound.
3. Drag the corners in the preview to place it, or use ⤢ to fill the canvas.
4. **Splits → Import .lss** to bring in your existing splits.
5. **Start recording** to test, then check the file that downloads.

---

## Optional: the RTMP relay (multistreaming)

The browser cannot speak RTMP, so pushing to Twitch or YouTube needs a small
Node process with `ffmpeg`. Two ways to run it.

### A. cPanel "Setup Node.js App"

Works if your host offers the Application Manager **and** has `ffmpeg`
installed. Ask support if you are not sure — many shared hosts do not.

1. Upload the `relay/` folder to `/home/USER/relay` (outside `public_html`).
2. cPanel → **Setup Node.js App** → **Create Application**:
   - Node version: 16 or newer
   - Application root: `relay`
   - Application URL: `relay.yourdomain.com` (or a subfolder)
   - Application startup file: `server.js`
3. **Environment variables** → add:
   - `RELAY_SECRET` — copy `relay_secret` out of `data/config.json`
   - `FFMPEG_PATH` — full path from `which ffmpeg`, if it is not on `PATH`
4. **Run NPM Install**, then **Start App**.
5. In the studio: **Settings → Server → Relay URL** →
   `wss://relay.yourdomain.com/ingest`

### B. A small VPS or a box at home

```bash
cd relay
npm install
RELAY_SECRET=<relay_secret from data/config.json> PORT=8081 node server.js
```

Put it behind nginx or Caddy with TLS, because a page served over HTTPS cannot
open a plain `ws://` socket. A one-line Caddyfile:

```
relay.example.com {
  reverse_proxy 127.0.0.1:8081
}
```

Then set the relay URL in the studio to `wss://relay.example.com/ingest`, add
destinations under **Destinations**, set **Settings → Output → Mode** to
*Stream via RTMP relay*, and press **Start streaming**.

### Checking it

```bash
curl https://relay.example.com/health
# {"ok":true,"sessions":0,"max":4}
```

---

## Optional: LiveSplit bridge

Only needed if you want LiveSplit itself to drive the timer. See
[`bridge/README.md`](../bridge/README.md). It runs on your gaming PC, not on
the web host.

---

## Troubleshooting

**"not installed - open install.php"**
`data/config.json` is missing or unreadable. Re-check the `data/` permissions.

**"cannot write studio.json - check data/ permissions"**
Set `data/` to 0775. On hosts with PHP-FPM running as a different user, also
check the *owner* of `data/` in File Manager.

**Screen capture button does nothing**
You are on `http://`, not `https://`. See step 4.

**500 error on every API call**
Usually a PHP version below 7.4, or the `xml` extension switched off. Open
`api/index.php?r=health` — it reports the PHP version it is running under.

**The studio loads but the canvas is black**
That is correct with no sources. Add one.

**FPS is low / "skipped" climbs**
Drop to 720p or 480p in Settings → Video, turn on Low power, and hide sources
you are not showing. A browser tab shares one core with the game — the studio
cannot conjure headroom that is not there.

**Stream keys**
They are encrypted in `data/destinations.json` with a key derived from
`data/config.json`. If you ever restore `destinations.json` from a backup
without the matching `config.json`, re-enter your keys.
