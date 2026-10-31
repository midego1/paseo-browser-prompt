// What the card shows for step progress, from the latest marker and the run's state. Pure, so the
// rules (done = full bar, failed and needs-you keep the last step) are tested without React.
import type { StepProgress } from "./steps.ts";

type RunStateLike = "starting" | "running" | "needs-input" | "asking" | "done" | "failed" | "stopped" | "unknown";

export interface StepView {
  label: string;
  step: number;
  fraction: number;
  tone: "accent" | "success" | "warning" | "danger";
}

export function stepProgressView(progress: StepProgress | null, total: number, state: RunStateLike): StepView | null {
  if (!(total >= 1)) return null;
  const of = (step: number) => `Step ${step} of ${total}`;
  if (state === "done") return { label: `${of(total)} · done ✓`, step: total, fraction: 1, tone: "success" };
  if (!progress) {
    if (state === "failed") return { label: `${total} step${total === 1 ? "" : "s"} · failed`, step: 0, fraction: 0, tone: "danger" };
    if (state === "starting" || state === "running" || state === "needs-input" || state === "asking") {
      return { label: `Starting · ${total} step${total === 1 ? "" : "s"}`, step: 0, fraction: 0, tone: "accent" };
    }
    return null;
  }
  const step = Math.min(total, Math.max(1, progress.step));
  const fraction = step / total;
  if (state === "failed") return { label: `${of(step)} · failed`, step, fraction, tone: "danger" };
  if (state === "needs-input") return { label: `${of(step)} · needs you`, step, fraction, tone: "warning" };
  if (state === "asking") return { label: `${of(step)} · asking the chat`, step, fraction, tone: "warning" };
  if (state === "stopped") return { label: `${of(step)} · stopped`, step, fraction, tone: "warning" };
  return { label: progress.text ? `${of(step)} · ${progress.text}` : of(step), step, fraction, tone: "accent" };
}
