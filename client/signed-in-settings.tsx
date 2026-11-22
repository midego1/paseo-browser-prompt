import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Platform, Text } from "react-native";
import { signedInSettings } from "../shared/settings";
import { BITWARDEN, DEFAULT_SIGNED_IN_PORT, SIGNED_IN_STATE_MESSAGES, validateHttpsBase, type BitwardenState } from "../shared/signed-in";
import { signedInBitwarden, signedInControl, signedInStatus, signedInViewerLink } from "../shared/signed-in-rpc";

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

type Armed = null | "build" | "logout" | "rotate" | "bitwarden";

const BITWARDEN_LABELS: Record<BitwardenState, string> = {
  off: "Off",
  "needs-browser": "On, but the signed-in browser is not set up yet (Download and build above first)",
  "no-image": `On, but Bitwarden ${BITWARDEN.version} is not downloaded yet: press Download and confirm`,
  building: `Downloading Bitwarden ${BITWARDEN.version} and building the browser with it…`,
  "build-failed": "Download or build failed",
  ready: `Ready (Bitwarden ${BITWARDEN.version})`,
};

/** Recommended Bitwarden settings: the extension has no managed policy for them, so the owner sets them once. */
export const BITWARDEN_RECOMMENDED =
  "First, in Bitwarden in the signed-in browser (Bitwarden has no policy the plugin could force these with): Settings › Account security: Vault timeout 1 minute (or shorter) with action Lock, never “Never” (that stores the key on the server's disk and Bitwarden unlocks itself, so the plugin can never lock it and runs stay paused); Unlock with PIN off; no biometrics. Settings › Autofill: Autofill on page load off (Bitwarden's default), and turn off card and identity suggestions in the inline menu. Log in with your master password plus two-step login.";
/** A new pin (plugin update) or turning Bitwarden off removes what it kept in the browser. */
export const BITWARDEN_PIN_NOTE =
  "A plugin update that pins a newer Bitwarden builds a new extension (its own id): the old one and its local data (vault cache, settings) are removed from the signed-in browser, and you download it again and log in again. The same happens when you turn Bitwarden off.";

/**
 * Signed-in Server browser: status, the explicit two-press image download, Log in to sites (the
 * owner's viewer, portrait on phones), Stop, Log out of everything (wipes the profile), viewer key
 * rotation, and the viewer's port and optional https base.
 */
