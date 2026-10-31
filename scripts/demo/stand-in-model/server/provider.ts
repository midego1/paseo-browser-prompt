// Demo only: the "model" behind the README video. It answers with fixed text and paced timeline
// items, so the recording shows the real Paseo app and the real browser-prompt plugin without any
// model calls or browser. Based on Paseo's plugin-examples/provider-direct.
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";

const CAPABILITIES = ["prompt.message", "prompt.steer", "session.configure", "session.persistence"] as const;
const MODES = [
  { id: "auto", label: "Auto mode" },
  { id: "default", label: "Always Ask" },
  { id: "plan", label: "Plan Mode" },
];
const MODEL = { id: "stand-in", label: "Stand-in (demo)" };

export const CARD_REPLY = [
  "Sure. I can't open a browser from here, so here are the steps as a browser prompt:",
  "",
  "```browser-prompt Check the example.com heading",
  "1. Open https://example.com",
  "2. Read the main heading.",
  '3. Open the "Docs" link.',
  "4. Report the heading and the title of the page it opens.",
  "```",
].join("\n");

const QUESTION = "[browser-prompt question] The page has no “Docs” link, only “More information…”. Should I open that one instead?";
const ANSWER = "[browser-prompt answer] Yes, open “More information…” instead.";
const REPORT = [
  "Done:",
  "1. Opened https://example.com",
  "2. The main heading is “Example Domain”.",
  "3. There was no “Docs” link, so I opened “More information…”, as the chat confirmed.",
  "4. That page's title is “Example Domains”.",
  "",
  "Nothing is left for you.",
].join("\n");
const THANKS = "Thanks! The heading is “Example Domain”, and the linked page is “Example Domains”. Nothing else to do.";

type Beat =
  | { wait: number; say: string }
  | { wait: number; tool: string; text: string };

/** The browser run before its question: step markers, stand-in tool rows, then the question. */
const RUN_UNTIL_QUESTION: Beat[] = [
  { wait: 1400, say: "[browser-prompt step 1/4] Opening example.com" },
  { wait: 900, tool: "browser_new_tab", text: "https://example.com" },
  { wait: 1600, say: "[browser-prompt step 2/4] Reading the main heading" },
  { wait: 900, tool: "browser_snapshot", text: "heading “Example Domain”" },
  { wait: 1300, say: "The main heading is “Example Domain”." },
  { wait: 1500, say: "[browser-prompt step 3/4] Looking for the Docs link" },
  { wait: 900, tool: "browser_snapshot", text: "links: “More information…”" },
  { wait: 1400, say: QUESTION },
];
/** The browser run after the chat's answer. */
const RUN_AFTER_ANSWER: Beat[] = [
  { wait: 1200, say: "[browser-prompt step 3/4] Opening “More information…”" },
  { wait: 900, tool: "browser_click", text: "“More information…”" },
  { wait: 1600, say: "[browser-prompt step 4/4] Writing the report" },
  { wait: 900, tool: "browser_snapshot", text: "title “Example Domains”" },
  { wait: 1500, say: REPORT },
];

const pendingAnswers: { runId: string; text: string }[] = [];
/** The stand-in chat's answer waiting to be delivered to a run (see index.server.ts). */
export function takePendingAnswer() {
  return pendingAnswers.shift() ?? null;
}

interface Session {
  config: ProviderSessionConfig;
  persistence: ProviderPersistence;
  turn: number;
  activeTurnId: string | null;
  items: number;
}

