#!/usr/bin/env bash
# Re-records the README tour: docs/assets/browser-prompt-tour.mp4 and docs/assets/browser-prompt-tour.gif.
#
#   scripts/demo/record.sh
#
# Needs Docker (rootless is fine) and network access to pull images. Everything runs against an
# isolated, throwaway Paseo daemon in a container: no published ports (it listens on 127.0.0.1 inside
# its own network namespace), relay off, a neutral host name, demo data only. The recorder container
# joins that namespace. Your own Paseo daemon, home and browser are never touched. Both containers
# are removed at the end.
#
# The scenes are the real Paseo app with this checkout of the plugin installed; the agent outputs
# are stand-ins from stand-in-model/ (no model calls, no real browser). See README.md here.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO="$REPO/scripts/demo"
WORK="${DEMO_WORK:-$(mktemp -d /tmp/browser-prompt-demo.XXXXXX)}"
PASEO_IMAGE="${PASEO_IMAGE:-ghcr.io/getpaseo/paseo:latest}"
TOOLS_IMAGE="browser-prompt-demo-tools"
DAEMON="browser-prompt-demo-daemon"

cleanup() { docker rm -f "$DAEMON" >/dev/null 2>&1 || true; }
trap cleanup EXIT

as_paseo() { docker exec --user paseo "$DAEMON" "$@"; }

echo "Building the recorder image"
docker build -q -t "$TOOLS_IMAGE" "$DEMO" >/dev/null

echo "Starting an isolated Paseo daemon"
cleanup
docker run -d --name "$DAEMON" --hostname demo-host \
  -e PASEO_LISTEN=127.0.0.1:6767 -e PASEO_RELAY_ENABLED=false \
  "$PASEO_IMAGE" >/dev/null
timeout 120 bash -c "until docker logs $DAEMON 2>&1 | grep -q 'WebSocket server initialized'; do sleep 2; done"

echo "Installing this checkout of the plugin and the demo stand-in model"
docker exec "$DAEMON" mkdir -p /opt/browser-prompt
(cd "$REPO" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -c) | docker exec -i "$DAEMON" tar -x -C /opt/browser-prompt
docker exec "$DAEMON" chown -R paseo:paseo /opt/browser-prompt
as_paseo paseo daemon config set pluginsEnabled true >/dev/null
as_paseo paseo reload --json >/dev/null
as_paseo paseo plugin install /opt/browser-prompt >/dev/null
as_paseo paseo plugin install /opt/browser-prompt/scripts/demo/stand-in-model >/dev/null
as_paseo paseo plugin ls

echo "Creating the demo workspace and chat"
as_paseo sh -c 'mkdir -p /tmp/demo-project && cd /tmp/demo-project && git init -q'
WORKSPACE_ID="$(as_paseo paseo agent run --provider claude-demo/stand-in --mode default --title "Website check" \
  --cwd /tmp/demo-project "Can you check the heading on example.com and the page its Docs link opens?" 2>&1 |
  grep -oE 'wks_[A-Za-z0-9]+' | head -1)"
test -n "$WORKSPACE_ID"

echo "Recording and encoding"
mkdir -p "$WORK"
cp "$DEMO"/capture.mjs "$DEMO"/overlay.mjs "$DEMO"/screencast.mjs "$DEMO"/encode.mjs "$DEMO"/package.json "$WORK"/
chmod -R a+rwX "$WORK"
docker run --rm --network "container:$DAEMON" -e DEMO_WORKSPACE_ID="$WORKSPACE_ID" -v "$WORK:/rec" -w /rec "$TOOLS_IMAGE" sh -c '
  npm install --silent --no-audit --no-fund >/dev/null 2>&1 &&
  node capture.mjs &&
  node encode.mjs &&
  exiftool -s -s -s -All out/browser-prompt-tour.mp4 out/browser-prompt-tour.gif | grep -viE "^(\\[|$)" > out/metadata.txt || true'

mkdir -p "$REPO/docs/assets"
cp "$WORK/out/browser-prompt-tour.mp4" "$WORK/out/browser-prompt-tour.gif" "$REPO/docs/assets/"
echo "Wrote docs/assets/browser-prompt-tour.mp4 and .gif (frames and metadata dump in $WORK/out)"
