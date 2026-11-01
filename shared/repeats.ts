// Pure logic behind repeated blocks: a content key per browser-prompt block, and which
// block of a chat comes first for a key. Imports only pure shared modules so tests can load it with
// `node --experimental-strip-types`.
import { blockFingerprint, sameBlock, type BlockFingerprint } from "./block-key.ts";
import { CARD_KIND, findBrowserPrompts, type ExplodedItem } from "./browser-prompt.ts";

export { blockFingerprint, blockKey, KEY_PREFIX, normalizeBlockText, sameBlock, type BlockFingerprint } from "./block-key.ts";

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
 * (its sequence number) and each block's fingerprint (key, normalized length and a second hash, all
 * three must match). A card finds its own message here by id, so the
 * answer does not depend on which cards the list has rendered or in which order (virtualized lists
 * often render the newest first). The renderer's own `timestamp` cannot place a card: Paseo gives
 * every card of a chat the same one.
 */
export function createChatIndex() {
  const seqs = new Map<string, number>();
  const byKey = new Map<string, (BlockRef & { fingerprint: BlockFingerprint })[]>();
  return {
    /** Adds a message and its blocks; returns true when anything was new. */
    addMessage(messageId: string, seq: number, blocks: readonly { fingerprint: BlockFingerprint; index: number }[]): boolean {
      if (!messageId || !Number.isFinite(seq)) return false;
      let added = !seqs.has(messageId);
      seqs.set(messageId, seq);
      for (const { fingerprint, index } of blocks) {
        const refs = byKey.get(fingerprint.key) ?? [];
        if (refs.some((ref) => ref.messageId === messageId && ref.index === index)) continue;
        refs.push({ messageId, index, fingerprint });
        byKey.set(fingerprint.key, refs);
        added = true;
      }
      return added;
    },
    knows(messageId: string): boolean {
      return seqs.has(messageId);
    },
    /** Whether the block at `messageId`/`index` is the first of its kind in the chat, or which one is. */
    firstOf(fingerprint: BlockFingerprint, messageId: string | undefined, index: number): FirstResult {
      const own = messageId ? seqs.get(messageId) : undefined;
      if (own === undefined) return { state: "unknown" };
      let first: { ref: BlockRef; seq: number } | null = null;
      for (const ref of byKey.get(fingerprint.key) ?? []) {
        const seq = seqs.get(ref.messageId);
        if (seq === undefined || (ref.messageId === messageId && ref.index === index)) continue;
        if (!sameBlock(ref.fingerprint, fingerprint)) continue;
        const earlier = seq < own || (seq === own && ref.index < index);
        if (!earlier) continue;
        if (!first || seq < first.seq || (seq === first.seq && ref.index < first.ref.index)) first = { ref, seq };
      }
      return first ? { state: "repeat", first: { messageId: first.ref.messageId, index: first.ref.index } } : { state: "first" };
    },
  };
}

export type ChatIndex = ReturnType<typeof createChatIndex>;

type TimelineEntry = { item: { type: string; text?: unknown; messageId?: unknown }; seqStart: number };

/** The assistant messages in a page of timeline entries that have an id, with their blocks' keys. */
export function messagesInTimeline(
  entries: readonly TimelineEntry[],
): { messageId: string; seq: number; blocks: { fingerprint: BlockFingerprint; index: number }[] }[] {
  const found: { messageId: string; seq: number; blocks: { fingerprint: BlockFingerprint; index: number }[] }[] = [];
  for (const entry of entries) {
    const { item } = entry;
    if (item.type !== "assistant_message" || typeof item.text !== "string") continue;
    if (typeof item.messageId !== "string" || !item.messageId) continue;
    const blocks = findBrowserPrompts(item.text)
      .filter((block) => block.closed)
      .map((block) => ({ fingerprint: blockFingerprint(block.title, block.body), index: block.index }));
    found.push({ messageId: item.messageId, seq: entry.seqStart, blocks });
  }
  return found;
}

/**
 * Marks each card that repeats an earlier card of the same message (`sameAs`: that card's block
 * index). Runs in the transformer, which sees the whole message, so such repeats show as one line
 * right away, before the chat's index is read.
 */
export function markRepeatsInMessage(items: ExplodedItem[]): ExplodedItem[] {
  const seen: { fingerprint: BlockFingerprint; index: number }[] = [];
  return items.map((item) => {
    if (item.kind !== CARD_KIND) return item;
    const fingerprint = blockFingerprint(item.data.title, item.data.text);
    const earlier = seen.find((known) => sameBlock(known.fingerprint, fingerprint));
    seen.push({ fingerprint, index: item.data.index });
    return earlier ? { ...item, data: { ...item.data, sameAs: earlier.index } } : item;
  });
}

/**
 * While the chat's index does not know a card's message yet, a block that repeats an earlier block
 * of the same message (the transformer's `sameAs`) is already known to be a repeat: shown as one at
 * once instead of collapsing after the read. Otherwise the index's answer stands.
 */
export function withinMessage(first: FirstResult, sameAs: number | undefined, messageId: string | undefined): FirstResult {
  if (first.state !== "unknown" || sameAs === undefined) return first;
  return { state: "repeat", first: { messageId: messageId ?? "", index: sameAs } };
}

/** The marker a run record carries for the content it was started for (see `sharedRunRecord`). */
export function runKeyMarker(key: string): string {
  return `key:${key}`;
}

/**
 * The run a card shows: the newest record of this chat that was started from this card's own id
 * (identical text) or for the same content (the `key:` marker, also from a repeat whose text differs
 * only in spacing). Records are kept oldest first.
 */
export function sharedRunRecord<Entry extends readonly string[]>(
  runs: readonly Entry[],
  agentId: string,
  runKey: string,
  key: string,
): Entry | null {
  const marker = runKeyMarker(key);
  for (let i = runs.length - 1; i >= 0; i--) {
    const entry = runs[i]!;
    if (entry[0] === runKey) return entry;
    if (entry[0]?.startsWith(`${agentId}:`) && entry.slice(2).includes(marker)) return entry;
  }
  return null;
}

/** Run states during which a run is still going (a repeat does not start a second one then). */
const ACTIVE_RUN_STATES = new Set(["starting", "running", "needs-input", "asking"]);

/** A repeat may start a run only while the shared run (if any) is not going. */
export function canStartRun(input: { repeat: boolean; runState: string | null }): boolean {
  return !input.repeat || input.runState === null || !ACTIVE_RUN_STATES.has(input.runState);
}

/**
 * How a card shows. "full": the first block, or "Collapse repeated blocks that are done" off.
 * "repeat": a later copy of a block that is not done, as a full card with a hint that it was shown
 * earlier. "collapsed": a later copy of a done block, one line until the owner taps Show
 * (`expanded`), then a full card again.
 */
export function repeatView(input: { collapse: boolean; first: FirstResult; done: boolean; expanded: boolean }): "full" | "repeat" | "collapsed" {
  if (!input.collapse || input.first.state !== "repeat") return "full";
  return input.done && !input.expanded ? "collapsed" : "repeat";
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
