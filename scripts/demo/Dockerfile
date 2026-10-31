# Recorder image for scripts/demo: Playwright's Chromium plus ffmpeg (encoding) and exiftool (metadata check).
FROM mcr.microsoft.com/playwright:v1.56.0-noble
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg libimage-exiftool-perl >/dev/null && rm -rf /var/lib/apt/lists/*
