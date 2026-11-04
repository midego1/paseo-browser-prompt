// Run: npm test. Archiving a browser agent after a fully successful run: the success line, the prompt
// rule, when the server archives and when it leaves the run open, and what the chat and card see.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildAgentPrompt,
  DEFAULT_AGENT_SETTINGS,
  hasRunSuccessMarker,
  QUESTION_MARKER,
  RUN_SUCCESS_MARKER,
  RUN_SUCCESS_RULE,
  stripRunSuccessMarker,
} from "../shared/agent-prompt.ts";
import { runLabels } from "../shared/report-back.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";
import { createReportBack } from "../server/report-back.ts";
import { readArchiveOnSuccess } from "../server/report-back-hook.ts";
import { fileReportedStore } from "../server/reported-store.ts";

const SOURCE = "agent-source";
const RUN = "agent-run";
const WS = "ws-1";
const SUCCESS = `All steps done.\n${RUN_SUCCESS_MARKER}\n`;

function setup({ text = SUCCESS, run = {}, source = {}, ...extra } = {}) {
  const sent = [];
  const archives = [];
  const agents = {
    [SOURCE]: { labels: {}, status: "idle", workspaceId: WS, provider: "claude", currentModeId: "default", ...source },
    [RUN]: { labels: runLabels(SOURCE, "card-1"), status: "idle", workspaceId: WS, text, ...run },
  };
  const paseo = {
    agents: {
      ref: (id) => ({
        async refresh() {
          const agent = agents[id];
          if (!agent) return null;
          const snapshot = { ...agent };
          if (agent.settlesAfter > 0) agent.settlesAfter--;
          else if (agent.settlesAfter === 0) agent.status = "idle";
          return { agent: snapshot };
        },
        timeline: {
          refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: agents[id].text } }] }),
        },
        waitForFinish: async () => ({ status: "idle" }),
        async send(message) {
          sent.push(message);
        },
        async archive() {
          if (agents[id].archiveError) throw new Error("archive failed");
          archives.push(id);
          agents[id].status = "closed";
          agents[id].archivedAt = "now";
          return { archivedAt: "now" };
        },
      }),
    },
  };
  const reportBack = createReportBack({
    mode: async () => "auto",
    recordedRun: async () => ({ fallback: false }),
    archiveOnSuccess: async () => true,
    log: () => {},
    recordWaitMs: 30,
    recordPollMs: 5,
    notARunTtlMs: 0,
    ...extra,
  });
  return { paseo, reportBack, sent, archives, agents };
}

const ended = (outcome = { kind: "completed" }) => ({
  agent: { id: RUN, workspaceId: WS, parentAgentId: null, provider: "claude", cwd: "/tmp", title: "Browser: Task" },
  outcome,
});

test("the success line counts only as the last line", () => {
  assert.equal(hasRunSuccessMarker(SUCCESS), true);
  assert.equal(hasRunSuccessMarker(`${RUN_SUCCESS_MARKER}\nStep 3 failed.`), false);
  assert.equal(hasRunSuccessMarker(`It said ${RUN_SUCCESS_MARKER} here`), false);
  assert.equal(hasRunSuccessMarker(""), false);
  assert.equal(stripRunSuccessMarker(SUCCESS), "All steps done.");
  assert.equal(stripRunSuccessMarker("Step 3 failed.\n"), "Step 3 failed.\n");
});

test("the prompt asks for the line only with the setting on; the setting is off by default", () => {
  assert.equal(DEFAULT_AGENT_SETTINGS.archiveAgentOnSuccess, false);
  assert.ok(buildAgentPrompt("T", "1. x", undefined, undefined, undefined, false, false, true).includes(RUN_SUCCESS_RULE));
  assert.ok(!buildAgentPrompt("T", "1. x", undefined, undefined, undefined, false, false, false).includes(RUN_SUCCESS_MARKER));
  assert.match(readFileSync(new URL("../client/agent-run.ts", import.meta.url), "utf8"), /input\.settings\.archiveAgentOnSuccess === true/);
});

test("a run that succeeded is archived after its report, and the chat does not see the line", async () => {
  const w = setup();
  assert.equal(await w.reportBack.onTurnEnded(ended(), w.paseo), "sent");
  assert.deepEqual(w.archives, [RUN]);
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0].includes("All steps done."));
  assert.ok(!w.sent[0].includes(RUN_SUCCESS_MARKER));
  assert.equal(await w.reportBack.wasArchived(RUN), true);
  await w.reportBack.dispose();
});

