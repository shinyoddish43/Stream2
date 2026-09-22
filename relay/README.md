# Stream Studio relay

Takes WebM chunks from the studio over a WebSocket and pipes them into one
`ffmpeg` per destination, so a single upload reaches Twitch, YouTube, Kick and
anything else that speaks RTMP at the same time.

```
browser ──WebSocket──▶ relay ──┬── ffmpeg ──▶ rtmp://live.twitch.tv/app/KEY
   (WebM/VP8+Opus)             ├── ffmpeg ──▶ rtmp://a.rtmp.youtube.com/live2/KEY
                               └── ffmpeg ──▶ rtmps://…kick…/app/KEY
```

## Run it

```bash
npm install
RELAY_SECRET=<relay_secret from data/config.json> node server.js
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_SECRET` | — | **Required.** Must match `relay_secret` in `data/config.json` |
| `PORT` | `8081` | Listen port |
| `WS_PATH` | `/ingest` | WebSocket path |
| `FFMPEG_PATH` | `ffmpeg` | Full path if ffmpeg is not on `PATH` |
| `MAX_SESSIONS` | `4` | Concurrent streams allowed |
| `X264_PRESET` | `veryfast` | Use `ultrafast` on a very small box |

`GET /health` returns `{"ok":true,"sessions":N,"max":M}`.

## Security model

The relay holds no accounts, no keys and no database. Every session starts with
a ticket the studio's PHP minted:

```
base64url({iss,user,exp,targets:[{name,url}]}) + "." + base64url(HMAC-SHA256(body, RELAY_SECRET))
```

The relay rejects a ticket that is expired (120 s), unsigned, wrongly signed,
or carries a URL that is not a plain `rtmp://` / `rtmps://` address. Stream keys
travel inside the ticket only, over TLS, and are never written to disk.

## Sizing

One 720p30 transcode at `veryfast` is roughly one modern core per destination.
Two destinations on a 1-core VPS will drop frames. If you are tight:

- set `X264_PRESET=ultrafast`
- lower the studio's bitrate and resolution
- stream to one service and let that service restream

## Why transcode at all?

The browser produces VP8/VP9 in a WebM container; RTMP wants H.264 in FLV.
There is no way around a transcode today. It is also the point where a single
`ffmpeg` per destination buys you isolation: if YouTube's ingest stalls, Twitch
keeps going.
