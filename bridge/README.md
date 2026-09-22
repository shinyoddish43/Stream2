# LiveSplit bridge

Optional. The studio's own timer needs none of this — the bridge exists for
runners who want **LiveSplit itself** (global hotkeys, autosplitters, their
existing layout) to drive the splits shown on stream.

```
LiveSplit  ──TCP 16834──▶  bridge  ──WebSocket 16835──▶  Stream Studio
   ◀────────────────── split / reset commands ──────────────────
```

Run it on the PC LiveSplit is on, not on your web host.

## 1. Turn on LiveSplit's server

In LiveSplit: right-click → **Control** → **Start Server**. If that entry is
missing, add the *LiveSplit Server* component under Edit Layout → + → Control →
LiveSplit Server.

## 2. Run the bridge

**Python** (nothing to install):

```bash
python3 livesplit_bridge.py
```

**Node** (needs `ws`):

```bash
npm install ws
node livesplit-bridge.js
```

Both print `websocket on ws://127.0.0.1:16835`.

## 3. Connect the studio

Timer dock → **Connect LiveSplit…** → leave the URL at
`ws://127.0.0.1:16835` → **Connect**.

The timer dock switches to "LiveSplit linked" and follows LiveSplit's clock,
phase and split index. The studio's own split/reset buttons forward to
LiveSplit, so either side can drive the run.

## Mixed content

A studio served over **https://** cannot open a plain **ws://** socket — the
browser blocks it outright. Options:

1. Open the studio over `http://localhost/...` on the same PC (allowed).
2. Give the bridge a TLS certificate and connect with `wss://`.
3. Put the bridge behind a local reverse proxy that terminates TLS.

## Options

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--port` / `BRIDGE_PORT` | `16835` | WebSocket port |
| `--bind` / `BIND` | `127.0.0.1` | Interface to listen on |
| `--livesplit-port` / `LIVESPLIT_PORT` | `16834` | LiveSplit Server port |
| `--interval` / `POLL_MS` | ~30 Hz | How often to poll LiveSplit |
| `--allow-remote` / `ALLOW_REMOTE=1` | off | Accept non-loopback clients |

Loopback-only is the default on purpose: anything that can reach this port can
reset your run.

## Raw mode

If you already run a generic TCP-to-WebSocket proxy (websockify and friends),
pick **Raw LiveSplit Server** in the connect dialog instead. The studio then
speaks LiveSplit's line protocol directly and polls at 10 Hz.
