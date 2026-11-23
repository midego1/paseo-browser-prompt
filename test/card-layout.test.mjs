// Run: npm test. The 0.24 card layout: which buttons show in which state, phone versus chat column,
// no Send to Claude on phones, Run once in… rows, the default ways, and the theme tints.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardLayout,
  cardPhase,
  cardTints,
  chatGptTarget,
  defaultRunWay,
  DEFAULT_CARD_CHOICES,
  isDarkColor,
  markRunStopped,
  mixColor,
  ownerStopState,
  runStoppedByOwner,
  STOPPED_RUN_MARKER,
  stopRecordedRun,
  stopRefusal,
  progressSegments,
  runMenuItems,
  sentNote,
} from "../shared/card-layout.ts";

const layout = (phase, { mobile = false, compact = false, expanded = false } = {}) => cardLayout({ phase, mobile, compact, expanded });

test("the state area: a going run wins over a done mark; a finished run or a mark folds the card", () => {
  assert.equal(cardPhase({ runState: null, done: false }), "new");
  assert.equal(cardPhase({ runState: "starting", done: false }), "running");
  assert.equal(cardPhase({ runState: "running", done: true }), "running", "Stop stays reachable on a marked card");
  assert.equal(cardPhase({ runState: "needs-input", done: false }), "needs-you");
  assert.equal(cardPhase({ runState: "asking", done: false }), "needs-you");
  assert.equal(cardPhase({ runState: "done", done: false }), "done");
  assert.equal(cardPhase({ runState: null, done: true }), "done");
  for (const state of ["failed", "stopped", "unknown"]) assert.equal(cardPhase({ runState: state, done: false }), "ended", state);
  assert.equal(cardPhase({ runState: "failed", done: true }), "done");
});

test("new: Run is the filled button, both Send buttons show in the chat column, Copy and Mark done stay quiet", () => {
  const view = layout("new");
  assert.deepEqual(
    { run: view.showRun, primary: view.runPrimary, label: view.runLabel, gpt: view.showSendChatGpt, claude: view.showSendClaude, ownRow: view.sendOwnRow },
    { run: true, primary: true, label: "Run", gpt: true, claude: true, ownRow: false },
  );
  assert.equal(view.showSteps, true);
  assert.equal(view.showWatch || view.showStop || view.showNeedsPanel || view.showFoldToggle, false);
  assert.equal(view.showQuietRow, true);
});

test("phone: the Send buttons get their own row, and there is no Send to Claude (no Claude app there)", () => {
  const phone = layout("new", { mobile: true, compact: true });
  assert.equal(phone.sendOwnRow, true);
  assert.equal(phone.showSendChatGpt, true, "ChatGPT stays");
  assert.equal(phone.showSendClaude, false);
  // A desktop window in the compact layout still has the Claude app.
  const narrowDesktop = layout("new", { mobile: false, compact: true });
  assert.equal(narrowDesktop.showSendClaude, true);
  assert.equal(narrowDesktop.sendOwnRow, true);
  // An iPad (iOS, wide layout): the row stays inline, still no Claude.
  const ipad = layout("new", { mobile: true, compact: false });
  assert.equal(ipad.showSendClaude, false);
  assert.equal(ipad.sendOwnRow, false);
});

test("running and needs you: no Run and no Send, but Watch and Stop; needs you adds the panel", () => {
  for (const phase of ["running", "needs-you"]) {
    for (const mobile of [false, true]) {
      const view = layout(phase, { mobile, compact: mobile });
      assert.equal(view.showRun, false, phase);
      assert.equal(view.showSendChatGpt, false, phase);
      assert.equal(view.showSendClaude, false, phase);
      assert.equal(view.showWatch, true, phase);
      assert.equal(view.showStop, true, phase);
      assert.equal(view.showSteps, true, phase);
      assert.equal(view.showQuietRow, true, phase);
    }
  }
  assert.equal(layout("running").showNeedsPanel, false);
  assert.equal(layout("needs-you").showNeedsPanel, true);
});

test("done: folded without steps or Send, Run again unfilled; Show steps brings them back", () => {
  const folded = layout("done");
  assert.equal(folded.showSteps, false);
  assert.equal(folded.showSendChatGpt, false);
  assert.equal(folded.showSendClaude, false);
  assert.equal(folded.showRun, true);
  assert.equal(folded.runPrimary, false, "no filled button in a done card");
  assert.equal(folded.runLabel, "Run again");
  assert.equal(folded.showFoldToggle, true);
  assert.equal(folded.showStop, false);
  const open = layout("done", { expanded: true });
  assert.equal(open.showSteps, true);
  assert.equal(open.showSendChatGpt, true);
  assert.equal(open.showSendClaude, true);
  assert.equal(layout("done", { expanded: true, mobile: true, compact: true }).showSendClaude, false, "never on a phone");
});

