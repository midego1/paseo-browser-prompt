# Signed-in Server browser image for the browser-prompt plugin: neko (https://github.com/m1k1o/neko,
# Apache-2.0) with Chromium, a desktop the owner can watch and take over over WebRTC, plus the
# plugin's overrides. Built locally by the plugin only after the owner's explicit choice in its
# settings (the base image is about 1.5 GB) and tagged with a hash of this build context, never
# `latest`. The base image is pinned by digest: neko 3.2.0 with Chromium 155.
# Overrides:
#   - chromium.conf: Chromium's own sandbox on, DevTools protocol on 127.0.0.1:9222 inside the
#     container only (for the run agent's Playwright MCP, which shares this container's network
#     namespace), session restore, no crash bubble; no --bwsi (guest mode would not keep logins).
#   - chromium-start.sh: removes stale profile locks and starts Chromium with the filtering proxy
#     sidecar as its only way out (also for loopback), refusing to start without it.
#   - policies.json: neko's policy without the forced Google extensions, with DevTools allowed
#     (needed for the protocol), cookies kept (neko ships session-only cookies), no password
#     manager, autofill, sync, sign-in, downloads, file pickers, extensions, metrics reporting or
#     background mode, standard Safe Browsing, and every internal page blocked (chrome://*,
#     chrome-untrusted://*, chrome-search://*, chrome-extension://*, devtools://*, view-source:,
#     about:*, javascript:, data:, file://) except about:blank and chrome://newtab (which opens about:blank), so neither
#     the agent nor a page can read history, settings or the list of signed-in sites there.
#   - viewer.css: neko's web client shows its on-screen keyboard button only below 769 px, so an
#     iPad could tap but not type; this stylesheet (linked from neko's index.html) shows it on touch
#     screens of any width. viewer.css and viewer.js are served as bp-viewer-<content hash>.css/.js,
#     so a browser never uses a cached copy from an older image.
#   - viewer.js (linked from neko's index.html, before neko's own deferred bundle) plus a one-line
#     hook in neko's onKeyDown: on touch devices a tap on the video focuses neko's key-capture
#     textarea without the on-screen keyboard (so an iPad's hardware keyboard types right after
#     Request controls), no autocorrect/autocapitalize/spell check on it, and Shift is held around
#     capitals and shifted symbols that arrive without it (on-screen keyboard text, dictation).
#     The build fails when the hook's anchor is not found exactly once.
FROM ghcr.io/m1k1o/neko/chromium:3.2.0@sha256:270face8b8111e639744fb7bcdbbf0deed227900bb89d58b2f8adfc12af8c41e

COPY chromium.conf /etc/neko/supervisord/chromium.conf
COPY chromium-start.sh /usr/local/bin/chromium-start.sh
COPY policies.json /etc/chromium/policies/managed/policies.json
RUN chmod 0755 /usr/local/bin/chromium-start.sh && chmod 0644 /etc/neko/supervisord/chromium.conf /etc/chromium/policies/managed/policies.json
COPY viewer.css /var/www/assets/bp-viewer.css
COPY viewer.js /var/www/assets/bp-viewer.js
RUN cd /var/www/assets \
  && css="bp-viewer-$(sha256sum bp-viewer.css | cut -c1-12).css" && js="bp-viewer-$(sha256sum bp-viewer.js | cut -c1-12).js" \
  && mv bp-viewer.css "$css" && mv bp-viewer.js "$js" && chmod 0644 "$css" "$js" \
  && sed -i "s#</head>#<link rel=\"stylesheet\" href=\"./assets/$css\"><script src=\"./assets/$js\"></script></head>#" /var/www/index.html \
  && grep -q "href=\"./assets/$css\"" /var/www/index.html \
  && grep -q "src=\"./assets/$js\"" /var/www/index.html \
  && bundle=$(ls /var/www/assets/index-*.js) && [ "$(echo "$bundle" | wc -l)" = 1 ] \
  && [ "$(grep -o 'this\.client\.input\.key(e,!0),ze(e))' "$bundle" | wc -l)" = 1 ] \
  && sed -i 's/this\.client\.input\.key(e,!0),ze(e))/(window.bpKeyDown?window.bpKeyDown(this,e):this.client.input.key(e,!0)),ze(e))/' "$bundle" \
  && grep -q 'window.bpKeyDown(this,e)' "$bundle"
