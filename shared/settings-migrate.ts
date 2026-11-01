// Pure migration for the `preferences` settings document. Imports only pure shared modules so tests
// can load it with `node --experimental-strip-types`.
import { MAX_CHAT_QUESTIONS_LIMIT, providerFamily } from "./agent-prompt.ts";

/** Converts a stored `preferences` document from `fromVersion` to the current shape. */
export function migratePreferences(values: unknown, fromVersion: number): unknown {
  const old = (values ?? {}) as { done?: unknown; reportBack?: unknown; agentMode?: unknown; agentProvider?: unknown };
  // v1 only had startMode ("web-agent" | "copy-only") and done. The app is the new default.
  if (fromVersion < 2) return { done: Array.isArray(old.done) ? old.done : [] };
  let next = values as Record<string, unknown>;
  // v5 stored reportBack as a boolean: true becomes auto, false becomes off.
  if (fromVersion < 6 && typeof old.reportBack === "boolean") {
    next = { ...next, reportBack: old.reportBack ? "auto" : "off" };
  }
  // v7 makes Claude Auto mode the default: a stored Always Ask ("default") or empty mode becomes
  // "auto" once. Plan and other providers' modes are kept; a later choice of "default" sticks.
  if (fromVersion < 7) {
    const provider = typeof old.agentProvider === "string" && old.agentProvider.trim() ? old.agentProvider : "claude";
    const mode = typeof old.agentMode === "string" ? old.agentMode.trim() : "";
    if (providerFamily(provider) === "claude" && (mode === "" || mode === "default")) next = { ...next, agentMode: "auto" };
  }
  // v8 adds openAgentOnStart, talkToChat and maxChatQuestions with defaults. A stored question cap
  // that is not a whole number from 0 to 50 would make the whole document invalid, so it is clamped.
  if (fromVersion < 8) {
    const raw = next.maxChatQuestions;
    if (raw !== undefined && !(typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_CHAT_QUESTIONS_LIMIT)) {
      const value = typeof raw === "number" && Number.isFinite(raw) ? Math.min(MAX_CHAT_QUESTIONS_LIMIT, Math.max(0, Math.floor(raw))) : undefined;
      next = { ...next };
      if (value === undefined) delete next.maxChatQuestions;
      else next.maxChatQuestions = value;
    }
  }
  // v9 adds showStepProgress, v10 showLiveScreenshot and v11 thumbnailMode, all with defaults.
  // A stored thumbnailMode that is not "all" or "latest" would make the document invalid: drop it.
  if (fromVersion < 11 && "thumbnailMode" in next && next.thumbnailMode !== "all" && next.thumbnailMode !== "latest") {
    next = { ...next };
    delete next.thumbnailMode;
  }
  // v12 adds mergeRepeats (default on). Done marks keep their old form here: a mark is a hash of the
  // block's raw text, and the new content key needs the text, so each card moves its own old mark
  // when it renders (`migrateDoneMark` in shared/repeats.ts). Old marks keep working until then.
  // v13 adds closeTabsOnSuccess (default on, also for existing settings). A stored value that is not
  // a boolean would make the document invalid: drop it so the default applies.
  if (fromVersion < 13 && "closeTabsOnSuccess" in next && typeof next.closeTabsOnSuccess !== "boolean") {
    next = { ...next };
    delete next.closeTabsOnSuccess;
  }
  return next;
}
