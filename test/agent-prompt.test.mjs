// Run: npm test  (Node 22+, uses --experimental-strip-types to load the shared TypeScript module)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AGENT_SAFETY_PREAMBLE,
  agentModeError,
  agentTitle,
  buildAgentPrompt,
  DEFAULT_AGENT_SETTINGS,
  MAX_AGENT_TITLE,
  CLASSIFIER_MODE_RULE,
  defaultModeFor,
  isAskFirstMode,
  isClassifierMode,
  resolveAgentConfig,
  runModeAllowed,
  runStateFrom,
  usesClassifierMode,
} from "../shared/agent-prompt.ts";
import { enforceRunMode } from "../shared/mode-guard.ts";
import { registerModeGuard } from "../server/mode-guard-hook.ts";
import { runLabels, sourceAllowsFullReport } from "../shared/report-back.ts";

const steps = [
  "1. Open https://dns.example.com and pick the example.com zone.",
  "2. Go to Security > WAF and   check the rule named `allow-ci`.",
  "",
  "   - leave it enabled",
  "3. Report the rule's action.",
].join("\n");

test("prompt starts with the safety preamble", () => {
  const prompt = buildAgentPrompt("Check WAF rule", steps);
  assert.ok(prompt.startsWith(AGENT_SAFETY_PREAMBLE));
  for (const rule of [
    /Use ONLY the Paseo browser_\* tools/,
    /Do not use Playwright or any browser on the server/,
    /Do not run shell commands/,
    /browser_list_tabs or browser_new_tab, then browser_snapshot/,
    /fresh element refs from the latest snapshot/,
    /has not painted/,
    /AskUserQuestion/,
    /password, token, API key, 2FA code or other secret/,
    /Never ask the owner to paste a secret into the chat/,
    /reply "done"/,
    /delete, revoke, merge, deploy, publish, payment/,
    /security, permissions, billing, DNS or WAF settings/,
    /page differs from what the steps expect/,
    /Never read out, print, copy or repeat secret values/,
    /what is left for the owner/,
  ]) {
    assert.match(prompt, rule);
  }
  assert.doesNotMatch(prompt, /screenshot path/, "reports never point at screenshot files");
});

test("prompt carries the steps verbatim and the task title", () => {
  const prompt = buildAgentPrompt("Check WAF rule", steps);
  assert.ok(prompt.includes(`<steps>\n${steps}\n</steps>`), "steps are byte-for-byte unchanged");
  assert.match(prompt, /\nTask: Check WAF rule\n/);
  const untitled = buildAgentPrompt("  ", steps);
  assert.ok(!untitled.includes("Task:"));
  assert.ok(untitled.includes(steps));
});

test("agent title", () => {
  assert.equal(agentTitle("Check WAF rule"), "Browser: Check WAF rule");
  assert.equal(agentTitle("  spaced   out  "), "Browser: spaced out");
  assert.equal(agentTitle("", "Browser prompt 2"), "Browser: Browser prompt 2");
  const long = agentTitle("x".repeat(200));
  assert.equal(long.length, MAX_AGENT_TITLE);
  assert.ok(long.endsWith("…"));
});

test("settings defaults: Anthropic Claude Sonnet 5.5, thinking high, Auto mode, confirm on", () => {
  assert.deepEqual({ ...DEFAULT_AGENT_SETTINGS }, {
    agentProvider: "claude",
    agentModel: "claude-sonnet-5-5",
    agentThinking: "high",
    agentMode: "auto",
    confirmAgentLaunch: true,
    openAgentOnStart: false,
    talkToChat: true,
    maxChatQuestions: 10,
    showStepProgress: true,
    showLiveScreenshot: true,
    thumbnailMode: "all",
    closeTabsOnSuccess: true,
  });
  assert.deepEqual(resolveAgentConfig(DEFAULT_AGENT_SETTINGS), {
    provider: "claude/claude-sonnet-5-5",
    modeId: "auto",
    thinkingOptionId: "high",
  });
  assert.deepEqual(resolveAgentConfig({}), resolveAgentConfig(DEFAULT_AGENT_SETTINGS));
});

