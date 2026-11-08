// Run: npm test. Merge repeated blocks: the content key, which block of a chat comes first (also
// when a later card renders first), the compact line's decision, and done marks per key.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { explodeMessage, hashText } from "../shared/browser-prompt.ts";
import {
  blockFingerprint,
  blockKey,
  createChatIndex,
  markRepeatsInMessage,
  canStartRun,
  cardRun,
  runIsRecorded,
  runKeyMarker,
  sharedRunRecord,
  addRunRecord,
  MAX_RUNS_PER_CARD,
  sameBlock,
  withinMessage,
  KEY_PREFIX,
  messagesInTimeline,
  migrateDoneMark,
  normalizeBlockText,
  repeatView,
} from "../shared/repeats.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";
import { createSettingsMirror, saveWithRetries, withDoneMark } from "../shared/settings-save.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const steps = "1. Open https://example.com\n2. Read the first paragraph.\n3. Report it.";

test("the key ignores whitespace, line endings, blank lines and step-number spacing", () => {
  const base = blockKey("Check example.com", steps);
  assert.ok(base.startsWith(KEY_PREFIX));
  assert.match(base, /^k1-[0-9a-f]{14}$/);
  for (const variant of [
    "1.Open https://example.com\n2.   Read the first paragraph.\n3) Report it.",
    "  1. Open   https://example.com  \r\n\r\n2. Read the first\tparagraph.\r\n3. Report it.\n\n",
    "1. Open https://example.com\r2. Read the first paragraph.\r3. Report it.",
  ]) {
    assert.equal(blockKey("Check example.com", variant), base, JSON.stringify(variant));
  }
  assert.equal(blockKey("  Check   example.com ", steps), base, "title whitespace");
  assert.equal(blockKey("Check ｅｘａｍｐｌｅ.com", steps), base, "NFKC");
  assert.equal(normalizeBlockText(" 1)Open \r\n\r\n 2.  Read "), "1. Open\n2. Read");
});

test("a different title, other steps or other case make a different key", () => {
  const base = blockKey("Check example.com", steps);
  assert.notEqual(blockKey("Check example.org", steps), base, "title");
  assert.notEqual(blockKey("", steps), base, "no title");
  assert.notEqual(blockKey("Check example.com", steps.replace("Report it.", "Report it twice.")), base);
  assert.notEqual(blockKey("check example.com", steps), base, "case-sensitive");
  assert.notEqual(blockKey("Check example.com\n1. Open https://example.com", "2. Read the first paragraph.\n3. Report it."), base,
    "title and steps stay apart");
});

test("the first block wins by its message's place in the chat, not by which card renders first", () => {
  const fp = blockFingerprint("Check", steps);
  const index = createChatIndex();
  // The whole-chat read learns every message with its sequence number, whatever the list rendered.
  index.addMessage("msg-a", 2, [{ fingerprint: fp, index: 0 }]);
  index.addMessage("msg-b", 6, [{ fingerprint: fp, index: 0 }, { fingerprint: fp, index: 1 }]);
  index.addMessage("msg-c", 9, [{ fingerprint: blockFingerprint("Other", steps), index: 0 }]);
  // Asked in any order (a virtualized list renders the newest card first):
  assert.deepEqual(index.firstOf(fp, "msg-b", 1), { state: "repeat", first: { messageId: "msg-a", index: 0 } });
  assert.deepEqual(index.firstOf(fp, "msg-b", 0), { state: "repeat", first: { messageId: "msg-a", index: 0 } });
  assert.deepEqual(index.firstOf(fp, "msg-a", 0), { state: "first" });
  assert.deepEqual(index.firstOf(blockFingerprint("Other", steps), "msg-c", 0), { state: "first" }, "other keys do not matter");
  // In one message, the earlier position wins.
  const one = createChatIndex();
  one.addMessage("m", 1, [{ fingerprint: fp, index: 0 }, { fingerprint: fp, index: 2 }]);
  assert.deepEqual(one.firstOf(fp, "m", 2), { state: "repeat", first: { messageId: "m", index: 0 } });
  assert.deepEqual(one.firstOf(fp, "m", 0), { state: "first" });
});

