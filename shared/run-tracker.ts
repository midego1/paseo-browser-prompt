// Pure state behind the card's step progress and "waiting for the chat" label, fed by timeline
// reads and the live stream. Kept free of React so it is tested directly.
import { finalAssistantText } from "./report-back.ts";
import { createScreenshotTracker } from "./screenshot.ts";
import { latestStep, type StepProgress } from "./steps.ts";
import { MAX_REDIRECTS, parseQuestion, REDIRECT_PREFIX } from "./talk.ts";

type Item = { type: string; text?: unknown; messageId?: unknown; name?: unknown };
type StreamEvent = { type: string; item?: Item };

/** Assistant text kept from the live stream to find the latest marker. */
const STREAM_BUFFER = 4000;
/** Items kept for the current turn, to find its final message. */
const TURN_ITEMS = 200;

export interface RunView {
  progress: StepProgress | null;
  /** The latest turn ended with a question for the chat that is still waiting for its answer. */
  asking: boolean;
  /** Path or URL of the run's latest browser screenshot (one reference, never image data). */
  screenshot: string | null;
}

function isRedirect(item: Item): boolean {
  return item.type === "user_message" && typeof item.text === "string" && item.text.trimStart().startsWith(REDIRECT_PREFIX);
}

/**
 * A question is only waiting while the run can still get an answer: after MAX_REDIRECTS notices the
 * server handles a further question turn as the run's report, so the run is done, not waiting.
 */
function waitsForChat(finalText: string, redirects: number): boolean {
  return parseQuestion(finalText) !== null && redirects < MAX_REDIRECTS;
}

export function createRunTracker(total: number, showSteps: boolean, showScreenshots = false) {
  let progress: StepProgress | null = null;
  let asking = false;
  let buffer = "";
  let lastMessageId: string | null = null;
  let turnItems: Item[] = [];
  let redirects = 0;
  let screenshots = createScreenshotTracker();

  /** Appends a chunk; a new message (new message id, or a marker at its start) starts a new line. */
  function append(text: string, chunk: string, newMessage: boolean): string {
    const needsBreak =
      text && !text.endsWith("\n") && (newMessage || chunk.trimStart().startsWith("[browser-prompt "));
    return (text + (needsBreak ? "\n" : "") + chunk).slice(-STREAM_BUFFER);
  }

  return {
    view(): RunView {
      return { progress: showSteps ? progress : null, asking, screenshot: showScreenshots ? screenshots.latest() : null };
    },

    /** A tail read of the run's timeline: recomputes the waiting state and the latest step. */
    history(items: readonly Item[]): void {
      redirects = items.filter(isRedirect).length;
      if (showScreenshots) {
        const fromHistory = createScreenshotTracker();
        for (const item of items) fromHistory.push(item);
        // A tail read without a screenshot keeps the one already shown (it may be older than the tail).
        if (fromHistory.latest()) screenshots = fromHistory;
      }
      asking = waitsForChat(finalAssistantText(items), redirects);
      if (!showSteps) return;
      const text = items
        .map((item) => (item.type === "assistant_message" && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      const found = latestStep(text, total);
      if (found) progress = found;
    },

    /** One live stream event. */
    event(event: StreamEvent): void {
      if (event.type === "turn_started") {
        turnItems = [];
        asking = false;
        return;
      }
      if (event.type === "turn_completed") {
        // The turn's final message decides, as on the server: narration before a question does not hide it.
        asking = waitsForChat(finalAssistantText(turnItems), redirects);
        return;
      }
      if (event.type !== "timeline" || !event.item) return;
      const item = event.item;
      turnItems.push(item);
      if (turnItems.length > TURN_ITEMS) turnItems = turnItems.slice(-TURN_ITEMS);
      if (isRedirect(item)) redirects++;
      if (showScreenshots) screenshots.push(item);
      if (item.type !== "assistant_message" || typeof item.text !== "string") return;
      const messageId = typeof item.messageId === "string" && item.messageId ? item.messageId : null;
      const newMessage = messageId !== null && lastMessageId !== null && messageId !== lastMessageId;
      if (messageId) lastMessageId = messageId;
      if (!showSteps) return;
      buffer = append(buffer, item.text, newMessage);
      const found = latestStep(buffer, total);
      if (found) progress = found;
    },

    /** The agent is working again (an answer arrived): it no longer waits for the chat. */
    resumed(): void {
      asking = false;
    },
  };
}

export type RunTracker = ReturnType<typeof createRunTracker>;
