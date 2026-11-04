// Run: npm test. Running a browser agent in the owner's real Chrome: the setting, the launch flag, the
// prompt rules, and masking of text typed through the extension's tools.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AGENT_SAFETY_PREAMBLE,
  buildAgentPrompt,
  CHROME_CLOSE_TABS_RULE,
  CHROME_KEEP_TABS_RULE,
  CHROME_RUN_MARKER,
  CHROME_SAFETY_PREAMBLE,
  CLASSIFIER_MODE_RULE,
  CLOSE_TABS_RULE,
  DEFAULT_AGENT_SETTINGS,
  parseBrowserAgent,
  resolveAgentConfig,
  SCREENSHOT_RULE,
} from "../shared/agent-prompt.ts";
import { permissionDetails } from "../shared/owner-prompt.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";

const AUTO = { provider: "claude/claude-sonnet-5-5", modeId: "auto" };
const chromePrompt = (config = AUTO, screenshots = true, closeTabs = true) =>
  buildAgentPrompt("T", "1. x", config, undefined, undefined, screenshots, closeTabs, false, "chrome");

test("the Paseo browser stays the default, and runs get no Chrome flag", () => {
  assert.equal(DEFAULT_AGENT_SETTINGS.browserAgent, "paseo");
  assert.equal("options" in resolveAgentConfig(DEFAULT_AGENT_SETTINGS), false);
  assert.equal("options" in resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "anything" }), false);
  assert.equal(parseBrowserAgent("chrome"), "chrome");
  assert.equal(parseBrowserAgent("Chrome"), "paseo");
  assert.equal(parseBrowserAgent(undefined), "paseo");
});

test("Chrome adds the CLI flag and keeps Auto mode as the default", () => {
  const config = resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "chrome" });
  assert.deepEqual(config.options, { extraArgs: { chrome: null } });
  assert.equal(config.modeId, "auto");
  assert.equal(resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "chrome", agentMode: "default" }).modeId, "default");
  assert.equal(resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "chrome", agentMode: "bypassPermissions" }).modeId, "auto");
});

test("Chrome needs a Claude provider", () => {
  assert.throws(
    () => resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "chrome", agentProvider: "omp", agentModel: "m", agentMode: "ask" }),
    /needs a Claude provider/,
  );
  assert.equal(
    "options" in resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, agentProvider: "omp", agentModel: "m", agentMode: "ask" }),
    false,
  );
});

test("a run in Chrome gets the Chrome rules and none of the Paseo browser's", () => {
  const prompt = chromePrompt();
  assert.ok(prompt.includes(CHROME_SAFETY_PREAMBLE));
  assert.ok(prompt.includes(CHROME_CLOSE_TABS_RULE));
  assert.ok(prompt.includes(CLASSIFIER_MODE_RULE));
  for (const rule of [AGENT_SAFETY_PREAMBLE, CLOSE_TABS_RULE, SCREENSHOT_RULE]) assert.ok(!prompt.includes(rule));
  assert.ok(!chromePrompt(AUTO, true, false).includes(CHROME_CLOSE_TABS_RULE));
  assert.ok(chromePrompt(AUTO, true, false).includes(CHROME_KEEP_TABS_RULE));
  assert.ok(!prompt.includes(CHROME_KEEP_TABS_RULE));
  assert.match(CHROME_SAFETY_PREAMBLE, /createIfEmpty true/);
  assert.match(CHROME_SAFETY_PREAMBLE, /Never take a screenshot while a page shows/);
  assert.match(CHROME_SAFETY_PREAMBLE, /Do not use the Paseo browser_\* tools/);
  assert.match(CHROME_SAFETY_PREAMBLE, /only on the sites the steps name/);
  assert.match(CHROME_SAFETY_PREAMBLE, /no browser is connected/);
});

test("the chat, step and success rules still come with a run in Chrome", () => {
  const prompt = buildAgentPrompt("T", "1. x", AUTO, { sourceAgentId: "a1", maxQuestions: 3 }, { totalSteps: 1 }, true, true, true, "chrome");
  for (const rule of ["8. Questions for the chat", "9. Progress", "11. Closing tabs", "12. Success line"]) assert.ok(prompt.includes(rule), rule);
  assert.ok(!/(^|\W)browser_(?!\*)/.test(prompt), "no Paseo browser tool is named, only the ban on browser_*");
});

test("a card remembers which browser its run started in", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.equal(CHROME_RUN_MARKER, "browser:chrome");
  assert.match(card, /\.\.\.\(chrome \? \[CHROME_RUN_MARKER\] : \[\]\)/);
  assert.match(card, /runInChrome \? CHROME_HINT : DESKTOP_HINT/);
});

test("both browsers share the hard safety rules", () => {
  for (const rule of ["3. HARD RULE", "4. When the page differs", "5. Never read out", "6. When finished"]) {
    assert.ok(AGENT_SAFETY_PREAMBLE.includes(rule));
    assert.ok(CHROME_SAFETY_PREAMBLE.includes(rule));
  }
});

test("a run in the Paseo browser keeps its prompt", () => {
  const prompt = buildAgentPrompt("T", "1. x", AUTO, undefined, undefined, true, true);
  assert.ok(prompt.includes(AGENT_SAFETY_PREAMBLE));
  assert.ok(prompt.includes(SCREENSHOT_RULE));
  assert.ok(prompt.includes(CLOSE_TABS_RULE));
  assert.ok(!prompt.includes("claude-in-chrome"));
});

test("the setting migrates, and an unknown value falls back", () => {
  assert.equal("browserAgent" in migratePreferences({ browserAgent: "firefox" }, 14), false);
  assert.equal(migratePreferences({ browserAgent: "chrome" }, 14).browserAgent, "chrome");
  assert.equal(migratePreferences({ browserAgent: "chrome" }, 15).browserAgent, "chrome");
});

test("the launch passes the flag and the browser to the prompt", () => {
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(run, /parseBrowserAgent\(input\.settings\.browserAgent\)/);
  assert.match(run, /agents\.create\(\{\s*config,/);
});

test("text typed through the extension's tools is masked on the card", () => {
  const typed = (tool, input) => permissionDetails({ name: tool, input });
  const form = typed("mcp__claude-in-chrome__form_input", { tabId: 7, ref: "ref_1", value: "s3cret" });
  assert.equal(form.lines.find((line) => line.label === "Value")?.masked, true);
  const computer = typed("mcp__claude-in-chrome__computer", { tabId: 7, action: "type", text: "s3cret" });
  assert.equal(computer.lines.find((line) => line.label === "Text")?.masked, true);
  assert.equal(computer.complete, true);
  // Unchecking a box or clearing a field has no line to show, so the card offers no Allow.
  for (const value of [false, "", "  ", null]) {
    assert.equal(typed("mcp__claude-in-chrome__form_input", { tabId: 7, ref: "ref_1", value }).complete, false);
  }
  assert.equal(typed("mcp__claude-in-chrome__form_input", { tabId: 7, ref: "ref_1", value: true }).complete, true);
  assert.equal(typed("mcp__paseo__browser_fill", { ref: "@e1", value: "" }).complete, true);
  assert.equal(typed("mcp__claude-in-chrome__browser_batch", { actions: [{ name: "computer", input: { text: "s3cret" } }] }).complete, false);
  // Another server's tool with the same name is not treated as typing.
  const other = typed("mcp__other__computer", { text: "x" });
  assert.equal(other.lines.find((line) => line.label === "Text")?.masked ?? false, false);
});
