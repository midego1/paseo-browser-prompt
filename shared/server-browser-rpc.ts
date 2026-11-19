import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SERVER_BROWSER_STATES } from "./server-browser";

const state = z.enum(SERVER_BROWSER_STATES);

/** The Server browser's state on this host; `build: true` (only from the settings' Download and build, the owner's explicit choice) starts building a missing image. */
export const serverBrowserStatus = defineRpc({
  name: "server-browser.status",
  input: z.object({ build: z.boolean().optional() }),
  output: z.object({
    state,
    image: z.string(),
    rootless: z.boolean().nullable(),
    detail: z.string(),
  }),
});

/**
 * Right before a Server browser run is created: checks Docker and the image again (never building
 * it) and returns a one-time ticket for this chat and card. The run's first session open needs
 * it, because the card can only record the run after it exists.
 */
export const prepareServerBrowserRun = defineRpc({
  name: "server-browser.prepare",
  input: z.object({ sourceAgentId: z.string().min(1).max(200), cardId: z.string().min(1).max(200) }),
  output: z.union([
    z.object({ ok: z.literal(true), ticket: z.string().min(16).max(100) }),
    z.object({ ok: z.literal(false), state, detail: z.string() }),
  ]),
});
