import { useState } from 'react';
import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type LlmConnection,
} from '@maka/core';
import {
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import { Button, Input, useMountedRef, useUiLocale } from '@maka/ui';
import { getVoiceSettingsCopy } from '../locales/settings-voice-copy';
import { PasswordInput } from './password-input';
import {
  providerPanelActionErrorMessage,
  type ConnectionsBridge,
} from './provider-panel-shared';
import { useActionGuard } from './use-action-guard';

export function VoiceRecognitionConnectionForm(props: {
  bridge: ConnectionsBridge;
  connection: LlmConnection;
  model: string;
  onCancel(): void;
  onSaved(connection: LlmConnection, model: string): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getVoiceSettingsCopy(locale);
  const [baseUrl, setBaseUrl] = useState(() => effectiveBaseUrl(props.connection));
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(props.model || props.connection.defaultModel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitGuard = useActionGuard<'submit'>();
  const mountedRef = useMountedRef();
  const supportsApiKey = providerAuthSupportsApiKey(props.connection.providerType);
  const endpointPlaceholder =
    PROVIDER_DEFAULTS[props.connection.providerType]?.baseUrl || 'https://…/v1';

  async function save(): Promise<void> {
    if (!submitGuard.begin('submit')) return;
    setError(null);
    const normalizedBaseUrl = baseUrl.trim();
    const normalizedModel = model.trim();
    if (!normalizedBaseUrl) {
      submitGuard.finish();
      setError(copy.recognitionConnectionEndpointMissing);
      return;
    }
    if (!normalizedModel) {
      submitGuard.finish();
      setError(copy.recognitionConnectionModelMissing);
      return;
    }
    setBusy(true);
    try {
      const updated = await props.bridge.update(props.connection.slug, {
        baseUrl: normalizedBaseUrl,
        defaultModel: normalizedModel,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      await props.onSaved(updated, normalizedModel);
    } catch (saveError) {
      if (!mountedRef.current) return;
      setError(providerPanelActionErrorMessage(saveError, locale));
    } finally {
      submitGuard.finish();
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="providerEditor">
      <label>
        <span>{copy.recognitionConnectionEndpoint}</span>
        <Input
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.currentTarget.value);
            if (error) setError(null);
          }}
          placeholder={endpointPlaceholder}
          disabled={busy}
          aria-label={copy.recognitionConnectionEndpoint}
        />
        <small>{copy.recognitionConnectionEndpointHelp}</small>
      </label>
      {supportsApiKey ? (
        <label>
          <span>{copy.recognitionConnectionApiKey}</span>
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
              if (error) setError(null);
            }}
            placeholder={copy.recognitionConnectionApiKeyPlaceholder}
            ariaLabel={copy.recognitionConnectionApiKey}
            disabled={busy}
          />
          <small>{copy.recognitionConnectionApiKeyHelp}</small>
        </label>
      ) : null}
      <label>
        <span>{copy.recognitionConnectionModel}</span>
        <Input
          value={model}
          onChange={(event) => {
            setModel(event.currentTarget.value);
            if (error) setError(null);
          }}
          placeholder={copy.recognitionConnectionModelPlaceholder}
          disabled={busy}
          aria-label={copy.recognitionConnectionModel}
        />
      </label>
      {error ? <p className="providerError" role="alert">{error}</p> : null}
      <div className="providerActions">
        <Button variant="ghost" type="button" disabled={busy} onClick={props.onCancel}>
          {copy.cancel}
        </Button>
        <Button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? copy.recognitionConnectionSaving : copy.recognitionConnectionSave}
        </Button>
      </div>
    </div>
  );
}
