#!/bin/sh
# Starts Chromium for the browser-prompt signed-in Server browser (see chromium.conf). Removes the
# profile locks a previous container left (the container's host name changes on every start), and
# sends every request through the filtering proxy sidecar (BP_PROXY), loopback included, so pages
# can reach neither this container's own services (neko, the DevTools port) nor private, tailnet or
# host addresses. Without a valid BP_PROXY it does not start Chromium at all.
# Bitwarden (only in the image variant built after the owner's consent, see signed-in-bitwarden/):
# when /opt/bitwarden holds the pinned extension, Chromium loads it from there (read-only, never
# updated) and disables every other extension. Without it, Bitwarden's data is removed from the
# profile (its vault cache, settings and storage), so turning Bitwarden off leaves nothing of it.
PROFILE=/home/neko/.config/chromium
BITWARDEN=/opt/bitwarden
BITWARDEN_ID=nngceckbapebfimnlniiiahkandclblb
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"
if ! printf '%s' "${BP_PROXY:-}" | grep -Eq '^http://(bp-si-[0-9a-f]{8}-proxy|[0-9]{1,3}(\.[0-9]{1,3}){3}):[0-9]{1,5}$'; then
  echo "browser-prompt: BP_PROXY is missing or not http://<stack proxy or ipv4>:<port>; refusing to start Chromium without the proxy" >&2
  sleep 10
  exit 1
fi
if [ -f "$BITWARDEN/manifest.json" ] && [ -f "$BITWARDEN/browser-prompt-pin.json" ]; then
  exec /usr/bin/chromium "$@" --load-extension="$BITWARDEN" --disable-extensions-except="$BITWARDEN" --proxy-server="$BP_PROXY" --proxy-bypass-list="<-loopback>"
fi
for dir in "$PROFILE"/Default "$PROFILE"/Profile*; do
  [ -d "$dir" ] || continue
  rm -rf "$dir/Local Extension Settings/$BITWARDEN_ID" "$dir/Sync Extension Settings/$BITWARDEN_ID" "$dir/Managed Extension Settings/$BITWARDEN_ID" \
    "$dir/Storage/ext/$BITWARDEN_ID" "$dir/Extensions/$BITWARDEN_ID" "$dir/IndexedDB/chrome-extension_${BITWARDEN_ID}_0.indexeddb.leveldb" \
    "$dir/IndexedDB/chrome-extension_${BITWARDEN_ID}_0.indexeddb.blob" "$dir/File System/chrome-extension_${BITWARDEN_ID}_0"
done
exec /usr/bin/chromium "$@" --proxy-server="$BP_PROXY" --proxy-bypass-list="<-loopback>"