export function SignedInSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const status = useRpc(signedInStatus);
  const link = useRpc(signedInViewerLink);
  const control = useRpc(signedInControl);
  const bitwarden = useRpc(signedInBitwarden);
  const config = useSettings(signedInSettings);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => status({}),
    refetchInterval: (q) => (q.state.data?.state === "building" || q.state.data?.state === "starting" || q.state.data?.bitwarden.state === "building" ? 5000 : 30000),
  });
  const [armed, setArmed] = useState<Armed>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [baseDraft, setBaseDraft] = useState<string | null>(null);
  const info = query.data;
  // An armed confirmation is dropped when the state changes and after 10 seconds, so an old first
  // press never turns a later single press into a download or a wipe.
  useEffect(() => setArmed(null), [info?.state, info?.bitwarden.state]);
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
        <SettingsRow
          label="Bitwarden"
          hint={
            info
              ? [
                  `${BITWARDEN_LABELS[info.bitwarden.state]}${info.bitwarden.detail ? ` (${info.bitwarden.detail})` : ""}`,
                  info.running ? (info.bitwarden.active ? "in the running browser" : "not in the running browser") : "",
                  info.bitwarden.updatePending ? (info.busy ? "Update pending: the browser switches when the run ends" : "Update pending: the browser switches at its next check") : "",
                  info.bitwarden.lockPending ? "a run waits until Bitwarden is locked" : "",
                  info.bitwarden.lastLock
                    ? info.bitwarden.lastLock.ok
                      ? "last lock verified"
                      : `last lock failed${info.bitwarden.lastLock.failures > 1 ? ` (${info.bitwarden.lastLock.failures} times in a row; tried again after a growing pause)` : ""}: ${info.bitwarden.lastLock.detail}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
        />
        {values?.bitwarden ? <Text style={{ ...muted, color: theme.colors.foreground }}>{BITWARDEN_RECOMMENDED}</Text> : null}
        <Text style={muted}>
          {`Optional: the Bitwarden Password Manager extension in the signed-in browser, for you while you hold control (Take over or Log in to sites): unlock it there, fill logins from its icon or a field's suggestion, and use it for passkeys. The agent never gets it: its pages and frames are hidden from the run, the run cannot open, click or type into them, and every time you release control the plugin locks the vault (Bitwarden's own lock, checked through the browser) before the run goes on. An unlocked vault does live in that browser on the server while you use it. Download and enable fetches Bitwarden ${BITWARDEN.version} (about 34 MB) from Bitwarden's GitHub releases, checks its SHA-256 and builds it into the browser image, where Chromium installs it by policy; it never updates by itself. Turning it off removes it and its data from the browser at the next start.`}
        </Text>
        <SettingsAction
          label={values?.bitwarden ? "Download Bitwarden again" : "Download and enable Bitwarden"}
          hint={values?.bitwarden ? "Needed after a plugin update pins a newer Bitwarden, or when the download failed." : undefined}
          actionLabel={armed === "bitwarden" ? "Confirm download" : values?.bitwarden ? "Download" : "Download and enable"}
          disabled={
            working ||
            !values ||
            !info ||
            info.bitwarden.state === "building" ||
            info.bitwarden.state === "ready" ||
            !["ready", "running", "failed"].includes(info.state)
          }
          onPress={() => {
            // Two presses: the download happens only on the owner's explicit confirmation.
            if (armed !== "bitwarden") return setArmed("bitwarden");
            setArmed(null);
            void act(async () => {
              if (config.status !== "ready") return "Settings are not loaded yet.";
              // The consent names the pinned release (its SHA-256); a new pin asks again.
              if (!(config.values.bitwarden && config.values.bitwardenConsent === BITWARDEN.sha256) && !(await config.save({ ...config.values, bitwarden: true, bitwardenConsent: BITWARDEN.sha256 }, config.revision))) return "Could not save the setting.";
              return (await bitwarden({ action: "download" })).message;
            });
          }}
        />
        <SettingsAction
          label="Turn Bitwarden off"
          hint="Removes Bitwarden and its data (vault cache, settings) from the signed-in browser at its next start; an idle browser restarts now."
          actionLabel="Turn off"
          disabled={working || !values?.bitwarden}
          onPress={() =>
            void act(async () => {
              if (config.status !== "ready") return "Settings are not loaded yet.";
              if (!(await config.save({ ...config.values, bitwarden: false }, config.revision))) return "Could not save the setting.";
              return (await bitwarden({ action: "apply" })).message;
            })
          }
        />
        <SettingsAction
          label="Apply the Bitwarden choice now"
          hint="Restarts the signed-in browser (logins kept) so it starts with or without Bitwarden as chosen. Never while a run uses it."
          actionLabel="Restart"
          disabled={working || !info?.running || info.bitwarden.active === (values?.bitwarden === true && info.bitwarden.state === "ready")}
          onPress={() => void act(async () => (await bitwarden({ action: "apply" })).message)}
        />
        <SettingsAction
          label="Lock Bitwarden now"
          hint="Locks every Bitwarden account in the signed-in browser and checks that it is locked; a run that waits for the lock goes on."
          actionLabel="Lock now"
          disabled={working || !info?.running || !info.bitwarden.active}
          onPress={() => void act(async () => (await bitwarden({ action: "lock" })).message)}
        />
        <SettingsAction
          label="Restart the signed-in browser"
          hint="Restarts Chromium there (your logins are kept; every unlocked key in memory is gone), then locks Bitwarden. Use it when Lock now fails."
          actionLabel="Restart browser"
          disabled={working || !info?.running}
          onPress={() => void act(async () => (await bitwarden({ action: "restart-browser" })).message)}
        />
        {values?.bitwarden ? <Text style={muted}>{BITWARDEN_PIN_NOTE}</Text> : null}
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
