import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";
import { SERVER_BROWSER_STATE_MESSAGES } from "../shared/server-browser";
import { serverBrowserStatus } from "../shared/server-browser-rpc";

const STATUS_KEY = ["browser-prompt", "server-browser-status"];

/** Short status line per state; the longer texts are what the card says when a press cannot start. */
const STATE_LABELS = {
  ready: "Ready",
  building: "Building the image… (first use, a few minutes)",
  "no-image": "Image not built yet",
  "build-failed": "Image build failed",
  "docker-missing": "Docker missing: the docker command was not found on the Paseo server",
  "docker-unavailable": "Docker not reachable on the Paseo server",
  unsupported: "Not available: this Paseo has no agent session hooks",
  busy: "Ready; the limit of runs with a browser at the same time is reached",
} as const;

/** Server browser status (Docker and its image on the daemon host), with a build button. */
export function ServerBrowserSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const status = useRpc(serverBrowserStatus);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => status({}),
    // Poll faster while a build runs.
    refetchInterval: (q) => (q.state.data?.state === "building" ? 5000 : 30000),
  });
  const info = query.data;
  const label = query.isLoading ? "Checking…" : info ? STATE_LABELS[info.state] : "Unknown (the Paseo server did not answer)";
  const detail = info?.detail ? ` · ${info.detail}` : "";
  const rootless = info?.rootless === true ? " · rootless Docker" : info?.rootless === false ? " · Docker is not rootless" : "";
  const canBuild = info?.state === "no-image" || info?.state === "build-failed";

  return (
    <SettingsSection title="Server browser">
      <SettingsCard>
        <SettingsRow label="Status" hint={`${label}${rootless}${detail}`} />
        {info && info.state !== "ready" && info.state !== "building" ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 6 }}>
            {SERVER_BROWSER_STATE_MESSAGES[info.state]}
          </Text>
        ) : null}
        <SettingsAction
          label="Build the image"
          hint={info ? `Image ${info.image}, built locally from the plugin's pinned Dockerfile (Playwright MCP over a Playwright 1.56 base image).` : undefined}
          actionLabel={info?.state === "building" ? "Building…" : "Build"}
          disabled={!canBuild}
          onPress={async () => {
            await status({ build: true }).catch(() => undefined);
            await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
          }}
        />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 10 }}>
          The card&apos;s Server browser button runs the agent with its own headless Chromium in a throwaway Docker container on
          the Paseo server, so no desktop app is needed (on phones it is the only way an agent can run the steps). That browser
          is not signed in to any of your accounts: use it for public pages and checks, and the Paseo browser for anything that
          needs a login. It cannot reach your tailnet, private or local addresses, or the server itself, has no access to the
          server&apos;s files, and is removed when the run&apos;s session ends.
        </Text>
      </SettingsCard>
    </SettingsSection>
  );
}
