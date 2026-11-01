# Changelog

## 0.13.0 (unreleased)

- The card shows one small line for a "Run with Paseo agent" run under the step progress: the time
  since the run started (including time it waited for the owner) and the last turn's tokens, e.g.
  "Running · 2m 14s" or "Took 3m 02s · last turn: 36 in · 701k cached · 4.6k out". While the run
  starts or runs its icon spins (still with reduced motion) and the time counts up once a second in
  that line only, corrected for a client clock ahead of or behind the daemon's; once it ended the
  line shows the total. Start and end come from the run agent (`createdAt` and the latest timeline
  entry), so they survive a reload; an ended run whose end is unknown (a stopped run, a failed
  read) shows just its state, without a time. Tokens are the daemon's `lastUsage` from the
  timeline read the card already does, shown as reported (input, cached input when non-zero,
  output; never added up); they appear when a turn completes, are cleared while a follow-up turn
  runs, and are missing for runs from before a daemon restart. No cost is shown, no new setting.

## 0.12.0 (unreleased)

- The server hooks (report back, questions, the mode guard) register through `addLifecycleHook`
  (`server/hooks.ts`): `server.addHook` with the new names (`agent.turn.after`, `agent.turn.before`,
  `agent.permission.before`) when the daemon has it, else the deprecated `server.on` names, which
  Paseo removes after 2027-04-30. Daemons up to 0.14.0 have only `on`. Behaviour is
  unchanged: the handlers return at once, report back runs in the background, and unloading the
  plugin removes the hooks. The demo stand-in model does the same.
- The `@getpaseo/plugin` devDependency is now 0.14.0. It only provides types for development; the
  runtime floor stays Paseo 0.11.4 (`requirements.paseo` `>=0.11.4`), since every SDK export the
  plugin uses at runtime exists in 0.11.4 and `addHook` is detected, not required.

## 0.11.0 (unreleased)

- New setting **Close tabs after a successful run** (on by default, also for existing settings;
  settings schema v13). When every numbered step succeeded with no failed, skipped or blocked step
  and nothing left for the owner, the agent closes the browser tabs it opened itself with
  `browser_new_tab`, as its very last action after the last step (and its screenshot) and before
  its report, and names their hosts in the report. Tabs that were open when the run started (it
  lists them first, refining rule 2) stay open, also when the run used them, as do tabs a step says
  to leave open and tabs it cannot tell it opened; any run that falls short leaves every tab open so
  the owner can see where it stopped. Like the other rules this is an instruction in the agent's
  prompt, not enforced: it depends on the provider and model, which may close the wrong tab or none. Closing is not a step: no step marker, no screenshot, so step
  progress and thumbnails are unchanged. Off: the prompt has no close rule, as before.

## 0.10.3 (unreleased)

- Docs: README, OVERVIEW and SECURITY say plainly that the browser-only rule and the secret rules
  are instructions in the agent's prompt, not a tool sandbox, so how well they hold depends on the
  selected provider and model; the permission mode and the mode guard are what the plugin enforces.
- Fix: without "Confirm before starting", two copies of the same block pressed within the second
  before the run record arrives could both start a run. The daemon now keeps an in-flight lock per
  chat and block: only the first press starts a run, a second copy shows that run (or says it is
  starting). A failed start frees the lock at once; a start that never reports back frees it after
  3 minutes, and a started run is named in it for 10 seconds, unless that run has already ended
  (Run again then starts a new one). If the daemon does not answer within 5 seconds, the card
  starts without the lock and logs why.
- Auto-update re-reads the consent and the install's remote right before it installs, so turning
  auto-update off (or the install moving to another repository) while a check runs installs
  nothing. Update now is unchanged.
- `.coderabbit.yaml` for CodeRabbit reviews (chill profile, no PR description summary, lockfile,
  demo scripts and docs media skipped).

## 0.10.2 (unreleased)

- Docs only. README, OVERVIEW and SECURITY describe 0.10.1 as it is: a complete Settings section in
  the order of the settings screen, auto-update off until you consent for the named repository
  (Check now, Update now), repeated blocks as full cards ("Also shown earlier in this chat") with
  done copies collapsed behind Show, the answer-on-card details, and no stale version notes.
