import { useState, type ReactNode } from 'react';
import { Banner, Divider, Grid, Heading, HStack, Link, Text, VStack } from '@astryxdesign/core';
import { PROVIDER_DEFAULTS } from '@maka/core';
import {
  Button,
  RelativeTime,
  Selector,
  TextInput,
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
import type { StatusTone } from './settings-status-badge';
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
    <VStack gap={3} hAlign="start">
      <Text>{copy.unknownDescription(connection.providerType)}</Text>
      <Button variant="destructive" onClick={remove} isDisabled={deleting} label={deleting ? copy.deleting : copy.deleteUnused} />
    </VStack>
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
    settingDefaultModel,
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
    updateDefaultModel,
    runTest,
    refreshModels,
    setAsDefault,
    remove,
    refreshAfterRelogin,
  } = useConnectionDetail(props);
  const defaultModelOptions = modelChoices
    .filter((entry) => entry.canUseAsChatDefault)
    .map((entry) => ({
      value: entry.id,
      label: entry.displayName?.trim() || entry.id,
    }));
  if (
    connection.defaultModel &&
    !defaultModelOptions.some((option) => option.value === connection.defaultModel)
  ) {
    defaultModelOptions.push({
      value: connection.defaultModel,
      label: connection.defaultModel,
    });
  }

  return (
    /* The `settings` template's form language, verbatim: a section is a
       heading with a sentence under it beside its controls, and one Divider
       BETWEEN sections. No rule under each heading, no box around anything,
       nothing folded away — the template has no Collapsible, and Astryx's own
       guidance says not to hide required content behind one or to reach for
       one to cover a single short field. */
    <VStack gap={8}>
      <DetailSection
        title={copy.credentials}
        description={supportsApiKey ? copy.credentialsHelp : copy.credentialsHelpAccount}
      >
        {supportsApiKey && (
          <VStack gap={2}>
            <PasswordInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={hasSecret === true ? '••••••••' : copy.pasteModelKey}
              label={copy.modelKeyAria(display.name)}
              description={apiKeyStatusHint}
              isDisabled={detailActionBusy}
            />
            <HStack gap={2} hAlign="between" vAlign="center">
              {defaults.signupUrl && (
                <Link
                  href={defaults.signupUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={copy.getModelKey}
                >
                  {copy.getModelKey}
                </Link>
              )}
              {/* Persistent button (disabled until a new key is typed) so the
                  credential actions row keeps a fixed height — no jitter when the
                  user starts pasting a key. */}
              <Button variant="primary" isDisabled={detailActionBusy || !hasApiKeyChange} onClick={save} label={busy ? copy.saving : copy.updateKey} />
            </HStack>
          </VStack>
        )}
        {issue && (
          <Banner
            status={connectionIssueStatus(issue.tone)}
            role="status"
            title={issue.label}
            description={(lastTestMessage || Number.isFinite(lastTestAtMs)) ? (
              <>
                {lastTestMessage && lastTestMessage !== issue.label ? lastTestMessage : null}
                {lastTestMessage && lastTestMessage !== issue.label && Number.isFinite(lastTestAtMs) ? ' · ' : null}
                {Number.isFinite(lastTestAtMs) && <RelativeTime ts={lastTestAtMs} />}
              </>
            ) : undefined}
          />
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
            <Banner
              status="info"
              title={hasSecret === true
                ? copy.oauthLoggedIn
                : hasSecret === 'loading'
                  ? copy.oauthLoading
                  : hasSecret === 'error'
                    ? copy.oauthUnknown
                    : copy.oauthWaiting}
              description={hasSecret === true
                ? copy.oauthLoggedInDetail
                : hasSecret === 'loading'
                  ? copy.oauthLoadingDetail
                  : hasSecret === 'error'
                    ? copy.oauthUnknownDetail
                    : copy.oauthWaitingDetail} />
          )
        )}
        {credentialProbePending && (
          <Banner
            status="warning"
            role="alert"
            title={hasSecret === 'loading'
              ? copy.credentialLoadingDetail
              : copy.credentialUnknownDetail}
          />
        )}
      </DetailSection>
      <Divider />
      <DetailSection title={copy.modelManagement} description={copy.modelManagementHelp}>
        <Selector
          label={copy.connectionDefaultModel}
          description={copy.connectionDefaultModelHelp}
          options={defaultModelOptions}
          value={connection.defaultModel}
          onChange={(model) => void updateDefaultModel(model)}
          isDisabled={detailActionBusy || defaultModelOptions.length === 0}
          disabledMessage={defaultModelOptions.length === 0 ? copy.noModels : undefined}
          isLoading={settingDefaultModel}
          placeholder={copy.noModels}
          width="100%"
        />
        <EnabledModelManager
          modelChoices={modelChoices}
          enabledModelIds={enabledModelIds}
          defaultModel={connection.defaultModel}
          disabled={detailActionBusy}
          onChange={(next) => void updateEnabledModels(next)}
        />
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button variant="secondary" isDisabled={detailActionBusy || !hasUsableCredential} onClick={runTest} label={testing ? copy.testing : copy.testConnection} />
          {supportsRemoteDiscovery && (
            <Button variant="ghost" isDisabled={detailActionBusy || !hasUsableCredential} onClick={() => void refreshModels()} label={fetchingModels ? copy.updating : copy.updateModels} />
          )}
        </HStack>
      </DetailSection>
      {/* Only where there is something to do. Once this connection IS the
          default the section had nothing but a sentence saying so — and the
          page header already says it, with a badge. */}
      {!props.isDefault && (
        <>
          <Divider />
          <DetailSection title={copy.defaultConnection} description={copy.defaultConnectionHelp}>
            {connection.enabled ? (
              <HStack>
                <Button
                  variant="primary"
                  isDisabled={detailActionBusy}
                  onClick={setAsDefault}
                  label={settingDefault ? copy.setting : copy.setDefault}
                />
              </HStack>
            ) : (
              <Text type="supporting" color="secondary">{copy.connectionDisabledDetail}</Text>
            )}
          </DetailSection>
        </>
      )}
      {/* The endpoint section only exists where the endpoint can actually be
          changed. An OAuth connection's endpoint is fixed by the provider, so
          showing it was a permanently read-only field explaining why it is
          read-only — a row that answers a question nobody asked. */}
      {!hasFixedOAuthBaseUrl && (
        <>
          <Divider />
          {/* Named for the one field it holds, not "高级设置": a category name
              with a single member is an extra door in front of one room. The
              heading names it, so the field does not repeat the name. */}
          <DetailSection title={copy.endpoint} description={copy.advancedHelp}>
            <TextInput
              label={copy.endpoint}
              isLabelHidden
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder={defaults.baseUrl}
              isDisabled={detailActionBusy}
            />
            {/* Persistent button (disabled until the endpoint is edited) so the
                section height stays constant while typing. */}
            <HStack>
              <Button variant="primary" isDisabled={detailActionBusy || !hasBaseUrlChange} onClick={save} label={busy ? copy.saving : copy.saveEndpoint} />
            </HStack>
          </DetailSection>
        </>
      )}
      <Divider />
      {/* Deletion is last, and the only thing beside it is its own warning —
          no quiet action next to the destructive one for a mis-aimed cursor. */}
      <DetailSection title={copy.dangerZone} description={copy.deleteRowHelp}>
        <HStack>
          {/* The destructive button names what it destroys; a bare 删除 next
              to a heading is one glance away from being read as 删除 something
              else on the page. */}
          <Button variant="destructive" isDisabled={detailActionBusy} onClick={remove} label={deleting ? copy.deleting : copy.deleteConnection} />
        </HStack>
      </DetailSection>
    </VStack>
  );
}