test("ended (failed, stopped): Run again is filled again, Send is back, no Stop", () => {
  const view = layout("ended");
  assert.equal(view.runPrimary, true);
  assert.equal(view.runLabel, "Run again");
  assert.equal(view.showSendChatGpt, true);
  assert.equal(view.showStop, false);
});

test("Run's default: the card setting, else a browser usual way, else the Paseo browser; never signed in unless chosen", () => {
  for (const usual of ["app", "web-agent", "copy-only", "claude-desktop"]) {
    assert.equal(defaultRunWay(DEFAULT_CARD_CHOICES, usual, true), "paseo", `usual way ${usual}: no credentialed browser by default`);
  }
  for (const way of ["paseo", "server", "signed-in", "chrome"]) assert.equal(defaultRunWay(DEFAULT_CARD_CHOICES, way, true), way, `usual way ${way} keeps working`);
  assert.equal(defaultRunWay({ runWay: "signed-in" }, "app", true), "signed-in", "the owner chose it");
  assert.equal(defaultRunWay({ runWay: "server" }, "paseo", true), "server", "the card setting wins");
  assert.equal(defaultRunWay({ runWay: "chrome" }, "app", false), "paseo", "no Claude provider: the Paseo browser, not signed in");
  assert.equal(defaultRunWay({ runWay: "chrome" }, "signed-in", false), "paseo", "a saved Chrome choice never turns into the signed-in browser");
  assert.equal(defaultRunWay(DEFAULT_CARD_CHOICES, "chrome", false), "paseo");
  assert.equal(defaultRunWay({ runWay: "" }, "server", false), "server");
});

test("Send to ChatGPT: the card setting, else today's usual ChatGPT way; phones never use the app", () => {
  assert.equal(chatGptTarget(DEFAULT_CARD_CHOICES, "app", false), "app");
  assert.equal(chatGptTarget(DEFAULT_CARD_CHOICES, "web-agent", false), "web-agent");
  assert.equal(chatGptTarget(DEFAULT_CARD_CHOICES, "copy-only", false), "copy-only");
  assert.equal(chatGptTarget(DEFAULT_CARD_CHOICES, "signed-in", false), "app", "an agent usual way: the desktop app, as the Command Center did");
  assert.equal(chatGptTarget({ chatGpt: "web-agent" }, "app", false), "web-agent");
  // Phones: the usual mobile way (copy only by default) unless the setting names web or copy only.
  assert.equal(chatGptTarget(DEFAULT_CARD_CHOICES, "copy-only", true), "copy-only");
  assert.equal(chatGptTarget(DEFAULT_CARD_CHOICES, "web-agent", true), "web-agent");
  assert.equal(chatGptTarget(DEFAULT_CARD_CHOICES, "paseo", true), "copy-only");
  assert.equal(chatGptTarget({ chatGpt: "app" }, "web-agent", true), "web-agent", "the app choice falls back to the phone's own way");
  assert.equal(chatGptTarget({ chatGpt: "web-agent" }, "copy-only", true), "web-agent");
});

test("Run once in…: every browser with the default marked; Claude in Chrome only when it would work", () => {
  const items = runMenuItems("server", true);
  assert.deepEqual(items.map((item) => item.way), ["signed-in", "server", "paseo", "chrome"]);
  assert.deepEqual(items.filter((item) => item.isDefault).map((item) => item.way), ["server"]);
  assert.deepEqual(runMenuItems("signed-in", false).map((item) => item.way), ["signed-in", "server", "paseo"]);
  for (const item of items) assert.ok(item.title && item.detail, item.way);
});

test("after a Send, the note says it does not report back", () => {
  assert.match(sentNote("chatgpt"), /^Sent to ChatGPT\. It does not report back here, so mark the card done/);
  assert.match(sentNote("claude"), /^Sent to Claude\./);
});

test("progress: one segment per step, a continuous bar for long runs", () => {
  assert.deepEqual(progressSegments(2, 3, false), ["done", "current", "pending"]);
  assert.deepEqual(progressSegments(3, 3, false), ["done", "done", "current"], "the last step running is not done yet");
  assert.deepEqual(progressSegments(3, 3, true), ["done", "done", "done"]);
  assert.deepEqual(progressSegments(0, 2, false), ["pending", "pending"], "starting");
  assert.equal(progressSegments(1, 40, false), null);
  assert.equal(progressSegments(1, 0, false), null);
});

