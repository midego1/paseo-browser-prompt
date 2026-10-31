// Run: npm test  (Node 22+, uses --experimental-strip-types to load the shared TypeScript module)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_SAFETY_PREAMBLE,
  agentModeError,
  agentTitle,
  buildAgentPrompt,
  DEFAULT_AGENT_SETTINGS,
  MAX_AGENT_TITLE,
  CLASSIFIER_MODE_RULE,
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
    /password, token, API key or other secret/,
    /Never ask the owner to paste a secret into the chat/,
    /reply "done"/,
    /delete, revoke, merge, deploy, publish, payment/,
    /security, permissions, billing, DNS or WAF settings/,
    /page differs from what the steps expect/,
    /Never read out, print, copy or repeat secret values/,
    /what is left for the owner/,
    /screenshot path/,
  ]) {
    assert.match(prompt, rule);
  }
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

test("settings defaults: Anthropic Claude Sonnet 5.5, thinking high, ask mode, confirm on", () => {
  assert.deepEqual({ ...DEFAULT_AGENT_SETTINGS }, {
    agentProvider: "claude",
    agentModel: "claude-sonnet-5-5",
    agentThinking: "high",
    agentMode: "default",
    confirmAgentLaunch: true,
  });
  assert.deepEqual(resolveAgentConfig(DEFAULT_AGENT_SETTINGS), {
    provider: "claude/claude-sonnet-5-5",
    modeId: "default",
    thinkingOptionId: "high",
  });
  assert.deepEqual(resolveAgentConfig({}), resolveAgentConfig(DEFAULT_AGENT_SETTINGS));
});

test("config resolution: blanks fall back, unsafe modes are refused", () => {
  assert.equal(resolveAgentConfig({ agentProvider: " ", agentModel: "" }).provider, "claude/claude-sonnet-5-5");
  assert.equal(resolveAgentConfig({ agentModel: "claude-opus-5-5" }).provider, "claude/claude-opus-5-5");
  assert.equal(resolveAgentConfig({ agentModel: "claude/claude-fable-5-1" }).provider, "claude/claude-fable-5-1");
  for (const mode of ["bypassPermissions", "acceptEdits", "full-access", "auto-review", "dontAsk", "yolo"]) {
    assert.equal(resolveAgentConfig({ agentMode: mode }).modeId, "default");
  }
  assert.equal(resolveAgentConfig({ agentMode: "plan" }).modeId, "plan");
  // custom provider ids of the claude family use claude's ask-first modes
  assert.deepEqual(resolveAgentConfig({ agentProvider: "claude-work", agentMode: "bypassPermissions" }), {
    provider: "claude-work/claude-sonnet-5-5",
    modeId: "default",
    thinkingOptionId: "high",
  });
  assert.equal(resolveAgentConfig({ agentProvider: "omp", agentModel: "m", agentMode: "full" }).modeId, "ask");
  // providers without a known ask-first mode are refused rather than started
  assert.throws(() => resolveAgentConfig({ agentProvider: "codex", agentModel: "gpt-6" }), /no known ask-first mode/);
  assert.throws(() => resolveAgentConfig({ agentModel: "antigravity/x" }), /no known ask-first mode/);
  // prototype keys are not providers
  for (const provider of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => resolveAgentConfig({ agentProvider: provider, agentModel: "m" }), /no known ask-first mode/, provider);
    assert.match(agentModeError(provider, "default"), /no known ask-first mode/);
  }
  assert.equal(agentModeError("claude", "default"), null);
  assert.equal(agentModeError("claude", "auto"), null, "Claude Auto mode is an allowed opt-in");
  assert.match(agentModeError("claude", "bypassPermissions"), /not allowed for this provider\. Allowed: default, plan \(ask first\), or auto \(classifier-reviewed, opt-in\)\./);
  assert.match(agentModeError("omp", "auto"), /not allowed for this provider\. Allowed: ask \(ask first\)\.$/, "no classifier mode outside Claude");
  assert.equal("thinkingOptionId" in resolveAgentConfig({ agentThinking: "" }), false);
});

