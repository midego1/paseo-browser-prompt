# Bitwarden variant of the browser-prompt signed-in Server browser image. Built by the plugin only
# after the owner's explicit two-press consent in its settings (Signed-in Server browser ›
# Bitwarden), on top of the plugin's own signed-in image (BASE_IMAGE, built from signed-in/), and
# tagged with a hash of both build contexts, never `latest`.
#   - install-bitwarden.py downloads the Bitwarden Password Manager release pinned in bitwarden.json
#     from Bitwarden's GitHub releases, refuses it unless size and SHA-256 match, and puts it
#     read-only in /opt/bitwarden. chromium-start.sh loads it from there (unpacked, so Chromium never
#     updates it) and disables every other extension.
#   - policy-overlay.json: Bitwarden is the only extension (types and install sources locked, no
#     external extensions, the Chrome Web Store blocked); only its own chrome-extension:// pages are
#     allowed back; Chromium's password manager and autofill stay off.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY bitwarden.json policy-overlay.json install-bitwarden.py /tmp/bp-bitwarden/
RUN python3 -I /tmp/bp-bitwarden/install-bitwarden.py /tmp/bp-bitwarden && rm -rf /tmp/bp-bitwarden
