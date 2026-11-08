import type { PluginServerContext } from "@getpaseo/plugin/server";
import { archivedAfterSuccess } from "./shared/archive-rpc";
import { createLauncher } from "./server/launcher";
import { registerModeGuard } from "./server/mode-guard-hook";
import { createSeenRuns, registerReportBack } from "./server/report-back-hook";
import { fileReportedStore } from "./server/reported-store";
import { createServerUpdater, currentUpdateStatus } from "./server/updater";
import { CLAUDE_DESKTOP_LINK_TEMPLATE, DEFAULT_APP_LINK_TEMPLATE } from "./shared/browser-prompt";
import { createRunLocks, runLockKey } from "./shared/run-lock";
import { acquireRunLock, finishRunLock } from "./shared/run-lock-rpc";
import { preferences } from "./shared/settings";
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

  return async () => {
    modeGuard.dispose();
    await reportBack.dispose();
    unsubscribe();
    await launcher.close();
  };
}
