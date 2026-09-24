#!/usr/bin/env bash
#
# Install or update Stream Studio on an Ubuntu 22.04+/Debian 12 VPS.
#
#   sudo bash deploy/install.sh t.example.com           HTTPS on that domain + login
#   sudo ALLOW_IP=203.0.113.7 bash deploy/install.sh t.example.com
#                                                       ...and only your home IP gets in
#   sudo bash deploy/install.sh                         no domain: SSH tunnel only
#
# Options (environment): PORT (default 8787), ALLOW_IP, EMAIL (for Let's Encrypt).
#
# Safe on a server that already hosts other sites: it adds its own site to the
# web server that is running (Caddy or nginx) rather than replacing that
# server's configuration, checks the result, and undoes its change if the
# check fails. Running it again updates the app and keeps everything in
# /var/lib/streamstudio (login, layouts, splits, stream key, backgrounds).
set -euo pipefail

DOMAIN="${1:-}"
PORT="${PORT:-8787}"
ALLOW_IP="${ALLOW_IP:-}"
EMAIL="${EMAIL:-}"
APP=/opt/streamstudio
DATA=/var/lib/streamstudio
# Where the web servers keep their configuration. Only the tests change these.
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }


# Which web server already answers on 80/443? We add to it; we never replace it.
detect_web_server() {
  local s
  for s in caddy nginx apache2 httpd; do
    if systemctl is-active --quiet "$s" 2>/dev/null; then echo "$s"; return; fi
  done
  if [ -n "$(ss -ltnH '( sport = :80 or sport = :443 )')" ]; then echo other; return; fi
  echo none
}

caddy_site() {
  echo "$DOMAIN {"
  if [ -n "$ALLOW_IP" ]; then
    echo "	@notHome not remote_ip $ALLOW_IP"
    echo "	respond @notHome 403"
  fi
  echo "	reverse_proxy 127.0.0.1:$PORT"
  echo "}"
}

