// Run: npm test. Step progress: counting steps, reading markers (valid, malformed, clamped,
// cleaned), the card's view per run state, the preamble rule, and markers never affecting question
// or report detection.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReportBack } from "../server/report-back.ts";
import {
  buildAgentPrompt,
  DEFAULT_AGENT_SETTINGS,
  liveSubscription,
  runStateFrom,
  MAX_STEP_TEXT,
  QUESTION_MARKER,
  resolveAgentConfig,
  STEP_MARKER_PREFIX,
  stepProgressRule,
} from "../shared/agent-prompt.ts";
import { runLabels } from "../shared/report-back.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";
import { stepProgressView } from "../shared/step-view.ts";
import { cleanStepText, countSteps, latestStep, stripLeadingStepMarkers } from "../shared/steps.ts";
import { createRunTracker } from "../shared/run-tracker.ts";
import { buildQuestionRedirect, MAX_REDIRECTS, parseQuestion } from "../shared/talk.ts";

test("step count: numbered lines, else non-empty lines", () => {
  const card = [
    "1. Open https://example.com",
    "2) Read the page title",
    "   - check it twice",
    "    4. deeply indented, not a step",
    "",
    "3. Report the title",
  ].join("\n");
  assert.equal(countSteps(card), 3);
  assert.equal(countSteps("Open the page\n\nRead the title\nReport it"), 3, "fallback: non-empty lines");
  assert.equal(countSteps("Just do it"), 1);
  assert.equal(countSteps(""), 1);
  assert.equal(countSteps("10. ten\n11. eleven"), 2);
});

test("markers: the last well-formed one wins, N is clamped, the run's M is ignored", () => {
  const text = [
    "[browser-prompt step 1/3] Opening the page",
    "some narration",
    "  [browser-prompt step 2/3] Reading the title  ",
    "[browser-prompt step x/3] malformed",
    "[browser-prompt step 2/] malformed",
    "inline [browser-prompt step 3/3] not at line start",
  ].join("\n");
  assert.deepEqual(latestStep(text, 3), { step: 2, total: 3, text: "Reading the title" });
  assert.deepEqual(latestStep("[browser-prompt step 9/9] Too far", 4), { step: 4, total: 4, text: "Too far" }, "clamped to M");
  assert.deepEqual(latestStep("[browser-prompt step 0/4] Zero", 4), { step: 1, total: 4, text: "Zero" }, "clamped to 1");
  assert.deepEqual(latestStep("[browser-prompt step 2/7]", 4), { step: 2, total: 4, text: "" }, "card's M is the total");
  assert.equal(latestStep("no markers here", 3), null);
  assert.equal(latestStep("[browser-prompt step 1/3] x", 0), null);
  assert.equal(latestStep("[browser-prompt step 99999/3] x", 3), null, "absurd numbers are malformed");
});

test("step text is cleaned and capped (it can come from a page)", () => {
  assert.equal(cleanStepText("Click​ <b>Save</b>\u0007\tnow"), "Click <b>Save</b> now", "React Native renders text, not markup");
  assert.equal(cleanStepText("ＦＵＬＬ"), "FULL", "NFKC");
  const long = cleanStepText("x".repeat(200));
  assert.equal(long.length, MAX_STEP_TEXT);
  assert.ok(long.endsWith("…"));
  assert.equal(latestStep(`[browser-prompt step 1/2] ${"y".repeat(300)}`, 2).text.length, MAX_STEP_TEXT);
});

test("card view per run state", () => {
  const p = { step: 2, total: 4, text: "Reading the title" };
  assert.deepEqual(stepProgressView(p, 4, "running"), { label: "Step 2 of 4 · Reading the title", step: 2, fraction: 0.5, tone: "accent" });
  assert.deepEqual(stepProgressView(p, 4, "done"), { label: "Step 4 of 4 · done ✓", step: 4, fraction: 1, tone: "success" });
  assert.deepEqual(stepProgressView(null, 4, "done"), { label: "Step 4 of 4 · done ✓", step: 4, fraction: 1, tone: "success" });
  assert.deepEqual(stepProgressView(p, 4, "failed"), { label: "Step 2 of 4 · failed", step: 2, fraction: 0.5, tone: "danger" });
  assert.equal(stepProgressView(p, 4, "needs-input").label, "Step 2 of 4 · needs you");
  assert.equal(stepProgressView(p, 4, "asking").label, "Step 2 of 4 · asking the chat");
  assert.equal(stepProgressView(p, 4, "stopped").label, "Step 2 of 4 · stopped");
  assert.equal(stepProgressView(null, 4, "running").label, "Starting · 4 steps");
  assert.equal(stepProgressView(null, 1, "starting").label, "Starting · 1 step");
  assert.equal(stepProgressView(null, 4, "stopped"), null);
  assert.equal(stepProgressView({ step: 2, total: 4, text: "" }, 4, "running").label, "Step 2 of 4");
});

