import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_AGENT_SETTINGS, MAX_CHAT_QUESTIONS_LIMIT } from "./agent-prompt";
import { DEFAULT_APP_LINK_TEMPLATE } from "./browser-prompt";
import { DEFAULT_REPORT_MODE, REPORT_MODES } from "./report-back";
import { THUMBNAIL_MODES } from "./screenshot";
import { migratePreferences } from "./settings-migrate";
import { DEFAULT_SIGNED_IN_PORT } from "./signed-in";
import { DEFAULT_TRAMPOLINE_PORT } from "./trampoline-host";

/** Cap on remembered "done" marks; the oldest are dropped first. */
export const MAX_DONE = 500;

/** Cap on remembered card -> agent links; the oldest are dropped first. */
export const MAX_RUNS = 200;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 18,
  schema: z.object({
    /**
     * Desktop and web clients.
     * app: copy, then open the ChatGPT desktop app with the prompt prefilled via the trampoline.
     * web-agent: copy, then open chatgpt.com agent mode (prefilled when short and secret-free).
     * copy-only: copy and remind to paste.
     * claude-desktop: copy, then open the Claude desktop app with the prompt prefilled (through the
     *   same launcher as the ChatGPT app).
     * paseo, chrome: a Paseo agent in the Paseo browser or in Claude in Chrome.
     * server: a Paseo agent in the Server browser (headless Chromium in a container on the daemon
     *   host; needs no desktop app, not signed in to any account).
     * signed-in: a Paseo agent in the signed-in Server browser (the owner's persistent Chromium on
     *   the daemon host, which the owner can watch and take over from any device).
     * This one is highlighted on the card. The card shows the Chrome tab button only with a Claude
     * provider, and no Desktop buttons on phones.
     */
    startMode: z.enum(["app", "web-agent", "copy-only", "claude-desktop", "paseo", "chrome", "server", "signed-in"]).default("app"),
    /** iOS and Android. No documented ChatGPT mobile deep link for a new prompt exists. */
    mobileStartMode: z.enum(["copy-only", "web-agent", "paseo", "chrome", "server", "signed-in"]).default("copy-only"),
    /** Desktop app deep link; `{prompt}` is replaced by the URI-encoded prompt. */
    appLinkTemplate: z.string().default(DEFAULT_APP_LINK_TEMPLATE),
    /**
     * Blocks the owner marked done: `<agentId>:<content key>` (see shared/repeats.ts), so every repeat
     * of a block in that chat shares the mark. Marks from before 0.9.0 are `<agentId>:<cardId>`; a
     * card that finds its old mark moves it to the new form.
     */
    done: z.array(z.string()).default([]),
    /** Show a later block with the same steps as an earlier one in the chat as one line pointing up. */
    mergeRepeats: z.boolean().default(true),
    /** "Run with Paseo agent": provider id, model id, thinking option and permission mode. */
    agentProvider: z.string().default(DEFAULT_AGENT_SETTINGS.agentProvider),
    agentModel: z.string().default(DEFAULT_AGENT_SETTINGS.agentModel),
    agentThinking: z.string().default(DEFAULT_AGENT_SETTINGS.agentThinking),
    agentMode: z.string().default(DEFAULT_AGENT_SETTINGS.agentMode),
    /**
     * Paseo provider for Claude in Chrome runs, on the extension's Claude account. Empty:
     * `claude-chrome` when the daemon has that provider, else the Provider setting.
     */
    chromeProvider: z.string().default(DEFAULT_AGENT_SETTINGS.chromeProvider),
    /** Ask before starting the agent. */
    confirmAgentLaunch: z.boolean().default(DEFAULT_AGENT_SETTINGS.confirmAgentLaunch),
    /** Open the new agent's view after starting it; off (default) = it runs in the background. */
    openAgentOnStart: z.boolean().default(DEFAULT_AGENT_SETTINGS.openAgentOnStart),
    /**
     * Let the run ask the chat that showed the card about the task. Never secrets or approvals of
     * destructive, security, billing, merge or publish actions: those always go to the owner.
     */
    talkToChat: z.boolean().default(DEFAULT_AGENT_SETTINGS.talkToChat),
    /** Ask the run to mark its steps and show "Step N of M" with a progress bar on the card. */
    showStepProgress: z.boolean().default(DEFAULT_AGENT_SETTINGS.showStepProgress),
    /** Ask the run for a viewport screenshot after each step and show the latest on the card. */
    showLiveScreenshot: z.boolean().default(DEFAULT_AGENT_SETTINGS.showLiveScreenshot),
    /** Card thumbnails: one per step, or only the newest. */
    thumbnailMode: z.enum(THUMBNAIL_MODES).default(DEFAULT_AGENT_SETTINGS.thumbnailMode),
    /** After a fully successful run, the agent closes the tabs it opened itself (default on). */
    closeTabsOnSuccess: z.boolean().default(DEFAULT_AGENT_SETTINGS.closeTabsOnSuccess),
    /** After a fully successful run, archive the agent once its report went out (default off). */
    archiveAgentOnSuccess: z.boolean().default(DEFAULT_AGENT_SETTINGS.archiveAgentOnSuccess),
    /** Questions a run may send to the chat (0 to 50; 0 behaves like Talk to the chat off). */
    maxChatQuestions: z
      .number()
      .int()
      .min(0)
      .max(MAX_CHAT_QUESTIONS_LIMIT)
      .default(DEFAULT_AGENT_SETTINGS.maxChatQuestions),
    /**
     * Report a finished browser agent back to the chat whose card started it. auto: the full report
     * only to chats in an ask-first mode, a status-only notice otherwise. full: always. off: never.
     */
    reportBack: z.enum(REPORT_MODES).default(DEFAULT_REPORT_MODE),
    /**
     * Agents started from cards: `[<agentId>:<cardId>, startedAgentId, ...markers]`, oldest first, at
     * most 5 per card and 200 in total. Markers: `"most-recent"` (always third when present) when the
     * run started outside the card agent's workspace, `key:<content key>` for the block it was started
     * for (copies of the block share the run), `browser:chrome` for a Claude in Chrome run and
     * `browser:server` for a Server browser run (the server attaches the browser only to runs with it).
     */
    runs: z.array(z.tuple([z.string(), z.string()], z.string())).default([]),
    /** ChatGPT launcher bind address on the daemon host; empty = this machine's Tailscale IPv4. */
    trampolineHost: z.string().default(""),
    /** ChatGPT launcher port. */
    trampolinePort: z.number().int().default(DEFAULT_TRAMPOLINE_PORT),
  }),
  migrate: migratePreferences,
});

/**
 * The signed-in Server browser's own settings, in a document of their own so older plugin versions
 * never see them (rollback-safe: they ignore it, and nothing in `preferences` changes shape).
 */
export const signedInSettings = defineSettings({
  id: "signed-in",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Port of the owner's viewer on the bind address (the launcher's: Tailscale or 127.0.0.1); WebRTC uses the next one. */
    port: z.number().int().min(1024).max(65534).default(DEFAULT_SIGNED_IN_PORT),
    /** Optional https://name[:port] in front of the viewer (for example `tailscale serve`); empty: http on the bind address. */
    httpsBaseUrl: z.string().default(""),
    /**
     * Bitwarden in the signed-in browser, for the owner during a takeover (off by default). Set only
     * after the settings' two-press consent; the pinned release is downloaded only then.
     */
    bitwarden: z.boolean().default(false),
    /** SHA-256 of the Bitwarden release the owner confirmed downloading (a new pin needs a new confirmation). */
    bitwardenConsent: z.string().default(""),
  }),
});
