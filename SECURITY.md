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
| The browser agent's final report (up to 4,000 characters), escaped and framed as untrusted output | The agent whose chat showed the card, and that agent's model provider | Report back to chat: Auto (default) only when that chat runs in an ask-first mode, or Always |
| Title, outcome and run agent id only | The agent whose chat showed the card | Report back to chat: Auto, when that chat runs in any other mode |
| Ids of runs that already reported | `reported-runs.json` in the state directory below | Report back to chat |
| Settings, done marks, card-to-agent links | Paseo host settings on your daemon | Always |
| Updater state, log, commit-only Git history | `~/.local/state/paseo-plugin-browser-prompt/` on the daemon host | Git installs |
| `git ls-remote` / `git fetch` | The `https://` remote the plugin was installed from | Git installs with auto-update on |

The plugin does not read the clipboard, does not log prompt text, and sends no telemetry.

## Design limits

- The launcher listens only on the daemon host's own Tailscale address (100.64.0.0/10) or on
  127.0.0.1, never on 0.0.0.0, a LAN or a public address. Anyone who can reach that address and
  guess a live 18-byte random id within 10 minutes could open that one prompt; ids are single-use.
- Run with Paseo agent starts Claude agents in **Auto mode by default**. The agent acts in your
  Paseo desktop app's browser, where you may be signed in. In Auto mode a model classifier, not you,
  approves its tool calls, including clicks and form submissions on those sites. The safety preamble
  tells the agent to ask you as a question before secrets, destructive or irreversible actions,
  merges, payments and security changes, but that is an instruction to a model, not an enforced
  control: a misbehaving model, or a web page that manipulates it, could act without asking, and the
  classifier may approve it. Set the permission mode to `default` (Always Ask) to approve every new
  tool yourself; review each approval there.
- The plugin checks the mode a run actually uses and stops (archives) runs in a refused mode
  (bypass, accept-edits and similar). Only agents a card recorded as its run are checked, so an
  agent that copies the plugin's labels is never archived by it. Moving between Auto, Always Ask and Plan is not acted on.
  Stopping takes a moment after the agent starts or changes mode, so a few tool calls can happen
  before it.
- Report back to chat can forward the browser agent's report, which can echo text from web pages,
  to the agent that showed the card. The report is escaped, fenced and labelled as untrusted
  output, but a model may still be influenced by it. Auto (the default) therefore forwards it only
  to chats in a known ask-first mode and sends a status-only notice to every other chat. An
  ask-first mode does not mean the agent cannot act on its own: allow rules you configured for that
  provider (for example always-allowed tools or commands) still run without asking, so a report
  could lead to those actions. **Always send the full report** removes that check; use it only if
  you accept that a web page could steer an agent that acts without approval.
- Only runs a card recorded in host settings report, so an agent that copies the plugin's labels
  cannot use them to message another chat. Anyone who can change this plugin's host settings can
  still add such a record.
- Self-update installs only fast-forward commits from the `https://` remote the plugin was installed
  from. Installing a plugin means trusting its repository: the server part runs unsandboxed with the
  daemon user's access.
