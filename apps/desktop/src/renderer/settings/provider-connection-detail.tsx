/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Badge,
  Banner,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  HStack,
  Link,
  Switch,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
import { isRelayProviderType, PROVIDER_REGISTRY } from '@maka/core/llm-connections';
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
import { SettingsActions, SettingsRow, SettingsSection } from './settings-section';
import { providerDisplay } from './provider-display';
import { AddModelDialog } from './provider-add-model-dialog';
import {
  RuntimeHostSettingsGenerationBoundary,
  useRuntimeHostSettingsErrorReporter,
} from './runtime-host-settings-target.js';
import { useOAuthLoginFlow } from './use-oauth-login-flow';
import {
  getProviderSettingsCopy,
  providerPanelActionErrorMessage,
  type CredentialPresenceStatus,
} from '../features/connection-settings';
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
import { bulkThinkingLevelStates } from './relay-thinking-bulk';
import { endpointCarriesCredentials, providerEndpointPresentation } from './provider-endpoint-presentation';

/** Past this many model rows the list needs a filter to be usable. */
const MODEL_FILTER_THRESHOLD = 8;

export function ConnectionDetail(props: ConnectionDetailProps) {
  const defaults = PROVIDER_REGISTRY[props.connection.providerType];
  // Unknown providerType (a connection persisted on a branch that registers a
  // provider this build doesn't know) → render a non-actionable fallback so
  // opening the orphan connection doesn't crash on `.authKind`/`.baseUrl`.
  // Mirrors `isRealConnection` in @maka/core/connection-readiness.ts.
  if (!defaults) return <UnknownConnectionDetail props={props} />;
  return <ConnectionDetailInner {...props} />;
}

