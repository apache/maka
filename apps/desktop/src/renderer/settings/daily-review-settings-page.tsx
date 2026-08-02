import { useEffect, useMemo, useState } from 'react';
import { Banner, Divider, Heading, HStack, Text, VStack } from '@astryxdesign/core';
import type { DailyReviewConfig, LlmConnection } from '@maka/core';
import { FormLayout, Selector, Switch, TextInput, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { buildCatalogDailyReviewModelOptions } from '../model-catalog-choices';
import { getDailyReviewSettingsCopy, type DailyReviewSettingsCopy } from '../locales/settings-daily-review-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';

const DAILY_REVIEW_DEFAULT_MODEL_VALUE = '__maka_daily_review_default_model__';

function buildDailyReviewModelOptions(
  connections: readonly LlmConnection[],
  currentModelKey: string,
  copy: DailyReviewSettingsCopy,
  locale: 'zh' | 'en',
): Array<{ value: string; label: string }> {
  return [
    { value: DAILY_REVIEW_DEFAULT_MODEL_VALUE, label: copy.defaultModel },
    ...buildCatalogDailyReviewModelOptions(connections, currentModelKey, locale).map(([value, label]) => ({
      value,
      label,
    })),
  ];
}

function SettingsSection(props: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <VStack gap={5}>
      <VStack gap={1}>
        <Heading level={2}>{props.title}</Heading>
        <Text type="supporting" color="secondary">{props.description}</Text>
      </VStack>
      {props.children}
    </VStack>
  );
}

export function DailyReviewSettingsPage(props: { connections: readonly LlmConnection[] }) {
  const locale = useUiLocale();
  const copy = getDailyReviewSettingsCopy(locale);
  const toast = useToast();
  const dailyReviewIpc = window.maka.dailyReview;
  const hasConfigIpc = Boolean(dailyReviewIpc.getConfig && dailyReviewIpc.setConfig);
  const [config, setConfig] = useState<DailyReviewConfig | null>(null);
  const [loading, setLoading] = useState(hasConfigIpc);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [executeTimeDraft, setExecuteTimeDraft] = useState('08:00');
  const [executeTimeInvalid, setExecuteTimeInvalid] = useState(false);
  const mountedRef = useMountedRef();
  const saveConfigGuard = useActionGuard<string>();

  useEffect(() => {
    if (!hasConfigIpc || !dailyReviewIpc.getConfig) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    dailyReviewIpc.getConfig().then((next) => {
      if (!cancelled && mountedRef.current) {
        setConfig(next);
        setLoading(false);
      }
    }).catch((error: unknown) => {
      if (!cancelled && mountedRef.current) {
        setLoadError(settingsActionErrorMessage(error, locale));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [dailyReviewIpc, hasConfigIpc, locale, mountedRef]);

  useEffect(() => {
    setExecuteTimeDraft(config?.executeTime ?? '08:00');
    setExecuteTimeInvalid(false);
  }, [config?.executeTime]);

  async function patchConfig(key: string, patch: Partial<DailyReviewConfig>) {
    if (!dailyReviewIpc.setConfig || !config || saveConfigGuard.current !== null) return;
    saveConfigGuard.begin(key);
    setSavingKey(key);
    try {
      const next = await dailyReviewIpc.setConfig(patch);
      if (mountedRef.current && saveConfigGuard.current === key) setConfig(next);
    } catch (error) {
      if (mountedRef.current && saveConfigGuard.current === key) {
        toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (saveConfigGuard.current === key) saveConfigGuard.finish();
      if (mountedRef.current) setSavingKey(null);
    }
  }

  const modelOptions = useMemo(
    () => buildDailyReviewModelOptions(props.connections, config?.modelKey ?? '', copy, locale),
    [config?.modelKey, copy, locale, props.connections],
  );
  const formDisabled = !hasConfigIpc || loading || Boolean(loadError) || !config || savingKey !== null;
  const scheduleDisabled = formDisabled;
  const selectedModelValue = config?.modelKey.trim() || DAILY_REVIEW_DEFAULT_MODEL_VALUE;

  return (
    <VStack className="settingsFormPage" gap={8} aria-label={copy.aria}>
      {!hasConfigIpc ? <Banner status="info" title={copy.unavailable} /> : null}
      {loadError ? <Banner status="error" title={copy.loadFailed(loadError)} /> : null}

      <SettingsSection title={copy.scheduleTitle} description={copy.scheduleDescription}>
        <FormLayout className="settingsFormLayout">
          <HStack justify="between" align="center" gap={6}>
            <VStack gap={1}>
              <Text type="body">{copy.enabled}</Text>
              <Text type="supporting" color="secondary">{copy.enabledHelp}</Text>
            </VStack>
            <Switch
              label={copy.enabled}
              isLabelHidden
              value={config?.enabled ?? false}
              isDisabled={formDisabled}
              onChange={(enabled) => void patchConfig('enabled', { enabled })}
            />
          </HStack>
          <TextInput
            label={copy.executeTime}
            description={copy.executeTimeHelp}
            value={executeTimeDraft}
            isDisabled={scheduleDisabled}
            placeholder={copy.executeTimePlaceholder}
            width="100%"
            status={executeTimeInvalid ? { type: 'error', message: copy.executeTimeInvalid } : undefined}
            onChange={(executeTime) => {
              setExecuteTimeDraft(executeTime);
              setExecuteTimeInvalid(false);
            }}
            onBlur={() => {
              if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(executeTimeDraft)) {
                setExecuteTimeInvalid(true);
              } else if (executeTimeDraft !== config?.executeTime) {
                void patchConfig('executeTime', { executeTime: executeTimeDraft });
              }
            }}
          />
        </FormLayout>
      </SettingsSection>

      <Divider />

      <SettingsSection title={copy.analysisTitle} description={copy.analysisDescription}>
        <FormLayout className="settingsFormLayout">
          <Selector
            value={selectedModelValue}
            label={copy.model}
            description={copy.modelHelp}
            options={modelOptions}
            isDisabled={formDisabled || modelOptions.length === 0}
            width="100%"
            onChange={(value) => void patchConfig('modelKey', {
              modelKey: value === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : value,
            })}
          />
        </FormLayout>
      </SettingsSection>
    </VStack>
  );
}
