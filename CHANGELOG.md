# Changelog

## 0.2.0 (unreleased)

- Report back to chat: when a browser agent started from a card finishes or fails, its final report
  (up to 4,000 characters, framed as untrusted output) is sent to the agent whose chat showed the
  card. Once per run, only for agents the plugin started, never to another browser run, and it
  waits for a busy agent instead of interrupting it. New setting **Report back to chat**, on by default.
- Browser agents carry `browser-prompt-source` and `browser-prompt-card` labels.
- Card status labels: running…, needs you (question or permission), done ✓, failed.

## 0.1.0 (unreleased)

First public release.

- Cards for `browser-prompt` blocks with Start in ChatGPT, Copy, Done and Run with Paseo agent.
- ChatGPT desktop app launcher bound only to the host's own Tailscale address or 127.0.0.1;
  one-time ids, prompt never in the launcher URL or logs.
- Run with Paseo agent: ask-first permission modes only (per-provider allow-list), fixed safety
  preamble always included.
- Self-update on use for Git installs: `https://` remotes only, fast-forward only on the tracked
  branch.
- MIT license, security policy, listing overview and screenshots; dependencies pinned and locked.
