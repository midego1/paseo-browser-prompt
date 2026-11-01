import type { PluginHookContext, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";

/** The `addHook` names for the deprecated `on` event names this plugin uses. */
export const HOOK_NAMES = {
  "agent.turn_started": "agent.turn.before",
  "agent.turn_ended": "agent.turn.after",
  "agent.permission_requested": "agent.permission.before",
} as const;
export type HookEvent = keyof typeof HOOK_NAMES;

type HookHandler<Name extends HookEvent> = (event: PluginLifecycleEvents[Name], context: PluginHookContext) => Promise<void>;
/** `addHook` as newer hosts pass it; the 0.14 plugin SDK and the Paseo 0.14 daemon do not have it. */
type AddHook = (name: (typeof HOOK_NAMES)[HookEvent], handler: (payload: never, context: PluginHookContext) => Promise<void>) => () => void;
export type HookServer = Pick<PluginServerContext, "on"> & { addHook?: AddHook };

/**
 * Registers a lifecycle hook with `addHook` and its new name when the host has it, else with the
 * deprecated `server.on` (removed after 2027-04-30). Both deliver the same payload, and the daemon
 * does not wait for these hooks. Returns the unsubscribe function.
 */
export function addLifecycleHook<Name extends HookEvent>(server: HookServer, name: Name, handler: HookHandler<Name>): () => void {
  if (typeof server.addHook === "function") return server.addHook(HOOK_NAMES[name], handler as (payload: never, context: PluginHookContext) => Promise<void>);
  return server.on(name, handler);
}
