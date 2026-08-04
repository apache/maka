import { useState, type ReactNode } from 'react';
import { Banner, Divider, Grid, Heading, HStack, Link, Text, VStack } from '@astryxdesign/core';
import { PROVIDER_DEFAULTS } from '@maka/core';
import {
  Button,
  RelativeTime,
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
  // NOT clickAction — see the note on the button below.
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
      {/* onClick, not clickAction: this handler awaits `toast.confirm`, and
          clickAction runs inside startTransition. React defers state commits
          made during an async transition until the action settles, so the
          confirm dialog — which is React state, and needs four commits to
          resolve its promise — can never render, and the action waits forever
          on a dialog that waits on the action. `isLoading` still gives the
          spinner, aria-busy, and the disable, so the label stays 删除 rather
          than renaming itself to 删除中… . */}
      <Button variant="destructive" onClick={() => void remove()} isLoading={deleting} label={copy.deleteUnused} />
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
    deleting,
    detailActionBusy,
    supportsApiKey,
    needsOAuth,
    usesGitHubCopilotLogin,
    oauthLoginService,
    supportsRemoteDiscovery,
    credentialProbePending,
    hasUsableCredential,
    apiKeyStatusHint,
    hasApiKeyChange,
    hasBaseUrlChange,
    issue,
    lastTestMessage,
    lastTestAtMs,
    savedBaseUrl,
    save,
    updateEnabledModels,
    runTest,
    refreshModels,
    remove,
    refreshAfterRelogin,
  } = useConnectionDetail(props);
  // One row is a form at a time, the way the settings-sidebar template does it.
  // Opening a row discards the other's draft: leaving an abandoned draft in
  // state meant it reappeared when the user came back to that row, and — until
  // `save` became per-field — rode along with the next save.
  const [editingRow, setEditingRow] = useState<'key' | 'endpoint' | null>(null);
  function openRow(row: 'key' | 'endpoint') {
    if (row === 'key') setBaseUrl(savedBaseUrl);
    else setApiKey('');
    setEditingRow(row);
  }
  // Most of the 60 providers publish a fixed endpoint; editing it there can
  // only break the connection, and a proxy belongs in 设置 · 通用 · 网络, not in
  // a per-connection URL. So the row exists only where the address is genuinely
  // the user's: a service with no published endpoint (the *-compatible ones), or
  // a local runtime whose port is a convention rather than a fact. A derived
  // endpoint (Cloudflare builds one from the account id) is nobody's to type,
  // and neither is an account-authorized one — `gemini-cli` is OAuth with an
  // empty baseUrl, so keying off "OAuth with a fixed URL" let it slip through.
  const showsEndpoint = !needsOAuth
    && !defaults.baseUrlTemplate
    && (!defaults.baseUrl || defaults.category === 'local');

  return (
    /* Three sections, each a heading with a sentence beside its controls, one
       Divider between them — the `settings` template's form language.
       The two settled values (key, endpoint) are rows in the
       settings-sidebar template's language: a row reports its state and
       carries one link, and only becomes a form when the user asks it to. A
       credential and an endpoint are set once and then read; a permanent input
       box for each was the page telling the user to fill in something that is
       already filled in. */
    <VStack gap={8}>
      <DetailSection
        title={copy.credentials}
        /* One claim, not four phrasings of it: the credential never leaves this
           machine. The endpoint is not a secret, so it did not need a variant. */
        description={supportsApiKey ? copy.credentialsHelp : copy.credentialsHelpAccount}
      >
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
        {(supportsApiKey || showsEndpoint) && (
          <VStack gap={0}>
            <Divider />
            {supportsApiKey && (
              <ExpandableSettingRow
                label={copy.modelKey}
                value={apiKeyStatusHint}
                actionLabel={hasSecret === true ? copy.change : copy.set}
                isEditing={editingRow === 'key'}
                isDisabled={detailActionBusy}
                canSave={hasApiKeyChange}
                saveLabel={busy ? copy.saving : copy.save}
                cancelLabel={copy.cancel}
                onEdit={() => openRow('key')}
                onCancel={() => { setApiKey(''); setEditingRow(null); }}
                onSave={async () => { if (await save('key')) setEditingRow(null); }}
              >
                <PasswordInput
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={copy.pasteModelKey}
                  label={copy.modelKeyAria(display.name)}
                  isLabelHidden
                  isDisabled={detailActionBusy}
                />
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
              </ExpandableSettingRow>
            )}
            {showsEndpoint && (
              <ExpandableSettingRow
                label={copy.endpoint}
                value={savedBaseUrl || copy.endpointDefault}
                actionLabel={copy.edit}
                isEditing={editingRow === 'endpoint'}
                isDisabled={detailActionBusy}
                canSave={hasBaseUrlChange}
                saveLabel={busy ? copy.saving : copy.save}
                cancelLabel={copy.cancel}
                onEdit={() => openRow('endpoint')}
                onCancel={() => { setBaseUrl(savedBaseUrl); setEditingRow(null); }}
                onSave={async () => { if (await save('endpoint')) setEditingRow(null); }}
              >
                <TextInput
                  label={copy.endpoint}
                  isLabelHidden
                  value={baseUrl}
                  onChange={setBaseUrl}
                  placeholder={defaults.baseUrl}
                  isDisabled={detailActionBusy}
                />
              </ExpandableSettingRow>
            )}
          </VStack>
        )}
      </DetailSection>
      {/* The rows draw the closing rule themselves; without them the section
          still needs one. Two rules with a gap between them read as an empty
          row, so only ever one. */}
      {!supportsApiKey && !showsEndpoint && <Divider />}
      <DetailSection title={copy.modelManagement} description={copy.modelManagementHelp}>
        <EnabledModelManager
          modelChoices={modelChoices}
          enabledModelIds={enabledModelIds}
          disabled={detailActionBusy}
          onChange={(next) => void updateEnabledModels(next)}
        />
        {/* Each button reports its own work through clickAction (spinner +
            aria-busy + "Loading" announcement) instead of renaming itself to
            测试中… — the section's `detailActionBusy` still says only one
            connection action runs at a time. `refreshModels` is wrapped
            because it takes an options object: handing it the click event
            would pass a MouseEvent as `opts`. */}
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button variant="secondary" isDisabled={detailActionBusy || !hasUsableCredential} clickAction={() => runTest()} label={copy.testConnection} />
          {supportsRemoteDiscovery && (
            <Button variant="ghost" isDisabled={detailActionBusy || !hasUsableCredential} clickAction={() => refreshModels()} label={copy.updateModels} />
          )}
        </HStack>
      </DetailSection>
      <Divider />
      {/* Deletion is last, and the only thing beside it is its own warning —
          no quiet action next to the destructive one for a mis-aimed cursor. */}
      <DetailSection title={copy.dangerZone} description={copy.deleteRowHelp}>
        <HStack>
          {/* The heading beside it already says 删除连接; repeating it on the
              button was the same three words twice in one row. */}
          {/* onClick, not clickAction: `remove` awaits toast.confirm, which
              cannot render from inside clickAction's transition (see the
              fallback detail above). `deleting` already drives
              detailActionBusy; feeding it to isLoading puts the spinner on
              the button that is actually working. */}
          <Button variant="destructive" isDisabled={detailActionBusy} isLoading={deleting} onClick={() => void remove()} label={copy.delete} />
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
/**
 * A settled value: its name, what it currently is, and one link to change it.
 * Editing swaps the row in place for the control plus save / cancel — the
 * settings-sidebar template's ExpandableRow, which is the shape Astryx uses for
 * exactly this (a password that is already set, an address already on file).
 *
 * The Divider trails each row, as in the template, so a stack of rows carries
 * its own separators without the caller interleaving them.
 */
function ExpandableSettingRow(props: {
  label: string;
  value: string;
  actionLabel: string;
  isEditing: boolean;
  isDisabled: boolean;
  canSave: boolean;
  saveLabel: string;
  cancelLabel: string;
  onEdit(): void;
  onCancel(): void;
  onSave(): void | Promise<void>;
  children: ReactNode;
}) {
  return (
    <>
      {props.isEditing ? (
        <VStack gap={3} paddingBlock={4}>
          <Text type="body" weight="semibold">{props.label}</Text>
          {props.children}
          <HStack gap={2}>
            <Button
              variant="primary"
              isDisabled={props.isDisabled || !props.canSave}
              onClick={() => void props.onSave()}
              label={props.saveLabel}
            />
            <Button variant="ghost" isDisabled={props.isDisabled} onClick={props.onCancel} label={props.cancelLabel} />
          </HStack>
        </VStack>
      ) : (
        <HStack hAlign="between" vAlign="start" gap={4} paddingBlock={4}>
          <VStack gap={0}>
            <Text type="body" weight="semibold">{props.label}</Text>
            <Text type="supporting" color="secondary">{props.value}</Text>
          </VStack>
          {/* A button, not a Link: this opens a form, it does not navigate. As
              a link it announced itself as one, ignored Space, and pointed at
              "#". Astryx has no link-styled variant, and ghost is the right
              weight for a row affordance anyway. */}
          <Button variant="ghost" size="sm" isDisabled={props.isDisabled} onClick={props.onEdit} label={props.actionLabel} />
        </HStack>
      )}
      <Divider />
    </>
  );
}

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
  // connectGuard stays: it survives this component's renders and is the
  // cross-render "one connect at a time" record. The `busy` state it used to
  // mirror is gone — one button, so clickAction's own disable and spinner are
  // the whole visible story.
  const connectGuard = useActionGuard<'connect'>();
  const mountedRef = useMountedRef();
  const toast = useToast();
  const loggedIn = props.hasSecret === true;
  const loading = props.hasSecret === 'loading';

  async function connect() {
    if (!connectGuard.begin('connect')) return;
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
    }
  }

  return (
    <Banner
      status="info"
      title={loggedIn ? copy.copilotLoggedIn : loading ? copy.oauthLoading : copy.copilotWaiting}
      description={loggedIn ? copy.copilotLoggedInDetail : copy.copilotWaitingDetail}
      endContent={!loading ? (
          <Button variant="primary" size="sm" clickAction={() => connect()} label={loggedIn ? copy.reimport : copy.importCredential} />
      ) : undefined} />
  );
}

// The OAuth notice for a re-loginable connection. The 重新登录 button drives
// the SAME shared browser-assisted OAuth flow the catalog cards use, so an
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
