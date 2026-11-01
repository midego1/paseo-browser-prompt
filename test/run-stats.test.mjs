// Run: npm test. The card's run stats line: duration and token formats, start/end from the run
// agent's own timestamps (live while going, frozen once ended), and tokens only when reported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { elapsedMs, formatDuration, formatTokens, runStatsView, runTiming, tokenCounts } from "../shared/run-stats.ts";

const CREATED = "2026-11-01T07:19:40.000Z";
const at = (seconds) => new Date(Date.parse(CREATED) + seconds * 1000).toISOString();
const ms = (seconds) => Date.parse(CREATED) + seconds * 1000;

test("formatDuration: seconds, minutes with padded seconds, hours with padded minutes", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(60_000), "1m 00s");
  assert.equal(formatDuration(134_000), "2m 14s");
  assert.equal(formatDuration(3_599_000), "59m 59s");
  assert.equal(formatDuration(3_720_000), "1h 02m");
  assert.equal(formatDuration(-5_000), "0s");
  assert.equal(formatDuration(Number.NaN), "0s");
});

test("formatTokens: plain below 1k, one decimal below 100k, none above, then M", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(936), "936");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(4555), "4.6k");
  assert.equal(formatTokens(18_400), "18.4k");
  assert.equal(formatTokens(99_960), "100k");
  assert.equal(formatTokens(700_998), "701k");
  assert.equal(formatTokens(999_499), "999k");
  assert.equal(formatTokens(999_500), "1M");
  assert.equal(formatTokens(1_234_567), "1.2M");
  assert.equal(formatTokens(-3), "0");
});

