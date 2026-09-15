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

import { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  HStack,
  Icon,
  IconButton,
  Link,
  Switch,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
import { isRelayProviderType, PROVIDER_REGISTRY } from '@maka/core/llm-connections';
import {
  supportsRelayFastServiceTier,
  modelLimitsConflict,
  type ModelOverride,
} from '@maka/core/model-thinking';
import {
  Button,
  RelativeTime,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { PasswordInput } from './password-input';
import { SettingsExpandableRow } from './settings-expandable-row';
import { SettingsActions, SettingsRow, SettingsSection } from './settings-section';
import { providerDisplay } from './provider-display';
import { CapabilityEditor, AddModelDialog, ModelParametersDialog } from '../features/connection-settings';
import {
  RuntimeHostSettingsGenerationBoundary,
  useRuntimeHostSettingsErrorReporter,
} from './runtime-host-settings-target.js';
import { useOAuthLoginFlow } from './use-oauth-login-flow';
import {
  getProviderSettingsCopy,
  parseContextWindowInput,
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
  | { model: string; contextWindowInput?: string; numericInputs?: Partial<Record<'inputLimit' | 'compactionThreshold' | 'maxOutputTokens', string>> }
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
    credentialProbeFailed,
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
    modelParameters,
    hasModelChanges,
    resetDraftProfile,
    setDraftParameters,
    saveModelParameters,
    runTest,
    refreshModels,
    remove,
    refreshAfterRelogin,
  } = useConnectionDetail(props);
  const isRelay = isRelayProviderType(connection.providerType);
  const entryById = new Map(modelChoices.map((entry) => [entry.id, entry]));
  // One row is a form at a time, the way the settings-sidebar template does it.
  // Opening a row discards the other's draft: leaving an abandoned draft in
  // state meant it reappeared when the user came back to that row, and — until
  // `save` became per-field — rode along with the next save.
  const [editingRow, setEditingRow] = useState<EditingRow>(null);
  const editingModelId = editingRow !== null && typeof editingRow === 'object' ? editingRow.model : null;
  const contextWindowInput = editingRow !== null && typeof editingRow === 'object'
    ? editingRow.contextWindowInput : undefined;
  const contextWindowInputInvalid = contextWindowInput !== undefined &&
    contextWindowInput.trim() !== '' && parseContextWindowInput(contextWindowInput) === null;
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

  const numericInputs = typeof editingRow === 'object' && editingRow?.model === editingModelId ? editingRow.numericInputs : undefined;
  const numericInvalid = Object.values(numericInputs ?? {}).some((input) => input.trim() !== '' && parseContextWindowInput(input) === null);
  const declared: ModelOverride | undefined = editingModelId === null ? undefined : modelParameters[editingModelId];
  const modelEntry = connection.catalogEntries.find((model) => model.id === editingModelId);
  const limitsConflict = modelLimitsConflict({
    contextWindow: declared?.contextWindow ?? modelEntry?.defaultContextWindow,
    inputLimit: declared?.inputLimit ?? modelEntry?.defaultInputLimit,
  });

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

  function changeContextWindow(modelId: string, input: string) {
    setEditingRow((current) => ({ ...(typeof current === 'object' && current ? current : {}), model: modelId, contextWindowInput: input }));
    const value = parseContextWindowInput(input);
    // Invalid text stays visible but never replaces a valid declaration.
    if (value !== null || input.trim() === '') setDraftParameters(modelId, { contextWindow: value ?? undefined });
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
      {credentialProbeFailed && (
        <Banner
          status="warning"
          role="alert"
          title={copy.credentialUnknownDetail}
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
                <Button variant="ghost" size="sm" isDisabled={allActionsBusy || !hasUsableCredential} clickAction={() => refreshModels()} label={copy.updateModels} />
              )}
              <Button variant="primary" size="sm" isDisabled={allActionsBusy} onClick={() => openRow('add-model')} label={copy.addModel} />
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
            const rowLabel = entry?.isDefault ? (
              <HStack gap={2} vAlign="center">
                <span>{label}</span>
                <Badge variant="neutral" label={providerCopy.panel.default} />
              </HStack>
            ) : label;
            return (
                <SettingsRow key={id} label={rowLabel} end={<>
                  <IconButton variant="ghost" size="sm" icon={<Icon icon="wrench" size="sm" />}
                    label={copy.declareCapabilitiesAria(label)} tooltip={copy.declareCapabilities}
                    isDisabled={allActionsBusy} onClick={() => openRow({ model: id })} />
                  {modelEnableSwitch(id, label)}
                </>} />

            );
          })}
        </SettingsSection>
      )}
      <ModelParametersDialog
        isOpen={editingModelId !== null} title={copy.declareCapabilities} subtitle={editingModelId ?? undefined}
        confirmLabel={copy.save} isSaving={allActionsBusy}
        isSubmitDisabled={!hasModelChanges || contextWindowInputInvalid || numericInvalid || limitsConflict}
        onClose={() => { if (editingModelId !== null) resetDraftProfile(editingModelId); setEditingRow(null); }}
        onSubmit={async () => {
            if (await saveModelParameters()) setEditingRow(null);
          }}
        >
        {editingModelId !== null && <CapabilityEditor
          copy={copy}
          modelId={editingModelId}
          isRelay={isRelay}
          numericInputs={numericInputs}
          onNumericInput={(field, input) => {
            setEditingRow((current) => ({ ...(typeof current === 'object' && current ? current : {}), model: editingModelId, numericInputs: { ...numericInputs, [field]: input } }));
            const value = parseContextWindowInput(input);
            if (value !== null || input.trim() === '') setDraftParameters(editingModelId, { [field]: value ?? undefined });
          }}
          declared={declared}
          limitsConflict={limitsConflict}
          defaultContextWindow={modelEntry?.defaultContextWindow}
          defaultInputLimit={modelEntry?.defaultInputLimit}
          onChange={(patch) => setDraftParameters(editingModelId, patch)}
          contextWindowInput={contextWindowInput ?? String(declared?.contextWindow ?? '')}
          contextWindowInputInvalid={contextWindowInputInvalid}
          disabled={allActionsBusy}
          showsFastMode={supportsRelayFastServiceTier(connection.providerType, editingModelId)}
          defaultVision={connection.catalogEntries.find((model) => model.id === editingModelId)?.defaultSupportsVision}
          onContextWindowInput={(input) => changeContextWindow(editingModelId, input)}
        />}
      </ModelParametersDialog>
      <AddModelDialog
        isOpen={editingRow === 'add-model'}
        providerType={connection.providerType}
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