test("the progress rule is in the preamble only when the setting is on", () => {
  const config = resolveAgentConfig({});
  const steps = "1. Open https://example.com\n2. Report the page title";
  const on = buildAgentPrompt("T", steps, config, undefined, { totalSteps: 2 });
  assert.ok(on.includes(stepProgressRule(2)));
  assert.match(on, /9\. Progress: before you start each numbered step, write one short line on its own in your reply: \[browser-prompt step N\/2\]/);
  assert.match(on, /not a message to the chat and not a question: keep working after it, do not end your turn for it/);
  assert.ok(on.indexOf("9. Progress") < on.indexOf("<steps>"));
  for (const progress of [undefined, { totalSteps: 0 }]) {
    assert.ok(!buildAgentPrompt("T", steps, config, undefined, progress).includes(STEP_MARKER_PREFIX), JSON.stringify(progress));
  }
  assert.equal(DEFAULT_AGENT_SETTINGS.showStepProgress, true);
});

test("settings migration to v9 keeps everything; the default applies", () => {
  const v8 = { agentMode: "auto", talkToChat: true, maxChatQuestions: 10 };
  assert.deepEqual(migratePreferences(v8, 8), v8);
  assert.equal("showStepProgress" in migratePreferences(v8, 8), false, "schema default (on) applies");
});

test("step markers never make a question, and a report starting with one stays a report", () => {
  assert.equal(parseQuestion("[browser-prompt step 3/3] Reporting\nDone: the title is Example Domain."), null);
  assert.equal(parseQuestion("[browser-prompt step 2/3] Checking"), null);
  assert.equal(
    parseQuestion(`[browser-prompt step 2/3] Choosing a button\n\n${QUESTION_MARKER} Which Save button?`),
    "Which Save button?",
    "a question after step lines is still a question",
  );
  assert.equal(stripLeadingStepMarkers("[browser-prompt step 1/2] a\n[browser-prompt step 2/2] b\nReport"), "Report");
  assert.equal(stripLeadingStepMarkers("Report\n[browser-prompt step 2/2] b"), "Report\n[browser-prompt step 2/2] b", "only leading lines");
});

// ---- end to end through the server ----

function world(final) {
  const agents = {
    source: { labels: {}, status: "idle", workspaceId: "ws", provider: "claude", currentModeId: "default" },
    run: { labels: runLabels("source", "card-1"), status: "idle", workspaceId: "ws", provider: "claude", currentModeId: "auto" },
  };
  const sent = [];
  const paseo = {
    agents: {
      ref(id) {
        return {
          refresh: async () => (agents[id] ? { agent: { ...agents[id], pendingPermissions: [], activeTurn: null, archivedAt: null } } : null),
          timeline: {
            refetch: async () => ({
              entries: [
                { item: { type: "user_message", text: "go" } },
                { item: { type: "assistant_message", text: final, messageId: "m1" } },
              ],
            }),
          },
          waitForFinish: async () => ({ status: "idle" }),
          send: async (text, options) => void sent.push({ id, text, options }),
        };
      },
    },
  };
  return { paseo, sent };
}

const options = {
  mode: async () => "auto",
  talk: async () => ({ maxQuestions: 10 }),
  recordedRun: async () => ({ fallback: false }),
  log: () => {},
  recordWaitMs: 0,
  minRecheckMs: 1,
};
const ended = { agent: { id: "run", workspaceId: "ws", parentAgentId: null, provider: "claude", cwd: "/tmp", title: "Browser: Example" }, outcome: { kind: "completed" }, turnId: "t1" };

test("a final message that starts with a step marker is forwarded as the report", async () => {
  const w = world("[browser-prompt step 2/2] Reporting\nDone: the page title is Example Domain.");
  assert.equal(await createReportBack(options).onTurnEnded(ended, w.paseo), "sent");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].id, "source");
  assert.match(w.sent[0].text, /<browser-agent-report>\n\[browser-prompt step 2\/2\] Reporting\nDone: the page title is Example Domain\.\n<\/browser-agent-report>/);
});

test("step lines before a question still route it to the chat, not as the report", async () => {
  const w = world(`[browser-prompt step 1/2] Looking for Save\n${QUESTION_MARKER} Which of the two Save buttons?`);
  assert.equal(await createReportBack(options).onTurnEnded(ended, w.paseo), "question-sent");
  assert.match(w.sent[0].text, /<browser-agent-question>\nWhich of the two Save buttons\?\n<\/browser-agent-question>/);
});

// ---- run tracker (card state) ----

const assistant = (text, messageId) => ({ type: "timeline", item: { type: "assistant_message", text, ...(messageId ? { messageId } : {}) } });
const user = (text) => ({ type: "user_message", text });

