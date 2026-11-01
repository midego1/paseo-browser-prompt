import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const lockInput = z.object({
  sourceAgentId: z.string().min(1).max(200),
  key: z.string().min(1).max(100),
  length: z.number().int().nonnegative(),
  check: z.string().min(1).max(32),
});

/** Takes the daemon's in-flight lock for a block's run (see shared/run-lock.ts) before starting it. */
export const acquireRunLock = defineRpc({
  name: "run.lock",
  /** `endedRunId`: the run this card shows has ended; a lock naming only that run does not hold. */
  input: lockInput.extend({ endedRunId: z.string().min(1).max(200).optional() }),
  output: z.union([
    z.object({ ok: z.literal(true), token: z.string() }),
    z.object({ ok: z.literal(false), agentId: z.string().nullable() }),
  ]),
});

/** Hands the lock back: with `agentId` the run started (held briefly, naming it), without it the start failed. */
export const finishRunLock = defineRpc({
  name: "run.unlock",
  input: lockInput.extend({ token: z.string().min(1).max(100), agentId: z.string().min(1).max(200).optional() }),
  output: z.object({ ok: z.boolean() }),
});
