import { useState, type FormEvent } from 'react';
import {
  PROVIDER_DEFAULTS,
  deriveConnectionSlug,
  isWiredOAuthProvider,
  validateSlug,
  type ProviderType,
} from '@maka/core';
import {
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  providerSupportsModelDiscovery,
} from '@maka/core/llm-connections';
import { Alert, AlertDescription, AlertTitle, Button, Chip, Input, useMountedRef, useUiLocale } from '@maka/ui';
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
  const [error, setError] = useState<string | null>(null);
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

  async function submit() {
    if (submitGuard.current !== null) return;
    setError(null);
    const slugError = validateSlug(slug);
    if (slugError) return setError(locale === 'zh' ? slugError : copy.invalidSlug);
    if (props.existingSlugs.includes(slug)) return setError(copy.duplicateSlug);
    const normalizedApiKey = apiKey.trim();
    if (requiresApiKey && !normalizedApiKey) return setError(copy.keyRequired(display.name));
    const normalizedCloudflareAccountId = cloudflareAccountId.trim();
    if (isCloudflareWorkersAi && !normalizedCloudflareAccountId) {
      return setError(copy.cloudflareAccount);
    }
    if (requiresBaseUrl && !baseUrl.trim()) return setError(copy.endpointRequired);
    const normalizedDefaultModel = defaultModel.trim();
    if (isCustomRelay && !normalizedDefaultModel) return setError(copy.defaultModelRequired);
    if (isExperimental) {
      return setError(isWiredOAuth
        ? copy.wiredLogin
        : copy.unwiredLogin);
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
      const connection = await props.bridge.create({
        slug,
        name: name || display.name,
        providerType: props.providerType,
        baseUrl: resolvedBaseUrl,
        defaultModel: normalizedDefaultModel || recommendedDefaultModel,
        ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
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
      if (addProviderMountedRef.current) setError(providerPanelActionErrorMessage(err, locale));
    } finally {
      submitGuard.finish();
      if (addProviderMountedRef.current) setBusy(false);
    }
  }

  function submitApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  if (usesApiKeyDialog) {
    const errorId = `provider-key-dialog-${props.providerType}-error`;
    return (
      <form className="providerKeyDialogForm" onSubmit={submitApiKey}>
        <label>
          <span>API Key</span>
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
              if (error) setError(null);
            }}
            placeholder={copy.apiKeyPlaceholder}
            ariaLabel="API Key"
            ariaDescribedBy={error ? errorId : undefined}
            disabled={busy}
          />
        </label>
        {error && <p className="providerError" id={errorId} role="alert">{error}</p>}
        <div className="providerKeyDialogActions">
          <Button variant="ghost" isDisabled={busy} onClick={props.onCancel} label={copy.cancel} />
          <Button variant="primary" type="submit" isDisabled={busy} label={busy ? copy.saving : copy.save} />
        </div>
      </form>
    );
  }

  return (
    <div className="providerEditor">
      <div className="providerHeaderBadges">
        <Chip variant="neutral" size="sm">{categoryLabel(defaults.category, locale)}</Chip>
      </div>
      {isExperimental && (
        <Alert variant="info">
          <AlertTitle>{isWiredOAuth ? copy.wiredTitle : copy.unwiredTitle}</AlertTitle>
          <AlertDescription>{isWiredOAuth
            ? copy.wiredDetail
            : copy.unwiredDetail}</AlertDescription>
        </Alert>
      )}
      {supportsApiKey && (
        <label>
          <span>{copy.apiKeyLabel(requiresApiKey)}</span>
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
              if (error) setError(null);
            }}
            placeholder={copy.apiKeyPlaceholder}
            ariaLabel={`${display.name} ${copy.apiKey}`}
            disabled={isExperimental || busy}
          />
        </label>
      )}
      <label>
        <span>{copy.slug}</span>
        <Input
          value={slug}
          onChange={(event) => {
            setSlug(event.currentTarget.value);
            if (error) setError(null);
          }}
          placeholder="my-provider"
          disabled={isExperimental || busy}
          aria-label={copy.slugAria}
        />
      </label>
      <label>
        <span>{copy.name}</span>
        <Input
          value={name}
          onChange={(event) => {
            setName(event.currentTarget.value);
            if (error) setError(null);
          }}
          placeholder={display.name}
          disabled={isExperimental || busy}
          aria-label={copy.nameAria}
        />
      </label>
      {isCloudflareWorkersAi ? (
        <label>
          <span>{copy.accountIdLabel}</span>
          <Input
            value={cloudflareAccountId}
            onChange={(event) => {
              setCloudflareAccountId(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={copy.accountIdPlaceholder}
            disabled={busy}
            aria-label={copy.accountIdAria}
          />
        </label>
      ) : (
        <label>
          <span>{copy.endpointLabel(requiresBaseUrl)}</span>
          <Input
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={defaults.baseUrl || 'https://…'}
            disabled={isExperimental || busy}
            aria-label={copy.endpointAria}
          />
        </label>
      )}
      {showsDefaultModel && (
        <label>
          <span>{copy.defaultModel}</span>
          <Input
            value={defaultModel}
            onChange={(event) => {
              setDefaultModel(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={copy.defaultModelPlaceholder}
            disabled={isExperimental || busy}
            aria-label={copy.defaultModelAria}
          />
          <small>{copy.defaultModelHelp}</small>
        </label>
      )}
      {error && <p className="providerError" role="alert">{error}</p>}
      <div className="providerActions">
        <Button variant="ghost" isDisabled={busy} onClick={props.onCancel} label={copy.cancel} />
        <Button variant="primary" isDisabled={busy || isExperimental} onClick={submit} label={busy ? copy.saving : copy.save} />
      </div>
    </div>
  );
}

function usesQuickApiKeyDialog(providerType: ProviderType): boolean {
  const defaults = PROVIDER_DEFAULTS[providerType];
  return defaults.authKind === 'api_key' && Boolean(defaults.baseUrl);
}
