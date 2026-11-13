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

/**
 * Characters that show as nothing or change how text around them looks: every default-ignorable code
 * point and format character (zero-width, joiners, bidi controls, variation selectors, tag characters
 * U+E0000-E007F, Hangul fillers, musical and shorthand format controls) plus the Braille blank.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/gu;
/** Space and line separators other than the plain space (no-break, Ogham, U+2028, U+2029): shown as a space. */
const ODD_SPACE = /(?! )[\p{Zs}\p{Zl}\p{Zp}]/gu;

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
  text = step(text, text.replace(ODD_SPACE, " "));
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
  /** The option's label exactly as the agent sent it: what the answer carries. */
  value: string;
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
  | {
      kind: "question";
      requestId: string;
      questions: PromptQuestion[];
      /**
       * Every question, header, option and description is shown in full and unaltered, within the
       * caps. Otherwise the card offers only "Open run": an answer must not pick an option the owner
       * could not read, or leave out a question that is not shown.
       */
      answerable: boolean;
    }
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

export type RequestLike = {
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
const present = (value: unknown) => value !== undefined && value !== null;

function toQuestions(input: unknown): { questions: PromptQuestion[]; intact: boolean } {
  const list = record(input)?.questions;
  if (!Array.isArray(list)) return { questions: [], intact: false };
  let intact = list.length <= MAX_QUESTIONS;
  // Cleans one text for display and notes when it is not shown exactly.
  const shown = (value: unknown, max: number, multiline = false) => {
    const info = cleanPromptTextInfo(value, max, { multiline });
    if (info.truncated || info.altered || (present(value) && typeof value !== "string")) intact = false;
    return info.text;
  };
  const questions: PromptQuestion[] = [];
  for (const raw of list.slice(0, MAX_QUESTIONS)) {
    const item = record(raw);
    const key = typeof item?.question === "string" ? item.question : "";
    if (!item || !key.trim()) {
      intact = false;
      continue;
    }
    if (present(item.options) && !Array.isArray(item.options)) intact = false;
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    if (rawOptions.length > MAX_OPTIONS) intact = false;
    const options = rawOptions
      .map((option) => record(option))
      .filter((option): option is Record<string, unknown> => {
        const usable = !!option && typeof option.label === "string" && !!option.label.trim();
        if (!usable) intact = false;
        return usable;
      })
      .slice(0, MAX_OPTIONS)
      .map((option) => ({
        label: shown(option.label, MAX_OPTION_LABEL),
        description: shown(option.description, MAX_OPTION_DESCRIPTION),
        value: option.label as string,
      }));
    questions.push({
      key,
      text: shown(key, MAX_QUESTION_TEXT, true),
      header: shown(item.header, MAX_OPTION_LABEL),
      options,
      multiSelect: item.multiSelect === true,
      allowOther: item.allowOther !== false,
    });
  }
  return { questions, intact };
}

/** `mcp__paseo__browser_fill` -> "Browser fill"; `Bash` stays "Bash". */
export function humanizeToolName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) return "";
  const bare = name.trim().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  const words = bare.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return cleanPromptText(words.charAt(0).toUpperCase() + words.slice(1), MAX_OPTION_LABEL);
}

/** Tool names are shown exactly, up to this length. */
export const MAX_TOOL_NAME = 200;

interface FieldSpec {
  field: string;
  label: string;
  block?: boolean;
  /** A list shown one item per line (as a block), so an item with ", " in it cannot pass for two. */
  list?: boolean;
  max?: number;
  /** Masked when it is text the tool types into a page. */
  mask?: (tool: string, value: string) => boolean;
}

const TYPED_TEXT_TOOL = /(^|__)browser_(fill|type)$|^mcp__claude-in-chrome__(form_input|computer)$/;
const CHROME_FORM_TOOL = /^mcp__claude-in-chrome__form_input$/;
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
  { field: "action", label: "Action", max: 100 },
  { field: "tabId", label: "Tab", max: 50 },
  { field: "coordinate", label: "Position", max: 50 },
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
  { field: "filePaths", label: "Files", block: true, list: true },
  { field: "file_path", label: "File" },
  { field: "filePath", label: "File" },
  { field: "path", label: "Path" },
  { field: "cwd", label: "Directory" },
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
/** Detail fields the summary can show: the ones read from `detail` when the input lacks them. */
const DETAIL_FIELDS = new Set(SUMMARY_FIELDS.map((spec) => spec.field));
/** Detail fields that only name the tool again (Paseo's search detail), not an argument. */
const DETAIL_NAME_FIELDS: Record<string, string> = { search: "toolName" };

