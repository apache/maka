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
import {
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  type ProviderType,
} from '@maka/core/llm-connections';
import { PROVIDER_DEFAULTS, deriveConnectionSlug } from '@maka/core/llm-connections';
import {
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import { Banner, HStack, VStack } from '@astryxdesign/core';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import {
  Button,
  FormLayout,
  TextInput,
  useMountedRef,
  useUiLocale,
} from '@maka/ui';

import { buildCatalogRecommendedDefaultModel } from '../model-catalog-choices';
import { PasswordInput } from './password-input';
import { providerDisplay } from './provider-display';
import { useActionGuard } from './use-action-guard';
import {
  categoryLabel,
  providerPanelActionErrorMessage,
  type ConnectionsBridge,
} from './provider-panel-shared';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import {
  newRequestHeaders,
  parseRequestBodyOverlay,
  RequestCustomizationEditor,
  type RequestHeaderDraft,
} from './request-customization-editor';
import {
  createProviderWithDiscovery,
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

export function AddProviderForm(props: {
  bridge: ConnectionsBridge;
  providerType: ProviderType;
  existingSlugs: string[];
  onCancel(): void;
  onCreated(slug: string, modelDiscoveryError?: unknown): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).add;
  const defaults = PROVIDER_DEFAULTS[props.providerType];
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
  const [error, setError] = useState<ProviderFormError | null>(null);
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
        : locale === 'zh'
          ? issue.detail
          : copy.invalidSlug;
    }
    if (issue.field === 'apiKey') return copy.keyRequired(display.name);
    if (issue.field === 'accountId') return copy.cloudflareAccount;
    if (issue.field === 'baseUrl') return copy.endpointRequired;
    return copy.accountLogin;
  }

  async function submit() {
    if (submitGuard.current !== null) return;
    setError(null);
    const issue = validateAddProviderDraft({
      providerType: props.providerType,
      slug,
      existingSlugs: props.existingSlugs,
      apiKey,
      cloudflareAccountId,
      baseUrl,
    });
    if (issue) return setError({ field: issue.field, message: issueMessage(issue) });
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
        ...(props.providerType === 'opencode-free'
          ? { enabledModelIds: [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS] }
          : {}),
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
            clearFieldError('advancedRequest');
          }}
          bodyText={requestBodyText}
          onBodyTextChange={(value) => {
            setRequestBodyText(value);
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

  if (usesApiKeyDialog) {
    return (
      <VStack as="form" gap={3} onSubmit={submitApiKey}>
        <PasswordInput
          value={apiKey}
          onChange={(next) => {
            setApiKey(next);
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
        {error?.field === 'form' && (
          <Banner status="error" title={error.message} />
        )}
        <HStack gap={2} justify="end">
          <Button variant="ghost" isDisabled={busy} onClick={props.onCancel} label={copy.cancel} />
          <Button variant="primary" type="submit" isDisabled={busy} label={busy ? copy.saving : copy.save} />
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack gap={3}>
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
          onChange={(value) => setName(value)}
          placeholder={display.name}
          isDisabled={isExperimental || busy}
          label={copy.name}
        />
        {isCloudflareWorkersAi ? (
          <TextInput
            value={cloudflareAccountId}
            onChange={(value) => {
              setCloudflareAccountId(value);
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
            onChange={setDefaultModel}
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
  const defaults = PROVIDER_DEFAULTS[providerType];
  return defaults.authKind === 'api_key' && Boolean(defaults.baseUrl);
}
