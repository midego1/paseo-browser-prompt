// Run: npm test. Closing the run's own tabs after a fully successful run: the prompt rule with the
// setting on and off, the setting and its migration, and step progress, thumbnails and the report
// staying intact when the run ends with browser_close_tab calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildAgentPrompt,
  CLOSE_TABS_RULE,
  DEFAULT_AGENT_SETTINGS,
  resolveAgentConfig,
  SCREENSHOT_RULE,
  stepProgressRule,
} from "../shared/agent-prompt.ts";
import { permissionDetails } from "../shared/owner-prompt.ts";
import { finalAssistantText } from "../shared/report-back.ts";
import { createRunTracker } from "../shared/run-tracker.ts";
import { stepScreenshots } from "../shared/screenshot.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";
import { parseQuestion } from "../shared/talk.ts";

const steps = "1. Open https://example.com\n2. Report the page title";
const config = resolveAgentConfig({});
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PNG_A = `file:///tmp/paseo-attachments-Ab12Cd/${HASH_A}.png`;
const PNG_B = `file:///tmp/paseo-attachments-Ab12Cd/${HASH_B}.png`;
const tool = (name) => ({ type: "tool_call", name: `mcp__paseo__${name}`, status: "completed" });
const image = (path) => ({ type: "assistant_message", text: `\n\n![Image](${path})\n\n` });
const say = (text) => ({ type: "assistant_message", text });
const REPORT = "Done: both steps. The title is Example Domain.\nClosed the tab I opened: Example Domain.";

/** A fully successful two-step run that closes its own tab after the last screenshot. */
const successfulRun = [
  { type: "user_message", text: "go" },
  tool("browser_list_tabs"),
  tool("browser_new_tab"),
  say("[browser-prompt step 1/2] Opening example.com"),
  tool("browser_navigate"),
  tool("browser_screenshot"),
  image(PNG_A),
  say("[browser-prompt step 2/2] Reading the title"),
  tool("browser_snapshot"),
  tool("browser_screenshot"),
  image(PNG_B),
  tool("browser_close_tab"),
  say(REPORT),
];

test("close-tabs setting is on by default", () => {
  assert.equal(DEFAULT_AGENT_SETTINGS.closeTabsOnSuccess, true);
});

test("the close-tabs rule is in the preamble only when the setting is on", () => {
  const on = buildAgentPrompt("T", steps, config, undefined, { totalSteps: 2 }, true, true);
  assert.ok(on.includes(CLOSE_TABS_RULE));
  assert.ok(on.indexOf(SCREENSHOT_RULE) < on.indexOf("11. Closing tabs"), "after the screenshot rule");
  assert.ok(on.indexOf(stepProgressRule(2)) < on.indexOf("11. Closing tabs"));
  assert.ok(on.indexOf("11. Closing tabs") < on.indexOf("<steps>"), "before the steps");
  assert.ok(on.includes(`<steps>\n${steps}\n</steps>`), "steps stay verbatim");
  for (const flag of [undefined, false]) {
    const off = buildAgentPrompt("T", steps, config, undefined, { totalSteps: 2 }, true, flag);
    assert.ok(!off.includes("browser_close_tab"), String(flag));
    assert.ok(!off.includes("Closing tabs"), String(flag));
  }
  // Independent of the other optional rules.
  assert.ok(buildAgentPrompt("T", steps, config, undefined, undefined, false, true).includes(CLOSE_TABS_RULE));
});

