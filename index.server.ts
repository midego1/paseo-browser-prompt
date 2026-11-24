import type { PluginServerContext } from "@getpaseo/plugin/server";
import { archivedAfterSuccess } from "./shared/archive-rpc";
import { createLauncher, systemProbes } from "./server/launcher";
import { registerModeGuard } from "./server/mode-guard-hook";
import { createSeenRuns, registerReportBack } from "./server/report-back-hook";
import { fileReportedStore } from "./server/reported-store";
import { createServerBrowser, registerServerBrowser, type OpenHookServer } from "./server/server-browser";
import { createSignedIn, signedInConfigFrom } from "./server/signed-in";
import { createServerUpdater, currentUpdateStatus } from "./server/updater";
import { CLAUDE_DESKTOP_LINK_TEMPLATE, DEFAULT_APP_LINK_TEMPLATE } from "./shared/browser-prompt";
import { createRunLocks, runLockKey } from "./shared/run-lock";
import { acquireRunLock, finishRunLock } from "./shared/run-lock-rpc";
import { prepareServerBrowserRun, serverBrowserStatus } from "./shared/server-browser-rpc";
import { cardSettings, preferences, signedInSettings } from "./shared/settings";
import { DEFAULT_SIGNED_IN_PORT, validateHttpsBase } from "./shared/signed-in";
import { prepareSignedInRun, signedInControl, signedInStatus, signedInViewerLink } from "./shared/signed-in-rpc";
import { chooseTrampolineHost } from "./shared/trampoline-host";
import { getLauncherStatus, stashPrompt } from "./shared/trampoline";
import { DEFAULT_TRAMPOLINE_PORT } from "./shared/trampoline-host";
import { checkForUpdate, getUpdateStatus, installUpdate, updateSettings } from "./shared/update";