test("a card whose message is not known yet (new, streaming, or no message id) is not decided", () => {
  const fp = blockFingerprint("Check", steps);
  const index = createChatIndex();
  index.addMessage("msg-a", 2, [{ fingerprint: fp, index: 0 }]);
  assert.deepEqual(index.firstOf(fp, "msg-new", 0), { state: "unknown" }, "shown in full until the tail read knows it");
  assert.deepEqual(index.firstOf(fp, undefined, 0), { state: "unknown" }, "providers without message ids: always full");
  assert.equal(index.knows("msg-new"), false);
  assert.equal(index.addMessage("msg-new", 8, [{ fingerprint: fp, index: 0 }]), true);
  assert.equal(index.addMessage("msg-new", 8, [{ fingerprint: fp, index: 0 }]), false, "a second read adds nothing");
  assert.deepEqual(index.firstOf(fp, "msg-new", 0), { state: "repeat", first: { messageId: "msg-a", index: 0 } });
  assert.equal(repeatView({ collapse: true, first: { state: "unknown" }, done: true, expanded: false }), "full");
});

test("cards are placed by message id: Paseo gives every card of a chat the same timestamp", () => {
  const card = read("client/card.tsx");
  assert.doesNotMatch(card.slice(card.indexOf("const first = ")), /timestamp\.getTime\(\), index \}/);
  assert.match(
    card,
    /useFirstOf\(paseo, agentId, fingerprint, messageId, index, collapse \|\| sharedRunGoing\)/,
    "placed when collapsing is on, and with it off while the shared run is going (the run guard needs it)",
  );
  assert.match(card, /const sharedRunGoing = !!runAgentId && !canStartRun\(\{ repeat: true, runState: shownState \}\);/);
  assert.match(read("index.client.tsx"), /explodeMessage\(item\.text, phase, messageId\)/);
  const [card1] = explodeMessage("```browser-prompt T\n1. x\n```", "complete", "msg-1");
  assert.equal(card1.data.messageId, "msg-1");
  const [card2] = explodeMessage("```browser-prompt T\n1. x\n```", "complete");
  assert.equal("messageId" in card2.data, false, "no id: the field is left out");
});

test("messages in a timeline page: assistant messages with an id, their closed blocks at the transformer's positions", () => {
  const message = `Intro\n\n\`\`\`browser-prompt Check\n${steps}\n\`\`\`\n\nAgain:\n\n\`\`\`browser-prompt Check\n${steps.replace(/\n/g, "\n\n")}\n\`\`\`\n\n\`\`\`browser-prompt Open\n1. Not closed`;
  const found = messagesInTimeline([
    { item: { type: "user_message", text: "```browser-prompt Check\n1. x\n```" }, seqStart: 1 },
    { item: { type: "assistant_message", text: message, messageId: "msg-1" }, seqStart: 2 },
    { item: { type: "assistant_message", text: "no blocks", messageId: "msg-2" }, seqStart: 5 },
    { item: { type: "assistant_message", text: "```browser-prompt X\n1. y\n```" }, seqStart: 6 },
  ]);
  assert.deepEqual(found.map((m) => [m.messageId, m.seq, m.blocks.length]), [["msg-1", 2, 2], ["msg-2", 5, 0]], "no id: skipped");
  assert.deepEqual(found[0].blocks[0].fingerprint, found[0].blocks[1].fingerprint, "the blank lines do not matter");
  const cards = explodeMessage(message, "complete").filter((item) => item.kind === "browser-prompt-card");
  assert.deepEqual(found[0].blocks.map((block) => block.index), cards.map((c) => c.data.index), "same positions as the cards");
});

test("a later copy is a full card with a hint; a done copy collapses until Show; setting off: plain full cards", () => {
  const first = { state: "repeat", first: { messageId: "m", index: 0 } };
  const view = (over) => repeatView({ collapse: true, first, done: false, expanded: false, ...over });
  assert.equal(view({ first: { state: "first" } }), "full", "the first block");
  assert.equal(view({}), "repeat", "not done: a full card with “Also shown earlier in this chat”");
  assert.equal(view({ done: true }), "collapsed", "done: “✓ Already done · Show”");
  assert.equal(view({ done: true, expanded: true }), "repeat", "Show expands it inline, with Undo done");
  assert.equal(view({ collapse: false }), "full", "setting off: no hint");
  assert.equal(view({ collapse: false, done: true }), "full", "setting off: done copies stay full");
});

