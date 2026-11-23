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
  describeLaunch,
  resolveLaunchWith,
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
  assert.match(card, /browser === "chrome"\s*\? \[CHROME_RUN_MARKER\]\s*: browser === "server"\s*\? \[SERVER_RUN_MARKER\]\s*: browser === "signed-in"\s*\? \[SIGNED_IN_RUN_MARKER\]\s*: \[\]/);
  assert.match(card, /HINTS\[runBrowser\]/);
  assert.match(card, /BROWSER_NAMES\[runBrowser\]/);
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
  const { OPENAI_ICON, CLAUDE_ICON, PASEO_ICON } = await import("../shared/brand-icons.ts");
  const { findSvgIconProblem } = await import(new URL("../node_modules/@getpaseo/plugin/dist/icons.js", import.meta.url).href);
  for (const icon of [OPENAI_ICON, CLAUDE_ICON, PASEO_ICON]) {
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

test("every way on the card stays reachable: the usual way keeps working until the card settings say otherwise", () => {
  const settings = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../client/settings-screen.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  // The stored usual way is unchanged (older plugin versions still read it) and decides the defaults.
  assert.match(settings, /startMode: z\.enum\(\["app", "web-agent", "copy-only", "claude-desktop", "paseo", "chrome", "server", "signed-in"\]\)\.default\("app"\)/);
  assert.match(settings, /mobileStartMode: z\.enum\(\["copy-only", "web-agent", "paseo", "chrome", "server", "signed-in"\]\)\.default\("copy-only"\)/);
  // The card's own choices live in their own document (rollback-safe).
  assert.match(settings, /id: "card",\n  scope: "host",\n  version: 1,/);
  assert.match(settings, /runWay: z\.enum\(\["", "signed-in", "server", "paseo", "chrome"\]\)\.default\(""\)/);
  assert.match(settings, /chatGpt: z\.enum\(\["", "app", "web-agent", "copy-only"\]\)\.default\(""\)/);
  assert.match(settings, /claude: z\.enum\(\["claude-desktop", "copy-only"\]\)\.default\("claude-desktop"\)/);
  assert.match(card, /const runWay = defaultRunWay\(choices, usualWay, showChrome\);/);
  assert.match(card, /const gptTarget = chatGptTarget\(choices, usualWay, mobile\);/);
  for (const label of ['label="The Run button uses"', 'label="ChatGPT"', 'label="Claude"']) assert.ok(screen.includes(label), label);
  for (const way of ['value: "signed-in"', 'value: "server"', 'value: "paseo"', 'value: "chrome"', 'value: "app"', 'value: "web-agent"', 'value: "copy-only"', 'value: "claude-desktop"']) assert.ok(screen.includes(way), way);
  const entry = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  const launch = readFileSync(new URL("../client/launch.ts", import.meta.url), "utf8");
  assert.match(entry, /commandCenterChatGptMode\(\)/, "the Command Center only opens ChatGPT");
  assert.match(launch, /return lastChatGpt \?\? chatGptMode\(effectiveMode\(getRememberedModes\(\)\)\);/, "as the cards' Send to ChatGPT, else from the usual way");
});

test("the Claude group opens the Claude desktop app and runs in a Chrome tab", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  const launch = readFileSync(new URL("../client/launch.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(card, /startInClaudeDesktop\(title, text, \(prompt\) => stash\(\{ prompt, target: "claude" \}\)\)/);
  assert.match(card, /copyForClaude\(title, text\)/, "Send to Claude with Copy only");
  assert.match(launch, /composePrompt\(title, body, CLAUDE_DESKTOP_HEADER\)/);
  assert.match(server, /if \(target === "claude"\) return launcher\.stash\(prompt, CLAUDE_DESKTOP_LINK_TEMPLATE\);/);
  assert.doesNotMatch(card, /"extension"/, "no ChatGPT extension button any more");
  assert.equal(migratePreferences({ startMode: "extension" }, 17).startMode, "app");
  assert.equal(migratePreferences({ startMode: "web-agent" }, 17).startMode, "web-agent");
});


test("a stored Browser setting is dropped", () => {
  assert.equal("browserAgent" in migratePreferences({ browserAgent: "chrome" }, 15), false);
  assert.equal("browserAgent" in migratePreferences({ browserAgent: "firefox" }, 14), false);
});

test("the card offers every way to run, per card: Run, Run once in…, Send to ChatGPT and Claude, Copy steps, Mark done", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  for (const label of ['"Copy steps"', '"Mark done"', '"Not done"', "`Copy ${displayTitle}`", "`Mark ${displayTitle} done`", 'name="ChatGPT"', 'name="Claude"', "Change the default…", 'title="Run once in…"']) assert.ok(card.includes(label), label);
  // Order: Run, then Send to ChatGPT, then Send to Claude; the quiet row last.
  const run = card.indexOf("<SplitRun");
  const chatgpt = card.indexOf('name="ChatGPT"');
  const claude = card.indexOf('name="Claude"');
  const quiet = card.indexOf("<View style={styles.quiet}>");
  assert.ok(run > 0 && run < chatgpt && chatgpt < claude && claude < quiet, "Run, then ChatGPT, then Claude, then the quiet row");
  assert.match(card, /<Icon icon=\{icon\} size=\{16\} color=\{color\} \/>/, "Send buttons: brand mark in color");
  assert.match(card, /icon=\{OPENAI_ICON\}\s+color=\{OPENAI_COLOR\}/);
  assert.match(card, /icon=\{CLAUDE_ICON\}\s+color=\{CLAUDE_COLOR\}/);
  assert.match(card, /startInChatGpt\(title, text, gptTarget, \(prompt\) => stash\(\{ prompt \}\)\)/);
  assert.match(card, /startInClaudeDesktop\(title, text, \(prompt\) => stash\(\{ prompt, target: "claude" \}\)\)/);
  assert.match(card, /onRun=\{\(\) => void onRunPress\(runWay\)\}/);
  assert.match(card, /runMenuItems\(runWay, showChrome\)/, "Claude in Chrome only when the launch would work");
  assert.match(card, /launchAgent\(pendingLaunch\)/);
  assert.match(card, /resolveLaunch\(paseo, [^)]*, browser\)/, "the press decides the browser, not a setting");
  assert.match(card, /\{shape\.showSendClaude \? \(/, "no Claude button without a Claude app (phones)");
  assert.match(card, /\{active \? <Text/, "the confirmation warns about a run still going");
  assert.match(card, /copyPrompt\(title, text\)/, "Copy steps copies the prompt");
  for (const demo of ["capture", "stills"]) {
    const script = readFileSync(new URL(`../scripts/demo/${demo}.mjs`, import.meta.url), "utf8");
    assert.match(script, /Run \.\* in the Paseo browser/, "the demo presses one button, the Paseo browser");
  }
});

test("Run once in… runs once and never changes the default", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  const once = card.slice(card.indexOf("function runOnceIn("), card.indexOf("function sendTo("));
  assert.match(once, /setMenuOpen\(false\);\s+void onRunPress\(way\);/);
  assert.doesNotMatch(once, /save|cardPrefs|runWay/, "no settings write, no default change");
  assert.match(card, /accessibilityLabel="Change the default way to run"[\s\S]{0,200}openSettingsScreen\(\)/, "Change the default… opens the settings");
  const onRunPress = card.slice(card.indexOf("async function onRunPress("), card.indexOf("/** The owner's Lock now"));
  assert.doesNotMatch(onRunPress, /\.save\(/, "a run never saves a default");
});

test("Stop archives the run (the mode guard's stop), only after a second press", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(run, /export async function stopRunAgent\(paseo: PaseoApi, agentId: string\): Promise<void> \{\n\s+await paseo\.agents\.ref\(agentId\)\.archive\(\);/);
  const stop = card.slice(card.indexOf("async function stopRun("), card.indexOf("const runVisuals ="));
  assert.match(stop, /if \(!stopArmed\) \{\s+setStopArmed\(true\);\s+return;\s+\}/, "the first press only arms it");
  assert.match(stop, /await stopRunAgent\(paseo, stopped\);/);
  assert.match(card, /setTimeout\(\(\) => setStopArmed\(false\), STOP_CONFIRM_MS\)/, "and it disarms by itself");
  assert.match(card, /onPress=\{\(\) => void stopRun\(\)\}/);
  // Shown for a run that is going (running and needs you), for every browser.
  assert.match(card, /\{phase === "running" \? watchStop\(\) : null\}/);
  const panel = card.slice(card.indexOf("<View style={styles.ask}>"), card.indexOf("{showSteps ? ("));
  assert.match(panel, /\{watchStop\(\)\}/, "in the needs-you panel too");
  assert.doesNotMatch(card.slice(card.indexOf("function watchStop()")), /runBrowser === "(paseo|server|chrome)"/, "no browser is left out");
});

test("the confirmation describes the exact provider and mode the run starts with", () => {
  const omp = { ...DEFAULT_AGENT_SETTINGS, agentProvider: "omp", agentModel: "m", agentMode: "ask" };
  // The registry review's case: Oh My Pi in ask mode, with a Claude provider for Chrome.
  const chrome = resolveAgentConfig({ ...omp, browserAgent: "chrome", chromeProvider: "claude-chrome" });
  const text = describeLaunch(chrome, "chrome");
  assert.match(text, /claude-chrome\/m, starting in Auto mode/);
  assert.match(text, /not you, approves its browser actions/);
  assert.doesNotMatch(text, /asks you before every new tool/);
  assert.match(describeLaunch(resolveAgentConfig(omp), "paseo"), /omp\/m, starting in "ask" mode: it asks you before every new tool/);
  assert.match(describeLaunch(resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, agentMode: "default" }), "chrome"), /starting in Always Ask mode/);
  assert.match(describeLaunch(resolveAgentConfig(DEFAULT_AGENT_SETTINGS), "paseo"), /claude\/claude-sonnet-5-5, starting in Auto mode: a model classifier, not you, reviews/);
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(card, /describeLaunch\(pendingLaunch\.config, pendingLaunch\.browser\)/, "the text comes from the resolved launch");
  assert.match(card, /settings: values,\s*launch,/, "the start uses that same launch");
  assert.match(run, /resolveLaunchWith\(\(\) => paseo\.providers\.listAvailable\(\), settings, browser\)/, "includes the automatic Chrome provider");
});

test("the reviewer's case end to end: the automatic Chrome provider is what the confirmation names and the run uses", async () => {
  const omp = { ...DEFAULT_AGENT_SETTINGS, agentProvider: "omp", agentModel: "m", agentMode: "ask" };
  const listAvailable = async () => ({ providers: [{ provider: "omp", available: true }, { provider: "claude-chrome", available: true }] });
  const launch = await resolveLaunchWith(listAvailable, omp, "chrome");
  assert.ok("config" in launch, JSON.stringify(launch));
  assert.deepEqual(launch.config, { provider: "claude-chrome/m", modeId: "auto", thinkingOptionId: "high", options: { extraArgs: { chrome: null } } });
  assert.equal(launch.settings.browserAgent, "chrome");
  assert.match(describeLaunch(launch.config, launch.browser), /claude-chrome\/m, starting in Auto mode: a model classifier, not you, approves/);
  // Without claude-chrome the Provider setting applies, and Chrome refuses a non-Claude provider.
  const refused = await resolveLaunchWith(async () => ({ providers: [] }), omp, "chrome");
  assert.ok("error" in refused && /needs a Claude provider/.test(refused.error));
  const failedLookup = await resolveLaunchWith(async () => { throw new Error("down"); }, DEFAULT_AGENT_SETTINGS, "chrome");
  assert.ok("config" in failedLookup && failedLookup.config.provider === "claude/claude-sonnet-5-5");
  const paseo = await resolveLaunchWith(async () => { throw new Error("not asked"); }, omp, "paseo");
  assert.ok("config" in paseo && paseo.config.provider === "omp/m" && paseo.config.modeId === "ask");
  const run = readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8");
  assert.match(run, /const launch = input\.launch \?\? \(await resolveLaunch\(/, "the start uses the confirmed launch");
});

test("only the latest press counts, and the agent buttons wait while it resolves", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(card, /const seq = \+\+pressSeq\.current;/);
  assert.match(card, /if \(seq !== pressSeq\.current\) return;/);
  assert.match(card, /const runDisabled = busy \|\| resolving \|\| runBlocked;/);
  // Run, its chevron and every "Run once in…" row wait.
  assert.equal(card.match(/disabled=\{runDisabled\}/g)?.length, 2);
  assert.match(card, /disabled=\{disabled\}\n\s+onPress=\{onMenu\}/, "the chevron too");
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
  assert.match(run, /resolveLaunchWith\(\(\) => paseo\.providers\.listAvailable\(\)/);
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

test("the confirmation names only the modes the run's provider may move between", () => {
  const omp = resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, agentProvider: "omp", agentModel: "m", agentMode: "ask" });
  const ompText = describeLaunch(omp, "paseo");
  assert.doesNotMatch(ompText, /Auto, Always Ask and Plan/, "Oh My Pi has no Auto or Plan mode");
  assert.match(ompText, /It must stay in "ask" mode; other modes are stopped\./);
  const claude = describeLaunch(resolveAgentConfig(DEFAULT_AGENT_SETTINGS), "paseo");
  assert.match(claude, /It can move between Auto, Always Ask and Plan later; other modes are stopped\./);
  const chrome = describeLaunch(resolveAgentConfig({ ...DEFAULT_AGENT_SETTINGS, browserAgent: "chrome", chromeProvider: "claude-chrome" }), "chrome");
  assert.match(chrome, /Auto, Always Ask and Plan/, "claude-chrome is a Claude provider");
});
