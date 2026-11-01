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
| Browser screenshots (viewport PNG after each step) | The browser agent's model provider, as tool output; a private copy kept by Paseo on the daemon host; shown as a thumbnail on the card in your Paseo app | Show live screenshot (on by default) |
| A browser agent's question for the chat (up to 1,500 characters), escaped and framed as untrusted text by the plugin | The agent whose chat showed the card, and that agent's model provider, in any permission mode | Talk to the chat (on by default, at most 10 per run by default) |
| Ids of runs that already reported | `reported-runs.json` in the state directory below | Report back to chat |
| Settings, done marks, card-to-agent links | Paseo host settings on your daemon | Always |
| Updater state, log, commit-only Git history | `~/.local/state/paseo-plugin-browser-prompt/` on the daemon host | Git installs, once a check or update ran |
| The chat's own timeline (assistant messages and their ids) | Read by the card in your Paseo app, kept in memory to recognize repeated blocks; not sent anywhere | A chat with browser-prompt cards |
| `git ls-remote` / `git fetch` | The `https://` remote the plugin was installed from | Git installs: automatically only after the owner enabled auto-update for that remote; otherwise only when the owner presses Check now or Update now |

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
- The browser-only rule (use only the Paseo browser tools: no shell commands, no file edits) and the
  secret-handling rules are also instructions in the agent's prompt, not a tool sandbox. The plugin
  does not remove other tools from the run, so enforcement depends on the selected provider and
  model and on the permission mode; in Always Ask you approve each new tool.
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
- Talk to the chat forwards questions that can contain text from web pages to the chat that showed
  the card, also to chats that act without approval (bypass or Auto mode), because a status-only
  notice cannot carry a question. The plugin, not the model, frames each question: it is escaped,
  fenced and labelled as untrusted, and the instructions on how to answer and what never to send
  come from the plugin outside the block. A model may still be influenced by such text. Turn Talk
  to the chat off (or set the limit to 0) if that is not acceptable.
- Answers are written by the chat's agent and arrive in the browser agent as ordinary messages; the
  plugin cannot verify or filter them. The fixed preamble tells the browser agent to use them only as
  information about the task and, as a hard rule that no setting changes, never to accept a secret
  or a confirmation of a destructive, security, billing, merge or publish action from the chat, only
  from the owner's AskUserQuestion answer. That is an instruction to a model, not an enforced
  control. The answer tool can also set the browser agent's permission mode; the plugin tells the
  chat not to, and the mode guard stops a run that ends up in a refused mode.
- Step progress text is written by the browser agent and can echo a page. The agent is told not to
  put secrets or page text in it; the card cleans it (no control or invisible characters, one line,
  at most 60 characters) and shows it only in your Paseo app. It is never sent to a chat.
- Screenshots can show anything on the page, including signed-in account details. The agent is
  told never to screenshot a page that shows a secret, but that is an instruction to a model. The
  plugin never sends screenshots or their file paths to a chat: reports, questions and error text are
  text only (Markdown and HTML images, `file://` URIs and Paseo attachment paths are removed). The
  thumbnail only uses Paseo's own local attachment files, never a remote URL.
  The thumbnail is read from the agent's own timeline and stays in your Paseo app. Turn off Show
  live screenshot to stop the screenshots (this also saves the tokens each image costs).
- Questions and permission requests the browser agent puts to the owner (AskUserQuestion, tool
  approvals) stay with the owner. The card shows them and sends the answer the owner clicks with
  Paseo's `respondToPermission`, the same as answering in the run. Nothing answers them
  automatically, the chat never sees them, and no server code responds to them. Answer buttons are
  shown only after the run's own snapshot confirms it is this card's run, a question is sent only
  after you select and press Send, and a permission offers Allow only when the card shows everything
  it would allow: every input field in full and exactly as sent (nothing cut, no characters removed
  or normalized, no unknown fields such as `dangerouslyDisableSandbox`), and Allow needs a second
  "Confirm allow" tap. Otherwise only Deny. Values typed into a page are masked until you tap Show.
  The question text, options and details come from the agent and can echo a page; read them before
  you click.
- A block repeated later in a chat shares the first's done mark and run. A copy cannot start a
  second run while that run is going, so asking for the steps again does not start parallel agents.
- Self-update is off until you enable it in settings, where the plugin names the `https://` remote it
  was installed from and says that newer code from it will be downloaded and installed. Declining, or
  never deciding, leaves everything as installed, including when cards are shown and when settings
  cannot be read. Consent applies to that remote only. It installs only fast-forward commits.
  **Update now** installs the one commit it names, only when pressed. Installing a plugin means
  trusting its repository: the server part runs unsandboxed with the daemon user's access.