test("run state", () => {
  assert.equal(runStateFrom(null, false), "unknown");
  assert.equal(runStateFrom({ status: "running", attentionReason: null }, false), "running");
  assert.equal(runStateFrom({ status: "running", attentionReason: "permission" }, true), "needs-input");
  assert.equal(runStateFrom({ status: "idle", attentionReason: "finished" }, false), "done");
  assert.equal(runStateFrom({ status: "idle", attentionReason: null }, true), "done");
  assert.equal(runStateFrom({ status: "idle", attentionReason: null }, false), "starting");
  assert.equal(runStateFrom({ status: "error", attentionReason: "error" }, true), "failed");
  assert.equal(runStateFrom({ status: "closed", attentionReason: null }, true), "stopped");
});

test("Claude Auto mode is an explicit opt-in, separate from ask-first modes", () => {
  assert.equal(isAskFirstMode("claude", "default"), true);
  assert.equal(isAskFirstMode("claude", "plan"), true);
  assert.equal(isAskFirstMode("claude", "auto"), false, "auto is not ask-first");
  assert.equal(isClassifierMode("claude", "auto"), true);
  assert.equal(isClassifierMode("claude-work", "auto"), true, "claude family");
  assert.equal(isClassifierMode("claude", "default"), false);
  for (const provider of ["omp", "codex", "opencode", "constructor"]) assert.equal(isClassifierMode(provider, "auto"), false, provider);

  assert.deepEqual(resolveAgentConfig({ agentMode: "auto" }), {
    provider: "claude/claude-sonnet-5-5",
    modeId: "auto",
    thinkingOptionId: "high",
  });
  assert.equal(resolveAgentConfig({ agentMode: " auto " }).modeId, "auto");
  assert.equal(resolveAgentConfig({ agentProvider: "claude-work", agentMode: "auto" }).modeId, "auto");
  assert.equal(resolveAgentConfig({ agentProvider: "omp", agentModel: "m", agentMode: "auto" }).modeId, "ask", "omp has no auto");
  for (const mode of ["bypassPermissions", "acceptEdits", "dontAsk", "Auto", "AUTO"]) {
    assert.equal(resolveAgentConfig({ agentMode: mode }).modeId, "default", mode);
  }
  assert.equal(DEFAULT_AGENT_SETTINGS.agentMode, "default", "the default stays Always Ask");
  assert.throws(() => resolveAgentConfig({ agentProvider: "codex", agentModel: "gpt-6", agentMode: "auto" }), /no known ask-first mode/);
});

