import { useState, type FormEvent } from 'react';
import {
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  type ProviderType,
} from '@maka/core/llm-connections';
import {
  PROVIDER_DEFAULTS,
  deriveConnectionSlug,
  validateSlug,
} from '@maka/core/llm-connections';
import { isWiredOAuthProvider } from '@maka/core/provider-registry';
import {
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  providerSupportsModelDiscovery,
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

type ProviderFormField =
  | 'slug'
  | 'apiKey'
  | 'accountId'
  | 'baseUrl'
  | 'defaultModel'
  | 'advancedRequest'
  | 'form';

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
  const isCustomRelay = defaults.category === 'custom';
  const isExperimental = defaults.status === 'phase3-experimental';
  const isWiredOAuth = isWiredOAuthProvider(props.providerType);
  const supportsRemoteDiscovery = providerSupportsModelDiscovery(props.providerType);
  const supportsApiKey = providerAuthSupportsApiKey(props.providerType);
  const requiresApiKey = providerAuthRequiresSecret(props.providerType) && supportsApiKey;
  const usesApiKeyDialog = usesQuickApiKeyDialog(props.providerType);

  function clearFieldError(field: ProviderFormField) {
    setError((current) =>
      current?.field === field ? null : current,
    );
  }

  async function submit() {
    if (submitGuard.current !== null) return;
    setError(null);
    const slugError = validateSlug(slug);
    if (slugError) {
      return setError({
        field: 'slug',
        message: locale === 'zh' ? slugError : copy.invalidSlug,
      });
    }
    if (props.existingSlugs.includes(slug)) {
      return setError({ field: 'slug', message: copy.duplicateSlug });
    }
    const normalizedApiKey = apiKey.trim();
    if (requiresApiKey && !normalizedApiKey) {
      return setError({
        field: 'apiKey',
        message: copy.keyRequired(display.name),
      });
    }
    const normalizedCloudflareAccountId = cloudflareAccountId.trim();
    if (isCloudflareWorkersAi && !normalizedCloudflareAccountId) {
      return setError({
        field: 'accountId',
        message: copy.cloudflareAccount,
      });
    }
    if (requiresBaseUrl && !baseUrl.trim()) {
      return setError({
        field: 'baseUrl',
        message: copy.endpointRequired,
      });
    }
    const normalizedDefaultModel = defaultModel.trim();
    if (isCustomRelay && !normalizedDefaultModel) {
      return setError({
        field: 'defaultModel',
        message: copy.defaultModelRequired,
      });
    }
    if (isExperimental) {
      return setError({
        field: 'form',
        message: isWiredOAuth ? copy.wiredLogin : copy.unwiredLogin,
      });
    }
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
      const connection = await props.bridge.create({
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
      let modelDiscoveryError: unknown;
      if (supportsRemoteDiscovery) {
        try {
          await props.bridge.fetchModels(connection.slug);
        } catch (error) {
          if (!isCustomRelay) modelDiscoveryError = error;
        }
      }
      if (!addProviderMountedRef.current) return;
      await props.onCreated(connection.slug, modelDiscoveryError);
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
          title={isWiredOAuth ? copy.wiredTitle : copy.unwiredTitle}
          description={isWiredOAuth
            ? copy.wiredDetail
            : copy.unwiredDetail} />
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
            onChange={(value) => {
              setDefaultModel(value);
              clearFieldError('defaultModel');
            }}
            placeholder={copy.defaultModelPlaceholder}
            isDisabled={isExperimental || busy}
            label={copy.defaultModel}
            description={copy.defaultModelHelp}
            isRequired={isCustomRelay}
            status={
              error?.field === 'defaultModel'
                ? { type: 'error', message: error.message }
                : undefined
            }
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
