// Run: npm test. Live screenshot thumbnail: finding the latest browser screenshot in a run's
// timeline (one reference, safe sources only), the prompt rule, and screenshots never reaching a chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReportBack } from "../server/report-back.ts";
import { buildAgentPrompt, DEFAULT_AGENT_SETTINGS, QUESTION_MARKER, resolveAgentConfig, SCREENSHOT_RULE } from "../shared/agent-prompt.ts";
import { buildReportMessage, escapeUntrusted, finalAssistantText, runLabels } from "../shared/report-back.ts";
import { buildQuestionMessage } from "../shared/talk.ts";
import { createRunTracker } from "../shared/run-tracker.ts";
import {
  createScreenshotTracker,
  isImageOnly,
  isScreenshotTool,
  latestScreenshot,
  safeImageSource,
  screenshotMarkdown,
  stripImagesForChat,
} from "../shared/screenshot.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";

// The shape Paseo uses for a tool's image output: an assistant message with a Markdown image.
const image = (path) => ({ type: "assistant_message", text: `\n\n![Image](${path})\n\n` });
const shot = (name = "mcp__paseo__browser_screenshot") => ({ type: "tool_call", name, status: "completed" });
// The shape 0.11.4 emits: file:// + a private paseo-attachments-<random> temp dir + <sha256>.<ext>.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PNG_A = `file:///tmp/paseo-attachments-Ab12Cd/${HASH_A}.png`;
const PNG_B = `file:///tmp/paseo-attachments-Ab12Cd/${HASH_B}.png`;

test("image helpers", () => {
  assert.equal(isImageOnly(`\n\n![Image](${PNG_A})\n\n`), true);
  assert.equal(isImageOnly(`Done ![x](${PNG_A})`), false);
  assert.equal(isImageOnly("no image"), false);
  for (const name of ["browser_screenshot", "mcp__paseo__browser_screenshot", "paseo.browser_screenshot"]) assert.equal(isScreenshotTool(name), true, name);
  for (const name of ["browser_snapshot", "my_browser_screenshot_tool", undefined]) assert.equal(isScreenshotTool(name), false, String(name));
  assert.equal(screenshotMarkdown(PNG_A), `![Latest browser screenshot](${PNG_A})`);
});

test("B1: only Paseo's attachment shape is a thumbnail source", () => {
  // Accepted: the file:// form 0.11.4 emits, the bare absolute path, Windows file URIs, all image exts.
  for (const ok of [
    PNG_A,
    `/tmp/paseo-attachments-Ab12Cd/${HASH_A}.png`,
    `/var/tmp/paseo-attachments/${HASH_A}.jpg`,
    `file:///C:/Temp/paseo-attachments-Q9/${HASH_A}.webp`,
    `file:///tmp/paseo-attachments-Ab12Cd/${HASH_A}.jpeg`,
    `file:///tmp/paseo-attachments-Ab12Cd/${HASH_A}.gif`,
  ]) {
    assert.equal(safeImageSource(ok), ok, ok);
  }
  for (const bad of [
    "https://example.com/a.png",
    `https://evil.example/paseo-attachments/${HASH_A}.png`,
    `http://localhost/paseo-attachments/${HASH_A}.png`,
    `data:image/png;base64,${HASH_A}`,
    `javascript:alert(1)//paseo-attachments/${HASH_A}.png`,
    `relative/paseo-attachments/${HASH_A}.png`,
    `//host/paseo-attachments/${HASH_A}.png`,
    `file://host/paseo-attachments/${HASH_A}.png`,
    `/tmp/paseo-attachments/../etc/${HASH_A}.png`,
    `/tmp/paseo-attachments-x/%2e%2e/${HASH_A}.png`,
    `/tmp/paseo-attachments-x/..%2f${HASH_A}.png`,
    `/tmp/paseo-attachments-x//${HASH_A}.png`,
    `/tmp/paseo-attachments-x/${HASH_A}.png?x=1`,
    `/tmp/paseo-attachments-x/${HASH_A}.png#frag`,
    `/tmp/paseo-attachments-x/${HASH_A}.svg`,
    `/tmp/paseo-attachments-x/${"a".repeat(63)}.png`,
    `/tmp/paseo-attachments-x/${"A".repeat(64)}.png`,
    `/tmp/other/${HASH_A}.png`,
    `/tmp/paseo-attachments-x/sub/${HASH_A}.png`,
    `/tmp/not-paseo-attachments/${HASH_A}.png`,
    `/tmp/paseo-attachments x/${HASH_A}.png`,
    "",
  ]) {
    assert.equal(safeImageSource(bad), null, bad);
  }
});

