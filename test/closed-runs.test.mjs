// Run: npm test. Closed runs stay closed: reading a closed agent's timeline or sending to it makes
// the daemon load it again, so a stopped run would turn idle and show as done. Covers the guard
// decision, the card's tail read and report back against fake SDKs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createReportBack } from "../server/report-back.ts";
import { mayLoadRun, QUESTION_MARKER, readRunTail } from "../shared/agent-prompt.ts";
import { buildClosedRunNotice, runLabels } from "../shared/report-back.ts";

const SOURCE = "agent-source";
const RUN = "agent-run";
const WS = "ws-1";
const QUESTION = `${QUESTION_MARKER} Which of the two Save buttons should I use?`;
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("mayLoadRun: only a run the daemon knows that is neither closed nor archived", () => {
  for (const status of ["idle", "running", "initializing", "error"]) assert.equal(mayLoadRun({ status }), true, status);
  assert.equal(mayLoadRun({ status: "closed" }), false);
  assert.equal(mayLoadRun({ status: "idle", archivedAt: "2026-11-01T07:00:00.000Z" }), false, "archived");
  assert.equal(mayLoadRun(null), false, "unknown to the daemon");
  assert.equal(mayLoadRun(undefined), false);
});

test("mayLoadRun: the app's closed status wins over a stored status that is out of date", () => {
  // A stored status can be out of date, for example when the daemon failed to store the close.
  assert.equal(mayLoadRun({ status: "idle" }, "closed"), false);
  assert.equal(mayLoadRun({ status: "running" }, "closed"), false);
  assert.equal(mayLoadRun({ status: "idle" }, "idle"), true);
  assert.equal(mayLoadRun({ status: "idle" }, null), true, "not in the app's cache yet: the fresh status decides");
  assert.equal(mayLoadRun({ status: "closed" }, null), false, "a closed run the app's cache does not know yet");
});

function fakeRun(agent, { onRefresh } = {}) {
  const calls = { refresh: 0, refetch: [] };
  return {
    calls,
    async refresh() {
      calls.refresh++;
      onRefresh?.();
      if (agent instanceof Error) throw agent;
      return agent ? { agent } : null;
    },
    timeline: {
      async refetch(options) {
        calls.refetch.push(options);
        return { entries: [] };
      },
    },
  };
}
const never = () => false;
const noCache = () => null;

test("readRunTail reads the tail of a run that is awake, after checking its status", async () => {
  const run = fakeRun({ status: "idle" });
  assert.deepEqual(await readRunTail(run, 40, () => "idle", never), { entries: [] });
  assert.equal(run.calls.refresh, 1);
  assert.deepEqual(run.calls.refetch, [{ direction: "tail", limit: 40 }]);
});

test("readRunTail: a run the app shows as closed costs no request at all", async () => {
  const run = fakeRun({ status: "idle" });
  assert.equal(await readRunTail(run, 40, () => "closed", never), null);
  assert.deepEqual(run.calls, { refresh: 0, refetch: [] });
});

test("readRunTail: no read when the fresh status rules it out, also without a cached status", async () => {
  for (const agent of [{ status: "closed" }, { status: "idle", archivedAt: "2026-11-01T07:00:00.000Z" }, null]) {
    const run = fakeRun(agent);
    assert.equal(await readRunTail(run, 40, noCache, never), null);
    assert.deepEqual(run.calls.refetch, []);
  }
});

test("readRunTail: a run that closes or a read that is cancelled during the status check is not read", async () => {
  let status = "running";
  const closing = fakeRun({ status: "running" }, { onRefresh: () => (status = "closed") });
  assert.equal(await readRunTail(closing, 40, () => status, never), null);
  assert.deepEqual(closing.calls.refetch, []);

  let cancelled = false;
  const dropped = fakeRun({ status: "idle" }, { onRefresh: () => (cancelled = true) });
  assert.equal(await readRunTail(dropped, 40, noCache, () => cancelled), null);
  assert.deepEqual(dropped.calls.refetch, []);

  const gone = fakeRun({ status: "idle" });
  assert.equal(await readRunTail(gone, 40, noCache, () => true), null);
  assert.deepEqual(gone.calls, { refresh: 0, refetch: [] });
});

test("readRunTail: a failed status check rejects without reading", async () => {
  const run = fakeRun(new Error("no answer"));
  await assert.rejects(readRunTail(run, 40, noCache, never), /no answer/);
  assert.deepEqual(run.calls.refetch, []);
});

