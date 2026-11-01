// Demo only. A scripted stand-in model (provider "claude-demo") for recording the README video
// against an isolated, throwaway Paseo daemon. See scripts/demo/README.md.
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createStandInProvider, takePendingAnswer } from "./server/provider";

type AddHook = (name: "agent.turn.after", handler: (payload: unknown, context: PluginHookContext) => Promise<void>) => () => void;

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createStandInProvider());
  // A scripted model cannot call the Paseo send_agent_prompt tool, so when the stand-in chat has
  // written its answer to a run's question, deliver it the same way: as a message to that run.
  const deliver = async (_event: unknown, { paseo }: PluginHookContext) => {
    const answer = takePendingAnswer();
    if (answer) await paseo.agents.ref(answer.runId).send(answer.text, { activeTurnBehavior: "steer" });
  };
  // `addHook` where the daemon has it, else the deprecated `on` (Paseo 0.14), as server/hooks.ts does.
  const addHook = (server as PluginServerContext & { addHook?: AddHook }).addHook;
  const off = typeof addHook === "function" ? addHook.call(server, "agent.turn.after", deliver) : server.on("agent.turn_ended", deliver);
  return () => off();
}