/** A field's text, "" when empty, or null when it cannot be shown as text (objects, mixed arrays). */
function fieldText(value: unknown, separator = ", "): string | null {
  if (value === undefined || value === null || value === false) return "";
  if (value === true) return "yes";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)))) return null;
    return value.join(separator);
  }
  return null;
}

/** No value worth showing: empty text, false, null, or an empty list. */
const isEmpty = (value: unknown) => fieldText(value) === "" && !(Array.isArray(value) && value.length > 0);
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

export interface PermissionDetails {
  lines: SummaryLine[];
  /**
   * Every non-empty input and detail field is shown, nothing was cut or altered: only then does the
   * card offer Allow.
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
  // The exact tool name, not the friendly one (the card's title): mcp__evil__browser_navigate and
  // browser_navigate both read "Browser navigate".
  const name = typeof request.name === "string" ? request.name : "";
  const tool = cleanPromptTextInfo(request.name, MAX_TOOL_NAME);
  if (tool.text) lines.push({ label: "Tool", value: tool.text, block: false });
  if (tool.truncated || tool.altered || name !== name.trim() || (present(request.name) && typeof request.name !== "string")) complete = false;
  // An input, detail or metadata that is there but not an object cannot be shown.
  for (const value of [request.input, request.detail, request.metadata]) if (present(value) && !record(value)) complete = false;
  const input = record(request.input) ?? {};
  const detail = record(request.detail) ?? {};
  for (const key of Object.keys(input)) {
    if (RENDERED_FIELDS.has(key) || HIDDEN_FIELDS.has(key)) continue;
    if (!isEmpty(input[key])) complete = false;
  }
  // Paseo's tool-call detail is derived from the input. Any other non-empty detail field, or a shown
  // field whose detail value differs from the input value that is shown instead, is not seen: incomplete.
  for (const key of Object.keys(detail)) {
    if (key === "type" || (typeof detail.type === "string" && DETAIL_NAME_FIELDS[detail.type] === key)) continue;
    const value = detail[key];
    const text = fieldText(value);
    if (isEmpty(value)) continue;
    if (text === null || !DETAIL_FIELDS.has(key)) {
      complete = false;
      continue;
    }
    const shown = fieldText(input[key]);
    if (shown && shown !== text) complete = false;
  }
  for (const spec of SUMMARY_FIELDS) {
    const separator = spec.list ? "\n" : ", ";
    let value = input[spec.field];
    let raw = fieldText(value, separator);
    if (raw === "") {
      value = detail[spec.field];
      raw = fieldText(value, separator);
    }
    if (raw === null) {
      complete = false;
      continue;
    }
    if (!raw.trim()) continue;
    // One item per line: an item with a line break of its own would pass for two.
    if (spec.list && (Array.isArray(value) ? value : [value]).some((item) => LINE_BREAK.test(String(item)))) complete = false;
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
  // Unchecking a box or clearing a field has no value line to show: no Allow without seeing it.
  if (CHROME_FORM_TOOL.test(name) && "value" in input && (fieldText(input.value) ?? "x").trim() === "") complete = false;
  if (lines.length > MAX_SUMMARY_LINES) complete = false;
  return { lines: lines.slice(0, MAX_SUMMARY_LINES), complete };
}

/**
 * Plan metadata the providers set (Paseo server 0.15.4): Claude's ExitPlanMode sends `planText` (shown)
 * and `toolUseId` (the tool call's id); Codex's plan approval sends `planText` and `source:
 * "codex_plan_approval"`. Each value must be exactly this kind: none of them names anything to allow.
 */
const PLAN_METADATA: Record<string, (value: unknown) => boolean> = {
  planText: (value) => typeof value === "string",
  toolUseId: (value) => typeof value === "string",
  source: (value) => value === "codex_plan_approval",
};

export interface PlanDetails extends PermissionDetails {
  /** The plan text as shown. */
  plan: CleanedText;
}

/**
 * What an ExitPlanMode request would allow: the plan text (Paseo's `metadata.planText`, else
 * `input.plan`) and the prompts it asks to allow for the implementation (`input.allowedPrompts`,
 * shown one per line as "Also allows"). Any other non-empty input, detail or metadata field, an input
 * plan that differs from the shown text, or a prompt that cannot be shown exactly is not seen:
 * incomplete. The plan text's own cut or change is in `plan`.
 */
export function planDetails(request: RequestLike): PlanDetails {
  const lines: SummaryLine[] = [];
  let complete = true;
  for (const value of [request.input, request.detail, request.metadata]) if (present(value) && !record(value)) complete = false;
  const input = record(request.input) ?? {};
  const detail = record(request.detail) ?? {};
  const metadata = record(request.metadata) ?? {};
  const planText = typeof metadata.planText === "string" ? metadata.planText : "";
  const inputPlan = fieldText(input.plan);
  if (inputPlan === null || (present(metadata.planText) && typeof metadata.planText !== "string")) complete = false;
  if (planText && inputPlan && inputPlan !== planText) complete = false;
  const shownPlan = planText || inputPlan || "";
  const plan = cleanPromptTextInfo(shownPlan, MAX_PLAN_TEXT, { multiline: true });
  for (const key of Object.keys(metadata)) {
    if (isEmpty(metadata[key])) continue;
    if (!Object.prototype.hasOwnProperty.call(PLAN_METADATA, key) || !PLAN_METADATA[key](metadata[key])) complete = false;
  }
  // A plan detail (protocol type `{ type: "plan", text }`; today's providers send none for the
  // request) may only repeat the plan shown. Any other field, or other text, is not seen.
  for (const key of Object.keys(detail)) {
    if (key === "type" || isEmpty(detail[key])) continue;
    if (key !== "text" || detail.text !== shownPlan) complete = false;
  }
  for (const key of Object.keys(input)) {
    if (key === "plan") continue;
    if (key !== "allowedPrompts") {
      if (!isEmpty(input[key])) complete = false;
      continue;
    }
    const prompts = input.allowedPrompts;
    if (!Array.isArray(prompts)) {
      if (!isEmpty(prompts)) complete = false;
      continue;
    }
    for (const raw of prompts) {
      const item = record(raw);
      if (!item || typeof item.tool !== "string" || typeof item.prompt !== "string" || Object.keys(item).some((field) => field !== "tool" && field !== "prompt")) {
        complete = false;
        continue;
      }
      const tool = cleanPromptTextInfo(item.tool, MAX_TOOL_NAME);
      const text = cleanPromptTextInfo(item.prompt, MAX_SUMMARY_VALUE);
      if (!tool.text || !text.text || tool.truncated || tool.altered || text.truncated || text.altered) complete = false;
      lines.push({ label: "Also allows", value: `${tool.text}: ${text.text}`, block: false });
    }
  }
  if (lines.length > MAX_SUMMARY_LINES) complete = false;
  return { lines: lines.slice(0, MAX_SUMMARY_LINES), complete, plan };
}

/** The lines of `permissionDetails`. */
export function permissionSummary(request: RequestLike): SummaryLine[] {
  return permissionDetails(request).lines;
}

interface ParsedAction extends PromptAction {
  /**
   * The label is shown exactly as sent: not cut, not altered, and present when the action has its
   * own id. An Allow action grants what its id means ("Always allow Bash(git push --force:*)"), so
   * one whose label is not shown in full is never offered.
   */
  intact: boolean;
}

function toActions(actions: unknown, labelMax = MAX_OPTION_LABEL): ParsedAction[] {
  const parsed = Array.isArray(actions)
    ? actions
        .map((action) => record(action))
        .filter((action): action is Record<string, unknown> => !!action && (action.behavior === "allow" || action.behavior === "deny"))
        .slice(0, MAX_ACTIONS)
        .map((action) => {
          const id = typeof action.id === "string" ? action.id : null;
          const info = cleanPromptTextInfo(action.label, labelMax);
          return {
            id,
            label: info.text || (action.behavior === "allow" ? "Allow" : "Deny"),
            behavior: action.behavior as "allow" | "deny",
            intact: !info.truncated && !info.altered && (!!info.text || id === null),
          };
        })
    : [];
  return parsed.length
    ? parsed
    : [
        { id: null, label: "Allow", behavior: "allow", intact: true },
        { id: null, label: "Deny", behavior: "deny", intact: true },
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
      const { questions, intact } = toQuestions(request.input);
      if (questions.length) prompts.push({ kind: "question", requestId, questions, answerable: intact });
      continue;
    }
    const isPlan = request.kind === "plan";
    const planned = isPlan ? planDetails(request) : null;
    const planInfo = planned?.plan ?? { text: "", truncated: false, altered: false };
    const plan = planInfo.text;
    const titleInfo = cleanPromptTextInfo(request.title, MAX_OPTION_LABEL);
    const descriptionInfo = cleanPromptTextInfo(request.description, MAX_QUESTION_TEXT, { multiline: true });
    const title = titleInfo.text;
    const description = descriptionInfo.text;
    const details = planned ?? permissionDetails(request);
    const summary = details.lines;
    const providerTextIntact = !titleInfo.truncated && !titleInfo.altered && !descriptionInfo.truncated && !descriptionInfo.altered;
    // Allow only when the card shows everything it would allow: the whole, unaltered plan and every
    // prompt it allows, or every input field in full and unaltered plus something to judge (a title,
    // a description or at least one field beyond the tool name). Otherwise only Deny and Open run.
    const contentShown = isPlan
      ? !!plan && !planInfo.truncated && !planInfo.altered && details.complete
      : details.complete && providerTextIntact && (!!title || !!description || summary.some((line) => line.label !== "Tool"));
    const actions = toActions(request.actions, isPlan ? MAX_PLAN_ACTION_LABEL : MAX_OPTION_LABEL);
    // Allow actions whose label is not shown exactly are dropped; none left means Deny only.
    const canAllow = contentShown && actions.some((action) => action.behavior === "allow" && action.intact);
    const shown = actions
      .filter((action) => action.behavior === "deny" || (canAllow && action.intact))
      .map(({ intact: _intact, ...action }) => action);
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
  if (!prompt.answerable || !isComplete(prompt, selections)) return null;
  const answers: Record<string, string> = {};
  prompt.questions.forEach((question, index) => {
    // The labels as the agent sent them (the shown ones are equal up to surrounding spaces).
    const chosen = (selections[index] ?? []).map((label) => question.options.find((option) => option.label === label)?.value ?? label);
    answers[question.key] = chosen.join(", ");
  });
  return { behavior: "allow", updatedInput: { answers } };
}

/**
 * The answer may still be sent: checked against the prompts from a fresh read of the run right before
 * sending. The request must still be pending with the same kind; an Allow (or a deny with its own
 * action id) must be one of the actions the card offers for it now, so an action that is no longer
 * shown in full is never granted.
 */
export function responseOffered(prompts: readonly OwnerPrompt[], requestId: string, response: PermissionResponse): boolean {
  const prompt = prompts.find((candidate) => candidate.requestId === requestId);
  if (!prompt) return false;
  if (prompt.kind === "question") {
    if (!prompt.answerable || response.behavior !== "allow" || response.selectedActionId) return false;
    const answers = record(response.updatedInput?.answers);
    const keys = prompt.questions.map((question) => question.key);
    return !!answers && Object.keys(answers).length === keys.length && keys.every((key) => typeof answers[key] === "string");
  }
  if (response.behavior === "allow" && (!prompt.canAllow || response.updatedInput)) return false;
  const id = response.selectedActionId ?? null;
  if (response.behavior === "deny" && id === null) return true;
  return prompt.actions.some((action) => action.behavior === response.behavior && action.id === id);
}

/**
 * Allow is pressable only once every masked line (typed text) is revealed: the owner allows what they
 * have read, not "•••• (N chars)". `revealed` holds the indexes of the summary lines shown.
 */
export function allowReady(prompt: Extract<OwnerPrompt, { kind: "permission" }>, revealed: readonly number[]): boolean {
  return prompt.canAllow && prompt.summary.every((line, index) => !line.masked || revealed.includes(index));
}

/** The run as `sendCheckedAnswer` needs it: a fresh read and the send, both supplied by the card. */
export interface AnswerTarget {
  /** Reads the run's snapshot again (the SDK's `refresh`). */
  read: () => Promise<
    { agent: { labels?: Record<string, unknown> | null; pendingPermissions?: readonly RequestLike[] | null } } | null | undefined
  >;
  /** Sends the answer (the SDK's respondToPermission). */
  send: (args: { requestId: string; response: PermissionResponse }) => Promise<unknown>;
}

export type CheckedAnswer = { sent: true } | { sent: false; prompts: OwnerPrompt[] };

/**
 * Sends the owner's answer only after reading the run again: the snapshot must still show this card's
 * run, the request must build exactly the prompt the owner saw (title, details, plan, actions), and the
 * response must be one it offers. Otherwise nothing is sent and the fresh prompts come back to show. A
 * failed read throws before anything is sent.
 */
export async function sendCheckedAnswer(
  target: AnswerTarget,
  card: { sourceAgentId: string; cardId: string },
  shown: OwnerPrompt,
  response: PermissionResponse,
): Promise<CheckedAnswer> {
  const result = await target.read();
  const prompts = result && verifiedRun(result.agent.labels, card.sourceAgentId, card.cardId) ? ownerPrompts(result.agent.pendingPermissions ?? []) : [];
  const fresh = prompts.find((prompt) => prompt.requestId === shown.requestId);
  if (!fresh || JSON.stringify(fresh) !== JSON.stringify(shown) || !responseOffered(prompts, shown.requestId, response)) {
    return { sent: false, prompts };
  }
  await target.send({ requestId: shown.requestId, response });
  return { sent: true };
}

/** The response for a permission action the owner pressed. */
export function permissionResponse(action: PromptAction): PermissionResponse {
  if (action.behavior === "allow") return action.id ? { behavior: "allow", selectedActionId: action.id } : { behavior: "allow" };
  return action.id
    ? { behavior: "deny", selectedActionId: action.id, message: "The owner declined on the card." }
    : { behavior: "deny", message: "The owner declined on the card." };
}