- New screenshots: `repeat-done.png` (a done copy opened with Show above a collapsed one),
  `settings-general.png` (with Collapse repeated blocks that are done) and `settings-updates.png`
  (the consent text with Enable auto-update and Not now); `asking.png`, `done.png`,
  `settings-run.png` and `settings-agent.png` re-captured.
- `scripts/demo/record.sh --stills`: `DEMO_PLUGIN_GIT` / `DEMO_PLUGIN_REF` install the plugin over
  Git so the Updates screenshot shows a real Git install, and a second demo chat asks for the same
  steps three times for the repeat screenshot.

## 0.10.1 (unreleased)

- Repeated blocks are full cards again: a later copy of a block that is not done has all its
  buttons and a note, "Also shown earlier in this chat", and shares the first's done mark and run.
  A copy of a done block collapses to "✓ Already done · Show"; Show opens it in place, with Undo
  done. The one-line "↑ Same step as above", the scroll to the first card and its toast are gone
  (scrolling failed in long chats).
- Copies share the newest run of their content in the chat (run records now carry the content key);
  a copy can start a run only while that run is not going, so no duplicate runs.
- The setting is now "Collapse repeated blocks that are done" (same stored value, on by default);
  off shows every copy as a plain full card.

## 0.10.0 (unreleased)

- Self-update needs explicit consent. Auto-update is off by default; the settings screen names the
  Git repository the plugin was installed from and says that newer plugin code from it will be
  downloaded and installed automatically, with **Enable auto-update** and **Not now**. Consent is
  stored with that remote and is void when the install's remote changes. Without consent nothing is
  checked or installed automatically (also on a card's first render, and when settings cannot be
  read); **Check now** only reads the remote, and the new **Update now** installs the commit it names
  only when pressed. Update settings version 2: an `autoUpdate` stored before 0.10.0 (on by default
  then) is turned off and asks again.

## 0.9.1 (unreleased)

- Fix: after the first card started a run, its repeats turned back into full cards (identical blocks
  share a run key). The run record now names the block it was started from, and only that block
  counts the run as its own; records without the name belong to the first card.
- Blocks match only when their key, normalized length and a second, independent hash all match.
- A failed whole-chat read is retried after 2, 8 and 30 seconds instead of leaving every card full
  for the session.
- Less jumping while the chat is read: a block that repeats an earlier block of the same message
  shows as a repeat at once (also for providers without message ids).
- Flash listeners no longer leave empty entries behind.

## 0.9.0 (unreleased)

- Merge repeated blocks (new setting, on by default): a block with the same title and steps as an
  earlier one in the same chat (NFKC, whitespace, line endings, blank lines and step-number spacing
  ignored) shows as one line, "↑ Same step as above", or "✓ Already done" once the first is done.
  Pressing it scrolls to the first card in the web and desktop app (and flashes it), or says to
  scroll up. Repeats have no buttons and never start a run. Which block is first comes from the
  chat's timeline (one read per chat per app session, plus tail reads for new messages), placed by
  message id, so a virtualized list that renders newer cards first does not change the answer.
- Done marks are per block content in a chat (`<agentId>:<key>`); old marks still count and move to
  the new form when their card renders. Settings schema v12.
- Fix: two messages with browser-prompt blocks no longer show the later message's cards in both.
  Card and segment ids now name their message.

## 0.8.1 (unreleased)

- Fix: "Paseo agent needs you" and the answer box now appear on Paseo 0.14. Paseo does not set a
  live agent's `attentionReason` for a pending permission, so the card watches the run's stream for
  `permission_requested` / `permission_resolved` and reads `pendingPermissions` from the run's
  snapshot when it opens a running run, on those events and after an answer.
- Thumbnails fill their tiles: each is a 16:10 window onto the host's fixed 320 px image box
  (`thumbnailFrame`), instead of a small picture centered in a tall empty tile; unclipped when the
  host's box measures differently. Larger tiles: up to 260 px in a row, 180 px in the scroll strip,
  320 px alone.
