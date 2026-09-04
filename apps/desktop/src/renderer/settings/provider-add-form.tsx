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

import { useState, type FormEvent } from 'react';
import type { ProviderType } from '@maka/core/llm-connections';
import { PROVIDER_REGISTRY, deriveConnectionSlug } from '@maka/core/llm-connections';
import {
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import {
  Banner,
  CheckboxList,
  CheckboxListItem,
  EmptyState,
  HStack,
  Step,
  Stepper,
  Text,
  VStack,
} from '@astryxdesign/core';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import {
  Button,
  FormLayout,
  Selector,
  TextInput,
  useMountedRef,
  useUiLocale,
} from '@maka/ui';

import { buildCatalogRecommendedDefaultModel } from '../model-catalog-choices';
import { PasswordInput } from './password-input';
import { providerDisplay } from './provider-display';
import { useActionGuard } from './use-action-guard';
import {
  OnboardingStepForm,
  getProviderSettingsCopy,
  providerPanelActionErrorMessage,
  type ApiKeyOnboardingBridge,
  type ConnectionsBridge,
  type DesktopConnectionOnboardingIdentity,
} from '../features/connection-settings';
import {
  newRequestHeaders,
  parseRequestBodyOverlay,
  RequestCustomizationEditor,
  type RequestHeaderDraft,
} from './request-customization-editor';
import {
  createProviderWithDiscovery,
  apiKeyOnboardingRoute,
  initialOnboardingModelIds,
  shouldShowManagedOnboardingOutcomeUnknown,
  stableOnboardingModels,
  validateAddProviderDraft,
  type AddProviderIssue,
} from './provider-add-submission';

/* No `defaultModel`: the creation gate has no rule that can fail on the model
   id, so an error could never be reported against that field. The union is
   kept aligned with `AddProviderIssue` plus the two form-local fields the
   gate does not own. */
type ProviderFormField = 'slug' | 'apiKey' | 'accountId' | 'baseUrl' | 'advancedRequest' | 'form';

type ProviderFormError = {
  field: ProviderFormField;
  message: string;
};

type ManagedOnboardingPhase =
  | { readonly kind: 'input' }
  | {
      readonly kind: 'models';
      readonly models: ReturnType<typeof stableOnboardingModels>;
      readonly selectedIds: readonly string[];
      /** The model new chats start on. Always one of `selectedIds`. */
      readonly defaultId: string;
      /** The picker's search text; it belongs to this step and leaves with it. */
      readonly filter: string;
    };

/** Past this many models the picker needs a filter to be usable. */
const MODEL_FILTER_THRESHOLD = 8;

export function AddProviderForm(props: {
  bridge: ConnectionsBridge;
  apiKeyOnboardingBridge?: ApiKeyOnboardingBridge;
  providerType: ProviderType;
  existingSlugs: string[];
  onCancel(): void;
  onCreated(slug: string, modelDiscoveryError?: unknown): Promise<void>;
  onOnboarded?(identity: DesktopConnectionOnboardingIdentity): Promise<void>;
  onOnboardingOutcomeUnknown?(): Promise<void>;
  hasSaveUncertainty?: boolean;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).add;
  const sharedCopy = getProviderSettingsCopy(locale).shared;
  const defaults = PROVIDER_REGISTRY[props.providerType];
  const display = providerDisplay(props.providerType, locale);
  const recommendedDefaultModel = buildCatalogRecommendedDefaultModel(props.providerType);
  const [slug, setSlug] = useState(() =>
    deriveConnectionSlug(props.providerType, props.existingSlugs),
  );
  const [name, setName] = useState(display.name);
  const [baseUrl, setBaseUrl] = useState(defaults.baseUrl);
  const [cloudflareAccountId, setCloudflareAccountId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(recommendedDefaultModel);
  const [requestHeaders, setRequestHeaders] = useState<RequestHeaderDraft[]>([]);
  const [requestBodyText, setRequestBodyText] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [formState, setFormState] = useState<{
    readonly managedPhase: ManagedOnboardingPhase;
    readonly error: ProviderFormError | null;
  }>(() => ({
    managedPhase: { kind: 'input' },
    error: null,
  }));
  const { managedPhase, error } = formState;
  const [busy, setBusy] = useState(false);
  const submitGuard = useActionGuard<'submit'>();
  const addProviderMountedRef = useMountedRef();

  const isCloudflareWorkersAi = props.providerType === 'cloudflare-workers-ai';
  const requiresBaseUrl = !defaults.baseUrl && !isCloudflareWorkersAi;
  const showsDefaultModel = recommendedDefaultModel.trim() === '';
  const isExperimental = defaults.status === 'phase3-experimental';
  const supportsApiKey = providerAuthSupportsApiKey(props.providerType);
  const requiresApiKey = providerAuthRequiresSecret(props.providerType) && supportsApiKey;
  const usesApiKeyDialog = usesQuickApiKeyDialog(props.providerType);

  function setManagedPhase(next: ManagedOnboardingPhase) {
    setFormState((current) => ({ ...current, managedPhase: next }));
  }

  function setError(
    next:
      | ProviderFormError
      | null
      | ((current: ProviderFormError | null) => ProviderFormError | null),
  ) {
    setFormState((current) => ({
      ...current,
      error: typeof next === 'function' ? next(current.error) : next,
    }));
  }

  function resetManagedVerification(options?: { clearKey?: boolean }) {
    setManagedPhase({ kind: 'input' });
    if (options?.clearKey) setApiKey('');
  }

  function clearFieldError(field: ProviderFormField) {
    setError((current) =>
      current?.field === field ? null : current,
    );
  }

  // The localized sentence for one field gate. The gate itself is in
  // provider-add-submission, so the order and the rules are testable without
  // a locale in the assertion.
  function issueMessage(issue: AddProviderIssue): string {
    if (issue.field === 'slug') {
      return issue.reason === 'duplicate'
        ? copy.duplicateSlug
        : locale === 'zh-CN'
          ? issue.detail
          : copy.invalidSlug;
    }
    if (issue.field === 'apiKey') return copy.keyRequired(display.name);
    if (issue.field === 'accountId') return copy.cloudflareAccount;
    if (issue.field === 'baseUrl') return copy.endpointRequired;
    return copy.accountLogin;
  }

  function onboardingFailureMessage(
    result:
      | Exclude<Awaited<ReturnType<ApiKeyOnboardingBridge['verify']>>, { kind: 'verified' }>
      | Exclude<
          Extract<Awaited<ReturnType<ApiKeyOnboardingBridge['save']>>, { kind: 'result' }>['result'],
          { kind: 'saved' }
        >,
  ): string {
    if (result.kind === 'failed') {
      if (result.errorClass === 'auth') return copy.onboardingAuthFailed;
      if (result.errorClass === 'timeout') return copy.onboardingTimeout;
      if (result.errorClass === 'network') return copy.onboardingNetwork;
      if (result.errorClass === 'provider_unavailable') return copy.onboardingUnavailable;
      return copy.onboardingInvalidResponse;
    }
    if (result.reason === 'catalog_full') return copy.onboardingCatalogFull;
    if (result.reason === 'model_unavailable' || result.reason === 'superseded') {
      return copy.onboardingModelsChanged;
    }
    if (result.reason === 'credential_not_configured') return copy.keyRequired(display.name);
    return copy.onboardingUnavailable;
  }

  async function verifyManagedApiKey(normalizedApiKey: string) {
    const onboarding = props.apiKeyOnboardingBridge;
    if (!onboarding) return;
    submitGuard.begin('submit');
    setBusy(true);
    try {
      const result = await onboarding.verify({
        target: { kind: 'create', providerType: props.providerType },
        apiKey: normalizedApiKey || null,
        baseUrl: null,
      });
      if (!addProviderMountedRef.current) return;
      if (result.kind !== 'verified') {
        setError({
          field:
            result.kind === 'failed' && result.errorClass === 'auth'
              ? 'apiKey'
              : 'form',
          message: onboardingFailureMessage(result),
        });
        return;
      }
      const models = stableOnboardingModels(result.models);
      const selectedIds = initialOnboardingModelIds(models, recommendedDefaultModel);
      if (selectedIds.length === 0) {
        setError({ field: 'form', message: copy.onboardingNoModels });
        return;
      }
      setManagedPhase({
        kind: 'models',
        models,
        selectedIds,
        defaultId: selectedIds.includes(recommendedDefaultModel)
          ? recommendedDefaultModel
          : selectedIds[0]!,
        filter: '',
      });
    } catch (err) {
      if (addProviderMountedRef.current) {
        setError({ field: 'form', message: providerPanelActionErrorMessage(err, locale) });
      }
    } finally {
      submitGuard.finish();
      if (addProviderMountedRef.current) setBusy(false);
    }
  }

  async function saveManagedApiKey(
    normalizedApiKey: string,
    phase: Extract<ManagedOnboardingPhase, { kind: 'models' }>,
  ) {
    const onboarding = props.apiKeyOnboardingBridge;
    if (!onboarding || phase.selectedIds.length === 0) {
      setError({ field: 'form', message: copy.onboardingSelectModel });
      return;
    }
    // Catalog order, with the chosen default first: the Host reads the head of
    // this list as the connection's default model.
    const selected = new Set(phase.selectedIds);
    const stableIds = phase.models
      .map((model) => model.id)
      .filter((modelId) => selected.has(modelId) && modelId !== phase.defaultId);
    if (selected.has(phase.defaultId)) stableIds.unshift(phase.defaultId);
    submitGuard.begin('submit');
    setBusy(true);
    try {
      const outcome = await onboarding.save({
        target: { kind: 'create', providerType: props.providerType },
        apiKey: normalizedApiKey || null,
        baseUrl: null,
        enabledModelIds: stableIds,
      });
      if (!addProviderMountedRef.current) return;
      if (outcome.kind === 'outcome_unknown') {
        setApiKey('');
        return;
      }
      if (outcome.kind === 'not_saved') {
        setError({ field: 'form', message: copy.onboardingUnavailable });
        return;
      }
      const result = outcome.result;
      if (result.kind === 'saved') {
        setApiKey('');
        await props.onOnboarded?.(result.connection);
        return;
      }
      if (
        result.kind === 'rejected' &&
        (result.reason === 'model_unavailable' || result.reason === 'superseded')
      ) {
        setManagedPhase({ kind: 'input' });
      }
      if (result.kind === 'failed' && result.errorClass === 'auth') {
        setManagedPhase({ kind: 'input' });
      }
      setError({
        field: result.kind === 'failed' && result.errorClass === 'auth' ? 'apiKey' : 'form',
        message: onboardingFailureMessage(result),
      });
    } catch {
      if (addProviderMountedRef.current) setApiKey('');
    } finally {
      submitGuard.finish();
      if (addProviderMountedRef.current) setBusy(false);
    }
  }

  async function submit() {
    if (submitGuard.current !== null) return;
    setError(null);
    const normalizedApiKey = apiKey.trim();
    const normalizedCloudflareAccountId = cloudflareAccountId.trim();
    const normalizedDefaultModel = defaultModel.trim();
    let normalizedRequestHeaders: Readonly<Record<string, string>>;
    let requestBodyOverlay: ReturnType<typeof parseRequestBodyOverlay>;
    try {
      normalizedRequestHeaders = newRequestHeaders(requestHeaders);
      requestBodyOverlay = parseRequestBodyOverlay(requestBodyText);
    } catch {
      setAdvancedOpen(true);
      return setError({ field: 'advancedRequest', message: copy.requestCustomizationInvalid });
    }
    const onboardingRoute = apiKeyOnboardingRoute({
      providerType: props.providerType,
      requestHeaderCount: Object.keys(normalizedRequestHeaders).length,
      hasRequestBodyOverlay: requestBodyOverlay !== undefined,
    });
    if (onboardingRoute.kind === 'host' && props.apiKeyOnboardingBridge) {
      if (requiresApiKey && !normalizedApiKey) {
        return setError({ field: 'apiKey', message: copy.keyRequired(display.name) });
      }
      if (managedPhase.kind === 'models') {
        await saveManagedApiKey(normalizedApiKey, managedPhase);
      } else if (managedPhase.kind === 'input') {
        await verifyManagedApiKey(normalizedApiKey);
      }
      return;
    }
    const issue = validateAddProviderDraft({
      providerType: props.providerType,
      slug,
      existingSlugs: props.existingSlugs,
      apiKey,
      cloudflareAccountId,
      baseUrl,
    });
    if (issue) return setError({ field: issue.field, message: issueMessage(issue) });
    submitGuard.begin('submit');
    setBusy(true);
    try {
      const resolvedBaseUrl = isCloudflareWorkersAi
        ? defaults.baseUrlTemplate?.replace(
            '${CLOUDFLARE_ACCOUNT_ID}',
            encodeURIComponent(normalizedCloudflareAccountId),
          )
        : baseUrl || undefined;
      const createdDefaultModel = normalizedDefaultModel || recommendedDefaultModel;
      const created = await createProviderWithDiscovery(props.bridge, {
        slug,
        name: name || display.name,
        providerType: props.providerType,
        baseUrl: resolvedBaseUrl,
        defaultModel: createdDefaultModel,
        ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
        ...(Object.keys(normalizedRequestHeaders).length > 0
          ? { requestHeaders: normalizedRequestHeaders }
          : {}),
        ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
      });
      if (!addProviderMountedRef.current) return;
      await props.onCreated(created.connection.slug, created.modelDiscoveryError);
    } catch (err) {
      if (addProviderMountedRef.current) {
        setError({
          field: 'form',
          message: providerPanelActionErrorMessage(err, locale),
        });
      }
    } finally {
      submitGuard.finish();
      if (addProviderMountedRef.current) setBusy(false);
    }
  }

  function submitApiKey(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    void submit();
  }

  const advancedRequestEditor = (
    <Collapsible
      trigger={advancedOpen ? copy.collapseAdvancedRequest : copy.expandAdvancedRequest}
      isOpen={advancedOpen}
      onOpenChange={setAdvancedOpen}
    >
      <VStack gap={3}>
        <RequestCustomizationEditor
          headers={requestHeaders}
          onHeadersChange={(headers) => {
            setRequestHeaders(headers);
            resetManagedVerification();
            clearFieldError('advancedRequest');
          }}
          bodyText={requestBodyText}
          onBodyTextChange={(value) => {
            setRequestBodyText(value);
            resetManagedVerification();
            clearFieldError('advancedRequest');
          }}
          disabled={busy}
          copy={{
            headers: copy.requestHeaders,
            headerName: copy.headerName,
            headerValue: copy.headerValue,
            retainedValue: copy.retainedHeaderValue,
            addHeader: copy.addHeader,
            removeHeader: copy.removeHeader,
            noHeaders: copy.noRequestHeaders,
            body: copy.extraRequestBody,
            bodyHelp: copy.extraRequestBodyHelp,
          }}
        />
        {error?.field === 'advancedRequest' && (
          <Banner status="error" title={error.message} />
        )}
      </VStack>
    </Collapsible>
  );
  const quickUsesManagedOnboarding = Boolean(
    props.apiKeyOnboardingBridge &&
      apiKeyOnboardingRoute({
        providerType: props.providerType,
        requestHeaderCount: requestHeaders.length,
        hasRequestBodyOverlay: requestBodyText.trim().length > 0,
      }).kind === 'host',
  );

  if (
    usesApiKeyDialog &&
    shouldShowManagedOnboardingOutcomeUnknown(props.hasSaveUncertainty === true, busy)
  ) {
    return (
      <VStack gap={3} data-maka-contract="api-key-onboarding-outcome-unknown">
        <Banner
          status="warning"
          role="status"
          title={copy.onboardingOutcomeUnknown}
          description={copy.onboardingOutcomeUnknownDetail}
        />
        <HStack gap={2} justify="end">
          <Button
            variant="secondary"
            label={copy.onboardingReloadConnections}
            clickAction={async () => props.onOnboardingOutcomeUnknown?.()}
          />
        </HStack>
      </VStack>
    );
  }

  // The managed route is two steps — the key, then the models it unlocked —
  // and the page says so up front rather than springing a second form on a
  // user who thought they were done. A single-step route shows no stepper:
  // one step is not progress.
  const managedStepper = quickUsesManagedOnboarding ? (
    <Stepper
      activeStep={managedPhase.kind === 'models' ? 1 : 0}
      label={copy.stepsAria}
      density="compact"
    >
      <Step step={0} label={copy.stepCredentials} />
      <Step step={1} label={copy.stepModels} />
    </Stepper>
  ) : null;

  if (usesApiKeyDialog && managedPhase.kind === 'models') {
    const normalizedFilter = managedPhase.filter.trim().toLocaleLowerCase();
    const setFilter = (filter: string) => setManagedPhase({ ...managedPhase, filter });
    const showsFilter = managedPhase.models.length > MODEL_FILTER_THRESHOLD;
    const visibleModels = managedPhase.models.filter((model) =>
      !normalizedFilter ||
      [model.id, model.displayName ?? '']
        .some((value) => value.toLocaleLowerCase().includes(normalizedFilter)));
    const modelLabel = (model: (typeof managedPhase.models)[number]) =>
      model.displayName?.trim() || model.id;
    const selectModels = (selectedIds: readonly string[]) => {
      // The default follows the selection: unticking it hands the role to the
      // first model still ticked, so the head of the saved list is never a
      // model the user just removed.
      const defaultId = selectedIds.includes(managedPhase.defaultId)
        ? managedPhase.defaultId
        : selectedIds[0] ?? '';
      setManagedPhase({ ...managedPhase, selectedIds, defaultId });
      clearFieldError('form');
    };
    const selectedOptions = managedPhase.models
      .filter((model) => managedPhase.selectedIds.includes(model.id))
      .map((model) => ({ value: model.id, label: modelLabel(model) }));
    return (
      <OnboardingStepForm
        onSubmit={submitApiKey}
        contract="api-key-onboarding-models"
        label={copy.onboardingChooseModels}
      >
        {managedStepper}
        <VStack gap={1}>
          <Text weight="semibold">{copy.onboardingChooseModels}</Text>
          <Text type="supporting" color="secondary">{copy.onboardingChooseModelsHelp}</Text>
        </VStack>
        <HStack gap={2} justify="between" vAlign="center" wrap="wrap">
          <Text type="supporting" color="secondary" role="status">
            {copy.onboardingSelectedCount(managedPhase.selectedIds.length, managedPhase.models.length)}
          </Text>
          <HStack gap={1}>
            <Button
              variant="ghost"
              size="sm"
              isDisabled={busy || managedPhase.selectedIds.length === managedPhase.models.length}
              onClick={() => selectModels(managedPhase.models.map((model) => model.id))}
              label={copy.onboardingSelectAll}
            />
            <Button
              variant="ghost"
              size="sm"
              isDisabled={busy || managedPhase.selectedIds.length === 0}
              onClick={() => selectModels([])}
              label={copy.onboardingClearAll}
            />
          </HStack>
        </HStack>
        {showsFilter && (
          <TextInput
            value={managedPhase.filter}
            onChange={setFilter}
            placeholder={copy.onboardingSearchModels}
            label={copy.onboardingSearchModels}
            isLabelHidden
            hasClear
            isDisabled={busy}
          />
        )}
        {/* The filter changes the list without moving focus, so the new count
            is spoken. Always mounted: a live region added at the same time as
            its text is not announced. */}
        <span className="maka-visually-hidden" role="status" aria-live="polite">
          {normalizedFilter ? sharedCopy.filterMatches(visibleModels.length) : ''}
        </span>
        {visibleModels.length === 0 ? (
          <EmptyState
            isCompact
            title={copy.onboardingNoModelsMatch}
            actions={<Button variant="ghost" size="sm" label={copy.onboardingClearAll} onClick={() => setFilter('')} />}
          />
        ) : (
          <CheckboxList
            label={copy.onboardingEnabledModels}
            isLabelHidden
            value={[...managedPhase.selectedIds]}
            onChange={selectModels}
            isDisabled={busy}
            hasDividers
            density="compact"
          >
            {visibleModels.map((model) => (
              <CheckboxListItem
                key={model.id}
                value={model.id}
                label={modelLabel(model)}
                description={modelLabel(model) === model.id ? undefined : model.id}
              />
            ))}
          </CheckboxList>
        )}
        <Selector
          label={copy.onboardingDefaultModel}
          description={copy.onboardingDefaultModelHelp}
          options={selectedOptions}
          value={managedPhase.defaultId}
          onChange={(defaultId: string) => setManagedPhase({ ...managedPhase, defaultId })}
          isDisabled={busy || selectedOptions.length === 0}
          placeholder={copy.onboardingSelectModel}
          width="100%"
        />
        <div role="status" aria-live="polite">
          {busy ? <Text type="supporting">{copy.saving}</Text> : null}
        </div>
        {error?.field === 'form' && <Banner status="error" title={error.message} />}
        <HStack gap={2} justify="end">
          <Button
            variant="ghost"
            isDisabled={busy}
            onClick={() => {
              resetManagedVerification();
              setError(null);
            }}
            label={copy.onboardingBack}
          />
          <Button
            variant="primary"
            type="submit"
            isDisabled={busy || managedPhase.selectedIds.length === 0}
            label={busy ? copy.saving : copy.onboardingAddConnection}
          />
        </HStack>
      </OnboardingStepForm>
    );
  }

  if (usesApiKeyDialog) {
    return (
      <VStack as="form" gap={4} onSubmit={submitApiKey}>
        {managedStepper}
        <FormLayout>
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
              resetManagedVerification();
              clearFieldError('apiKey');
            }}
            placeholder={copy.apiKeyPlaceholder}
            label={copy.apiKeyLabel}
            isRequired={requiresApiKey}
            isOptional={!requiresApiKey}
            status={
              error?.field === 'apiKey'
                ? { type: 'error', message: error.message }
                : undefined
            }
            isDisabled={busy}
            hasAutoFocus
          />
          {advancedRequestEditor}
        </FormLayout>
        <div role="status" aria-live="polite">
          {busy ? (
            <Text type="supporting">
              {quickUsesManagedOnboarding ? copy.onboardingVerifying : copy.saving}
            </Text>
          ) : null}
        </div>
        {error?.field === 'form' && (
          <Banner status="error" title={error.message} />
        )}
        <HStack gap={2} justify="end">
          <Button variant="ghost" isDisabled={busy} onClick={props.onCancel} label={copy.cancel} />
          <Button
            variant="primary"
            type="submit"
            isDisabled={busy}
            label={quickUsesManagedOnboarding
              ? busy
                ? copy.onboardingVerifying
                : copy.onboardingVerifyAndChoose
              : busy
                ? copy.saving
                : copy.save}
          />
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      {isExperimental && (
        <Banner
          status="info"
          title={copy.accountTitle}
          description={copy.accountDetail} />
      )}
      <FormLayout>
        {supportsApiKey && (
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
              resetManagedVerification();
              clearFieldError('apiKey');
            }}
            placeholder={copy.apiKeyPlaceholder}
            label={copy.apiKeyLabel}
            isRequired={requiresApiKey}
            isOptional={!requiresApiKey}
            isDisabled={isExperimental || busy}
            status={
              error?.field === 'apiKey'
                ? { type: 'error', message: error.message }
                : undefined
            }
          />
        )}
        <TextInput
          value={slug}
          onChange={(value) => {
            setSlug(value);
            resetManagedVerification();
            clearFieldError('slug');
          }}
          placeholder="my-provider"
          isDisabled={isExperimental || busy}
          label={copy.slug}
          status={
            error?.field === 'slug'
              ? { type: 'error', message: error.message }
              : undefined
          }
        />
        <TextInput
          value={name}
          onChange={(value) => {
            setName(value);
            resetManagedVerification();
          }}
          placeholder={display.name}
          isDisabled={isExperimental || busy}
          label={copy.name}
        />
        {isCloudflareWorkersAi ? (
          <TextInput
            value={cloudflareAccountId}
            onChange={(value) => {
              setCloudflareAccountId(value);
              resetManagedVerification();
              clearFieldError('accountId');
            }}
            placeholder={copy.accountIdPlaceholder}
            isDisabled={busy}
            label={copy.accountIdLabel}
            isRequired
            status={
              error?.field === 'accountId'
                ? { type: 'error', message: error.message }
                : undefined
            }
          />
        ) : (
          <TextInput
            value={baseUrl}
            onChange={(value) => {
              setBaseUrl(value);
              resetManagedVerification();
              clearFieldError('baseUrl');
            }}
            placeholder={defaults.baseUrl || 'https://…'}
            isDisabled={isExperimental || busy}
            label={copy.endpointLabel}
            isRequired={requiresBaseUrl}
            status={
              error?.field === 'baseUrl'
                ? { type: 'error', message: error.message }
                : undefined
            }
          />
        )}
        {showsDefaultModel && (
          <TextInput
            value={defaultModel}
            onChange={(value) => {
              setDefaultModel(value);
              resetManagedVerification();
            }}
            placeholder={copy.defaultModelPlaceholder}
            isDisabled={isExperimental || busy}
            label={copy.defaultModel}
            description={copy.defaultModelHelp}
          />
        )}
        {advancedRequestEditor}
      </FormLayout>
      {error?.field === 'form' && (
        <Banner status="error" title={error.message} />
      )}
      <HStack gap={2} justify="end">
        <Button variant="ghost" isDisabled={busy} onClick={props.onCancel} label={copy.cancel} />
        <Button variant="primary" isDisabled={busy || isExperimental} onClick={submit} label={busy ? copy.saving : copy.save} />
      </HStack>
    </VStack>
  );
}

function usesQuickApiKeyDialog(providerType: ProviderType): boolean {
  const defaults = PROVIDER_REGISTRY[providerType];
  return defaults.authKind === 'api_key' && Boolean(defaults.baseUrl);
}
