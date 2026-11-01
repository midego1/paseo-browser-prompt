// Pure logic behind "Merge repeated blocks": a content key per browser-prompt block, and which
// block of a chat comes first for a key. Imports only pure shared modules so tests can load it with
// `node --experimental-strip-types`.
import { findBrowserPrompts } from "./browser-prompt.ts";

/** Keys of this shape start with this prefix; older card ids (8 hex digits) never do. */
export const KEY_PREFIX = "k1-";

/**
 * One line of a block for its key: NFKC-normalized, outer and repeated inner whitespace collapsed,
 * and a step number written as `N. ` (`1.Open`, `1.   Open` and `1) Open` all become `1. Open`).
 */
function normalizeLine(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(\d+)[.)]\s*/, "$1. ");
}

/**
 * A block's text as its key sees it: line endings unified, each line normalized, blank lines
 * dropped. Case and everything else are kept.
 */
export function normalizeBlockText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .join("\n");
}

/** cyrb53: a fast 53-bit string hash (public domain), as 14 hex digits. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The block's content key: its title and steps, normalized, hashed. Equal blocks share a key. */
export function blockKey(title: string, body: string): string {
  return `${KEY_PREFIX}${hash53(`${normalizeBlockText(title)}\u0000${normalizeBlockText(body)}`)}`;
}

/** A block's place: its message (Paseo's message id) and its position in that message. */
export interface BlockRef {
  messageId: string;
  index: number;
}

export type FirstResult =
  /** This card's message is not known yet (newer than the last read, or no message id). */
  | { state: "unknown" }
  | { state: "first" }
  | { state: "repeat"; first: BlockRef };

/**
 * What a chat is known to contain, from reading its timeline: each message's place in the chat
 * (its sequence number) and each block's key. A card finds its own message here by id, so the
 * answer does not depend on which cards the list has rendered or in which order (virtualized lists
 * often render the newest first). The renderer's own `timestamp` cannot place a card: Paseo gives
 * every card of a chat the same one.
 */
export function createChatIndex() {
  const seqs = new Map<string, number>();
  const byKey = new Map<string, BlockRef[]>();
  return {
    /** Adds a message and its blocks; returns true when anything was new. */
    addMessage(messageId: string, seq: number, blocks: readonly { key: string; index: number }[]): boolean {
      if (!messageId || !Number.isFinite(seq)) return false;
      let added = !seqs.has(messageId);
      seqs.set(messageId, seq);
      for (const { key, index } of blocks) {
        const refs = byKey.get(key) ?? [];
        if (refs.some((ref) => ref.messageId === messageId && ref.index === index)) continue;
        refs.push({ messageId, index });
        byKey.set(key, refs);
        added = true;
      }
      return added;
    },
    knows(messageId: string): boolean {
      return seqs.has(messageId);
    },
    /** Whether the block at `messageId`/`index` is the first with `key` in the chat, or which one is. */
    firstOf(key: string, messageId: string | undefined, index: number): FirstResult {
      const own = messageId ? seqs.get(messageId) : undefined;
      if (own === undefined) return { state: "unknown" };
      let first: { ref: BlockRef; seq: number } | null = null;
      for (const ref of byKey.get(key) ?? []) {
        const seq = seqs.get(ref.messageId);
        if (seq === undefined || (ref.messageId === messageId && ref.index === index)) continue;
        const earlier = seq < own || (seq === own && ref.index < index);
        if (!earlier) continue;
        if (!first || seq < first.seq || (seq === first.seq && ref.index < first.ref.index)) first = { ref, seq };
      }
      return first ? { state: "repeat", first: first.ref } : { state: "first" };
    },
  };
}

export type ChatIndex = ReturnType<typeof createChatIndex>;

type TimelineEntry = { item: { type: string; text?: unknown; messageId?: unknown }; seqStart: number };

/** The assistant messages in a page of timeline entries that have an id, with their blocks' keys. */
export function messagesInTimeline(
  entries: readonly TimelineEntry[],
): { messageId: string; seq: number; blocks: { key: string; index: number }[] }[] {
  const found: { messageId: string; seq: number; blocks: { key: string; index: number }[] }[] = [];
  for (const entry of entries) {
    const { item } = entry;
    if (item.type !== "assistant_message" || typeof item.text !== "string") continue;
    if (typeof item.messageId !== "string" || !item.messageId) continue;
    const blocks = findBrowserPrompts(item.text)
      .filter((block) => block.closed)
      .map((block) => ({ key: blockKey(block.title, block.body), index: block.index }));
    found.push({ messageId: item.messageId, seq: entry.seqStart, blocks });
  }
  return found;
}

/**
 * How a card shows: "repeat" for a later block with the same content as an earlier one, "done" for
 * such a block whose first is marked done, and "full" otherwise: the first block, merging off, a
 * card with its own recorded run, or a card whose message is not known yet.
 */
export function repeatView(input: { merge: boolean; first: FirstResult; done: boolean; ownRun: boolean }): "full" | "repeat" | "done" {
  if (!input.merge || input.first.state !== "repeat" || input.ownRun) return "full";
  return input.done ? "done" : "repeat";
}

/**
 * Done marks are `<agentId>:<key>`. Before 0.9.0 they were `<agentId>:<cardId>` (a hash of the raw
 * text, which cannot be turned into the new key without the text). A card that finds its old mark
 * returns the list with that mark replaced by the new one; null when nothing changes.
 */
export function migrateDoneMark(done: readonly string[], legacyMark: string, mark: string): string[] | null {
  if (!done.includes(legacyMark)) return null;
  const without = done.filter((entry) => entry !== legacyMark && entry !== mark);
  return [...without, mark];
}
