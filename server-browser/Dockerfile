# Server browser image for the browser-prompt plugin: headless Chromium driven by a pinned
# Playwright MCP (entrypoint.mjs), the filtering proxy its sidecar runs (proxy-main.mjs), and the
# relay of the signed-in Server browser (relay-main.mjs). In signed-in runs the same Playwright MCP
# attaches over the DevTools protocol to the persistent neko Chromium instead. Built
# locally by the plugin on first use (or with `npm run server-browser:image`) and tagged with the
# pinned versions and a hash of the build context, never `latest`. The base image is pinned by
# digest: Playwright 1.65.1 with Chromium revision 1255. @playwright/mcp 0.0.84 runs on the same
# Playwright 1.65.1 through npm overrides in package.json, so it uses exactly that browser.
# Release checklist: bump this base image and the package versions on every plugin release.
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

WORKDIR /opt/browser-prompt
COPY package.json package-lock.json ./
# Exact versions and integrity hashes from the lock file; no install scripts.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY proxy.mjs proxy-main.mjs mcp-filter.mjs entrypoint.mjs relay.mjs relay-main.mjs ./

ENV NODE_ENV=production \
    HOME=/tmp/home \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER pwuser
ENTRYPOINT ["node", "/opt/browser-prompt/entrypoint.mjs"]
