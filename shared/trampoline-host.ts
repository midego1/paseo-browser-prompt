// Pure logic for choosing the ChatGPT launcher's bind address on this machine.
// Import-free so the unit tests can load it with `node --experimental-strip-types`.

export const DEFAULT_TRAMPOLINE_PORT = 5299;
export const TAILSCALE_TIMEOUT_MS = 3000;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function octets(ip: string): number[] | null {
  const match = IPV4.exec(ip.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

/** Tailscale hands out IPv4 addresses from the CGNAT range 100.64.0.0/10 (100.64.x.x to 100.127.x.x). */
export function isTailscaleIPv4(ip: string): boolean {
  const parts = octets(ip);
  return parts !== null && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/** First Tailscale address in `tailscale ip -4` output. */
export function parseTailscaleIp(stdout: string): string | null {
  for (const line of stdout.split(/\s+/)) if (isTailscaleIPv4(line)) return line.trim();
  return null;
}

export interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

/** Shape of `os.networkInterfaces()`. */
export type InterfaceTable = Record<string, InterfaceAddress[] | undefined>;

/** Interface names Tailscale uses: `tailscale0` on Linux, `utunN` on macOS. */
export function isTailscaleInterfaceName(name: string): boolean {
  return /^(tailscale|utun)/i.test(name);
}

/**
 * Fallback when `tailscale ip -4` is unavailable: a non-internal IPv4 address in 100.64.0.0/10 on a
 * Tailscale-named interface (`tailscale*` first, then `utun*`). Other interfaces in that range
 * (carrier-grade NAT, other VPNs) are never chosen.
 */
export function pickTailscaleInterface(table: InterfaceTable): string | null {
  const names = Object.keys(table)
    .filter(isTailscaleInterfaceName)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const name of names) {
    for (const entry of table[name] ?? []) {
      const ipv4 = entry.family === "IPv4" || entry.family === 4;
      if (ipv4 && !entry.internal && isTailscaleIPv4(entry.address)) return entry.address;
    }
  }
  return null;
}

function rank(name: string): number {
  return /^tailscale/i.test(name) ? 0 : 1;
}

/** Loopback is allowed as an explicit setting: reachable only from this machine. */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Checks the bind-address setting's shape. Only this machine's own Tailscale (100.64.0.0/10)
 * IPv4 address or 127.0.0.1 is accepted; wildcards, LAN/public addresses and host names are refused.
 * Ownership is checked again when the launcher starts.
 */
export function validateConfiguredHost(value: string): string | null {
  const host = value.trim();
  if (!host) return null;
  if (host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*") {
    return "Wildcard addresses are not allowed. Leave empty for the Tailscale address.";
  }
  if (host === LOOPBACK_HOST || isTailscaleIPv4(host)) return null;
  return "Enter this machine's Tailscale IPv4 address (100.64.0.0/10) or 127.0.0.1, or leave empty.";
}

/** This machine's Tailscale IPv4 addresses, from `tailscale ip -4` and Tailscale-named interfaces. */
function ownAddresses(table: InterfaceTable | null, tailscaleOutput: string): Set<string> {
  const own = new Set<string>();
  for (const [name, entries] of Object.entries(table ?? {})) {
    if (!isTailscaleInterfaceName(name)) continue;
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === "IPv4" || entry.family === 4;
      if (ipv4 && isTailscaleIPv4(entry.address)) own.add(entry.address.trim());
    }
  }
  for (const word of tailscaleOutput.split(/\s+/)) if (isTailscaleIPv4(word)) own.add(word.trim());
  return own;
}

export function validatePort(port: number): string | null {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? null : "Port must be between 1024 and 65535.";
}

export type HostSource = "setting" | "tailscale" | "interfaces" | "none";

/** Why no address was chosen: no Tailscale address, or a setting that is not this machine's. */
export type NoHostReason = "no-tailscale" | "not-local";

export interface HostChoice {
  host: string | null;
  source: HostSource;
  /** Set when `host` is null. */
  reason?: NoHostReason;
}

export interface HostProbes {
  /** Runs `tailscale ip -4` with a 3 s timeout; rejects when it is missing, slow or fails. */
  tailscaleIp(): Promise<string>;
  interfaces(): InterfaceTable;
}

/**
 * Bind address for the launcher. A setting is used only when it is 127.0.0.1 or a Tailscale address
 * assigned to this machine; otherwise the launcher stays off. Without a setting: the Tailscale CLI's
 * IPv4, else an interface address in 100.64.0.0/10, else none (the launcher then stays off).
 */
export async function chooseTrampolineHost(configured: string, probes: HostProbes): Promise<HostChoice> {
  const setting = configured.trim();
  let cliOutput = "";
  let cliFailed = false;
  try {
    cliOutput = await probes.tailscaleIp();
  } catch {
    cliFailed = true;
  }
  let table: InterfaceTable | null = null;
  try {
    table = probes.interfaces();
  } catch {
    // no interfaces readable
  }
  if (setting) {
    if (validateConfiguredHost(setting) !== null) return { host: null, source: "none", reason: "not-local" };
    if (setting === LOOPBACK_HOST || ownAddresses(table, cliOutput).has(setting)) return { host: setting, source: "setting" };
    return { host: null, source: "none", reason: "not-local" };
  }
  const fromCli = cliFailed ? null : parseTailscaleIp(cliOutput);
  if (fromCli) return { host: fromCli, source: "tailscale" };
  const fromInterfaces = table ? pickTailscaleInterface(table) : null;
  if (fromInterfaces) return { host: fromInterfaces, source: "interfaces" };
  return { host: null, source: "none", reason: "no-tailscale" };
}

export type LauncherState = "starting" | "listening" | "no-tailscale" | "not-local" | "port-in-use" | "error";

export const LAUNCHER_UNAVAILABLE_MESSAGES: Record<Exclude<LauncherState, "listening">, string> = {
  starting: "ChatGPT launcher is starting",
  "no-tailscale": "ChatGPT launcher needs Tailscale on this host",
  "not-local": "ChatGPT launcher address is not one of this host's addresses",
  "port-in-use": "ChatGPT launcher port is in use on this host",
  error: "ChatGPT launcher is unavailable on this host",
};
