#!/usr/bin/env bash
#
# Deploy the studio to a live host over SSH, or package it for an upload.
#
#   deploy/deploy.sh user@host:/home/user/public_html/studio     # rsync over SSH
#   deploy/deploy.sh --zip                                        # build an upload
#   deploy/deploy.sh --check https://example.com/studio           # health check a live install
#
# Never copies data/: that is the live install's scenes, splits and stream
# keys. Never copies tests, the relay, the bridges or .git either — the web
# root does not need them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXCLUDES=(
  --exclude '.git' --exclude '.github' --exclude 'data' --exclude 'tests'
  --exclude 'relay' --exclude 'bridge' --exclude 'deploy' --exclude 'node_modules'
  --exclude '*.log' --exclude '__pycache__' --exclude '.DS_Store'
)

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

case "${1:-}" in
  --zip)
    OUT="${2:-stream-studio-deploy.zip}"
    rm -f "$OUT"
    zip -rq "$OUT" . \
      -x '.git/*' '.github/*' 'data/*' 'tests/*' 'relay/*' 'bridge/*' 'deploy/*' \
         'node_modules/*' '*.log' '__pycache__/*'
    echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))."
    echo "Upload it in cPanel → File Manager, extract, then open install.php."
    ;;

  --check)
    URL="${2:-}"
    [ -n "$URL" ] || usage
    echo "Checking ${URL%/}/health.php …"
    BODY="$(curl -fsS "${URL%/}/health.php?format=json" || true)"
    if [ -z "$BODY" ]; then
      echo "No answer. If the studio needs a login, open health.php in a browser instead." >&2
      exit 1
    fi
    printf '%s\n' "$BODY" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$BODY"
    printf '%s' "$BODY" | grep -q '"status": *"bad"' && { echo "FAILED checks above." >&2; exit 1; }
    echo "Live install looks healthy."
    ;;

  ''|-h|--help)
    usage
    ;;

  *)
    TARGET="$1"
    echo "Deploying to $TARGET"
    # A dry run first, so you see what is about to change on a live site.
    rsync -az --delete-after "${EXCLUDES[@]}" --dry-run --itemize-changes ./ "$TARGET/" | head -40
    read -r -p "Apply these changes? [y/N] " answer
    [ "$answer" = "y" ] || { echo "Nothing sent."; exit 0; }
    rsync -az --delete-after "${EXCLUDES[@]}" ./ "$TARGET/"
    echo "Sent. Now open https://your-domain/health.php to confirm the live install."
    ;;
esac
