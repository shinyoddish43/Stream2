# Stream Studio on the six7 hub

The hub (`~/six7` on the VPS, source: the `foss` repo) runs Caddy in Docker,
so `deploy/install.sh` finds no Caddy or nginx on the host and leaves the web
side alone. Here the studio runs as a container instead, and the hub's own
login (authentik) guards it.

```
browser ── https://t.six7.pw ──▶ hub Caddy ──forward_auth──▶ authentik (identity:9000)
                                    │
                                    └── studio-edge 10.67.0.0/28 ──▶ studio:8787 ──egress──▶ Twitch
```

- Only the hub Caddy shares `studio-edge` with the studio. The studio believes
  `X-Authentik-Username` only from Caddy's pinned address there, 10.67.0.2
  (`TRUST_PROXY` in `six7.env`), and only for `Oddish` (`AUTH_USERS`).
  Caddy drops any copy a browser sends; its `forward_auth` also replaces the
  header with authentik's answer.
- authentik application `stream-studio` admits group `six7-owner` only. The
  hub's home-network guest (`home-guest`, see the foss repo's
  `scripts/home_network_sign_in.py`) is refused, so going live always takes
  a real sign-in.
- 10.67.x because Docker's usual 172.17–31 ranges brush the VPS uplink
  (gateway 172.31.1.1). Automatic addresses come from the upper half of each
  range (`ip_range`), so nothing can take the proxy's pinned .2.
- Studio data is the Docker volume `streamstudio_data`.
- Log out goes to the outpost's sign-out: it ends the studio session only.
  Away from home your hub session signs you straight back in; to sign out of
  everything use the hub's own log out.

## 1. Hub `compose.yaml`

```yaml
  proxy:
    # ...unchanged...
    networks:
      portal-edge: {}
      identity-edge: {ipv4_address: 10.67.1.2}
      studio-edge: {ipv4_address: 10.67.0.2}
  identity:
    environment: &identity-env
      # ...unchanged...
      AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS: "10.67.1.2/32"
```

and under the top-level `networks:`

```yaml
  identity-edge:
    ipam: {config: [{subnet: 10.67.1.0/28, ip_range: 10.67.1.8/29}]}
  studio-edge:
    internal: true
    ipam: {config: [{subnet: 10.67.0.0/28, ip_range: 10.67.0.8/29}]}
```

The trusted-proxy line matters for the home network sign-in: without it,
authentik believes `X-Forwarded-For` from any private address, so the VPS host
(via `127.0.0.1:9000`) could claim to be at home.

## 2. Hub `deploy/Caddyfile`

```caddyfile
t.six7.pw {
	import security_headers
	route {
		reverse_proxy /outpost.goauthentik.io/* identity:9000
		request_header -X-Authentik-*
		forward_auth identity:9000 {
			uri /outpost.goauthentik.io/auth/caddy
			copy_headers X-Authentik-Username
		}
		reverse_proxy studio:8787
	}
}
```

## 3. Order of work

1. Back up `~/six7/compose.yaml`, `~/six7/deploy/Caddyfile` and the authentik
   database (`pg_dump` in `six7-identity-db-1`).
2. Put the edits from 1 and 2 in the `foss` repo and on the VPS (they must
   match, or the next hub deploy drops the studio). `caddy validate` the
   Caddyfile in a throwaway `caddy:2.11.4-alpine` first.
3. Recreate what changed. `identity-edge` gets a fixed subnet, which an
   existing network cannot take, so it is removed and made again (about a
   minute without the hub's sites and login):
   ```bash
   cd ~/six7 && C="-f compose.yaml -f deploy/staging.compose.yaml"
   docker compose $C stop proxy identity && docker compose $C rm -f proxy identity
   docker network rm six7_identity-edge
   docker compose $C up -d proxy identity identity-worker
   ```
4. authentik, dry run then `-e APPLY=1`:
   `docker exec six7-identity-1 ak shell -c "$(cat deploy/docker/authentik_setup.py)"`.
   The report should list the callback redirect URI.
5. From your computer: `deploy/docker/push.sh vps`.
6. Check: `https://t.six7.pw` sends you to the hub login and back into the
   studio; from outside the home network,
   `curl -H 'X-Forwarded-For: 173.175.148.44' -H 'X-Authentik-Username: Oddish' https://t.six7.pw/api/state`
   is a redirect to the login, never data. Settings → bandwidth test before a
   real stream.

## Undo

`docker compose -p streamstudio down` (the data volume stays), restore the two
hub files and repeat step 3, and run the authentik script with
`-e APPLY=1 -e UNDO=1`.
