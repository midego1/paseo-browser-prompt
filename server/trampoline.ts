/// <reference types="node" />
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  buildAppLink,
  DEFAULT_APP_LINK_TEMPLATE,
  renderTrampolinePage,
  trampolineHeaders,
} from "../shared/browser-prompt.ts";

import { DEFAULT_TRAMPOLINE_PORT } from "../shared/trampoline-host.ts";

export const TRAMPOLINE_PORT = DEFAULT_TRAMPOLINE_PORT;
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

interface Entry {
  prompt: string;
  template: string;
  expiresAt: number;
}

export interface Trampoline {
  /** Stores a prompt for one fetch and returns the URL to open. Throws when the listener is down. */
  stash(prompt: string, template: string): string;
  /** Bind outcome: listening, or the error code (EADDRINUSE, ...), or null while starting. */
  state(): { listening: boolean; failure: string | null };
  /** Resolves once the listener is up or has failed. */
  ready: Promise<void>;
  close(): Promise<void>;
}

/** Binds `host:port` only. Callers pass a specific address (the Tailscale IP), never a wildcard. */
export function startTrampoline(host: string, port: number = TRAMPOLINE_PORT): Trampoline {
  const entries = new Map<string, Entry>();
  let listening = false;
  let failure: string | null = null;

  const sweep = () => {
    const now = Date.now();
    for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
  };
  const timer = setInterval(sweep, 60 * 1000);

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://trampoline.invalid");
    if (req.method !== "GET" || url.pathname !== "/open") {
      res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Not found\n");
      return;
    }
    const id = url.searchParams.get("id") ?? "";
    const entry = entries.get(id);
    entries.delete(id); // one-time: gone after the first fetch, found or not
    if (!entry || entry.expiresAt <= Date.now()) {
      res
        .writeHead(410, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("This browser prompt link has expired or was already used. The prompt is on your clipboard.\n");
      return;
    }
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, trampolineHeaders(nonce)).end(renderTrampolinePage(buildAppLink(entry.template, entry.prompt), nonce));
  });

  let settle: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    listening = false;
    failure = error.code ?? "error";
    // Never log prompt text; only the bind outcome.
    console.error(`[browser-prompt] trampoline unavailable on ${host}:${port} (${failure})`);
    settle();
  });
  server.listen(port, host, () => {
    listening = true;
    failure = null;
    console.log(`[browser-prompt] trampoline listening on ${host}:${port}`);
    settle();
  });

  return {
    ready,
    state: () => ({ listening, failure }),
    stash(prompt, template) {
      if (!listening) throw new Error(`ChatGPT launcher unavailable (${failure ?? "starting"})`);
      sweep();
      while (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const id = randomBytes(18).toString("base64url");
      entries.set(id, { prompt, template: template || DEFAULT_APP_LINK_TEMPLATE, expiresAt: Date.now() + TTL_MS });
      return `http://${host}:${port}/open?id=${id}`;
    },
    close() {
      clearInterval(timer);
      entries.clear();
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
