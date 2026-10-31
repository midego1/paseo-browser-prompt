// Pure logic for answering a run's pending question or permission request from the card. The
// requests come from the run agent's own snapshot (SDK `refresh().pendingPermissions`) and are
// answered with the SDK's `respondToPermission`, only when the owner clicks on the card. Nothing here
// talks to the chat or answers on its own. Imports only pure shared modules so tests can load it.
import { CARD_LABEL, isBrowserRun, SOURCE_LABEL } from "./report-back.ts";

export const MAX_QUESTION_TEXT = 500;
export const MAX_OPTION_LABEL = 80;
export const MAX_OPTION_DESCRIPTION = 160;
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 8;
export const MAX_ACTIONS = 4;
export const MAX_SUMMARY_VALUE = 1000;
export const MAX_SUMMARY_BLOCK = 2000;
export const MAX_SUMMARY_BLOCK_LINES = 30;
export const MAX_SUMMARY_LINES = 12;
export const MAX_PLAN_TEXT = 6000;
/** Plan actions ("Implement with Auto mode") are shown in full, up to this length. */
export const MAX_PLAN_ACTION_LABEL = 200;

const INVISIBLE = /[­؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/**
 * Text from the run for display: NFKC-normalized, no invisible or control characters (newlines kept
 * when `multiline`), trimmed and capped. It is shown as plain React Native text.
 */
export function cleanPromptText(value: unknown, max: number, multiline = false): string {
  return cleanPromptTextInfo(value, max, { multiline }).text;
}

export interface CleanedText {
  text: string;
  /** Cut at the character or line limit. */
  truncated: boolean;
  /**
   * Shown differently from what the agent sent: NFKC changed it, invisible, bidi or control
   * characters were removed, or (single line) line breaks, tabs or runs of spaces were collapsed.
   * Leading and trailing whitespace does not count.
   */
  altered: boolean;
}

export function cleanPromptTextInfo(
  value: unknown,
  max: number,
  { multiline = false, maxLines = Number.POSITIVE_INFINITY }: { multiline?: boolean; maxLines?: number } = {},
): CleanedText {
  if (typeof value !== "string") return { text: "", truncated: false, altered: false };
  let altered = false;
  const step = (before: string, after: string) => {
    if (after !== before) altered = true;
    return after;
  };
  let text = value.trim().replace(/\r\n/g, "\n");
  text = step(text, text.normalize("NFKC"));
  text = step(text, text.replace(INVISIBLE, ""));
  if (multiline) {
    text = step(text, text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, " "));
    text = step(text, text.replace(/\n{3,}/g, "\n\n"));
  } else {
    text = step(text, text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " "));
    text = step(text, text.replace(/\s{2,}/g, " "));
  }
  text = text.trim();
  let truncated = false;
  if (multiline) {
    const lines = text.split("\n");
    if (lines.length > maxLines) {
      text = `${lines.slice(0, maxLines).join("\n")}\n…`;
      truncated = true;
    }
  }
  if (text.length > max) {
    text = `${text.slice(0, max - 1)}…`;
    truncated = true;
  }
  return { text, truncated, altered };
}

export interface PromptOption {
  label: string;
  description: string;
}

export interface PromptQuestion {
  /** Full question text: the key Paseo's Claude provider expects in `answers`. */
  key: string;
  text: string;
  header: string;
  options: PromptOption[];
  multiSelect: boolean;
  /** A free-text answer is possible; the card offers "Open run" for it. */
  allowOther: boolean;
}

export interface PromptAction {
  id: string | null;
  label: string;
  behavior: "allow" | "deny";
}

export interface SummaryLine {
  label: string;
  value: string;
  /** Shown as a scrollable monospace block (commands, scripts) rather than on one line. */
  block: boolean;
  /** Typed text: shown as "•••• (N chars)" until the owner reveals it. */
  masked?: boolean;
}

export type OwnerPrompt =
  | { kind: "question"; requestId: string; questions: PromptQuestion[] }
  | {
      kind: "permission";
      requestId: string;
      title: string;
      description: string;
      /** What the request would do, from its known fields (Claude sends no title or description). */
      summary: SummaryLine[];
      /** ExitPlanMode's plan text. */
      plan: string;
      /** Allow is offered only when the card can show what would be allowed. */
      canAllow: boolean;
      actions: PromptAction[];
    };

