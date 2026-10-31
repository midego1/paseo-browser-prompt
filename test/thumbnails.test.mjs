// Run: npm test. One screenshot thumbnail per step: mapping screenshots to the step marker before
// them, the per-run cap, live and history reads, the card's layout choice, and the setting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunTracker } from "../shared/run-tracker.ts";
import {
  createScreenshotTracker,
  MAX_STEP_SCREENSHOTS,
  screenshotMarkdown,
  stepScreenshots,
  THUMB_GAP,
  THUMB_MAX,
  THUMB_MIN,
  thumbnailLayout,
} from "../shared/screenshot.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";

const hash = (n) => n.toString(16).padStart(64, "0");
const png = (n) => `file:///tmp/paseo-attachments-Q1/${hash(n)}.png`;
const say = (text, messageId) => ({ type: "assistant_message", text, ...(messageId ? { messageId } : {}) });
const marker = (step, total = 4, text = "doing it") => say(`[browser-prompt step ${step}/${total}] ${text}`);
const shot = () => ({ type: "tool_call", name: "mcp__paseo__browser_screenshot", status: "completed" });
const image = (n) => say(`\n\n![Image](${png(n)})\n\n`);
const go = { type: "user_message", text: "go" };

test("each screenshot belongs to the step marker before it; the last one per step wins", () => {
  const items = [
    go,
    marker(1), shot(), image(1),
    marker(2), say("narration"), shot(), image(2), shot(), image(3),
    marker(3), shot(), image(4),
  ];
  assert.deepEqual(stepScreenshots(items, 4), [
    { step: 1, source: png(1) },
    { step: 2, source: png(3) },
    { step: 3, source: png(4) },
  ]);
});

test("missing markers: screenshots before any marker share step 0, and steps without one are skipped", () => {
  assert.deepEqual(stepScreenshots([go, shot(), image(1), shot(), image(2)], 4), [{ step: 0, source: png(2) }]);
  assert.deepEqual(stepScreenshots([go, marker(1), shot(), image(1), marker(2), marker(3), shot(), image(3)], 4), [
    { step: 1, source: png(1) },
    { step: 3, source: png(3) },
  ]);
  assert.deepEqual(stepScreenshots([go, marker(2), shot(), image(1)], 0), [{ step: 0, source: png(1) }], "no step count: no mapping");
});

test("out of order and out of range markers", () => {
  const items = [go, marker(3), shot(), image(3), marker(2), shot(), image(2), marker(9), shot(), image(9)];
  assert.deepEqual(stepScreenshots(items, 4), [
    { step: 2, source: png(2) },
    { step: 3, source: png(3) },
    { step: 4, source: png(9) },
  ], "a later marker for an earlier step maps there; N is clamped to the card's M");
  const tracker = createScreenshotTracker(4);
  for (const item of items) tracker.push(item);
  assert.equal(tracker.latestStep(), 4);
  assert.equal(tracker.latest(), png(9));
});

test("at most 20 steps are kept, the least recently captured dropped first", () => {
  const items = [go];
  for (let step = 1; step <= 30; step++) items.push(marker(step, 30), shot(), image(step));
  const shots = stepScreenshots(items, 30);
  assert.equal(MAX_STEP_SCREENSHOTS, 20);
  assert.equal(shots.length, 20);
  assert.deepEqual(shots[0], { step: 11, source: png(11) });
  assert.deepEqual(shots.at(-1), { step: 30, source: png(30) });
  assert.ok(shots.every((entry) => typeof entry.source === "string"), "path strings only");
});

test("the strict source and image-only rules still apply per step", () => {
  const items = [
    go,
    marker(1), shot(), say(`Here: ![Image](${png(1)})`),
    marker(2), shot(), say("\n\n![Image](https://example.com/x.png)\n\n"),
    marker(3), shot(), say("first"), image(3),
  ];
  assert.deepEqual(stepScreenshots(items, 4), [], "prose with an image, and an image that is not the first message, are ignored");
  const remote = [go, marker(1), shot(), say("\n![Image](https://example.com/a.png)\n")];
  assert.deepEqual(stepScreenshots(remote, 4), []);
});

