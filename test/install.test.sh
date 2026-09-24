#!/usr/bin/env bash
# shellcheck disable=SC2034  # DOMAIN, PORT and ALLOW_IP are read by the sourced functions
# deploy/install.sh's web-server step, against real Caddy and nginx binaries,
# in throwaway directories. The point: adding the studio to a server that
# already hosts another site must never break or replace that site.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT
export CADDY_DIR="$WORK/caddy" NGINX_DIR="$WORK/nginx"
# shellcheck source=/dev/null
source "$ROOT/deploy/install.sh"      # defines the functions; runs nothing
systemctl() { echo "[systemctl $*]"; }
say() { :; }
set +e
PASS=0; FAIL=0
check() { if eval "$2"; then PASS=$((PASS + 1)); echo "ok   - $1"; else FAIL=$((FAIL + 1)); echo "FAIL - $1"; fi; }
DOMAIN=t.six7.pw PORT=8787 ALLOW_IP=""

if command -v caddy >/dev/null; then
  C="$CADDY_DIR/Caddyfile"
  valid() { caddy validate --config "$C" --adapter caddyfile >/dev/null 2>&1; }
  adapted() { caddy adapt --config "$C" --adapter caddyfile 2>/dev/null; }

  mkdir -p "$CADDY_DIR"
  printf 'six7.pw, hub.six7.pw {\n\treverse_proxy 127.0.0.1:3000\n}\n' > "$C"
  cp "$C" "$WORK/hub-caddy"
  ( setup_caddy no ) > "$WORK/c1" 2>&1
  check "caddy: the existing site is kept" "grep -q 'reverse_proxy 127.0.0.1:3000' '$C'"
  check "caddy: the studio is added as an import" "grep -qx 'import $CADDY_DIR/streamstudio.caddy' '$C'"
  check "caddy: the original is backed up" "cmp -s '$WORK/hub-caddy' $CADDY_DIR/Caddyfile.before-streamstudio.*"
  check "caddy: the combined config validates" valid
  check "caddy: both sites are routed" "adapted | grep -q '\"hub.six7.pw\"' && adapted | grep -q '\"t.six7.pw\"'"
  check "caddy: the studio proxies to its port" "adapted | grep -q '127.0.0.1:8787'"
  ( setup_caddy no ) > "$WORK/c2" 2>&1
  check "caddy: a rerun does not import twice" "[ \$(grep -cx 'import $CADDY_DIR/streamstudio.caddy' '$C') = 1 ]"
  ALLOW_IP=203.0.113.7; ( setup_caddy no ) > "$WORK/c3" 2>&1; ALLOW_IP=""
  check "caddy: ALLOW_IP gives a valid allowlist" "valid && adapted | grep -q '203.0.113.7'"

  rm -rf "$CADDY_DIR"; mkdir -p "$CADDY_DIR"
  printf 't.six7.pw {\n\trespond "already taken"\n}\n' > "$C"
  cp "$C" "$WORK/taken-caddy"
  ( setup_caddy no ) > "$WORK/c4" 2>&1
  check "caddy: a clash is refused" "grep -q 'put back as it was' '$WORK/c4'"
  check "caddy: and the original is restored exactly" "cmp -s '$WORK/taken-caddy' '$C'"
  check "caddy: and nothing is reloaded" "! grep -q 'reload caddy' '$WORK/c4'"
  check "caddy: and the studio's site file is gone" "[ ! -e '$CADDY_DIR/streamstudio.caddy' ]"

  rm -rf "$CADDY_DIR"; mkdir -p "$CADDY_DIR"
  printf ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n' > "$C"
  ( setup_caddy yes ) > "$WORK/c5" 2>&1
  check "caddy: a fresh install replaces only the placeholder page" "[ \"\$(cat '$C')\" = 'import $CADDY_DIR/streamstudio.caddy' ] && [ -f '$C.orig' ] && valid"
else
  echo "skip - caddy is not installed"
fi

if command -v nginx >/dev/null; then
  N="$NGINX_DIR/nginx.conf"
  mkdir -p "$NGINX_DIR/sites-available" "$NGINX_DIR/sites-enabled" "$WORK/bin" "$WORK/nginx-tmp"
  # A stand-in hub, plus an existing Upgrade map of its own, as many setups have.
  cat > "$N" <<CONF
