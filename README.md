# Browser prompt for Paseo

A [Paseo](https://paseo.sh) plugin that renders a card with **Start in ChatGPT**, **Copy**, **Mark done**
and **Run with Paseo agent** for every `browser-prompt` block in an assistant message.

- **Run with Paseo agent** starts a browser agent in the background (Claude Auto mode by default,
  with a fixed safety preamble). The card shows "Step N of M", a screenshot per step, and the run's
  state; questions and permissions for you are answered right on the card.
- The browser agent can ask the chat that showed the card about the task (**Talk to the chat**), and
  tells that chat when it finishes or fails (**Report back to chat**: the full report to chats in an
  ask-first mode, a status-only notice otherwise).
- A block the agent repeats later in the chat is a full card that shares the first's done mark and
  run; once done, later copies collapse to "✓ Already done · Show".
- No auto-update without your consent: it is off until you enable it for the named repository.

[![Browser prompt tour: a card in the chat, a background Paseo agent with step progress and a screenshot per step, a question to the chat, a question and a permission answered on the card, the report coming back, and the settings](docs/assets/browser-prompt-tour.gif)](docs/assets/browser-prompt-tour.mp4)

The tour is recorded in the real Paseo app with this plugin installed; the agents' replies and the
run's page screenshots are stand-ins ([how it is made](scripts/demo/README.md)).
[MP4 version](docs/assets/browser-prompt-tour.mp4).

See [OVERVIEW.md](OVERVIEW.md) for what it does, what data goes where, and its limits, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## How it works

The screenshots below are the real Paseo app with this plugin. The agent text and the run's page
screenshots (real example.com and iana.org pages) are demo stand-ins; see
[how they are made](scripts/demo/README.md). The settings named here are under Settings → Plugins →
Browser prompts.

**1. The card.** Every `browser-prompt` block in an agent's reply becomes a card. **Start in
ChatGPT** copies the steps and opens ChatGPT, **Copy** only copies them, **Mark done** marks the
card done on this host, and **Run with Paseo agent** starts a Paseo browser agent (after a
confirmation, **Confirm before starting**).

![The card: the steps with Start in ChatGPT, Copy, Mark done and Run with Paseo agent](docs/screenshots/card.png)

**2. Running in the background.** The agent works in the background and the card shows its state
with an Open link (**Open the agent when started** opens it right away instead). "Step N of M" and
the bar follow the agent's step lines (**Show step progress**), and a screenshot per step appears
under it with its step number, the latest highlighted (**Show live screenshot**, **Thumbnails**).
A small line under the progress shows the run time (counting up with a spinning icon while it runs,
the total once it ended) and, once a turn has finished, its input and output tokens, for example
"Took 3m 02s · 701k in · 4.6k out".

![Running: Step 3 of 4 with a progress bar and thumbnails for steps 1, 2 and 3](docs/screenshots/running.png)

The same card in the dark theme:

![The running card in the dark theme](docs/screenshots/running-dark.png)

**3. Asking the chat.** When the page differs from the steps, the agent may ask the chat that
showed the card. The plugin forwards the question marked as untrusted text, and the card says
"Waiting for the chat's answer" until the chat replies (**Talk to the chat**, **Max questions to
the chat per run**). Secrets and risky approvals are never asked of the chat.

![Waiting for the chat's answer, and the forwarded question in the chat](docs/screenshots/asking.png)

**4. The agent needs you.** A question for you or a permission request appears on the card. Tap an
option and press **Send answer**. A permission shows exactly what it would allow (typed text masked
until you tap Show) and needs **Confirm allow**; when the card cannot show all of it, it offers only
Deny and Open run. **Permission mode** decides how often the agent asks.

![The agent needs you: a question with its options, one selected, and Send answer](docs/screenshots/needs-you-question.png)

![A permission request: Browser navigate with its URL, and Confirm allow](docs/screenshots/needs-you-permission.png)

**5. Done, and the report.** The card shows done ✓, and the chat gets the run's report as untrusted
data (**Report back to chat**: Auto sends the full report to a chat in an ask-first mode and a
status-only notice otherwise).

![Done: the card's done status, the report back in the chat, and the chat's reply](docs/screenshots/done.png)

**6. Repeated blocks.** When the agent writes the same steps again later in the chat (for example
when you ask for them again), the copy is a full card with "Also shown earlier in this chat"; it
shares the first's done mark and run, and does not start a second run while one is going. Once the
steps are done, later copies collapse to "✓ Already done · Show", and Show opens the card in place
(**Collapse repeated blocks that are done**).

![A copy of a done block opened with Show, with "Also shown earlier in this chat", above another copy collapsed to "✓ Already done · Show"](docs/screenshots/repeat-done.png)

**7. Settings.** Each behavior above is a setting (see [Settings](#settings) for the full list).

![Settings: Start in ChatGPT, the deep link, Collapse repeated blocks that are done, and Done marks](docs/screenshots/settings-general.png)

![Settings: Run with Paseo agent options](docs/screenshots/settings-run.png)

![Settings: the agent's provider, model, permission mode and thinking](docs/screenshots/settings-agent.png)

**8. Updates.** Auto-update is off. For a Git install, the Updates section names the repository the
plugin was installed from and says that, once enabled, newer plugin code from it is downloaded and
installed automatically; **Enable auto-update** or **Not now**. **Check now** only reads the
repository, and **Update now** installs the commit it names when you press it.

![Settings: Updates, with the repository, the consent text, Enable auto-update and Not now](docs/screenshots/settings-updates.png)

## Install

From the Paseo plugin registry, once listed:

```bash
paseo plugin add midego1/browser-prompt
```

Directly from Git:

```bash
paseo plugin add git:midego1/paseo-browser-prompt
# pin a branch, tag or commit
paseo plugin add git:midego1/paseo-browser-prompt --ref main
```

Auto-update is off. In settings, under Updates, the plugin shows the repository it was installed
from and offers **Enable auto-update** (newer commits from that repository are then downloaded and
installed when the plugin is used) or **Not now**; **Check now** and **Update now** work by hand.

`paseo plugin add` and `paseo plugin install` are aliases. The plugin has no runtime npm
dependencies and no build step. Paseo 0.11.4 or later; thumbnails need a Paseo 0.13 or later app.
Tailscale on the daemon host is needed only for the ChatGPT desktop app launcher; everything else
works without it.

## Settings

Settings → Plugins → Browser prompts, in the order shown there. All are host settings, so every
connected app shares them.

**Browser prompts**

| Setting | Default | What it does |
| --- | --- | --- |
| Start in ChatGPT (desktop) | ChatGPT app | ChatGPT app (through the launcher), ChatGPT web, or Copy only. The prompt is always copied first. |
| Start in ChatGPT (iOS and Android) | Copy only | Copy only, or ChatGPT web. ChatGPT documents no mobile deep link for a new prompt. |
| ChatGPT app deep link | `codex://new?prompt={prompt}` | `{prompt}` is replaced by the encoded prompt; only `codex:` and `https:` are accepted. Save and Reset to default. |
| Collapse repeated blocks that are done | on | A later copy of a block in the chat is a full card with "Also shown earlier in this chat"; once done, copies collapse to "✓ Already done · Show". Off: every copy is a plain full card. |
| Done marks | – | How many cards are marked done on this host; Clear removes all marks. |

**Run with Paseo agent**

| Setting | Default | What it does |
| --- | --- | --- |
| Confirm before starting | on | Asks before starting the agent; says when it will run in Auto mode. |
| Open the agent when started | off | Off: the agent works in the background; the card shows its status (running…, needs you, done ✓, failed) and an Open link. On: its view opens right away. |
| Show step progress | on | The agent marks each numbered step as it starts it (`[browser-prompt step N/M] …`); the card shows "Step N of M · …" with a progress bar. |
| Show live screenshot | on | The agent takes a viewport screenshot after each numbered step (never of pages showing secrets); the card shows them as thumbnails under the progress bar. Needs a Paseo 0.13+ app to show them. |
| Thumbnails | All steps | All steps: one thumbnail per step with "Step N" above it and the latest highlighted, side by side when the card is wide enough, a horizontal strip otherwise, the latest alone on very narrow screens. Latest only: just the newest screenshot. |
| Close tabs after a successful run | on | When every step succeeded, the agent closes the browser tabs it opened itself (with `browser_new_tab`) as its last action and names their hosts in its report. Tabs that were open before the run, tabs a step says to leave open and tabs it is unsure about stay open; a run that fails, stops or needs you leaves every tab open. In Always Ask mode you approve the close like any other new tool. An instruction in the agent's prompt, not enforced: it depends on the provider and model, which may close the wrong tab or none. |
| Talk to the chat | on | The agent may ask the chat that showed the card about the task; the plugin forwards each question framed as untrusted text (see below). |
| Max questions to the chat per run | `10` | Whole number from 0 to 50; 0 works like Talk to the chat off. After the limit the agent asks you. |
| Report back to chat | Auto | Auto, Always send the full report, or Off (see below). |
| Provider | `claude` | Paseo provider id; only providers with a known ask-first mode are started. |
| Model | `claude-sonnet-5-5` | Model id, or `provider/model`. |
| Permission mode | `auto` | Claude: `auto` (Auto mode, a model classifier reviews tool calls; the default), `default` (Always Ask) or `plan`. Oh My Pi: `ask`. Bypass, accept-edits and other modes are refused and fall back to the default mode. |
| Thinking | `high` | Thinking level passed to the provider. |
| Reset agent settings to default | – | Provider, model, mode and thinking back to the defaults above. |
| Agent links on cards | – | How many cards remember a started agent; Clear forgets them. |

**ChatGPT launcher**

| Setting | Default | What it does |
| --- | --- | --- |
| Status | – | Whether the launcher runs, its address and port. |
| Bind address | empty | Empty: this machine's Tailscale IPv4 (detected). Otherwise only this machine's own Tailscale address or 127.0.0.1; never 0.0.0.0 or a LAN address. |
| Port | `5299` | The launcher's port. |

**Updates** (Git installs)

| Setting | Default | What it does |
| --- | --- | --- |
| Enable auto-update / Not now | off | Names the repository the plugin was installed from; once enabled, newer plugin code from it is downloaded and installed when the plugin is used. Consent counts for that repository only. While on: Turn off. |
| Installed, Latest seen, Last check | – | The installed commit and branch, the newest commit seen, and the last check's time and result. |
| Update now | – | Shown when a newer commit is known: installs that commit from that repository, only when pressed. |
| Check for updates now | – | Reads the newest commit of the followed branch; installs nothing unless auto-update is on. |
| Follow branch | inferred | The branch to follow; empty means the branch the install was made from. |

Local installs say the plugin does not update itself; npm and registry installs are updated by
Paseo.

## Convention for agents

When the human must do something in a browser, write a fenced code block with the
info string `browser-prompt`, optionally followed by a short title on the same line:

````markdown
```browser-prompt Add the DEPLOY_TOKEN secret
1. Open https://github.com/acme/webshop/settings/secrets/actions
2. Click "New repository secret".
3. Name: DEPLOY_TOKEN. Value: ask me for it (do not guess).
4. Click "Add secret".
```
````

Rules:

- One block per independent task; several blocks per message are fine.
- Number the steps and include full URLs.
- Refer to secrets by name only. Never put a secret value in the block.
- Close the fence. The card appears only once the closing fence is written.
- Blocks inside another code block (for example a ````markdown example) are ignored.

## Safe defaults

- The ChatGPT launcher binds only to this machine's own Tailscale address (100.64.0.0/10) or, when
  set explicitly, 127.0.0.1. Wildcards, LAN, public addresses and host names are refused; without a
  usable address the launcher stays off and Start in ChatGPT only copies.
- Launcher links carry a random one-time id (18 bytes), expire after 10 minutes and are deleted on
  first fetch. The prompt is never in the launcher URL, and prompt text is never logged.
- ChatGPT web mode puts the prompt in the `chatgpt.com` URL only when it is short and has nothing
  that looks like a credential.
- Run with Paseo agent starts Claude agents in Auto mode by default (a model classifier reviews tool
  calls), or in Always Ask or Plan when you choose them, and always prepends the fixed safety
  preamble. Bypass and accept-edits modes are refused, and a run that ends up in one is stopped.
- The preamble's rules (only the Paseo browser tools, ask before secrets and risky actions) are
  instructions to the model, not a tool sandbox: whether they are followed depends on the selected
  provider and model. Always Ask lets you approve each new tool yourself.
- Links in rendered messages open only when they are http(s) URLs; the ChatGPT app deep link may
  use only the `codex:` or `https:` scheme.
- No telemetry. No download or install without the owner: auto-update is off until the owner enables
  it for the named `https://` remote the plugin was installed from, and then installs only
  fast-forwards of the installed commit on the tracked branch.

## Development

```bash
npm ci
npm run typecheck
npm test                     # unit tests (parser, card logic, launcher, updater, agent prompt, report back)
paseo plugin install "$PWD"  # first time
paseo plugin reload browser-prompt
paseo plugin logs browser-prompt
```

Dependencies are pinned to exact versions and locked in `package-lock.json`. They are all
development or host-provided modules (Paseo supplies `@getpaseo/plugin`, React, React Native,
TanStack Query and zod at runtime).

## Internals

Layout: `shared/browser-prompt.ts` (pure parser, transformer output, URL plan, deep link
and trampoline page), `shared/settings.ts` (host settings), `shared/trampoline.ts` (stash
RPC), `server/trampoline.ts` + `server/launcher.ts` (one-time launcher on this machine's Tailscale
IP, port 5299), `client/` (card, markdown fallback, launch actions, settings screen, agent run), `shared/agent-prompt.ts`
(agent safety preamble, prompt builder, config defaults), `index.client.tsx`, `index.server.ts`.

Start in ChatGPT (desktop default): copy prompt, RPC stashes it under a one-time id
(10 min TTL, deleted on first fetch), Paseo opens `http://<tailscale-ip>:5299/open?id=...`,
the page does `location.replace("codex://new?prompt=...")`. Prompt text is never logged.
Check the bind with `ss -ltnp | grep 5299`.

Launcher address (`shared/trampoline-host.ts`, `server/launcher.ts`): the `trampolineHost` setting
(accepted only when it is 127.0.0.1 or a Tailscale address assigned to this machine, otherwise the
launcher stays off with `not-local`), else `tailscale ip -4` (3 s timeout), else a non-internal
address in 100.64.0.0/10 on a Tailscale interface (`tailscale*`, `utun*`), else none: the
listener is not started (never 0.0.0.0) and `trampoline.stash` returns
`{ unavailable: "no-tailscale" }`, so the client copies and shows "ChatGPT launcher needs Tailscale
on this host". `trampolinePort` defaults to 5299; EADDRINUSE reports `port-in-use`. Host or port
changes restart the listener. The client only uses the URL the server returns.

## Repeated blocks

Agents often repeat a block they wrote earlier in the same chat, for example when asked for the
steps again. Every copy is a full card with working buttons; a later copy says "Also shown earlier
in this chat" and shares the first's done mark and run. Once the block is done, later copies
collapse to "✓ Already done · Show", and Show opens the card right there (with Undo done). Nothing
scrolls the chat: in a long chat the first card may not even be rendered.

Setting: **Collapse repeated blocks that are done** (on; stored as `mergeRepeats`). Off: every copy is
a plain full card.

- **Same block** (`blockKey` in `shared/repeats.ts`): title and steps NFKC-normalized, line endings
  unified, whitespace collapsed, blank lines dropped, and step numbers written as `N. ` (`1.Open`,
  `1.   Open` and `1) Open` match); case and everything else count. The key is `k1-` plus a 53-bit
  hash (cyrb53) of that text (`shared/block-key.ts`). The chat index also keeps the normalized
  length and a second, independent hash (FNV-1a 32), and two blocks match only when all three do.
- **Which one is first**: a timeline renderer gets only its own item (no position, and every card
  of a chat gets the same `timestamp` from Paseo), so the transformer puts the message's id
  (`messageId`) in each card, and `client/chat-index.ts` reads the chat's timeline once per app
  session (newest page first, up to 25 pages of 200 entries) to learn every message's place
  (`seqStart`) and blocks. A card is placed by its own message, so the answer does not depend on
  which cards a virtualized list renders first. A card whose message is not known yet (a new message)
  shows in full and triggers a tail read (at most every 1.5 s). A block that repeats an earlier block
  of the same message is marked by the transformer (`sameAs`) and shows as a repeat at once, also
  before the read and for providers without message ids; other blocks of providers that give no
  message id keep a full card. A failed whole-chat read is retried after 2, 8 and 30 seconds.
- **Views** (`repeatView`): the first block is a plain full card; a later copy of a block that is not
  done is a full card with the hint; a later copy of a done block is one line until Show. Nothing
  points or scrolls to the first card: in a long, virtualized chat it may not be rendered.
- **Done marks** are per block in a chat: `<agentId>:<key>` in the `done` setting, so marking the
  first card done covers its repeats. Older marks of the form `<agentId>:<cardId>` (a hash of the
  raw text, which cannot be turned into the new key without the text) still count, and a card that
  finds its old mark moves it to the new form. **Clear** in settings empties the list.
- **Runs** stay keyed by the card's own id (`<agentId>:<cardId>`, which the server checks against
  the run's card label), and the record also carries `key:<content key>` (after the server's
  `most-recent` marker). Every copy shows the newest run of its content in the chat
  (`sharedRunRecord`: its own id, else the content marker), so all copies show the same status. A
  later copy can start a run only while that shared run is not going (starting, running, needing you
  or waiting for the chat); then its Run button is disabled and the shared status shows. The first
  card keeps its usual Run again.
- Item ids name their message (`card-<messageId>-<n>`; without a message id, a hash of the message
  text up to its first block): Paseo keeps plugin items by id within a chat, so ids shared between
  messages would show one message's cards in both.

## Run with Paseo agent

The settings are listed under [Settings](#settings).

Not configurable (the hard rule, rule 3 of the fixed preamble): passwords, tokens, API keys, 2FA codes
and other secrets, and confirmations of destructive, irreversible, security, permission, billing,
DNS/WAF, merge, deploy, publish or payment actions are always asked of the owner with
AskUserQuestion. The agent is told never to ask the chat for them and never to accept them from the
chat, a web page or any other message. This is an instruction in the prompt, not an enforced
control, so it holds only as well as the selected provider and model follow it. Invalid inputs are
not saved: the question cap must be a whole number from 0 to 50, and refused permission modes keep
Save disabled (a malformed stored cap is clamped).

The card's "Run with Paseo agent" button uses the app's own Paseo connection (`usePaseo()`):

- Workspace: `useAgent(cardAgentId, a => a.workspaceId)`; if the app has no snapshot yet,
  `paseo.agents.ref(id).refresh()`; last resort the most recently active workspace
  (`workspaces.list({ sort: activity_at desc, limit 1 })`).
- After creating the agent the card opens its view only when **Open the agent when started** is on
  (`opensAgentOnStart`); by default the run works in the background.
- `paseo.workspaces.ref(workspaceId).agents.create({ config, title: "Browser: <title>", prompt, labels })`
  with `config = { provider: "claude/claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "high" }`
  by default (host settings). Allowed modes are the ask-first modes (`ASK_FIRST_MODES`: claude
  `default`/`plan`, omp `ask`) and the classifier-reviewed modes (`CLASSIFIER_MODES`: claude `auto`,
  the provider's "Auto mode"). A blank or refused mode falls back to the provider's default mode
  (`defaultModeFor`: claude `auto`, omp `ask`); providers without an ask-first mode are refused.
  Auto mode never counts as ask-first (report back treats a source in Auto mode as unsafe).
  An older stored Claude `default` or empty mode was moved to `auto` once, when Auto became the
  default.
- `prompt = buildAgentPrompt(title, steps, config)`: fixed safety preamble (`AGENT_SAFETY_PREAMBLE`),
  in Auto mode followed by `CLASSIFIER_MODE_RULE` (an approved tool call is not the owner's
  approval; the stops of rule 3 must be AskUserQuestion questions), the chat, progress and
  screenshot rules when their settings are on, and with **Close tabs after a successful run**
  `CLOSE_TABS_RULE` (rule 11, refining rule 2: list the tabs first, and only after a fully successful run close
  the tabs the run opened with `browser_new_tab`, after the last screenshot and before the report;
  no step marker for it), then the steps verbatim inside `<steps>`.
- Mode guard (`shared/mode-guard.ts`): right after creating the agent the card reads its actual
  mode (`refresh()`, a few tries until it is reported). The server checks again whenever a run's
  turn starts or it requests a permission (`server/mode-guard-hook.ts`), but only for agents a card
  recorded in the host `runs` setting (`readRecordedRun`, polled up to 10 seconds, as for report
  back); labels alone never get an agent archived. Drift between allowed
  modes (`runModeAllowed`: claude `auto`, `default`, `plan`) is ignored. A refused mode (bypass,
  accept-edits, ...) is set back if the SDK has a mode setter; the plugin SDK (0.11 to 0.14) has
  none, so the run is stopped by archiving it, and the card shows the error. The settings screen
  keeps Save disabled for a refused mode (`agentModeError`), so none is ever stored.
- The card remembers `<agentId>:<cardId> -> startedAgentId` in host settings (plus `"most-recent"`
  when the run started outside the card agent's workspace, then `key:<content key>` so copies of the
  block share the run; a save that loses a revision race is retried against the newest settings)
  and shows the
  status from `useAgent(startedAgentId, …)`. Timeline renderers get no `navigation`, so
  "Open" opens the plugin screen `agent-run`, which calls `navigation.openAgent` once.
  Screens get no client-state provider on Paseo 0.11, so screen code must not use
  `useAgent`/`useWorkspace` (they throw "Plugin state hooks must run inside a workspace
  panel"); `test/screen-hooks.test.mjs` checks every registered screen's import graph.
- Labels (`shared/report-back.ts` `runLabels`): `browser-prompt: run`,
  `browser-prompt-source: <card agent id>`, `browser-prompt-card: <card id>`.
- Nothing is appended to timelines and prompt text is never logged.

### Report back to chat

The server hooks (`server/hooks.ts` `addLifecycleHook`) register with
`server.addHook("agent.turn.after" | "agent.turn.before" | "agent.permission.before")` when the
daemon passes `addHook`, else with the deprecated `server.on("agent.turn_ended" | "agent.turn_started" |
"agent.permission_requested")`, which is removed after 2027-04-30. Both deliver the same payload and
the daemon does not wait for either. Daemons up to Paseo 0.14.0 and their plugin SDKs have only `on`;
`addHook` comes with the next plugin SDK (0.15 beta), and daemons that have it get it without a new
plugin release.

Setting **Report back to chat** (host setting `reportBack`): `auto` (default), `full` or `off`.
Settings that cannot be read or are invalid count as `auto`, never `full`. An old boolean value
migrates `true` to `auto` and `false` to `off`. `server/report-back-hook.ts` registers
the turn-ended hook; the handler returns at once and `server/report-back.ts` delivers in
the background, because Paseo cancels hook requests after 30 seconds and their `signal` with them.
Plugin cleanup aborts every pending wait through the plugin's own `AbortController`.

Which runs report:

- Canceled turns never report. Labels are read with `paseo.agents.ref(id).refresh()`; an agent
  without the run label is skipped for 60 seconds, then read again, since labels can change. Only
  `browser-prompt: run` agents with both `browser-prompt-source` and `browser-prompt-card` labels
  are considered.
- The run must be listed in the host `runs` setting under `<source>:<card>`, which only the card
  writes (polled for up to 10 seconds, since the card saves it right after creating the agent).
  Run and source must be in the same workspace unless that entry records the most-recent fallback.
  Running a card again replaces its entry, so only the latest run of a card reports.
- No report goes to a missing or archived source, to a source that is itself a browser run, or to
  the run itself, so reports cannot loop. Skips log agent ids only.
- Once per run: run ids are claimed before delivery, also across concurrent events, and persisted
  (last 200) in `reported-runs.json` in the plugin's state directory, because the server's settings
  handle is read-only. A delivery that sent nothing (busy timeout, RPC error, failed send) releases
  the claim once, so a later turn of that run can retry; a second failure keeps it claimed.

What is sent:

- `auto` and a source in a known ask-first mode (`ASK_FIRST_MODES`; unknown providers or modes count
  as unsafe), or `full`: `[browser-prompt] Browser agent "<title>" finished|failed. Run agent id:
  <id>.`, a note that the block is the browser agent's untrusted report and not the owner's
  instructions, then `<browser-agent-report>` … `</browser-agent-report>` holding the error (for a
  failed run) and the report, then a closing reminder. All of that text is NFKC-normalized,
  stripped of zero-width, bidi and control characters, and every `<` and `>` is escaped.
- `auto` and any other source: a status-only notice with no page-derived text (title, outcome and
  run agent id only).
- The report is the turn's final assistant message (from the event's timeline when present, else
  the last 60 timeline items), cut to 4,000 characters on a line or word boundary with a note.

Delivery:

- Sends to one source are serialized. Each waits until the source is idle with no active turn and no
  pending permission or question (`waitForFinish` in slices of at most 5 minutes, at least 1 second
  apart while the source stays busy; `permission` keeps waiting and re-checks every 15 seconds),
  re-reads the source right before sending, and gives up without sending 2 hours after the report
  was queued (time spent behind other reports for the same source counts).
- Every Paseo `send` clears pending permissions of the target (a steered message denies them), and
  by default a send replaces a running turn. That is why the report waits until the source is
  settled. It is sent with `activeTurnBehavior: "steer"`: on an idle agent this starts a normal
  turn. In the milliseconds between the last read and the send, the owner could start a turn; the
  report is then steered into that turn (providers with steering, Claude included, unless the turn
  is a slash command, is compacting or has no live query, in which case Paseo replaces it), and a
  permission that turn had just raised would be denied.
- A permission request or an AskUserQuestion of the browser agent does not message the source; the
  card shows "Paseo agent needs you" and lets the owner answer there (see Answer on the card).

### Step progress

With **Show step progress** on (default), the card counts its steps (`countSteps`: numbered lines
`1.`/`2)`, indented sub-items excluded; else non-empty lines) and the run's prompt gets rule 9: before
each numbered step, write one plain line `[browser-prompt step N/M] <at most 60 characters>`. It is
ordinary assistant text, not a message to the chat, and does not end the turn.

- The card reads the markers without polling (`useAgent`, the card's status source, has no message
  text): one tail read of the run's timeline (`timeline.refetch`, last 40 items) when the card shows
  the run, also for finished runs so a waiting question can be told from a report (skipped for
  stopped runs; redone if a dependency change cancels it); the live timeline stream
  (`timeline.subscribe`) only while the agent's own status is running or initializing; and one more
  tail read when a live run settles, because its idle status can arrive before the stream's
  `turn_completed`. An idle run that this card session did not just start is shown as done.
- The pure `createRunTracker` (`shared/run-tracker.ts`) holds this state: the latest marker (a new
  message id starts a new line, so a marker is never glued to the previous message) and whether the
  latest turn's final message is a question still waiting for the chat. After `MAX_REDIRECTS`
  redirect notices in the run's timeline a question turn is the run's report, so it is not shown
  as waiting.
- `latestStep` takes the last well-formed marker at a line start; N is clamped to 1..M, the card's own
  count is M (the run's M is ignored), malformed markers are skipped. The text is NFKC-normalized,
  stripped of control and invisible characters, kept on one line and cut at 60 characters. It is
  rendered as plain React Native text.
- View (`stepProgressView`): running shows "Step N of M · text" and the bar at N/M; done shows a full
  bar and done ✓; failed, needs you and asking the chat keep the last step with that status.
- An idle run whose latest turn ended with a question for the chat is shown as "Waiting for the
  chat's answer" instead of done (the hook tracks the current turn's text from the same stream).
- Step markers never affect report back: question detection ignores leading marker lines (a
  question after them is still a question), and a final message that starts with a marker followed
  by anything else is the run's report.

### Run time and tokens

Under the step progress the card shows one line for the run, `RunStatsRow`
(`client/run-stats-row.tsx`, formats and derivation in `shared/run-stats.ts`):
"Running · 2m 14s · 18.4k in · 950 out" while it runs, "Took 3m 02s · …" (or "Failed after",
"Stopped after") once it ended. No setting; it shows whenever the card shows a run.

- Time comes from the run agent's own data, so it survives a reload: the start is the agent's
  `createdAt` (`useAgent`), the end of a run that ended is the timestamp of the latest entry from
  the card's existing tail read of the timeline, else the agent's `updatedAt` (which later changes,
  such as archiving, also move). While the run starts, runs or waits for the owner the time counts
  up: one 1-second interval in that row only (not the card), cleared when the run ends or the row
  unmounts.
- The icon spins (`LoaderCircle`, React Native `Animated`) only while the run is starting or
  running, not while it needs the owner, is done, failed or stopped. With reduced motion
  (`AccessibilityInfo.isReduceMotionEnabled`, prefers-reduced-motion on the web) it stays still.
- Tokens are the daemon's `lastUsage` on the agent snapshot that the same tail read returns
  (`timeline.refetch` includes the agent; `useAgent`'s snapshot has no usage). "in" is
  `inputTokens + cachedInputTokens`, "out" is `outputTokens`. The daemon fills these when a turn
  completes (while streaming it only keeps context-window fields), so tokens appear when the run's
  turn ends; for a run with a follow-up turn they are that turn's. The daemon keeps `lastUsage` in
  memory only: a run from before a daemon restart shows its time but no tokens. Cost
  (`totalCostUsd`) is never shown.
- The run screen (`client/run-screen.tsx`) only hands off to Paseo's agent view and has no agent
  state on Paseo 0.11 (screen code must not use `useAgent`, see above), so the line is on the card
  only.

### Live screenshot

With **Show live screenshot** on (default), the run's prompt gets rule 10: after each numbered step,
call `browser_screenshot` once with `fullPage: false`; never screenshot a page that shows a password,
token, API key, 2FA or recovery code or other secret (skip it and say "screenshot skipped").

- Where the image comes from: Paseo's browser_screenshot returns a PNG as an MCP image block; the
  Claude provider stores a private copy on the daemon host and emits an assistant message
  `![Image](file:///<tmp>/paseo-attachments-<random>/<sha256>.png)` right after the tool call. The
  timeline has no separate image item.
- `createScreenshotTracker` (`shared/screenshot.ts`) only looks at the first assistant message after
  a `browser_screenshot` call, and only when that message is a lone image. `safeImageSource` accepts
  only Paseo's attachment shape: a `file://` URI or absolute path whose file is
  `<64 hex>.<png|jpg|jpeg|webp|gif>` directly inside a `paseo-attachments[-suffix]` directory; no
  http(s) or other schemes, no query or fragment, no traversal (segments are decoded first). The
  source is passed on unchanged, in the form Paseo's own renderer gets. Each screenshot belongs to
  the step whose `[browser-prompt step N/M]` marker came last before it (N clamped to the card's M;
  step 0 before any marker); a later screenshot in the same step replaces the earlier one. Path
  strings only, never image data, at most 20 steps per card (least recently captured dropped). It
  is fed by the same timeline read and live stream as step progress (the stream also passes the step
  it read from its buffer, for markers split across chunks; a newer tail read keeps earlier steps it
  no longer reaches), so it updates while the run works and stays after it is done.
- The card shows them with the host `Markdown` component (`@getpaseo/plugin/client/ui`, Paseo 0.13+),
  the renderer Paseo uses for these image messages in an agent's own chat, each in a pressable frame
  with "Step N" above it that opens the run (accessibility label "Screenshot after step N"); the
  latest has an accent border. `thumbnailLayout` picks the layout from the card's measured width
  (`onLayout`): a row when every step fits at 140 to 260 px, a horizontal scroll strip of 180 px
  thumbnails when at least two fit but not all (readable step order, swipeable on phones), and the
  latest alone (up to 320 px) when the card is narrower than two thumbnails, when there is one
  screenshot, or with Thumbnails set to Latest only. The plugin API has no other way to show a
  daemon-side image, so on older apps no thumbnail is shown.
- The host's Markdown shows an image in a 320 px tall box with `contain`, which leaves a narrow
  screenshot small in a tall empty tile. Each thumbnail is therefore a 16:10 window onto that box
  (`thumbnailFrame`): the frame is the screenshot's height at the tile's width and the box is moved
  up by half the difference, so the picture fills the tile (another window shape loses or gains a
  thin strip). When the host content measures differently (another Paseo version), the thumbnail
  shows the host's rendering unclipped.
- Paseo's browser only captures a tab the desktop app is showing: a screenshot of a hidden tab
  fails with "The tab has not painted yet". No browser tool or plugin API can make a hidden tab
  paint or show the run's own tab (`browser_new_tab` always opens in the background;
  `navigation.openBrowser` only creates and focuses a new tab, on Electron, and timeline cards get
  no `navigation`). So rule 10 tells the agent to try once and, on that error, take no more
  screenshots in the run (no retry, no question to the owner) and note
  "(screenshots off: tab not visible)" in its next step line. Browser tool errors arrive as a
  completed call whose output carries the error text; `isUnpaintedScreenshot` recognizes it and the
  card shows a hint that screenshots need the run's browser tab visible in the Paseo app.
- Screenshots never reach a chat. `finalAssistantText` skips image-only messages, and the shared
  chat escape (`escapeUntrusted`, used for reports, questions and error text) runs
  `stripImagesForChat` after NFKC normalization: inline Markdown images (titles, escaped brackets
  and parentheses, `<…>` destinations), reference-style images and image or file reference
  definitions, `<img>` tags, `file://` URIs and paths into `paseo-attachments` are removed or
  replaced by `[file omitted]`. The preamble no longer asks for a screenshot path in the report.
  Any `![` left after that is defused to `!\[` (also in report and question titles), so nothing in
  chat-bound text can render as an image. Alt text may hold one level of `[...]`.
  These patterns are linear and their input is capped (20,000 characters for stripping, 4,096 for
  image-message checks); `test/perf.test.mjs` runs 100k-character adversarial input through every
  chat-text and card path.

### Answer on the card

When the run waits for the owner (an AskUserQuestion or a permission request; the card says
"Paseo agent needs you" in the theme's warning color), the card shows the request itself in a
warning-bordered box:

- Paseo does not mark a running agent that waits for a permission (its `attentionReason` is only
  set for finished and error), so the card watches the run's live stream for `permission_requested`
  and `permission_resolved` (`shared/run-tracker.ts`). `useOwnerPrompts` (`client/owner-prompt.tsx`)
  reads the run's `pendingPermissions` with `paseo.agents.ref(run).refresh()` while the run is
  active: when the card opens it, on each of those events and on status changes, and after an
  answer. The card says "needs you" when the stream shows an open request or the snapshot has one. Answer buttons appear only when that same snapshot carries this card's run
  labels (`verifiedRun`: `browser-prompt: run`, this card's chat as source, this card's id);
  otherwise the box offers **Answer in run** only. `ownerPrompts` (`shared/owner-prompt.ts`) turns
  the requests into prompts: questions with their header, text and options (at most 4 questions
  and 8 options; text NFKC-normalized, invisible and control characters removed, capped), or
  permissions. Claude permission requests have no title or description, so the card shows the
  request's input and Paseo's tool-call detail as plain text (`permissionDetails`): the tool name
  humanized, command and script as scrollable monospace blocks (up to 2,000 characters and 30
  lines), URL, files and values (up to 1,000), element, key, click options, search, purpose,
  timeout and scroll; for ExitPlanMode the plan text (up to 6,000, scrollable) and the plan's
  actions in full. Values typed into a page (browser_fill, browser_type) are masked as
  "•••• (N chars)" until the owner taps Show.
- Allow is offered only when the card shows everything it would allow: every non-empty input field
  is rendered (only `browserId`, the tab id, is hidden on purpose; any other key, for example
  `dangerouslyDisableSandbox` or `run_in_background`, withholds Allow), nothing was cut, and
  nothing was altered for display (`cleanPromptTextInfo` reports NFKC changes, removed invisible,
  bidi or control characters, and collapsed whitespace). Otherwise the card offers only Deny and
  **Open run**, and says so.
- The owner answers with clicks: a tap on an option only selects it and **Send answer** sends it;
  Allow on a permission asks for **Confirm allow** first; Deny is immediate. The answer goes to the run with the SDK's
  `respondToPermission`: questions as `{ behavior: "allow", updatedInput: { answers } }` keyed by
  each question's full text (several choices joined with ", "), permissions with the pressed
  action's behavior and `selectedActionId`. **Other answer: open run** / **Open run** opens the run
  for free text or anything the card does not show.
- Only the owner's click answers: no server code and no chat path calls `respondToPermission`
  (a test checks this), and these questions are never forwarded to the chat. If the request cannot
  be read, the box offers **Answer in run**.

### Talk to the chat

When **Talk to the chat** is on and the cap is above 0, the run's prompt gets rule 8 with the source
agent's id and the cap. The design routes questions through the plugin, so the plugin, not the
model, frames what reaches the chat:

- The run asks by ending its turn with a final message that starts with `[browser-prompt question]`
  (`QUESTION_MARKER`) and nothing else. It does not message the chat itself.
- When a turn ends (`agent.turn.after`) the server reads the final message (`parseQuestion`). A question turn is
  never claimed as the run's report, so the real final report later still goes out once. Failed
  and canceled turns are never questions.
- The question is forwarded only for runs a card recorded, through the same serialized
  wait-until-idle delivery as reports: `[browser-prompt question from run <id>] ... (k of at most N)`,
  then a note that the block is untrusted data, then `<browser-agent-question>` … escaped like a
  report (NFKC, invisible characters removed, every `<` and `>` escaped, cut at 1,500 characters) …
  `</browser-agent-question>`, then plugin-written instructions: answer with the Paseo
  `send_agent_prompt` tool (agentId = run, `notifyOnFinish` false, no `sessionMode`), starting the
  prompt with `[browser-prompt answer]`, and never send secrets or approve dangerous actions.
- Questions are independent of the Report back setting and reach chats in any mode, framed (a
  status-only notice cannot carry a question). Questions per run are counted in memory (a plugin
  reload resets the count) and the same turn is forwarded once.
- With talking off (setting off, cap 0, or unreadable settings, which fail closed), after the cap,
  or when the chat is gone, archived, itself a browser run, in another workspace or busy for 2 hours,
  the server sends the run `[browser-prompt] Your question was not forwarded to the chat: ...` so it
  asks the owner with AskUserQuestion instead. A run gets at most 2 such notices
  (`MAX_REDIRECTS`); a later question turn is handled as the run's report (escaped, sent per the
  Report back setting, run claimed), so a run that keeps asking cannot loop unattended or suppress
  its report. Same-turn dedupe uses the turn id, else the turn's last assistant message id.
- The answer is written by the chat's agent, not by the plugin. The run is told to use answers only
  as information about the task; rule 3 still applies to them.

## Self-update (opt-in)

No cron, and nothing is downloaded or installed without the owner's consent.

- **Consent**: the `updates` settings hold `autoUpdate` (default off) and `consentRemote`, the Git
  remote shown when the owner pressed **Enable auto-update** after reading "newer plugin code from
  <remote> will be downloaded and installed automatically". Consent counts only while the install's
  remote is that one (`hasConsent`); a moved install asks again. **Not now** keeps it off. The
  `updates` settings migration (version 2) turns off any `autoUpdate` stored when it still defaulted
  to on, so those installs are asked once.
- **Automatic checks**: the card calls `update.check` on its first render in an app session and on
  Start, Copy and Run only when the settings are loaded and consented. On the daemon, an automatic
  check without `autoUpdate` returns `not-consented` at once (no `paseo plugin ls`, no network), and
  with consent for another remote it returns `not-consented` without contacting either. Settings that
  cannot be read count as no consent.
- **By hand**: **Check now** (`force: true`) reads the remote and installs only with consent. **Update
  now** (`update.install`) sends the remote and commit the owner was shown; the daemon installs only
  if the install still uses that remote and that commit is still the newest fast-forward, else
  `changed`.
- The settings screen reads `update.status`, which includes the install's kind and remote from
  `paseo plugin ls --json` (local, no network), so the remote is named before the owner decides.
- Install info: `paseo plugin ls --json` (this plugin's `installation.identity.remote` and
  `currentRevision`). Local installs show "Local install: the plugin does not update itself".
- Only `https://` remotes (the one the plugin was installed from); Git runs with
  `-c protocol.allow=never -c protocol.https.allow=always`, no terminal prompts.
- Latest: `git ls-remote --symref <remote> HEAD 'refs/heads/*'` (10 s timeout, no prompts).
  Paseo stores only the installed commit, not the ref, so the followed branch is inferred: the
  branch whose tip is the installed commit (previous choice, then default branch), else the
  previously followed branch, else the default branch. "Follow branch" in settings overrides it.
- Fast-forward only: a commit-only (`--filter=tree:0`) bare copy of the remote in
  `~/.local/state/paseo-plugin-browser-prompt/history.git` is fetched for the tracked branch and
  `git merge-base --is-ancestor <installed> <latest>` must succeed; otherwise the result is
  `not-fast-forward` and nothing is installed.
- Apply: detached `/bin/sh -c '"$1" plugin update "$2" --ref "$3" --yes; rm -f "$4"'` in its own
  session, output in `~/.local/state/paseo-plugin-browser-prompt/update.log`; the plugin's reload
  does not kill it, and the daemon is never restarted.
- Guards: in-process flag plus `update.lock` (O_EXCL, stale after 10 min); one remote check per
  30 minutes (in memory and in `state.json` next to the lock). Server code cannot write host
  settings in Paseo 0.11, so the toggles live in the `updates` settings document and the check
  state in that file.
- Logic and tests: `shared/updater.ts`, `test/updater.test.mjs`.

Switch an install to follow another branch: `paseo plugin update browser-prompt --ref <branch> --yes`
(the updater then follows that branch).
Update log: `~/.local/state/paseo-plugin-browser-prompt/update.log`.
