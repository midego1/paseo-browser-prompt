// Run: npm test. Merge repeated blocks: the content key, which block of a chat comes first (also
// when a later card renders first), the compact line's decision, and done marks per key.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { explodeMessage, hashText } from "../shared/browser-prompt.ts";
import {
  blockKey,
  createChatIndex,
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
  const key = blockKey("Check", steps);
  const index = createChatIndex();
  // The whole-chat read learns every message with its sequence number, whatever the list rendered.
  index.addMessage("msg-a", 2, [{ key, index: 0 }]);
  index.addMessage("msg-b", 6, [{ key, index: 0 }, { key, index: 1 }]);
  index.addMessage("msg-c", 9, [{ key: blockKey("Other", steps), index: 0 }]);
  // Asked in any order (a virtualized list renders the newest card first):
  assert.deepEqual(index.firstOf(key, "msg-b", 1), { state: "repeat", first: { messageId: "msg-a", index: 0 } });
  assert.deepEqual(index.firstOf(key, "msg-b", 0), { state: "repeat", first: { messageId: "msg-a", index: 0 } });
  assert.deepEqual(index.firstOf(key, "msg-a", 0), { state: "first" });
  assert.deepEqual(index.firstOf(blockKey("Other", steps), "msg-c", 0), { state: "first" }, "other keys do not matter");
  // In one message, the earlier position wins.
  const one = createChatIndex();
  one.addMessage("m", 1, [{ key, index: 0 }, { key, index: 2 }]);
  assert.deepEqual(one.firstOf(key, "m", 2), { state: "repeat", first: { messageId: "m", index: 0 } });
  assert.deepEqual(one.firstOf(key, "m", 0), { state: "first" });
});

test("a card whose message is not known yet (new, streaming, or no message id) is not decided", () => {
  const key = blockKey("Check", steps);
  const index = createChatIndex();
  index.addMessage("msg-a", 2, [{ key, index: 0 }]);
  assert.deepEqual(index.firstOf(key, "msg-new", 0), { state: "unknown" }, "shown in full until the tail read knows it");
  assert.deepEqual(index.firstOf(key, undefined, 0), { state: "unknown" }, "providers without message ids: always full");
  assert.equal(index.knows("msg-new"), false);
  assert.equal(index.addMessage("msg-new", 8, [{ key, index: 0 }]), true);
  assert.equal(index.addMessage("msg-new", 8, [{ key, index: 0 }]), false, "a second read adds nothing");
  assert.deepEqual(index.firstOf(key, "msg-new", 0), { state: "repeat", first: { messageId: "msg-a", index: 0 } });
  assert.equal(repeatView({ merge: true, first: { state: "unknown" }, done: true, ownRun: false }), "full");
});

test("cards are placed by message id: Paseo gives every card of a chat the same timestamp", () => {
  const card = read("client/card.tsx");
  assert.doesNotMatch(card.slice(card.indexOf("const first = ")), /timestamp\.getTime\(\), index \}/);
  assert.match(card, /useFirstOf\(paseo, agentId, key, messageId, index, merge\)/);
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
  assert.equal(found[0].blocks[0].key, found[0].blocks[1].key, "the blank lines do not matter");
  const cards = explodeMessage(message, "complete").filter((item) => item.kind === "browser-prompt-card");
  assert.deepEqual(found[0].blocks.map((block) => block.index), cards.map((c) => c.data.index), "same positions as the cards");
});

test("full card, repeat line or Already done", () => {
  const first = { state: "repeat", first: { messageId: "m", index: 0 } };
  assert.equal(repeatView({ merge: true, first: { state: "first" }, done: false, ownRun: false }), "full", "the first");
  assert.equal(repeatView({ merge: true, first, done: false, ownRun: false }), "repeat");
  assert.equal(repeatView({ merge: true, first, done: true, ownRun: false }), "done");
  assert.equal(repeatView({ merge: false, first, done: true, ownRun: false }), "full", "setting off: every block is a card");
  assert.equal(repeatView({ merge: true, first, done: false, ownRun: true }), "full", "a repeat with its own run keeps its card");
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

test("repeats never start runs, and runs stay keyed by the card's own id", () => {
  const card = read("client/card.tsx");
  const line = card.slice(card.indexOf("function RepeatLine("));
  assert.doesNotMatch(line, /launchAgent|onRunPress|startBrowserAgent|Run with Paseo agent/, "no Run on the repeat line");
  assert.match(card, /if \(view !== "full"\) \{\n\s+return <RepeatLine/);
  assert.match(card, /const runKey = `\$\{agentId\}:\$\{cardId\}`;/);
  assert.match(card, /\? \[runKey, startedAgentId, MOST_RECENT_FALLBACK\]/);
  assert.match(card, /entry === runKey\)\?\.\[1\]/);
});
