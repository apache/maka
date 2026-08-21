import { useEffect, useState, type ReactNode } from 'react';
import {
  Banner,
  Divider,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  Grid,
  Heading,
  HStack,
  Link,
  Text,
  VStack,
} from '@astryxdesign/core';
import { isRelayProviderType, PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import {
  DECLARABLE_RELAY_THINKING_LEVELS,
  THINKING_LEVELS,
  supportsRelayFastServiceTier,
  type RelayModelProfile,
  type ThinkingLevel,
} from '@maka/core/model-thinking';
import {
  Button,
  NumberInput,
  RelativeTime,
  Selector,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { PasswordInput } from './password-input';
import { SettingsExpandableRow } from './settings-expandable-row';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { providerDisplay } from './provider-display';
import { EnabledModelManager } from './provider-enabled-model-manager';
import { useActionGuard } from './use-action-guard';
import { useRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';
import { useOAuthLoginFlow } from './use-oauth-login-flow';
import {
  providerPanelActionErrorMessage,
  type CredentialPresenceStatus,
} from './provider-panel-shared';
import type { StatusSemantic } from '@maka/ui';
import {
  useConnectionDetail,
  type ConnectionDetailProps,
  type OAuthLoginService,
} from './use-connection-detail';
import {
  formatRequestBodyOverlay,
  parseRequestBodyOverlay,
  requestHeaderUpdates,
  RequestBodyEditor,
  RequestHeadersEditor,
  savedRequestHeaderDrafts,
  type RequestHeaderDraft,
} from './request-customization-editor';

export function ConnectionDetail(props: ConnectionDetailProps) {
  const defaults = PROVIDER_DEFAULTS[props.connection.providerType];
  // Unknown providerType (a connection persisted on a branch that registers a
  // provider this build doesn't know) → render a non-actionable fallback so
  // opening the orphan connection doesn't crash on `.authKind`/`.baseUrl`.
  // Mirrors `isRealConnection` in @maka/core/connection-readiness.ts.
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
    relayProfileDraft,
    hasRelayProfileChanges,
    setDraftThinkingLevels,
    setDraftVision,
    setDraftContextWindow,
    setDraftServiceTier,
    saveRelayProfiles,
    runTest,
    refreshModels,
    remove,
    refreshAfterRelogin,
  } = useConnectionDetail(props);
  // Capability switches only exist for custom OpenAI relays: built-in
  // providers declare their thinking support in model metadata, a custom
  // relay's backing model is unknown until the user says what it can do. The
  // declaration is per model — a relay can front both a reasoner and a plain
  // instruct model.
  const showsCapabilities = isRelayProviderType(connection.providerType);
  // Rows are the enabled models, exactly — the store prunes a model's profile
  // the moment it is disabled, so no declaration can ever belong to a row
  // this list does not show. The editor edits the per-model draft; 保存
  // commits the whole table in one write.
  const capabilityModelIds = enabledModelIds;
  // One row is a form at a time, the way the settings-sidebar template does it.
  // Opening a row discards the other's draft: leaving an abandoned draft in
  // state meant it reappeared when the user came back to that row, and — until
  // `save` became per-field — rode along with the next save.
  const [editingRow, setEditingRow] = useState<'key' | 'endpoint' | 'headers' | 'body' | null>(null);
  const [savedHeaderNames, setSavedHeaderNames] = useState<readonly string[]>([]);
  const [headerDrafts, setHeaderDrafts] = useState<RequestHeaderDraft[]>([]);
  const savedBodyText = formatRequestBodyOverlay(connection.requestBodyOverlay);
  const [bodyDraft, setBodyDraft] = useState(savedBodyText);
  const [requestCustomizationBusy, setRequestCustomizationBusy] = useState(false);
  const toast = useToast();
  const mounted = useMountedRef();
  const allActionsBusy = detailActionBusy || requestCustomizationBusy;
  const hasHeaderDraftChanges =
    headerDrafts.length !== savedHeaderNames.length ||
    headerDrafts.some(
      (header, index) =>
        !header.retained ||
        header.value.length > 0 ||
        header.name.toLowerCase() !== savedHeaderNames[index]?.toLowerCase(),
    );

  useEffect(() => {
    let current = true;
    setSavedHeaderNames([]);
    setHeaderDrafts([]);
    setBodyDraft(formatRequestBodyOverlay(connection.requestBodyOverlay));
    void props.bridge
      .getRequestHeaders(connection.slug)
      .then(({ names }) => {
        if (!current) return;
        setSavedHeaderNames(names);
        setHeaderDrafts(savedRequestHeaderDrafts(names));
      })
      .catch((error) => {
        if (!current) return;
        toast.error(copy.requestCustomizationInvalid, providerPanelActionErrorMessage(error, locale));
      });
    return () => {
      current = false;
    };
  }, [connection.slug, props.bridge, toast]);

  function openRow(row: 'key' | 'endpoint' | 'headers' | 'body') {
    if (row === 'key') setBaseUrl(savedBaseUrl);
    else if (row === 'endpoint') setApiKey('');
    else if (row === 'headers') setHeaderDrafts(savedRequestHeaderDrafts(savedHeaderNames));
    else setBodyDraft(savedBodyText);
    setEditingRow(row);
  }

  async function saveRequestHeaders(): Promise<boolean> {
    let updates;
    try {
      updates = requestHeaderUpdates(headerDrafts);
    } catch {
      toast.error(copy.requestCustomizationInvalid, copy.requestHeadersInvalidDetail);
      return false;
    }
    setRequestCustomizationBusy(true);
    try {
      const saved = await props.bridge.setRequestHeaders(connection.slug, updates);
      if (!mounted.current) return true;
      setSavedHeaderNames(saved.names);
      setHeaderDrafts(savedRequestHeaderDrafts(saved.names));
      await props.onChanged();
      return true;
    } catch (error) {
      if (mounted.current) {
        toast.error(copy.saveFailed, providerPanelActionErrorMessage(error, locale));
      }
      return false;
    } finally {
      if (mounted.current) setRequestCustomizationBusy(false);
    }
  }

  async function saveRequestBody(): Promise<boolean> {
    let overlay;
    try {
      overlay = parseRequestBodyOverlay(bodyDraft);
    } catch {
      toast.error(copy.requestCustomizationInvalid, copy.requestBodyInvalidDetail);
      return false;
    }
    setRequestCustomizationBusy(true);
    try {
      await props.bridge.update(connection.slug, { requestBodyOverlay: overlay ?? null });
      await props.onChanged();
      return true;
    } catch (error) {
      if (mounted.current) {
        toast.error(copy.saveFailed, providerPanelActionErrorMessage(error, locale));
      }
      return false;
    } finally {
      if (mounted.current) setRequestCustomizationBusy(false);
    }
  }
  // Most of the 60 providers publish a fixed endpoint; editing it there can
  // only break the connection, and a proxy belongs in 设置 · 通用 · 网络, not in
  // a per-connection URL. So the row exists only where the address is genuinely
  // the user's: a service with no published endpoint (the *-compatible ones), or
  // a local runtime whose port is a convention rather than a fact. A derived
  // endpoint (Cloudflare builds one from the account id) is nobody's to type.
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
              <>
              <SettingsExpandableRow
                label={copy.modelKey}
                value={apiKeyStatusHint}
                actionLabel={hasSecret === true ? copy.change : copy.set}
                isEditing={editingRow === 'key'}
                isDisabled={allActionsBusy}
                canSave={hasApiKeyChange}
                saveLabel={copy.save}
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
                  isDisabled={allActionsBusy}
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
              </SettingsExpandableRow>
              <Divider />
              </>
            )}
            {showsEndpoint && (
              <>
              <SettingsExpandableRow
                label={copy.endpoint}
                value={savedBaseUrl || copy.endpointDefault}
                actionLabel={copy.edit}
                isEditing={editingRow === 'endpoint'}
                isDisabled={allActionsBusy}
                canSave={hasBaseUrlChange}
                saveLabel={copy.save}
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
                  isDisabled={allActionsBusy}
                />
              </SettingsExpandableRow>
              <Divider />
              </>
            )}
          </VStack>
        )}
      </DetailSection>
      {/* The rows draw the closing rule themselves; without them the section
          still needs one. Two rules with a gap between them read as an empty
          row, so only ever one. */}
      {!supportsApiKey && !showsEndpoint && <Divider />}
      <DetailSection title={copy.advancedRequest} description={copy.advancedRequestHelp}>
        <VStack gap={0}>
              <SettingsExpandableRow
                label={copy.requestHeaders}
                value={savedHeaderNames.length > 0
                  ? copy.configuredHeaders(savedHeaderNames.length)
                  : copy.noAdvancedRequest}
                actionLabel={copy.edit}
                actionAriaLabel={`${copy.edit}: ${copy.requestHeaders}`}
                isEditing={editingRow === 'headers'}
                isDisabled={allActionsBusy}
                canSave={hasHeaderDraftChanges}
                saveLabel={copy.save}
                cancelLabel={copy.cancel}
                onEdit={() => openRow('headers')}
                onCancel={() => {
                  setHeaderDrafts(savedRequestHeaderDrafts(savedHeaderNames));
                  setEditingRow(null);
                }}
                onSave={async () => {
                  if (await saveRequestHeaders()) setEditingRow(null);
                }}
              >
                <RequestHeadersEditor
                  headers={headerDrafts}
                  onHeadersChange={setHeaderDrafts}
                  disabled={allActionsBusy}
                  hideTitle
                  copy={{
                    headers: copy.requestHeaders,
                    headerName: copy.headerName,
                    headerValue: copy.headerValue,
                    retainedValue: copy.retainedHeaderValue,
                    addHeader: copy.addHeader,
                    removeHeader: copy.removeHeader,
                    noHeaders: copy.noRequestHeaders,
                  }}
                />
              </SettingsExpandableRow>
              <Divider />
              <SettingsExpandableRow
                label={copy.extraRequestBody}
                value={connection.requestBodyOverlay ? copy.keySet : copy.noAdvancedRequest}
                actionLabel={copy.edit}
                actionAriaLabel={`${copy.edit}: ${copy.extraRequestBody}`}
                isEditing={editingRow === 'body'}
                isDisabled={allActionsBusy}
                canSave={bodyDraft !== savedBodyText}
                saveLabel={copy.save}
                cancelLabel={copy.cancel}
                onEdit={() => openRow('body')}
                onCancel={() => {
                  setBodyDraft(savedBodyText);
                  setEditingRow(null);
                }}
                onSave={async () => {
                  if (await saveRequestBody()) setEditingRow(null);
                }}
              >
                <RequestBodyEditor
                  bodyText={bodyDraft}
                  onBodyTextChange={setBodyDraft}
                  disabled={allActionsBusy}
                  hideLabel
                  copy={{ body: copy.extraRequestBody, bodyHelp: copy.extraRequestBodyHelp }}
                />
              </SettingsExpandableRow>
              <Divider />
        </VStack>
      </DetailSection>
      <DetailSection title={copy.modelManagement} description={copy.modelManagementHelp}>
        <EnabledModelManager
          modelChoices={modelChoices}
          enabledModelIds={enabledModelIds}
          disabled={allActionsBusy}
          onChange={(next) => void updateEnabledModels(next)}
        />
        {/* Each button reports its own work through clickAction (spinner +
            aria-busy + "Loading" announcement) instead of renaming itself to
            测试中… — the section's `detailActionBusy` still says only one
            connection action runs at a time. `refreshModels` is wrapped
            because it takes an options object: handing it the click event
            would pass a MouseEvent as `opts`. */}
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button variant="secondary" isDisabled={allActionsBusy || !hasUsableCredential} clickAction={() => runTest()} label={copy.testConnection} />
          {supportsRemoteDiscovery && (
            <Button variant="ghost" isDisabled={allActionsBusy || !hasUsableCredential} clickAction={() => refreshModels()} label={copy.updateModels} />
          )}
        </HStack>
      </DetailSection>
      {showsCapabilities && (
        <>
          <Divider />
          <DetailSection title={copy.capabilities} description={copy.capabilitiesHelp}>
            <VStack gap={4}>
              {capabilityModelIds.map((modelId, modelIndex) => {
                const declared: RelayModelProfile | undefined = relayProfileDraft[modelId];
                // Vision resolves to one of three states: absent (Auto),
                // true (Enabled), false (explicitly Disabled). Only Auto is
                // ever ambiguous, and three distinct controls keep it honest.
                const visionValue =
                  declared?.vision === true
                    ? 'enabled'
                    : declared?.vision === false
                      ? 'disabled'
                      : 'auto';
                const draftLevels = declared?.thinkingLevels ?? [];
                const serviceTierValue = declared?.serviceTier ?? 'auto';
                const showsFastMode = supportsRelayFastServiceTier(
                  connection.providerType,
                  modelId,
                );
                // The menu offers the five declarable levels PLUS anything
                // the stored table already claims — a level saved while it
                // was still declarable (or hand-written into the document)
                // must stay visible and un-checkable, never an invisible
                // selection the trigger counts but the menu cannot show.
                const menuLevels: readonly ThinkingLevel[] = THINKING_LEVELS.filter(
                  (level) =>
                    (DECLARABLE_RELAY_THINKING_LEVELS as readonly ThinkingLevel[]).includes(
                      level,
                    ) || draftLevels.includes(level),
                );
                return (
                  <VStack key={modelId} gap={3}>
                    {modelIndex > 0 && <Divider />}
                    <Text weight="semibold">{modelId}</Text>
                    {/* One row per declaration: label + what it does on the
                        left, one compact control on the right (the 模型功能
                        row language). A CheckboxList wall was the reason this
                        section looked like a form from a different app. */}
                    <CapabilityRow label={copy.thinkingEffort} description={copy.thinkingEffortHelp}>
                      {/* DropdownMenu, not MultiSelector: levels have a
                          canonical order (low → max) that must not shuffle —
                          MultiSelector pins the selected-at-open options to
                          the top with no opt-out, which misread as the
                          declaration being order-sensitive. Checkbox items
                          stay open between toggles; the trigger carries the
                          已选择 N 个 state line. */}
                      <DropdownMenu
                        button={{
                          variant: 'secondary',
                          size: 'sm',
                          label:
                            draftLevels.length > 0
                              ? copy.thinkingSelectedCount(draftLevels.length)
                              : copy.thinkingUndeclared,
                          'aria-label': `${copy.thinkingEffort} — ${modelId}`,
                          isDisabled: allActionsBusy,
                        }}
                        hasChevron
                        menuWidth={224}
                      >
                        {menuLevels.map((level) => (
                          <DropdownMenuCheckboxItem
                            key={level}
                            label={level}
                            aria-label={`${modelId} ${level}`}
                            value={draftLevels.includes(level)}
                            onChange={(checked) => {
                              setDraftThinkingLevels(
                                modelId,
                                checked
                                  ? [...draftLevels, level]
                                  : draftLevels.filter((existing) => existing !== level),
                              );
                            }}
                            isDisabled={allActionsBusy}
                          />
                        ))}
                      </DropdownMenu>
                    </CapabilityRow>
                    <CapabilityRow label={copy.visionInput} description={copy.visionInputHelp}>
                      <Selector
                        label={`${copy.visionInput} — ${modelId}`}
                        isLabelHidden
                        size="sm"
                        width={132}
                        options={[
                          { value: 'auto', label: copy.visionAuto },
                          { value: 'enabled', label: copy.visionEnabledOption },
                          { value: 'disabled', label: copy.visionDisabledOption },
                        ]}
                        value={visionValue}
                        onChange={(value) =>
                          setDraftVision(
                            modelId,
                            value === 'auto' ? undefined : value === 'enabled',
                          )
                        }
                        isDisabled={allActionsBusy}
                      />
                    </CapabilityRow>
                    <CapabilityRow label={copy.contextWindow} description={copy.contextWindowHelp}>
                      <DeclaredContextWindowField
                        declared={declared?.contextWindow}
                        disabled={allActionsBusy}
                        label={copy.contextWindow}
                        onCommit={(value) =>
                          setDraftContextWindow(modelId, value ?? undefined)
                        }
                      />
                    </CapabilityRow>
                    {showsFastMode && (
                      <CapabilityRow label={copy.fastMode} description={copy.fastModeHelp}>
                        <Selector
                          label={`${copy.fastMode} — ${modelId}`}
                          isLabelHidden
                          size="sm"
                          width={132}
                          options={[
                            { value: 'auto', label: copy.fastAuto },
                            { value: 'fast', label: copy.fastEnabled },
                          ]}
                          value={serviceTierValue}
                          onChange={(value) =>
                            setDraftServiceTier(modelId, value === 'fast' ? 'fast' : undefined)
                          }
                          isDisabled={allActionsBusy}
                        />
                      </CapabilityRow>
                    )}
                  </VStack>
                );
              })}
              {/* One commit for the whole table. Draft edits stay local until
                  this lands; the button only arms when the draft truly differs
                  from the saved table (both sides pass the write-path
                  normalizer, so reordering levels doesn't arm it falsely). */}
              <HStack gap={2} justify="end">
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={allActionsBusy || !hasRelayProfileChanges}
                  clickAction={() => void saveRelayProfiles()}
                  label={copy.saveCapabilities}
                />
              </HStack>
            </VStack>
          </DetailSection>
        </>
      )}
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
          <Button variant="destructive" isDisabled={allActionsBusy} isLoading={deleting} onClick={() => void remove()} label={copy.delete} />
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
// A context-window draft commits on blur/Enter only: NumberInput fires
// onChange per *valid* keystroke, and "128000" must arrive as one draft edit,
// not six. The committed draft stays local until the section's 保存 — nothing
// here writes the connection itself. The draft resyncs from the controller's
// draft whenever it changes (seed, save round-trip, or an unrelated field).
function DeclaredContextWindowField(props: {
  declared: number | undefined;
  disabled: boolean;
  label: string;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState<number | null>(props.declared ?? null);
  useEffect(() => {
    setDraft(props.declared ?? null);
  }, [props.declared]);
  function commit() {
    if ((draft ?? undefined) === props.declared) return;
    props.onCommit(draft);
  }
  return (
    <NumberInput
      size="sm"
      width={200}
      label={props.label}
      isLabelHidden
      value={draft}
      hasClear
      isIntegerOnly
      min={1}
      onChange={setDraft}
      onBlur={commit}
      onEnter={commit}
      isDisabled={props.disabled}
    />
  );
}

/**
 * One declaration row in the 模型功能 shape: what it is (label) and what it
 * does (one supporting sentence) on the left, its one compact control on the
 * right. The text column flexes and wraps; the control never does.
 */
function CapabilityRow(props: { label: string; description: string; children: ReactNode }) {
  return (
    <HStack gap={4} justify="between" vAlign="start">
      <VStack gap={1} maxWidth={380}>
        <Text size="sm">{props.label}</Text>
        <Text type="supporting" color="secondary">{props.description}</Text>
      </VStack>
      {props.children}
    </HStack>
  );
}

function DetailSection(props: { title: string; description: string; children: ReactNode }) {
  return (
    /* `columnGap`, not `gap`: the template's 10 is the gutter BETWEEN the two
       columns. At this column's width the grid is one column, and a 10-step
       row gap there reads as a hole between a heading and the thing it
       labels. */
    <Grid columns={{ minWidth: 320 }} columnGap={10} rowGap={4} role="region" aria-label={props.title}>
      <VStack gap={0.5}>
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
function connectionIssueStatus(tone: StatusSemantic): 'error' | 'success' | 'info' {
  if (tone === 'error') return 'error';
  if (tone === 'success') return 'success';
  // Banner has a real `info` rung, unlike StatusDot — so this is the
  // component's own quiet status, not the missing-rung workaround the dots
  // had to fake with accent. Left as-is on that basis.
  return 'info';
}

function GitHubCopilotReloginNotice(props: {
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const host = useRuntimeHostSettingsTarget();
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
      const result = await window.maka.githubCopilotSubscription.connectExistingLogin(host);
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
