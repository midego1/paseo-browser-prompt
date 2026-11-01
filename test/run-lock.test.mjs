// Run: npm test. In-flight run lock: two copies of a block pressed before the run record arrives
// start one run; the lock frees on a failed start and after its timeout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { blockFingerprint } from "../shared/block-key.ts";
import { createRunLocks, RUN_LOCK_HOLD_MS, RUN_LOCK_TTL_MS, runLockKey } from "../shared/run-lock.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const steps = "1. Open https://example.com\n2. Read the first paragraph.\n3. Report it.";

function clock() {
  let now = 1_000_000;
  let tokens = 0;
  const locks = createRunLocks({ now: () => now, token: () => `t${++tokens}` });
  return { locks, advance: (ms) => (now += ms) };
}

test("the lock is keyed like the shared run: source agent and block content, spacing ignored", () => {
  const a = runLockKey("agent-1", blockFingerprint("Check", steps));
  assert.equal(runLockKey("agent-1", blockFingerprint("Check", steps.replace("1. Open", "1.Open"))), a, "a copy that differs in spacing");
  assert.notEqual(runLockKey("agent-2", blockFingerprint("Check", steps)), a, "another chat");
  assert.notEqual(runLockKey("agent-1", blockFingerprint("Other", steps)), a, "another block");
});

test("two copies pressed at once (no confirmation): only the first starts, the second shows its run", () => {
  const { locks } = clock();
  const key = runLockKey("agent-1", blockFingerprint("Check", steps));
  const first = locks.acquire(key);
  assert.deepEqual(first, { ok: true, token: "t1" });
  assert.deepEqual(locks.acquire(key), { ok: false, agentId: null }, "still starting: no run to show yet");
  assert.equal(locks.started(key, "t1", "run-1"), true);
  assert.deepEqual(locks.acquire(key), { ok: false, agentId: "run-1" }, "started: the copy attaches to that run");
  assert.equal(locks.acquire(runLockKey("agent-1", blockFingerprint("Other", steps))).ok, true, "other blocks are not held");
});

test("a failed start frees the lock at once; a stale token cannot free or claim a newer lock", () => {
  const { locks } = clock();
  const key = runLockKey("agent-1", blockFingerprint("Check", steps));
  assert.equal(locks.acquire(key).ok, true);
  assert.equal(locks.release(key, "t1"), true);
  const again = locks.acquire(key);
  assert.deepEqual(again, { ok: true, token: "t2" }, "another copy may start right away");
  assert.equal(locks.release(key, "t1"), false, "the old token does not free the new lock");
  assert.equal(locks.started(key, "t1", "run-x"), false, "nor name its run");
  assert.deepEqual(locks.acquire(key), { ok: false, agentId: null });
});

test("a start that never reports back frees the lock after the timeout; a started run after the hold", () => {
  const { locks, advance } = clock();
  const key = runLockKey("agent-1", blockFingerprint("Check", steps));
  locks.acquire(key);
  advance(RUN_LOCK_TTL_MS - 1);
  assert.equal(locks.acquire(key).ok, false);
  advance(1);
  assert.equal(locks.acquire(key).ok, true, "app closed during the start: the lock does not stay");
  assert.equal(locks.started(key, "t2", "run-2"), true);
  advance(RUN_LOCK_HOLD_MS - 1);
  assert.deepEqual(locks.acquire(key), { ok: false, agentId: "run-2" });
  advance(1);
  assert.equal(locks.acquire(key).ok, true, "after the hold the shared run record decides again");
  assert.ok(RUN_LOCK_HOLD_MS < RUN_LOCK_TTL_MS);
});

test("expired locks are dropped and the map stays bounded", () => {
  const { locks, advance } = clock();
  for (let i = 0; i < 50; i++) locks.acquire(`k${i}`);
  advance(RUN_LOCK_TTL_MS);
  locks.acquire("fresh");
  assert.equal(locks.size(), 1);
  for (let i = 0; i < 2000; i++) locks.acquire(`many${i}`);
  assert.ok(locks.size() <= 500);
});

test("the card takes the daemon's lock before starting and hands it back on start or failure", () => {
  const card = read("client/card.tsx");
  const launch = card.slice(card.indexOf("async function launchAgent()"));
  const lockAt = launch.indexOf("await takeRunLock()");
  const startAt = launch.indexOf("await startBrowserAgent(");
  assert.ok(lockAt > 0 && lockAt < startAt, "lock before the start");
  assert.match(launch, /finishLock\(lockToken, started\.agentId\)/, "a started run names itself in the lock");
  assert.match(launch, /finally \{\s*\/\/[^\n]*\n\s*finishLock\(lockToken\);/, "a failed start releases it");
  assert.match(card, /if \(result\.agentId\) setLocalRun\(result\.agentId\);/, "a refused copy shows the run");
  const server = read("index.server.ts");
  assert.match(server, /server\.handle\(acquireRunLock,/);
  assert.match(server, /server\.handle\(finishRunLock,/);
});
