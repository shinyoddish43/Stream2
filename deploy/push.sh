#!/usr/bin/env bash
#
# Deploy from your own computer to a VPS you can already ssh into.
#
#   deploy/push.sh vps t.example.com          vps is an ssh host or alias
#   ALLOW_IP=203.0.113.7 deploy/push.sh vps t.example.com
#
# Copies the committed app (git archive, so nothing half-edited goes up), then
# runs deploy/install.sh on the server. The first run asks you to choose the
# studio's username and password.
set -euo pipefail

HOST="${1:?usage: deploy/push.sh <ssh host> [domain]}"
DOMAIN="${2:-}"
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Note: uncommitted changes are not deployed; this sends the last commit."
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar.gz -o "$tmp/streamstudio.tgz" HEAD
scp -q "$tmp/streamstudio.tgz" "$HOST:/tmp/streamstudio.tgz"

# printf %q quotes each value for the remote shell.
remote="set -e
src=\$(mktemp -d)
tar -xzf /tmp/streamstudio.tgz -C \"\$src\"
rm -f /tmp/streamstudio.tgz
run=''; [ \"\$(id -u)\" = 0 ] || run=sudo
\$run env ALLOW_IP=$(printf %q "${ALLOW_IP:-}") PORT=$(printf %q "${PORT:-8787}") EMAIL=$(printf %q "${EMAIL:-}") bash \"\$src/deploy/install.sh\" $(printf %q "$DOMAIN")
rm -rf \"\$src\""
ssh -t "$HOST" "$remote"
