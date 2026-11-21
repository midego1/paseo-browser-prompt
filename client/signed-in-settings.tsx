import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Platform, Text } from "react-native";
import { signedInSettings } from "../shared/settings";
import { DEFAULT_SIGNED_IN_PORT, SIGNED_IN_STATE_MESSAGES, validateHttpsBase } from "../shared/signed-in";
import { signedInControl, signedInStatus, signedInViewerLink } from "../shared/signed-in-rpc";

const STATUS_KEY = ["browser-prompt", "signed-in-status"];

const STATE_LABELS = {
  ready: "Ready (stopped; starts when needed)",
  running: "Running",
  starting: "Starting…",
  busy: "In use by a run",
  building: "Downloading and building the images… (a few minutes)",
  "no-image": "Images not built yet",
  "build-failed": "Image build failed",
  "no-address": "No Tailscale address on this server for the viewer",
  "docker-missing": "Docker missing: the docker command was not found on the Paseo server",
  "docker-unavailable": "Docker not reachable on the Paseo server",
  unsupported: "Not available: this Paseo has no agent session hooks",
  failed: "Could not start",
} as const;

type Armed = null | "build" | "logout" | "rotate";

/**
 * Signed-in Server browser: status, the explicit two-press image download, Log in to sites (the
 * owner's viewer, portrait on phones), Stop, Log out of everything (wipes the profile), viewer key
 * rotation, and the viewer's port and optional https base.
 */