test("live: a marker split across stream chunks still maps the next screenshot", () => {
  const run = createRunTracker(4, true, true);
  const event = (item) => run.event({ type: "timeline", item });
  event(say("[browser-prompt ", "m1"));
  event(say("step 2/4] Reading", "m1"));
  event(shot());
  event(image(2));
  assert.deepEqual(run.view().screenshots, [{ step: 2, source: png(2) }]);
  assert.equal(run.view().screenshotStep, 2);
});

test("history: a newer tail read keeps earlier steps it no longer reaches", () => {
  const run = createRunTracker(4, true, true);
  run.history([go, marker(1), shot(), image(1), marker(2), shot(), image(2)]);
  run.history([go, marker(3), shot(), image(3)]);
  assert.deepEqual(run.view().screenshots.map((entry) => entry.step), [1, 2, 3]);
  assert.equal(run.view().screenshotStep, 3);
  run.history([go, marker(2), shot(), image(22)]);
  assert.deepEqual(run.view().screenshots, [
    { step: 1, source: png(1) },
    { step: 2, source: png(22) },
    { step: 3, source: png(3) },
  ], "a newer read replaces its own steps");
  const off = createRunTracker(4, true, false);
  off.history([go, marker(1), shot(), image(1)]);
  assert.deepEqual(off.view().screenshots, []);
});

test("layout: a row when all fit, a scroll strip when some do, the latest alone when narrow", () => {
  assert.deepEqual(thumbnailLayout(900, 3, "all"), { kind: "row", size: THUMB_MAX });
  const exact = 3 * THUMB_MIN + 2 * THUMB_GAP;
  assert.deepEqual(thumbnailLayout(exact, 3, "all"), { kind: "row", size: THUMB_MIN });
  assert.deepEqual(thumbnailLayout(exact - 1, 3, "all"), { kind: "scroll", size: 160 });
  assert.deepEqual(thumbnailLayout(2 * THUMB_MIN + THUMB_GAP, 6, "all"), { kind: "scroll", size: 160 }, "phone width: swipe");
  assert.deepEqual(thumbnailLayout(2 * THUMB_MIN + THUMB_GAP - 1, 6, "all"), { kind: "latest", size: 240 }, "too narrow for two");
  assert.deepEqual(thumbnailLayout(200, 6, "all"), { kind: "latest", size: 200 }, "never wider than the card");
  assert.deepEqual(thumbnailLayout(900, 1, "all"), { kind: "latest", size: 240 }, "one screenshot");
  assert.deepEqual(thumbnailLayout(900, 5, "latest"), { kind: "latest", size: 240 }, "setting: latest only");
  assert.deepEqual(thumbnailLayout(0, 5, "all"), { kind: "latest", size: 0 }, "not measured yet");
  for (const [width, count] of [[Number.NaN, 3], [Number.POSITIVE_INFINITY, 3], [-5, 3], [900, Number.NaN], [900, Number.POSITIVE_INFINITY]]) {
    assert.deepEqual(thumbnailLayout(width, count, "all"), { kind: "latest", size: 0 }, `${width} x ${count}`);
  }
});

test("thumbnail alt text names the step", () => {
  assert.equal(screenshotMarkdown(png(1), 3), `![Screenshot after step 3](${png(1)})`);
  assert.equal(screenshotMarkdown(png(1)), `![Latest browser screenshot](${png(1)})`);
});

test("settings migration to v11: thumbnail mode defaults to all steps; a bad stored value is dropped", () => {
  const v10 = { showLiveScreenshot: true };
  assert.deepEqual(migratePreferences(v10, 10), v10);
  assert.equal("thumbnailMode" in migratePreferences({ ...v10, thumbnailMode: "grid" }, 10), false);
  assert.equal(migratePreferences({ ...v10, thumbnailMode: "latest" }, 10).thumbnailMode, "latest");
});
