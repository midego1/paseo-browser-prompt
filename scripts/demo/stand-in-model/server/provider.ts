// Demo only: the "model" behind the README video. It answers with fixed text and paced timeline
// items, so the recording shows the real Paseo app and the real browser-prompt plugin without any
// model calls or browser. Based on Paseo's plugin-examples/provider-direct.
import { existsSync, readFileSync } from "node:fs";
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

const CAPABILITIES = ["prompt.message", "prompt.steer", "session.configure", "session.persistence", "permission"] as const;
const MODES = [
  { id: "auto", label: "Auto mode" },
  { id: "default", label: "Always Ask" },
  { id: "plan", label: "Plan Mode" },
];
const MODEL = { id: "stand-in", label: "Stand-in (demo)" };

type Beat =
  | { wait: number; say: string }
  | { wait: number; tool: string; text: string }
  /** A stand-in browser screenshot: a browser_screenshot row, then the image the way Paseo shows one. */
  | { wait: number; screenshot: number }
  /** A request for the owner (a permission); the turn goes on with `allowed` or `denied` after the answer. */
  | { wait: number; ask: Ask };

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface Ask {
  request: { name: string; kind: "tool" | "question"; input: Record<string, JsonValue> };
  allowed: Beat[];
  denied: Beat[];
}

/**
 * Written by record.sh: the stand-in screenshots (real example.com and iana.org pages rendered by
 * the recorder's own Chromium, stored in the daemon's attachment form) and how long the run and the
 * chat hold the states the recorder films or captures.
 */
export const STAND_INS_FILE = "/tmp/browser-prompt-demo-stand-ins.json";

function standIns(): { shots: string[]; hold: number } {
  if (!existsSync(STAND_INS_FILE)) return { shots: [], hold: 2500 };
  const { shots, hold } = JSON.parse(readFileSync(STAND_INS_FILE, "utf8")) as { shots?: unknown; hold?: unknown };
  return {
    shots: Array.isArray(shots) ? shots.filter((shot): shot is string => typeof shot === "string") : [],
    hold: typeof hold === "number" ? hold : 2500,
  };
}

// Written for example.com as it is today: one paragraph and a “Learn more” link to IANA's page.
const CARD_REPLY = [
  "Sure. I can't open a browser from here, so here are the steps as a browser prompt:",
  "",
  "```browser-prompt Check what example.com says",
  "1. Open https://example.com",
  "2. Read the first paragraph.",
  '3. Open the "Docs" link.',
  "4. Report the first line and the title of the page it opens.",
  "```",
].join("\n");
const QUESTION = "[browser-prompt question] The page has no “Docs” link, only “Learn more”. Should I open that one instead?";
const ANSWER = "[browser-prompt answer] Yes, open “Learn more” instead.";
const REPORT = [
  "Done:",
  "1. Opened https://example.com",
  "2. Its first line: “This domain is for use in documentation examples without needing permission.”",
  "3. There was no “Docs” link, so I opened “Learn more”, as the chat confirmed. Its title is “Example Domains”.",
  "4. As you asked, I also opened IANA's list of reserved domains.",
  "",
  "Nothing is left for you.",
].join("\n");
const THANKS = "Thanks! example.com is reserved for documentation examples, and its “Learn more” page is “Example Domains”. Nothing else to do.";

/** The browser run before its question: step markers, stand-in tool rows and screenshots, then the question. */
const RUN_UNTIL_QUESTION: Beat[] = [
  { wait: 1400, say: "[browser-prompt step 1/4] Opening example.com" },
  { wait: 900, tool: "browser_new_tab", text: "https://example.com" },
  { wait: 700, screenshot: 0 },
  { wait: 1600, say: "[browser-prompt step 2/4] Reading the first paragraph" },
  { wait: 900, tool: "browser_snapshot", text: "paragraph “This domain is for use in documentation examples…”" },
  { wait: 700, screenshot: 1 },
  { wait: 1500, say: "[browser-prompt step 3/4] Looking for the Docs link" },
  { wait: 900, tool: "browser_snapshot", text: "links: “Learn more”" },
  { wait: 1400, say: QUESTION },
];

