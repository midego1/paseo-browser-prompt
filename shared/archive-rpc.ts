import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Whether the plugin archived this run after it succeeded, so its card shows done, not stopped. */
export const archivedAfterSuccess = defineRpc({
  name: "run.archivedAfterSuccess",
  input: z.object({ agentId: z.string().min(1).max(200) }),
  output: z.object({ archived: z.boolean() }),
});
