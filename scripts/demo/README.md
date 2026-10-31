# README tour recording

`record.sh` re-records `docs/assets/browser-prompt-tour.mp4` and `docs/assets/browser-prompt-tour.gif`.

```bash
scripts/demo/record.sh
```

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
- A demo workspace (`/tmp/demo-project` inside the container) and one chat are created with the CLI.
- The recorder container (Playwright's Chromium, ffmpeg, exiftool; see `Dockerfile`) joins the
  daemon's network namespace and drives Paseo's bundled web UI headless. Your own Paseo daemon, home
  and browser are never touched.

## Real vs stand-in

The scenes are the real Paseo app and the real plugin: the card, Run with Paseo agent, the
confirmation, the background start, step progress, forwarding the browser agent's question to the
chat, delivering the chat's answer, reporting back, and the settings screen.

The agent outputs are stand-ins. `stand-in-model/` is a demo-only provider plugin (`claude-demo`,
Claude family, so the card accepts it) that answers with fixed text and paced timeline items and
makes no model calls. The browser run does not drive a real browser (a headless web UI has no Paseo
browser host), so its step lines, tool rows, question and report are scripted, and live screenshots
are turned off for the recording. The settings scene is reset to the plugin's defaults off camera, so it shows the real defaults rather than the stand-in provider. A scripted model cannot call the Paseo `send_agent_prompt` tool, so
the stand-in model plugin delivers the chat's answer to the run itself through the plugin SDK. Never
install `stand-in-model/` on a real daemon.

## Files

| File | Role |
| --- | --- |
| `record.sh` | Starts the isolated daemon, installs the plugins, creates the demo chat, records, encodes, cleans up |
| `capture.mjs` | Playwright scenes and captions |
| `overlay.mjs` | Pointer and bottom caption drawn over the app |
| `screencast.mjs` | Chromium screencast frames with timestamps |
| `encode.mjs` | Frames to H.264 MP4 and GIF (under 10 MB), metadata stripped |
| `stand-in-model/` | Demo-only scripted provider plugin |

Adapted from the recording scripts in midego1/kite (`scripts/screenshots`).
