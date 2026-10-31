# Recorder image for scripts/demo: Playwright's Chromium plus ffmpeg (encoding), exiftool (metadata
# check), and pngquant and optipng (the README screenshots; oxipng is not packaged for this Ubuntu).
FROM mcr.microsoft.com/playwright:v1.56.0-noble
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg libimage-exiftool-perl pngquant optipng >/dev/null && rm -rf /var/lib/apt/lists/*
