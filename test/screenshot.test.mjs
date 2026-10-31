// Run: npm test. Live screenshot thumbnail: finding the latest browser screenshot in a run's
// timeline (one reference, safe sources only), the prompt rule, and screenshots never reaching a chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReportBack } from "../server/report-back.ts";
import { buildAgentPrompt, DEFAULT_AGENT_SETTINGS, QUESTION_MARKER, resolveAgentConfig, SCREENSHOT_RULE } from "../shared/agent-prompt.ts";
import { finalAssistantText, runLabels } from "../shared/report-back.ts";
import { createRunTracker } from "../shared/run-tracker.ts";
import {
  createScreenshotTracker,
  isImageOnly,
  isScreenshotTool,
  latestScreenshot,
  safeImageSource,
  screenshotMarkdown,
  stripMarkdownImages,
} from "../shared/screenshot.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";

// The shape Paseo uses for a tool's image output: an assistant message with a Markdown image.
const image = (path) => ({ type: "assistant_message", text: `\n\n![Image](${path})\n\n` });
const shot = (name = "mcp__paseo__browser_screenshot") => ({ type: "tool_call", name, status: "completed" });
const PNG_A = "/var/lib/paseo-attachments/aaaa.png";
const PNG_B = "/var/lib/paseo-attachments/bbbb.png";

test("image helpers", () => {
  assert.equal(stripMarkdownImages(`Done.\n\n![Image](${PNG_A})\n\nBye`), "Done.\n\nBye");
  assert.equal(isImageOnly(`\n\n![Image](${PNG_A})\n\n`), true);
  assert.equal(isImageOnly(`Done ![x](${PNG_A})`), false);
  assert.equal(isImageOnly("no image"), false);
  for (const name of ["browser_screenshot", "mcp__paseo__browser_screenshot", "paseo.browser_screenshot"]) assert.equal(isScreenshotTool(name), true, name);
  for (const name of ["browser_snapshot", "my_browser_screenshot_tool", undefined]) assert.equal(isScreenshotTool(name), false, String(name));
  assert.equal(screenshotMarkdown(PNG_A), `![Latest browser screenshot](${PNG_A})`);
});

test("only absolute paths and http(s) URLs are used as a thumbnail source", () => {
  assert.equal(safeImageSource(PNG_A), PNG_A);
  assert.equal(safeImageSource("https://example.com/a.png"), "https://example.com/a.png");
  for (const bad of ["data:image/png;base64,AAAA", "relative/a.png", "//host/a.png", "/a/../b.png", "/a b.png", "/a(b).png", "javascript:alert(1)", "", "/x\".png"]) {
    assert.equal(safeImageSource(bad), null, bad);
  }
});

test("the latest screenshot is the image that follows a browser_screenshot call", () => {
  assert.equal(latestScreenshot([shot(), image(PNG_A)]), PNG_A);
  assert.equal(latestScreenshot([shot("browser_screenshot"), image(PNG_A), shot(), image(PNG_B)]), PNG_B, "latest wins");
  assert.equal(latestScreenshot([image(PNG_A)]), null, "an image without a screenshot call is ignored");
  assert.equal(latestScreenshot([shot(), { type: "assistant_message", text: "narration" }, image(PNG_A)]), null, "must follow directly");
  assert.equal(latestScreenshot([shot(), { type: "user_message", text: "hi" }, image(PNG_A)]), null);
  assert.equal(latestScreenshot([shot("browser_snapshot"), image(PNG_A)]), null);
  assert.equal(latestScreenshot([shot(), image("data:image/png;base64,AAAA")]), null, "no data URIs");
  assert.equal(latestScreenshot([shot(), image(PNG_A), shot(), image("relative.png")]), PNG_A, "an unsafe newer one keeps the older");
});

test("the tracker keeps one reference and updates it live", () => {
  const tracker = createScreenshotTracker();
  tracker.push(shot());
  tracker.push(image(PNG_A));
  assert.equal(tracker.latest(), PNG_A);
  tracker.push(shot());
  tracker.push(image(PNG_B));
  assert.equal(tracker.latest(), PNG_B);

  const run = createRunTracker(3, true, true);
  run.event({ type: "timeline", item: shot() });
  run.event({ type: "timeline", item: image(PNG_A) });
  assert.equal(run.view().screenshot, PNG_A);
  run.history([{ type: "user_message", text: "go" }, { type: "assistant_message", text: "no shots in this tail" }]);
  assert.equal(run.view().screenshot, PNG_A, "a tail without screenshots keeps the last one");
  run.history([{ type: "user_message", text: "go" }, shot(), image(PNG_B)]);
  assert.equal(run.view().screenshot, PNG_B);

  const off = createRunTracker(3, true, false);
  off.event({ type: "timeline", item: shot() });
  off.event({ type: "timeline", item: image(PNG_A) });
  assert.equal(off.view().screenshot, null, "setting off: no thumbnail");
});

