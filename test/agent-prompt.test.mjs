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
  resolveAgentConfig,
  runStateFrom,
} from "../shared/agent-prompt.ts";

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
  for (const mode of ["bypassPermissions", "auto", "acceptEdits", "full-access", "auto-review", "yolo"]) {
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
  assert.match(agentModeError("claude", "auto"), /not an ask-first mode/);
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
