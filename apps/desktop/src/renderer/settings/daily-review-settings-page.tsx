import { useEffect, useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core';
import type { DailyReviewConfig } from '@maka/core/daily-review';
import type { LlmConnection } from '@maka/core/llm-connections';
import { Selector, Switch, TextInput, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { buildCatalogDailyReviewModelOptions } from '../model-catalog-choices';
import { getDailyReviewSettingsCopy, type DailyReviewSettingsCopy } from '../locales/settings-daily-review-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsRow, SettingsSection } from './settings-section';
import { SettingsSkeletonStack } from './settings-skeleton';
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

  if (loading) {
    return (
      <SettingsPage aria-label={copy.aria}>
        <SettingsSkeletonStack label={copy.aria} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage aria-label={copy.aria}>
      {!hasConfigIpc ? <Banner status="info" title={copy.unavailable} /> : null}
      {loadError ? <Banner status="error" title={copy.loadFailed(loadError)} /> : null}
      <SettingsSection title={copy.scheduleTitle} description={copy.scheduleDescription}>
        <SettingsRow
          label={copy.enabled}
          description={copy.enabledHelp}
          end={
            <Switch
              label={copy.enabled}
              isLabelHidden
              value={config?.enabled ?? false}
              isDisabled={formDisabled}
              onChange={(enabled) => void patchConfig('enabled', { enabled })}
            />
          }
        />
        <SettingsRow
          label={copy.executeTime}
          description={copy.executeTimeHelp}
          end={<TextInput
            label={copy.executeTime}
            isLabelHidden
            value={executeTimeDraft}
            isDisabled={scheduleDisabled}
            placeholder={copy.executeTimePlaceholder}
            width={110}
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
          />}
        />
      </SettingsSection>
      <SettingsSection title={copy.analysisTitle} description={copy.analysisDescription}>
        <SettingsRow
          label={copy.model}
          description={copy.modelHelp}
          end={<Selector
            value={selectedModelValue}
            label={copy.model}
            isLabelHidden
            options={modelOptions}
            placement="below"
            isDisabled={formDisabled || modelOptions.length === 0}
            onChange={(value) => void patchConfig('modelKey', {
              modelKey: value === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : value,
            })}
          />}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
