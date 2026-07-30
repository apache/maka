import { useMemo, useState } from 'react';
import { PersonalizationSettingsPage } from './appearance-settings-page';
import type {
  AppSettings,
  ChatDefaultPermissionMode,
  LlmConnection,
  NetworkProxySettings,
  UpdateAppSettingsResult,
} from '@maka/core';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  NumberField,
  NumberFieldInput,
  ModelPicker,
  PermissionModeSelect,
  SettingsSelect,
  SettingsSwitch as Switch,
  modelChoiceValue,
  modelMenuGroups,
  parseModelChoiceValue,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { ProviderLogo } from './ProvidersPanel';
import { buildCatalogChatModelChoices } from '../model-catalog-choices';
import { PasswordInput } from './password-input';
import { SettingsRows } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard, useKeyedActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import { getShellCopy } from '../locales/shell-copy.js';

export function GeneralSettingsPage(props: {
  settings: AppSettings;
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onRefreshConnections(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).general;
  const toast = useToast();
  return (
    <div className="settingsStructuredPage">
      {/* Designer audit P2-13: identity fields (显示名称/界面语言/语气偏好)
          moved here from the 外观 page — they configure who you are to the
          app, not how the app looks. The component keeps its save flow. */}
      <PersonalizationSettingsPage settings={props.settings} onUpdate={props.onUpdate} />
      <SettingsRows>
        <div className="settingsFormRow">
          <div>
            <strong>{copy.incognito}</strong>
            <small>{copy.incognitoHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.enableIncognito}
            checked={props.settings.privacy.incognitoActive}
            onChange={(incognitoActive) => {
              props.onUpdate({ privacy: { incognitoActive } }).catch((error: unknown) => {
                toast.error(copy.incognitoFailed, settingsActionErrorMessage(error, locale));
              });
            }}
          />
        </div>
        <div className="settingsFormRow">
          <div>
            <strong>{copy.notifications}</strong>
            <small>{copy.notificationsHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.notifications}
            checked={props.settings.notifications.runComplete}
            onChange={(runComplete) => {
              props.onUpdate({ notifications: { runComplete } }).catch((error: unknown) => {
                toast.error(copy.notificationsFailed, settingsActionErrorMessage(error, locale));
              });
            }}
          />
        </div>
      </SettingsRows>
      <GeneralDefaultsCard
        connections={props.connections}
        defaultSlug={props.defaultSlug}
        onRefresh={props.onRefreshConnections}
        permissionMode={props.settings.chatDefaults.permissionMode}
        onUpdate={props.onUpdate}
      />
      <SettingsRows>
        <NetworkProxySection settings={props.settings} onUpdate={props.onUpdate} />
      </SettingsRows>
    </div>
  );
}

/**
 * PR-GENERAL-DEFAULTS-CONFIGURABLE-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
 * the General page used to ship three read-only `<SettingRow>` lines
 * (启动 / 新对话模式 / 默认模型) that read like settings but had no
 * configurable backing — the static text was the entire UI. Drop the
 * two without backing storage; replace the third with a real
 * `<SettingsSelect>` that lets the user pick the default LLM model
 * inline. The selection is grouped by connection, but the persisted
 * default is the pair `{ slug, model }` via `connections.setDefaultModel`.
 *
 * PR-DEFAULT-PERMISSION-MODE-0: the composer's per-session boundary picker
 * did not previously control what a *new* chat starts on. Added
 * a second picker right below 默认模型, backed by
 * `settings.chatDefaults.permissionMode` (persisted via the generic
 * `settings.update` patch, unlike the model picker's dedicated
 * `connections.setDefaultModel` IPC). Renders the shared
 * `PermissionModeSelect` (Base UI Select) so labels, hints, and markup
 * can't drift from the composer picker.
 */
function GeneralDefaultsCard(props: {
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  permissionMode: ChatDefaultPermissionMode;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).general;
  const boundaryCopy = getShellCopy(locale).sessionSettingsActions;
  const toast = useToast();
  const mountedRef = useMountedRef();
  const persistGuard = useKeyedActionGuard<'default-model' | 'permission-mode'>();
  const [saving, setSaving] = useState(false);
  const [savingPermissionMode, setSavingPermissionMode] = useState(false);

  const modelChoices = useMemo(() => buildCatalogChatModelChoices(props.connections), [props.connections]);
  const modelGroups = useMemo(() => modelMenuGroups(modelChoices, locale), [locale, modelChoices]);
  const selectedValue = useMemo(() => {
    if (!props.defaultSlug) return '';
    const connection = props.connections.find((candidate) => candidate.slug === props.defaultSlug);
    if (!connection?.defaultModel) return '';
    const value = modelChoiceValue(connection.slug, connection.defaultModel);
    return modelChoices.some((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === value) ? value : '';
  }, [modelChoices, props.connections, props.defaultSlug]);
  const selectedLabel = useMemo(() => {
    if (!selectedValue) return copy.notSet;
    return modelChoices.find((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === selectedValue)?.label ?? copy.notSet;
  }, [copy.notSet, modelChoices, selectedValue]);

  async function persistDefault(nextValue: string) {
    const releaseSave = persistGuard.begin('default-model');
    if (!releaseSave) return;
    setSaving(true);
    try {
      const parsed = parseModelChoiceValue(nextValue);
      await window.maka.connections.setDefaultModel(parsed ? {
        slug: parsed.llmConnectionSlug,
        model: parsed.model,
      } : null);
      if (!mountedRef.current) return;
      await props.onRefresh();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.saveDefaultModelFailed, settingsActionErrorMessage(error, locale));
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
    const releaseSave = persistGuard.begin('permission-mode');
    if (!releaseSave) return;
    if (nextMode === 'bypass' && props.permissionMode !== 'bypass') {
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
          toast.error(copy.saveDefaultPermissionFailed, settingsActionErrorMessage(error, locale));
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
        toast.error(copy.saveDefaultPermissionFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      releaseSave();
      if (mountedRef.current) setSavingPermissionMode(false);
    }
  }

  return (
    <SettingsRows>
      <div className="settingsRow" data-control-width="select">
        <div>
          <strong>{copy.defaultModel}</strong>
          <small>{copy.defaultModelHelp}</small>
        </div>
        {/* Shared searchable picker with the composer's model switcher
            (ModelPicker in @maka/ui) so the grouped list, provider marks,
            and search behavior can't drift between the two surfaces. */}
        <ModelPicker
          groups={modelGroups}
          value={selectedValue}
          pinnedItem={{ value: '', label: copy.notSet }}
          renderProviderMark={(type) => <ProviderLogo type={type} compact />}
          ariaLabel={copy.defaultModel}
          disabled={saving}
          triggerClassName="settingsModelPickerTrigger"
          onValueChange={(value) => {
            void persistDefault(value);
          }}
        >
          <span className="modelPickerOptionLabel">{selectedLabel}</span>
        </ModelPicker>
      </div>
      <div className="settingsRow" data-control-width="select">
        <div>
          <strong>{copy.defaultPermission}</strong>
          {/* Fixed description of the SETTING (not the selected option's own
              hint — the shared popup already shows every option's hint). */}
          <small>{copy.defaultPermissionHelp}</small>
        </div>
        {/* Shared Base UI Select picker with the composer (PermissionModeSelect)
            — same component, so option markup can't drift between the two
            surfaces. Every option shows its label + hint before picking. */}
        <PermissionModeSelect
          activeMode={props.permissionMode}
          onSelect={(mode) => {
            void persistPermissionMode(mode);
          }}
          align="end"
          disabled={savingPermissionMode}
          ariaLabel={copy.defaultPermission}
        />
      </div>
    </SettingsRows>
  );
}

function NetworkProxySection(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).general;
  const persistedProxy = props.settings.network.proxy;
  const [testing, setTesting] = useState(false);
  const proxyTestGuard = useActionGuard<'test'>();
  const toast = useToast();
  const {
    draft: proxyDraft,
    draftRef: proxyDraftRef,
    mountedRef: networkPageMountedRef,
    update,
  } = useOptimisticSettingsDraft<NetworkProxySettings>(
    persistedProxy,
    (patch) => props.onUpdate({ network: { proxy: patch } }).then((result) => result.settings.network.proxy),
    { onError: (error) => toast.error(copy.saveNetworkFailed, settingsActionErrorMessage(error, locale)) },
  );

  function updateProxy(patch: Partial<NetworkProxySettings>) {
    return update(patch);
  }

  async function testProxy() {
    if (!proxyTestGuard.begin('test')) return;
    setTesting(true);
    try {
      const result = await window.maka.settings.testNetworkProxy(toProxyTestInput(proxyDraftRef.current));
      const latency = result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : '';
      if (result.ok && networkPageMountedRef.current) {
        toast.success(copy.proxyReachable, `${result.message}${latency}`);
      } else if (networkPageMountedRef.current) {
        toast.error(copy.proxyTestFailed, result.message);
      }
    } catch (error) {
      if (networkPageMountedRef.current) {
        toast.error(copy.proxyTestError, settingsActionErrorMessage(error, locale));
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
      <div className="settingsFormRow">
        <div>
          <strong>{copy.proxy}</strong>
          <small>{copy.proxyHelp}</small>
        </div>
        <Switch
          ariaLabel={copy.enableProxy}
          checked={proxyDraft.enabled}
          onChange={(enabled) => void updateProxy({ enabled })}
        />
      </div>

      {proxyDraft.enabled && (
        <>
          <div className="settingsFormGrid settingsFormGridProxy">
            <label>
              <span>{copy.proxyProtocol}</span>
              <SettingsSelect
                value={proxyDraft.protocol}
                ariaLabel={copy.proxyProtocol}
                options={[
                  ['http', 'HTTP/HTTPS'],
                  ['https', 'HTTPS'],
                  ['socks5', 'SOCKS5'],
                ] satisfies Array<readonly [NetworkProxySettings['protocol'], string]>}
                onChange={(protocol) => void updateProxy({ protocol })}
              />
            </label>
            <label>
              <span>{copy.serverAddress}</span>
              <Input value={proxyDraft.host} onChange={(event) => void updateProxy({ host: event.currentTarget.value })} placeholder="127.0.0.1" aria-label={copy.proxyServerAddress} />
            </label>
            <label>
              <span>{copy.port}</span>
              <NumberField value={proxyDraft.port || null} format={{ useGrouping: false }} onValueChange={(v) => void updateProxy({ port: v ?? 0 })}>
                <NumberFieldInput placeholder="7890" aria-label={copy.proxyPort} />
              </NumberField>
            </label>
          </div>

          <div className="settingsFormRow">
            <div>
              <strong>{copy.proxyAuth}</strong>
              <small>{copy.proxyAuthHelp}</small>
            </div>
            <Switch
              ariaLabel={copy.enableProxyAuth}
              checked={proxyDraft.authEnabled}
              onChange={(authEnabled) => void updateProxy({ authEnabled })}
            />
          </div>

          {proxyDraft.authEnabled && (
            <div className="settingsFormGrid">
              <label>
                <span>{copy.username}</span>
                <Input value={proxyDraft.username} onChange={(event) => void updateProxy({ username: event.currentTarget.value })} aria-label={copy.proxyUsername} />
              </label>
              <label>
                <span>{copy.password}</span>
                <PasswordInput value={proxyDraft.password} onChange={(next) => void updateProxy({ password: next })} ariaLabel={copy.proxyPassword} />
              </label>
            </div>
          )}

          <label className="settingsField">
            <span>{copy.bypassList}</span>
            <Input
              value={proxyDraft.bypassList.join(', ')}
              onChange={(event) => void updateProxy({ bypassList: csvList(event.currentTarget.value) })}
              placeholder="metaso.cn, baidu.com"
              aria-label={copy.bypassList}
            />
            <small>{copy.bypassHelp}</small>
          </label>

          <Alert variant="info">
            <AlertDescription>{copy.autoBypass(proxyDraft.autoBypassDomains.length)}</AlertDescription>
          </Alert>

          <div className="settingsActionRow">
            <Button
              variant="primary"
              isDisabled={testing}
              aria-busy={testing}
              data-pending={testing ? 'true' : undefined}
              onClick={() => void testProxy()}
              label={testing ? copy.testing : copy.testCurrent}
            />
          </div>
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
      username: proxy.authEnabled && proxy.username.trim() ? proxy.username.trim() : undefined,
      password: proxy.authEnabled && proxy.password ? proxy.password : undefined,
      bypassList: proxy.bypassList,
    },
  };
}

function csvList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}
