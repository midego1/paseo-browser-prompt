import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const unavailable = z.enum(["starting", "no-tailscale", "not-local", "port-in-use", "error"]);

/**
 * Stashes the prompt server-side under a one-time id and returns the launcher URL on this host's
 * Tailscale address, or why the launcher is not available.
 */
export const stashPrompt = defineRpc({
  name: "trampoline.stash",
  input: z.object({ prompt: z.string().min(1).max(20000) }),
  output: z.union([z.object({ url: z.string().url() }), z.object({ unavailable })]),
});

export const getLauncherStatus = defineRpc({
  name: "trampoline.status",
  input: z.object({}),
  output: z.object({
    state: z.enum(["listening", "starting", "no-tailscale", "not-local", "port-in-use", "error"]),
    host: z.string().nullable(),
    port: z.number(),
    source: z.enum(["setting", "tailscale", "interfaces", "none"]),
  }),
});