type RequestLike = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  input?: unknown;
  detail?: unknown;
  metadata?: unknown;
  actions?: unknown;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function toQuestions(input: unknown): PromptQuestion[] {
  const list = record(input)?.questions;
  if (!Array.isArray(list)) return [];
  const questions: PromptQuestion[] = [];
  for (const raw of list.slice(0, MAX_QUESTIONS)) {
    const item = record(raw);
    const key = typeof item?.question === "string" ? item.question : "";
    if (!item || !key.trim()) continue;
    const options = Array.isArray(item.options)
      ? item.options
          .map((option) => record(option))
          .filter((option): option is Record<string, unknown> => !!option && typeof option.label === "string" && !!option.label.trim())
          .slice(0, MAX_OPTIONS)
          .map((option) => ({
            label: cleanPromptText(option.label, MAX_OPTION_LABEL),
            description: cleanPromptText(option.description, MAX_OPTION_DESCRIPTION),
          }))
      : [];
    questions.push({
      key,
      text: cleanPromptText(key, MAX_QUESTION_TEXT, true),
      header: cleanPromptText(item.header, MAX_OPTION_LABEL),
      options,
      multiSelect: item.multiSelect === true,
      allowOther: item.allowOther !== false,
    });
  }
  return questions;
}

/** `mcp__paseo__browser_fill` -> "Browser fill"; `Bash` stays "Bash". */
export function humanizeToolName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) return "";
  const bare = name.trim().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  const words = bare.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return cleanPromptText(words.charAt(0).toUpperCase() + words.slice(1), MAX_OPTION_LABEL);
}

interface FieldSpec {
  field: string;
  label: string;
  block?: boolean;
  max?: number;
  /** Masked when it is text the tool types into a page. */
  mask?: (tool: string, value: string) => boolean;
}

const TYPED_TEXT_TOOL = /(^|__)browser_(fill|type)$/;
const KEYPRESS_TOOL = /(^|__)browser_keypress$/;
/** One key, optionally with modifiers: a single character or a named key such as Enter, ArrowDown, F5, KeyA. */
const KEY_NAME =
  /^(?:(?:Control|Shift|Alt|Meta|ControlOrMeta)\+)*(?:[^\s]|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-9]|2[0-4])|Space|Control|Shift|Alt|Meta|ControlOrMeta|CapsLock|NumLock|ScrollLock|ContextMenu|Pause|PrintScreen|Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Minus|Equal|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote|BracketLeft|BracketRight)$/u;
const typedText = (tool: string) => TYPED_TEXT_TOOL.test(tool);
/** browser_keypress with more than a single key name (typed characters) is masked like typed text. */
const typedKeys = (tool: string, value: string) => KEYPRESS_TOOL.test(tool) && !KEY_NAME.test(value);

/** Every input field the card can show, in display order. */
const SUMMARY_FIELDS: FieldSpec[] = [
  { field: "command", label: "Command", block: true },
  { field: "url", label: "URL" },
  { field: "ref", label: "Element", max: 200 },
  { field: "sourceRef", label: "From element", max: 200 },
  { field: "targetRef", label: "To element", max: 200 },
  { field: "selector", label: "Element", max: 200 },
  { field: "value", label: "Value", mask: typedText },
  { field: "text", label: "Text", mask: typedText },
  { field: "key", label: "Key", max: 100, mask: typedKeys },
  { field: "button", label: "Button", max: 50 },
  { field: "doubleClick", label: "Double click", max: 10 },
  { field: "modifiers", label: "Modifiers", max: 100 },
  { field: "filePaths", label: "Files" },
  { field: "file_path", label: "File" },
  { field: "filePath", label: "File" },
  { field: "path", label: "Path" },
  { field: "function", label: "Script", block: true },
  { field: "pattern", label: "Search", max: 500 },
  { field: "query", label: "Search", max: 500 },
  { field: "description", label: "Purpose", max: 500 },
  { field: "timeout", label: "Timeout", max: 50 },
  { field: "timeoutMs", label: "Timeout (ms)", max: 50 },
  { field: "fullPage", label: "Full page", max: 10 },
];
const RENDERED_FIELDS = new Set([...SUMMARY_FIELDS.map((spec) => spec.field), "deltaX", "deltaY"]);
/** Input fields hidden on purpose because they do not change what is allowed. */
const HIDDEN_FIELDS = new Set(["browserId"]);

/** A field's text, "" when empty, or null when it cannot be shown as text (objects, mixed arrays). */
function fieldText(value: unknown): string | null {
  if (value === undefined || value === null || value === false) return "";
  if (value === true) return "yes";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)))) return null;
    return value.join(", ");
  }
  return null;
}

