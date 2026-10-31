// Demo only. A scripted stand-in model (provider "claude-demo") for recording the README video
// against an isolated, throwaway Paseo daemon. See scripts/demo/README.md.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createStandInProvider, takePendingAnswer } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createStandInProvider());
  // A scripted model cannot call the Paseo send_agent_prompt tool, so when the stand-in chat has
  // written its answer to a run's question, deliver it the same way: as a message to that run.
  const off = server.on("agent.turn_ended", async (_event, { paseo }) => {
    const answer = takePendingAnswer();
    if (answer) await paseo.agents.ref(answer.runId).send(answer.text, { activeTurnBehavior: "steer" });
  });
  return () => off();
}
