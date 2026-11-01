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
  runKeyMarker,
  sharedRunRecord,
  sameBlock,
  withinMessage,
  KEY_PREFIX,
  messagesInTimeline,
  migrateDoneMark,
  normalizeBlockText,
  repeatView,
} from "../shared/repeats.ts";
import { migratePreferences } from "../shared/settings-migrate.ts";

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
  assert.match(card, /useFirstOf\(paseo, agentId, fingerprint, messageId, index, true\)/, "always placed: the run guard needs it even with collapsing off");
  assert.match(read("index.client.tsx"), /explodeMessage\(item\.text, phase, messageId\)/);
  const [, card1] = explodeMessage("```browser-prompt T\n1. x\n```", "complete", "msg-1");
  assert.equal(card1.data.messageId, "msg-1");
  const [, card2] = explodeMessage("```browser-prompt T\n1. x\n```", "complete");
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
  assert.match(card, /mark !== doneMark && mark !== runKey/, "undo removes both forms");
  assert.match(read("client/settings-screen.tsx"), /done: \[\] \}, revision/, "Clear");
});

test("settings v12: Merge repeated blocks defaults on; the migration keeps done marks", () => {
  const settings = read("shared/settings.ts");
  assert.match(settings, /version: 12,/);
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
  assert.match(card, /if \(busy \|\| runBlocked\) return;/);
  assert.match(card, /disabled=\{busy \|\| runBlocked\}/);
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
