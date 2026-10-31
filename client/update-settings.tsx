import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { checkForUpdate, getUpdateStatus, updateSettings } from "../shared/update";
import { branchName, shortSha } from "../shared/updater";
import { UPDATED_TOAST } from "./update";

const STATUS_KEY = ["browser-prompt", "update-status"];

function describe(result: string): string {
  if (!result) return "Not checked yet";
  if (result === "up-to-date") return "Up to date";
  if (result === "updating") return "Updating…";
  if (result === "updated") return "Updated. Reload Paseo to use the new version.";
  if (result === "update-available") return "Update available (auto-update is off)";
  if (result === "local") return "Local install, no auto-update";
  if (result === "unsupported") return "Not an https:// Git install, no auto-update";
  if (result === "not-fast-forward") return "Branch is not a fast-forward of the installed commit; update manually";
  if (result.startsWith("failed: ")) return `Last check failed: ${result.slice("failed: ".length)}`;
  return result;
}

export function UpdateSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const settings = useSettings(updateSettings);
  const status = useRpc(getUpdateStatus);
  const check = useRpc(checkForUpdate);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [refDraft, setRefDraft] = useState<string | null>(null);
  const query = useQuery({ queryKey: STATUS_KEY, queryFn: () => status({}) });

  if (settings.status !== "ready") {
    const message = settings.status === "loading" ? "Loading..." : `Settings unavailable: ${settings.error}`;
    return <Text style={{ color: theme.colors.foregroundMuted }}>{message}</Text>;
  }
  const { values, revision } = settings;
  const info = query.data;
  const lastCheck = info?.lastCheckAt ? new Date(info.lastCheckAt).toLocaleString() : "never";
  const refValue = refDraft ?? values.trackRefOverride;

  async function checkNow() {
    setChecking(true);
    try {
      const result = await check({ force: true });
      if (result.applied) toast.show(UPDATED_TOAST, { variant: "success", durationMs: 8000 });
      else if (result.status === "failed") toast.error(result.message);
      else toast.show(result.message, { durationMs: 4000 });
    } catch (error) {
      toast.error(`Check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setChecking(false);
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    }
  }

  return (
    <SettingsSection title="Updates">
      <SettingsCard>
        <SettingsSwitch
          label="Auto-update on use"
          hint="When a card is shown or used, check the plugin's Git branch over HTTPS (at most every 30 minutes) and install a newer commit only when it is a fast-forward."
          value={values.autoUpdate}
          onValueChange={(autoUpdate) => void settings.save({ ...values, autoUpdate }, revision)}
        />
        <SettingsRow
          label="Installed"
          hint={
            query.isLoading
              ? "Loading…"
              : info?.installedRevision
                ? `${shortSha(info.installedRevision)}${info.trackedRef ? ` on ${branchName(info.trackedRef)}` : ""}`
                : "Unknown"
          }
        />
        <SettingsRow label="Latest seen" hint={info?.latestRevision ? shortSha(info.latestRevision) : "—"} />
        <SettingsRow label="Last check" hint={`${lastCheck} · ${describe(info?.lastResult ?? "")}`} />
        <SettingsAction
          label="Check for updates now"
          hint="Ignores the 30-minute limit. Installs the update when auto-update is on."
          actionLabel={checking ? "Checking…" : "Check now"}
          disabled={checking}
          onPress={() => void checkNow()}
        />
        <SettingsInput
          label="Follow branch"
          hint="Empty: the branch the install was made from (inferred). Example: main."
          initialValue={values.trackRefOverride}
          placeholder="inferred"
          onChangeText={setRefDraft}
        />
        <SettingsAction
          label="Save branch"
          actionLabel="Save"
          disabled={refDraft === null || refDraft.trim() === values.trackRefOverride}
          onPress={async () => {
            if (await settings.save({ ...values, trackRefOverride: refValue.trim() }, revision)) setRefDraft(null);
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