export interface PermissionDetails {
  lines: SummaryLine[];
  /**
   * Every non-empty input field is shown, nothing was cut or altered: only then does the card
   * offer Allow.
   */
  complete: boolean;
}

/**
 * What a permission request would do, as plain text, from the request's input and the tool-call
 * detail Paseo attaches (for example a shell command). The tool name comes first. A field that is
 * cut, altered for display, or cannot be shown at all makes the details incomplete.
 */
export function permissionDetails(request: RequestLike): PermissionDetails {
  const lines: SummaryLine[] = [];
  let complete = true;
  const tool = humanizeToolName(request.name);
  if (tool) lines.push({ label: "Tool", value: tool, block: false });
  const name = typeof request.name === "string" ? request.name : "";
  const input = record(request.input) ?? {};
  const detail = record(request.detail) ?? {};
  for (const key of Object.keys(input)) {
    if (RENDERED_FIELDS.has(key) || HIDDEN_FIELDS.has(key)) continue;
    const text = fieldText(input[key]);
    if (text === null || text !== "" || (Array.isArray(input[key]) && (input[key] as unknown[]).length > 0)) complete = false;
  }
  for (const spec of SUMMARY_FIELDS) {
    let raw = fieldText(input[spec.field]);
    if (raw === "") raw = fieldText(detail[spec.field]);
    if (raw === null) {
      complete = false;
      continue;
    }
    if (!raw.trim()) continue;
    const cleaned = cleanPromptTextInfo(raw, spec.max ?? (spec.block ? MAX_SUMMARY_BLOCK : MAX_SUMMARY_VALUE), {
      multiline: !!spec.block,
      maxLines: MAX_SUMMARY_BLOCK_LINES,
    });
    if (cleaned.truncated || cleaned.altered) complete = false;
    if (lines.some((line) => line.label === spec.label && line.value === cleaned.text)) continue;
    const masked = !!spec.mask && spec.mask(name, cleaned.text);
    lines.push({ label: spec.label, value: cleaned.text, block: !!spec.block, ...(masked ? { masked: true } : {}) });
  }
  const dx = input.deltaX;
  const dy = input.deltaY;
  for (const delta of [dx, dy]) if (delta !== undefined && !(typeof delta === "number" && Number.isFinite(delta))) complete = false;
  if (typeof dx === "number" || typeof dy === "number") {
    lines.push({ label: "Scroll", value: `${typeof dx === "number" ? dx : 0}, ${typeof dy === "number" ? dy : 0}`, block: false });
  }
  if (lines.length > MAX_SUMMARY_LINES) complete = false;
  return { lines: lines.slice(0, MAX_SUMMARY_LINES), complete };
}

/** The lines of `permissionDetails`. */
export function permissionSummary(request: RequestLike): SummaryLine[] {
  return permissionDetails(request).lines;
}

function toActions(actions: unknown, labelMax = MAX_OPTION_LABEL): PromptAction[] {
  const parsed = Array.isArray(actions)
    ? actions
        .map((action) => record(action))
        .filter((action): action is Record<string, unknown> => !!action && (action.behavior === "allow" || action.behavior === "deny"))
        .slice(0, MAX_ACTIONS)
        .map((action) => ({
          id: typeof action.id === "string" ? action.id : null,
          label: cleanPromptText(action.label, labelMax) || (action.behavior === "allow" ? "Allow" : "Deny"),
          behavior: action.behavior as "allow" | "deny",
        }))
    : [];
  return parsed.length
    ? parsed
    : [
        { id: null, label: "Allow", behavior: "allow" },
        { id: null, label: "Deny", behavior: "deny" },
      ];
}

/**
 * The run's pending requests as card prompts. Questions (AskUserQuestion, `kind: "question"`) get
 * their questions and options; everything else becomes a permission with its actions (or Allow /
 * Deny). Requests without an id, and questions without a usable question, are left to the run view.
 */
