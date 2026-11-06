import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import {
  agentModeError,
  DEFAULT_AGENT_SETTINGS,
  isClassifierMode,
  MAX_CHAT_QUESTIONS_LIMIT,
  parseMaxChatQuestions,
  providerFamily,
} from "../shared/agent-prompt";
import { DEFAULT_APP_LINK_TEMPLATE, validateAppLinkTemplate } from "../shared/browser-prompt";
import { parseReportMode, type ReportMode } from "../shared/report-back";
import { preferences } from "../shared/settings";
import { LauncherSettings } from "./launcher-settings";
import { UpdateSettings } from "./update-settings";

const DESKTOP_OPTIONS: { label: string; value: "app" | "web-agent" | "copy-only" | "claude-desktop" | "paseo" | "chrome" }[] = [
  { label: "ChatGPT desktop", value: "app" },
  { label: "ChatGPT web", value: "web-agent" },
  { label: "Claude desktop", value: "claude-desktop" },
  { label: "Paseo browser", value: "paseo" },
  { label: "Claude Chrome tab", value: "chrome" },
  { label: "Copy only", value: "copy-only" },
];

const MOBILE_OPTIONS: { label: string; value: "copy-only" | "web-agent" | "paseo" | "chrome" }[] = [
  { label: "Copy only", value: "copy-only" },
  { label: "ChatGPT web", value: "web-agent" },
  { label: "Paseo browser", value: "paseo" },
  { label: "Claude Chrome tab", value: "chrome" },
];

const THINKING_OPTIONS: { label: string; value: string }[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High (default)", value: "high" },
  { label: "Extra high", value: "xhigh" },
  { label: "Max", value: "max" },
];

const REPORT_OPTIONS: { label: string; value: ReportMode }[] = [
  { label: "Auto (default)", value: "auto" },
  { label: "Always send the full report", value: "full" },
  { label: "Off", value: "off" },
];

const THUMBNAIL_OPTIONS: { label: string; value: "all" | "latest" }[] = [
  { label: "All steps (default)", value: "all" },
  { label: "Latest only", value: "latest" },
];

