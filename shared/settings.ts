import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_AGENT_SETTINGS } from "./agent-prompt";
import { DEFAULT_APP_LINK_TEMPLATE } from "./browser-prompt";
import { DEFAULT_TRAMPOLINE_PORT } from "./trampoline-host";

/** Cap on remembered "done" marks; the oldest are dropped first. */
export const MAX_DONE = 500;

/** Cap on remembered card -> agent links; the oldest are dropped first. */
export const MAX_RUNS = 200;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 4,
  schema: z.object({
    /**
     * Desktop and web clients.
     * app: copy, then open the ChatGPT desktop app with the prompt prefilled via the trampoline.
     * web-agent: copy, then open chatgpt.com agent mode (prefilled when short and secret-free).
     * copy-only: copy and remind to paste.
     */
    startMode: z.enum(["app", "web-agent", "copy-only"]).default("app"),
    /** iOS and Android. No documented ChatGPT mobile deep link for a new prompt exists. */
    mobileStartMode: z.enum(["copy-only", "web-agent"]).default("copy-only"),
    /** Desktop app deep link; `{prompt}` is replaced by the URI-encoded prompt. */
    appLinkTemplate: z.string().default(DEFAULT_APP_LINK_TEMPLATE),
    /** Card keys (`<agentId>:<cardId>`) the owner marked done. */
    done: z.array(z.string()).default([]),
    /** "Run with Paseo agent": provider id, model id, thinking option and permission mode. */
    agentProvider: z.string().default(DEFAULT_AGENT_SETTINGS.agentProvider),
    agentModel: z.string().default(DEFAULT_AGENT_SETTINGS.agentModel),
    agentThinking: z.string().default(DEFAULT_AGENT_SETTINGS.agentThinking),
    agentMode: z.string().default(DEFAULT_AGENT_SETTINGS.agentMode),
    /** Ask before starting the agent. */
    confirmAgentLaunch: z.boolean().default(DEFAULT_AGENT_SETTINGS.confirmAgentLaunch),
    /** Agents started from cards: `[<agentId>:<cardId>, startedAgentId]`, oldest first. */
    runs: z.array(z.tuple([z.string(), z.string()])).default([]),
    /** ChatGPT launcher bind address on the daemon host; empty = this machine's Tailscale IPv4. */
    trampolineHost: z.string().default(""),
    /** ChatGPT launcher port. */
    trampolinePort: z.number().int().default(DEFAULT_TRAMPOLINE_PORT),
  }),
  migrate(values, fromVersion) {
    const old = (values ?? {}) as { done?: unknown };
    // v1 only had startMode ("web-agent" | "copy-only") and done. The app is the new default.
    if (fromVersion < 2) return { done: Array.isArray(old.done) ? old.done : [] };
    // v3 and v4 only add fields with defaults.
    return values;
  },
});
