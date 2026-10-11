# Stream Studio ("Fstream")

A browser stream studio with a built-in speedrun timer that streams to Twitch through the VPS (Node 18+, `ws`, ffmpeg). Live at https://t.six7.pw as the container `streamstudio-studio-1` (`~/streamstudio` on the VPS) behind the six7 hub's sign-in (authentik group `six7-owner` only); the hub dashboard calls it Fstream. Owner and only user: Oddish.

**Source of truth:** `HANDOFF.md` (what is verified, what is not done), `README.md` (features, tests), `deploy/docker/six7-hub.md` (how it sits behind the hub). A repo change is not a deploy.

**Coordination:** follow `~/.claude/templates/AGENT-COORDINATION.md`: repo log `.agents/activity.log`, VPS log `~/agent-activity.log`. Codex once left an abandoned copy in `~/Documents/ChatGPT/stream studio/app`: this repo is the real one.

## Commands
```sh
npm install && node server.js passwd    # first run: set the local password
node server.js                          # local: http://localhost:8080
npm test                                # all suites; Twitch and browser parts skip without ffmpeg / Playwright
deploy/docker/push.sh vps               # deploy to the hub (container on studio-edge)
```
Verify after deploy: https://t.six7.pw redirects to the hub sign-in when signed out, the container is healthy, and its logs show no new errors. Roll back by redeploying the previous commit.

## Layout
`server.js` the server · `public/` the studio page · `test/` node:test suites, `fake-twitch.mjs` · `deploy/` stand-alone installer (host Caddy/nginx) and `docker/` (six7 hub mode).

## Users and UX
- Just the owner. One column: 16:9 preview on the left, controls on the right, Start streaming top right; camera and audio use portable defaults.
- Layouts autosave and merge across browsers; audio inputs belong to the device they were added on.

## Rules
1. The stream key and Twitch tokens never reach the browser, logs or chat. The key lives in the studio's `settings.json` on the VPS: never print it.
2. Chat, title and category changes work only for the Twitch account that owns the saved stream key.
3. The studio trusts `X-Authentik-Username` only from Caddy's pinned 10.67.0.2 and only for Oddish.
4. Hub changes (Caddy, authentik, networks) belong to the six7 repo (shinyoddish43/foss) and its six7-deploy skill.

## Things that are easy to get wrong
- Leaving the studio tab ends a stream; the dashboard opens it in a new window.
- A new studio window needs one click before it can go live (Chrome starts no sound in an unclicked page, and the studio won't stream silence).
- The stream key is saved in `/data/settings.json` (Docker volume `streamstudio_data`), which survives deploys.
- Automated tests use stand-in Twitch servers (`test/fake-twitch.mjs`); timer hotkeys only fire while the studio tab has focus.

## Status
- Deadline: first real stream by 2027-02-01.
- Not done yet (HANDOFF.md): the owner signs in once, the bandwidth test, then a real Twitch stream. The hub's Twitch widget waits for a registered Twitch app.
