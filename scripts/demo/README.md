# README tour and screenshots

`record.sh` re-records the tour: `docs/assets/browser-prompt-tour.mp4`, the README GIF
`docs/assets/browser-prompt-tour.gif` (at most 5 MB) and the X cut
`docs/assets/browser-prompt-tour-x.mp4` (1280×720, H.264 High, yuv420p, faststart, no audio; the
16:10 recording centered on a light background, at most 140 s and 15 MB). With `--stills` it
captures the README screenshots in `docs/screenshots/` instead (PNG at 2×, cropped to the card or
setting, palette-reduced with pngquant, recompressed with optipng, all metadata chunks stripped,
each at most 250 KB).

```bash
scripts/demo/record.sh            # the tour
scripts/demo/record.sh --stills   # the screenshots
# the Updates screenshot needs a Git install of a pushed branch:
DEMO_PLUGIN_GIT=midego1/paseo-browser-prompt DEMO_PLUGIN_REF=<branch> scripts/demo/record.sh --stills
```

With `DEMO_PLUGIN_GIT` (owner/repo) and `DEMO_PLUGIN_REF`, the demo daemon installs the plugin from
that GitHub repository over HTTPS instead of from this checkout, so the Updates settings name a real
repository and show the consent text. Without them the Updates screenshot shows a local install.
For the repeat screenshot, `--stills` also creates a second demo chat in its own workspace and asks
it for the same steps three times; the stills mark the first card done, open the second copy with
Show and capture it above the collapsed third.

It needs Docker (rootless is fine) and network access to pull `ghcr.io/getpaseo/paseo` and the
Playwright image. The Paseo image is pinned to the release the tour was recorded with
(`PASEO_VERSION`, default `0.14.0`); set `PASEO_VERSION` or `PASEO_IMAGE` to record against another.
Only committed files of this checkout are installed into the demo daemon, so commit changes to the
plugin or `stand-in-model/` first. Frames and outputs go to a private work directory (mode 700,
`DEMO_WORK` to choose it); the recorder runs as your user (`--user` on regular Docker; on rootless
Docker the container's root already is your user). Its dependencies are installed with `npm ci` from
`package-lock.json`.

## What runs where

- An isolated, throwaway Paseo daemon in a container (`browser-prompt-demo-daemon`): the official
  image, its own home inside the container, no published ports (it listens on 127.0.0.1 inside its
  own network namespace), relay off, host name `demo-host`. It is removed when the script ends.
- This checkout of the plugin is installed into that daemon, plus `stand-in-model/`.
- Stand-in page screenshots are rendered first (`stand-ins.mjs`, see below) and copied into the
  daemon's attachment form: `/tmp/paseo-attachments-demo/<sha256>.png` (directory 700, files 600),
  listed in `/tmp/browser-prompt-demo-stand-ins.json` for the stand-in model.
- A demo workspace (`/tmp/demo-project` inside the container) and one chat are created with the CLI.
- The recorder container (Playwright's Chromium, ffmpeg, exiftool; see `Dockerfile`) joins the
  daemon's network namespace and drives Paseo's bundled web UI headless. Your own Paseo daemon, home
  and browser are never touched.

## Real vs stand-in

The scenes are the real Paseo app and the real plugin: the card, Run with Paseo agent, the
confirmation, the background start, step progress and the per-step thumbnails, forwarding the
browser agent's question to the chat, delivering the chat's answer, the owner's question and
permission answered on the card (Send answer, Confirm allow), reporting back, and the settings
screen.

The agent outputs are stand-ins. `stand-in-model/` is a demo-only provider plugin (`claude-demo`,
Claude family, so the card accepts it) that answers with fixed text and paced timeline items and
makes no model calls. The browser run does not drive a real browser (a headless web UI has no Paseo
browser host), so its step lines, tool rows, questions, permission request and report are scripted.
Its screenshots are stand-ins too: `stand-ins.mjs` renders real pages (example.com, the same page
with its first paragraph selected, and iana.org's Example Domains page) in the recorder's own
headless Chromium, and the stand-in model shows them the way Paseo shows a tool's image, so the card
renders them as it renders a real run's screenshots. The scenario follows example.com as it is
today (one paragraph and a "Learn more" link). The run holds a state for 2.5 s in the tour and 15 s
for the stills, long enough to capture it. The settings scene is reset to the plugin's defaults off camera, so it shows the real defaults rather than the stand-in provider. A scripted model cannot call the Paseo `send_agent_prompt` tool, so
the stand-in model plugin delivers the chat's answer to the run itself through the plugin SDK. Never
install `stand-in-model/` on a real daemon.

## Files

| File | Role |
| --- | --- |
| `record.sh` | Starts the isolated daemon, installs the plugins, renders the stand-in screenshots, creates the demo chat, records or captures, encodes, cleans up |
| `setup.mjs` | Opens the demo app and points the plugin at the stand-in model (shared, not filmed) |
| `stand-ins.mjs` | Renders the stand-in page screenshots under their SHA-256 names |
| `capture.mjs` | Playwright scenes and captions of the tour |
| `stills.mjs` | The README screenshots, cropped to the card or setting (light theme, one dark) |
| `optimize.mjs` | pngquant + optipng, metadata stripped, 250 KB limit, metadata dump |
| `overlay.mjs` | Pointer and bottom caption drawn over the app |
| `screencast.mjs` | Chromium screencast frames with timestamps |
| `encode.mjs` | Frames to the H.264 MP4, the X cut and the GIF (at most 5 MB), metadata stripped |
| `stand-in-model/` | Demo-only scripted provider plugin |

Adapted from the recording scripts in midego1/kite (`scripts/screenshots`).