test("tokenCounts: input includes cached input; no counts or all zero means none", () => {
  // As a finished Claude run reports it (lastUsage on the agent snapshot).
  assert.deepEqual(tokenCounts({ inputTokens: 36, cachedInputTokens: 700_962, outputTokens: 4555, totalCostUsd: 0.35 }), {
    input: 700_998,
    cached: 700_962,
    output: 4555,
  });
  assert.deepEqual(tokenCounts({ outputTokens: 12 }), { input: 0, cached: 0, output: 12 });
  // While streaming the daemon's lastUsage holds only context-window fields.
  assert.equal(tokenCounts({ contextWindowUsedTokens: 30_000, contextWindowMaxTokens: 200_000 }), null);
  assert.equal(tokenCounts({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), null);
  assert.equal(tokenCounts({ inputTokens: Number.NaN, outputTokens: -1 }), null);
  assert.equal(tokenCounts(null), null);
  assert.equal(tokenCounts(undefined), null);
});

test("runTiming: going states count up from createdAt", () => {
  for (const state of ["starting", "running", "needs-input"]) {
    const timing = runTiming({ state, createdAt: CREATED, updatedAt: at(30), lastEntryAt: at(20) });
    assert.deepEqual(timing, { startMs: ms(0), endMs: null }, state);
    assert.equal(elapsedMs(timing, ms(134)), 134_000);
  }
});

test("runTiming: an ended run stops at its latest timeline entry, else at updatedAt", () => {
  for (const state of ["done", "failed", "stopped", "asking"]) {
    const fromEntry = runTiming({ state, createdAt: CREATED, updatedAt: at(500), lastEntryAt: at(74) });
    assert.deepEqual(fromEntry, { startMs: ms(0), endMs: ms(74) }, state);
    // Later clock time does not change an ended run.
    assert.equal(elapsedMs(fromEntry, ms(10_000)), 74_000);
    assert.deepEqual(runTiming({ state, createdAt: CREATED, updatedAt: at(90) }), { startMs: ms(0), endMs: ms(90) });
  }
});

test("runTiming: no start, unknown state or bad timestamps", () => {
  assert.equal(runTiming({ state: "running", createdAt: null, updatedAt: at(5) }), null);
  assert.equal(runTiming({ state: "running", createdAt: "not a date", updatedAt: at(5) }), null);
  assert.equal(runTiming({ state: "unknown", createdAt: CREATED, updatedAt: at(5) }), null);
  // An entry before the start is ignored; an end before the start reads as 0s.
  assert.deepEqual(runTiming({ state: "done", createdAt: CREATED, updatedAt: at(40), lastEntryAt: at(-10) }), {
    startMs: ms(0),
    endMs: ms(40),
  });
  assert.deepEqual(runTiming({ state: "done", createdAt: CREATED, updatedAt: at(-10) }), { startMs: ms(0), endMs: ms(0) });
  assert.deepEqual(runTiming({ state: "done", createdAt: CREATED, updatedAt: null }), { startMs: ms(0), endMs: ms(0) });
  // A client clock behind the daemon does not show a negative time.
  assert.equal(elapsedMs({ startMs: ms(0), endMs: null }, ms(-3)), 0);
});

test("runStatsView: running spins, ticks and shows tokens once reported", () => {
  const timing = runTiming({ state: "running", createdAt: CREATED, updatedAt: at(1) });
  const running = runStatsView({ state: "running", timing, nowMs: ms(134) });
  assert.deepEqual(running, {
    spinning: true,
    live: true,
    text: "Running · 2m 14s",
    accessibilityLabel: "Running, 2m 14s so far",
  });
  const withTokens = runStatsView({
    state: "running",
    timing,
    nowMs: ms(134),
    usage: { inputTokens: 1200, cachedInputTokens: 17_200, outputTokens: 950 },
  });
  assert.equal(withTokens.text, "Running · 2m 14s · 18.4k in · 950 out");
  assert.equal(withTokens.accessibilityLabel, "Running, 2m 14s so far, 18400 input tokens (17200 cached), 950 output tokens");
  assert.equal(runStatsView({ state: "starting", timing, nowMs: ms(3) }).text, "Starting · 3s");
});

test("runStatsView: waiting for the owner ticks without spinning", () => {
  const timing = runTiming({ state: "needs-input", createdAt: CREATED, updatedAt: at(1) });
  const view = runStatsView({ state: "needs-input", timing, nowMs: ms(65) });
  assert.equal(view.spinning, false);
  assert.equal(view.live, true);
  assert.equal(view.text, "Waiting for you · 1m 05s");
});

test("runStatsView: an ended run shows its total time and no spinner", () => {
  const usage = { inputTokens: 36, cachedInputTokens: 700_962, outputTokens: 4555 };
  const view = (state) =>
    runStatsView({ state, timing: runTiming({ state, createdAt: CREATED, updatedAt: at(900), lastEntryAt: at(182) }), nowMs: ms(5000), usage });
  assert.deepEqual(view("done"), {
    spinning: false,
    live: false,
    text: "Took 3m 02s · 701k in · 4.6k out",
    accessibilityLabel: "Took 3m 02s, 700998 input tokens (700962 cached), 4555 output tokens",
  });
  assert.equal(view("failed").text, "Failed after 3m 02s · 701k in · 4.6k out");
  assert.equal(view("stopped").text, "Stopped after 3m 02s · 701k in · 4.6k out");
  assert.equal(view("asking").text, "Ran 3m 02s · 701k in · 4.6k out");
});

test("runStatsView: nothing without timing, and never a cost", () => {
  assert.equal(runStatsView({ state: "running", timing: null, nowMs: ms(1) }), null);
  assert.equal(runStatsView({ state: "unknown", timing: { startMs: ms(0), endMs: ms(1) }, nowMs: ms(1) }), null);
  const view = runStatsView({
    state: "done",
    timing: { startMs: ms(0), endMs: ms(10) },
    nowMs: ms(10),
    usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 1.23 },
  });
  assert.doesNotMatch(`${view.text} ${view.accessibilityLabel}`, /\$|usd|cost|1\.23/i);
});

test("the card shows the stats line and the spinner respects reduced motion", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(card, /<RunStatsRow\b/);
  const row = readFileSync(new URL("../client/run-stats-row.tsx", import.meta.url), "utf8");
  assert.match(row, /isReduceMotionEnabled/);
  assert.match(row, /reduceMotionChanged/);
  assert.match(row, /clearInterval/);
  assert.doesNotMatch(row, /totalCostUsd/);
});