export function ownerPrompts(requests: readonly RequestLike[] | null | undefined): OwnerPrompt[] {
  const prompts: OwnerPrompt[] = [];
  for (const request of requests ?? []) {
    const requestId = typeof request.id === "string" ? request.id : "";
    if (!requestId) continue;
    if (request.kind === "question") {
      const questions = toQuestions(request.input);
      if (questions.length) prompts.push({ kind: "question", requestId, questions });
      continue;
    }
    const isPlan = request.kind === "plan";
    const metadata = record(request.metadata) ?? {};
    const planInfo = isPlan
      ? cleanPromptTextInfo(
          (typeof metadata.planText === "string" && metadata.planText) || (fieldText(record(request.input)?.plan) ?? ""),
          MAX_PLAN_TEXT,
          { multiline: true },
        )
      : { text: "", truncated: false, altered: false };
    const plan = planInfo.text;
    const titleInfo = cleanPromptTextInfo(request.title, MAX_OPTION_LABEL);
    const descriptionInfo = cleanPromptTextInfo(request.description, MAX_QUESTION_TEXT, { multiline: true });
    const title = titleInfo.text;
    const description = descriptionInfo.text;
    const details = isPlan ? { lines: [], complete: true } : permissionDetails(request);
    const summary = details.lines;
    const providerTextIntact = !titleInfo.truncated && !titleInfo.altered && !descriptionInfo.truncated && !descriptionInfo.altered;
    // Allow only when the card shows everything it would allow: the whole, unaltered plan, or every
    // input field in full and unaltered plus something to judge (a title, a description or at least
    // one field beyond the tool name). Otherwise only Deny and Open run.
    const canAllow = isPlan
      ? !!plan && !planInfo.truncated && !planInfo.altered
      : details.complete && providerTextIntact && (!!title || !!description || summary.some((line) => line.label !== "Tool"));
    const actions = toActions(request.actions, isPlan ? MAX_PLAN_ACTION_LABEL : MAX_OPTION_LABEL);
    const shown = canAllow ? actions : actions.filter((action) => action.behavior === "deny");
    prompts.push({
      kind: "permission",
      requestId,
      title: title || (isPlan ? "Plan" : humanizeToolName(request.name)) || "Permission request",
      description,
      summary,
      plan,
      canAllow,
      actions: shown.length ? shown : [{ id: null, label: "Deny", behavior: "deny" }],
    });
  }
  return prompts;
}

/** The owner's selections per question: question index -> chosen option labels. */
export type Selections = Record<number, string[]>;

/**
 * Answer buttons are shown only for a run this card started: the same snapshot the requests came
 * from must carry the browser-prompt run label, this card's chat as source and this card's id.
 */
export function verifiedRun(
  labels: Record<string, unknown> | null | undefined,
  sourceAgentId: string,
  cardId: string,
): boolean {
  return isBrowserRun(labels) && labels![SOURCE_LABEL] === sourceAgentId && labels![CARD_LABEL] === cardId;
}

/** Applies a click on an option: single choice replaces, multiple choice toggles. */
export function selectOption(
  prompt: Extract<OwnerPrompt, { kind: "question" }>,
  selections: Selections,
  question: number,
  label: string,
): Selections {
  const target = prompt.questions[question];
  if (!target || !target.options.some((option) => option.label === label)) return selections;
  const current = selections[question] ?? [];
  const next = target.multiSelect
    ? current.includes(label)
      ? current.filter((value) => value !== label)
      : [...current, label]
    : [label];
  return { ...selections, [question]: next };
}

/** Every question has at least one chosen option. */
export function isComplete(prompt: Extract<OwnerPrompt, { kind: "question" }>, selections: Selections): boolean {
  return prompt.questions.every((_, index) => (selections[index] ?? []).length > 0);
}

export type PermissionResponse =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; selectedActionId?: string; message?: string };

/**
 * The answer to a question, as Paseo's Claude provider expects it: `answers` keyed by each question's
 * full text, several choices joined with ", ". Null until every question has a choice.
 */
export function questionResponse(prompt: Extract<OwnerPrompt, { kind: "question" }>, selections: Selections): PermissionResponse | null {
  if (!isComplete(prompt, selections)) return null;
  const answers: Record<string, string> = {};
  prompt.questions.forEach((question, index) => {
    answers[question.key] = (selections[index] ?? []).join(", ");
  });
  return { behavior: "allow", updatedInput: { answers } };
}

/** The response for a permission action the owner pressed. */
export function permissionResponse(action: PromptAction): PermissionResponse {
  if (action.behavior === "allow") return action.id ? { behavior: "allow", selectedActionId: action.id } : { behavior: "allow" };
  return action.id
    ? { behavior: "deny", selectedActionId: action.id, message: "The owner declined on the card." }
    : { behavior: "deny", message: "The owner declined on the card." };
}
