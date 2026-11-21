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
FROM ghcr.io/m1k1o/neko/chromium:3.2.0@sha256:270face8b8111e639744fb7bcdbbf0deed227900bb89d58b2f8adfc12af8c41e

COPY chromium.conf /etc/neko/supervisord/chromium.conf
COPY chromium-start.sh /usr/local/bin/chromium-start.sh
COPY policies.json /etc/chromium/policies/managed/policies.json
RUN chmod 0755 /usr/local/bin/chromium-start.sh && chmod 0644 /etc/neko/supervisord/chromium.conf /etc/chromium/policies/managed/policies.json
