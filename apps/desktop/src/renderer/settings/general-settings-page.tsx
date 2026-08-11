import { useMemo, useState } from "react";
import { PersonalizationSettingsSection } from "./personalization-settings-section";
import {
  SettingsActions,
  SettingsField,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "./settings-section";
import type {
  AppSettings,
  ChatDefaultPermissionMode,
  NetworkProxySettings,
  UpdateAppSettingsResult,
} from '@maka/core/settings';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { TestProxyInput } from "@maka/core/settings/network-settings";
import { buildChatModelChoices } from "@maka/core/chat-model-choice";
import {
  Button,
  FormLayout,
  TextInput,
  NumberInput,
  ModelPicker,
  PermissionModeSelect,
  Selector,
  Switch,
  modelChoiceValue,
  modelMenuGroups,
  parseModelChoiceValue,
  useMountedRef,
  useToast,
  useUiLocale,
  Banner,
} from "@maka/ui";
import { ProviderBrandMark } from "./provider-brand-marks";
import { PasswordInput } from "./password-input";
import { getConversationCopy } from '@maka/ui';
import { settingsActionErrorMessage } from "./settings-error-copy";
import { useActionGuard, useKeyedActionGuard } from "./use-action-guard";
import { useOptimisticSettingsDraft } from "./use-optimistic-settings-draft";
import { getSettingsPreferencesCopy } from "../locales/settings-preferences-copy.js";
import { settingsTestResultMessage } from "../locales/settings-test-result-copy.js";
import { getShellCopy } from "../locales/shell-copy.js";

export function GeneralSettingsPage(props: {
  settings: AppSettings;
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
  onRefreshConnections(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).general;
  const sections = getSettingsPreferencesCopy(locale).sections;
  const toast = useToast();
  return (
    <SettingsPage>
      {/* Designer audit P2-13: identity fields (显示名称/界面语言/语气偏好)
          moved here from the 外观 page — they configure who you are to the
          app, not how the app looks. The component keeps its save flow. */}
      <PersonalizationSettingsSection
        settings={props.settings}
        onUpdate={props.onUpdate}
      />
      <SettingsSection
        title={sections.privacy}
        description={sections.privacyHelp}
      >
        <SettingsRow
          label={copy.incognito}
          description={copy.incognitoHelp}
          end={
            <Switch
              label={copy.enableIncognito}
              isLabelHidden
              value={props.settings.privacy.incognitoActive}
              changeAction={async (incognitoActive) => {
                try {
                  await props.onUpdate({ privacy: { incognitoActive } });
                } catch (error: unknown) {
                  toast.error(
                    copy.incognitoFailed,
                    settingsActionErrorMessage(error, locale),
                  );
                }
              }}
            />
          }
        />
        <SettingsRow
          label={copy.notifications}
          description={copy.notificationsHelp}
          end={
            <Switch
              label={copy.notifications}
              isLabelHidden
              value={props.settings.notifications.runComplete}
              changeAction={async (runComplete) => {
                try {
                  await props.onUpdate({ notifications: { runComplete } });
                } catch (error: unknown) {
                  toast.error(
                    copy.notificationsFailed,
                    settingsActionErrorMessage(error, locale),
                  );
                }
              }}
            />
          }
        />
        <SettingsRow
          label={copy.workspaceInstructions}
          description={copy.workspaceInstructionsHelp}
          end={
            <Switch
              label={copy.workspaceInstructions}
              isLabelHidden
              value={props.settings.workspaceInstructions.enabled}
              changeAction={async (enabled) => {
                try {
                  await props.onUpdate({ workspaceInstructions: { enabled } });
                } catch (error: unknown) {
                  toast.error(
                    copy.workspaceInstructionsFailed,
                    settingsActionErrorMessage(error, locale),
                  );
                }
              }}
            />
          }
        />
      </SettingsSection>
      <GeneralDefaultsCard
        connections={props.connections}
        defaultSlug={props.defaultSlug}
        onRefresh={props.onRefreshConnections}
        permissionMode={props.settings.chatDefaults.permissionMode}
        thinkingLevel={props.settings.chatDefaults.thinkingLevel}
        onUpdate={props.onUpdate}
      />
      <SettingsSection
        title={sections.network}
        description={sections.networkHelp}
      >
        <NetworkProxySection
          settings={props.settings}
          onUpdate={props.onUpdate}
        />
      </SettingsSection>
    </SettingsPage>
  );
}

/**
 * PR-GENERAL-DEFAULTS-CONFIGURABLE-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
 * the General page used to ship three read-only `<SettingRow>` lines
 * (启动 / 新对话模式 / 默认模型) that read like settings but had no
 * configurable backing — the static text was the entire UI. Drop the
 * two without backing storage; replace the third with a real
 * Astryx `<Selector>` that lets the user pick the default LLM model
 * inline. The selection is grouped by connection, but the persisted
 * default is the pair `{ slug, model }` via `connections.setDefaultModel`.
 *
 * PR-DEFAULT-PERMISSION-MODE-0: the composer's per-session boundary picker
 * did not previously control what a *new* chat starts on. Added
 * a second picker right below 默认模型, backed by
 * `settings.chatDefaults.permissionMode` (persisted via the generic
 * `settings.update` patch, unlike the model picker's dedicated
 * `connections.setDefaultModel` IPC). Renders the shared Astryx-backed
 * `PermissionModeSelect` so labels, hints, and markup can't drift from the
 * composer picker.
 */
/** Sentinel for "no preference" — Selector needs a value, absence is not one. */
const FOLLOW_MODEL_DEFAULT = "__follow_model__";
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function GeneralDefaultsCard(props: {
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  permissionMode: ChatDefaultPermissionMode;
  thinkingLevel?: ThinkingLevel;
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).general;
  // Level names come from the composer's own map — one vocabulary for the
  // levels, so the settings row and the in-chat menu can never disagree.
  const conversationCopy = getConversationCopy(locale);
  const sections = getSettingsPreferencesCopy(locale).sections;
  const boundaryCopy = getShellCopy(locale).sessionSettingsActions;
  const toast = useToast();
  const mountedRef = useMountedRef();
  const persistGuard = useKeyedActionGuard<
    "default-model" | "permission-mode" | "thinking-level"
  >();
  const [saving, setSaving] = useState(false);
  const [savingPermissionMode, setSavingPermissionMode] = useState(false);
  const [savingThinkingLevel, setSavingThinkingLevel] = useState(false);

  const modelChoices = useMemo(
    () => buildChatModelChoices(props.connections),
    [props.connections],
  );
  const modelGroups = useMemo(
    () => modelMenuGroups(modelChoices, locale),
    [locale, modelChoices],
  );
  const selectedValue = useMemo(() => {
    if (!props.defaultSlug) return "";
    const connection = props.connections.find(
      (candidate) => candidate.slug === props.defaultSlug,
    );
    if (!connection?.defaultModel) return "";
    const value = modelChoiceValue(connection.slug, connection.defaultModel);
    return modelChoices.some(
      (choice) =>
        modelChoiceValue(choice.connectionSlug, choice.model) === value,
    )
      ? value
      : "";
  }, [modelChoices, props.connections, props.defaultSlug]);
  async function persistDefault(nextValue: string) {
    const releaseSave = persistGuard.begin("default-model");
    if (!releaseSave) return;
    setSaving(true);
    try {
      const parsed = parseModelChoiceValue(nextValue);
      await window.maka.connections.setDefaultModel(
        parsed
          ? {
              slug: parsed.llmConnectionSlug,
              model: parsed.model,
            }
          : null,
      );
      if (!mountedRef.current) return;
      await props.onRefresh();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          copy.saveDefaultModelFailed,
          settingsActionErrorMessage(error, locale),
        );
      }
    } finally {
      releaseSave();
      if (mountedRef.current) setSaving(false);
    }
  }

  async function persistPermissionMode(nextMode: ChatDefaultPermissionMode) {
    // Same re-entrancy guard as persistDefault above: the disabled trigger
    // alone can't fully prevent overlapping saves (React disables it a tick
    // after the click), and overlapping settings.update calls have no
    // ordering guarantee.
    const releaseSave = persistGuard.begin("permission-mode");
    if (!releaseSave) return;
    if (nextMode === "bypass" && props.permissionMode !== "bypass") {
      let confirmed = false;
      try {
        confirmed = await toast.confirm({
          title: boundaryCopy.bypassConfirmTitle,
          description: boundaryCopy.bypassConfirmDescription,
          confirmLabel: boundaryCopy.bypassConfirmLabel,
          cancelLabel: boundaryCopy.bypassCancelLabel,
          destructive: true,
        });
      } catch (error) {
        releaseSave();
        if (mountedRef.current) {
          toast.error(
            copy.saveDefaultPermissionFailed,
            settingsActionErrorMessage(error, locale),
          );
        }
        return;
      }
      if (!confirmed) {
        releaseSave();
        return;
      }
    }
    setSavingPermissionMode(true);
    try {
      await props.onUpdate({ chatDefaults: { permissionMode: nextMode } });
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          copy.saveDefaultPermissionFailed,
          settingsActionErrorMessage(error, locale),
        );
      }
    } finally {
      releaseSave();
      if (mountedRef.current) setSavingPermissionMode(false);
    }
  }

  async function persistThinkingLevel(next: ThinkingLevel | undefined) {
    const releaseSave = persistGuard.begin("thinking-level");
    if (!releaseSave) return;
    setSavingThinkingLevel(true);
    try {
      await props.onUpdate({ chatDefaults: { thinkingLevel: next } });
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.saveDefaultThinkingFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      releaseSave();
      if (mountedRef.current) setSavingThinkingLevel(false);
    }
  }

  return (
    <SettingsSection
      title={sections.chatDefaults}
      description={sections.chatDefaultsHelp}
    >
      <SettingsRow
        label={copy.defaultModel}
        description={copy.defaultModelHelp}
        end={
          <ModelPicker
            groups={modelGroups}
            value={selectedValue}
            leadingOption={{ value: "", label: copy.notSet }}
            renderProviderMark={(type) => <ProviderBrandMark type={type} />}
            ariaLabel={copy.defaultModel}
            disabled={saving}
            loading={saving}
            triggerClassName="settingsModelPickerTrigger"
            onValueChange={persistDefault}
          />
        }
      />
      <SettingsRow
        label={copy.defaultPermission}
        description={copy.defaultPermissionHelp}
        end={
          <PermissionModeSelect
            activeMode={props.permissionMode}
            onSelect={(mode) => {
              void persistPermissionMode(mode);
            }}
            align="end"
            disabled={savingPermissionMode}
            ariaLabel={copy.defaultPermission}
          />
        }
      />
      {/* The absent option is first and means exactly that: no preference, so
          each model uses its own. It is not a level, which is why the composer
          menu now calls that same state 模型默认 rather than 默认 — the old
          wording promised a knob that did not exist anywhere. */}
      <SettingsRow
        label={copy.defaultThinking}
        description={copy.defaultThinkingHelp}
        end={
          <Selector
            label={copy.defaultThinking}
            isLabelHidden
            value={props.thinkingLevel ?? FOLLOW_MODEL_DEFAULT}
            onChange={(value) => {
              void persistThinkingLevel(
                value === FOLLOW_MODEL_DEFAULT ? undefined : (value as ThinkingLevel),
              );
            }}
            options={[
              { value: FOLLOW_MODEL_DEFAULT, label: copy.followModelDefault },
              ...THINKING_LEVELS.map((level) => ({
                value: level,
                label: conversationCopy.model.level[level],
              })),
            ]}
            isDisabled={savingThinkingLevel}
          />
        }
      />
    </SettingsSection>
  );
}

