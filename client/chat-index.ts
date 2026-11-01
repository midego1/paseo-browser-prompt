// Which browser-prompt blocks a chat contains, for "Merge repeated blocks". Timeline renderers get
// only their own item (no position, and a timestamp Paseo gives every card of a chat alike), and the
// plugin API has no way to scroll to another item. So each card carries its message's id (added by
// the transformer), and each chat gets one index in memory, filled by reading the chat's timeline:
// - once per app session, page by page from the newest, for the whole chat (up to a cap),
// - again from the tail when a card's message is not in the index yet (a new message), throttled.
// A card is placed by its own message in that index, so the answer does not depend on which cards a
// virtualized list renders or in which order. Until its message is known, a card shows in full.
import type { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { createChatIndex, messagesInTimeline, type ChatIndex, type FirstResult } from "../shared/repeats";

type PaseoApi = ReturnType<typeof usePaseo>;
type Timeline = ReturnType<PaseoApi["agents"]["ref"]>["timeline"];
type Page = Awaited<ReturnType<Timeline["refetch"]>>;

/** Timeline entries per page, and pages at most for the whole-chat read. */
const PAGE_SIZE = 200;
const MAX_PAGES = 25;
/** A tail read for new messages at most this often per chat. */
const TAIL_INTERVAL_MS = 1500;
const TAIL_SIZE = 50;

interface ChatState {
  index: ChatIndex;
  version: number;
  listeners: Set<() => void>;
  fullRead: Promise<void> | null;
  tailRead: Promise<void> | null;
  lastTail: number;
}

const chats = new Map<string, ChatState>();

function chatState(agentId: string): ChatState {
  let state = chats.get(agentId);
  if (!state) {
    state = { index: createChatIndex(), version: 0, listeners: new Set(), fullRead: null, tailRead: null, lastTail: 0 };
    chats.set(agentId, state);
  }
  return state;
}

function addPage(state: ChatState, page: Page) {
  let added = false;
  for (const message of messagesInTimeline(page.entries)) {
    added = state.index.addMessage(message.messageId, message.seq, message.blocks) || added;
  }
  if (added) {
    state.version++;
    for (const listener of state.listeners) listener();
  }
}

/** The whole chat, newest page first, once per app session. */
function readChat(paseo: PaseoApi, agentId: string, state: ChatState): Promise<void> {
  state.fullRead ??= (async () => {
    const timeline = paseo.agents.ref(agentId).timeline;
    let cursor: Page["startCursor"] = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: Page = await timeline.refetch(
        cursor
          ? { direction: "before", cursor, limit: PAGE_SIZE, projection: "projected" }
          : { direction: "tail", limit: PAGE_SIZE, projection: "projected" },
      );
      addPage(state, result);
      if (!result.hasOlder || !result.startCursor) return;
      cursor = result.startCursor;
    }
  })().catch(() => {
    // Without the read, every card shows in full.
  });
  return state.fullRead;
}

/** The newest messages, for a card whose message arrived after the whole-chat read. Throttled. */
function readTail(paseo: PaseoApi, agentId: string, state: ChatState) {
  if (state.tailRead) return;
  const wait = state.lastTail + TAIL_INTERVAL_MS - Date.now();
  state.tailRead = (async () => {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    state.lastTail = Date.now();
    addPage(state, await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: TAIL_SIZE, projection: "projected" }));
  })()
    .catch(() => undefined)
    .finally(() => {
      state.tailRead = null;
    });
}

/**
 * Whether this card's block is the first with its key in the chat, a repeat of an earlier one, or
 * not known yet. Re-renders when the chat's index learns more.
 */
export function useFirstOf(
  paseo: PaseoApi,
  agentId: string,
  key: string,
  messageId: string | undefined,
  index: number,
  enabled: boolean,
): FirstResult {
  const state = chatState(agentId);
  const [, setVersion] = useState(state.version);
  const known = !!messageId && state.index.knows(messageId);
  useEffect(() => {
    if (!enabled || !messageId) return;
    const listener = () => setVersion(state.version);
    state.listeners.add(listener);
    listener();
    void readChat(paseo, agentId, state).then(() => {
      if (!state.index.knows(messageId)) readTail(paseo, agentId, state);
    });
    return () => {
      state.listeners.delete(listener);
    };
  }, [enabled, agentId, messageId, paseo, state]);
  // A message still unknown after the whole-chat read (new or streaming): read the tail again.
  useEffect(() => {
    if (enabled && messageId && !known && state.fullRead) readTail(paseo, agentId, state);
  }, [enabled, messageId, known, state.version, paseo, agentId, state]);
  return enabled ? state.index.firstOf(key, messageId, index) : { state: "first" };
}

/** Cards that show a block first, listening for "show me" from their repeats. */
const flashListeners = new Map<string, Set<() => void>>();

/** Lets the first card of `chatKey` (`<agentId>:<key>`) flash when a repeat is pressed. */
export function useFlashTarget(chatKey: string, active: boolean): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = () => {
      setFlashing(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setFlashing(false), 1600);
    };
    const set = flashListeners.get(chatKey) ?? new Set();
    set.add(listener);
    flashListeners.set(chatKey, set);
    return () => {
      set.delete(listener);
      if (timer) clearTimeout(timer);
    };
  }, [chatKey, active]);
  return flashing;
}

/** Flashes the first card; false when it is not rendered right now (scrolled out of the list). */
export function flashFirst(chatKey: string): boolean {
  const set = flashListeners.get(chatKey);
  if (!set || set.size === 0) return false;
  for (const listener of set) listener();
  return true;
}
