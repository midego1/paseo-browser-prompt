Browser prompt turns step-by-step browser instructions written by an agent into a card. From the card you can hand the steps to ChatGPT, copy them, mark them done, or have a Paseo agent carry them out in the browser tabs of your own Paseo desktop app.

## What it does

When an assistant message contains a fenced code block whose info string is `browser-prompt` (optionally followed by a title), the message is shown as before and a card appears below each such block. The card shows the title and the steps, with four buttons:

- **Start in ChatGPT** copies the steps to the clipboard with a short header asking ChatGPT to carry them out with computer use, and to stop and ask before entering secrets or confirming destructive actions. It then opens ChatGPT as set in the settings.
- **Copy** copies the same text without opening anything.
- **Mark done** marks the card as finished (**Undo done** reverts it). Done marks are stored on the Paseo host, so every connected app sees them.
- **Run with Paseo agent** starts a new Paseo agent that carries out the steps in the browser tabs of your Paseo desktop app.

A card appears only after the block's closing fence has streamed in. Blocks nested inside another code block are ignored. The README describes the block convention for agents.

## Setup

No account or token is needed. Paseo 0.11.4 or later.

- **ChatGPT web mode** and **Copy only** work everywhere.
- **ChatGPT app mode** (the desktop default) opens the ChatGPT desktop app with the prompt in a new chat (you still press send). It needs the ChatGPT desktop app on macOS or Windows and a small launcher page served by the plugin on the Paseo daemon's host. The launcher binds only to that host's own Tailscale address (100.64.0.0/10, detected with `tailscale ip -4` or from Tailscale's network interface) or, if you set it, to 127.0.0.1 when the Paseo app runs on the same machine. It never binds to 0.0.0.0, a LAN or a public address. Tailscale is optional: without it the launcher stays off and Start in ChatGPT copies the prompt instead. The first time, the browser asks whether to open ChatGPT.
- **Run with Paseo agent** needs the Paseo desktop app open with its browser available, and an enabled Claude provider (or another provider with a known ask-first mode). Claude Auto mode needs Claude Code on the Anthropic API; Paseo refuses it on Bedrock and Vertex.

## What is read and where data goes

- **Clipboard**: Start in ChatGPT and Copy write the prompt to the clipboard of the device you press the button on. Nothing is read from the clipboard.
- **ChatGPT web mode**: opens `https://chatgpt.com/?hints=agent` in your browser. When the prompt is short (under about 1,500 characters as a URL) and contains nothing that looks like a token or key, the prompt is added to that URL as the `q` parameter, so it is sent to OpenAI and can appear in your browser history. Otherwise only the bare URL is opened and you paste the prompt.
- **ChatGPT app mode**: the prompt is sent from the Paseo app to the plugin on your Paseo daemon and kept in memory under a random one-time id for at most 10 minutes. Your browser opens `http://<launcher address>:5299/open?id=<id>`, which does not contain the prompt. That page hands the prompt to the ChatGPT app through its `codex://new?prompt=...` deep link and deletes the id on first use. The prompt then goes to OpenAI when you send it in the ChatGPT app.
- **Run with Paseo agent**: starts an agent on your own Paseo daemon, in the workspace of the agent whose message holds the card (or your most recently active workspace). Its first message is a fixed safety preamble followed by the card's steps, so the steps are sent to that agent's model provider (Anthropic by default). The agent uses only Paseo's browser tools, which act in your Paseo desktop app where you may be signed in to websites.
- **Talk to the chat**: a question of the browser agent (up to 1,500 characters, escaped and marked as untrusted) is sent to the agent whose chat showed the card, so it also reaches that agent's model provider, whatever permission mode that chat uses. Off, or a limit of 0, sends nothing.
- **Report back to chat**: when that agent finishes or fails, a message goes to the agent whose chat showed the card, so it also reaches that agent's model provider. With Auto it holds the browser agent's final message (up to 4,000 characters) only when that chat runs in an ask-first mode; otherwise only the title, outcome and run agent id. The plugin keeps the ids of runs that already reported in `reported-runs.json` in its state directory. Logs contain agent ids only.
- **Settings and state**: start modes, done marks, agent settings and links between cards and started agents are stored as Paseo host settings. The updater keeps a small state file, a log and a commit-only copy of the plugin's Git history in `~/.local/state/paseo-plugin-browser-prompt/`.
- **Updates**: for Git installs from an `https://` remote, the daemon contacts that remote (the repository the plugin was installed from) to check for and install newer commits. Registry installs are updated by Paseo instead.
- Prompt text is never written to logs. The plugin sends no telemetry.

## Run with Paseo agent

The agent starts in Claude **Auto mode** by default: a model classifier, not you, reviews its tool calls. The agent is additionally told that an approved tool call is not your approval and that it must ask you, as a question, before secrets, anything destructive or irreversible, merges, payments and security changes. You can choose Always Ask (`default`, you approve each new tool) or Plan instead; Oh My Pi uses Ask. Bypass, accept-edits and other auto-approve modes are refused, and providers without a known ask-first mode are not started. By default the card asks "Start a Paseo agent to do these steps in your browser?" first and mentions Auto mode. Updating from an earlier version moves a stored Always Ask setting to Auto mode once.

The plugin checks the mode the agent actually runs in, right after starting it and again whenever it starts a turn or asks for a permission. Moving between Auto mode, Always Ask and Plan is fine. A run in a refused mode such as bypass or accept-edits is stopped (archived) and the card shows why.

The safety preamble is always included. It tells the agent to use only the Paseo browser tools (no shell commands, no file edits, no browser on the server), to stop and ask before typing any secret, before anything destructive or irreversible and whenever the page differs from the steps, never to repeat secret values shown on a page, and to finish with a summary of what it did and what is left for you. Secrets and confirmations of destructive, security, billing, merge or publish actions are a hard rule that no setting changes: they are always asked of you, never of the chat.

With **Show step progress** (on by default) the agent writes a short line as it starts each numbered step, and the card shows "Step N of M" with what it is doing and a progress bar; done fills the bar, and failed, needs you or waiting for the chat keep the last step. The card reads these lines from the agent's own chat; nothing extra is sent anywhere.

With **Show live screenshot** (on by default) the agent takes a screenshot of the visible page after each step, never of a page that shows a password, token or code, and the card shows one thumbnail per step with "Step N" above it, the latest highlighted: side by side when the card is wide enough, as a horizontal strip otherwise, and only the latest on very narrow screens (or always, with **Thumbnails** set to Latest only). Pressing a thumbnail opens the agent. Screenshots stay in your Paseo app and are never sent to a chat. Each screenshot is also read by the agent's model, which adds to its token use; turn the setting off to save tokens. The thumbnail needs a Paseo 0.13 or later app. Paseo can only capture a browser tab your app is showing, so a run in the background usually gets no screenshot: it tries once, stops taking them for that run, and the card says that the run's browser tab must be visible (for example in a split next to the chat).

When the agent needs you (a question it asks you, or a permission it needs), the card says so in the warning color and shows the question and its options, or the permission with Allow and Deny, so you can answer right on the card. A free-text answer opens the agent. Only your click answers; these questions are never sent to the chat.

By default the agent starts in the background: the card shows its state (running, needs you for a question or permission, done, failed) with a link to open it. Turn on **Open the agent when started** to open its view right away.

**Talk to the chat** (on by default) lets the agent ask the chat that showed the card about the task itself, for example which of two buttons to use, which value to fill in, or how to go on when the page differs from the steps. The agent ends its turn with the question, the plugin forwards it to that chat marked as untrusted text that may come from web pages, and that chat's agent answers by sending a message to the browser agent. A run asks at most 10 questions by default (0 to 50 in settings; 0 works like off); after that, when talking is off, or when the chat is not available, the agent asks you instead. If it keeps asking the chat anyway, its third such turn is treated as its final report. Questions never count as the final report.

**Report back to chat** tells the chat that showed the card when the agent finishes or fails, so that chat's agent can continue with the result. It has three settings:

- **Auto** (default): the full report when that chat runs in an ask-first permission mode (Claude Always Ask or Plan, Oh My Pi Ask). For any other mode, including bypass and auto-approve modes and providers without a known ask-first mode, only a short notice that the run finished or failed, without any text from the web pages; open the run agent to read its report.
- **Always send the full report**: also to chats that act without your approval. The report can contain text from web pages, so a page could try to steer that agent.
- **Off**: nothing is sent.

The report is escaped, fenced and marked as the browser agent's untrusted output, not your instructions. It is sent once per run, only for runs a card recorded, never to a browser agent itself, and not at all when the original chat no longer exists. When that chat's agent is busy or waiting for your answer, the report waits up to two hours for it to be idle and is dropped after that. Only the latest run of a card reports.

## Updates

For Git installs, the plugin checks the branch it was installed from when a card is first shown in an app session and when you press a card button, at most once every 30 minutes (**Check now** skips that limit). It installs a newer commit only when the remote is `https://` and the commit is a fast-forward of the installed one; anything else is reported in settings and left for you. Auto-update can be turned off in settings. The daemon is never restarted.

## Settings

- Start in ChatGPT on desktop (ChatGPT app, ChatGPT web, or copy only) and on iOS and Android (copy only or ChatGPT web).
- ChatGPT app deep link template (default `codex://new?prompt={prompt}`), and clearing done marks.
- Run with Paseo agent: confirm before starting, open the agent when started, show step progress, show live screenshot, thumbnails (all steps or latest only), report back to chat (Auto, Always, Off), talk to the chat, max questions to the chat per run, provider, model, permission mode, thinking level, and clearing card-to-agent links.
- ChatGPT launcher: status, bind address (empty means the detected Tailscale address) and port (default 5299).
- Updates: auto-update on use, installed and latest commit, last check, Check now, and an optional branch to follow.

The Command Center has **Open last browser prompt in ChatGPT**.

## Limits

- The prompt is always copied first, so you can paste it if ChatGPT or the launcher page cannot be opened.
- ChatGPT computer use requires the ChatGPT desktop app on macOS or Windows with computer use enabled. ChatGPT documents no mobile deep link for a new prompt.
- The ChatGPT web URL parameters are not officially documented and may change.
- Run with Paseo agent needs the Paseo desktop app open; on Paseo 0.11 and 0.12 the card's message text uses a compact built-in Markdown renderer.
