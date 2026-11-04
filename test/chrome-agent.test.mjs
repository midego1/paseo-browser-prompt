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
  chromeAvailable,
  DEFAULT_CHROME_PROVIDER,
  pickChromeProvider,
  runStartedInChrome,
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

test("runs get no Chrome flag unless asked", () => {
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

test("the brand marks pass Paseo's SVG check", async () => {
  const { OPENAI_ICON, CLAUDE_ICON } = await import("../shared/brand-icons.ts");
  const { findSvgIconProblem } = await import(new URL("../node_modules/@getpaseo/plugin/dist/icons.js", import.meta.url).href);
  for (const icon of [OPENAI_ICON, CLAUDE_ICON]) {
    assert.equal(findSvgIconProblem(icon.svg), null);
    assert.match(icon.svg, /fill="currentColor"/, "tinted by the card");
  }
});

test("the card's settings icon opens the page the plugin registers", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(card, /accessibilityLabel="Browser prompt settings"/);
  assert.match(card, /<Icon name="Settings"/);
  assert.match(card, /openPluginSettings\(\)/);
  assert.match(entry, /setOpenSettings\(\(id\) => client\.openSettings\(id\)\)/);
  assert.match(entry, /addSettingsScreen\(\{\s*id: SETTINGS_SCREEN_ID,/);
  assert.match(entry, /setOpenSettings\(null\)/);
  assert.match(run, /SETTINGS_SCREEN_ID = "preferences"/);
});

test("every way on the card can be the usual way", () => {
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../client/settings-screen.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(settings, /startMode: z\.enum\(\["app", "web-agent", "extension", "copy-only", "paseo", "chrome"\]\)\.default\("app"\)/);
  assert.match(settings, /mobileStartMode: z\.enum\(\["copy-only", "web-agent", "paseo", "chrome"\]\)\.default\("copy-only"\)/);
  assert.equal(screen.match(/label: "Paseo browser", value: "paseo"/g)?.length, 2);
  assert.equal(screen.match(/label: "Claude in Chrome", value: "chrome"/g)?.length, 2);
  for (const way of ["app", "web-agent", "extension", "paseo", "chrome"]) assert.ok(card.includes(`highlighted={defaultMode === "${way}"}`), way);
  assert.ok(card.includes('defaultMode === "copy-only" ? styles.primary'), "copy-only");
  assert.match(readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8"), /chatGptMode\(effectiveMode\(/, "the Command Center only opens ChatGPT");
});

test("the ChatGPT extension button copies a prompt for the side panel", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  const launch = readFileSync(new URL("../client/launch.ts", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  assert.match(card, /startInChatGpt\(title, text, "extension"/);
  assert.match(card, /label="Extension"/);
  assert.match(launch, /mode === "extension" \? CHATGPT_EXTENSION_HEADER/);
  assert.match(launch, /if \(mode === "extension"\) \{\s*return copied \? \{ ok: true, message: EXTENSION_HINT \}/, "copies and opens nothing");
  assert.match(settings, /startMode: z\.enum\(\["app", "web-agent", "extension", "copy-only", "paseo", "chrome"\]\)/);
  assert.doesNotMatch(settings, /mobileStartMode: z\.enum\([^)]*"extension"/, "no extension on iOS and Android");
});

test("a stored Browser setting is dropped", () => {
  assert.equal("browserAgent" in migratePreferences({ browserAgent: "chrome" }, 15), false);
  assert.equal("browserAgent" in migratePreferences({ browserAgent: "firefox" }, 14), false);
});

test("the card offers every way to run, per card", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  for (const label of ['label="Desktop"', 'label="Web"', 'label="Extension"', '"Paseo browser"', '"Chrome"', "`Copy ${displayTitle}`", "`Mark ${displayTitle} done`"]) assert.ok(card.includes(label), label);
  assert.match(card, /<Icon icon=\{OPENAI_ICON\}/, "ChatGPT group has its mark");
  assert.match(card, /agentIsClaude \? \(\s*<Icon icon=\{CLAUDE_ICON\}/, "Claude mark only for a Claude provider");
  assert.match(card, /startInChatGpt\(title, text, "app"/);
  assert.match(card, /startInChatGpt\(title, text, "web-agent"/);
  assert.match(card, /onRunPress\("paseo"\)/);
  assert.match(card, /onRunPress\("chrome"\)/);
  assert.match(card, /launchAgent\(pendingBrowser\)/);
  assert.match(card, /browserAgent: browser \}/, "the press decides the browser, not a setting");
  assert.match(card, /\{mobile \? null : \(/, "no ChatGPT app button without a mobile deep link");
  assert.match(card, /\{showChrome \? \(/, "Claude in Chrome only when the launch would work");
  assert.match(card, /"Again: Paseo browser"/, "a card with a run says it would be another run");
  assert.match(card, /"Again: Chrome"/);
  assert.match(card, /\{active \? <Text/, "the confirmation warns about a run still going");
  assert.match(card, /startInChatGpt\(title, text, "copy-only"/, "highlighted Copy keeps the paste hint");
  for (const demo of ["capture", "stills"]) {
    const script = readFileSync(new URL(`../scripts/demo/${demo}.mjs`, import.meta.url), "utf8");
    assert.match(script, /Run \.\* in the Paseo browser/, "the demo presses one button, the Paseo browser");
  }
});

test("Claude in Chrome shows only when the launch would work", () => {
  assert.equal(chromeAvailable(DEFAULT_AGENT_SETTINGS), true);
  assert.equal(chromeAvailable({ ...DEFAULT_AGENT_SETTINGS, agentProvider: "omp", agentModel: "m" }), false);
  assert.equal(chromeAvailable({ ...DEFAULT_AGENT_SETTINGS, agentProvider: "codex", agentModel: "claude/claude-sonnet-5-5" }), true);
  assert.equal(chromeAvailable({ ...DEFAULT_AGENT_SETTINGS, agentProvider: "claude", agentModel: "omp/x" }), false);
  assert.throws(() => resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "chrome", agentModel: "omp/x" }), /use the Paseo browser/);
});

test("Chrome runs can use their own provider, and only Chrome runs", () => {
  const settings = { ...DEFAULT_AGENT_SETTINGS, chromeProvider: " claude-chrome " };
  assert.equal(resolveAgentConfig({ ...settings, browserAgent: "chrome" }).provider, "claude-chrome/claude-sonnet-5-5");
  assert.equal(resolveAgentConfig({ ...settings, browserAgent: "chrome", agentModel: "claude/claude-opus-5-5" }).provider, "claude-chrome/claude-opus-5-5");
  assert.equal(resolveAgentConfig({ ...settings, browserAgent: "chrome" }).modeId, "auto");
  assert.equal(resolveAgentConfig(settings).provider, "claude/claude-sonnet-5-5", "the Paseo browser keeps the Provider setting");
  assert.equal(resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "chrome" }).provider, "claude/claude-sonnet-5-5", "empty keeps it too");
  assert.equal(chromeAvailable({ ...settings, chromeProvider: "omp" }), false);
  // A Chrome provider makes the button work even when the Paseo browser uses another provider family.
  assert.equal(chromeAvailable({ ...settings, agentProvider: "omp", agentModel: "m" }), true);
  assert.equal("chromeProvider" in migratePreferences({ chromeProvider: 5 }, 16), false);
  assert.equal(migratePreferences({ chromeProvider: "claude-chrome" }, 16).chromeProvider, "claude-chrome");
});

test("Chrome runs use claude-chrome by themselves when the daemon has it", () => {
  const list = (available) => [{ provider: "claude", available: true }, { provider: DEFAULT_CHROME_PROVIDER, available }];
  assert.equal(pickChromeProvider("", list(true)), "claude-chrome");
  assert.equal(pickChromeProvider("", list(false)), "", "not available: the Provider setting");
  assert.equal(pickChromeProvider("", null), "", "list failed: the Provider setting");
  assert.equal(pickChromeProvider("", [{ provider: "claude", available: true }]), "");
  assert.equal(pickChromeProvider(" my-chrome ", list(true)), "my-chrome", "the setting wins");
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(run, /resolveAgentConfig\(await withChromeProvider\(paseo, input\.settings\)\)/);
  assert.match(run, /paseo\.providers\.listAvailable\(\)/);
});

test("a run's own record names its browser, not a newer run's", () => {
  const runs = [
    ["a:card1", "run-paseo", "key:k"],
    ["a:card2", "run-chrome", "key:k", CHROME_RUN_MARKER],
    ["a:card3", "run-fallback", "most-recent", "key:k", CHROME_RUN_MARKER],
  ];
  assert.equal(runStartedInChrome(runs, "run-paseo"), false);
  assert.equal(runStartedInChrome(runs, "run-chrome"), true);
  assert.equal(runStartedInChrome(runs, "run-fallback"), true);
  assert.equal(runStartedInChrome(runs, "not-saved-yet"), null);
  assert.equal(runStartedInChrome(runs, null), null);
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
