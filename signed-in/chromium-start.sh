#!/bin/sh
# Starts Chromium for the browser-prompt signed-in Server browser (see chromium.conf). Removes the
# profile locks a previous container left (the container's host name changes on every start), and
# sends every request through the filtering proxy sidecar (BP_PROXY), loopback included, so pages
# can reach neither this container's own services (neko, the DevTools port) nor private, tailnet or
# host addresses. Without a valid BP_PROXY it does not start Chromium at all.
rm -f /home/neko/.config/chromium/SingletonLock /home/neko/.config/chromium/SingletonCookie /home/neko/.config/chromium/SingletonSocket
if ! printf '%s' "${BP_PROXY:-}" | grep -Eq '^http://[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$'; then
  echo "browser-prompt: BP_PROXY is missing or not http://<ipv4>:<port>; refusing to start Chromium without the proxy" >&2
  sleep 10
  exit 1
fi
exec /usr/bin/chromium "$@" --proxy-server="$BP_PROXY" --proxy-bypass-list="<-loopback>"