export default function contribute(server: PluginServerContext) {
  // Host-scoped persistence for start modes, the app deep link, launcher address, and done marks.
  const settings = server.registerSettings(preferences);
  // ChatGPT launcher: binds this machine's Tailscale address (or the configured one), else stays off.
  const launcher = createLauncher();
  const configureFrom = (state: Awaited<ReturnType<typeof settings.read>>) =>
    launcher.configure(
      state.status === "ready"
        ? { trampolineHost: state.values.trampolineHost, trampolinePort: state.values.trampolinePort }
        : { trampolineHost: "", trampolinePort: DEFAULT_TRAMPOLINE_PORT },
    );
  void settings.read().then(configureFrom, () => launcher.configure({ trampolineHost: "", trampolinePort: DEFAULT_TRAMPOLINE_PORT }));
  const unsubscribe = settings.subscribe((state) => configureFrom(state));

  // Self-update: off until the owner enables it for the install's remote (see shared/updater.ts).
  // The client calls update.check when cards render or are used; without consent it returns at once.
  const updater = createServerUpdater(server.registerSettings(updateSettings));

  server.handle(checkForUpdate, ({ force }) => updater.check({ force }));
  server.handle(installUpdate, ({ remote, revision }) => updater.check({ install: { remote, revision } }));
  server.handle(getUpdateStatus, () => currentUpdateStatus());

  server.handle(stashPrompt, async ({ prompt, target }) => {
    // An off launcher (no Tailscale yet, port taken) is tried again, with backoff.
    await launcher.retry();
    if (target === "claude") return launcher.stash(prompt, CLAUDE_DESKTOP_LINK_TEMPLATE);
    const current = await settings.read();
    const template = current.status === "ready" ? current.values.appLinkTemplate : DEFAULT_APP_LINK_TEMPLATE;
    return launcher.stash(prompt, template);
  });
  server.handle(getLauncherStatus, () => launcher.status());

  // In-flight run lock: copies of a block in one chat start one run, also before its record is saved.
  const runLocks = createRunLocks();
  server.handle(acquireRunLock, ({ sourceAgentId, key, length, check, endedRunId }) =>
    runLocks.acquire(runLockKey(sourceAgentId, { key, length, check }), endedRunId),
  );
  server.handle(finishRunLock, ({ sourceAgentId, key, length, check, token, agentId }) => {
    const lockKey = runLockKey(sourceAgentId, { key, length, check });
    return { ok: agentId ? runLocks.started(lockKey, token, agentId) : runLocks.release(lockKey, token) };
  });

  // Runs seen recorded by a card: they keep report back and the mode guard if their record drops out.
  const seenRuns = createSeenRuns();
  // Report back to chat: a finished browser run reports to the agent whose card started it.
  const reportBack = registerReportBack(server, settings, {
    seen: seenRuns,
    store: fileReportedStore(),
    archivedStore: fileReportedStore(undefined, undefined, "archived-runs.json"),
  });
  server.handle(archivedAfterSuccess, async ({ agentId }) => ({ archived: await reportBack.reportBack.wasArchived(agentId) }));
  // Mode guard: a browser run that leaves its allowed permission mode is set back or stopped.
  const modeGuard = registerModeGuard(server, settings, { seen: seenRuns });

  // Server browser: a run's own headless Chromium in a throwaway Docker container on this host,
  // attached as an MCP server only to Server browser runs a card started (see server/server-browser.ts).
  const serverBrowser = createServerBrowser();
  // Signed-in Server browser: the owner's persistent Chromium (neko) on this host, which runs use one
  // at a time and the owner watches or takes over through the relay on this host's Tailscale address
  // (see server/signed-in.ts). Started on demand, stopped after 30 minutes without use.
  const signedInConfig = server.registerSettings(signedInSettings);
  // The card's Run default and Send to targets (0.24.0); the server only keeps the document.
  server.registerSettings(cardSettings);
  // The launcher's bind address: the setting (127.0.0.1 or this host's Tailscale IPv4), else
  // Tailscale; asked at most every 30 seconds (it runs `tailscale ip -4`).
  let bindHostCache: { at: number; configured: string; host: string | null } | null = null;
  const signedIn = createSignedIn({
    serverBrowser,
    bindHost: async () => {
      const prefs = await settings.read().catch(() => null);
      const configured = prefs?.status === "ready" ? prefs.values.trampolineHost : "";
      if (bindHostCache && bindHostCache.configured === configured && Date.now() - bindHostCache.at < 30_000) return bindHostCache.host;
      const host = (await chooseTrampolineHost(configured, systemProbes)).host;
      bindHostCache = { at: Date.now(), configured, host };
      return host;
    },
    // Not ready, invalid or a failed read: the defaults (keys of earlier versions are ignored).
    config: async () => signedInConfigFrom(await signedInConfig.read().catch(() => null), { port: DEFAULT_SIGNED_IN_PORT, validHttpsBase: (base) => validateHttpsBase(base) === null }),
  });
  signedIn.startIdleChecks();
  const serverBrowserHook = registerServerBrowser(server as unknown as OpenHookServer, settings, serverBrowser, { signedIn });
  server.handle(serverBrowserStatus, async ({ build }) => {
    if (!serverBrowserHook.supported) return { state: "unsupported" as const, image: serverBrowser.image, rootless: null, detail: "" };
    return serverBrowser.status({ build });
  });
  server.handle(prepareServerBrowserRun, async ({ sourceAgentId, cardId }) => {
    if (!serverBrowserHook.supported) return { ok: false as const, state: "unsupported" as const, detail: "" };
    return serverBrowser.prepare({ sourceId: sourceAgentId, cardId });
  });

  server.handle(signedInStatus, async ({ build }) => {
    if (!serverBrowserHook.supported) {
      return {
        state: "unsupported" as const,
        image: signedIn.image,
        serverImage: serverBrowser.image,
        running: false,
        viewers: 0,
        busy: false,
        bindHost: null,
        viewerOrigin: null,
        detail: "",
      };
    }
    return signedIn.status({ build });
  });
  server.handle(prepareSignedInRun, async ({ sourceAgentId, cardId }) => {
    if (!serverBrowserHook.supported) return { ok: false as const, state: "unsupported" as const, detail: "" };
    return signedIn.prepare({ sourceId: sourceAgentId, cardId });
  });
  server.handle(signedInViewerLink, async ({ purpose, portrait }) => {
    if (!serverBrowserHook.supported) return { ok: false as const, state: "unsupported" as const, detail: "" };
    return signedIn.viewerLink({ purpose, portrait });
  });
  server.handle(signedInControl, async ({ action }) => {
    try {
      if (action === "stop") await signedIn.stop();
      else if (action === "restart") await signedIn.restart();
      else if (action === "logout") await signedIn.logout();
      else await signedIn.rotateKey();
      const done = {
        stop: "Stopped the signed-in browser. Your logins are kept.",
        restart: "Restarted the signed-in browser. Your logins are kept.",
        logout: "Logged out of everything: the signed-in browser's profile was removed.",
        "rotate-key": "New viewer key: earlier links and viewer sessions no longer work.",
      } as const;
      return { ok: true, message: done[action] };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  return async () => {
    signedIn.dispose();
    serverBrowserHook.dispose();
    modeGuard.dispose();
    await reportBack.dispose();
    unsubscribe();
    await launcher.close();
  };
}
