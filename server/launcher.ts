/// <reference types="node" />
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import {
  chooseTrampolineHost,
  DEFAULT_TRAMPOLINE_PORT,
  type HostProbes,
  type HostSource,
  type LauncherState,
  TAILSCALE_TIMEOUT_MS,
  validatePort,
} from "../shared/trampoline-host.ts";
import { startTrampoline, type Trampoline } from "./trampoline.ts";

const TAILSCALE_BINARIES = [
  "tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function runTailscale(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["ip", "-4"], { timeout: TAILSCALE_TIMEOUT_MS }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

export const systemProbes: HostProbes = {
  async tailscaleIp() {
    let lastError: unknown = new Error("tailscale not found");
    for (const binary of TAILSCALE_BINARIES) {
      try {
        return await runTailscale(binary);
      } catch (error) {
        lastError = error;
        // A missing binary fails fast; a slow one already used its 3 s.
        if ((error as { killed?: boolean }).killed) break;
      }
    }
    throw lastError;
  },
  interfaces: () => networkInterfaces(),
};

export interface LauncherConfig {
  trampolineHost: string;
  trampolinePort: number;
}

export interface LauncherStatus {
  state: LauncherState;
  host: string | null;
  port: number;
  source: HostSource;
}

export type StashOutcome = { url: string } | { unavailable: Exclude<LauncherState, "listening"> };

type Start = (host: string, port: number) => Trampoline;

/**
 * Owns the one-time ChatGPT launcher. Picks the bind address per machine (setting, else Tailscale),
 * stays off when there is no Tailscale address or the setting is not one of this machine's
 * addresses, and restarts when the host or port setting changes.
 */
export function createLauncher(probes: HostProbes = systemProbes, start: Start = startTrampoline) {
  let current: Trampoline | null = null;
  let status: LauncherStatus = { state: "starting", host: null, port: DEFAULT_TRAMPOLINE_PORT, source: "none" };
  let applied: string | null = null;
  let generation = 0;
  let pending: Promise<void> = Promise.resolve();

  async function stop() {
    const old = current;
    current = null;
    if (old) await old.close();
  }

  async function apply(config: LauncherConfig): Promise<void> {
    const port = validatePort(config.trampolinePort) === null ? config.trampolinePort : DEFAULT_TRAMPOLINE_PORT;
    const key = `${config.trampolineHost.trim()}|${port}`;
    if (key === applied && status.state !== "error") return;
    applied = key;
    const mine = ++generation;
    await stop();
    status = { state: "starting", host: null, port, source: "none" };
    const choice = await chooseTrampolineHost(config.trampolineHost, probes);
    if (mine !== generation) return;
    if (!choice.host) {
      const reason = choice.reason ?? "no-tailscale";
      status = { state: reason, host: null, port, source: "none" };
      console.log(
        reason === "not-local"
          ? "[browser-prompt] trampoline off: the configured address is not this host's Tailscale address or 127.0.0.1"
          : "[browser-prompt] trampoline off: no Tailscale address on this host",
      );
      return;
    }
    const trampoline = start(choice.host, port);
    current = trampoline;
    await trampoline.ready;
    if (mine !== generation) return;
    const { listening, failure } = trampoline.state();
    status = {
      state: listening ? "listening" : failure === "EADDRINUSE" ? "port-in-use" : "error",
      host: choice.host,
      port,
      source: choice.source,
    };
  }

  return {
    /** Applies a configuration; calls are serialized. */
    configure(config: LauncherConfig): Promise<void> {
      pending = pending.then(() => apply(config)).catch((error) => {
        console.error(`[browser-prompt] trampoline setup failed: ${error instanceof Error ? error.message : String(error)}`);
        status = { ...status, state: "error" };
      });
      return pending;
    },
    status: (): LauncherStatus => ({ ...status }),
    stash(prompt: string, template: string): StashOutcome {
      if (!current || status.state !== "listening") {
        return { unavailable: status.state === "listening" ? "error" : status.state };
      }
      try {
        return { url: current.stash(prompt, template) };
      } catch {
        return { unavailable: "error" };
      }
    },
    async close() {
      generation++;
      await pending.catch(() => undefined);
      await stop();
    },
  };
}