test("the screenshot rule is in the preamble only when the setting is on", () => {
  assert.equal(DEFAULT_AGENT_SETTINGS.showLiveScreenshot, true);
  const config = resolveAgentConfig({});
  const on = buildAgentPrompt("T", "1. Open https://example.com", config, undefined, { totalSteps: 1 }, true);
  assert.ok(on.includes(SCREENSHOT_RULE));
  assert.match(SCREENSHOT_RULE, /call browser_screenshot once for the current tab with fullPage false/);
  assert.match(SCREENSHOT_RULE, /Never take a screenshot while the page shows a password, token, API key, 2FA or recovery code or any other secret: skip it and say "screenshot skipped"/);
  assert.ok(on.indexOf("10. Screenshots") < on.indexOf("<steps>"));
  for (const flag of [undefined, false]) {
    assert.ok(!buildAgentPrompt("T", "1. x", config, undefined, { totalSteps: 1 }, flag).includes("browser_screenshot once"), String(flag));
  }
});

test("settings migration to v10 keeps everything; the default applies", () => {
  const v9 = { agentMode: "auto", showStepProgress: true };
  assert.deepEqual(migratePreferences(v9, 9), v9);
});

test("final message text never contains images or their paths", () => {
  const go = { type: "user_message", text: "go" };
  assert.equal(finalAssistantText([go, { type: "assistant_message", text: "Done: Example Domain." }, shot(), image(PNG_A)]), "Done: Example Domain.");
  assert.equal(finalAssistantText([go, shot(), image(PNG_A), { type: "assistant_message", text: "Done." }]), "Done.");
  assert.equal(finalAssistantText([go, { type: "assistant_message", text: `Done. ![shot](${PNG_A}) See above.` }]), "Done.  See above.");
  assert.equal(finalAssistantText([go, shot(), image(PNG_A)]), "", "an image alone is no report text");
});

// ---- never to the chat, end to end ----

function world(items) {
  const agents = {
    source: { labels: {}, status: "idle", workspaceId: "ws", provider: "claude", currentModeId: "default" },
    run: { labels: runLabels("source", "card-1"), status: "idle", workspaceId: "ws", provider: "claude", currentModeId: "auto" },
  };
  const sent = [];
  const paseo = {
    agents: {
      ref(id) {
        return {
          refresh: async () => ({ agent: { ...agents[id], pendingPermissions: [], activeTurn: null, archivedAt: null } }),
          timeline: { refetch: async () => ({ entries: items.map((item) => ({ item })) }) },
          waitForFinish: async () => ({ status: "idle" }),
          send: async (text) => void sent.push({ id, text }),
        };
      },
    },
  };
  return { paseo, sent };
}
const options = (mode = "full") => ({
  mode: async () => mode,
  talk: async () => ({ maxQuestions: 10 }),
  recordedRun: async () => ({ fallback: false }),
  log: () => {},
  recordWaitMs: 0,
  minRecheckMs: 1,
});
const ended = { agent: { id: "run", workspaceId: "ws", parentAgentId: null, provider: "claude", cwd: "/tmp", title: "Browser: Example" }, outcome: { kind: "completed" }, turnId: "t1" };

test("reports to the chat are text only, even when the run's last output was a screenshot", async () => {
  const items = [
    { type: "user_message", text: "go" },
    { type: "assistant_message", text: `Done: the title is Example Domain.\n\n![Image](${PNG_A})` },
    shot(),
    image(PNG_B),
  ];
  for (const mode of ["full", "auto"]) {
    const w = world(items);
    assert.equal(await createReportBack(options(mode)).onTurnEnded(ended, w.paseo), "sent");
    assert.equal(w.sent.length, 1);
    assert.doesNotMatch(w.sent[0].text, /!\[|paseo-attachments|\.png/, mode);
    assert.match(w.sent[0].text, /Done: the title is Example Domain\./);
  }
});

test("questions to the chat are text only and still recognized after a screenshot", async () => {
  const w = world([
    { type: "user_message", text: "go" },
    shot(),
    image(PNG_A),
    { type: "assistant_message", text: `${QUESTION_MARKER} Which Save button? ![Image](${PNG_B})` },
  ]);
  assert.equal(await createReportBack(options()).onTurnEnded(ended, w.paseo), "question-sent");
  assert.doesNotMatch(w.sent[0].text, /!\[|paseo-attachments|\.png/);
  assert.match(w.sent[0].text, /Which Save button\?/);
});