- browser_keypress text that is more than one key name (typed characters, not Enter or Control+A)
  is masked like typed values.
- README: "How it works" with screenshots of each stage (`docs/screenshots/`); the listing's
  `media` adds three of them after the GIF.
- The tour is re-recorded with the new features: thumbnails per step, a question and a permission
  answered on the card. New X cut `docs/assets/browser-prompt-tour-x.mp4` (1280×720, H.264 High;
  not in the package).
- `scripts/demo`: `record.sh --stills` captures the README screenshots; the stand-in run shows
  stand-in page screenshots (example.com and iana.org rendered by the recorder's own Chromium,
  stored as demo-daemon attachments) and asks the owner a question and a permission. The scenario
  follows example.com as it is today (step 3 opens its "Learn more" link; the agent asks the chat
  before following it to iana.org).

## 0.8.0 (unreleased)

- Answer on the card: when the run waits for the owner (AskUserQuestion or a permission request),
  the card shows the question and its options, or the permission with what it would do (tool,
  command, URL, element, masked typed value, files, plan text), in a warning-bordered box and sends
  the owner's choice with Paseo's `respondToPermission` after Send or Confirm allow. Allow is offered
  only when every input field is shown in full and unaltered; buttons appear only for this card's
  verified run. Free-text answers open
  the run. Only the owner's click answers; nothing is forwarded to the chat.
- `thumbnailLayout` ignores non-finite widths and counts.
- The card's "Paseo agent needs you" status is shown in the theme's warning color.

## 0.7.0 (unreleased)

- One screenshot thumbnail per step on the card, with "Step N" above it and the latest highlighted
  with an accent border. Each screenshot belongs to the step marker before it; the last one per
  step is kept (path strings only, at most 20 steps). The layout follows the card's width: a row
  when all fit, a horizontal scroll strip when some do, the latest alone on very narrow screens.
- New setting **Thumbnails**: All steps (default) or Latest only. Settings schema v11.

## 0.6.6 (unreleased)

- The README tour GIF is the listing's interface image: `media` in `paseo-plugin.json` and in the
  npm package `files` (the MP4 stays out of the package).
- `scripts/demo/record.sh`: copies only committed files into the demo daemon, uses a private work
  directory (mode 700) and runs the recorder as your user instead of opening the directory to
  everyone, pins the Paseo image to the recorded release (`PASEO_VERSION`, default 0.14.0), and
  installs the recorder's dependencies from a lockfile with `npm ci`.

## 0.6.5 (unreleased)

- README tour: `docs/assets/browser-prompt-tour.gif` (linking to the `.mp4`) with captions, recorded
  in the real Paseo web UI against an isolated, throwaway Paseo daemon in Docker. The agents' replies
  are scripted stand-ins from a demo-only provider plugin; `scripts/demo/record.sh` re-records it.

## 0.6.4 (unreleased)

- Paseo cannot capture a browser tab the desktop app is not showing ("The tab has not painted
  yet"), and no plugin API can show the run's tab. Rule 10 now tells the agent to try one
  screenshot and, on that error, take no more for the run (no retry, no question to the owner)
  and note it in its next step line. The card shows a hint that screenshots need the run's browser
  tab visible in the Paseo app.

## 0.6.3 (unreleased)

- Chat-bound text (reports, questions, error text and titles) defuses every `![` left after image
  stripping into `!\[`, so nothing can render as an image there, even with deeply nested alt text
  and a remote URL. Image stripping now also removes images whose alt text holds one level of
  `[...]`. Both stay linear (tested with 100k-character adversarial input).

## 0.6.2 (unreleased)

- Image stripping for chat text and the screenshot checks are linear in their input: alt text no
  longer spans `[`, `<img` tags stop at `<`, attachment paths only match at the start of a token,
  stripping input is cut at 20,000 characters (chat text is cut to 4,000 or 1,500 afterwards) and
  image-message checks skip anything over 4,096 characters. Adversarial input such as 100k
  characters of `![` took seconds before and now takes milliseconds on every path (tested).

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