test("the card reads a run's timeline only through readRunTail, and never settles on a closed run", () => {
  const progress = source("client/step-progress.tsx");
  assert.doesNotMatch(progress, /timeline\.refetch|\.refetch\(/);
  assert.match(progress, /readRunTail\(paseo\.agents\.ref\(id\), 40, \(\) => statusNow\.current, \(\) => cancelled\)/);
  assert.match(progress, /statusNow\.current = status;/);
  // live -> closed: the settle read is skipped, and a closed run does not count as already read.
  assert.match(progress, /if \(!settledNow \|\| !agentId \|\| stopped\) return;/);
  assert.match(progress, /if \(!agentId \|\| stopped\) \{\s+fetchedFor\.current = null;\s+return;\s+\}/);
  assert.match(progress, /\[live, agentId, stopped, paseo\]/);
});

test("nothing else in the client reads an agent's timeline except the chat index", () => {
  for (const file of ["card.tsx", "owner-prompt.tsx", "run-status.tsx", "run-stats-row.tsx", "screenshot-thumb.tsx", "agent-run.ts", "run-screen.tsx"]) {
    assert.doesNotMatch(source(`client/${file}`), /\.timeline\b|agents\s*\.ref\([^)]*\)\s*\.reload\(/, file);
  }
});

function reportWorld({ run = {}, sourceAgent = {}, final = "Done: nothing left." } = {}) {
  const agents = {
    [SOURCE]: { labels: {}, status: "idle", workspaceId: WS, provider: "claude", currentModeId: "default", ...sourceAgent },
    [RUN]: { labels: runLabels(SOURCE, "card-1"), status: "idle", workspaceId: WS, provider: "claude", currentModeId: "auto", ...run },
  };
  const sent = [];
  const calls = { refetch: 0 };
  const paseo = {
    agents: {
      ref(id) {
        return {
          async refresh() {
            const agent = agents[id];
            if (agent?.refreshError) throw new Error("no answer");
            return agent ? { agent: { pendingPermissions: [], activeTurn: null, ...agent } } : null;
          },
          timeline: {
            async refetch() {
              calls.refetch++;
              return { entries: [{ item: { type: "user_message", text: "go" } }, { item: { type: "assistant_message", text: final, messageId: "m1" } }] };
            },
          },
          async waitForFinish() {
            agents[id].onWait?.();
            return { status: "timeout" };
          },
          async send(text) {
            sent.push({ id, text });
          },
        };
      },
    },
  };
  return { agents, paseo, sent, calls };
}

const ended = (extra = {}, outcome = { kind: "completed" }) => ({
  agent: { id: RUN, workspaceId: WS, parentAgentId: null, provider: "claude", cwd: "/tmp", title: "Browser: Example" },
  outcome,
  turnId: "t1",
  ...extra,
});

const reportOptions = (extra = {}) => ({
  mode: async () => "full",
  talk: async () => ({ maxQuestions: 0 }),
  recordedRun: async ({ runId }) => (runId === RUN ? { fallback: false } : null),
  log: () => {},
  busyWaitMs: 2000,
  permissionPollMs: 1,
  minRecheckMs: 1,
  recordWaitMs: 5,
  recordPollMs: 1,
  ...extra,
});

const CLOSED_TEXT = "It was closed or archived, so its report was not read.";
const ARCHIVED = { status: "idle", archivedAt: "2026-11-01T07:00:00.000Z" };
const FAILED = { kind: "failed", error: { message: "boom <b>" } };

test("the closed-run notice: outcome and id only, the error only for a chat that may get a report", () => {
  const input = { title: "Browser: <Example>", browserAgentId: RUN };
  assert.equal(
    buildClosedRunNotice({ ...input, outcome: { kind: "completed" }, withError: true }),
    `[browser-prompt] Browser agent "Browser: &lt;Example&gt;" finished. Run agent id: ${RUN}. ${CLOSED_TEXT}`,
  );
  const failed = { kind: "failed", message: "boom <b>" };
  assert.equal(
    buildClosedRunNotice({ ...input, outcome: failed, withError: false }),
    `[browser-prompt] Browser agent "Browser: &lt;Example&gt;" failed. Run agent id: ${RUN}. ${CLOSED_TEXT}`,
  );
  const withError = buildClosedRunNotice({ ...input, outcome: failed, withError: true });
  assert.ok(withError.includes(`${CLOSED_TEXT}\n\nThe block below is the browser agent's error text.`));
  assert.ok(withError.endsWith("<browser-agent-report>\nError: boom &lt;b&gt;\n</browser-agent-report>"));
  assert.doesNotMatch(buildClosedRunNotice({ ...input, outcome: failed, withError: false }), /boom|mode that acts/);
});

test("report back: a closed or archived run is not read, the chat gets the notice, and the run is claimed", async () => {
  for (const run of [{ status: "closed" }, ARCHIVED]) {
    for (const outcome of [{ kind: "completed" }, FAILED]) {
      const w = reportWorld({ run });
      const reportBack = createReportBack(reportOptions());
      assert.equal(await reportBack.onTurnEnded(ended({}, outcome), w.paseo), "sent-closed");
      assert.equal(w.calls.refetch, 0);
      assert.deepEqual(w.sent.map((m) => m.id), [SOURCE]);
      assert.ok(w.sent[0].text.includes(CLOSED_TEXT));
      assert.match(w.sent[0].text, outcome.kind === "failed" ? /" failed\. / : /" finished\. /);

      // The owner loads the run again and a later turn ends: the run already reported.
      w.agents[RUN].status = "idle";
      w.agents[RUN].archivedAt = null;
      assert.equal(await reportBack.onTurnEnded(ended({ turnId: "t2" }), w.paseo), "duplicate");
      assert.equal(w.sent.length, 1);
    }
  }
});

test("report back: the notice goes only where a report would have gone", async () => {
  const off = reportWorld({ run: { status: "closed" } });
  assert.equal(await createReportBack(reportOptions({ mode: async () => "off" })).onTurnEnded(ended(), off.paseo), "disabled");
  assert.deepEqual(off.sent, []);

  const unrecorded = reportWorld({ run: { status: "closed" } });
  assert.equal(await createReportBack(reportOptions({ recordedRun: async () => null })).onTurnEnded(ended(), unrecorded.paseo), "unrecorded");
  assert.deepEqual(unrecorded.sent, []);

  const gone = reportWorld({ run: { status: "closed" }, sourceAgent: { archivedAt: "2026-11-01T07:00:00.000Z" } });
  assert.equal(await createReportBack(reportOptions()).onTurnEnded(ended(), gone.paseo), "source-missing");
  assert.deepEqual(gone.sent, []);

  const canceled = reportWorld({ run: { status: "closed" } });
  assert.equal(await createReportBack(reportOptions()).onTurnEnded(ended({}, { kind: "canceled", reason: "x" }), canceled.paseo), "canceled");
  assert.deepEqual(canceled.sent, []);
});

test("report back: a failed run's error reaches only a chat that may get a report", async () => {
  const auto = { mode: async () => "auto" };
  const askFirst = reportWorld({ run: { status: "closed" } });
  assert.equal(await createReportBack(reportOptions(auto)).onTurnEnded(ended({}, FAILED), askFirst.paseo), "sent-closed");
  assert.match(askFirst.sent[0].text, /Error: boom &lt;b&gt;/);

  const bypass = reportWorld({ run: { status: "closed" }, sourceAgent: { currentModeId: "bypassPermissions" } });
  assert.equal(await createReportBack(reportOptions(auto)).onTurnEnded(ended({}, FAILED), bypass.paseo), "sent-closed");
  assert.ok(bypass.sent[0].text.endsWith(CLOSED_TEXT));
  assert.doesNotMatch(bypass.sent[0].text, /boom/);
});

test("report back: an event that carries the report needs no read, so it reports as usual", async () => {
  const w = reportWorld({ run: { status: "closed" } });
  const timeline = [{ type: "assistant_message", text: "From the event." }];
  assert.equal(await createReportBack(reportOptions()).onTurnEnded(ended({ timeline }), w.paseo), "sent");
  assert.equal(w.calls.refetch, 0);
  assert.match(w.sent[0].text, /From the event\./);
});

test("report back: an awake run is read and reported as before", async () => {
  const w = reportWorld();
  assert.equal(await createReportBack(reportOptions()).onTurnEnded(ended(), w.paseo), "sent");
  assert.equal(w.calls.refetch, 1);
  assert.deepEqual(w.sent.map((m) => m.id), [SOURCE]);
});

test("question redirect: an awake run is told; a run that closed after its turn was read gets nothing", async () => {
  const awake = reportWorld({ final: QUESTION });
  assert.equal(await createReportBack(reportOptions()).onTurnEnded(ended(), awake.paseo), "question-redirected");
  assert.deepEqual(awake.sent.map((m) => m.id), [RUN]);

  for (const closing of [{ status: "closed" }, ARCHIVED]) {
    const w = reportWorld({ final: QUESTION });
    const reportBack = createReportBack(reportOptions({
      recordedRun: async () => {
        Object.assign(w.agents[RUN], closing);
        return { fallback: false };
      },
    }));
    assert.equal(await reportBack.onTurnEnded(ended(), w.paseo), "not-forwarded-closed");
    assert.deepEqual(w.sent, []);
  }
});

test("question redirect: a failed status read is not taken for closed; the notice goes out and it is logged", async () => {
  const w = reportWorld({ final: QUESTION });
  const logs = [];
  const reportBack = createReportBack(reportOptions({
    log: (message) => logs.push(message),
    recordedRun: async () => {
      w.agents[RUN].refreshError = true;
      return { fallback: false };
    },
  }));
  assert.equal(await reportBack.onTurnEnded(ended(), w.paseo), "question-redirected");
  assert.deepEqual(w.sent.map((m) => m.id), [RUN]);
  assert.ok(logs.some((line) => line.includes("could not read the status of run")));
});

test("question redirect: a run closed while its question waited for a busy chat is not woken", async () => {
  const w = reportWorld({ final: QUESTION, sourceAgent: { status: "running", activeTurn: { turnId: "s" } } });
  w.agents[SOURCE].onWait = () => (w.agents[RUN].status = "closed");
  const reportBack = createReportBack(reportOptions({ talk: async () => ({ maxQuestions: 5 }), busyWaitMs: 5 }));
  assert.equal(await reportBack.onTurnEnded(ended(), w.paseo), "not-forwarded-closed");
  assert.deepEqual(w.sent, []);
});
