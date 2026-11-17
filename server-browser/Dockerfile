# Server browser image for the browser-prompt plugin: headless Chromium driven by a pinned
# Playwright MCP, behind a filtering proxy (proxy.mjs). Built locally by the plugin on first use
# (or with `npm run server-browser:image`) and tagged with the pinned versions and a hash of this
# directory, never `latest`. The base image is pinned by digest: Playwright 1.56.0 with Chromium
# 141 (revision 1194), the revision @playwright/mcp 0.0.41 expects.
FROM mcr.microsoft.com/playwright:v1.56.0-noble@sha256:35246d87a7c88ea9b771c65d33171b2611b02a8253b4b12ce6f94376c55f99f2

WORKDIR /opt/browser-prompt
COPY package.json package-lock.json ./
# Exact versions and integrity hashes from the lock file; no install scripts.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY proxy.mjs entrypoint.mjs ./

ENV NODE_ENV=production \
    HOME=/tmp/home \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER pwuser
ENTRYPOINT ["node", "/opt/browser-prompt/entrypoint.mjs"]
