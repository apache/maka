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
import type { ModelApiProtocol, ProviderType } from '@maka/core/llm-connections';
import {
  MODEL_API_PROTOCOL_LABELS,
  MODEL_API_PROTOCOLS,
  PROVIDER_REGISTRY,
  deriveConnectionSlug,
} from '@maka/core/llm-connections';
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
  ProviderEndpointField,
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
  probeRequestHeaderUpdates,
  shouldShowManagedOnboardingOutcomeUnknown,
  stableOnboardingModels,
  usesLegacyConnectionWriter,
  validateAddProviderDraft,
  type AddProviderIssue,
} from './provider-add-submission';

/** The advanced editor's material, normalized once and shared by both writers. */
interface FormRequestCustomization {
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyOverlay: ReturnType<typeof parseRequestBodyOverlay>;
}

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
  const [endpoint, setEndpoint] = useState<{
    readonly baseUrl: string;
    readonly defaultApiProtocol: ModelApiProtocol;
  }>({ baseUrl: defaults.baseUrl, defaultApiProtocol: 'openai-chat' });
  const { baseUrl, defaultApiProtocol } = endpoint;
  const isCustom = props.providerType === 'custom';
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
  // The form asks for a model id exactly when the registry recommends none,
  // and the probe's catalog is the only place that answer can be honored.
  // Falling back to the recommendation keeps providers that ship one seeded
  // as they were.
  const preferredDefaultModel = defaultModel.trim() || recommendedDefaultModel;
  const isExperimental = defaults.status === 'phase3-experimental';
  const supportsApiKey = providerAuthSupportsApiKey(props.providerType);
  const requiresApiKey = providerAuthRequiresSecret(props.providerType) && supportsApiKey;
  const usesApiKeyDialog = usesQuickApiKeyDialog(props.providerType);
  // The managed verify→choose route used to belong to the key-only dialog
  // alone. A custom relay walks the same two steps through the ordinary form,
  // which is the one that owns the endpoint the probe needs.
  const usesManagedOnboarding = usesApiKeyDialog || isCustom;
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
      return issue.reason === 'duplicate' ? copy.duplicateSlug : copy.slugIssues[issue.detail];
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

  /**
   * What the probe must carry beyond the key: a custom relay's endpoint and
   * whatever headers the advanced editor holds. Both describe the connection
   * the form is about to create, so probing without them would answer for a
   * relay nobody asked to add.
   */
  function probeMaterial(customization: FormRequestCustomization) {
    const headerUpdates = probeRequestHeaderUpdates(customization.headers);
    return {
      baseUrl: isCustom ? baseUrl.trim() || null : null,
      ...(headerUpdates.length === 0 ? {} : { requestHeaders: headerUpdates }),
    };
  }

  /**
   * A custom target has to name the protocol it speaks — the Host resolves the
   * catalog endpoint from it, and the wire closes the field to every other
   * provider. Only the probe asks for one: a custom save still goes through
   * create-then-discover, which carries the protocol on its own input.
   */
  function probeTarget() {
    return {
      kind: 'create' as const,
      providerType: props.providerType,
      ...(isCustom ? { defaultApiProtocol } : {}),
    };
  }

  /**
   * Returns false when the caller should create the connection instead: a
   * probe that cannot answer is not a refusal for a relay whose save is the
   * create-then-discover writer, which reports a failed discovery rather than
   * refusing to create. Every other provider keeps the managed route's answer.
   */
  async function verifyManagedApiKey(
    normalizedApiKey: string,
    customization: FormRequestCustomization,
  ): Promise<boolean> {
    const onboarding = props.apiKeyOnboardingBridge;
    if (!onboarding) return false;
    submitGuard.begin('submit');
    setBusy(true);
    try {
      const result = await onboarding.verify({
        target: probeTarget(),
        apiKey: normalizedApiKey || null,
        ...probeMaterial(customization),
      });
      if (!addProviderMountedRef.current) return true;
      if (result.kind !== 'verified') {
        if (usesLegacyConnectionWriter(props.providerType)) return false;
        setError({
          field:
            result.kind === 'failed' && result.errorClass === 'auth'
              ? 'apiKey'
              : 'form',
          message: onboardingFailureMessage(result),
        });
        return true;
      }
      const models = stableOnboardingModels(result.models);
      const selectedIds = initialOnboardingModelIds(models, preferredDefaultModel);
      if (selectedIds.length === 0) {
        if (usesLegacyConnectionWriter(props.providerType)) return false;
        setError({ field: 'form', message: copy.onboardingNoModels });
        return true;
      }
      setManagedPhase({
        kind: 'models',
        models,
        selectedIds,
        defaultId: selectedIds.includes(preferredDefaultModel)
          ? preferredDefaultModel
          : selectedIds[0]!,
        filter: '',
      });
      return true;
    } catch (err) {
      if (addProviderMountedRef.current) {
        setError({ field: 'form', message: providerPanelActionErrorMessage(err, locale) });
      }
      return true;
    } finally {
      submitGuard.finish();
      if (addProviderMountedRef.current) setBusy(false);
    }
  }

  async function saveManagedApiKey(
    normalizedApiKey: string,
    phase: Extract<ManagedOnboardingPhase, { kind: 'models' }>,
    customization: FormRequestCustomization,
  ) {
    const onboarding = props.apiKeyOnboardingBridge;
    if (!onboarding || phase.selectedIds.length === 0) {
      setError({ field: 'form', message: copy.onboardingSelectModel });
      return;
    }
    // Catalog order, with the chosen default first: the Host reads the head of
    // this list as the connection's default model, and the create writer
    // derives its enabled set from the same ordering.
    const selected = new Set(phase.selectedIds);
    const stableIds = phase.models
      .map((model) => model.id)
      .filter((modelId) => selected.has(modelId) && modelId !== phase.defaultId);
    if (selected.has(phase.defaultId)) stableIds.unshift(phase.defaultId);
    // A custom relay still saves through create-then-discover. The managed
    // save commits the catalog and the key, but not the endpoint headers this
    // form just probed with — a connection saved without them would fetch
    // nothing. The picker's selection rides along, so the connection enables
    // what the user ticked rather than the default alone.
    if (isCustom) {
      await createConnectionFromForm({
        normalizedApiKey,
        createdDefaultModel: phase.defaultId,
        enabledModelIds: stableIds,
        customization,
      });
      return;
    }
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

  /**
   * Create the connection through the legacy writer, then let its catalog
   * answer for itself. Both the plain form and a verified custom relay's
   * picker land here — this is the writer that persists the endpoint headers
   * a managed save would leave behind.
   */
  async function createConnectionFromForm(input: {
    normalizedApiKey: string;
    createdDefaultModel: string;
    /** The picker's selection, default first; omitted when the form showed none. */
    enabledModelIds?: readonly string[];
    customization: FormRequestCustomization;
  }) {
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
            encodeURIComponent(cloudflareAccountId.trim()),
          )
        : baseUrl || undefined;
      const created = await createProviderWithDiscovery(props.bridge, {
        slug,
        name: name || display.name,
        providerType: props.providerType,
        baseUrl: resolvedBaseUrl,
        ...(isCustom ? { defaultApiProtocol } : {}),
        defaultModel: input.createdDefaultModel,
        ...(input.enabledModelIds === undefined
          ? {}
          : { enabledModelIds: [...input.enabledModelIds] }),
        ...(input.normalizedApiKey ? { apiKey: input.normalizedApiKey } : {}),
        ...(Object.keys(input.customization.headers).length > 0
          ? { requestHeaders: input.customization.headers }
          : {}),
        ...(input.customization.bodyOverlay === undefined
          ? {}
          : { requestBodyOverlay: input.customization.bodyOverlay }),
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

  async function submit() {
    if (submitGuard.current !== null) return;
    setError(null);
    let customization: FormRequestCustomization;
    try {
      customization = {
        headers: newRequestHeaders(requestHeaders),
        bodyOverlay: parseRequestBodyOverlay(requestBodyText),
      };
    } catch {
      setAdvancedOpen(true);
      return setError({ field: 'advancedRequest', message: copy.requestCustomizationInvalid });
    }
    const normalizedApiKey = apiKey.trim();
    const onboardingRoute = apiKeyOnboardingRoute({
      providerType: props.providerType,
      hasRequestBodyOverlay: customization.bodyOverlay !== undefined,
      hasRequestHeaders: Object.keys(customization.headers).length > 0,
      hasEndpoint: baseUrl.trim().length > 0,
    });
    if (onboardingRoute.kind === 'host' && props.apiKeyOnboardingBridge) {
      if (requiresApiKey && !normalizedApiKey) {
        return setError({ field: 'apiKey', message: copy.keyRequired(display.name) });
      }
      if (managedPhase.kind === 'models') {
        await saveManagedApiKey(normalizedApiKey, managedPhase, customization);
        return;
      }
      if (
        managedPhase.kind === 'input' &&
        (await verifyManagedApiKey(normalizedApiKey, customization))
      ) {
        return;
      }
    }
    // Either the draft never belonged to the managed route, or the probe could
    // not answer a relay that the create writer is willing to save anyway.
    await createConnectionFromForm({
      normalizedApiKey,
      createdDefaultModel: preferredDefaultModel,
      customization,
    });
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
  // Whether the first press proves the key and opens the catalog rather than
  // saving. Both step-one layouts — the key-only dialog and the ordinary form
  // a custom relay walks — press the same button for the same thing, so they
  // read the same answer and say the same words.
  const startsManagedOnboarding = Boolean(
    usesManagedOnboarding &&
      props.apiKeyOnboardingBridge &&
      apiKeyOnboardingRoute({
        providerType: props.providerType,
        hasRequestBodyOverlay: requestBodyText.trim().length > 0,
        hasRequestHeaders: requestHeaders.length > 0,
        hasEndpoint: baseUrl.trim().length > 0,
      }).kind === 'host',
  );

  if (
    usesManagedOnboarding &&
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
  const managedStepper = startsManagedOnboarding ? (
    <Stepper
      activeStep={managedPhase.kind === 'models' ? 1 : 0}
      label={copy.stepsAria}
      density="compact"
    >
      <Step step={0} label={copy.stepCredentials} />
      <Step step={1} label={copy.stepModels} />
    </Stepper>
  ) : null;

  if (usesManagedOnboarding && managedPhase.kind === 'models') {
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
        {/* Any error, not just `form`: this step has no slug/key/endpoint input
            for a create failure to attach to, so reporting only `form` would
            drop the reason the connection was refused. */}
        {error && <Banner status="error" title={error.message} />}
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
              {startsManagedOnboarding ? copy.onboardingVerifying : copy.saving}
            </Text>
          ) : null}
        </div>
        {/* The key and the advanced editor render their own errors; the slug
            and endpoint this dialog never shows a field for have nowhere else
            to land, and a create that falls back still reports them. */}
        {error &&
          error.field !== 'apiKey' &&
          error.field !== 'advancedRequest' && (
            <Banner status="error" title={error.message} />
          )}
        <HStack gap={2} justify="end">
          <Button variant="ghost" isDisabled={busy} onClick={props.onCancel} label={copy.cancel} />
          <Button
            variant="primary"
            type="submit"
            isDisabled={busy}
            label={startsManagedOnboarding
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
          <ProviderEndpointField providerType={props.providerType} baseUrl={baseUrl} apiProtocol={defaultApiProtocol}>
            {(requestDescription) => (
              <TextInput
                aria-description={requestDescription}
                value={baseUrl}
                onChange={(value) => {
                  setEndpoint((current) => ({ ...current, baseUrl: value }));
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
          </ProviderEndpointField>
        )}
        {isCustom && (
          <Selector
            label={copy.connectionApiProtocol}
            description={copy.connectionApiProtocolHelp}
            width="100%"
            options={MODEL_API_PROTOCOLS.map((protocol) => ({
              value: protocol,
              label: MODEL_API_PROTOCOL_LABELS[protocol],
            }))}
            value={defaultApiProtocol}
            onChange={(value) =>
              setEndpoint((current) => ({
                ...current,
                defaultApiProtocol: value as ModelApiProtocol,
              }))
            }
            isDisabled={busy}
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
        <Button
          variant="primary"
          isDisabled={busy || isExperimental}
          onClick={submit}
          // A relay that will be probed is not saved by this press, and the
          // button should not promise a save that only a second press makes.
          label={
            startsManagedOnboarding
              ? busy
                ? copy.onboardingVerifying
                : copy.onboardingVerifyAndChoose
              : busy
                ? copy.saving
                : copy.save
          }
        />
      </HStack>
    </VStack>
  );
}

function usesQuickApiKeyDialog(providerType: ProviderType): boolean {
  const defaults = PROVIDER_REGISTRY[providerType];
  return defaults.authKind === 'api_key' && Boolean(defaults.baseUrl);
}
