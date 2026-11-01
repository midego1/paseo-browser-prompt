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
import { checkForUpdate, getUpdateStatus, installUpdate, updateSettings } from "../shared/update";
import { branchName, hasConsent, shortSha } from "../shared/updater";
import { UPDATED_TOAST } from "./update";

const STATUS_KEY = ["browser-prompt", "update-status"];

function describe(result: string): string {
  if (!result) return "Not checked yet";
  if (result === "up-to-date") return "Up to date";
  if (result === "updating") return "Updating…";
  if (result === "updated") return "Updated. Reload Paseo to use the new version.";
  if (result === "update-available") return "Update available";
  if (result === "local") return "Local install, no auto-update";
  if (result === "unsupported") return "Not an https:// Git install, no auto-update";
  if (result === "not-fast-forward") return "Branch is not a fast-forward of the installed commit; update manually";
  if (result.startsWith("failed: ")) return `Last check failed: ${result.slice("failed: ".length)}`;
  return result;
}

/** What the owner agrees to when enabling auto-update: the repository, and that code gets installed. */
export function consentText(remote: string): string {
  return `When you use the plugin, newer plugin code from ${remote} will be downloaded and installed automatically (only fast-forwards of the branch it follows, at most one check every 30 minutes). Nothing is downloaded or installed until you enable it.`;
}

/** What "Update now" does, shown before the owner presses it. */
export function updateNowText(remote: string, revision: string): string {
  return `Downloads commit ${shortSha(revision)} from ${remote} and installs it as this plugin. Reload Paseo afterwards.`;
}

export function UpdateSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const settings = useSettings(updateSettings);
  const status = useRpc(getUpdateStatus);
  const check = useRpc(checkForUpdate);
  const install = useRpc(installUpdate);
  const [notNow, setNotNow] = useState(false);
  const [installing, setInstalling] = useState(false);
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

  const remote = info?.installKind === "git" ? info.remote : "";
  const consented = hasConsent(values, remote);
  const staleConsent = values.autoUpdate && values.consentRemote !== "" && remote !== "" && values.consentRemote !== remote;
  const available = remote && info?.lastResult === "update-available" && info.latestRevision ? info.latestRevision : "";

  async function updateNow(revision: string) {
    setInstalling(true);
    try {
      const result = await install({ remote, revision });
      if (result.applied) toast.show(UPDATED_TOAST, { variant: "success", durationMs: 8000 });
      else if (result.status === "failed") toast.error(result.message);
      else toast.show(result.message, { durationMs: 5000 });
    } catch (error) {
      toast.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInstalling(false);
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    }
  }

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
        {query.isLoading ? <SettingsRow label="Auto-update" hint="Loading…" /> : null}
        {!query.isLoading && !remote ? (
          <SettingsRow
            label="Auto-update"
            hint={
              info?.installKind === "local"
                ? "Local install: the plugin does not update itself."
                : "Only installs from a Git repository can update themselves; this one updates through Paseo."
            }
          />
        ) : null}
        {remote && consented ? (
          <SettingsAction
            label="Auto-update is on"
            hint={consentText(remote)}
            actionLabel="Turn off"
            onPress={() => void settings.save({ ...values, autoUpdate: false, consentRemote: "" }, revision)}
          />
        ) : null}
        {remote && !consented && staleConsent ? (
          <SettingsRow
            label="Auto-update is off"
            hint={`It was enabled for ${values.consentRemote}. The plugin now comes from ${remote}, so it stays off until you enable it for this repository.`}
          />
        ) : null}
        {remote && !consented ? (
          <SettingsAction
            label="Enable auto-update"
            hint={notNow ? `Off. Updates would come from ${remote}.` : consentText(remote)}
            actionLabel="Enable auto-update"
            onPress={() => void settings.save({ ...values, autoUpdate: true, consentRemote: remote }, revision)}
          />
        ) : null}
        {remote && !consented && !notNow ? (
          <SettingsAction
            label="Keep auto-update off"
            hint="Nothing is downloaded or installed. You can still check and update by hand below."
            actionLabel="Not now"
            onPress={() => {
              setNotNow(true);
              if (values.autoUpdate || values.consentRemote) void settings.save({ ...values, autoUpdate: false, consentRemote: "" }, revision);
            }}
          />
        ) : null}
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
        {available && !consented ? (
          <SettingsAction
            label={`Update to ${shortSha(available)}`}
            hint={updateNowText(remote, available)}
            actionLabel={installing ? "Updating…" : "Update now"}
            disabled={installing}
            onPress={() => void updateNow(available)}
          />
        ) : null}
        <SettingsAction
          label="Check for updates now"
          hint={
            remote
              ? `Reads the newest commit of the followed branch from ${remote}. Installs nothing unless auto-update is on.`
              : "Reads the newest commit of the followed branch from the install's repository. Installs nothing unless auto-update is on."
          }
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