test("config resolution: blanks fall back, unsafe modes are refused", () => {
  assert.equal(resolveAgentConfig({ agentProvider: " ", agentModel: "" }).provider, "claude/claude-sonnet-5-5");
  assert.equal(resolveAgentConfig({ agentModel: "claude-opus-5-5" }).provider, "claude/claude-opus-5-5");
  assert.equal(resolveAgentConfig({ agentModel: "claude/claude-fable-5-1" }).provider, "claude/claude-fable-5-1");
  for (const mode of ["bypassPermissions", "acceptEdits", "full-access", "auto-review", "dontAsk", "yolo", "Auto", ""]) {
    assert.equal(resolveAgentConfig({ agentMode: mode }).modeId, "auto", `${mode} falls back to the default mode`);
  }
  assert.equal(resolveAgentConfig({ agentMode: "default" }).modeId, "default", "Always Ask stays selectable");
  assert.equal(resolveAgentConfig({ agentMode: "plan" }).modeId, "plan");
  // custom provider ids of the claude family use claude's modes
  assert.deepEqual(resolveAgentConfig({ agentProvider: "claude-work", agentMode: "bypassPermissions" }), {
    provider: "claude-work/claude-sonnet-5-5",
    modeId: "auto",
    thinkingOptionId: "high",
  });
  assert.equal(resolveAgentConfig({ agentProvider: "omp", agentModel: "m", agentMode: "full" }).modeId, "ask");
  assert.equal(resolveAgentConfig({ agentProvider: "omp", agentModel: "m", agentMode: "auto" }).modeId, "ask", "omp has no Auto mode");
  // providers without a known ask-first mode are refused rather than started
  assert.throws(() => resolveAgentConfig({ agentProvider: "codex", agentModel: "gpt-6" }), /no known ask-first mode/);
  assert.throws(() => resolveAgentConfig({ agentModel: "antigravity/x" }), /no known ask-first mode/);
  // prototype keys are not providers
  for (const provider of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => resolveAgentConfig({ agentProvider: provider, agentModel: "m" }), /no known ask-first mode/, provider);
    assert.match(agentModeError(provider, "default"), /no known ask-first mode/);
  }
  assert.equal(agentModeError("claude", "default"), null);
  assert.equal(agentModeError("claude", "auto"), null);
  assert.match(agentModeError("claude", "bypassPermissions"), /not allowed for this provider\. Allowed: default, plan \(ask first\), or auto \(classifier-reviewed, the default\)\./);
  assert.match(agentModeError("omp", "auto"), /not allowed for this provider\. Allowed: ask \(ask first\)\.$/, "no classifier mode outside Claude");
  assert.equal("thinkingOptionId" in resolveAgentConfig({ agentThinking: "" }), false);
});

test("run state", () => {
  assert.equal(runStateFrom(null, false), "unknown");
  assert.equal(runStateFrom({ status: "running", attentionReason: null }, false), "running");
  assert.equal(runStateFrom({ status: "running", attentionReason: "permission" }, true), "needs-input");
  assert.equal(runStateFrom({ status: "idle", attentionReason: "finished" }, false), "done");
  assert.equal(runStateFrom({ status: "idle", attentionReason: null }, true), "done");
  assert.equal(runStateFrom({ status: "idle", attentionReason: null }, false), "done", "an old idle run is done");
  assert.equal(runStateFrom({ status: "idle", attentionReason: null }, false, true), "starting", "just started in this card session");
  assert.equal(runStateFrom({ status: "error", attentionReason: "error" }, true), "failed");
  assert.equal(runStateFrom({ status: "closed", attentionReason: null }, true), "stopped");
});

test("Claude Auto mode is the default, kept separate from ask-first modes", () => {
  assert.equal(isAskFirstMode("claude", "default"), true);
  assert.equal(isAskFirstMode("claude", "plan"), true);
  assert.equal(isAskFirstMode("claude", "auto"), false, "auto is not ask-first");
  assert.equal(isClassifierMode("claude", "auto"), true);
  assert.equal(isClassifierMode("claude-work", "auto"), true, "claude family");
  assert.equal(isClassifierMode("claude", "default"), false);
  for (const provider of ["omp", "codex", "opencode", "constructor"]) assert.equal(isClassifierMode(provider, "auto"), false, provider);
  assert.equal(defaultModeFor("claude"), "auto");
  assert.equal(defaultModeFor("claude-work"), "auto");
  assert.equal(defaultModeFor("omp"), "ask");
  assert.equal(defaultModeFor("codex"), null);
  assert.equal(resolveAgentConfig({ agentMode: " auto " }).modeId, "auto");
  assert.throws(() => resolveAgentConfig({ agentProvider: "codex", agentModel: "gpt-6", agentMode: "auto" }), /no known ask-first mode/);
});