test("theme tints are fixed colors from the theme; unreadable colors fall back to the surface", () => {
  assert.equal(mixColor("#ff0000", "#000000", 0.5), "#800000");
  assert.equal(mixColor("#fff", "#000", 1), "#ffffff");
  assert.equal(mixColor("rgb(0, 0, 255)", "#000000", 0.5), "#000080");
  assert.equal(mixColor("var(--x)", "#123456", 0.5), "#123456");
  assert.equal(isDarkColor("#212322"), true);
  assert.equal(isDarkColor("#f8f8f8"), false);
  const colors = { accent: "#1f7a4d", surface1: "#212322", border: "#383b3a", statusWarning: "#e3a84d", statusSuccess: "#4cba85" };
  const dark = cardTints(colors);
  assert.notEqual(dark.accentText, colors.accent, "lightened in dark");
  assert.equal(cardTints({ ...colors, surface1: "#f8f8f8" }).accentText, colors.accent, "the accent itself in light");
  for (const value of Object.values(dark)) assert.match(value, /^#[0-9a-f]{6}$/);
});

test("Stop: the stopped run shows as stopped (an ended card with Run again), not as done", () => {
  // An archived agent can look idle ("done") or vanish from the cache ("unknown").
  for (const state of ["done", "unknown", "running", "stopped"]) {
    const shown = ownerStopState(state, { here: true, recorded: false });
    assert.equal(shown, "stopped", `pressed here: ${state}`);
    const phase = cardPhase({ runState: shown, done: false });
    assert.equal(phase, "ended");
    const view = cardLayout({ phase, mobile: false, compact: false, expanded: false });
    assert.equal(view.showStop, false, "no Stop once stopped");
    assert.equal(view.runLabel, "Run again");
    assert.equal(view.runPrimary, true);
  }
  // After a reload the run record says so; a run the owner resumed in Paseo shows its real state.
  assert.equal(ownerStopState("done", { here: false, recorded: true }), "stopped");
  assert.equal(ownerStopState("unknown", { here: false, recorded: true }), "stopped");
  assert.equal(ownerStopState("running", { here: false, recorded: true }), "running");
  assert.equal(ownerStopState("needs-input", { here: false, recorded: true }), "needs-input");
  assert.equal(ownerStopState("done", { here: false, recorded: false }), "done", "not stopped: unchanged");
  // A done mark still folds a stopped card.
  assert.equal(cardPhase({ runState: "stopped", done: true }), "done");
});

test("Stop is recorded on the run's record in place, keeping the server's markers", () => {
  const runs = [["chat:card", "run-1", "most-recent", "key:k", "browser:server"], ["chat:card", "run-2", "key:k"], ["other:x", "run-3"]];
  const next = markRunStopped(runs, "run-1");
  assert.deepEqual(next[0], ["chat:card", "run-1", "most-recent", "key:k", "browser:server", STOPPED_RUN_MARKER], "position 2 stays the fallback marker");
  assert.deepEqual(next.slice(1), runs.slice(1), "other records untouched, order kept");
  assert.deepEqual(markRunStopped(next, "run-1"), next, "marked once");
  assert.equal(runStoppedByOwner(next, "run-1"), true);
  assert.equal(runStoppedByOwner(next, "run-2"), false);
  assert.equal(runStoppedByOwner(next, null), false);
});

test("Stop archives only a run this chat's card recorded, never the chat's own agent", async () => {
  const runs = [["chat:card", "run-1", "key:k"], ["other-chat:card", "run-9", "key:k"]];
  const archived = [];
  const archive = async (id) => void archived.push(id);
  await assert.rejects(stopRecordedRun(archive, { runId: "chat", sourceAgentId: "chat", runs: [...runs, ["chat:card", "chat"]] }), /chat's own agent/);
  await assert.rejects(stopRecordedRun(archive, { runId: "run-x", sourceAgentId: "chat", runs }), /not recorded on this card/);
  await assert.rejects(stopRecordedRun(archive, { runId: "run-9", sourceAgentId: "chat", runs }), /not recorded/, "another chat's run");
  await assert.rejects(stopRecordedRun(archive, { runId: null, sourceAgentId: "chat", runs }), /no run/);
  assert.deepEqual(archived, [], "nothing archived on a refusal");
  await stopRecordedRun(archive, { runId: "run-1", sourceAgentId: "chat", runs });
  assert.deepEqual(archived, ["run-1"]);
  assert.equal(stopRefusal({ runId: "run-1", sourceAgentId: "chat", runs }), null);
});
