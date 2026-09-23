#!/usr/bin/env bash
#
# Install Stream Studio on a fresh Ubuntu 22.04+/Debian 12 VPS.
#
#   sudo bash deploy/install.sh studio.example.com            HTTPS + login
#   sudo ALLOW_IP=203.0.113.7 bash deploy/install.sh studio.example.com
#                                                             ...and only your home IP
#   sudo bash deploy/install.sh                               no domain: SSH tunnel only
#
# Run it again to update: it keeps /var/lib/streamstudio (login, layouts,
# splits, stream key, backgrounds) and replaces only the app.
set -euo pipefail

DOMAIN="${1:-}"
APP=/opt/streamstudio
DATA=/var/lib/streamstudio
SRC="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" = 0 ] || { echo "Run this with sudo."; exit 1; }

echo "==> Packages"
apt-get update -qq
apt-get install -y -qq ffmpeg ca-certificates curl >/dev/null
# Keep a Node you installed yourself (NodeSource, nvm); only fall back to the distro's.
command -v node >/dev/null || apt-get install -y -qq nodejs >/dev/null
command -v npm >/dev/null || apt-get install -y -qq npm >/dev/null
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node $NODE_MAJOR is too old; Stream Studio needs 18 or newer."
  echo "Install a current Node (https://nodejs.org/en/download/package-manager) and run this again."
  exit 1
fi

echo "==> App in $APP, data in $DATA"
id streamstudio >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin streamstudio
mkdir -p "$APP" "$DATA"
rm -rf "$APP/public"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/public" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --silent)
chown -R root:root "$APP"
chown -R streamstudio:streamstudio "$DATA"
chmod 700 "$DATA"

if [ ! -f "$DATA/auth.json" ]; then
  echo "==> Choose the login for the studio"
  sudo -u streamstudio DATA_DIR="$DATA" node "$APP/server.js" passwd
fi

echo "==> Service"
sed "s#/usr/bin/node#$(command -v node)#" "$SRC/deploy/streamstudio.service" > /etc/systemd/system/streamstudio.service
systemctl daemon-reload
systemctl enable --now streamstudio
systemctl restart streamstudio

if [ -n "$DOMAIN" ]; then
  echo "==> Caddy (HTTPS for $DOMAIN)"
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq caddy >/dev/null 2>&1 || {
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    }
  fi
  {
    echo "$DOMAIN {"
    if [ -n "${ALLOW_IP:-}" ]; then
      echo "	@notHome not remote_ip $ALLOW_IP"
      echo "	respond @notHome 403"
    fi
    echo "	reverse_proxy 127.0.0.1:8080"
    echo "}"
  } > /etc/caddy/Caddyfile
  systemctl enable --now caddy
  systemctl reload caddy
  if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp && ufw allow 443/tcp; fi
  echo
  echo "Done. Open https://$DOMAIN from home and sign in."
  [ -z "${ALLOW_IP:-}" ] && echo "Tip: rerun with ALLOW_IP=<your home IP> so nobody else can even reach the login page."
else
  echo
  echo "Done. Nothing is exposed to the internet. From your home PC run:"
  echo "    ssh -N -L 8080:127.0.0.1:8080 $(logname 2>/dev/null || echo you)@<this-vps>"
  echo "and open http://localhost:8080 (browsers allow cameras on localhost)."
fi
echo "Logs: journalctl -u streamstudio -f"
