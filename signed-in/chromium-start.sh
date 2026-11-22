#!/bin/sh
# Starts Chromium for the browser-prompt signed-in Server browser (see chromium.conf). Removes the
# profile locks a previous container left (the container's host name changes on every start), and
# sends every request through the filtering proxy sidecar (BP_PROXY), loopback included, so pages
# can reach neither this container's own services (neko, the DevTools port) nor private, tailnet or
# host addresses. Without a valid BP_PROXY it does not start Chromium at all.
# Bitwarden (only in the image variant built after the owner's consent, see signed-in-bitwarden/):
# the variant force-installs it by policy, with an id made for that build. This script records the
# ids of the Bitwarden builds the profile has seen (.bp-bitwarden-ids) and, on every start, removes
# what is left of every one not installed now: all of them when Bitwarden is off, the old one after a
# new pin (data directories, the shared extension databases, preference entries). (Chromium
# itself uninstalls a force-installed extension once the policy no longer names it, and the plugin
# clears the extension origins' storage through DevTools after the start.)
PROFILE=/home/neko/.config/chromium
PIN=/opt/bitwarden/browser-prompt-pin.json
IDS="$PROFILE/.bp-bitwarden-ids"
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"
if ! printf '%s' "${BP_PROXY:-}" | grep -Eq '^http://(bp-si-[0-9a-f]{8}-proxy|[0-9]{1,3}(\.[0-9]{1,3}){3}):[0-9]{1,5}$'; then
  echo "browser-prompt: BP_PROXY is missing or not http://<stack proxy or ipv4>:<port>; refusing to start Chromium without the proxy" >&2
  sleep 10
  exit 1
fi
CURRENT=""
if [ -f "$PIN" ]; then
  CURRENT=$(grep -oE '"id": *"[a-p]{32}"' "$PIN" | grep -oE '[a-p]{32}')
  if [ -n "$CURRENT" ] && ! grep -qx "$CURRENT" "$IDS" 2>/dev/null; then printf '%s\n' "$CURRENT" >> "$IDS"; fi
fi
if [ -f "$IDS" ]; then
  STALE=""
  for id in $(grep -xE '[a-p]{32}' "$IDS"); do
    [ "$id" = "$CURRENT" ] && continue
    STALE="$STALE $id"
    for dir in "$PROFILE"/Default "$PROFILE"/Profile*; do
      [ -d "$dir" ] || continue
      rm -rf "$dir/Local Extension Settings/$id" "$dir/Sync Extension Settings/$id" "$dir/Managed Extension Settings/$id" \
        "$dir/Storage/ext/$id" "$dir/Extensions/$id" "$dir/IndexedDB/chrome-extension_${id}_0.indexeddb.leveldb" \
        "$dir/IndexedDB/chrome-extension_${id}_0.indexeddb.blob" "$dir/File System/chrome-extension_${id}_0"
    done
  done
  # Chromium's shared extension databases (state, rules, dynamic scripts) are keyed by extension id;
  # Bitwarden is the only extension besides Chromium's own components, which rebuild their entries.
  if [ -n "$STALE" ]; then
    for dir in "$PROFILE"/Default "$PROFILE"/Profile*; do
      [ -d "$dir" ] && rm -rf "$dir/Extension State" "$dir/Extension Rules" "$dir/Extension Scripts"
    done
  fi
  # Their entries in Chromium's preferences (settings, uninstall records, shortcuts, MACs), before Chromium reads them.
  if [ -n "$STALE" ] && command -v python3 >/dev/null 2>&1; then
    python3 -I -c '
import json, os, sys
stale = set(sys.argv[2:])
def names(v):
    return isinstance(v, str) and (v in stale or any(("chrome-extension://" + s) in v for s in stale))
def clean(value):
    if isinstance(value, dict):
        # Drop entries named after a stale build, and records that point at one (keyboard shortcuts:
        # {"extension": id, ...}), so Chromium does not bring them back.
        return {k: clean(v) for k, v in value.items() if k not in stale and not names(v) and not (isinstance(v, dict) and any(names(x) for x in v.values()))}
    if isinstance(value, list):
        return [clean(v) for v in value if not names(v)]
    return value
for root, dirs, files in os.walk(sys.argv[1]):
    if root.count(os.sep) - sys.argv[1].count(os.sep) > 1:
        continue
    for name in ("Preferences", "Secure Preferences"):
        if name not in files:
            continue
        path = os.path.join(root, name)
        try:
            data = json.load(open(path))
        except Exception:
            continue
        cleaned = clean(data)
        if cleaned != data:
            with open(path + ".bp-tmp", "w") as out:
                json.dump(cleaned, out)
            os.replace(path + ".bp-tmp", path)
' "$PROFILE" $STALE || true
  fi
fi
exec /usr/bin/chromium "$@" --proxy-server="$BP_PROXY" --proxy-bypass-list="<-loopback>"
