#!/usr/bin/env bash
#
# Deploy the studio as a container beside the six7 hub, from your own computer:
#
#   deploy/docker/push.sh vps          vps is an ssh host or alias
#
# Sends the working tree (committed, changed and new files; not what
# .gitignore excludes), builds the image on the server and restarts the
# container. Studio data lives in the Docker volume streamstudio_data and
# survives updates. The hub needs its studio network first: see six7-hub.md.
set -euo pipefail

HOST="${1:?usage: deploy/docker/push.sh <ssh host>}"
cd "$(dirname "$0")/../.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# A scratch index snapshots the working tree without touching yours.
tree="$(export GIT_INDEX_FILE="$tmp/index"; git read-tree HEAD && git add -A && git write-tree)"
git archive --format=tar.gz -o "$tmp/streamstudio.tgz" "$tree"
[ -z "$(git status --porcelain)" ] || echo "Note: deploying uncommitted changes too."
scp -q "$tmp/streamstudio.tgz" "$HOST:/tmp/streamstudio.tgz"

ssh "$HOST" 'set -e
docker network inspect six7_studio-edge >/dev/null 2>&1 || {
  echo "The hub has no studio network (six7_studio-edge) yet: see deploy/docker/six7-hub.md." >&2
  exit 1
}
dir="$HOME/streamstudio"
rm -rf "$dir.new"
mkdir -p "$dir.new"
tar -xzf /tmp/streamstudio.tgz -C "$dir.new"
rm -f /tmp/streamstudio.tgz
rm -rf "$dir.old"
if [ -d "$dir" ]; then mv "$dir" "$dir.old"; fi
mv "$dir.new" "$dir"
cd "$dir"
docker compose -f deploy/docker/compose.yaml --env-file deploy/docker/six7.env up -d --build --wait
docker compose -f deploy/docker/compose.yaml --env-file deploy/docker/six7.env ps'