test("the Auto mode rule is added to the preamble only for Auto mode", () => {
  const auto = buildAgentPrompt("Check WAF rule", steps, resolveAgentConfig({ agentMode: "auto" }));
  assert.ok(auto.startsWith(AGENT_SAFETY_PREAMBLE), "the full safety preamble stays");
  assert.ok(auto.includes(`${AGENT_SAFETY_PREAMBLE}\n${CLASSIFIER_MODE_RULE}\n\n`));
  assert.match(CLASSIFIER_MODE_RULE, /classifier, not the owner, approves your tool calls/);
  assert.match(CLASSIFIER_MODE_RULE, /MUST ask the owner with AskUserQuestion, as a question and not as a permission request/);
  assert.match(auto, /3\. STOP and ask the owner with your question tool \(AskUserQuestion\)/, "rule 3 still present");
  for (const config of [undefined, resolveAgentConfig({}), resolveAgentConfig({ agentMode: "plan" }), { provider: "omp/m", modeId: "auto" }]) {
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

test("run modes: ask-first always allowed, Auto only when requested, everything else not", () => {
  assert.equal(runModeAllowed("claude", "default", "default"), true);
  assert.equal(runModeAllowed("claude", "default", "plan"), true, "stricter is fine");
  assert.equal(runModeAllowed("claude", "auto", "default"), true);
  assert.equal(runModeAllowed("claude", "auto", "auto"), true);
  assert.equal(runModeAllowed("claude", "default", "auto"), false, "unrequested Auto mode");
  assert.equal(runModeAllowed("claude", "", "auto"), false, "runs without a mode label");
  assert.equal(runModeAllowed("claude", "auto", "bypassPermissions"), false);
  assert.equal(runModeAllowed("claude", "default", "acceptEdits"), false);
  assert.equal(runModeAllowed("omp", "auto", "auto"), false);
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

test("mode guard: an allowed mode is left alone", async () => {
  for (const [requested, actual] of [["default", "default"], ["default", "plan"], ["auto", "auto"], ["auto", "default"]]) {
    const { handle, calls } = fakeRun({ modes: [actual] });
    assert.deepEqual(await enforceRunMode(handle, "claude", requested, noSleep), { ok: true, actualMode: actual, corrected: false });
    assert.equal(calls.archive, 0);
  }
});

test("mode guard: waits for the mode to be reported, and an unreadable mode is not a violation", async () => {
  const late = fakeRun({ modes: [null, null, "auto"] });
  const result = await enforceRunMode(late.handle, "claude", "default", noSleep);
  assert.equal(result.ok, false);
  assert.equal(late.calls.refresh, 3);
  const never = fakeRun({ modes: [null] });
  assert.deepEqual(await enforceRunMode(never.handle, "claude", "default", noSleep), { ok: true, actualMode: null, corrected: false });
  assert.equal(never.calls.archive, 0);
});

test("mode guard: an unrequested Auto mode is stopped when the SDK cannot set it back", async () => {
  const { handle, calls } = fakeRun({ modes: ["auto"] });
  const result = await enforceRunMode(handle, "claude", "default", noSleep);
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.equal(result.actualMode, "auto");
  assert.match(result.message, /switched to mode "auto" instead of "default", so it was stopped \(archived\)/);
  assert.equal(calls.archive, 1);
});

test("mode guard: set back with setMode when the SDK offers it", async () => {
  let mode = "bypassPermissions";
  const { handle, calls } = fakeRun({ modes: ["bypassPermissions"], setMode: (m) => (mode = m) });
  handle.refresh = async () => ({ agent: { currentModeId: mode } });
  const result = await enforceRunMode(handle, "claude", "default", noSleep);
  assert.deepEqual(result, { ok: true, actualMode: "default", corrected: true });
  assert.deepEqual(calls.setMode, ["default"]);
  assert.equal(calls.archive, 0);
});

test("mode guard: a failed setMode or one that does not stick still stops the run", async () => {
  const throws = fakeRun({ modes: ["auto"], setMode: () => Promise.reject(new Error("unsupported")) });
  assert.equal((await enforceRunMode(throws.handle, "claude", "default", noSleep)).stopped, true);
  assert.equal(throws.calls.archive, 1);
  const ignored = fakeRun({ modes: ["auto"], setMode: () => undefined });
  assert.equal((await enforceRunMode(ignored.handle, "claude", "default", noSleep)).stopped, true);
  assert.equal(ignored.calls.archive, 1);
});

test("mode guard: when stopping fails too, the card is told to stop it by hand", async () => {
  const { handle } = fakeRun({ modes: ["acceptEdits"], archiveError: "rpc" });
  const result = await enforceRunMode(handle, "claude", "auto", noSleep);
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.match(result.message, /could not be stopped\. Stop it in Paseo now\./);
});

test("server mode guard checks browser runs on turn start and permission requests", async () => {
  const handlers = new Map();
  const logs = [];
  const guard = registerModeGuard({ on: (name, handler) => (handlers.set(name, handler), () => handlers.delete(name)) }, (m) => logs.push(m));
  assert.ok(handlers.has("agent.turn_started") && handlers.has("agent.permission_requested"));

  const runs = {
    flipped: fakeRun({ modes: ["auto"], labels: runLabels("src", "c1", "default") }),
    optedIn: fakeRun({ modes: ["auto"], labels: runLabels("src", "c2", "auto") }),
    legacy: fakeRun({ modes: ["auto"], labels: runLabels("src", "c3") }),
    other: fakeRun({ modes: ["bypassPermissions"], labels: {} }),
  };
  const paseo = { agents: { ref: (id) => runs[id].handle } };
  for (const id of Object.keys(runs)) {
    await handlers.get("agent.turn_started")({ agent: { id, provider: "claude" }, turnId: "t" }, { paseo, signal: new AbortController().signal });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runs.flipped.calls.archive, 1, "unrequested Auto mode is stopped");
  assert.equal(runs.optedIn.calls.archive, 0, "requested Auto mode is kept");
  assert.equal(runs.legacy.calls.archive, 1, "0.2.0 runs may only be ask-first");
  assert.equal(runs.other.calls.archive, 0, "never touches agents the plugin did not start");
  assert.ok(logs.every((m) => /^run (flipped|legacy) was in mode auto; stopped \(archived\)$/.test(m)), logs.join("\n"));

  await guard.check({ id: "flipped", provider: "claude" }, paseo);
  assert.equal(runs.flipped.calls.archive, 1, "stopped once");
  guard.dispose();
  assert.equal(handlers.size, 0);
});