test("1: only a running or initializing agent is followed live; an old idle run is done", () => {
  for (const status of ["running", "initializing"]) assert.equal(liveSubscription(status), true, status);
  for (const status of ["idle", "error", "closed", null, undefined, "unknown"]) assert.equal(liveSubscription(status), false, String(status));
  assert.equal(runStateFrom({ status: "idle", attentionReason: null }, false), "done", "old idle run: done, not starting");
  assert.equal(runStateFrom({ status: "idle", attentionReason: null }, false, true), "starting", "only when started in this card session");
  assert.deepEqual(stepProgressView({ step: 2, total: 4, text: "x" }, 4, runStateFrom({ status: "idle", attentionReason: null }, false)), {
    label: "Step 4 of 4 · done ✓",
    step: 4,
    fraction: 1,
    tone: "success",
  });
});

test("3: a read after the run settles decides between waiting for the chat and done", () => {
  const tracker = createRunTracker(3, true);
  // The stream ended before turn_completed arrived: no waiting state yet.
  tracker.event({ type: "turn_started" });
  tracker.event(assistant(`${QUESTION_MARKER} Which Save button?`, "m1"));
  assert.equal(tracker.view().asking, false);
  tracker.history([user("go"), { type: "assistant_message", text: "[browser-prompt step 2/3] Choosing", messageId: "m0" }, { type: "tool_call" }, { type: "assistant_message", text: `${QUESTION_MARKER} Which Save button?`, messageId: "m1" }]);
  assert.deepEqual(tracker.view(), { progress: { step: 2, total: 3, text: "Choosing" }, asking: true, screenshot: null, screenshots: [], screenshotStep: null, screenshotsBlocked: false, permissionPending: false, permissionEvents: 0 });
  tracker.resumed();
  assert.equal(tracker.view().asking, false, "an answer made it run again");
  tracker.history([user("go"), { type: "assistant_message", text: "Done: Example Domain.", messageId: "m2" }]);
  assert.equal(tracker.view().asking, false, "a final report is not waiting");
});

test("the turn's final message decides, so narration before a question does not hide it", () => {
  const tracker = createRunTracker(3, true);
  tracker.event({ type: "turn_started" });
  tracker.event(assistant("I opened the page and see two Save buttons.", "m1"));
  tracker.event({ type: "timeline", item: { type: "tool_call" } });
  tracker.event(assistant(`${QUESTION_MARKER} Which one?`, "m2"));
  tracker.event({ type: "turn_completed" });
  assert.equal(tracker.view().asking, true);
  tracker.event({ type: "turn_started" });
  assert.equal(tracker.view().asking, false);
  tracker.event(assistant("Done.", "m3"));
  tracker.event({ type: "turn_completed" });
  assert.equal(tracker.view().asking, false);
});

test("4: a marker at the start of a new message is not glued to the previous one", () => {
  const tracker = createRunTracker(4, true);
  tracker.event(assistant("Opened the page", "m1"));
  // Different message id, chunk does not start with the marker prefix (leading text split oddly).
  tracker.event(assistant("[browser-prompt step 2/4] Reading", "m2"));
  assert.deepEqual(tracker.view().progress, { step: 2, total: 4, text: "Reading" });
  const split = createRunTracker(4, true);
  split.event(assistant("Narration", "a"));
  split.event(assistant("[browser-prompt ", "b"));
  split.event(assistant("step 3/4] Saving", "b"));
  assert.deepEqual(split.view().progress, { step: 3, total: 4, text: "Saving" }, "chunks of one message are not split");
  const sameMessage = createRunTracker(4, true);
  sameMessage.event(assistant("Narration then [browser-prompt step 3/4] inline", "a"));
  assert.equal(sameMessage.view().progress, null, "inline mentions are not markers");
});

test("5: after the redirect cap a question turn is the report, so the card is done, not waiting", () => {
  const redirect = buildQuestionRedirect("talk-off", 0);
  const history = (redirects) => [
    ...Array.from({ length: redirects }, () => user(redirect)),
    user("go"),
    { type: "assistant_message", text: `${QUESTION_MARKER} Which one?`, messageId: "m" },
  ];
  const tracker = createRunTracker(2, true);
  tracker.history(history(MAX_REDIRECTS - 1));
  assert.equal(tracker.view().asking, true, "still waiting while the server would redirect");
  tracker.history(history(MAX_REDIRECTS));
  assert.equal(tracker.view().asking, false, "fall-through: handled as the report");

  const live = createRunTracker(2, true);
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    live.event({ type: "turn_started" });
    live.event({ type: "timeline", item: user(redirect) });
    live.event(assistant(`${QUESTION_MARKER} Which one?`, `q${i}`));
    live.event({ type: "turn_completed" });
  }
  assert.equal(live.view().asking, false, "the stream counts redirect notices too");
});

test("with step progress off the tracker still tracks waiting, without steps", () => {
  const tracker = createRunTracker(2, false);
  tracker.history([user("go"), { type: "assistant_message", text: `[browser-prompt step 1/2] x\n${QUESTION_MARKER} Q?` }]);
  assert.deepEqual(tracker.view(), { progress: null, asking: true, screenshot: null, screenshots: [], screenshotStep: null, screenshotsBlocked: false, permissionPending: false, permissionEvents: 0 });
});