test("done marks per key: an old mark moves to the content key; Clear still empties the list", () => {
  const agent = "agent-1";
  const title = "Check";
  const legacy = `${agent}:${hashText(`${title}\n${steps}`)}`;
  const mark = `${agent}:${blockKey(title, steps)}`;
  assert.deepEqual(migrateDoneMark(["other", legacy], legacy, mark), ["other", mark]);
  assert.deepEqual(migrateDoneMark([legacy, mark], legacy, mark), [mark], "no duplicate");
  assert.equal(migrateDoneMark(["other", mark], legacy, mark), null, "nothing to move");
  assert.equal(migrateDoneMark([], legacy, mark), null);
  const card = read("client/card.tsx");
  assert.match(card, /settings\.values\.done\.includes\(doneMark\) \|\| settings\.values\.done\.includes\(runKey\)/, "old marks count until moved");
  assert.match(card, /withDoneMark\(values\.done, doneMark, runKey, next, MAX_DONE\)/);
  assert.deepEqual(withDoneMark(["x", legacy, mark], mark, legacy, false, 500), ["x"], "undo removes both forms");
  assert.deepEqual(withDoneMark(["x", legacy], mark, legacy, true, 500), ["x", mark], "done replaces the old form");
  assert.deepEqual(withDoneMark(["a", "b"], mark, legacy, true, 2), ["b", mark], "capped, oldest dropped");
  assert.match(read("client/settings-screen.tsx"), /done: \[\] \}, revision/, "Clear");
});

test("settings v12: Merge repeated blocks defaults on; the migration keeps done marks", () => {
  const settings = read("shared/settings.ts");
  assert.ok(Number(/version: (\d+),/.exec(settings)?.[1]) >= 12, "v12 or later");
  assert.match(settings, /mergeRepeats: z\.boolean\(\)\.default\(true\)/);
  const v11 = { done: ["a:0badf00d"], thumbnailMode: "all" };
  assert.deepEqual(migratePreferences(v11, 11), v11);
  assert.equal("mergeRepeats" in migratePreferences(v11, 11), false, "the schema default applies");
});

test("copies share the run: by the card's own id or by the content marker, newest first", () => {
  const key = blockKey("Check", steps);
  const runs = [
    ["agent:aaaaaaaa", "run-old"],
    ["other:bbbbbbbb", "run-elsewhere", runKeyMarker(key)],
    ["agent:cccccccc", "run-copy", "most-recent", runKeyMarker(key)],
    ["agent:dddddddd", "run-unrelated", runKeyMarker(blockKey("Other", steps))],
  ];
  assert.equal(sharedRunRecord(runs, "agent", "agent:aaaaaaaa", key)[1], "run-copy", "the newest record for this content");
  assert.equal(sharedRunRecord(runs.slice(0, 2), "agent", "agent:aaaaaaaa", key)[1], "run-old", "its own id (records from before 0.10.1)");
  assert.equal(sharedRunRecord(runs.slice(1, 2), "agent", "agent:aaaaaaaa", key), null, "another chat's run is not shared");
  assert.equal(sharedRunRecord([], "agent", "agent:aaaaaaaa", key), null);
});

test("a repeat starts its own run only while the shared run is not going; the first card is unchanged", () => {
  for (const state of ["starting", "running", "needs-input", "asking"]) {
    assert.equal(canStartRun({ repeat: true, runState: state }), false, state);
    assert.equal(canStartRun({ repeat: false, runState: state }), true, `the first card: ${state}`);
  }
  for (const state of [null, "done", "failed", "stopped", "unknown"]) assert.equal(canStartRun({ repeat: true, runState: state }), true, String(state));
  const card = read("client/card.tsx");
  assert.match(card, /const runBlocked = !canStartRun\(\{ repeat: isRepeat, runState: runAgentId \? shownState : null \}\);/);
  assert.match(card, /if \(busy \|\| resolving \|\| runBlocked\) return;/);
  assert.match(card, /disabled=\{busy \|\| resolving \|\| runBlocked\}/);
  assert.match(card, /const runKey = `\$\{agentId\}:\$\{cardId\}`;/, "runs stay keyed by the card's own id (the server checks it)");
  assert.match(card, /runKey,\n\s+startedAgentId,\n\s+\.\.\.\(fallback \? \[MOST_RECENT_FALLBACK\] : \[\]\),\n\s+runKeyMarker\(key\),/);
});

