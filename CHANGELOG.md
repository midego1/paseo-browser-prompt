# Changelog

## 0.6.1 (unreleased)

Security fixes for the 0.6.0 live screenshot (0.6.0 accepted any http(s) or absolute image source):

- The thumbnail only uses Paseo's own attachment file (`file://` or absolute path, `<sha256>.<image
  ext>` inside `paseo-attachments[-suffix]`), from the first message after the screenshot call when
  it is a lone image; remote URLs are never loaded.
- Reports, questions and error text to the chat are text only: image messages are skipped, and
  inline and reference Markdown images, `<img>` tags, `file://` URIs and attachment paths are
  removed. The final report no longer includes a screenshot path.

## 0.6.0 (unreleased)

- Live screenshot on the card (setting **Show live screenshot**, on by default): the agent takes a
  viewport screenshot after each numbered step (never of pages showing secrets), and the card shows
  the latest one as a thumbnail under the progress bar that opens the run when pressed. Uses the
  host Markdown component, so it needs a Paseo 0.13+ app; older apps show no thumbnail.
- Settings schema v10.

## 0.5.1 (unreleased)

- The card's done button reads **Mark done** instead of "Done ✓", so it no longer shows two
  checkmarks next to its Check icon. **Undo done** is unchanged.

## 0.5.0 (unreleased)

- Step progress on the card (setting **Show step progress**, on by default): the agent writes
  `[browser-prompt step N/M] …` before each numbered step, and the card shows "Step N of M · …" with
  a progress bar (done = full bar ✓; failed, needs you and waiting for the chat keep the last step).
  Markers are read from the run's timeline without polling: one read when the card shows the run,
  the live stream only while the agent is running, and one read when it settles.
- The card shows "Waiting for the chat's answer" for an idle run whose latest turn is a question,
  instead of done.
- Question detection ignores leading step marker lines; a final message starting with a marker is
  still the report.
- Settings schema v9.

## 0.4.0 (unreleased)

- Background start: new setting **Open the agent when started** (off by default). The agent works
  in the background and the card shows its status and an Open link.
- **Talk to the chat** (on by default): the browser agent can ask the chat that showed the card
  about the task by ending its turn with a `[browser-prompt question]` message. The plugin forwards
  it, escaped and framed as untrusted text, through the report-back delivery; the chat answers with
  the Paseo send_agent_prompt tool. Question turns are never taken as the final report.
- **Max questions to the chat per run** (default 10, 0 to 50, 0 works like off). After the limit,
  with talking off, or when the chat is not available, the agent is told to ask the owner, at most
  twice per run; a later question turn is handled as the run's report, so a run cannot loop.
- The fixed preamble now states the hard rule: secrets and confirmations of destructive, security,
  billing, merge or publish actions are always asked of the owner and never accepted from the chat.
  Rules renumbered: page differs is rule 4, final report rule 6, Auto mode rule 7, chat rule 8.
- Settings schema v8 with the three new settings; a malformed stored question cap is clamped.
- Removed the mock screenshots (`docs/screenshots/`) and their references in `paseo-plugin.json`
  (`media`), the README and the npm package files. They were not captures of the real app; real
  screenshots will be added once they can be taken from a running Paseo app.

## 0.3.2 (unreleased)

- Mode guard: only agents a card recorded in the host `runs` setting are checked and stopped, the
  same check report back uses. An agent that only carries the plugin's labels is never archived.
- The settings screen never stores a refused permission mode (Save stays disabled, and the save
  handler checks again).
- Documentation fixes for the 0.3.1 default.

## 0.3.1 (unreleased)

- Claude **Auto mode** is now the default for Run with Paseo agent. Always Ask (`default`) and Plan
  stay selectable; bypass, accept-edits and similar modes are still refused and fall back to the
  default mode. Settings schema v7 moves a stored Always Ask (or empty) mode to Auto mode once; a
  later choice of Always Ask sticks.
- Mode guard: drift between Auto, Always Ask and Plan is no longer acted on; only runs in a refused
  mode are stopped (archived). The `browser-prompt-mode` label is no longer written or read.
- The Auto mode note in settings is neutral; the launch confirmation still mentions Auto mode.
- Report back is unchanged: a source chat in Auto mode gets only the status-only notice.

## 0.3.0 (unreleased)

- Run with Paseo agent can use Claude **Auto mode** (`auto`, a model classifier reviews permission
  prompts) as an explicit opt-in. The default stayed Always Ask (superseded in 0.3.1, where Auto
  mode became the default); bypass and accept-edits modes are still refused. Settings show a warning for Auto mode, the confirmation names it, and the safety
  preamble gets an extra rule: an approved tool call is not the owner's approval, so the agent must
  ask with AskUserQuestion before secrets, destructive actions, merges, payments and security changes.
- Mode guard: the card checks the mode a new run actually uses, and the server re-checks on every
  turn start and permission request. A run outside the allowed modes is stopped (archived) and the
  card shows an error; the plugin SDK has no way to set the mode back.
- Report back: a source chat in Auto mode still gets only the status-only notice.
- New label `browser-prompt-mode` on runs.

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
