// Pure logic for step progress on the card: counting a card's steps and reading the run's
// `[browser-prompt step N/M] text` markers. Imports only pure shared modules so tests can load it.
import { MAX_STEP_TEXT } from "./agent-prompt.ts";

const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+\S/;

/**
 * Steps on a card: its numbered lines (`1.`, `2)` …, indented sub-items excluded), else its
 * non-empty lines. At least 1 for any text.
 */
export function countSteps(text: string): number {
  const lines = text.split(/\r?\n/);
  const numbered = lines.filter((line) => NUMBERED.test(line)).length;
  if (numbered > 0) return numbered;
  return Math.max(1, lines.filter((line) => line.trim()).length);
}

/** One marker line; N and M must be whole numbers, the text is optional. */
const MARKER = /^[ \t]*\[browser-prompt step (\d{1,4})\/(\d{1,4})\][ \t]*(.*)$/gm;
const INVISIBLE = /[­؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/** Step text for display: normalized, no controls or invisible characters, one line, capped. */
export function cleanStepText(text: string, max = MAX_STEP_TEXT): string {
  const line = text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface StepProgress {
  step: number;
  total: number;
  text: string;
}

/**
 * The last well-formed step marker in `text`, with N clamped to 1..total. The card's own step
 * count is the total; the M the run wrote is ignored. Malformed markers are skipped.
 */
export function latestStep(text: string, total: number): StepProgress | null {
  if (!(total >= 1)) return null;
  let last: RegExpExecArray | null = null;
  MARKER.lastIndex = 0;
  for (let match = MARKER.exec(text); match; match = MARKER.exec(text)) last = match;
  if (!last) return null;
  const step = Math.min(total, Math.max(1, Number(last[1])));
  return { step, total, text: cleanStepText(last[3] ?? "") };
}

/** Removes leading step marker lines, so a question or report after them is read as such. */
export function stripLeadingStepMarkers(text: string): string {
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && (/^\s*\[browser-prompt step \d{1,4}\/\d{1,4}\]/.test(lines[index]!) || (!lines[index]!.trim() && index < lines.length - 1))) index++;
  return lines.slice(index).join("\n");
}