export function createStandInProvider(): ProviderRegistration {
  return {
    id: "claude-demo",
    label: "Stand-in model (demo)",
    description: "Scripted answers for recording the browser-prompt demo. Makes no model calls.",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

function createConnection(capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      if (input.type !== "session.open" && "sessionId" in input && !sessions.has(input.sessionId)) {
        throw new Error(`Unknown session: ${input.sessionId}`);
      }
      requireProviderCapabilities(capabilities, input);
      queueMicrotask(() => {
        if (!closed) dispatch(input, sessions, emit, capabilities);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      sessions.clear();
      listeners.clear();
    },
  };
}

function configState(session: Session): ProviderConfigState {
  return {
    model: MODEL.id,
    mode: session.config.mode ?? "auto",
    thinkingOption: undefined,
    models: [MODEL],
    modes: MODES,
    thinkingOptions: [],
    settings: [],
  };
}

function dispatch(
  input: ProviderInput,
  sessions: Map<string, Session>,
  emit: (event: ProviderEvent) => void,
  capabilities: readonly string[],
): void {
  switch (input.type) {
    case "catalog":
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: { models: [MODEL], modes: MODES, defaultModel: MODEL.id, defaultMode: "auto" },
      });
      return;
    case "sessions":
      emit({ type: "sessions", requestId: input.requestId, sessions: [] });
      return;
    case "session.open": {
      const persistence = input.persistence ?? { version: 1, data: { nativeSessionId: `demo:${input.sessionId}` } };
      const session: Session = { config: input.config, persistence, turn: 0, activeTurnId: null, items: 0 };
      sessions.set(input.sessionId, session);
      emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities,
        restoration: "core",
        persistence,
        title: input.config.title,
        cwd: input.config.cwd,
      });
      emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
      emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      return;
    }
    case "session.configure": {
      const session = sessions.get(input.sessionId)!;
      const mode = input.changes.mode;
      session.config = { ...session.config, mode: mode === null ? undefined : (mode ?? session.config.mode) };
      emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.prompt":
      prompt(input, sessions.get(input.sessionId)!, emit);
      return;
    case "session.close":
      sessions.delete(input.sessionId);
      emit({ type: "session.closed", sessionId: input.sessionId });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    default:
      if ("requestId" in input && input.requestId) emit({ type: "request.completed", requestId: input.requestId });
  }
}

function prompt(input: Extract<ProviderInput, { type: "session.prompt" }>, session: Session, emit: (event: ProviderEvent) => void) {
  const sessionId = input.sessionId;
  if (input.prompt.input.type !== "message" && input.prompt.input.type !== undefined) {
    emit({ type: "session.prompt_result", sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "completed" } });
    return;
  }
  const text = (input.prompt.input as { content: { type: string; text?: string }[] }).content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (input.prompt.delivery === "steer" && session.activeTurnId) {
    emit({ type: "session.prompt_result", sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "steer", turnId: session.activeTurnId } });
    return;
  }
  session.turn += 1;
  const turnId = `turn-${session.turn}`;
  session.activeTurnId = turnId;
  emit({ type: "timeline.item", sessionId, item: { type: "user_message", id: `user-${session.turn}`, text, clientMessageId: input.prompt.clientMessageId } });
  emit({ type: "session.prompt_result", sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
  emit({ type: "session.turn", sessionId, turnId, state: "started" });

  const nextId = () => `item-${session.turn}-${++session.items}`;
  const say = (line: string) => {
    const id = nextId();
    emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id, messageId: id, text: line } });
  };
  const tool = (name: string, detail: string) => {
    const id = nextId();
    emit({
      type: "timeline.item",
      sessionId,
      item: { type: "tool_call", id, callId: id, name, status: "completed", error: null, detail: { type: "plain_text", label: name, text: detail } },
    });
  };
  const finish = () => {
    emit({ type: "session.turn", sessionId, turnId, state: "completed" });
    session.activeTurnId = null;
  };
  const play = (beats: Beat[]) => {
    let at = 0;
    for (const beat of beats) {
      at += beat.wait;
      setTimeout(() => ("say" in beat ? say(beat.say) : tool(beat.tool, beat.text)), at);
    }
    setTimeout(finish, at + 300);
  };

  if (text.includes("You are carrying out browser steps")) return play(RUN_UNTIL_QUESTION);
  if (text.startsWith("[browser-prompt answer]") || text.startsWith("[browser-prompt] Your question was not forwarded")) {
    return play(RUN_AFTER_ANSWER);
  }
  const question = /^\[browser-prompt question from run ([^\]\s]+)\]/.exec(text);
  if (question) {
    pendingAnswers.push({ runId: question[1]!, text: ANSWER });
    return play([{ wait: 1500, say: ANSWER }]);
  }
  if (text.startsWith("[browser-prompt] Browser agent")) return play([{ wait: 1500, say: THANKS }]);
  return play([{ wait: 1800, say: CARD_REPLY }]);
}
