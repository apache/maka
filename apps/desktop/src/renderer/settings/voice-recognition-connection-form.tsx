import { useState } from 'react';
import {
  type LlmConnection,
} from '@maka/core';
import { PROVIDER_DEFAULTS, effectiveBaseUrl } from '@maka/core/llm-connections';
import {
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import { Button, FormLayout, TextInput, useMountedRef, useUiLocale, Banner } from '@maka/ui';
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
  const [error, setError] = useState<{
    field: 'baseUrl' | 'model' | 'form';
    message: string;
  } | null>(null);
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
      setError({
        field: 'baseUrl',
        message: copy.recognitionConnectionEndpointMissing,
      });
      return;
    }
    if (!normalizedModel) {
      submitGuard.finish();
      setError({
        field: 'model',
        message: copy.recognitionConnectionModelMissing,
      });
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
      setError({
        field: 'form',
        message: providerPanelActionErrorMessage(saveError, locale),
      });
    } finally {
      submitGuard.finish();
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="providerEditor">
      <FormLayout>
        <TextInput
          value={baseUrl}
          onChange={(value) => {
            setBaseUrl(value);
            if (error?.field === 'baseUrl') setError(null);
          }}
          placeholder={endpointPlaceholder}
          isDisabled={busy}
          label={copy.recognitionConnectionEndpoint}
          description={copy.recognitionConnectionEndpointHelp}
          status={
            error?.field === 'baseUrl'
              ? { type: 'error', message: error.message }
              : undefined
          }
        />
        {supportsApiKey ? (
          <PasswordInput
            value={apiKey}
            onChange={(next) => {
              setApiKey(next);
            }}
            placeholder={copy.recognitionConnectionApiKeyPlaceholder}
            label={copy.recognitionConnectionApiKey}
            description={copy.recognitionConnectionApiKeyHelp}
            isDisabled={busy}
          />
        ) : null}
        <TextInput
          value={model}
          onChange={(value) => {
            setModel(value);
            if (error?.field === 'model') setError(null);
          }}
          placeholder={copy.recognitionConnectionModelPlaceholder}
          isDisabled={busy}
          label={copy.recognitionConnectionModel}
          status={
            error?.field === 'model'
              ? { type: 'error', message: error.message }
              : undefined
          }
        />
      </FormLayout>
      {error?.field === 'form' ? (
        <Banner status="error" title={error.message} />
      ) : null}
      <div className="providerActions">
        <Button
          variant="ghost"
          type="button"
          isDisabled={busy}
          onClick={props.onCancel}
          label={copy.cancel}
        />
        {/* The save button no longer reports its own busy state through the
            label: clickAction gives it the spinner, aria-busy, and the
            same-tick dedupe a save must have. `busy` remains the form-wide
            lock that freezes the three fields and 取消 beside it. */}
        <Button
          variant="primary"
          type="button"
          isDisabled={busy}
          clickAction={() => save()}
          label={copy.recognitionConnectionSave}
        />
      </div>
    </div>
  );
}
