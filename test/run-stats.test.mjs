// Run: npm test. The card's run stats line: duration and token formats, start/end from the run
// agent's own timestamps (live while going, frozen once ended, no time when the end is unknown),
// clock skew between the client and the daemon, and tokens only as reported, for the last turn.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  elapsedMs,
  formatDuration,
  formatTokens,
  observeSkew,
  runStatsView,
  runTiming,
  tokenCounts,
} from "../shared/run-stats.ts";

const CREATED = "2026-11-01T07:19:40.000Z";
const at = (seconds) => new Date(Date.parse(CREATED) + seconds * 1000).toISOString();
const ms = (seconds) => Date.parse(CREATED) + seconds * 1000;
// As a finished Claude run reports it (lastUsage on the agent snapshot): cached apart from input.
const CLAUDE_USAGE = { inputTokens: 36, cachedInputTokens: 700_962, outputTokens: 4555, totalCostUsd: 0.35 };

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
  assert.equal(formatTokens(700_962), "701k");
  assert.equal(formatTokens(999_499), "999k");
  assert.equal(formatTokens(999_500), "1M");
  assert.equal(formatTokens(1_234_567), "1.2M");
  assert.equal(formatTokens(-3), "0");
});

test("tokenCounts: as reported, never summed; no counts or all zero means none", () => {
  assert.deepEqual(tokenCounts(CLAUDE_USAGE), { input: 36, cached: 700_962, output: 4555 });
  // Codex-style: cached is a part of input; still shown as reported, not added.
  assert.deepEqual(tokenCounts({ inputTokens: 20_000, cachedInputTokens: 15_000, outputTokens: 800 }), {
    input: 20_000,
    cached: 15_000,
    output: 800,
  });
  assert.deepEqual(tokenCounts({ outputTokens: 12 }), { input: null, cached: null, output: 12 });
  // While streaming the daemon's lastUsage holds only context-window fields.
  assert.equal(tokenCounts({ contextWindowUsedTokens: 30_000, contextWindowMaxTokens: 200_000 }), null);
  assert.equal(tokenCounts({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), null);
  assert.equal(tokenCounts({ cachedInputTokens: 500 }), null);
  assert.equal(tokenCounts(null), null);
  assert.equal(tokenCounts(undefined), null);
});

test("tokenCounts: non-finite, negative or absurd (> 1e12) counts read as missing", () => {
  assert.equal(tokenCounts({ inputTokens: Number.NaN, outputTokens: -1 }), null);
  assert.equal(tokenCounts({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 2e12 }), null);
  assert.deepEqual(tokenCounts({ inputTokens: 5e12, cachedInputTokens: Number.NaN, outputTokens: 40 }), {
    input: null,
    cached: null,
    output: 40,
  });
  assert.deepEqual(tokenCounts({ inputTokens: 1e12, outputTokens: 1 }), { input: 1e12, cached: null, output: 1 });
  assert.equal(tokenCounts({ inputTokens: "36", outputTokens: "4555" }), null);
});

test("runTiming: going states count up from createdAt", () => {
  for (const state of ["starting", "running", "needs-input"]) {
    const timing = runTiming({ state, createdAt: CREATED, lastEntryAt: at(20) });
    assert.deepEqual(timing, { startMs: ms(0), ended: false, endMs: null }, state);
    assert.equal(elapsedMs(timing, ms(134)), 134_000);
  }
});

test("runTiming: an ended run stops at its latest timeline entry, else has no known end", () => {
  for (const state of ["done", "failed", "stopped", "asking"]) {
    const fromEntry = runTiming({ state, createdAt: CREATED, lastEntryAt: at(74) });
    assert.deepEqual(fromEntry, { startMs: ms(0), ended: true, endMs: ms(74) }, state);
    // Later clock time and skew do not change an ended run.
    assert.equal(elapsedMs(fromEntry, ms(10_000), 5_000), 74_000);
    const unknown = runTiming({ state, createdAt: CREATED, lastEntryAt: null });
    assert.deepEqual(unknown, { startMs: ms(0), ended: true, endMs: null });
    assert.equal(elapsedMs(unknown, ms(10_000)), null);
    // An entry before the start is not an end.
    assert.equal(runTiming({ state, createdAt: CREATED, lastEntryAt: at(-10) }).endMs, null);
  }
});

test("runTiming: no start, unknown state or bad timestamps", () => {
  assert.equal(runTiming({ state: "running", createdAt: null }), null);
  assert.equal(runTiming({ state: "running", createdAt: "not a date" }), null);
  assert.equal(runTiming({ state: "unknown", createdAt: CREATED }), null);
  assert.equal(runTiming({ state: "done", createdAt: CREATED, lastEntryAt: "not a date" }).endMs, null);
});

test("clock skew: client ahead of the daemon", () => {
  // The client clock runs 60s ahead; timestamps arrive 0.3s, 1.5s and 0.1s after the daemon wrote them.
  const lead = 60_000;
  let skew = null;
  skew = observeSkew(skew, ms(10) + lead + 300, at(10));
  skew = observeSkew(skew, ms(20) + lead + 1500, at(20));
  skew = observeSkew(skew, ms(30) + lead + 100, at(30));
  assert.equal(skew, lead + 100);
  const timing = runTiming({ state: "running", createdAt: CREATED });
  // Daemon time 134s after the start reads as 2m 14s, not 3m 14s.
  assert.equal(elapsedMs(timing, ms(134) + lead, skew), 134_000 - 100);
  assert.equal(runStatsView({ state: "running", timing, nowMs: ms(134) + lead, skewMs: skew }).timeText, "Running · 2m 13s");
  assert.equal(runStatsView({ state: "running", timing, nowMs: ms(134) + lead }).timeText, "Running · 3m 14s");
});

test("clock skew: client behind the daemon", () => {
  const lag = -45_000;
  let skew = null;
  skew = observeSkew(skew, ms(5) + lag + 200, at(5));
  skew = observeSkew(skew, ms(6) + lag + 900, at(6));
  assert.equal(skew, lag + 200);
  const timing = runTiming({ state: "running", createdAt: CREATED });
  // Right after the start the uncorrected client time would be negative (clamped to 0s).
  assert.equal(elapsedMs(timing, ms(10) + lag), 0);
  assert.equal(elapsedMs(timing, ms(10) + lag, skew), 10_000 - 200);
  // Never below 0, even with a skew estimate.
  assert.equal(elapsedMs(timing, ms(-60) + lag, skew), 0);
});

test("clock skew: bad timestamps keep the estimate", () => {
  assert.equal(observeSkew(null, ms(1), null), null);
  assert.equal(observeSkew(250, ms(1), "not a date"), 250);
  assert.equal(observeSkew(250, Number.NaN, at(1)), 250);
});

test("runStatsView: running spins and ticks, without tokens until a turn reports them", () => {
  const timing = runTiming({ state: "running", createdAt: CREATED });
  assert.deepEqual(runStatsView({ state: "running", timing, nowMs: ms(134) }), {
    spinning: true,
    live: true,
    timeText: "Running · 2m 14s",
    timeLabel: "Running, 2m 14s since the run started",
    tokenText: null,
    tokenLabel: null,
  });
  assert.equal(runStatsView({ state: "starting", timing, nowMs: ms(3) }).timeText, "Starting · 3s");
});

test("runStatsView: waiting for the owner ticks without spinning", () => {
  const timing = runTiming({ state: "needs-input", createdAt: CREATED });
  const view = runStatsView({ state: "needs-input", timing, nowMs: ms(65) });
  assert.equal(view.spinning, false);
  assert.equal(view.live, true);
  assert.equal(view.timeText, "Waiting for you · 1m 05s");
});

test("runStatsView: an ended run shows its total time and the last turn's tokens", () => {
  const view = (state, usage = CLAUDE_USAGE) =>
    runStatsView({ state, timing: runTiming({ state, createdAt: CREATED, lastEntryAt: at(182) }), nowMs: ms(5000), usage });
  assert.deepEqual(view("done"), {
    spinning: false,
    live: false,
    timeText: "Took 3m 02s",
    timeLabel: "Took 3m 02s",
    tokenText: "last turn: 36 in · 701k cached · 4.6k out",
    tokenLabel: "Last turn's tokens: 36 input, 700962 cached input, 4555 output",
  });
  assert.equal(view("failed").timeText, "Failed after 3m 02s");
  assert.equal(view("stopped").timeText, "Stopped after 3m 02s");
  assert.equal(view("asking").timeText, "Ran 3m 02s");
  // No cached count: just in and out.
  assert.equal(view("done", { inputTokens: 18_400, outputTokens: 950 }).tokenText, "last turn: 18.4k in · 950 out");
  assert.equal(view("done", { inputTokens: 18_400, cachedInputTokens: 0, outputTokens: 950 }).tokenText, "last turn: 18.4k in · 950 out");
  assert.equal(view("done", { outputTokens: 950 }).tokenText, "last turn: 950 out");
});

test("runStatsView: an ended run with no known end shows the state without a time", () => {
  const view = (state) => runStatsView({ state, timing: runTiming({ state, createdAt: CREATED, lastEntryAt: null }), nowMs: ms(9000) });
  assert.equal(view("stopped").timeText, "Stopped");
  assert.equal(view("done").timeText, "Done");
  assert.equal(view("failed").timeText, "Failed");
  assert.equal(view("asking").timeText, "Waiting for the chat");
  assert.equal(view("stopped").live, false);
  assert.doesNotMatch(view("stopped").timeText, /\d/);
});

test("runStatsView: nothing without timing, and never a cost", () => {
  assert.equal(runStatsView({ state: "running", timing: null, nowMs: ms(1) }), null);
  assert.equal(runStatsView({ state: "unknown", timing: { startMs: ms(0), ended: true, endMs: ms(1) }, nowMs: ms(1) }), null);
  const view = runStatsView({
    state: "done",
    timing: { startMs: ms(0), ended: true, endMs: ms(10) },
    nowMs: ms(10),
    usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 1.23 },
  });
  assert.doesNotMatch(`${view.timeText} ${view.tokenText} ${view.tokenLabel}`, /\$|usd|cost|1\.23/i);
});

test("the card wires the stats line; the row spins only with motion and clears its interval", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(card, /<RunStatsRow\b/);
  assert.match(card, /streamSkewMs=\{runMeta\.skewMs\}/);
  const row = readFileSync(new URL("../client/run-stats-row.tsx", import.meta.url), "utf8");
  const spinner = row.slice(row.indexOf("function Spinner"), row.indexOf("export function RunStatsRow"));
  assert.match(spinner, /useReducedMotion\(\)/);
  assert.match(row, /isReduceMotionEnabled/);
  assert.match(row, /reduceMotionChanged/);
  assert.match(row, /clearInterval/);
  assert.match(row, /accessibilityRole="timer"/);
  assert.doesNotMatch(row, /totalCostUsd/);
  const progress = readFileSync(new URL("../client/step-progress.tsx", import.meta.url), "utf8");
  // Usage from a read during a live turn is the previous turn's; going live clears it.
  assert.match(progress, /if \(liveNow\.current\) return;/);
  assert.match(progress, /lastEntryAt: null, usage: null/);
  // A closed agent's timeline is not read: the read would load it again, idle.
  assert.match(progress, /if \(!agentId \|\| stopped\) \{/);
});
