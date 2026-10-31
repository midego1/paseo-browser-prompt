// Pure logic for answering a run's pending question or permission request from the card. The
// requests come from the run agent's own snapshot (SDK `refresh().pendingPermissions`) and are
// answered with the SDK's `respondToPermission`, only when the owner clicks on the card. Nothing here
// talks to the chat or answers on its own. Import-free so tests can load it directly.

export const MAX_QUESTION_TEXT = 500;
export const MAX_OPTION_LABEL = 80;
export const MAX_OPTION_DESCRIPTION = 160;
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 8;
export const MAX_ACTIONS = 4;

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

export type OwnerPrompt =
  | { kind: "question"; requestId: string; questions: PromptQuestion[] }
  | { kind: "permission"; requestId: string; title: string; description: string; actions: PromptAction[] };

type RequestLike = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  input?: unknown;
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

function toActions(actions: unknown): PromptAction[] {
  const parsed = Array.isArray(actions)
    ? actions
        .map((action) => record(action))
        .filter((action): action is Record<string, unknown> => !!action && (action.behavior === "allow" || action.behavior === "deny"))
        .slice(0, MAX_ACTIONS)
        .map((action) => ({
          id: typeof action.id === "string" ? action.id : null,
          label: cleanPromptText(action.label, MAX_OPTION_LABEL) || (action.behavior === "allow" ? "Allow" : "Deny"),
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
    prompts.push({
      kind: "permission",
      requestId,
      title: cleanPromptText(request.title, MAX_OPTION_LABEL) || cleanPromptText(request.name, MAX_OPTION_LABEL) || "Permission request",
      description: cleanPromptText(request.description, MAX_QUESTION_TEXT, true),
      actions: toActions(request.actions),
    });
  }
  return prompts;
}

/** The owner's selections per question: question index -> chosen option labels. */
export type Selections = Record<number, string[]>;

/** One question with single choice and options: a click answers it at once, no Send button. */
export function answersOnClick(prompt: Extract<OwnerPrompt, { kind: "question" }>): boolean {
  return prompt.questions.length === 1 && !prompt.questions[0]!.multiSelect && prompt.questions[0]!.options.length > 0;
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