/**
 * One section of the form, in the `settings` template's shape: the heading and
 * its one-sentence explanation in the first grid cell, the controls in the
 * second. At the settings column's width the grid is one column, so it reads
 * as heading → sentence → controls; it splits into two columns for free if the
 * shell ever widens.
 */
function DetailSection(props: { title: string; description: string; children: ReactNode }) {
  return (
    /* `columnGap`, not `gap`: the template's 10 is the gutter BETWEEN the two
       columns. At this column's width the grid is one column, and a 10-step
       row gap there reads as a hole between a heading and the thing it
       labels. */
    <Grid columns={{ minWidth: 320 }} columnGap={10} rowGap={4} role="region" aria-label={props.title}>
      <VStack gap={1}>
        <Heading level={3}>{props.title}</Heading>
        <Text type="supporting" color="secondary">{props.description}</Text>
      </VStack>
      <VStack gap={4}>{props.children}</VStack>
    </Grid>
  );
}

/** The list's three status tones against Banner's four; `neutral` has no
 * Banner equivalent, so it takes the quietest one rather than borrowing an
 * alarm color it does not mean. */
function connectionIssueStatus(tone: StatusTone): 'error' | 'success' | 'info' {
  if (tone === 'destructive') return 'error';
  if (tone === 'success') return 'success';
  return 'info';
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
    <Banner
      status="info"
      title={loggedIn ? copy.copilotLoggedIn : loading ? copy.oauthLoading : copy.copilotWaiting}
      description={loggedIn ? copy.copilotLoggedInDetail : copy.copilotWaitingDetail}
      endContent={!loading ? (
          <Button variant="primary" size="sm" isDisabled={busy} onClick={() => void connect()} label={busy ? copy.importing : loggedIn ? copy.reimport : copy.importCredential} />
      ) : undefined} />
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
    <Banner
      status="info"
      title={title}
      description={detail}
      endContent={!loading ? (
          <Button
            variant="primary"
            size="sm"
            isDisabled={flow.actionBusy}
            onClick={() => void flow.startLogin()}
            label={flow.pendingAction === 'login' ? copy.loggingIn : loggedIn ? copy.relogin : copy.login}
          />
      ) : undefined} />
  );
}
