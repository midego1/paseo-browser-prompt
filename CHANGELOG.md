# Changelog

## 0.2.0 (unreleased)

- Report back to chat: when a browser agent started from a card finishes or fails, the agent whose
  chat showed the card is told. New setting **Report back to chat**: Auto (default) forwards the
  report only to chats in an ask-first mode and a status-only notice to others; Always forwards it
  to any chat; Off sends nothing.
- Reports are escaped (NFKC, invisible characters removed, every `<` and `>` escaped), fenced and
  framed as untrusted output, capped at 4,000 characters.
- Once per run, persisted across plugin reloads; only runs a card recorded, in the same workspace;
  never to another browser run.
- A busy chat is never interrupted on purpose: deliveries to one chat are serialized and wait until
  it is idle with no pending question or permission, for up to two hours.
- Browser agents carry `browser-prompt-source` and `browser-prompt-card` labels; card run records
  note when the most-recent-workspace fallback was used.
- Settings schema v6: `reportBack` is `auto | full | off` (a v5 boolean migrates to `auto` / `off`).
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