/** The browser run after the chat's answer: a question and a permission for the owner, then the report. */
function runAfterAnswer(hold: number): Beat[] {
  const report: Beat[] = [{ wait: 1500, say: REPORT }];
  return [
    { wait: 1200, say: "[browser-prompt step 3/4] Opening “Learn more”" },
    { wait: 900, tool: "browser_click", text: "“Learn more”" },
    { wait: 700, screenshot: 2 },
    { wait: 900, say: "That page's title is “Example Domains”." },
    { wait: hold, say: "[browser-prompt step 4/4] Writing the report" },
    {
      wait: 1200,
      ask: {
        request: {
          name: "AskUserQuestion",
          kind: "question",
          input: {
            questions: [
              {
                question: "Should I also check IANA's list of reserved domains before I report?",
                header: "Extra check",
                options: [
                  { label: "Yes, check it", description: "Open the reserved domains list too" },
                  { label: "No, just report", description: "Report what I found so far" },
                ],
                multiSelect: false,
              },
            ],
          },
        },
        allowed: [
          { wait: 1000, say: "Okay, I'll open the reserved domains list too." },
          {
            wait: 1200,
            ask: {
              request: {
                name: "mcp__paseo__browser_navigate",
                kind: "tool",
                input: { url: "https://www.iana.org/domains/reserved", browserId: "demo-tab" },
              },
              allowed: [{ wait: 900, tool: "browser_navigate", text: "https://www.iana.org/domains/reserved" }, ...report],
              denied: report,
            },
          },
        ],
        denied: report,
      },
    },
  ];
}

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
  /** The beats to play after the owner answers the open permission request. */
  waiting: { id: string; ask: Ask; play: (beats: Beat[]) => void } | null;
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
      const session: Session = { config: input.config, persistence, turn: 0, activeTurnId: null, items: 0, waiting: null };
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
    case "session.permission": {
      const session = sessions.get(input.sessionId)!;
      const waiting = session.waiting;
      if (!waiting || waiting.id !== input.permissionId) return;
      session.waiting = null;
      emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: input.permissionId });
      waiting.play(input.response.behavior === "allow" ? waiting.ask.allowed : waiting.ask.denied);
      return;
    }
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
  const screenshot = (index: number) => {
    tool("browser_screenshot", "viewport");
    const source = standIns().shots[index];
    if (source) say(`\n\n![Image](${source})\n\n`);
  };
  const ask = (beat: Ask) => {
    const id = `permission-${nextId()}`;
    session.waiting = { id, ask: beat, play };
    emit({ type: "session.permission", sessionId, request: { id, ...beat.request } });
  };
  const finish = () => {
    emit({ type: "session.turn", sessionId, turnId, state: "completed" });
    session.activeTurnId = null;
  };
  // Plays beats in order; an ask stops here and the owner's answer plays its own beats.
  function play(beats: Beat[]) {
    let at = 0;
    for (const beat of beats) {
      at += beat.wait;
      if ("ask" in beat) {
        setTimeout(() => ask(beat.ask), at);
        return;
      }
      setTimeout(() => {
        if ("say" in beat) say(beat.say);
        else if ("screenshot" in beat) screenshot(beat.screenshot);
        else tool(beat.tool, beat.text);
      }, at);
    }
    setTimeout(finish, at + 300);
  }

  const { hold } = standIns();
  if (text.includes("You are carrying out browser steps")) return play(RUN_UNTIL_QUESTION);
  if (text.startsWith("[browser-prompt answer]") || text.startsWith("[browser-prompt] Your question was not forwarded")) {
    return play(runAfterAnswer(hold));
  }
  const question = /^\[browser-prompt question from run ([^\]\s]+)\]/.exec(text);
  if (question) {
    pendingAnswers.push({ runId: question[1]!, text: ANSWER });
    return play([{ wait: hold, say: ANSWER }]);
  }
  if (text.startsWith("[browser-prompt] Browser agent")) return play([{ wait: 1500, say: THANKS }]);
  return play([{ wait: 1800, say: CARD_REPLY }]);
}
