import { useState } from 'react';
import { PROVIDER_DEFAULTS } from '@maka/core';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Button,
  FieldDescription,
  FieldRoot,
  Input,
  Label,
  RelativeTime,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { PasswordInput } from './password-input';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { providerDisplay } from './provider-display';
import { EnabledModelManager } from './provider-enabled-model-manager';
import { useActionGuard } from './use-action-guard';
import { useOAuthLoginFlow } from './use-oauth-login-flow';
import {
  providerPanelActionErrorMessage,
  type CredentialPresenceStatus,
} from './provider-panel-shared';
import {
  useConnectionDetail,
  type ConnectionDetailProps,
  type OAuthLoginService,
} from './use-connection-detail';

export function ConnectionDetail(props: ConnectionDetailProps) {
  const defaults = PROVIDER_DEFAULTS[props.connection.providerType];
  // Unknown providerType (a connection persisted on a branch that registers a
  // provider this build doesn't know) → render a non-actionable fallback so
  // opening the orphan connection doesn't crash on `.authKind`/`.baseUrl`.
  // Mirrors `isFakeBackend` in @maka/core/connection-readiness.ts.
  if (!defaults) return <UnknownConnectionDetail props={props} />;
  return <ConnectionDetailInner {...props} />;
}

function UnknownConnectionDetail({ props }: { props: ConnectionDetailProps }) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const { connection } = props;
  const toast = useToast();
  const mounted = useMountedRef();
  const [deleting, setDeleting] = useState(false);
  async function remove() {
    if (deleting) return;
    const ok = await toast.confirm({
      title: copy.deleteProviderTitle(connection.name || connection.slug),
      description: copy.deleteUnknownDescription,
      confirmLabel: copy.delete,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!mounted.current || !ok) return;
    setDeleting(true);
    try {
      await props.bridge.delete(connection.slug);
      if (!mounted.current) return;
      await props.onDeleted();
    } catch (error) {
      if (!mounted.current) return;
      toast.error(copy.deleteFailed, providerPanelActionErrorMessage(error, locale));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }
  return (
    <div className="providerConnectionDetail">
      <p>
        {copy.unknownDescription(connection.providerType)}
      </p>
      <Button variant="destructive" type="button" onClick={remove} disabled={deleting}>
        {deleting ? copy.deleting : copy.deleteUnused}
      </Button>
    </div>
  );
}

function ConnectionDetailInner(props: ConnectionDetailProps) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const { connection } = props;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const display = providerDisplay(connection.providerType, locale);
  const {
    apiKey,
    setApiKey,
    hasSecret,
    baseUrl,
    setBaseUrl,
    enabledModelIds,
    modelChoices,
    busy,
    testing,
    fetchingModels,
    settingDefault,
    deleting,
    detailActionBusy,
    supportsApiKey,
    needsOAuth,
    usesGitHubCopilotLogin,
    oauthLoginService,
    hasFixedOAuthBaseUrl,
    supportsRemoteDiscovery,
    credentialProbePending,
    hasUsableCredential,
    apiKeyStatusHint,
    hasApiKeyChange,
    hasBaseUrlChange,
    issue,
    lastTestMessage,
    lastTestAtMs,
    save,
    updateEnabledModels,
    runTest,
    refreshModels,
    setAsDefault,
    remove,
    refreshAfterRelogin,
  } = useConnectionDetail(props);

  return (
    <div className="providerEditor providerConnectionManager">
      {supportsApiKey && (
        <div className="providerCredentialTask">
          <FieldRoot className="grid gap-1.5">
            <Label className="text-xs text-foreground-secondary">{copy.modelKey}</Label>
            <FieldDescription>{apiKeyStatusHint}</FieldDescription>
            <PasswordInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={hasSecret === true ? '••••••••' : copy.pasteModelKey}
              ariaLabel={copy.modelKeyAria(display.name)}
              disabled={detailActionBusy}
            />
          </FieldRoot>
          <div className="providerCredentialActions">
            {defaults.signupUrl && (
              <a
                className="providerExternalLink"
                href={defaults.signupUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={copy.getModelKey}
              >
                {copy.getModelKey}
              </a>
            )}
            {/* Persistent button (disabled until a new key is typed) so the
                credential actions row keeps a fixed height — no jitter when the
                user starts pasting a key. */}
            <Button type="button" disabled={detailActionBusy || !hasApiKeyChange} onClick={save}>
              {busy ? copy.saving : copy.updateKey}
            </Button>
          </div>
        </div>
      )}
      {issue && (
        <div className="providerConnectionIssue" data-tone={issue.tone} role="status">
          <strong>{issue.label}</strong>
          {(lastTestMessage || Number.isFinite(lastTestAtMs)) && (
            <span>
              {lastTestMessage && lastTestMessage !== issue.label ? lastTestMessage : null}
              {lastTestMessage && lastTestMessage !== issue.label && Number.isFinite(lastTestAtMs) ? ' · ' : null}
              {Number.isFinite(lastTestAtMs) && <RelativeTime ts={lastTestAtMs} />}
            </span>
          )}
        </div>
      )}
      {needsOAuth && (
        usesGitHubCopilotLogin ? (
          <GitHubCopilotReloginNotice hasSecret={hasSecret} onRelogin={refreshAfterRelogin} />
        ) : oauthLoginService ? (
          <OAuthReloginNotice
            service={oauthLoginService}
            hasSecret={hasSecret}
            onRelogin={refreshAfterRelogin}
          />
        ) : (
          <Alert variant="info">
            <AlertTitle>
              {hasSecret === true
                ? copy.oauthLoggedIn
                : hasSecret === 'loading'
                  ? copy.oauthLoading
                  : hasSecret === 'error'
                    ? copy.oauthUnknown
                    : copy.oauthWaiting}
            </AlertTitle>
            <AlertDescription>
              {hasSecret === true
                ? copy.oauthLoggedInDetail
                : hasSecret === 'loading'
                  ? copy.oauthLoadingDetail
                  : hasSecret === 'error'
                    ? copy.oauthUnknownDetail
                    : copy.oauthWaitingDetail}
            </AlertDescription>
          </Alert>
        )
      )}
      {credentialProbePending && (
        <p className="providerError" role="alert">
          {hasSecret === 'loading'
            ? copy.credentialLoadingDetail
            : copy.credentialUnknownDetail}
        </p>
      )}
      <details className="providerAdvancedSettings">
        <summary>{copy.advanced}</summary>
        <div className="providerAdvancedSettingsBody">
          <EnabledModelManager
            modelChoices={modelChoices}
            enabledModelIds={enabledModelIds}
            defaultModel={connection.defaultModel}
            disabled={detailActionBusy}
            onChange={(next) => void updateEnabledModels(next)}
          />
          <div className="providerEndpointSettings">
            <ConnectionEndpointField
              baseUrl={baseUrl}
              defaultsBaseUrl={defaults.baseUrl}
              fixedOAuth={hasFixedOAuthBaseUrl}
              disabled={detailActionBusy}
              onChange={setBaseUrl}
            />
            {/* Persistent button (disabled until the endpoint is edited) so the
                advanced settings body height stays constant while typing. An
                OAuth-fixed endpoint is readOnly with no dirty path — no jitter
                risk — so it renders no permanently-disabled Save at all. */}
            {!hasFixedOAuthBaseUrl && (
              <div className="providerEndpointActions">
                <Button type="button" disabled={detailActionBusy || !hasBaseUrlChange} onClick={save}>
                  {busy ? copy.saving : copy.saveEndpoint}
                </Button>
              </div>
            )}
          </div>
          <div className="providerAdvancedActions">
            <Button variant="secondary" type="button" disabled={detailActionBusy || !hasUsableCredential} onClick={runTest}>
              {testing ? copy.testing : copy.testConnection}
            </Button>
            {supportsRemoteDiscovery && (
              <Button variant="quiet" type="button" disabled={detailActionBusy || !hasUsableCredential} onClick={() => void refreshModels()}>
                {fetchingModels ? copy.updating : copy.updateModels}
              </Button>
            )}
            {!props.isDefault && connection.enabled && (
              <Button variant="quiet" type="button" disabled={detailActionBusy} onClick={setAsDefault}>
                {settingDefault ? copy.setting : copy.setDefault}
              </Button>
            )}
            <Button className="providerAdvancedDanger" variant="quiet" type="button" disabled={detailActionBusy} onClick={remove}>
              {deleting ? copy.deleting : copy.deleteConnection}
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

function ConnectionEndpointField(props: {
  baseUrl: string;
  defaultsBaseUrl: string | undefined;
  fixedOAuth: boolean;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  return (
    <FieldRoot className="grid gap-1.5">
      <Label className="text-xs text-foreground-secondary">{copy.endpoint}</Label>
      {props.fixedOAuth && <FieldDescription>{copy.oauthFixed}</FieldDescription>}
      <Input
        value={props.baseUrl}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder={props.defaultsBaseUrl}
        readOnly={props.fixedOAuth}
        disabled={props.disabled}
        aria-readonly={props.fixedOAuth ? 'true' : undefined}
        aria-label={props.fixedOAuth ? copy.endpointFixedAria : copy.endpointAria}
      />
    </FieldRoot>
  );
}

function GitHubCopilotReloginNotice(props: {
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const [busy, setBusy] = useState(false);
  const connectGuard = useActionGuard<'connect'>();
  const mountedRef = useMountedRef();
  const toast = useToast();
  const loggedIn = props.hasSecret === true;
  const loading = props.hasSecret === 'loading';

  async function connect() {
    if (!connectGuard.begin('connect')) return;
    setBusy(true);
    try {
      const result = await window.maka.githubCopilotSubscription.connectExistingLogin();
      if (!result.ok) {
        toast.error(copy.copilotImportFailed, result.message);
        return;
      }
      await props.onRelogin();
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.copilotImportFailed, providerPanelActionErrorMessage(error, locale));
      }
    } finally {
      connectGuard.finish();
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <Alert variant="info">
      <AlertTitle>{loggedIn ? copy.copilotLoggedIn : loading ? copy.oauthLoading : copy.copilotWaiting}</AlertTitle>
      <AlertDescription>{loggedIn ? copy.copilotLoggedInDetail : copy.copilotWaitingDetail}</AlertDescription>
      {!loading && (
        <AlertAction>
          <Button type="button" size="sm" disabled={busy} onClick={() => void connect()}>
            {busy ? copy.importing : loggedIn ? copy.reimport : copy.importCredential}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

// The OAuth notice for a re-loginable connection. The 重新登录 button drives
// the SAME shared browser-loopback flow the OAuth catalog cards use, so an
// expired connection can be re-authorized right where the problem surfaces.
// The button shows in every credential state except 'loading' — an EXPIRED
// token still reads hasSecret===true, so it must not hide behind
// hasSecret===false.
function OAuthReloginNotice(props: {
  service: OAuthLoginService;
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const flow = useOAuthLoginFlow({
    bridge: props.service.bridge,
    display: props.service.display,
    onLoginSuccess: props.onRelogin,
  });
  const { hasSecret } = props;
  const loggedIn = hasSecret === true;
  const loading = hasSecret === 'loading';
  const errored = hasSecret === 'error';
  const title = loggedIn
    ? copy.oauthLoggedIn
    : loading
      ? copy.oauthLoading
      : errored
        ? copy.oauthUnknown
        : copy.oauthWaiting;
  const detail = loggedIn
    ? copy.oauthReloginDetail
    : loading
      ? copy.oauthLoadingDetail
      : errored
        ? copy.oauthUnknownDetail
        : copy.oauthStartDetail;
  return (
    <Alert variant="info">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
      {!loading && (
        <AlertAction>
          <Button
            type="button"
            size="sm"
            disabled={flow.actionBusy}
            onClick={() => void flow.startLogin()}
          >
            {flow.pendingAction === 'login' ? copy.loggingIn : loggedIn ? copy.relogin : copy.login}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