test("no scrolling to the first card, no toast; a collapsed copy expands in place", () => {
  const card = read("client/card.tsx");
  assert.doesNotMatch(card, /scrollIntoView|scrollToFirst|nativeID|Scroll up to the first card|Same step as above|flashFirst/);
  assert.match(card, /Also shown earlier in this chat/);
  assert.match(card, /✓ Already done/);
  assert.match(card, /onShow=\{\(\) => setExpanded\(true\)\}/);
  assert.match(card, /setExpanded\(false\)\}>\n\s+<Text style=\{styles\.link\}>Hide<\/Text>/);
  assert.doesNotMatch(read("client/chat-index.ts"), /flash/i);
  assert.match(read("client/settings-screen.tsx"), /label="Collapse repeated blocks that are done"/);
});

test("with collapsing off, the chat is read only while the shared run is going; done marks and runs stay shared", () => {
  const card = read("client/card.tsx");
  // The order matters: the run state is known before the card asks the index.
  assert.ok(card.indexOf("const shownState =") < card.indexOf("const sharedRunGoing ="));
  for (const state of ["starting", "running", "needs-input", "asking"]) assert.equal(canStartRun({ repeat: true, runState: state }), false, state);
  for (const state of ["done", "failed", "stopped", "unknown"]) assert.equal(canStartRun({ repeat: true, runState: state }), true, state);
  // Done marks and the shared run are keyed by content, not by the chat index.
  assert.match(card, /const doneMark = `\$\{agentId\}:\$\{key\}`;/);
  assert.match(card, /sharedRunRecord\(storedRuns, agentId, runKey, key\)/);
  assert.match(card, /const storedRuns = settings\.status === "ready" \? settings\.values\.runs : null;/);
  assert.equal(repeatView({ collapse: false, first: { state: "first" }, done: true, expanded: false }), "full");
  const index = read("client/chat-index.ts");
  assert.match(index, /if \(!enabled \|\| !messageId\) return;/, "a disabled card does not read the chat");
});

