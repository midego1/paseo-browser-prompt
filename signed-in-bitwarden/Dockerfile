# Bitwarden variant of the browser-prompt signed-in Server browser image. Built by the plugin only
# after the owner's explicit two-press consent in its settings (Signed-in Server browser ›
# Bitwarden), on top of the plugin's own signed-in image (BASE_IMAGE, built from signed-in/), and
# tagged with a hash of both build contexts, never `latest`.
#   - install-bitwarden.py downloads the Bitwarden Password Manager release pinned in bitwarden.json
#     from Bitwarden's GitHub releases, refuses it unless size and SHA-256 match, packs it unchanged
#     into a CRX with a key made for this build (deleted right after), and puts the CRX and a local
#     update manifest (file://, the same version) read-only in /opt/bitwarden.
#   - policy-overlay.json plus the install script: Chromium force-installs exactly that extension
#     from the local manifest (it never updates it from anywhere) and blocks every other one
#     (ExtensionInstallBlocklist "*", developer mode off, types and install sources locked, no
#     external extensions, the Chrome Web Store blocked); chrome-extension:// pages are not blocked
#     by URL (Bitwarden's inline menu frames use per-session dynamic ids no allowlist entry can
#     name; the agent is kept off them by the plugin's filters); Chromium's password manager and
#     autofill stay off; DevTools stay allowed for the plugin's lock check (never the agent's).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY bitwarden.json policy-overlay.json install-bitwarden.py /tmp/bp-bitwarden/
RUN python3 -I /tmp/bp-bitwarden/install-bitwarden.py /tmp/bp-bitwarden && rm -rf /tmp/bp-bitwarden
