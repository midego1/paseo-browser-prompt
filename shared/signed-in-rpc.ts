import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SIGNED_IN_STATES } from "./signed-in";

const state = z.enum(SIGNED_IN_STATES);

/**
 * The signed-in Server browser's state on this host. `build: true` (only from the settings' Download
 * and build after its confirmation, the owner's explicit choice) downloads and builds missing images.
 */
export const signedInStatus = defineRpc({
  name: "signed-in.status",
  input: z.object({ build: z.boolean().optional() }),
  output: z.object({
    state,
    image: z.string(),
    serverImage: z.string(),
    running: z.boolean(),
    viewers: z.number(),
    busy: z.boolean(),
    bindHost: z.string().nullable(),
    viewerOrigin: z.string().nullable(),
    detail: z.string(),
  }),
});

const refusal = z.object({ ok: z.literal(false), state, detail: z.string() });

/** Right before a signed-in run is created: starts the browser when needed and returns a one-time ticket, or why not (busy: one run at a time). */
export const prepareSignedInRun = defineRpc({
  name: "signed-in.prepare",
  input: z.object({ sourceAgentId: z.string().min(1).max(200), cardId: z.string().min(1).max(200) }),
  output: z.union([z.object({ ok: z.literal(true), ticket: z.string().min(16).max(100) }), refusal]),
});

/**
 * A one-time link to the owner's viewer (Take over, Log in to sites): the ticket is in the URL
 * fragment, valid once for a few minutes. Starts the browser when needed.
 */
export const signedInViewerLink = defineRpc({
  name: "signed-in.viewer-link",
  input: z.object({ purpose: z.enum(["login", "takeover"]), portrait: z.boolean() }),
  output: z.union([z.object({ ok: z.literal(true), url: z.string().url() }), refusal]),
});

/** Stop or restart (both keep the logins), log out of everything (removes the profile), or rotate the viewer key. */
export const signedInControl = defineRpc({
  name: "signed-in.control",
  input: z.object({ action: z.enum(["stop", "restart", "logout", "rotate-key"]) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
