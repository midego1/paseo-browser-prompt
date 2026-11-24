#!/bin/sh
# Starts Chromium for the browser-prompt signed-in Server browser (see chromium.conf). Removes the
# profile locks a previous container left (the container's host name changes on every start), and
# sends every request through the filtering proxy sidecar (BP_PROXY), loopback included, so pages
# can reach neither this container's own services (neko, the DevTools port) nor private, tailnet or
# host addresses. Without a valid BP_PROXY it does not start Chromium at all.
# Migration from before 0.25.0, when the plugin could put Bitwarden into this browser (an image
# variant, removed in 0.25.0; no extension can be installed now, see policies.json): the profile
# recorded the ids of the Bitwarden builds it had seen (.bp-bitwarden-ids). While that file exists,
# a start removes what those builds left (their extension data directories, IndexedDB and file
# system entries, Chromium's shared extension databases, their preference entries); after the first
# pass whose preference cleanup succeeded (at most 3 passes otherwise) the file and its marker go, so
# the cleanup does not repeat on every start. Site logins and cookies are never touched.
PROFILE=/home/neko/.config/chromium
IDS="$PROFILE/.bp-bitwarden-ids"
DBS="$PROFILE/.bp-bitwarden-dbs-cleared"
PASSES="$PROFILE/.bp-bitwarden-passes"
# Written when the cleanup finished: the old store id below is then never looked for again.
DONE="$PROFILE/.bp-bitwarden-cleaned"
# The first 0.23.0 builds loaded Bitwarden with its store id: a stale build where it left traces.
LEGACY_ID=nngceckbapebfimnlniiiahkandclblb
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"
if ! printf '%s' "${BP_PROXY:-}" | grep -Eq '^http://(bp-si-[0-9a-f]{8}-proxy|[0-9]{1,3}(\.[0-9]{1,3}){3}):[0-9]{1,5}$'; then
  echo "browser-prompt: BP_PROXY is missing or not http://<stack proxy or ipv4>:<port>; refusing to start Chromium without the proxy" >&2
  sleep 10
  exit 1
fi
if [ ! -e "$DONE" ] && ! grep -qx "$LEGACY_ID" "$IDS" 2>/dev/null; then
  if [ -e "$PROFILE/Default/Local Extension Settings/$LEGACY_ID" ] || grep -q "$LEGACY_ID" "$PROFILE/Default/Preferences" 2>/dev/null; then printf '%s\n' "$LEGACY_ID" >> "$IDS"; fi
fi
if [ -f "$IDS" ]; then
  STALE=$(grep -xE '[a-p]{32}' "$IDS" | sort -u)
  for id in $STALE; do
    for dir in "$PROFILE"/Default "$PROFILE"/Profile*; do
      [ -d "$dir" ] || continue
      rm -rf "$dir/Local Extension Settings/$id" "$dir/Sync Extension Settings/$id" "$dir/Managed Extension Settings/$id" \
        "$dir/Storage/ext/$id" "$dir/Extensions/$id" "$dir/IndexedDB/chrome-extension_${id}_0.indexeddb.leveldb" \
        "$dir/IndexedDB/chrome-extension_${id}_0.indexeddb.blob" "$dir/File System/chrome-extension_${id}_0"
    done
  done
  if [ -n "$STALE" ]; then
    # Chromium's shared extension databases (state, rules, dynamic scripts) are keyed by extension id;
    # no extension may be installed any more, and Chromium's own components rebuild their entries.
    for dir in "$PROFILE"/Default "$PROFILE"/Profile*; do
      [ -d "$dir" ] && rm -rf "$dir/Extension State" "$dir/Extension Rules" "$dir/Extension Scripts"
    done
  fi
  # Their entries in Chromium's preferences (settings, uninstall records, shortcuts, MACs), before Chromium reads them.
  PREFS_OK=1
  if [ -n "$STALE" ] && ! command -v python3 >/dev/null 2>&1; then PREFS_OK=0; fi
  if [ -n "$STALE" ] && [ "$PREFS_OK" = 1 ]; then
    python3 -I -c '
import json, os, sys
stale = set(sys.argv[2:])
def names(v):
    return isinstance(v, str) and (v in stale or any(("chrome-extension://" + s) in v for s in stale))
def clean(value):
    if isinstance(value, dict):
        # Drop entries named after a stale build, and records that point at one (keyboard shortcuts:
        # {"extension": id, ...}), so Chromium does not bring them back.
        # Also keys that name one: content settings use "chrome-extension://<id>,*".
        return {k: clean(v) for k, v in value.items() if k not in stale and not names(k) and not names(v) and not (isinstance(v, dict) and any(names(x) for x in v.values()))}
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
' "$PROFILE" $STALE || PREFS_OK=0
  fi
  # Done after the first pass whose preference cleanup succeeded; otherwise tried again, at most 3 passes.
  COUNT=1
  [ -f "$PASSES" ] && COUNT=$(( $(wc -l < "$PASSES") + 1 ))
  if [ "$PREFS_OK" = 1 ] || [ "$COUNT" -ge 3 ]; then
    rm -f "$IDS" "$DBS" "$PASSES"
    : > "$DONE"
  else
    printf 'x\n' >> "$PASSES"
  fi
fi
exec /usr/bin/chromium "$@" --proxy-server="$BP_PROXY" --proxy-bypass-list="<-loopback>"