test("a done-mark save that loses a race is retried against reloaded settings", async () => {
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);
  // Another device saved in between: the first save fails, the reload brings newer values.
  let state = { status: "ready", values: { done: ["other"], n: 1 }, revision: "1" };
  const saved = [];
  const handle = () => ({
    ...state,
    save: async (values, revision) => {
      saved.push([values, revision]);
      return revision === "2";
    },
    reload: async () => {
      state = { status: "ready", values: { done: ["other", "newer"], n: 2 }, revision: "2" };
    },
  });
  const update = (values) => ({ ...values, done: withDoneMark(values.done, "a:k", "a:c", true, 500) });
  assert.equal(await saveWithRetries(handle, update, { sleep }), true);
  assert.deepEqual(saved.at(-1), [{ done: ["other", "newer", "a:k"], n: 2 }, "2"], "built from the reloaded settings, not the stale ones");
  assert.deepEqual(sleeps, [100]);

  // Never wins: four tries, a reload after each, then false so the card resets and says so.
  let reloads = 0;
  const losing = () => ({ status: "ready", values: { done: [] }, revision: "1", save: async () => false, reload: async () => void reloads++ });
  assert.equal(await saveWithRetries(losing, update, { sleep: async () => {} }), false);
  assert.equal(reloads, 4);

  // Not ready (loading or invalid): nothing is saved, it reloads and tries again.
  let tries = 0;
  const loading = () => ({ status: tries++ < 1 ? "loading" : "ready", values: { done: [] }, revision: "3", save: async () => true, reload: async () => {} });
  assert.equal(await saveWithRetries(loading, update, { sleep: async () => {} }), true);

  const card = read("client/card.tsx");
  const body = card.slice(card.indexOf("async function toggleDone()"), card.indexOf("const displayTitle ="));
  assert.match(body, /saveWithRetries\(\n\s+newestSettings,/, "reads the newest settings on each try");
  assert.match(body, /setLocalDone\(null\);\n\s+if \(!saved\) toast\.error\(/, "after the retries the local mark is reset and an error shown");
});

test("the run record keeps the server's fallback marker at position 2", () => {
  // The server reads entry[2] === "most-recent"; the block marker never takes that place when it matters.
  const entry = (fallback, marker) => ["k", "run", ...(fallback ? ["most-recent"] : []), ...(marker ? [marker] : [])];
  assert.equal(entry(true, "item:m:0")[2], "most-recent");
  assert.notEqual(entry(false, "item:m:0")[2], "most-recent");
});

test("blocks match only when key, normalized length and a second hash all match", () => {
  const a = blockFingerprint("Check", steps);
  assert.deepEqual(Object.keys(a).sort(), ["check", "key", "length"]);
  assert.match(a.check, /^[0-9a-f]{8}$/);
  assert.equal(sameBlock(a, blockFingerprint(" Check ", steps.replace(/\n/g, "\r\n"))), true);
  assert.equal(sameBlock(a, { ...a, length: a.length + 1 }), false, "a key collision with another length");
  assert.equal(sameBlock(a, { ...a, check: "00000000" }), false, "a key collision with another second hash");
  const index = createChatIndex();
  index.addMessage("msg-a", 1, [{ fingerprint: { ...a, check: "deadbeef" }, index: 0 }]);
  index.addMessage("msg-b", 2, [{ fingerprint: a, index: 0 }]);
  assert.deepEqual(index.firstOf(a, "msg-b", 0), { state: "first" }, "same key, different block: not a repeat");
});

test("repeats within one message show as repeats before the chat's index is read", () => {
  const block = (body) => "```browser-prompt Check\n" + body + "\n```";
  const text = `${block(steps)}\n\n${block("1. Other")}\n\n${block(steps.replace(/\. /g, ".   "))}`;
  const cards = markRepeatsInMessage(explodeMessage(text, "complete", "msg-1")).filter((item) => item.kind === "browser-prompt-card");
  assert.deepEqual(cards.map((card) => card.data.sameAs), [undefined, undefined, 0]);
  assert.equal(withinMessage({ state: "unknown" }, 0, "msg-1").state, "repeat", "loading: already a repeat");
  assert.deepEqual(withinMessage({ state: "unknown" }, 0, undefined), { state: "repeat", first: { messageId: "", index: 0 } }, "also without a message id");
  assert.deepEqual(withinMessage({ state: "unknown" }, undefined, "msg-1"), { state: "unknown" }, "others stay full until known");
  const known = { state: "repeat", first: { messageId: "msg-0", index: 0 } };
  assert.equal(withinMessage(known, 0, "msg-1"), known, "the index's answer stands once known");
  assert.match(read("index.client.tsx"), /items: markRepeatsInMessage\(items\)/);
  assert.match(read("client/card.tsx"), /withinMessage\(useFirstOf\(/);
});

test("a failed whole-chat read is retried with backoff", () => {
  const index = read("client/chat-index.ts");
  assert.match(index, /READ_RETRY_DELAYS_MS = \[2000, 8000, 30000\]/);
  assert.match(index, /if \(result\.error\) throw new Error\(result\.error\);/);
  assert.match(index, /const delay = READ_RETRY_DELAYS_MS\[attempt\];\n\s+if \(delay === undefined\) return;/);
});

test("running a card again keeps the earlier run's record, so its mode is still checked and it still reports", async () => {
  const { readRecordedRun } = await import("../server/report-back-hook.ts");
  const a = ["agent:card", "run-a", "key:k"];
  const b = ["agent:card", "run-b", "key:k"];
  const runs = addRunRecord(addRunRecord([], a, 200), b, 200);
  assert.deepEqual(runs, [a, b]);
  assert.equal(sharedRunRecord(runs, "agent", "agent:card", "k")[1], "run-b", "the card shows the newest run");
  const settings = { read: async () => ({ status: "ready", values: { runs } }) };
  assert.ok(await readRecordedRun(settings, { sourceId: "agent", cardId: "card", runId: "run-a" }), "run A is still recorded");
  assert.ok(await readRecordedRun(settings, { sourceId: "agent", cardId: "card", runId: "run-b" }));

  assert.deepEqual(addRunRecord(runs, a, 200), [b, a], "the same run is recorded once, newest last");
  let many = [];
  for (let i = 0; i < MAX_RUNS_PER_CARD + 3; i++) many = addRunRecord(many, ["agent:card", `run-${i}`], 200);
  many = addRunRecord(many, ["agent:other", "run-x"], 200);
  assert.equal(many.filter(([key]) => key === "agent:card").length, MAX_RUNS_PER_CARD, "a card keeps its newest runs only");
  assert.equal(many.at(-2)[1], `run-${MAX_RUNS_PER_CARD + 2}`);
  assert.equal(addRunRecord(many, ["agent:third", "run-y"], 3).length, 3, "the total cap still applies");
});

test("a card follows a newer shared run once its own run is recorded, so a repeat cannot start a second run", () => {
  const agentId = "chat";
  const key = blockKey("Check", "1. Open https://example.com");
  const marker = runKeyMarker(key);
  // The repeat copy started run X (its own card id); X finished. The first copy then started Y.
  const runs = [
    [`${agentId}:repeat-card`, "run-x", marker],
    [`${agentId}:first-card`, "run-y", marker],
  ];
  const stored = sharedRunRecord(runs, agentId, `${agentId}:repeat-card`, key)?.[1] ?? null;
  assert.equal(stored, "run-y", "the newest record of the block");
  assert.equal(runIsRecorded(runs, "run-x"), true);
  // More than RUN_LOCK_HOLD_MS later, while Y runs, the repeat copy still remembers X locally.
  const shown = cardRun("run-x", stored, runs);
  assert.equal(shown, "run-y", "the newer shared run wins over the card's own, already recorded run");
  assert.equal(canStartRun({ repeat: true, runState: "running" }), false, "so Run on the repeat waits for Y");
  // Before its record is saved, the card's own new run shows (the record is about a second behind).
  assert.equal(cardRun("run-z", stored, runs), "run-z");
  assert.equal(cardRun(null, stored, runs), "run-y");
  assert.equal(cardRun("run-z", null, []), "run-z");

  const card = read("client/card.tsx");
  assert.match(card, /const runAgentId = cardRun\(localRun, storedRun, storedRuns \?\? \[\]\);/);
  assert.match(card, /if \(localRecorded\) setLocalRun\(null\);/, "the local run is dropped once recorded");
  assert.match(card, /useRunState\(runAgentId, startedHere !== null && startedHere === runAgentId\)/, "'starting' stays tied to the run started here");
});

test("a retried save of a card that unmounted uses the newest settings another card rendered", async () => {
  const mirror = createSettingsMirror();
  const saved = [];
  const handle = (revision, values, reloads) => ({
    status: "ready",
    revision,
    values,
    save: async (next, rev) => {
      saved.push([next, rev]);
      return rev === "2";
    },
    reload: async () => void reloads.push(revision),
  });
  const reloads = [];
  // This card rendered revision 1 and then unmounted: its own handle never changes again.
  const stale = handle("1", { runs: [["a", "old"]] }, reloads);
  mirror.publish(stale);
  const update = (values) => ({ ...values, runs: [...values.runs, ["a", "new"]] });
  const tries = [];
  const latest = () => {
    tries.push(tries.length);
    // After the first failed save, another mounted card renders the reloaded revision 2.
    if (tries.length === 2) mirror.publish(handle("2", { runs: [["a", "old"], ["b", "other"]] }, reloads));
    return mirror.latest(stale);
  };
  assert.equal(await saveWithRetries(latest, update, { sleep: async () => {} }), true);
  assert.deepEqual(saved.at(-1), [{ runs: [["a", "old"], ["b", "other"], ["a", "new"]] }, "2"], "built from revision 2, keeping the other card's record");
  assert.equal(createSettingsMirror().latest(stale), stale, "nothing published: the card's own handle");

  const card = read("client/card.tsx");
  const remember = card.slice(card.indexOf("async function rememberRun("), card.indexOf("async function takeRunLock("));
  assert.match(remember, /saveWithRetries\(newestSettings, \(values\) => \(\{ \.\.\.values, runs: addRunRecord\(values\.runs, entry, MAX_RUNS\) \}\)\)/);
  assert.doesNotMatch(remember, /latestSettings\.current/, "no retry loop on the card's own, possibly stale handle");
  assert.match(card, /settingsMirror\.publish\(settings as RetrySettings<PreferenceValues>\);/);
});