test("with reports off a recorded run that succeeded is still archived", async () => {
  const w = setup({ mode: async () => "off" });
  assert.equal(await w.reportBack.onTurnEnded(ended(), w.paseo), "disabled");
  assert.deepEqual(w.archives, [RUN]);
  await w.reportBack.dispose();
});

test("a run still settling when the hook fires is archived once it is idle", async () => {
  const w = setup({ mode: async () => "off", run: { status: "running", settlesAfter: 1 } });
  await w.reportBack.onTurnEnded(ended(), w.paseo);
  assert.deepEqual(w.archives, [RUN]);
  await w.reportBack.dispose();
});

const LEFT_OPEN = {
  "setting off": { archiveOnSuccess: async () => false },
  "setting not wired": { archiveOnSuccess: undefined },
  "setting unreadable": {
    archiveOnSuccess: async () => {
      throw new Error("nope");
    },
  },
  "no success line": { text: "Step 3 failed.\n" },
  "line not last": { text: `${RUN_SUCCESS_MARKER}\nBut step 3 failed.` },
  "a question": { text: `${QUESTION_MARKER} Which one?\n${RUN_SUCCESS_MARKER}` },
  "a question later in the text": { text: `Step 1 done.\n${QUESTION_MARKER} Which one?\n${RUN_SUCCESS_MARKER}` },
  "not recorded by a card": { mode: async () => "off", recordedRun: async () => null },
  "chat gone, so no report": { source: { archivedAt: "then" } },
  "a new turn started": { run: { status: "running" }, mode: async () => "off" },
  "waiting for a permission": { run: { pendingPermissions: [{}] }, mode: async () => "off" },
};

for (const [name, overrides] of Object.entries(LEFT_OPEN)) {
  test(`stays open: ${name}`, { timeout: 15000 }, async () => {
    const w = setup(overrides);
    await w.reportBack.onTurnEnded(ended(), w.paseo);
    assert.deepEqual(w.archives, []);
    assert.equal(await w.reportBack.wasArchived(RUN), false);
    await w.reportBack.dispose();
  });
}

test("stays open: failed or stopped turn", async () => {
  for (const outcome of [{ kind: "failed", error: { message: "boom" } }, { kind: "canceled" }]) {
    const w = setup();
    await w.reportBack.onTurnEnded(ended(outcome), w.paseo);
    assert.deepEqual(w.archives, []);
    await w.reportBack.dispose();
  }
});

test("a failed archive is not remembered as archived", async () => {
  const w = setup({ run: { archiveError: true } });
  assert.equal(await w.reportBack.onTurnEnded(ended(), w.paseo), "sent");
  assert.equal(await w.reportBack.wasArchived(RUN), false);
  await w.reportBack.dispose();
});

test("archived runs survive a restart in their own file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archived-runs-"));
  try {
    const store = fileReportedStore(dir, () => {}, "archived-runs.json");
    const w = setup({ archivedStore: store });
    await w.reportBack.onTurnEnded(ended(), w.paseo);
    await w.reportBack.dispose();
    assert.deepEqual(await store.load(), [RUN]);
    assert.deepEqual(await fileReportedStore(dir, () => {}).load(), []);
    const again = setup({ archivedStore: store });
    assert.equal(await again.reportBack.wasArchived(RUN), true);
    await again.reportBack.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the setting fails closed and migrates", async () => {
  assert.equal(await readArchiveOnSuccess({ read: async () => ({ status: "ready", values: { archiveAgentOnSuccess: true } }) }), true);
  assert.equal(await readArchiveOnSuccess({ read: async () => ({ status: "ready", values: { archiveAgentOnSuccess: false } }) }), false);
  assert.equal(await readArchiveOnSuccess({ read: async () => ({ status: "error" }) }), false);
  assert.equal(await readArchiveOnSuccess({ read: async () => Promise.reject(new Error("x")) }), false);
  const v13 = { done: [], runs: [] };
  assert.equal("archiveAgentOnSuccess" in migratePreferences({ ...v13, archiveAgentOnSuccess: "yes" }, 13), false);
  assert.equal(migratePreferences({ ...v13, archiveAgentOnSuccess: true }, 13).archiveAgentOnSuccess, true);
});

test("the card asks the server about a closed or unknown run and shows it as done", () => {
  const card = readFileSync(new URL("../client/card.tsx", import.meta.url), "utf8");
  assert.match(card, /followedState === "stopped" \|\| followedState === "unknown"/);
  assert.match(card, /archivedRun === runAgentId && mayBeArchived \? "done" : followedState/);
});
