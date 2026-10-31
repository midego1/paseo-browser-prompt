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
export const MAX_SUMMARY_VALUE = 200;
export const MAX_SUMMARY_BLOCK = 400;
export const MAX_PLAN_TEXT = 1500;
/** Plan actions ("Implement with Auto mode") are shown in full, up to this length. */
export const MAX_PLAN_ACTION_LABEL = 200;

const INVISIBLE = /[­؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/**
 * Text from the run for display: NFKC-normalized, no invisible or control characters (newlines kept
 * when `multiline`), trimmed and capped. It is shown as plain React Native text.
 */
export function cleanPromptText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== "string") return "";
  let text = value.normalize("NFKC").replace(INVISIBLE, "");
  text = multiline
    ? text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ");
  text = text.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
  /** Shown as a block (commands, scripts) rather than on one line. */
  block: boolean;
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

/** Known request fields, in display order: [field, label, shown as a block]. */
const SUMMARY_FIELDS: [string, string, boolean][] = [
  ["command", "Command", true],
  ["url", "URL", false],
  ["ref", "Element", false],
  ["sourceRef", "From element", false],
  ["targetRef", "To element", false],
  ["selector", "Element", false],
  ["value", "Value", false],
  ["text", "Text", false],
  ["key", "Key", false],
  ["filePaths", "Files", false],
  ["file_path", "File", false],
  ["filePath", "File", false],
  ["path", "Path", false],
  ["function", "Script", true],
  ["pattern", "Search", false],
  ["query", "Search", false],
  ["description", "Purpose", false],
];

function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return "";
}

/**
 * A bounded plain-text summary of what a permission request would do, from the request's input
 * and the tool-call detail Paseo attaches (for example a shell command). Only known fields, each
 * cleaned and capped; the tool name is always first.
 */
export function permissionSummary(request: RequestLike): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const tool = humanizeToolName(request.name);
  if (tool) lines.push({ label: "Tool", value: tool, block: false });
  const input = record(request.input) ?? {};
  const detail = record(request.detail) ?? {};
  const seen = new Set<string>();
  for (const [field, label, block] of SUMMARY_FIELDS) {
    const raw = fieldText(input[field]) || fieldText(detail[field]);
    const value = cleanPromptText(raw, block ? MAX_SUMMARY_BLOCK : MAX_SUMMARY_VALUE, block);
    if (!value || seen.has(`${label}:${value}`)) continue;
    seen.add(`${label}:${value}`);
    lines.push({ label, value, block });
  }
  const dx = input.deltaX;
  const dy = input.deltaY;
  if ((typeof dx === "number" && Number.isFinite(dx)) || (typeof dy === "number" && Number.isFinite(dy))) {
    lines.push({ label: "Scroll", value: `${typeof dx === "number" ? dx : 0}, ${typeof dy === "number" ? dy : 0}`, block: false });
  }
  return lines.slice(0, 8);
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
    const plan = isPlan
      ? cleanPromptText(fieldText(metadata.planText) || fieldText(record(request.input)?.plan), MAX_PLAN_TEXT, true)
      : "";
    const title = cleanPromptText(request.title, MAX_OPTION_LABEL);
    const description = cleanPromptText(request.description, MAX_QUESTION_TEXT, true);
    const summary = isPlan ? [] : permissionSummary(request);
    // Something the owner can judge: plan text, the provider's own title or description, or at least
    // one known field beyond the tool name. Without it the card offers only Deny and Open run.
    const canAllow = isPlan ? !!plan : !!title || !!description || summary.some((line) => line.label !== "Tool");
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
