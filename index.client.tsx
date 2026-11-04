import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RUN_SCREEN_ID, setOpenScreen, setOpenSettings, SETTINGS_SCREEN_ID } from "./client/agent-run";
import { BrowserPromptCard, cardSchema, MarkdownSegment, markdownSchema } from "./client/card";
import { chatGptMode, effectiveMode, getLastSeenPrompt, getRememberedModes, startInChatGpt } from "./client/launch";
import { AgentRunScreen } from "./client/run-screen";
import { SettingsScreen } from "./client/settings-screen";
import { CARD_KIND, explodeMessage, MARKDOWN_KIND } from "./shared/browser-prompt";
import { markRepeatsInMessage } from "./shared/repeats";
import { stashPrompt } from "./shared/trampoline";

export default function contribute(client: PluginClientContext) {
  setOpenScreen((input) => client.openScreen(input));
  setOpenSettings((id) => client.openSettings(id));
  client.addScreen({
    id: RUN_SCREEN_ID,
    title: (params) => params.title || "Paseo browser agent",
    Component: AgentRunScreen,
  });
  client.addTimelineTransformer({
    id: "browser-prompt",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      const messageId = typeof item.messageId === "string" && item.messageId ? item.messageId : undefined;
      const items = explodeMessage(item.text, phase, messageId);
      return items ? { items: markRepeatsInMessage(items) } : undefined;
    },
  });
  client.addTimelineRenderer({
    kind: MARKDOWN_KIND,
    version: 1,
    schema: markdownSchema,
    Component: MarkdownSegment,
  });
  client.addTimelineRenderer({
    kind: CARD_KIND,
    version: 1,
    schema: cardSchema,
    Component: BrowserPromptCard,
  });
  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Browser prompts",
    icon: "Globe",
    Component: SettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-last-browser-prompt",
    title: "Open last browser prompt in ChatGPT",
    icon: "Globe",
    keywords: ["browser prompt", "chatgpt", "chrome extension"],
    context: "global",
    async onSelect({ rpc }) {
      const last = getLastSeenPrompt();
      if (!last) throw new Error("No browser prompt has been shown in this app session yet.");
      const result = await startInChatGpt(last.title, last.text, chatGptMode(effectiveMode(getRememberedModes())), (prompt) =>
        rpc(stashPrompt, { prompt }),
      );
      if (!result.ok) throw new Error(result.message);
    },
  });
  return () => {
    setOpenScreen(null);
    setOpenSettings(null);
  };
}
