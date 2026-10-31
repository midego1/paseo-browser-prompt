import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_AGENT_SETTINGS } from "./agent-prompt";
import { DEFAULT_APP_LINK_TEMPLATE } from "./browser-prompt";
import { DEFAULT_REPORT_MODE, REPORT_MODES } from "./report-back";
import { migratePreferences } from "./settings-migrate";
import { DEFAULT_TRAMPOLINE_PORT } from "./trampoline-host";

/** Cap on remembered "done" marks; the oldest are dropped first. */
export const MAX_DONE = 500;

/** Cap on remembered card -> agent links; the oldest are dropped first. */
export const MAX_RUNS = 200;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 7,
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
    /**
     * Report a finished browser agent back to the chat whose card started it. auto: the full report
     * only to chats in an ask-first mode, a status-only notice otherwise. full: always. off: never.
     */
    reportBack: z.enum(REPORT_MODES).default(DEFAULT_REPORT_MODE),
    /**
     * Agents started from cards: `[<agentId>:<cardId>, startedAgentId]`, oldest first, plus
     * `"most-recent"` when the run started outside the card agent's workspace.
     */
    runs: z.array(z.tuple([z.string(), z.string()], z.string())).default([]),
    /** ChatGPT launcher bind address on the daemon host; empty = this machine's Tailscale IPv4. */
    trampolineHost: z.string().default(""),
    /** ChatGPT launcher port. */
    trampolinePort: z.number().int().default(DEFAULT_TRAMPOLINE_PORT),
  }),
  migrate: migratePreferences,
});