function UnknownConnectionDetail({ props }: { props: ConnectionDetailProps }) {
  const reportHostError = useRuntimeHostSettingsErrorReporter();
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
      await props.bridge.delete({ connectionId: connection.connectionId, slug: connection.slug });
      if (!mounted.current) return;
      await props.onDeleted();
    } catch (error) {
      if (!mounted.current) return;
      reportHostError(
        copy.deleteFailed,
        providerPanelActionErrorMessage(error, locale),
      );
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

type EditingRow =
  | 'name'
  | 'key'
  | 'endpoint'
  | 'headers'
  | 'body'
  | { model: string }
  /* The 添加模型 dialog: one thing is open at a time, so it is a row here. */
  | 'add-model'
  | null;

function ConnectionDetailInner(props: ConnectionDetailProps) {
  const reportHostError = useRuntimeHostSettingsErrorReporter();
  const locale = useUiLocale();
  const providerCopy = getProviderSettingsCopy(locale);
  const copy = providerCopy.detail;
  const { connection } = props;
  const defaults = PROVIDER_REGISTRY[connection.providerType];
  const display = providerDisplay(connection.providerType, locale);
  const {
    apiKey,
    setApiKey,
    hasSecret,
    name,
    setName,
    baseUrl,
    setBaseUrl,
    enabledModelIds,
    modelChoices,
    testing,
    deleting,
    detailActionBusy,
    supportsApiKey,
    needsOAuth,
    retired,
    oauthLoginService,
    supportsRemoteDiscovery,
    credentialProbePending,
    hasUsableCredential,
    apiKeyStatusHint,
    hasApiKeyChange,
    hasBaseUrlChange,
    hasNameChange,
    savedName,
    issue,
    lastTestMessage,
    lastTestAtMs,
    savedBaseUrl,
    save,
    updateEnabledModels,
    addDeclaredModel,
    relayProfileDraft,
    hasRelayProfileChanges,
    setDraftThinkingLevels,
    saveThinkingLevelForAll,
    setDraftVision,
    setDraftContextWindow,
    setDraftServiceTier,
    resetDraftProfile,
    saveRelayProfiles,
    runTest,
    refreshModels,
    remove,
    refreshAfterRelogin,
  } = useConnectionDetail(props);
  // A model gets a capability editor when Maka cannot describe it otherwise.
  // On a custom OpenAI relay that is every model: the id is whatever the
  // operator chose, so even one that collides with a known name may front
  // something else entirely. Elsewhere it is the models the Host-resolved
  // catalog entry reports no metadata for — one the user typed in on a provider
  // whose key cannot call a model-list endpoint, which no refresh will ever
  // describe (#1584). The entry answers this, not the renderer's bundled table:
  // the Host owns the catalog and may have refreshed it since this build (#4496).
  //
  // A model that already carries a declaration always keeps its editor, or a
  // stale declaration would be uneditable and unclearable.
  const isRelay = isRelayProviderType(connection.providerType);
  const entryById = new Map(modelChoices.map((entry) => [entry.id, entry]));
  // Only enabled models declare — the store prunes a model's profile the
  // moment it is disabled, so no declaration can ever belong to a row that is
  // off.
  const capabilityModelIds = enabledModelIds.filter((modelId) => {
    if (isRelay || relayProfileDraft[modelId] !== undefined) return true;
    // A missing entry is a model the catalog dropped — a quarantined id the
    // provider registry filters out of the list but `enabledModelIds` still
    // carries so the user can untick it — not one the Host failed to describe.
    // Treating absence as "no metadata" would grow an editor `main` never
    // showed; only a present-but-uncovered entry needs the hand editor (the
    // #1584 typed id, which `savedModelIds` always gives an entry).
    const entry = entryById.get(modelId);
    return entry !== undefined && !entry.describedByMetadata;
  });
  const declaringModelIds = new Set(capabilityModelIds);
  // The bulk control edits the relay-only thinking declaration and needs
  // repetition to be worth a control at all: with one row it would be a second
  // widget doing what the row under it already does.
  const showsThinkingBulk = isRelay && capabilityModelIds.length > 1;
  // One row is a form at a time, the way the settings-sidebar template does it.
  // Opening a row discards the other's draft: leaving an abandoned draft in
  // state meant it reappeared when the user came back to that row, and — until
  // `save` became per-field — rode along with the next save.
  const [editingRow, setEditingRow] = useState<EditingRow>(null);
  const editingModelId = editingRow !== null && typeof editingRow === 'object' ? editingRow.model : null;
  const [modelFilter, setModelFilter] = useState('');
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
    setModelFilter('');
    void props.bridge
      .getRequestHeaders({ connectionId: connection.connectionId, slug: connection.slug })
      .then(({ names }) => {
        if (!current) return;
        setSavedHeaderNames(names);
        setHeaderDrafts(savedRequestHeaderDrafts(names));
      })
      .catch((error) => {
        if (!current) return;
        reportHostError(
          copy.requestCustomizationInvalid,
          providerPanelActionErrorMessage(error, locale),
        );
      });
    return () => {
      current = false;
    };
  }, [connection.slug, props.bridge, toast]);

  function openRow(row: Exclude<EditingRow, null>) {
    // Opening one row abandons whatever another row was holding: only one is
    // editable at a time, so a draft left behind would be saved by a later
    // action the user never connected to it.
    if (editingModelId !== null) resetDraftProfile(editingModelId);
    if (row !== 'name') setName(savedName);
    if (row === 'key') setBaseUrl(savedBaseUrl);
    else if (row === 'endpoint') setApiKey('');
    else if (row === 'headers') setHeaderDrafts(savedRequestHeaderDrafts(savedHeaderNames));
    else if (row === 'body') setBodyDraft(savedBodyText);
    else if (row === 'name' || typeof row === 'object') {
      setApiKey('');
      setBaseUrl(savedBaseUrl);
    }
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
      const saved = await props.bridge.setRequestHeaders(
        { connectionId: connection.connectionId, slug: connection.slug },
        updates,
      );
      if (!mounted.current) return true;
      setSavedHeaderNames(saved.names);
      setHeaderDrafts(savedRequestHeaderDrafts(saved.names));
      await props.onChanged();
      return true;
    } catch (error) {
      if (mounted.current) {
        reportHostError(
          copy.saveFailed,
          providerPanelActionErrorMessage(error, locale),
        );
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
      await props.bridge.update(
        { connectionId: connection.connectionId, slug: connection.slug },
        { requestBodyOverlay: overlay ?? null },
      );
      await props.onChanged();
      return true;
    } catch (error) {
      if (mounted.current) {
        reportHostError(
          copy.saveFailed,
          providerPanelActionErrorMessage(error, locale),
        );
      }
      return false;
    } finally {
      if (mounted.current) setRequestCustomizationBusy(false);
    }
  }
  // Every known connection reports where requests go. Editability remains the
  // narrower authority: built-in and derived endpoints are visible but fixed,
  // while custom relays and local runtimes keep their existing editor.
  const endpoint = providerEndpointPresentation(connection);
  const endpointValue = endpoint.value
    ? <code className="settingsReadOnlyValue providerEndpointValue" data-mono="true">{endpoint.value}</code>
    : endpoint.emptyState === 'managed'
      ? copy.endpointManaged
      : copy.endpointMissing;
  // Model-level endpoint overrides mean the connection-level base is not the
  // whole truth for every model; say so under the value rather than implying
  // one address serves all models.
  const endpointNote = endpoint.modelOverrides
    ? <span className="providerEndpointNote">{copy.endpointModelOverridesNote}</span>
    : null;
  const endpointDisplay = endpointNote ? <>{endpointValue}{endpointNote}</> : endpointValue;
  // A credential-bearing saved endpoint must not prefill a plain text input:
  // the editor falls back to the masked-by-default PasswordInput, which the
  // user can deliberately reveal.
  const endpointHasCredentials = endpointCarriesCredentials(savedBaseUrl);

  // The rows are the chat-capable catalog, plus any enabled id the catalog no
  // longer lists (a stale id, or a model dropped from the latest fetch) so the
  // user can still switch it off. Catalog order throughout: the enabled ones
  // are marked, not hoisted, so a row does not jump when it is toggled.
  const modelRows = (() => {
    const seen = new Set<string>();
    const rows: Array<{ id: string; entry: (typeof modelChoices)[number] | undefined }> = [];
    for (const entry of modelChoices) {
      if (!entry.canUseAsChatDefault) continue;
      seen.add(entry.id);
      rows.push({ id: entry.id, entry });
    }
    for (const id of enabledModelIds) {
      if (seen.has(id)) continue;
      rows.push({ id, entry: entryById.get(id) });
    }
    return rows;
  })();
  const normalizedModelFilter = modelFilter.trim().toLocaleLowerCase();
  const visibleModelRows = modelRows.filter(({ id, entry }) =>
    !normalizedModelFilter ||
    [id, entry?.displayName ?? '']
      .some((value) => value.toLocaleLowerCase().includes(normalizedModelFilter)));
  const showsModelFilter = modelRows.length > MODEL_FILTER_THRESHOLD;
  const enabledCount = modelRows.filter(({ id }) => enabledModelIds.includes(id)).length;

  // The last test is a dated fact, not a live signal, so it reads as one
  // supporting line — 正常 · time, or the failure and its message — rather
  // than a status dot, which would claim the page is watching the connection
  // right now. Only a failure gets color: a Token in the error tone, so the
  // healthy row stays as quiet as the rows around it.
  const statusLabel = issue
    ? issue.label
    : connection.lastTestStatus === 'verified'
      ? copy.statusHealthy
      : copy.statusUntested;
  const statusDetail = lastTestMessage && lastTestMessage !== statusLabel ? lastTestMessage : null;
  const statusDescription = (
    <HStack gap={1.5} vAlign="center" wrap="wrap">
      {issue ? <Token size="sm" color="red" label={statusLabel} /> : <span>{statusLabel}</span>}
      {statusDetail && <span>· {statusDetail}</span>}
      {Number.isFinite(lastTestAtMs) && <span>· <RelativeTime ts={lastTestAtMs} /></span>}
    </HStack>
  );

  function modelEnableSwitch(id: string, label: string) {
    const enabled = enabledModelIds.includes(id);
    return (
      <Switch
        label={copy.enableModelAria(label)}
        isLabelHidden
        size="sm"
        value={enabled}
        isDisabled={allActionsBusy}
        changeAction={() =>
          updateEnabledModels(
            enabled ? enabledModelIds.filter((existing) => existing !== id) : [...enabledModelIds, id],
          )
        }
      />
    );
  }

  return (
    <VStack gap={8}>
      {needsOAuth && (
        retired ? (
          <Banner status="error" role="alert" title={copy.oauthRetired} description={copy.oauthRetiredDetail} />
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
      {/* The settled values (name, key, endpoint) are rows in the
          settings-sidebar template's language: a row reports its state and
          carries one affordance, and only becomes a form when the user asks
          it to. A credential and an endpoint are set once and then read; a
          permanent input box for each was the page telling the user to fill
          in something that is already filled in. */}
      <SettingsSection
        title={copy.credentials}
        /* One claim, not four phrasings of it: the credential never leaves this
           machine. The endpoint is not a secret, so it did not need a variant. */
        description={supportsApiKey ? copy.credentialsHelp : copy.credentialsHelpAccount}
      >
        {/* The name row is outside the key/endpoint guard below: a connection
            with neither — an OAuth subscription, say — still has a name, and
            hiding the only editable field it has would leave the section
            empty. It comes first because it is the field the user chose. */}
        {!retired && (
          <SettingsExpandableRow
            label={copy.connectionName}
            value={savedName || connection.slug}
            actionLabel={copy.edit}
            actionAriaLabel={`${copy.edit}: ${copy.connectionName}`}
            isEditing={editingRow === 'name'}
            isDisabled={allActionsBusy}
            canSave={hasNameChange}
            saveLabel={copy.save}
            cancelLabel={copy.cancel}
            onEdit={() => openRow('name')}
            onCancel={() => { setName(savedName); setEditingRow(null); }}
            onSave={async () => { if (await save('name')) setEditingRow(null); }}
          >
            <TextInput
              label={copy.connectionName}
              isLabelHidden
              value={name}
              onChange={setName}
              placeholder={copy.connectionNamePlaceholder}
              isDisabled={allActionsBusy}
            />
          </SettingsExpandableRow>
        )}
        {supportsApiKey && !retired && (
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
        )}
        {endpoint.editable && !retired ? (
          <SettingsExpandableRow
            label={copy.endpoint}
            value={endpointDisplay}
            actionLabel={copy.edit}
            actionAriaLabel={`${copy.edit}: ${copy.endpoint}`}
            isEditing={editingRow === 'endpoint'}
            isDisabled={allActionsBusy}
            canSave={hasBaseUrlChange}
            saveLabel={copy.save}
            cancelLabel={copy.cancel}
            onEdit={() => openRow('endpoint')}
            onCancel={() => { setBaseUrl(savedBaseUrl); setEditingRow(null); }}
            onSave={async () => { if (await save('endpoint')) setEditingRow(null); }}
          >
            {endpointHasCredentials ? (
              <PasswordInput
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder={defaults.baseUrl}
                label={copy.endpoint}
                isLabelHidden
                description={copy.endpointCredentialsMasked}
                isDisabled={allActionsBusy}
              />
            ) : (
              <TextInput
                label={copy.endpoint}
                isLabelHidden
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder={defaults.baseUrl}
                isDisabled={allActionsBusy}
              />
            )}
          </SettingsExpandableRow>
        ) : (
          <SettingsRow label={copy.endpoint} description={endpointDisplay} align="start" />
        )}
        {!retired && (
          <SettingsRow
            label={copy.status}
            description={statusDescription}
            end={(
              /* clickAction reports the probe through the button itself
                 (spinner + aria-busy) instead of renaming it to 测试中… */
              <Button
                variant="secondary"
                size="sm"
                isDisabled={allActionsBusy || !hasUsableCredential}
                isLoading={testing}
                clickAction={() => runTest()}
                label={copy.testConnection}
              />
            )}
          />
        )}
      </SettingsSection>
      {/* Everything below writes to the connection, and a retired one accepts
          no writes: the catalog refuses a model or request-body change, and the
          credential vault refuses a request header. Rendering the editors would
          offer work that either fails or — worse, before the vault refused it —
          saves something that can never reach a request. What remains is the
          retirement notice above and the deletion below. */}
      {!retired && (
        <SettingsSection
          title={copy.modelManagement}
          description={modelRows.length > 0
            ? `${copy.modelsSummary(enabledCount, modelRows.length)} · ${copy.modelManagementHelp}`
            : copy.modelManagementHelp}
          action={(
            <HStack gap={2} vAlign="center" wrap="wrap">
              {/* Both, wherever refresh exists. Refresh is the fast path and
                  stays first, but having a model-list endpoint does not mean
                  the endpoint answers for this account: a self-hosted gateway
                  on `openai-compatible` may not serve /models at all, and a
                  provider's list can lag a model the account already has.
                  Making the two alternatives left those users with no way in
                  (#1584). `refreshModels` is wrapped because it takes an
                  options object: handing it the click event would pass a
                  MouseEvent as `opts`. */}
              {supportsRemoteDiscovery && (
                <Button variant="secondary" size="sm" isDisabled={allActionsBusy || !hasUsableCredential} clickAction={() => refreshModels()} label={copy.updateModels} />
              )}
              <Button variant="secondary" size="sm" isDisabled={allActionsBusy} onClick={() => openRow('add-model')} label={copy.addModel} />
              {/* One control for the whole table. A relay usually fronts one
                  model family that accepts the same reasoning_effort values,
                  and declaring that per row was models × levels clicks for a
                  single fact. A tick here saves at once — there is no editor
                  open to hold a draft — so it waits while a row's editor is
                  open rather than committing that row's half-typed draft. */}
              {showsThinkingBulk && (
                <DropdownMenu
                  button={{
                    variant: 'secondary',
                    size: 'sm',
                    label: copy.thinkingBulk,
                    'aria-label': copy.thinkingBulk,
                    isDisabled: allActionsBusy || editingModelId !== null,
                  }}
                  hasChevron
                  menuWidth={240}
                >
                  {/* The declarable vocabulary, which is the whole of what a
                      draft can hold: the seed sanitizes through
                      `normalizeRelayModelProfiles`, so `off` — a disable wire
                      no generic relay is presumed to speak — cannot reach a
                      row here either. */}
                  {bulkThinkingLevelStates(
                    capabilityModelIds,
                    relayProfileDraft,
                    DECLARABLE_RELAY_THINKING_LEVELS,
                  ).map((state) => (
                    <DropdownMenuCheckboxItem
                      key={state.level}
                      label={state.level}
                      /* The box only ticks at full coverage, so the count is
                         the sole place partial coverage is legible — without
                         it "3 of 5 declare high" and "none do" present as the
                         same empty box. */
                      description={copy.thinkingBulkCoverage(state.declaredCount, state.total)}
                      aria-label={`${copy.thinkingBulk} ${state.level}`}
                      /* The item's `description` is visible text only — the
                         component does not wire it to `aria-describedby`, and
                         this item's own `aria-label` replaces the name the
                         description would otherwise have joined. Without this,
                         "1/4 个模型" and "全部未声明" both reach a screen reader
                         as an unchecked box with the same name, which is
                         exactly the partial state the count exists to show. */
                      aria-description={copy.thinkingBulkCoverage(
                        state.declaredCount,
                        state.total,
                      )}
                      value={state.checked}
                      onChange={(checked) => {
                        void saveThinkingLevelForAll(capabilityModelIds, state.level, checked);
                      }}
                      isDisabled={allActionsBusy}
                    />
                  ))}
                </DropdownMenu>
              )}
            </HStack>
          )}
        >
          {showsModelFilter && (
            <SettingsRow
              label={(
                <>
                  <TextInput
                    value={modelFilter}
                    onChange={setModelFilter}
                    placeholder={copy.filterModels}
                    label={copy.filterModels}
                    isLabelHidden
                    hasClear
                    size="sm"
                    width="100%"
                  />
                  {/* The filter rewrites the rows below without moving focus,
                      so the new count is spoken. Always mounted: a live region
                      added at the same time as its text is not announced. */}
                  <span className="maka-visually-hidden" role="status" aria-live="polite">
                    {modelFilter.trim() ? providerCopy.shared.filterMatches(visibleModelRows.length) : ''}
                  </span>
                </>
              )}
            />
          )}
          {modelRows.length === 0 ? (
            <SettingsRow label={copy.noModels} />
          ) : visibleModelRows.length === 0 ? (
            <SettingsRow
              label={copy.noModelsMatch}
              end={<Button variant="ghost" size="sm" label={copy.cancel} onClick={() => setModelFilter('')} />}
            />
          ) : visibleModelRows.map(({ id, entry }) => {
            const label = entry?.displayName?.trim() || id;
            const declared: RelayModelProfile | undefined = relayProfileDraft[id];
            const declares = declaringModelIds.has(id);
            // One supporting line, the facts separated by dots: the id when it
            // differs from the name, then what the model can do. Plain text,
            // not a token per fact — three pills under a name and a badge read
            // as clutter, and none of these is a state to scan for.
            const factParts = [
              label !== id ? id : null,
              entry?.contextWindow !== undefined ? copy.contextToken(formatTokenCount(entry.contextWindow)) : null,
              entry?.supportsVision ? copy.visionToken : null,
              entry !== undefined && entry.thinkingLevels.length > 0 ? copy.thinkingToken : null,
              declares && declared === undefined ? copy.modelUndescribed : null,
            ].filter((part): part is string => part !== null);
            const facts = factParts.length > 0 ? factParts.join(' · ') : undefined;
            const rowLabel = entry?.isDefault ? (
              <HStack gap={2} vAlign="center">
                <span>{label}</span>
                <Badge variant="neutral" label={providerCopy.panel.default} />
              </HStack>
            ) : label;
            if (!declares) {
              return (
                <SettingsRow
                  key={id}
                  label={rowLabel}
                  description={facts}
                  align="start"
                  end={modelEnableSwitch(id, label)}
                />
              );
            }
            return (
              <SettingsExpandableRow
                key={id}
                label={rowLabel}
                value={facts}
                actionLabel={copy.declareCapabilities}
                actionAriaLabel={copy.declareCapabilitiesAria(label)}
                beforeAction={modelEnableSwitch(id, label)}
                isEditing={editingModelId === id}
                isDisabled={allActionsBusy}
                canSave={hasRelayProfileChanges}
                saveLabel={copy.save}
                cancelLabel={copy.cancel}
                onEdit={() => openRow({ model: id })}
                onCancel={() => { resetDraftProfile(id); setEditingRow(null); }}
                onSave={async () => { if (await saveRelayProfiles()) setEditingRow(null); }}
              >
                <Text type="supporting" color="secondary">{copy.capabilitiesHelp}</Text>
                <CapabilityEditor
                  copy={copy}
                  modelId={id}
                  isRelay={isRelay}
                  declared={declared}
                  disabled={allActionsBusy}
                  showsFastMode={supportsRelayFastServiceTier(connection.providerType, id)}
                  reportedContextWindow={connection.models?.find((model) => model.id === id)?.contextWindow}
                  onThinkingLevels={(levels) => setDraftThinkingLevels(id, levels)}
                  onVision={(vision) => setDraftVision(id, vision)}
                  onContextWindow={(value) => setDraftContextWindow(id, value ?? undefined)}
                  onServiceTier={(tier) => setDraftServiceTier(id, tier)}
                />
              </SettingsExpandableRow>
            );
          })}
        </SettingsSection>
      )}
      <AddModelDialog
        isOpen={editingRow === 'add-model'}
        /* The catalog, not just the selection: the resolved entries are usually
           a proper superset of what the user enabled. Checking only the
           selection lets a listed-but-unchecked id through, and the dialog
           then requires a hand-typed context window that overrides the one
           Maka already knows. The entries rather than the stored rows, so a
           provider that ships its inventory instead of storing it still
           answers "already known" for every model it offers. */
        existingModelIds={modelChoices.map(({ id }) => id)}
        /* A write started after the dialog opened would make the store drop
           this submission silently, taking the typed id with it. */
        isSubmitDisabled={allActionsBusy}
        onOpenChange={(open) => setEditingRow(open ? 'add-model' : null)}
        onSubmit={addDeclaredModel}
      />
      {!retired && (
        <SettingsSection title={copy.advancedRequest} description={copy.advancedRequestHelp}>
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
        </SettingsSection>
      )}
      {/* Deletion is last, and the only thing beside it is its own warning —
          no quiet action next to the destructive one for a mis-aimed cursor. */}
      <SettingsSection title={copy.dangerZone} description={copy.deleteRowHelp}>
        <SettingsActions>
          {/* onClick, not clickAction: `remove` awaits toast.confirm, which
              cannot render from inside clickAction's transition (see the
              fallback detail above). `deleting` already drives
              detailActionBusy; feeding it to isLoading puts the spinner on
              the button that is actually working. */}
          <Button variant="destructive" isDisabled={allActionsBusy} isLoading={deleting} onClick={() => void remove()} label={copy.delete} />
        </SettingsActions>
      </SettingsSection>
    </VStack>
  );
}

/** 128000 → 128k, 1048576 → 1M: the token count as a model page prints it. */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  return `${Math.round(value / 1000)}k`;
}

/**
 * The declaration editor for one model, inside its expanded row: each fact
 * as a label + one sentence on the left and one compact control on the right.
 * Edits land in the hook's per-model draft; the row's 保存 commits the table.
 */
function CapabilityEditor(props: {
  copy: ReturnType<typeof getProviderSettingsCopy>['detail'];
  modelId: string;
  isRelay: boolean;
  declared: RelayModelProfile | undefined;
  disabled: boolean;
  showsFastMode: boolean;
  /** The window the provider's model list reports, offered as a one-click fill while nothing is declared. */
  reportedContextWindow: number | undefined;
  onThinkingLevels(levels: ThinkingLevel[] | undefined): void;
  onVision(vision: boolean | undefined): void;
  onContextWindow(value: number | null): void;
  onServiceTier(tier: 'fast' | undefined): void;
}) {
  const { copy, modelId, declared } = props;
  // Vision resolves to one of three states: absent (Auto), true (Enabled),
  // false (explicitly Disabled). Only Auto is ever ambiguous, and three
  // distinct options keep it honest.
  const visionValue =
    declared?.vision === true ? 'enabled' : declared?.vision === false ? 'disabled' : 'auto';
  const draftLevels = declared?.thinkingLevels ?? [];
  // The menu offers the five declarable levels PLUS anything the stored table
  // already claims — a level saved while it was still declarable (or
  // hand-written into the document) must stay visible and un-checkable, never
  // an invisible selection the trigger counts but the menu cannot show.
  const menuLevels: readonly ThinkingLevel[] = THINKING_LEVELS.filter(
    (level) =>
      (DECLARABLE_RELAY_THINKING_LEVELS as readonly ThinkingLevel[]).includes(level) ||
      draftLevels.includes(level),
  );
  return (
    <VStack gap={3}>
      {/* Relay-only, like 快速模式 below: a declared level encodes into
          `reasoning_effort`, a wire field only the OpenAI-compatible relays
          accept. The catalog codec refuses to persist one elsewhere, so
          offering the control would promise an edit that cannot be saved. */}
      {props.isRelay && (
        <CapabilityField label={copy.thinkingEffort} description={copy.thinkingEffortHelp}>
          {/* DropdownMenu, not MultiSelector: levels have a canonical order
              (low → max) that must not shuffle — MultiSelector pins the
              selected-at-open options to the top with no opt-out, which
              misread as the declaration being order-sensitive. */}
          <DropdownMenu
            button={{
              variant: 'secondary',
              size: 'sm',
              label:
                draftLevels.length > 0
                  ? copy.thinkingSelectedCount(draftLevels.length)
                  : copy.thinkingUndeclared,
              'aria-label': `${copy.thinkingEffort} — ${modelId}`,
              isDisabled: props.disabled,
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
                  props.onThinkingLevels(
                    checked
                      ? [...draftLevels, level]
                      : draftLevels.filter((existing) => existing !== level),
                  );
                }}
                isDisabled={props.disabled}
              />
            ))}
          </DropdownMenu>
        </CapabilityField>
      )}
      <CapabilityField label={copy.visionInput} description={copy.visionInputHelp}>
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
          onChange={(value) => props.onVision(value === 'auto' ? undefined : value === 'enabled')}
          isDisabled={props.disabled}
        />
      </CapabilityField>
      <CapabilityField label={copy.contextWindow} description={copy.contextWindowHelp}>
        <VStack gap={1} hAlign="start">
          <DeclaredContextWindowField
            declared={declared?.contextWindow}
            disabled={props.disabled}
            /* Named per model, like the controls around it: the visible label
               is the field's, but the control's own name is all a screen reader
               gets, and every open row carries the same one. */
            label={`${copy.contextWindow} — ${modelId}`}
            onCommit={props.onContextWindow}
          />
          {declared?.contextWindow === undefined && props.reportedContextWindow !== undefined && (
            <HStack gap={1} vAlign="center">
              <Text size="sm" type="supporting" color="secondary">
                {copy.contextWindowHint(props.reportedContextWindow)}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                label={copy.contextWindowApplyHint}
                isDisabled={props.disabled}
                onClick={() => props.onContextWindow(props.reportedContextWindow ?? null)}
              />
            </HStack>
          )}
        </VStack>
      </CapabilityField>
      {props.showsFastMode && (
        <CapabilityField label={copy.fastMode} description={copy.fastModeHelp}>
          <Selector
            label={`${copy.fastMode} — ${modelId}`}
            isLabelHidden
            size="sm"
            width={132}
            options={[
              { value: 'auto', label: copy.fastAuto },
              { value: 'fast', label: copy.fastEnabled },
            ]}
            value={declared?.serviceTier ?? 'auto'}
            onChange={(value) => props.onServiceTier(value === 'fast' ? 'fast' : undefined)}
            isDisabled={props.disabled}
          />
        </CapabilityField>
      )}
    </VStack>
  );
}