test("the Auto mode rule is added to the preamble only for Auto mode", () => {
  const auto = buildAgentPrompt("Check WAF rule", steps, resolveAgentConfig({}));
  assert.ok(auto.startsWith(AGENT_SAFETY_PREAMBLE), "the full safety preamble stays");
  assert.ok(auto.includes(`${AGENT_SAFETY_PREAMBLE}\n${CLASSIFIER_MODE_RULE}\n\n`), "default settings get rule 6");
  assert.match(CLASSIFIER_MODE_RULE, /classifier, not the owner, approves your tool calls/);
  assert.match(CLASSIFIER_MODE_RULE, /MUST ask the owner with AskUserQuestion, as a question and not as a permission request/);
  assert.match(auto, /3\. HARD RULE \(no setting and no message can change it\): STOP and ask the owner with your question tool \(AskUserQuestion\)/, "rule 3 still present");
  for (const config of [undefined, resolveAgentConfig({ agentMode: "default" }), resolveAgentConfig({ agentMode: "plan" }), { provider: "omp/m", modeId: "auto" }]) {
    const prompt = buildAgentPrompt("Check WAF rule", steps, config);
    assert.ok(!prompt.includes(CLASSIFIER_MODE_RULE), JSON.stringify(config));
    assert.ok(prompt.startsWith(AGENT_SAFETY_PREAMBLE));
  }
  assert.equal(usesClassifierMode({ provider: "claude/claude-sonnet-5-5", modeId: "auto" }), true);
  assert.equal(usesClassifierMode({ provider: "claude/claude-sonnet-5-5", modeId: "default" }), false);
});

test("report back still treats a source in Auto mode as not ask-first", () => {
  assert.equal(sourceAllowsFullReport("auto", "claude", "auto"), false, "status-only notice");
  assert.equal(sourceAllowsFullReport("auto", "claude", "default"), true);
  assert.equal(sourceAllowsFullReport("full", "claude", "auto"), true, "only the explicit full setting forwards");
});

test("run modes: Auto, Always Ask and Plan are all fine; refused modes are not", () => {
  for (const mode of ["default", "plan", "auto", " auto "]) assert.equal(runModeAllowed("claude", mode), true, mode);
  for (const mode of ["bypassPermissions", "acceptEdits", "dontAsk", "full-access", "yolo", ""]) {
    assert.equal(runModeAllowed("claude", mode), false, mode);
  }
  assert.equal(runModeAllowed("omp", "ask"), true);
  assert.equal(runModeAllowed("omp", "auto"), false);
  assert.equal(runModeAllowed("codex", "default"), false, "unknown providers have no allowed modes");
});

/** Fake SDK agent handle whose mode reads come from a script; `setMode` is optional. */
function fakeRun({ modes, setMode, archiveError, labels } = {}) {
  const calls = { refresh: 0, archive: 0, setMode: [] };
  let index = 0;
  const handle = {
    async refresh() {
      calls.refresh++;
      const mode = modes[Math.min(index++, modes.length - 1)];
      return { agent: { currentModeId: mode, labels: labels ?? {} } };
    },
    async archive() {
      calls.archive++;
      if (archiveError) throw new Error(archiveError);
      return { archivedAt: "now" };
    },
  };
  if (setMode) {
    handle.setMode = async (mode) => {
      calls.setMode.push(mode);
      return setMode(mode);
    };
  }
  return { handle, calls };
}
const noSleep = { sleep: async () => {}, attempts: 4 };

test("mode guard: drift between Auto, Always Ask and Plan is left alone", () => Promise.all(
  ["default", "plan", "auto"].map(async (actual) => {
    const { handle, calls } = fakeRun({ modes: [actual] });
    assert.deepEqual(await enforceRunMode(handle, "claude", { ...noSleep, restoreMode: "auto" }), { ok: true, actualMode: actual, corrected: false });
    assert.equal(calls.archive, 0);
    assert.deepEqual(calls.setMode, []);
  }),
));