function NetworkProxySection(props: {
  settings: AppSettings;
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).general;
  const persistedProxy = props.settings.network.proxy;
  const [testing, setTesting] = useState(false);
  const proxyTestGuard = useActionGuard<"test">();
  const toast = useToast();
  const {
    draft: proxyDraft,
    draftRef: proxyDraftRef,
    mountedRef: networkPageMountedRef,
    update,
  } = useOptimisticSettingsDraft<NetworkProxySettings>(
    persistedProxy,
    (patch) =>
      props
        .onUpdate({ network: { proxy: patch } })
        .then((result) => result.settings.network.proxy),
    {
      onError: (error) =>
        toast.error(
          copy.saveNetworkFailed,
          settingsActionErrorMessage(error, locale),
        ),
    },
  );

  function updateProxy(patch: Partial<NetworkProxySettings>) {
    return update(patch);
  }

  async function testProxy() {
    if (!proxyTestGuard.begin("test")) return;
    setTesting(true);
    try {
      const result = await window.maka.settings.testNetworkProxy(
        toProxyTestInput(proxyDraftRef.current),
      );
      const latency =
        result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : "";
      const message = settingsTestResultMessage(result, locale);
      if (result.ok && networkPageMountedRef.current) {
        toast.success(copy.proxyReachable, `${message}${latency}`);
      } else if (networkPageMountedRef.current) {
        toast.error(copy.proxyTestFailed, message);
      }
    } catch (error) {
      if (networkPageMountedRef.current) {
        toast.error(
          copy.proxyTestError,
          settingsActionErrorMessage(error, locale),
        );
      }
    } finally {
      proxyTestGuard.finish();
      if (networkPageMountedRef.current) {
        setTesting(false);
      }
    }
  }

  return (
    <>
      <SettingsRow
        label={copy.proxy}
        description={copy.proxyHelp}
        end={
          <Switch
            label={copy.enableProxy}
            isLabelHidden
            value={proxyDraft.enabled}
            onChange={(enabled) => void updateProxy({ enabled })}
          />
        }
      />
      {proxyDraft.enabled && (
        <>
          <SettingsField>
            <FormLayout direction="horizontal">
              <Selector
                value={proxyDraft.protocol}
                label={copy.proxyProtocol}
                options={[
                  { value: "http", label: "HTTP/HTTPS" },
                  { value: "https", label: "HTTPS" },
                  { value: "socks5", label: "SOCKS5" },
                ]}
                width="100%"
                onChange={(protocol) =>
                  void updateProxy({
                    protocol: protocol as NetworkProxySettings["protocol"],
                  })
                }
              />
              <TextInput
                value={proxyDraft.host}
                onChange={(value) => void updateProxy({ host: value })}
                placeholder="127.0.0.1"
                label={copy.serverAddress}
              />
              <NumberInput
                label={copy.port}
                value={proxyDraft.port || null}
                isIntegerOnly
                onChange={(value) => void updateProxy({ port: value ?? 0 })}
                placeholder="7890"
              />
            </FormLayout>
          </SettingsField>

          <SettingsRow
            label={copy.proxyAuth}
            description={copy.proxyAuthHelp}
            end={
              <Switch
                label={copy.enableProxyAuth}
                isLabelHidden
                value={proxyDraft.authEnabled}
                onChange={(authEnabled) => void updateProxy({ authEnabled })}
              />
            }
          />

          {proxyDraft.authEnabled && (
            <SettingsField>
              <FormLayout direction="horizontal">
                <TextInput
                  value={proxyDraft.username}
                  onChange={(value) => void updateProxy({ username: value })}
                  label={copy.username}
                />
                <PasswordInput
                  value={proxyDraft.password}
                  onChange={(next) => void updateProxy({ password: next })}
                  label={copy.password}
                />
              </FormLayout>
            </SettingsField>
          )}

          <SettingsField>
            <TextInput
              value={proxyDraft.bypassList.join(", ")}
              onChange={(value) =>
                void updateProxy({ bypassList: csvList(value) })
              }
              placeholder="metaso.cn, baidu.com"
              label={copy.bypassList}
              description={copy.bypassHelp}
              width="100%"
            />
          </SettingsField>

          <SettingsField>
            <Banner
              status="info"
              title={copy.autoBypass(proxyDraft.autoBypassDomains.length)}
            />
          </SettingsField>

          <SettingsActions>
            <Button
              variant="primary"
              isLoading={testing}
              onClick={() => void testProxy()}
              label={copy.testCurrent}
            />
          </SettingsActions>
        </>
      )}
    </>
  );
}

function toProxyTestInput(proxy: NetworkProxySettings): TestProxyInput {
  return {
    proxy: {
      enabled: proxy.enabled,
      type: proxy.protocol,
      host: proxy.host.trim(),
      port: proxy.port,
      username:
        proxy.authEnabled && proxy.username.trim()
          ? proxy.username.trim()
          : undefined,
      password:
        proxy.authEnabled && proxy.password ? proxy.password : undefined,
      bypassList: proxy.bypassList,
    },
  };
}

function csvList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