export function SignedInSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const status = useRpc(signedInStatus);
  const link = useRpc(signedInViewerLink);
  const control = useRpc(signedInControl);
  const config = useSettings(signedInSettings);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => status({}),
    refetchInterval: (q) => (q.state.data?.state === "building" || q.state.data?.state === "starting" ? 5000 : 30000),
  });
  const [armed, setArmed] = useState<Armed>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [baseDraft, setBaseDraft] = useState<string | null>(null);
  const info = query.data;
  // An armed confirmation is dropped when the state changes and after 10 seconds, so an old first
  // press never turns a later single press into a download or a wipe.
  useEffect(() => setArmed(null), [info?.state]);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 10_000);
    return () => clearTimeout(timer);
  }, [armed]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: STATUS_KEY });
  const label = query.isLoading ? "Checking…" : info ? STATE_LABELS[info.state] : "Unknown (the Paseo server did not answer)";
  const extra = info
    ? [info.running && info.viewers > 0 ? `${info.viewers} viewer${info.viewers === 1 ? "" : "s"}` : "", info.busy ? "a run is using it" : "", info.detail]
        .filter(Boolean)
        .join(" · ")
    : "";
  const canBuild = info?.state === "no-image" || info?.state === "build-failed";
  const usable = info?.state === "ready" || info?.state === "running" || info?.state === "failed";
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 6 } as const;

  async function act(action: () => Promise<string | null>) {
    if (working) return;
    setWorking(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
      void refresh();
    }
  }

  const values = config.status === "ready" ? config.values : null;
  const portText = portDraft ?? String(values?.port ?? DEFAULT_SIGNED_IN_PORT);
  const port = Number(portText);
  const portError = Number.isInteger(port) && port >= 1024 && port <= 65534 ? null : "A port from 1024 to 65534.";
  const base = baseDraft ?? values?.httpsBaseUrl ?? "";
  const baseError = validateHttpsBase(base);
  const dirty = portDraft !== null || baseDraft !== null;

  return (
    <SettingsSection title="Signed-in Server browser">
      <SettingsCard>
        <SettingsRow label="Status" hint={`${label}${extra ? ` · ${extra}` : ""}`} />
        {info && !usable && info.state !== "building" && info.state !== "starting" ? <Text style={muted}>{SIGNED_IN_STATE_MESSAGES[info.state]}</Text> : null}
        <SettingsAction
          label="Download and build"
          hint={
            info
              ? `Downloads the pinned neko browser image from GitHub's registry (about 1.5 GB) and builds ${info.image}; also builds ${info.serverImage} if the Server browser is not set up yet (about 2.6 GB more). Nothing is downloaded until you confirm.`
              : undefined
          }
          actionLabel={info?.state === "building" ? "Building…" : armed === "build" ? "Confirm download (1.5 GB+)" : "Download and build"}
          disabled={!canBuild || working}
          onPress={() => {
            // Two presses: the download happens only on the owner's explicit confirmation.
            if (armed !== "build") return setArmed("build");
            setArmed(null);
            void act(async () => {
              await status({ build: true });
              return null;
            });
          }}
        />
        <SettingsAction
          label="Log in to sites"
          hint="Opens the signed-in browser on this device (portrait on phones) so you can log in to the sites runs should use, including 2FA. The link works once, for a few minutes."
          actionLabel={working ? "…" : "Open"}
          disabled={!usable || working}
          onPress={() =>
            void act(async () => {
              const result = await link({ purpose: "login", portrait: Platform.OS === "ios" || Platform.OS === "android" });
              if (!result.ok) return `${SIGNED_IN_STATE_MESSAGES[result.state]}${result.detail ? ` (${result.detail})` : ""}`;
              await openExternalUrl(result.url);
              return null;
            })
          }
        />
        <SettingsAction
          label="Stop now"
          hint="Stops the browser (it also stops by itself after 30 minutes without a run or viewer). Your logins are kept."
          actionLabel="Stop"
          disabled={!info?.running || working}
          onPress={() =>
            void act(async () => {
              const result = await control({ action: "stop" });
              return result.message;
            })
          }
        />
        <SettingsAction
          label="Log out of everything"
          hint="Stops the browser and deletes its profile on the server: every login, cookie and the history there. A run using it is stopped."
          actionLabel={armed === "logout" ? "Confirm: delete all logins" : "Log out of everything"}
          disabled={working || !info || info.state === "docker-missing" || info.state === "docker-unavailable" || info.state === "unsupported"}
          onPress={() => {
            if (armed !== "logout") return setArmed("logout");
            setArmed(null);
            void act(async () => (await control({ action: "logout" })).message);
          }}
        />
        <SettingsAction
          label="New viewer key"
          hint="Makes every earlier viewer link and open viewer session stop working (the viewer key lives in the plugin's state directory on the server)."
          actionLabel={armed === "rotate" ? "Confirm new key" : "Rotate key"}
          disabled={working || !info || info.state === "docker-missing" || info.state === "unsupported"}
          onPress={() => {
            if (armed !== "rotate") return setArmed("rotate");
            setArmed(null);
            void act(async () => (await control({ action: "rotate-key" })).message);
          }}
        />
        {message ? <Text style={muted}>{message}</Text> : null}
        <SettingsInput
          label="Viewer port"
          hint={`Default ${DEFAULT_SIGNED_IN_PORT}; WebRTC uses the next port. Bound only on the launcher's address (this server's Tailscale IPv4, or 127.0.0.1).${info?.viewerOrigin ? ` Now: ${info.viewerOrigin}` : ""}`}
          error={portError ?? undefined}
          initialValue={String(values?.port ?? DEFAULT_SIGNED_IN_PORT)}
          placeholder={String(DEFAULT_SIGNED_IN_PORT)}
          onChangeText={setPortDraft}
        />
        <SettingsInput
          label="HTTPS address (optional)"
          hint="For example https://my-server.tailnet-name.ts.net:8443 after you set up `tailscale serve` for the viewer port; phones then get clipboard and secure cookies. Empty: plain http on the Tailscale address."
          error={baseError ?? undefined}
          initialValue={values?.httpsBaseUrl ?? ""}
          placeholder="https://…"
          onChangeText={setBaseDraft}
        />
        <SettingsAction
          label="Save viewer address"
          actionLabel="Save"
          disabled={!dirty || !values || portError !== null || baseError !== null}
          onPress={() =>
            void (async () => {
              if (config.status !== "ready") return;
              if (await config.save({ ...config.values, port, httpsBaseUrl: base.trim().replace(/\/$/, "") }, config.revision)) {
                setPortDraft(null);
                setBaseDraft(null);
                void refresh();
              }
            })()
          }
        />
        <Text style={{ ...muted, paddingVertical: 10 }}>
          The card&apos;s Server (signed in) button runs the agent in your own persistent browser on the Paseo server, signed in to the
          sites you logged in to here. You can watch a run and take over (log in, 2FA, captchas) from any device on your tailnet with
          the card&apos;s Take over button. Your login sessions are stored on the Paseo server, in a Docker volume only this browser
          uses. It cannot reach your tailnet, private or local addresses, or the server itself. One run at a time.
        </Text>
      </SettingsCard>
    </SettingsSection>
  );
}