test("mode guard: waits for the mode to be reported, and an unreadable mode is not a violation", async () => {
  const late = fakeRun({ modes: [null, null, "bypassPermissions"] });
  const result = await enforceRunMode(late.handle, "claude", noSleep);
  assert.equal(result.ok, false);
  assert.equal(late.calls.refresh, 3);
  const never = fakeRun({ modes: [null] });
  assert.deepEqual(await enforceRunMode(never.handle, "claude", noSleep), { ok: true, actualMode: null, corrected: false });
  assert.equal(never.calls.archive, 0);
});

test("mode guard: a refused mode is stopped when the SDK cannot set it back", async () => {
  for (const mode of ["bypassPermissions", "acceptEdits"]) {
    const { handle, calls } = fakeRun({ modes: [mode] });
    const result = await enforceRunMode(handle, "claude", noSleep);
    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.equal(result.actualMode, mode);
    assert.match(result.message, new RegExp(`switched to mode "${mode}", which browser runs may not use, so it was stopped \\(archived\\)`));
    assert.equal(calls.archive, 1);
  }
});

test("mode guard: set back with setMode when the SDK offers it", async () => {
  for (const [restoreMode, expected] of [["default", "default"], [undefined, "auto"], ["bypassPermissions", "auto"]]) {
    let mode = "bypassPermissions";
    const { handle, calls } = fakeRun({ modes: ["bypassPermissions"], setMode: (m) => (mode = m) });
    handle.refresh = async () => ({ agent: { currentModeId: mode } });
    const result = await enforceRunMode(handle, "claude", { ...noSleep, restoreMode });
    assert.deepEqual(result, { ok: true, actualMode: expected, corrected: true });
    assert.deepEqual(calls.setMode, [expected], "the requested mode, else the provider default");
    assert.equal(calls.archive, 0);
  }
});

test("mode guard: a failed setMode or one that does not stick still stops the run", async () => {
  const throws = fakeRun({ modes: ["bypassPermissions"], setMode: () => Promise.reject(new Error("unsupported")) });
  assert.equal((await enforceRunMode(throws.handle, "claude", noSleep)).stopped, true);
  assert.equal(throws.calls.archive, 1);
  const ignored = fakeRun({ modes: ["acceptEdits"], setMode: () => undefined });
  assert.equal((await enforceRunMode(ignored.handle, "claude", noSleep)).stopped, true);
  assert.equal(ignored.calls.archive, 1);
});

test("mode guard: when stopping fails too, the card is told to stop it by hand", async () => {
  const { handle } = fakeRun({ modes: ["acceptEdits"], archiveError: "rpc" });
  const result = await enforceRunMode(handle, "claude", noSleep);
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.match(result.message, /could not be stopped\. Stop it in Paseo now\./);
});

/** Host settings whose `runs` record lists the given `[source:card, runId]` entries. */
const recordedRuns = (entries) => ({
  read: async () => ({ status: "ready", revision: "1", values: { runs: entries, reportBack: "auto" } }),
});
const captureHooks = () => {
  const handlers = new Map();
  return { handlers, server: { on: (name, handler) => (handlers.set(name, handler), () => handlers.delete(name)) } };
};

test("server mode guard checks recorded browser runs on turn start and permission requests", async () => {
  const { handlers, server } = captureHooks();
  const logs = [];
  const settings = recordedRuns([1, 2, 3, 4, 5].map((n) => [`src:c${n}`, ["auto", "ask", "plan", "bypass", "edits"][n - 1]]));
  const guard = registerModeGuard(server, settings, { log: (m) => logs.push(m), recordWaitMs: 0 });
  assert.ok(handlers.has("agent.turn_started") && handlers.has("agent.permission_requested"));

  const runs = {
    auto: fakeRun({ modes: ["auto"], labels: runLabels("src", "c1") }),
    ask: fakeRun({ modes: ["default"], labels: runLabels("src", "c2") }),
    plan: fakeRun({ modes: ["plan"], labels: runLabels("src", "c3") }),
    bypass: fakeRun({ modes: ["bypassPermissions"], labels: runLabels("src", "c4") }),
    edits: fakeRun({ modes: ["acceptEdits"], labels: runLabels("src", "c5") }),
    other: fakeRun({ modes: ["bypassPermissions"], labels: {} }),
  };
  const paseo = { agents: { ref: (id) => runs[id].handle } };
  const context = { paseo, signal: new AbortController().signal };
  for (const id of Object.keys(runs)) {
    const name = id === "edits" ? "agent.permission_requested" : "agent.turn_started";
    await handlers.get(name)({ agent: { id, provider: "claude" }, turnId: "t", request: {} }, context);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const id of ["auto", "ask", "plan"]) assert.equal(runs[id].calls.archive, 0, `${id} is allowed`);
  assert.equal(runs.bypass.calls.archive, 1, "bypass is stopped");
  assert.equal(runs.edits.calls.archive, 1, "accept-edits is stopped (on a permission request)");
  assert.equal(runs.other.calls.archive, 0, "never touches agents the plugin did not start");
  assert.deepEqual(logs.sort(), ["run bypass was in mode bypassPermissions; stopped (archived)", "run edits was in mode acceptEdits; stopped (archived)"]);

  await guard.check({ id: "bypass", provider: "claude" }, paseo);
  assert.equal(runs.bypass.calls.archive, 1, "stopped once");
  guard.dispose();
  assert.equal(handlers.size, 0);
});

