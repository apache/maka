import { useEffect, useState } from 'react';
import type { AppSettings, OpenGatewayRuntimeStatus, UpdateAppSettingsResult } from '@maka/core';
import { Alert, AlertDescription, Button, TextInput, NumberInput, SettingsSelect, Switch, TextArea, useToast, useUiLocale } from '@maka/ui';
import { getOpenGatewaySettingsCopy, type OpenGatewaySettingsCopy } from '../locales/settings-open-gateway-copy';
import { PasswordInput } from './password-input';
import { MetricCard } from './settings-metric-card';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';

export function OpenGatewaySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getOpenGatewaySettingsCopy(locale);
  const persistedGateway = props.settings.openGateway;
  const [status, setStatus] = useState<OpenGatewayRuntimeStatus | null>(null);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState(persistedGateway.token);
  const [eventSessionId, setEventSessionId] = useState('');
  const [copyingGatewayAction, setCopyingGatewayAction] = useState<string | null>(null);
  const gatewayCopyGuard = useActionGuard<string>();
  const toast = useToast();
  const {
    draft: gatewayDraft,
    mountedRef: openGatewayMountedRef,
    saving,
    update,
  } = useOptimisticSettingsDraft<AppSettings['openGateway']>(
    persistedGateway,
    (patch) => props.onUpdate({ openGateway: patch }).then((result) => result.settings.openGateway),
    {
      onError: (error) => toast.error(copy.errors.save, settingsActionErrorMessage(error, locale)),
      onReconcile: (next) => setTokenDraft(next.token),
    },
  );

  useEffect(() => {
    let cancelled = false;
    window.maka.gateway
      .status()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setStatusLoadError(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = settingsActionErrorMessage(error, locale);
        setStatusLoadError(message);
        toast.error(copy.errors.loadStatus, message);
      });
    const unsubscribe = window.maka.gateway.subscribeStatusChanges((next) => {
      if (!cancelled) {
        setStatus(next);
        setStatusLoadError(null);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [locale]);

  function updateGateway(patch: Partial<AppSettings['openGateway']>): Promise<boolean> {
    return update(patch);
  }

  async function saveToken(nextToken = tokenDraft.trim()) {
    const saved = await updateGateway({ token: nextToken });
    if (!saved || !openGatewayMountedRef.current) return;
    toast.success(nextToken ? copy.toast.tokenSaved : copy.toast.tokenCleared);
  }

  async function generateToken() {
    const token = generateGatewayToken();
    setTokenDraft(token);
    const saved = await updateGateway({ token });
    if (!saved || !openGatewayMountedRef.current) return;
    toast.success(copy.toast.tokenGenerated, copy.toast.tokenGeneratedDetail);
  }

  async function copyGatewayText(action: string, text: string, successTitle: string, successDetail: string) {
    if (!gatewayCopyGuard.begin(action)) return;
    setCopyingGatewayAction(action);
    try {
      await navigator.clipboard.writeText(text);
      if (openGatewayMountedRef.current) {
        toast.success(successTitle, successDetail);
      }
    } catch {
      if (openGatewayMountedRef.current) {
        toast.error(copy.errors.copyTitle, copy.errors.copyDetail);
      }
    } finally {
      gatewayCopyGuard.finish();
      if (openGatewayMountedRef.current) {
        setCopyingGatewayAction(null);
      }
    }
  }

  async function copyBaseUrl() {
    const baseUrl = status?.baseUrl ?? gatewayBaseUrl(gatewayDraft.host, gatewayDraft.port);
    await copyGatewayText('base-url', baseUrl, copy.toast.baseUrlCopied, baseUrl);
  }

  const baseUrl = status?.baseUrl ?? gatewayBaseUrl(gatewayDraft.host, gatewayDraft.port);
  async function copyOverviewCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/state`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('overview-curl', command, copy.toast.overviewCopied, copy.toast.overviewDetail);
  }

  async function copyOpenApiCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/openapi.json`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('openapi-curl', command, copy.toast.openApiCopied, copy.toast.openApiDetail);
  }

  async function copySessionStateCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/state`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('session-state-curl', command, copy.toast.sessionStateCopied, sessionId === '<SESSION_ID>' ? copy.toast.sessionStateTemplateDetail : copy.toast.sessionStateDetail);
  }

  async function copyEventStreamCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = [
      'curl -N -sS',
      shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/events`),
      '-H',
      shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`),
      '-H',
      shellSingleQuote('Accept: text/event-stream'),
    ].join(' ');
    await copyGatewayText('event-stream-curl', command, copy.toast.eventStreamCopied, sessionId === '<SESSION_ID>' ? copy.toast.eventStreamTemplateDetail : copy.toast.eventStreamDetail);
  }

  async function copyRecentEventsCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/events/recent`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('recent-events-curl', command, copy.toast.recentEventsCopied, sessionId === '<SESSION_ID>' ? copy.toast.recentEventsTemplateDetail : copy.toast.recentEventsDetail);
  }

  async function copyRecentRequestsCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/requests/recent`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('recent-requests-curl', command, copy.toast.recentRequestsCopied, copy.toast.recentRequestsDetail);
  }

  const state = presentGatewayStatus(status, gatewayDraft, copy);
  const isCopyingGatewayAction = (action: string) => copyingGatewayAction === action;
  const gatewayCopyDisabled = Boolean(copyingGatewayAction);

  return (
    <div className="settingsStructuredPage">
      <div className="settingsGatewaySummary" role="group" aria-label={copy.summary.aria}>
        <MetricCard title={copy.summary.status} value={state.label} detail={state.detail} />
        <MetricCard title={copy.summary.address} value={baseUrl} detail={gatewayDraft.host === '0.0.0.0' ? copy.summary.lanAccessible : copy.summary.localOnly} />
        <MetricCard title={copy.summary.credentials} value={gatewayDraft.token ? copy.summary.configured : copy.summary.waitingToken} detail={copy.summary.credentialsDetail} />
        <MetricCard title={copy.summary.connections} value={String(status?.activeEventStreams ?? 0)} detail={copy.summary.connectionsDetail} />
        <MetricCard title={copy.summary.capability} value={copy.summary.endpointCount} detail={copy.summary.capabilityDetail} />
      </div>
      {statusLoadError && (
        <Alert variant="info" role="alert">
          <AlertDescription>{copy.status.loadFailed(statusLoadError)}</AlertDescription>
        </Alert>
      )}

      <div className="settingsFormRow">
        <div>
          <strong>{copy.form.enabled}</strong>
          <small>{copy.form.enabledHelp}</small>
        </div>
        <Switch
          label={copy.form.enabled}
              isLabelHidden
          value={gatewayDraft.enabled}
          onChange={(enabled) => void updateGateway({ enabled })}
        />
      </div>

      <div className="settingsFormGrid settingsFormGridProxy">
        <div>
          <span>{copy.form.host}</span>
          <SettingsSelect
            value={gatewayDraft.host}
            ariaLabel={copy.form.hostAria}
            options={[
              ['127.0.0.1', '127.0.0.1'],
              ['0.0.0.0', '0.0.0.0'],
            ] satisfies Array<readonly [AppSettings['openGateway']['host'], string]>}
            onChange={(host) => void updateGateway({ host })}
          />
        </div>
        <NumberInput label={copy.form.port} value={gatewayDraft.port} isIntegerOnly hasClear onChange={(value) => void updateGateway({ port: value ?? 3939 })} />
        <div>
          <span>{copy.form.token}</span>
          <PasswordInput
            value={tokenDraft}
            onChange={setTokenDraft}
            disabled={saving}
            onBlur={() => {
              if (tokenDraft !== gatewayDraft.token) void saveToken();
            }}
            placeholder={copy.form.tokenPlaceholder}
            ariaLabel={copy.form.tokenAria}
          />
        </div>
        <div>
          <span>{copy.form.sessionId}</span>
          <TextInput
            value={eventSessionId}
            isDisabled={saving}
            placeholder={copy.form.sessionPlaceholder}
            onChange={(value) => setEventSessionId(value)}
              label={copy.form.sessionAria}
              isLabelHidden
          />
        </div>
      </div>

      {gatewayDraft.enabled && !gatewayDraft.token && (
        <Alert variant="passive">
          <AlertDescription>{copy.form.waitingNotice}</AlertDescription>
        </Alert>
      )}
      {status?.lastError && (
        <Alert variant="info">
          <AlertDescription>{copy.status.startStatus(gatewayErrorCopy(status.lastError, copy))}</AlertDescription>
        </Alert>
      )}

      <div className="settingsActionRow" role="group" aria-label={copy.actions.aria}>
        <Button variant="primary" isDisabled={saving} onClick={() => void generateToken()} label={copy.actions.generateToken} />
        <Button variant="secondary" isDisabled={!gatewayDraft.token || saving} onClick={() => void saveToken('')} label={copy.actions.clearToken} />
        <Button variant="secondary" className="min-w-[4rem]" isDisabled={gatewayCopyDisabled} onClick={() => void copyBaseUrl()} label={isCopyingGatewayAction('base-url') ? copy.actions.copying : copy.actions.copyAddress} />
      </div>

      <SettingsRows>
        <SettingRow title={copy.endpoints.health.title} detail={copy.endpoints.health.detail} value="GET /health" />
        <SettingRow title={copy.endpoints.openApi.title} detail={copy.endpoints.openApi.detail} value="GET /v1/openapi.json" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" isDisabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyOpenApiCurl()} aria-label={copy.endpoints.openApi.copyAria} label={isCopyingGatewayAction('openapi-curl') ? copy.actions.copying : copy.actions.copyCurl} />} />
        <SettingRow title={copy.endpoints.overview.title} detail={copy.endpoints.overview.detail} value="GET /v1/state" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" isDisabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyOverviewCurl()} aria-label={copy.endpoints.overview.copyAria} label={isCopyingGatewayAction('overview-curl') ? copy.actions.copying : copy.actions.copyCurl} />} />
        <SettingRow title={copy.endpoints.capabilities.title} detail={copy.endpoints.capabilities.detail} value="GET /v1/capabilities" />
        <SettingRow title={copy.endpoints.sessions.title} detail={copy.endpoints.sessions.detail} value="GET /v1/sessions" />
        <SettingRow title={copy.endpoints.sessionsState.title} detail={copy.endpoints.sessionsState.detail} value="GET /v1/sessions/state" />
        <SettingRow title={copy.endpoints.sessionState.title} detail={copy.endpoints.sessionState.detail} value="GET /v1/sessions/:id/state" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" isDisabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copySessionStateCurl()} aria-label={copy.endpoints.sessionState.copyAria} label={isCopyingGatewayAction('session-state-curl') ? copy.actions.copying : copy.actions.copyCurl} />} />
        <SettingRow title={copy.endpoints.messages.title} detail={copy.endpoints.messages.detail} value="GET /v1/sessions/:id/messages" />
        <SettingRow title={copy.endpoints.messagesState.title} detail={copy.endpoints.messagesState.detail} value="GET /v1/sessions/:id/messages/state" />
        <SettingRow title={copy.endpoints.sendMessage.title} detail={copy.endpoints.sendMessage.detail} value="POST /v1/sessions/:id/messages" />
        <SettingRow title={copy.endpoints.events.title} detail={copy.endpoints.events.detail} value="GET /v1/sessions/:id/events" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" isDisabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyEventStreamCurl()} aria-label={copy.endpoints.events.copyAria} label={isCopyingGatewayAction('event-stream-curl') ? copy.actions.copying : copy.actions.copyCurl} />} />
        <SettingRow title={copy.endpoints.eventsState.title} detail={copy.endpoints.eventsState.detail} value="GET /v1/sessions/:id/events/state" />
        <SettingRow title={copy.endpoints.recentEvents.title} detail={copy.endpoints.recentEvents.detail} value="GET /v1/sessions/:id/events/recent" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" isDisabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyRecentEventsCurl()} aria-label={copy.endpoints.recentEvents.copyAria} label={isCopyingGatewayAction('recent-events-curl') ? copy.actions.copying : copy.actions.copyCurl} />} />
        <SettingRow title={copy.endpoints.globalEventsState.title} detail={copy.endpoints.globalEventsState.detail} value="GET /v1/events/state" />
        <SettingRow title={copy.endpoints.recentRequests.title} detail={copy.endpoints.recentRequests.detail} value="GET /v1/requests/recent" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" isDisabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyRecentRequestsCurl()} aria-label={copy.endpoints.recentRequests.copyAria} label={isCopyingGatewayAction('recent-requests-curl') ? copy.actions.copying : copy.actions.copyCurl} />} />
        <SettingRow title={copy.endpoints.incidents.title} detail={copy.endpoints.incidents.detail} value="GET /v1/sessions/:id/incidents" />
        <SettingRow title={copy.endpoints.incidentIndex.title} detail={copy.endpoints.incidentIndex.detail} value="GET /v1/incidents" />
        <SettingRow title={copy.endpoints.incidentState.title} detail={copy.endpoints.incidentState.detail} value="GET /v1/incidents/state" />
        <SettingRow title={copy.endpoints.search.title} detail={copy.endpoints.search.detail} value="GET /v1/search/thread?q=..." />
      </SettingsRows>

      <p className="settingsHelpText">
        {copy.help}
      </p>
    </div>
  );
}

function gatewayBaseUrl(host: AppSettings['openGateway']['host'], port: number): string {
  return `http://${host}:${port}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function presentGatewayStatus(
  status: OpenGatewayRuntimeStatus | null,
  settings: AppSettings['openGateway'],
  copy: OpenGatewaySettingsCopy,
): { label: string; detail: string } {
  if (!settings.enabled) return { label: copy.status.disabled, detail: copy.status.disabledDetail };
  if (!settings.token) return { label: copy.status.waitingToken, detail: copy.status.waitingTokenDetail };
  if (!status) return { label: copy.status.loading, detail: copy.status.loadingDetail };
  if (status.running) return { label: copy.status.running, detail: status.startedAt ? copy.status.startedDetail : copy.status.listeningDetail };
  return { label: copy.status.failed, detail: gatewayErrorCopy(status.lastError ?? 'gateway_start_failed', copy) };
}

function gatewayErrorCopy(error: string, copy: OpenGatewaySettingsCopy): string {
  if (error === 'missing_token') return copy.status.waitingToken;
  if (error === 'start_failed' || error === 'gateway_start_failed') return copy.errors.start;
  if (error.includes('EADDRINUSE')) return copy.errors.portInUse;
  return copy.errors.start;
}

function generateGatewayToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
