// Run: npm test. Adversarial input must stay fast on every path that turns run output into chat
// text or card state (the regular expressions were quadratic on input like "![![![…").
import assert from "node:assert/strict";
import { test } from "node:test";
import { QUESTION_MARKER } from "../shared/agent-prompt.ts";
import { buildReportMessage, escapeUntrusted, finalAssistantText } from "../shared/report-back.ts";
import { createRunTracker } from "../shared/run-tracker.ts";
import { isImageOnly, latestScreenshot, MAX_STRIP_INPUT, stripImagesForChat } from "../shared/screenshot.ts";
import { latestStep } from "../shared/steps.ts";
import { buildQuestionMessage, parseQuestion } from "../shared/talk.ts";

const SIZE = 100_000;
const BUDGET_MS = 200;
const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

const ADVERSARIAL = {
  "![": fill("!["),
  "![![x](": fill("![![x]("),
  "<img": fill("<img"),
  "![a](": fill("![a]("),
  "![a](((": fill("![a]((("),
  "long token": fill("a"),
  "attachment-like token": fill("paseo-attachments/"),
  "file:// run": fill("file://"),
  "reference lines": fill("[x]: /tmp/a\n"),
  "step markers": fill("[browser-prompt step 1/"),
  "question marker": fill(`${QUESTION_MARKER} `),
  "mixed": fill("![<img [x]( file://paseo-attachments-"),
  "![[": fill("![["),
  "![a [": fill("![a ["),
  "![[a]": fill("![[a]"),
  "![a [b] c](": fill("![a [b] c]("),
};

const PATHS = {
  stripImagesForChat: (t) => stripImagesForChat(t),
  isImageOnly: (t) => isImageOnly(t),
  escapeUntrusted: (t) => escapeUntrusted(t),
  finalAssistantText: (t) => finalAssistantText([{ type: "user_message", text: "go" }, { type: "assistant_message", text: t }]),
  latestScreenshot: (t) => latestScreenshot([{ type: "tool_call", name: "browser_screenshot" }, { type: "assistant_message", text: t }]),
  buildReportMessage: (t) => buildReportMessage({ title: t, browserAgentId: "run", outcome: { kind: "failed", message: t }, report: t }),
  buildQuestionMessage: (t) => buildQuestionMessage({ title: t, runId: "run", question: t, index: 1, max: 1 }),
  parseQuestion: (t) => parseQuestion(t),
  latestStep: (t) => latestStep(t, 5),
  runTracker: (t) => {
    const tracker = createRunTracker(5, true, true);
    tracker.history([{ type: "user_message", text: "go" }, { type: "assistant_message", text: t }]);
    tracker.event({ type: "timeline", item: { type: "assistant_message", text: t } });
    tracker.event({ type: "turn_completed" });
    return tracker.view();
  },
};

for (const [inputName, input] of Object.entries(ADVERSARIAL)) {
  test(`100k adversarial "${inputName}" stays under ${BUDGET_MS} ms on every path`, () => {
    for (const [pathName, run] of Object.entries(PATHS)) {
      const started = performance.now();
      run(input);
      const ms = performance.now() - started;
      assert.ok(ms < BUDGET_MS, `${pathName}: ${ms.toFixed(0)} ms`);
    }
  });
}

test("cutting at the strip cap keeps the start, which is all that is ever sent", () => {
  const text = `Report start. ${"x".repeat(MAX_STRIP_INPUT)} tail ![a](file:///tmp/paseo-attachments/${"a".repeat(64)}.png)`;
  const stripped = stripImagesForChat(text);
  assert.ok(stripped.startsWith("Report start."));
  assert.ok(stripped.length <= MAX_STRIP_INPUT);
  assert.doesNotMatch(stripped, /paseo-attachments|file:/);
  assert.equal(isImageOnly(`![Image](file:///tmp/paseo-attachments/${"a".repeat(64)}.png)${" ".repeat(5000)}`), false, "long messages are not image outputs");
});

test("linear patterns still strip what matters", () => {
  const png = `file:///tmp/paseo-attachments-Q/${"a".repeat(64)}.png`;
  assert.equal(stripImagesForChat(`A ![x](${png}) B`), "A  B");
  assert.equal(stripImagesForChat("A <img src=x> B"), "A  B");
  // Nested brackets in alt text: the image is not removed as a whole, but its location is.
  assert.doesNotMatch(stripImagesForChat(`A ![a [b] c](${png}) B`), /paseo-attachments|file:/);
  assert.equal(stripImagesForChat(`see /tmp/paseo-attachments-Q/${"a".repeat(64)}.png`), "see [file omitted]");
  assert.equal(stripImagesForChat("xpaseo-attachments"), "[file omitted]", "a token that contains the directory name still counts");
});
