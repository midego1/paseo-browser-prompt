import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { preferences } from "../shared/settings";
import { getLauncherStatus } from "../shared/trampoline";
import { DEFAULT_TRAMPOLINE_PORT, validateConfiguredHost, validatePort } from "../shared/trampoline-host";

const STATUS_KEY = ["browser-prompt", "launcher-status"];

const SOURCE_LABELS = {
  setting: "from the setting",
  tailscale: "Tailscale",
  interfaces: "Tailscale interface",
  none: "not found",
} as const;

const STATE_LABELS = {
  listening: "Listening",
  starting: "Starting…",
  "no-tailscale": "Off: no Tailscale address on this host. Start in ChatGPT copies the prompt instead.",
  "not-local": "Off: the bind address is not this host's Tailscale address or 127.0.0.1.",
  "port-in-use": "Off: the port is in use on this host.",
  error: "Off: could not start.",
} as const;

export function LauncherSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const settings = useSettings(preferences);
  const status = useRpc(getLauncherStatus);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: STATUS_KEY, queryFn: () => status({}), refetchInterval: 5000 });
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);

  if (settings.status !== "ready") {
    return <Text style={{ color: theme.colors.foregroundMuted }}>{settings.status === "loading" ? "Loading..." : ""}</Text>;
  }
  const { values, revision } = settings;
  const host = hostDraft ?? values.trampolineHost;
  const portText = portDraft ?? String(values.trampolinePort);
  const port = Number(portText);
  const hostError = validateConfiguredHost(host);
  const portError = validatePort(port);
  const info = query.data;
  const where = info?.host ? `${info.host}:${info.port} (${SOURCE_LABELS[info.source]})` : `port ${info?.port ?? values.trampolinePort}`;
  const dirty = hostDraft !== null || portDraft !== null;

  async function save(next: { trampolineHost: string; trampolinePort: number }) {
    if (await settings.save({ ...values, ...next }, revision)) {
      setHostDraft(null);
      setPortDraft(null);
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: STATUS_KEY }), 1500);
    }
  }

  return (
    <SettingsSection title="ChatGPT launcher">
      <SettingsCard>
        <SettingsRow
          label="Status"
          hint={query.isLoading ? "Loading…" : info ? `${STATE_LABELS[info.state]} · ${where}` : "Unknown"}
        />
        <SettingsInput
          label="Bind address"
          hint="Empty: this machine's Tailscale IPv4 (detected). Otherwise only this machine's own Tailscale address or 127.0.0.1; never 0.0.0.0 or a LAN address."
          error={hostError ?? undefined}
          initialValue={values.trampolineHost}
          placeholder="auto (Tailscale)"
          onChangeText={setHostDraft}
        />
        <SettingsInput
          label="Port"
          hint={`Default: ${DEFAULT_TRAMPOLINE_PORT}`}
          error={portError ?? undefined}
          initialValue={String(values.trampolinePort)}
          placeholder={String(DEFAULT_TRAMPOLINE_PORT)}
          onChangeText={setPortDraft}
        />
        <SettingsAction
          label="Save launcher address"
          actionLabel="Save"
          disabled={!dirty || hostError !== null || portError !== null}
          onPress={() => void save({ trampolineHost: host.trim(), trampolinePort: port })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