/** Label + what it does on the left, one compact control on the right. */
function CapabilityField(props: { label: string; description: string; children: ReactNode }) {
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

// NumberInput already owns the text draft and calls onChange only when the
// whole value commits on blur/Enter. Forward that commit directly to the
// row-level draft: adding another local draft here creates a second commit
// boundary, so the first blur only updates this component and Save can write
// the previous value.
function DeclaredContextWindowField(props: {
  declared: number | undefined;
  disabled: boolean;
  label: string;
  onCommit: (value: number | null) => void;
}) {
  return (
    <NumberInput
      size="sm"
      width={200}
      label={props.label}
      isLabelHidden
      value={props.declared ?? null}
      hasClear
      isIntegerOnly
      min={1}
      onChange={props.onCommit}
      isDisabled={props.disabled}
    />
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
  return (
    <RuntimeHostSettingsGenerationBoundary>
      <OAuthReloginNoticeForCurrentGeneration {...props} />
    </RuntimeHostSettingsGenerationBoundary>
  );
}

function OAuthReloginNoticeForCurrentGeneration(props: {
  service: OAuthLoginService;
  hasSecret: CredentialPresenceStatus;
  onRelogin(): Promise<void>;
}) {
  const providerCopy = getProviderSettingsCopy(useUiLocale());
  const copy = providerCopy.detail;
  const flow = useOAuthLoginFlow({
    mode: 'existing',
    authorizationBridge: props.service.authorizationBridge,
    accountBridge: props.service.accountBridge,
    display: props.service.display,
    onLoginSuccess: () => props.onRelogin(),
    onAccountChanged: props.onRelogin,
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
  // Device pages without the code in their URL require the surface to show it.
  const deviceCode = props.service.showsDeviceCode ? flow.stateHint : null;
  return (
    <Banner
      status="info"
      title={title}
      description={deviceCode ? (
        <>
          {detail} {providerCopy.oauthSection.deviceCode} <code>{deviceCode}</code>
        </>
      ) : detail}
      endContent={!loading ? (
        <HStack gap={2}>
          <Button
            variant="primary"
            size="sm"
            isDisabled={flow.actionBusy}
            onClick={() => void flow.startLogin()}
            label={flow.pendingAction === 'login' ? copy.loggingIn : loggedIn ? copy.relogin : copy.login}
          />
          {loggedIn && flow.logout && (
            <Button
              variant="ghost"
              size="sm"
              isDisabled={flow.actionBusy}
              onClick={() => void flow.logout?.()}
              label={flow.pendingAction === 'logout'
                ? providerCopy.oauthSection.loggingOut
                : providerCopy.oauthSection.logout}
            />
          )}
        </HStack>
      ) : undefined} />
  );
}