pid $WORK/nginx.pid;
error_log $WORK/error.log;
events {}
http {
    access_log off;
    # Scratch temp paths: as an ordinary user (CI) nginx -t cannot create the
    # packaged ones under /var/lib/nginx, and fails before judging the site.
    client_body_temp_path $WORK/nginx-tmp/body;
    proxy_temp_path $WORK/nginx-tmp/proxy;
    fastcgi_temp_path $WORK/nginx-tmp/fastcgi;
    uwsgi_temp_path $WORK/nginx-tmp/uwsgi;
    scgi_temp_path $WORK/nginx-tmp/scgi;
    map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
    server { listen 127.0.0.1:18080; server_name hub.six7.pw; location / { return 200 'hub'; } }
    include $NGINX_DIR/sites-enabled/*;
}
CONF
  cp "$N" "$WORK/hub-nginx"
  printf '#!/bin/sh\necho "certbot $*" >> %s\n' "$WORK/certbot.log" > "$WORK/bin/certbot"
  chmod +x "$WORK/bin/certbot"
  PATH="$WORK/bin:$PATH"
  ntest() { nginx -t -c "$N" >/dev/null 2>&1; }

  ( setup_nginx ) > "$WORK/n1" 2>&1
  # When nginx refuses the site, its reason is the useful part of a failure.
  [ -L "$NGINX_DIR/sites-enabled/streamstudio.conf" ] || sed 's/^/    setup_nginx: /' "$WORK/n1"
  check "nginx: the existing config is untouched" "cmp -s '$WORK/hub-nginx' '$N'"
  check "nginx: the site is added and enabled" "[ -L '$NGINX_DIR/sites-enabled/streamstudio.conf' ]"
  check "nginx: IPv6 is listened on only where the kernel has it" "if [ -e /proc/net/if_inet6 ]; then grep -q 'listen \[::\]:80' '$NGINX_DIR/sites-available/streamstudio.conf'; else ! grep -q '\[::\]' '$NGINX_DIR/sites-available/streamstudio.conf'; fi"
  check "nginx: the result passes nginx -t" ntest
  check "nginx: it proxies to the studio's port with WebSocket upgrades" "grep -q 'proxy_pass http://127.0.0.1:8787' '$NGINX_DIR/sites-available/streamstudio.conf' && grep -q 'Upgrade' '$NGINX_DIR/sites-available/streamstudio.conf'"
  check "nginx: a certificate is requested for the domain" "grep -q -- '--nginx -d t.six7.pw' '$WORK/certbot.log'"
  ( setup_nginx ) > "$WORK/n2" 2>&1
  check "nginx: a rerun still passes" ntest
  ALLOW_IP=203.0.113.7; ( setup_nginx ) > "$WORK/n3" 2>&1; ALLOW_IP=""
  check "nginx: ALLOW_IP is applied inside location, leaving room for the certificate check" "ntest && awk '/location \\//,/}/' '$NGINX_DIR/sites-available/streamstudio.conf' | grep -q 'allow 203.0.113.7; deny all;'"

  # An existing problem in the server's config: add nothing, reload nothing.
  echo 'this is not nginx syntax;' >> "$N"
  rm -f "$NGINX_DIR/sites-enabled/streamstudio.conf" "$NGINX_DIR/sites-available/streamstudio.conf"
  ( setup_nginx ) > "$WORK/n4" 2>&1
  check "nginx: a failing check is reported" "grep -q 'removed again' '$WORK/n4'"
  check "nginx: and the studio's files are removed" "[ ! -e '$NGINX_DIR/sites-available/streamstudio.conf' ] && [ ! -e '$NGINX_DIR/sites-enabled/streamstudio.conf' ]"
  check "nginx: and nothing is reloaded" "! grep -q 'reload nginx' '$WORK/n4'"
else
  echo "skip - nginx is not installed"
fi

# ---- deploy/push.sh: what it would run on the server, with ssh and scp stubbed.
STUB="$WORK/stub"; mkdir -p "$STUB" "$WORK/remote"
cat > "$STUB/scp" <<'S'
#!/bin/sh
# scp -q <file> host:<path>  ->  a local copy
cp "$2" "${3#*:}"
S
cat > "$STUB/ssh" <<'S'
#!/bin/sh
# ssh -t host <command>  ->  run the command locally
shift 2
exec bash -c "$1"
S
cat > "$STUB/env" <<S
#!/bin/sh
# Stands in for the install: record the arguments, check the script arrived.
for a in "\$@"; do printf '%s\n' "\$a"; done > "$WORK/push-args"
last=\$(eval echo "\\\${\$((\$# - 1))}")
[ -f "\$last" ] && echo present > "$WORK/push-script"
S
cat > "$STUB/sudo" <<'S'
#!/bin/sh
# push.sh uses sudo unless it is already root on the server
exec "$@"
S
chmod +x "$STUB/scp" "$STUB/ssh" "$STUB/env" "$STUB/sudo"
( cd "$ROOT" && PATH="$STUB:$PATH" ALLOW_IP=203.0.113.7 EMAIL='me and you@example.com' PORT='' \
    bash deploy/push.sh fakehost t.six7.pw ) > "$WORK/push-out" 2>&1
check "push: the app reaches the server and the installer is run from it" "grep -qx present '$WORK/push-script'"
check "push: settings arrive intact, spaces and all" "grep -qx 'ALLOW_IP=203.0.113.7' '$WORK/push-args' && grep -qx 'EMAIL=me and you@example.com' '$WORK/push-args' && grep -qx 'PORT=8787' '$WORK/push-args'"
check "push: the domain is passed to the installer" "tail -1 '$WORK/push-args' | grep -qx 't.six7.pw'"
check "push: the upload is cleaned up" "[ ! -e /tmp/streamstudio.tgz ]"

# ---- deploy/docker/push.sh: ships the working tree, new files included, and
# leaves your git index alone. ssh is stubbed to record the remote script.
cat > "$STUB/ssh" <<S
#!/bin/sh
printf '%s' "\$2" > "$WORK/docker-remote"
S
chmod +x "$STUB/ssh"
before="$(cd "$ROOT" && git status --porcelain)"
( cd "$ROOT" && PATH="$STUB:$PATH" bash deploy/docker/push.sh fakehost ) > "$WORK/docker-out" 2>&1
# Listed to a file first: grep -q stopping early would SIGPIPE tar under pipefail.
tar -tzf /tmp/streamstudio.tgz > "$WORK/docker-files" 2>/dev/null; rm -f /tmp/streamstudio.tgz
check "docker push: the app and the container files are shipped" "grep -qx server.js '$WORK/docker-files' && grep -qx deploy/docker/Dockerfile '$WORK/docker-files'"
check "docker push: git-ignored files stay home" "! grep -q '^node_modules/' '$WORK/docker-files'"
check "docker push: your git index is untouched" "[ \"\$(cd '$ROOT' && git status --porcelain)\" = \"\$before\" ]"
check "docker push: the server builds and starts the container" "grep -q 'up -d --build --wait' '$WORK/docker-remote'"

echo "install: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
