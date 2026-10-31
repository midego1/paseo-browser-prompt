# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (private vulnerability reporting). Do not open a public issue for
a vulnerability. Include the plugin version or commit, your Paseo version, what you did, and what
happened. You should get a first response within a week.

Do not include real secrets, tokens or private prompts in a report; describe them or use fake values.

## What data goes where

| Data | Where it goes | When |
| --- | --- | --- |
| Prompt text (card steps plus a fixed header) | Clipboard of the device you use | Start in ChatGPT, Copy |
| Prompt text | `https://chatgpt.com/?hints=agent&q=...` in your browser (OpenAI, browser history) | ChatGPT web mode, only when the prompt is short and has nothing that looks like a credential |
| Prompt text | Plugin memory on your Paseo daemon, under a random one-time id, at most 10 minutes; then the ChatGPT app via its `codex://` deep link | ChatGPT app mode |
| Launcher URL `http://<own Tailscale IP or 127.0.0.1>:5299/open?id=<id>` | Your browser; contains no prompt text | ChatGPT app mode |
| Card steps plus a fixed safety preamble | A new agent on your own Paseo daemon, and that agent's model provider (Anthropic by default) | Run with Paseo agent |
| Settings, done marks, card-to-agent links | Paseo host settings on your daemon | Always |
| Updater state, log, commit-only Git history | `~/.local/state/paseo-plugin-browser-prompt/` on the daemon host | Git installs |
| `git ls-remote` / `git fetch` | The `https://` remote the plugin was installed from | Git installs with auto-update on |

The plugin does not read the clipboard, does not log prompt text, and sends no telemetry.

## Design limits

- The launcher listens only on the daemon host's own Tailscale address (100.64.0.0/10) or on
  127.0.0.1, never on 0.0.0.0, a LAN or a public address. Anyone who can reach that address and
  guess a live 18-byte random id within 10 minutes could open that one prompt; ids are single-use.
- Run with Paseo agent starts agents only in ask-first permission modes. The agent acts in your
  Paseo desktop app's browser, where you may be signed in; review each tool approval.
- Self-update installs only fast-forward commits from the `https://` remote the plugin was installed
  from. Installing a plugin means trusting its repository: the server part runs unsandboxed with the
  daemon user's access.
