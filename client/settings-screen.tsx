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
import { agentModeError, DEFAULT_AGENT_SETTINGS } from "../shared/agent-prompt";
import { DEFAULT_APP_LINK_TEMPLATE, validateAppLinkTemplate } from "../shared/browser-prompt";
import { preferences } from "../shared/settings";
import { LauncherSettings } from "./launcher-settings";
import { UpdateSettings } from "./update-settings";

const DESKTOP_OPTIONS: { label: string; value: "app" | "web-agent" | "copy-only" }[] = [
  { label: "ChatGPT app (macOS)", value: "app" },
  { label: "ChatGPT web agent", value: "web-agent" },
  { label: "Copy only", value: "copy-only" },
];

const MOBILE_OPTIONS: { label: string; value: "copy-only" | "web-agent" }[] = [
  { label: "Copy only", value: "copy-only" },
  { label: "ChatGPT web agent", value: "web-agent" },
];

const THINKING_OPTIONS: { label: string; value: string }[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High (default)", value: "high" },
  { label: "Extra high", value: "xhigh" },
  { label: "Max", value: "max" },
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
  // Only ask-first modes are allowed; bypass, auto-approve and accept-edits modes are refused.
  const modeError = agentModeError(agent.agentProvider || DEFAULT_AGENT_SETTINGS.agentProvider, agent.agentMode || DEFAULT_AGENT_SETTINGS.agentMode);
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
            label="Start in ChatGPT (desktop)"
            hint="The prompt is always copied to the clipboard first."
            value={values.startMode}
            options={DESKTOP_OPTIONS}
            onValueChange={(startMode) => void settings.save({ ...values, startMode }, revision)}
          />
          <SettingsSelect
            label="Start in ChatGPT (iOS and Android)"
            hint="ChatGPT documents no mobile deep link for a new prompt."
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
            hint="Default: default (Always Ask), so you approve tool use. Only ask-first modes are accepted; bypass, auto and accept-edits modes are refused."
            error={modeError ?? undefined}
            initialValue={values.agentMode}
            placeholder={DEFAULT_AGENT_SETTINGS.agentMode}
            onChangeText={(agentMode) => setAgentDraft((d) => ({ ...d, agentMode }))}
          />
          <SettingsAction
            label="Save agent provider, model and mode"
            actionLabel="Save"
            disabled={!agentDirty || modeError !== null}
            onPress={async () => {
              const next = {
                agentProvider: agent.agentProvider.trim() || DEFAULT_AGENT_SETTINGS.agentProvider,
                agentModel: agent.agentModel.trim() || DEFAULT_AGENT_SETTINGS.agentModel,
                agentMode: agent.agentMode.trim() || DEFAULT_AGENT_SETTINGS.agentMode,
              };
              if (await settings.save({ ...values, ...next }, revision)) setAgentDraft({});
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
            hint="Claude Sonnet 5.5, thinking high, Always Ask."
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