test("B1: the latest screenshot is the first message after the call, and only a lone image", () => {
  assert.equal(latestScreenshot([shot(), image(PNG_A)]), PNG_A);
  assert.equal(latestScreenshot([shot("browser_screenshot"), image(PNG_A), shot(), image(PNG_B)]), PNG_B, "latest wins");
  const bare = `/tmp/paseo-attachments-Ab12Cd/${HASH_A}.png`;
  assert.equal(latestScreenshot([shot(), image(bare)]), bare, "bare path form");
  assert.equal(latestScreenshot([image(PNG_A)]), null, "an image without a screenshot call is ignored");
  assert.equal(latestScreenshot([shot(), { type: "assistant_message", text: "narration" }, image(PNG_A)]), null, "must be the first message");
  assert.equal(latestScreenshot([shot(), { type: "assistant_message", text: `Here it is: ![Image](${PNG_A})` }]), null, "prose with an image is not a screenshot");
  assert.equal(latestScreenshot([shot(), { type: "assistant_message", text: `![a](${PNG_A})\n![b](${PNG_B})` }]), null, "only a lone image");
  assert.equal(latestScreenshot([shot(), { type: "user_message", text: "hi" }, image(PNG_A)]), null);
  assert.equal(latestScreenshot([shot("browser_snapshot"), image(PNG_A)]), null);
  assert.equal(latestScreenshot([shot(), image("https://example.com/a.png")]), null, "no remote images");
  assert.equal(latestScreenshot([shot(), image(`/tmp/paseo-attachments/../x/${HASH_A}.png`)]), null, "no traversal");
  assert.equal(latestScreenshot([shot(), image(PNG_A), shot(), image("https://example.com/x.png")]), PNG_A, "an unsafe newer one keeps the older");
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
  assert.equal(finalAssistantText([go, { type: "assistant_message", text: `Saved to ${PNG_A}` }]), "Saved to [file omitted]");
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
    assert.doesNotMatch(w.sent[0].text, /!\[|paseo-attachments|\.png|file:/, mode);
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
  assert.doesNotMatch(w.sent[0].text, /!\[|paseo-attachments|\.png|file:/);
  assert.match(w.sent[0].text, /Which Save button\?/);
});

test("B2: every image form is stripped from text bound for a chat", () => {
  const path = `/tmp/paseo-attachments-Ab12Cd/${HASH_A}.png`;
  const cases = [
    ["inline", `A ![Image](${PNG_A}) B`, "A  B"],
    ["inline with title", `A ![Image](${PNG_A} "Title") B`, "A  B"],
    ["inline with single-quoted title", `A ![Image](${PNG_A} 'Title') B`, "A  B"],
    ["inline with (title)", `A ![Image](${PNG_A} (Title)) B`, "A  B"],
    ["escaped bracket in alt", `A ![a \\] b](${PNG_A}) B`, "A  B"],
    ["escaped paren in destination", `A ![x](/tmp/paseo-attachments-Q/x\\)y.png) B`, "A  B"],
    ["balanced parens in destination", "A ![x](/tmp/a(1).png) B", "A  B"],
    ["angle-bracket destination", "A ![x](</tmp/with space.png>) B", "A  B"],
    ["empty alt", `A ![](${PNG_A}) B`, "A  B"],
    ["reference image", "A ![shot][s1] B\n\n[s1]: /tmp/x.png", "A  B"],
    ["collapsed reference", "A ![shot][] B", "A  B"],
    ["shortcut reference", "A ![shot] B", "A  B"],
    ["reference definition with title", 'Text\n[s1]: <file:///tmp/x.png> "t"', "Text"],
    ["img tag", `A <img src="${PNG_A}"> B`, "A  B"],
    ["self-closing img tag", "A <IMG src='x.png' alt=\"y\" /> B", "A  B"],
    ["multi-line img tag", 'A <img\n  src="x.png"\n  alt="y"> B', "A  B"],
    ["file URI", "Saved at file:///srv/shots/shot.png now", "Saved at [file omitted] now"],
    ["attachment path", `Saved at ${path} now`, "Saved at [file omitted] now"],
    ["Windows attachment path", `Saved at C:/Temp/paseo-attachments-Q/${HASH_A}.png now`, "Saved at [file omitted] now"],
  ];
  for (const [name, input, expected] of cases) assert.equal(stripImagesForChat(input).trim(), expected, name);
  // Plain "[x]: text" lines in a report are not image definitions and stay.
  assert.equal(stripImagesForChat("[1]: Opened the page\n[Step 2]: done"), "[1]: Opened the page\n[Step 2]: done");
  assert.equal(stripImagesForChat("Text\n[s]: https://example.com/a.PNG").trim(), "Text", "image URL definition");
});

test("B2: the shared chat escape strips images, also from look-alike and error text", () => {
  assert.equal(escapeUntrusted(`ok ！［x］（${PNG_A}） done`).trim(), "ok  done", "fullwidth look-alikes normalize first");
  assert.equal(escapeUntrusted(`a <img src="${PNG_A}"> b`), "a  b", "img removed before brackets are escaped");
  const report = buildReportMessage({
    title: "T",
    browserAgentId: "run",
    outcome: { kind: "failed", message: `Could not save ${PNG_A}` },
    report: `Done ![x](${PNG_A}) and ${PNG_B} <img src="${PNG_A}">`,
  });
  assert.doesNotMatch(report, /paseo-attachments|file:|!\[|&lt;img/);
  const question = buildQuestionMessage({ title: "T", runId: "run", question: `Which? ![x](${PNG_A}) ${PNG_B}`, index: 1, max: 3 });
  assert.doesNotMatch(question, /paseo-attachments|file:|!\[/);
});
