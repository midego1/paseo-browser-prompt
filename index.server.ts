import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createLauncher } from "./server/launcher";
import { createReportBack } from "./server/report-back";
import { createServerUpdater, currentUpdateStatus } from "./server/updater";
import { DEFAULT_APP_LINK_TEMPLATE } from "./shared/browser-prompt";
import { preferences } from "./shared/settings";
import { getLauncherStatus, stashPrompt } from "./shared/trampoline";
import { DEFAULT_TRAMPOLINE_PORT } from "./shared/trampoline-host";
import { checkForUpdate, getUpdateStatus, updateSettings } from "./shared/update";

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

  // Self-update on use: the client calls update.check when cards render or are used.
  const updater = createServerUpdater(server.registerSettings(updateSettings));

  server.handle(checkForUpdate, ({ force }) => updater.check({ force }));
  server.handle(getUpdateStatus, () => currentUpdateStatus());

  server.handle(stashPrompt, async ({ prompt }) => {
    const current = await settings.read();
    const template = current.status === "ready" ? current.values.appLinkTemplate : DEFAULT_APP_LINK_TEMPLATE;
    return launcher.stash(prompt, template);
  });
  server.handle(getLauncherStatus, () => launcher.status());

  // Report back to chat: a finished browser run sends its report to the agent whose card started it.
  const reportBack = createReportBack({
    async enabled() {
      const current = await settings.read();
      return current.status === "ready" ? current.values.reportBack : true;
    },
  });
  const stopReporting = server.on("agent.turn_ended", async (event, { paseo }) => {
    await reportBack.onTurnEnded(event, paseo);
  });

  return async () => {
    stopReporting();
    unsubscribe();
    await launcher.close();
  };
}