type AgentDraft = { agentProvider: string; agentModel: string; agentMode: string };

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const input = useRef<SettingsInputHandle>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<Partial<AgentDraft>>({});
  const providerInput = useRef<SettingsInputHandle>(null);
  const modelInput = useRef<SettingsInputHandle>(null);
  const modeInput = useRef<SettingsInputHandle>(null);
  const maxQuestionsInput = useRef<SettingsInputHandle>(null);
  const [maxQuestionsDraft, setMaxQuestionsDraft] = useState<string | null>(null);
  const chromeProviderInput = useRef<SettingsInputHandle>(null);
  const [chromeProviderDraft, setChromeProviderDraft] = useState<string | null>(null);

  if (settings.status !== "ready") {
    const message = settings.status === "loading" ? "Loading..." : `Settings unavailable: ${settings.error}`;
    return <Text style={{ color: theme.colors.foregroundMuted }}>{message}</Text>;
  }
  const { values, revision } = settings;
  const template = draft ?? values.appLinkTemplate;
  const templateError = validateAppLinkTemplate(template);
  const agent: AgentDraft = {
    agentProvider: agentDraft.agentProvider ?? values.agentProvider,
    agentModel: agentDraft.agentModel ?? values.agentModel,
    agentMode: agentDraft.agentMode ?? values.agentMode,
  };
  // Allowed: ask-first modes (Claude default and plan, Oh My Pi ask) and Claude Auto mode (the
  // default). Bypass, accept-edits and other auto-approve modes are refused: Save stays disabled.
  const modeError = agentModeError(agent.agentProvider || DEFAULT_AGENT_SETTINGS.agentProvider, agent.agentMode || DEFAULT_AGENT_SETTINGS.agentMode);
  const autoModeSelected = isClassifierMode(
    agent.agentProvider || DEFAULT_AGENT_SETTINGS.agentProvider,
    agent.agentMode || DEFAULT_AGENT_SETTINGS.agentMode,
  );
  const chromeProviderText = (chromeProviderDraft ?? values.chromeProvider).trim();
  const chromeProviderError =
    chromeProviderText && providerFamily(chromeProviderText) !== "claude" ? "Claude in Chrome needs a Claude provider." : null;
  const maxQuestionsText = maxQuestionsDraft ?? String(values.maxChatQuestions);
  const maxQuestionsParsed = parseMaxChatQuestions(maxQuestionsText);
  const maxQuestionsError = "error" in maxQuestionsParsed ? maxQuestionsParsed.error : null;
  const agentDirty =
    agent.agentProvider !== values.agentProvider ||
    agent.agentModel !== values.agentModel ||
    agent.agentMode !== values.agentMode;
  const agentIsDefault =
    values.agentProvider === DEFAULT_AGENT_SETTINGS.agentProvider &&
    values.agentModel === DEFAULT_AGENT_SETTINGS.agentModel &&
    values.agentMode === DEFAULT_AGENT_SETTINGS.agentMode &&
    values.agentThinking === DEFAULT_AGENT_SETTINGS.agentThinking;
  const thinkingOptions = THINKING_OPTIONS.some((option) => option.value === values.agentThinking)
    ? THINKING_OPTIONS
    : [...THINKING_OPTIONS, { label: values.agentThinking || "Provider default", value: values.agentThinking }];

  return (
    <>
      <SettingsSection title="Browser prompts">
        <SettingsCard>
          <SettingsSelect
            label="Usual way to start (desktop)"
            hint="Highlighted on the card. The card always offers every way. The Command Center opens ChatGPT as chosen here, or the ChatGPT app when this is a Paseo agent."
            value={values.startMode}
            options={DESKTOP_OPTIONS}
            onValueChange={(startMode) => void settings.save({ ...values, startMode }, revision)}
          />
          <SettingsSelect
            label="Usual way to start (iOS and Android)"
            hint="Highlighted on the card. ChatGPT documents no mobile deep link for a new prompt, so the card has no ChatGPT app button there."
            value={values.mobileStartMode}
            options={MOBILE_OPTIONS}
            onValueChange={(mobileStartMode) => void settings.save({ ...values, mobileStartMode }, revision)}
          />
          <SettingsInput
            ref={input}
            label="ChatGPT app deep link"
            hint={`{prompt} is replaced by the encoded prompt. Default: ${DEFAULT_APP_LINK_TEMPLATE}`}
            error={templateError ?? undefined}
            initialValue={values.appLinkTemplate}
            placeholder={DEFAULT_APP_LINK_TEMPLATE}
            onChangeText={setDraft}
          />
          <SettingsAction
            label="Save deep link"
            actionLabel="Save"
            disabled={draft === null || draft === values.appLinkTemplate || templateError !== null}
            onPress={async () => {
              if (await settings.save({ ...values, appLinkTemplate: template.trim() }, revision)) setDraft(null);
            }}
          />
          <SettingsAction
            label="Reset deep link to default"
            actionLabel="Reset"
            disabled={values.appLinkTemplate === DEFAULT_APP_LINK_TEMPLATE && draft === null}
            onPress={async () => {
              input.current?.replaceText(DEFAULT_APP_LINK_TEMPLATE);
              if (await settings.save({ ...values, appLinkTemplate: DEFAULT_APP_LINK_TEMPLATE }, revision)) setDraft(null);
            }}
          />
          <SettingsSwitch
            label="Collapse repeated blocks that are done"
            hint="A block with the same title and steps as an earlier one in the chat is a full card that shares its done mark and run, with “Also shown earlier in this chat”. Once it is done, later copies show “✓ Already done · Show”; Show opens the card in place. Off: every block is a full card without the hint."
            value={values.mergeRepeats}
            onValueChange={(mergeRepeats) => void settings.save({ ...values, mergeRepeats }, revision)}
          />
          <SettingsAction
            label="Done marks"
            hint={`${values.done.length} prompt(s) marked done on this host.`}
            actionLabel="Clear"
            disabled={values.done.length === 0}
            onPress={() => void settings.save({ ...values, done: [] }, revision)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Run with Paseo agent">
        <SettingsCard>
          <SettingsSwitch
            label="Confirm before starting"
            hint="Ask “Start a Paseo agent to do these steps in your browser?” first."
            value={values.confirmAgentLaunch}
            onValueChange={(confirmAgentLaunch) => void settings.save({ ...values, confirmAgentLaunch }, revision)}
          />
          <SettingsSwitch
            label="Open the agent when started"
            hint="Off: the agent works in the background and the card shows its status and an Open link. On: its view opens right away."
            value={values.openAgentOnStart}
            onValueChange={(openAgentOnStart) => void settings.save({ ...values, openAgentOnStart }, revision)}
          />
          <SettingsSwitch
            label="Show step progress"
            hint="The agent marks each step as it starts it, and the card shows “Step N of M” with a progress bar."
            value={values.showStepProgress}
            onValueChange={(showStepProgress) => void settings.save({ ...values, showStepProgress }, revision)}
          />
          <SettingsSwitch
            label="Show live screenshot"
            hint="The agent takes a screenshot of the visible page after each step (never of pages showing secrets), and the card shows them (see Thumbnails). Screenshots stay in your Paseo app and are never sent to a chat. Each one adds to the agent's token use. Needs Paseo 0.13 or later to show, and the run's browser tab visible in the app: Paseo cannot capture a hidden tab, so a run in the background stops taking screenshots after the first one fails."
            value={values.showLiveScreenshot}
            onValueChange={(showLiveScreenshot) => void settings.save({ ...values, showLiveScreenshot }, revision)}
          />
          <SettingsSelect
            label="Thumbnails"
            hint="All steps: one thumbnail per step with its step number, side by side when the card is wide enough, as a horizontal strip otherwise, and only the latest on very narrow screens. Latest only: just the newest screenshot."
            value={values.thumbnailMode}
            options={THUMBNAIL_OPTIONS}
            disabled={!values.showLiveScreenshot}
            onValueChange={(thumbnailMode) => void settings.save({ ...values, thumbnailMode: thumbnailMode === "latest" ? "latest" : "all" }, revision)}
          />
          <SettingsSwitch
            label="Close tabs after a successful run"
            hint="When every step succeeded, the agent closes the browser tabs it opened itself for the run, as its last action before its report, and names their sites in the report. Tabs that were already open stay open, and a run that fails, stops or still needs you leaves every tab open so you can see where it stopped. In Always Ask mode you approve the close like any other new tool. This is an instruction in the agent's prompt, not enforced: how well it holds depends on the provider and model, which may close the wrong tab or none."
            value={values.closeTabsOnSuccess}
            onValueChange={(closeTabsOnSuccess) => void settings.save({ ...values, closeTabsOnSuccess }, revision)}
          />
          <SettingsSwitch
            label="Archive the agent after a successful run"
            hint="When every step succeeded, the agent says so in the last line of its report and the plugin archives it, once the chat got the report or notice (with Report back to chat off, right away). A run that fails, stops, asks a question or leaves something for you stays open, and so does a run whose report could not be sent or that you gave a follow-up. The card keeps showing it as done, but its screenshots, time and tokens show only until the card reloads, because reading an archived agent would load it again. Applies to runs started after you turn it on."
            value={values.archiveAgentOnSuccess}
            onValueChange={(archiveAgentOnSuccess) => void settings.save({ ...values, archiveAgentOnSuccess }, revision)}
          />
          <SettingsSwitch
            label="Talk to the chat"
            hint="The agent may ask the chat that showed the card about the task (which button, which value, how to go on when the page differs). The plugin forwards each question marked as untrusted text. Not configurable: passwords, tokens, 2FA codes and approvals of destructive, security, billing, merge or publish actions are always asked of you, never of the chat."
            value={values.talkToChat}
            onValueChange={(talkToChat) => void settings.save({ ...values, talkToChat }, revision)}
          />
          <SettingsInput
            ref={maxQuestionsInput}
            label="Max questions to the chat per run"
            hint={`0 to ${MAX_CHAT_QUESTIONS_LIMIT}; 0 works like Talk to the chat off. After the limit the agent asks you instead. Default: ${DEFAULT_AGENT_SETTINGS.maxChatQuestions}.`}
            error={maxQuestionsError ?? undefined}
            initialValue={String(values.maxChatQuestions)}
            placeholder={String(DEFAULT_AGENT_SETTINGS.maxChatQuestions)}
            disabled={!values.talkToChat}
            onChangeText={setMaxQuestionsDraft}
          />
          <SettingsAction
            label="Save max questions"
            actionLabel="Save"
            disabled={maxQuestionsDraft === null || maxQuestionsError !== null || ("value" in maxQuestionsParsed && maxQuestionsParsed.value === values.maxChatQuestions)}
            onPress={async () => {
              if (!("value" in maxQuestionsParsed)) return; // never store an invalid cap
              if (await settings.save({ ...values, maxChatQuestions: maxQuestionsParsed.value }, revision)) setMaxQuestionsDraft(null);
            }}
          />
          <SettingsSelect
            label="Report back to chat"
            hint="When the agent finishes or fails, tell the chat that showed the card. Auto forwards the report only to chats in an ask-first mode and sends a status-only notice otherwise. Always forwards it to any chat, including ones that act without approval; the report can contain text from web pages."
            value={values.reportBack}
            options={REPORT_OPTIONS}
            onValueChange={(reportBack) => void settings.save({ ...values, reportBack: parseReportMode(reportBack) }, revision)}
          />
          <SettingsInput
            ref={providerInput}
            label="Provider"
            hint={`Paseo provider id. Default: ${DEFAULT_AGENT_SETTINGS.agentProvider} (Anthropic).`}
            initialValue={values.agentProvider}
            placeholder={DEFAULT_AGENT_SETTINGS.agentProvider}
            onChangeText={(agentProvider) => setAgentDraft((d) => ({ ...d, agentProvider }))}
          />
          <SettingsInput
            ref={modelInput}
            label="Model"
            hint={`Default: ${DEFAULT_AGENT_SETTINGS.agentModel} (Claude Sonnet 5.5).`}
            initialValue={values.agentModel}
            placeholder={DEFAULT_AGENT_SETTINGS.agentModel}
            onChangeText={(agentModel) => setAgentDraft((d) => ({ ...d, agentModel }))}
          />
          <SettingsInput
            ref={modeInput}
            label="Permission mode"
            hint="Default: auto (Claude Auto mode). Also allowed: default (Always Ask) and plan for Claude, ask for Oh My Pi. Bypass and accept-edits modes are refused. Claude in Chrome on the card uses this mode too: in Auto mode a classifier approves actions in your real Chrome, with every account you are signed in to, and the extension skips its check per site."
            error={modeError ?? undefined}
            initialValue={values.agentMode}
            placeholder={DEFAULT_AGENT_SETTINGS.agentMode}
            onChangeText={(agentMode) => setAgentDraft((d) => ({ ...d, agentMode }))}
          />
          {autoModeSelected ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 10 }}>
              In Auto mode a model classifier reviews this agent&apos;s tool calls instead of asking you each time. The
              agent is told to ask you, as a question, before secrets, anything destructive or irreversible, merges,
              payments and security changes. Choose default (Always Ask) to approve every new tool yourself. Auto mode
              needs Claude Code on the Anthropic API (not Bedrock or Vertex).
            </Text>
          ) : null}
          <SettingsAction
            label="Save agent provider, model and mode"
            actionLabel="Save"
            disabled={!agentDirty || modeError !== null}
            onPress={async () => {
              if (modeError !== null) return; // never store a refused mode
              const next = {
                agentProvider: agent.agentProvider.trim() || DEFAULT_AGENT_SETTINGS.agentProvider,
                agentModel: agent.agentModel.trim() || DEFAULT_AGENT_SETTINGS.agentModel,
                agentMode: agent.agentMode.trim() || DEFAULT_AGENT_SETTINGS.agentMode,
              };
              if (await settings.save({ ...values, ...next }, revision)) setAgentDraft({});
            }}
          />
          <SettingsInput
            ref={chromeProviderInput}
            label="Claude in Chrome provider"
            hint="Paseo provider for the agent's Chrome button (Claude in Chrome). The extension only connects when the agent uses its Claude account, so add a provider for that account to the daemon's config.json (see the README) and name it here. Empty: claude-chrome when the daemon has that provider, else the Provider above."
            error={chromeProviderError ?? undefined}
            initialValue={values.chromeProvider}
            placeholder="claude-chrome"
            onChangeText={setChromeProviderDraft}
          />
          <SettingsAction
            label="Save Claude in Chrome provider"
            actionLabel="Save"
            disabled={chromeProviderDraft === null || chromeProviderError !== null || chromeProviderText === values.chromeProvider}
            onPress={async () => {
              if (chromeProviderError !== null) return;
              if (await settings.save({ ...values, chromeProvider: chromeProviderText }, revision)) setChromeProviderDraft(null);
            }}
          />
          <SettingsSelect
            label="Thinking"
            value={values.agentThinking}
            options={thinkingOptions}
            onValueChange={(agentThinking) => void settings.save({ ...values, agentThinking }, revision)}
          />
          <SettingsAction
            label="Reset agent settings to default"
            hint="Claude Sonnet 5.5, thinking high, Auto mode."
            actionLabel="Reset"
            disabled={agentIsDefault && !agentDirty}
            onPress={async () => {
              providerInput.current?.replaceText(DEFAULT_AGENT_SETTINGS.agentProvider);
              modelInput.current?.replaceText(DEFAULT_AGENT_SETTINGS.agentModel);
              modeInput.current?.replaceText(DEFAULT_AGENT_SETTINGS.agentMode);
              const defaults = {
                agentProvider: DEFAULT_AGENT_SETTINGS.agentProvider,
                agentModel: DEFAULT_AGENT_SETTINGS.agentModel,
                agentMode: DEFAULT_AGENT_SETTINGS.agentMode,
                agentThinking: DEFAULT_AGENT_SETTINGS.agentThinking,
              };
              if (await settings.save({ ...values, ...defaults }, revision)) setAgentDraft({});
            }}
          />
          <SettingsAction
            label="Agent links on cards"
            hint={`${values.runs.length} card(s) remember a started agent on this host.`}
            actionLabel="Clear"
            disabled={values.runs.length === 0}
            onPress={() => void settings.save({ ...values, runs: [] }, revision)}
          />
        </SettingsCard>
      </SettingsSection>
      <LauncherSettings theme={theme} />
      <UpdateSettings theme={theme} />
    </>
  );
}