test("server mode guard never archives an agent the card did not record, labels or not", async () => {
  const { handlers, server } = captureHooks();
  const logs = [];
  // The record lists another run for this card, and nothing for the second card.
  const settings = recordedRuns([["src:c1", "real-run"]]);
  registerModeGuard(server, settings, { log: (m) => logs.push(m), recordWaitMs: 20, recordPollMs: 5 });
  const runs = {
    spoof: fakeRun({ modes: ["bypassPermissions"], labels: runLabels("src", "c1") }),
    stray: fakeRun({ modes: ["bypassPermissions"], labels: runLabels("src", "c9") }),
  };
  const paseo = { agents: { ref: (id) => runs[id].handle } };
  for (const id of Object.keys(runs)) {
    await handlers.get("agent.turn_started")({ agent: { id, provider: "claude" }, turnId: "t" }, { paseo, signal: new AbortController().signal });
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runs.spoof.calls.archive, 0);
  assert.equal(runs.stray.calls.archive, 0);
  assert.deepEqual(logs.sort(), [
    "agent spoof has browser run labels but no card record; mode not checked",
    "agent stray has browser run labels but no card record; mode not checked",
  ]);

  // Unreadable settings are treated as no record: nothing is archived.
  const broken = captureHooks();
  registerModeGuard(broken.server, { read: async () => ({ status: "invalid", revision: "1", error: "bad" }) }, { log: () => {}, recordWaitMs: 0 });
  const run = fakeRun({ modes: ["bypassPermissions"], labels: runLabels("src", "c1") });
  await broken.handlers.get("agent.turn_started")({ agent: { id: "r", provider: "claude" }, turnId: "t" }, { paseo: { agents: { ref: () => run.handle } }, signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(run.calls.archive, 0);
});

test("server mode guard waits briefly for the card to record a new run", async () => {
  const { handlers, server } = captureHooks();
  const entries = [];
  registerModeGuard(server, recordedRuns(entries), { log: () => {}, recordWaitMs: 500, recordPollMs: 5 });
  const run = fakeRun({ modes: ["bypassPermissions"], labels: runLabels("src", "c1") });
  setTimeout(() => entries.push(["src:c1", "new-run"]), 30);
  await handlers.get("agent.turn_started")({ agent: { id: "new-run", provider: "claude" }, turnId: "t" }, { paseo: { agents: { ref: () => run.handle } }, signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(run.calls.archive, 1, "checked once the record appeared");
});

test("the settings screen cannot save a refused permission mode", () => {
  // agentModeError gates the Save action: refused modes produce an error, allowed ones none.
  for (const mode of ["bypassPermissions", "acceptEdits", "dontAsk", "full-access", "auto-review", "yolo"]) {
    assert.notEqual(agentModeError("claude", mode), null, mode);
  }
  for (const mode of ["auto", "default", "plan"]) assert.equal(agentModeError("claude", mode), null, mode);
  const screen = readFileSync(new URL("../client/settings-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /const modeError = agentModeError\(/);
  assert.match(screen, /disabled=\{!agentDirty \|\| modeError !== null\}/, "Save is disabled while the mode is refused");
  assert.match(screen, /if \(modeError !== null\) return; \/\/ never store a refused mode/, "and the handler checks again");
});