nginx_site() {
  local allow="" ipv6=""
  # Inside location / and not the server block: Let's Encrypt must still reach
  # its challenge path when only your home IP is allowed.
  [ -n "$ALLOW_IP" ] && allow="allow $ALLOW_IP; deny all;"
  # Only listen on IPv6 where the kernel has it: on a VPS with IPv6 disabled,
  # nginx refuses the whole configuration over a [::] listen line.
  [ -e /proc/net/if_inet6 ] && ipv6="listen [::]:80;"
  cat <<EOF
# Stream Studio (added by deploy/install.sh)
map \$http_upgrade \$streamstudio_connection { default upgrade; '' close; }
server {
    listen 80;
    $ipv6
    server_name $DOMAIN;
    client_max_body_size 250m;
    location / {
        $allow
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$streamstudio_connection;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
EOF
}

setup_caddy() {
  local fresh=$1 main="$CADDY_DIR/Caddyfile" site="$CADDY_DIR/streamstudio.caddy" backup=""
  caddy_site > "$site"
  if [ "$fresh" = yes ]; then
    # We installed Caddy just now: its packaged Caddyfile is only a placeholder page.
    [ -f "$main" ] && cp "$main" "$main.orig"
    echo "import $site" > "$main"
  elif ! grep -qxF "import $site" "$main"; then
    backup="$main.before-streamstudio.$(date +%s)"
    cp "$main" "$backup"
    printf '\nimport %s\n' "$site" >> "$main"
  fi
  if ! caddy validate --config "$main" --adapter caddyfile >/tmp/streamstudio-caddy.log 2>&1; then
    [ -n "$backup" ] && cp "$backup" "$main"
    rm -f "$site"
    cat /tmp/streamstudio-caddy.log >&2
    die "Caddy rejected the new configuration, so it was put back as it was. Your other sites are untouched."
  fi
  if [ "$fresh" = yes ]; then systemctl enable --now caddy; fi
  systemctl reload caddy
  echo "Added $DOMAIN to Caddy ($site). Caddy fetches the HTTPS certificate itself."
}

setup_nginx() {
  local conf link
  if [ -d "$NGINX_DIR/sites-available" ]; then
    conf="$NGINX_DIR/sites-available/streamstudio.conf"
    link="$NGINX_DIR/sites-enabled/streamstudio.conf"
  else
    conf="$NGINX_DIR/conf.d/streamstudio.conf"
    link=""
  fi
  nginx_site > "$conf"
  [ -n "$link" ] && ln -sf "$conf" "$link"
  if ! nginx -t -c "$NGINX_DIR/nginx.conf" >/tmp/streamstudio-nginx.log 2>&1; then
    rm -f "$conf" ${link:+"$link"}
    cat /tmp/streamstudio-nginx.log >&2
    die "nginx rejected the new configuration, so it was removed again. Your other sites are untouched."
  fi
  systemctl reload nginx
  echo "Added $DOMAIN to nginx ($conf)."

  say "HTTPS certificate for $DOMAIN (Let's Encrypt)"
  command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  local who=(--register-unsafely-without-email)
  [ -n "$EMAIL" ] && who=(--email "$EMAIL")
  if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${who[@]}"; then
    echo
    echo "Warning: no certificate yet, so $DOMAIN only works over plain http for now,"
    echo "and browsers will not open cameras there. Check that $DOMAIN points at this"
    echo "server and port 80 is open, then run:  sudo certbot --nginx -d $DOMAIN"
  fi
}

# ---------------------------------------------------------------- install

main() {
  [ "$(id -u)" = 0 ] || die "run this with sudo."
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT must be a number."
  [ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "that does not look like a domain: $DOMAIN"
  [ -z "$ALLOW_IP" ] || [[ "$ALLOW_IP" =~ ^[0-9A-Fa-f.:/]+$ ]] || die "ALLOW_IP must be an IP address."

  # Something else already listening on our port would be a silent clash.
  # (Captured rather than piped to grep -q: with pipefail an early grep exit can read as "no match".)
  if [ -n "$(ss -ltnH "sport = :$PORT")" ] && ! systemctl is-active --quiet streamstudio; then
    die "port $PORT is already in use by another program. Rerun with PORT=<a free port>."
  fi

  say "Packages"
  apt-get update -qq
  apt-get install -y -qq ffmpeg ca-certificates curl >/dev/null
  # Keep a Node you installed yourself (NodeSource, nvm); only fall back to the distro's.
  command -v node >/dev/null || apt-get install -y -qq nodejs >/dev/null
  command -v npm >/dev/null || apt-get install -y -qq npm >/dev/null
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    die "Node $NODE_MAJOR is too old; Stream Studio needs 18 or newer. Install a current Node (https://nodejs.org/en/download/package-manager) and run this again."
  fi

  say "App in $APP, data in $DATA"
  id streamstudio >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin streamstudio
  mkdir -p "$APP" "$DATA"
  rm -rf "$APP/public"
  cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/public" "$APP/"
  (cd "$APP" && npm ci --omit=dev --no-audit --no-fund --silent)
  chown -R root:root "$APP"
  chown -R streamstudio:streamstudio "$DATA"
  chmod 700 "$DATA"

  if [ ! -f "$DATA/auth.json" ]; then
    say "Choose the login for the studio"
    sudo -u streamstudio DATA_DIR="$DATA" node "$APP/server.js" passwd
  fi

  say "Service (listening on 127.0.0.1:$PORT only)"
  sed -e "s#/usr/bin/node#$(command -v node)#" -e "s#^Environment=PORT=.*#Environment=PORT=$PORT#" \
    "$SRC/deploy/streamstudio.service" > /etc/systemd/system/streamstudio.service
  systemctl daemon-reload
  systemctl enable --quiet streamstudio
  systemctl restart streamstudio
  for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || die "the service did not start. See: journalctl -u streamstudio -n 50"

  if [ -z "$DOMAIN" ]; then
    echo
    echo "Done. Nothing is exposed to the internet. From your home PC run:"
    echo "    ssh -N -L $PORT:127.0.0.1:$PORT <you>@<this-vps>"
    echo "and open http://localhost:$PORT (browsers allow cameras on localhost)."
    return 0
  fi

  say "Web server for $DOMAIN"
  # Point out a DNS mismatch early: the certificate request depends on it.
  PUBLIC_IP="$(curl -fsS -4 -m 5 https://ifconfig.me 2>/dev/null || true)"
  DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')"
  if [ -n "$PUBLIC_IP" ] && [ -n "$DNS_IP" ] && [ "$PUBLIC_IP" != "$DNS_IP" ]; then
    echo "Warning: $DOMAIN points at $DNS_IP but this server is $PUBLIC_IP. HTTPS will fail until DNS is right."
  fi

  case "$(detect_web_server)" in
    caddy) setup_caddy no ;;
    nginx) setup_nginx ;;
    none)
      say "Installing Caddy"
      apt-get install -y -qq caddy >/dev/null 2>&1 || {
        apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -qq && apt-get install -y -qq caddy >/dev/null
      }
      setup_caddy yes
      ;;
    *)
      echo "Another web server (not Caddy or nginx) owns ports 80/443, so this script leaves it alone."
      echo "Point $DOMAIN at 127.0.0.1:$PORT in that server as a reverse proxy, passing WebSocket"
      echo "upgrades through and setting X-Forwarded-For and X-Forwarded-Proto."
      ;;
  esac

  if command -v ufw >/dev/null && [[ "$(ufw status)" == *"Status: active"* ]]; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
  fi

  echo
  echo "Done. Open https://$DOMAIN from home and sign in."
  [ -z "$ALLOW_IP" ] && echo "Tip: rerun with ALLOW_IP=<your home IP> so nobody else can even reach the login page."
  echo "Logs: journalctl -u streamstudio -f"
}

# Run only when executed; sourcing it (the tests do) just defines the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