test("the close-tabs rule: only own tabs, only after full success, last, reported", () => {
  for (const rule of [
    /start the run with browser_list_tabs \(before any browser_new_tab\) and remember which tabs already exist/,
    /remember each tab you open yourself with browser_new_tab/,
    /Only when the run is fully successful \(every numbered step done, none failed, skipped or blocked, no question left unanswered, nothing left for the owner to do\)/,
    /as your very last action, after the last step's screenshot and right before your final report/,
    /close with browser_close_tab each tab you opened yourself with browser_new_tab, and only those/,
    /Never close a tab that already existed when the run started, even if you used it/,
    /write no step marker and take no screenshot for it/,
    /it is not a destructive action under rule 3/,
    /If a close fails, leave that tab open and go on to your report/,
    /anything less than fully successful, close no tab, so the owner can see where it stopped/,
    /In your report, say which tabs you closed \(by page title, never a secret\) or that you left them open and why/,
  ]) {
    assert.match(CLOSE_TABS_RULE, rule);
  }
  assert.doesNotMatch(CLOSE_TABS_RULE, /\[browser-prompt step/, "the rule itself never looks like a step marker");
});

test("the card passes the setting to the prompt, on unless it is false", () => {
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(run, /input\.settings\.closeTabsOnSuccess !== false/);
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  assert.match(settings, /version: 13,/);
  assert.match(settings, /closeTabsOnSuccess: z\.boolean\(\)\.default\(DEFAULT_AGENT_SETTINGS\.closeTabsOnSuccess\)/);
  const screen = readFileSync(new URL("../client/settings-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /label="Close tabs after a successful run"/);
  assert.match(screen, /value=\{values\.closeTabsOnSuccess\}/);
});

test("settings migration to v13: the default (on) applies to existing settings; a bad stored value is dropped", () => {
  const v12 = { agentMode: "auto", showLiveScreenshot: true, thumbnailMode: "all", mergeRepeats: true };
  assert.deepEqual(migratePreferences(v12, 12), v12);
  assert.equal("closeTabsOnSuccess" in migratePreferences(v12, 12), false, "schema default (on) applies");
  assert.equal("closeTabsOnSuccess" in migratePreferences({ ...v12, closeTabsOnSuccess: "yes" }, 12), false);
  assert.equal(migratePreferences({ ...v12, closeTabsOnSuccess: false }, 12).closeTabsOnSuccess, false);
  assert.equal(migratePreferences({ ...v12, closeTabsOnSuccess: false }, 13).closeTabsOnSuccess, false);
});

test("closing tabs after the last step keeps step progress, thumbnails and the report", () => {
  assert.deepEqual(stepScreenshots(successfulRun, 2), [
    { step: 1, source: PNG_A },
    { step: 2, source: PNG_B },
  ]);
  assert.equal(finalAssistantText(successfulRun), REPORT);
  assert.equal(parseQuestion(finalAssistantText(successfulRun)), null, "the report is not a question");

  const read = createRunTracker(2, true, true);
  read.history(successfulRun);
  const view = read.view();
  assert.deepEqual(view.progress, { step: 2, total: 2, text: "Reading the title" });
  assert.equal(view.asking, false);
  assert.equal(view.screenshot, PNG_B);
  assert.equal(view.screenshotStep, 2);
  assert.deepEqual(view.screenshots.map((s) => s.step), [1, 2]);
  assert.equal(view.screenshotsBlocked, false);

  const live = createRunTracker(2, true, true);
  for (const item of successfulRun) live.event({ type: "timeline", item });
  assert.deepEqual(live.view().progress, view.progress);
  assert.deepEqual(live.view().screenshots, view.screenshots);
  assert.equal(live.view().asking, false);
});

test("a close right after a screenshot call does not take the next message as a thumbnail", () => {
  const items = [
    say("[browser-prompt step 1/1] Opening"),
    tool("browser_screenshot"),
    image(PNG_A),
    tool("browser_close_tab"),
    image(PNG_B),
    say(REPORT),
  ];
  assert.deepEqual(stepScreenshots(items, 1), [{ step: 1, source: PNG_A }], "only an image right after browser_screenshot counts");
});

test("in Always Ask mode the close shows as a complete permission, so the card can offer Allow", () => {
  const details = permissionDetails({
    kind: "tool",
    name: "mcp__paseo__browser_close_tab",
    input: { browserId: "123e4567-e89b-42d3-a456-426614174000" },
  });
  assert.equal(details.complete, true);
  assert.deepEqual(details.lines.map((line) => line.value), ["Browser close tab"]);
});
