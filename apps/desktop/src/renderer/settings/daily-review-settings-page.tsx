import { useEffect, useMemo, useState } from 'react';
import { Banner, Card, Item } from '@astryxdesign/core';
import type { DailyReviewConfig, DailyReviewMode, LlmConnection } from '@maka/core';
import {
  Button,
  Selector,
  Switch,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { buildCatalogDailyReviewModelOptions } from '../model-catalog-choices';
import { getDailyReviewSettingsCopy, type DailyReviewSettingsCopy } from '../locales/settings-daily-review-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';

/**
 * PR-DAILY-REVIEW-MVP-0 follow-up: Settings → 每日回顾 is no longer
 * a roadmap page. The sidebar panel handles browsing/usage; this
 * page summarizes what it does, the privacy boundary, and offers a
 * one-click jump to the sidebar.
 */
const DAILY_REVIEW_SECTION_KEYS = ['summary', 'gaps', 'usage', 'code'] as const;

const DAILY_REVIEW_DEFAULT_MODEL_VALUE = '__maka_daily_review_default_model__';

function buildDailyReviewModelOptions(
  connections: readonly LlmConnection[],
  currentModelKey: string,
  copy: DailyReviewSettingsCopy,
  locale: 'zh' | 'en',
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [
    { value: DAILY_REVIEW_DEFAULT_MODEL_VALUE, label: copy.defaultModel },
  ];
  options.push(
    ...buildCatalogDailyReviewModelOptions(
      connections,
      currentModelKey.trim() === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : currentModelKey,
      locale,
    ).map(([value, label]) => ({ value, label })),
  );
  return options;
}

export function DailyReviewSettingsPage(props: { connections: readonly LlmConnection[]; onOpenDailyReview?: () => void }) {
  const locale = useUiLocale();
  const copy = getDailyReviewSettingsCopy(locale);
  const toast = useToast();
  const dailyReviewIpc = window.maka.dailyReview;
  const hasConfigIpc = Boolean(dailyReviewIpc.getConfig && dailyReviewIpc.setConfig);
  const hasRunOnceIpc = Boolean(dailyReviewIpc.runOnce);

  const [config, setConfig] = useState<DailyReviewConfig | null>(null);
  const [loading, setLoading] = useState<boolean>(hasConfigIpc);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [runningMode, setRunningMode] = useState<DailyReviewMode | null>(null);
  const [executeTimeDraft, setExecuteTimeDraft] = useState('08:00');
  const [executeTimeInvalid, setExecuteTimeInvalid] = useState(false);
  const mountedRef = useMountedRef();
  const saveConfigGuard = useActionGuard<string>();
  const runModeGuard = useActionGuard<DailyReviewMode>();

  useEffect(() => {
    if (!hasConfigIpc || !dailyReviewIpc.getConfig) {
      setConfig(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    dailyReviewIpc
      .getConfig()
      .then((next) => {
        if (!cancelled && mountedRef.current) {
          setConfig(next);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && mountedRef.current) {
          setLoadError(settingsActionErrorMessage(err, locale));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasConfigIpc, dailyReviewIpc, locale]);

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
    } catch (err) {
      if (mountedRef.current && saveConfigGuard.current === key) {
        toast.error(copy.saveFailed, settingsActionErrorMessage(err, locale));
      }
    } finally {
      if (saveConfigGuard.current === key) {
        saveConfigGuard.finish();
      }
      if (mountedRef.current) setSavingKey(null);
    }
  }

  async function triggerRun(mode: DailyReviewMode) {
    if (!dailyReviewIpc.runOnce || runModeGuard.current !== null) return;
    runModeGuard.begin(mode);
    setRunningMode(mode);
    try {
      await dailyReviewIpc.runOnce({ mode });
      if (mountedRef.current && runModeGuard.current === mode) {
        toast.success(copy.runSuccess[mode], copy.runSuccessDetail);
      }
    } catch (err) {
      if (mountedRef.current && runModeGuard.current === mode) {
        toast.error(copy.runFailed, settingsActionErrorMessage(err, locale));
      }
    } finally {
      if (runModeGuard.current === mode) {
        runModeGuard.finish();
      }
      if (mountedRef.current) setRunningMode(null);
    }
  }

  const effectiveConfig = config;
  const formDisabled = !hasConfigIpc || loading || Boolean(loadError) || !effectiveConfig || savingKey !== null;
  const modelOptions = useMemo(
    () => buildDailyReviewModelOptions(props.connections, effectiveConfig?.modelKey ?? '', copy, locale),
    [copy, effectiveConfig?.modelKey, locale, props.connections],
  );
  const selectedModelValue = effectiveConfig?.modelKey?.trim()
    ? effectiveConfig.modelKey.trim()
    : DAILY_REVIEW_DEFAULT_MODEL_VALUE;

  return (
    <section className="settingsFeatureStatusPage" aria-label={copy.aria}>
      {/* Detail audit: the always-on feature banner repeated the page
          subtitle — report by exception instead: only the not-wired
          fallback state warrants a banner. */}
      {!hasConfigIpc && (
        <Banner status="info" title={copy.unavailable} />
      )}
      {loadError ? (
        <Banner
          status="error"
          className="settingsSurfaceAlert"
          title={copy.loadFailed(loadError)} />
      ) : null}
      <Card padding={0} className="settingsRows">
        <Item
          label={copy.enabled}
          description={copy.enabledHelp}
          endContent={<Switch
            label={copy.enabled}
            isLabelHidden
            value={effectiveConfig?.enabled ?? false}
            isDisabled={formDisabled || savingKey === 'enabled'}
            onChange={(enabled) => void patchConfig('enabled', { enabled })}
          />}
        />

        <Item
          label={copy.executeTime}
          description={copy.executeTimeHelp}
          endContent={<TextInput
            label={copy.executeTimeAria}
            isLabelHidden
            value={executeTimeDraft}
            isDisabled={formDisabled || savingKey === 'executeTime'}
            placeholder={copy.executeTimePlaceholder}
            width={140}
            status={
              executeTimeInvalid
                ? { type: 'error', message: copy.executeTimeInvalid }
                : undefined
            }
            onChange={(executeTime) => {
              setExecuteTimeDraft(executeTime);
              setExecuteTimeInvalid(false);
            }}
            onBlur={() => {
              if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(executeTimeDraft)) {
                setExecuteTimeInvalid(true);
                return;
              }
              if (executeTimeDraft !== effectiveConfig?.executeTime) {
                void patchConfig('executeTime', {
                  executeTime: executeTimeDraft,
                });
              }
            }}
          />}
        />

        {DAILY_REVIEW_SECTION_KEYS.map((key) => (
          <Item
            key={key}
            label={copy.sections[key].title}
            description={copy.sections[key].detail}
            endContent={<Switch
              label={copy.sections[key].title}
              isLabelHidden
              value={effectiveConfig?.sections[key] ?? false}
              isDisabled={formDisabled || savingKey === `section:${key}` || !(effectiveConfig?.enabled ?? false)}
              onChange={(next) =>
                void patchConfig(`section:${key}`, {
                  sections: {
                    ...(effectiveConfig?.sections ?? { summary: false, gaps: false, usage: false, code: false }),
                    [key]: next,
                  },
                })
              }
            />}
          />
        ))}

        <Item
          label={copy.deep}
          description={copy.deepHelp}
          endContent={<Switch
            label={copy.deep}
            isLabelHidden
            value={effectiveConfig?.deepEnabled ?? false}
            isDisabled={formDisabled || savingKey === 'deepEnabled'}
            onChange={(deepEnabled) => void patchConfig('deepEnabled', { deepEnabled })}
          />}
        />

        <Item
          label={copy.model}
          description={copy.modelHelp}
          endContent={<Selector
            value={selectedModelValue}
            label={copy.modelAria}
            isLabelHidden
            options={modelOptions}
            isDisabled={formDisabled || savingKey === 'modelKey' || modelOptions.length === 0}
            width={320}
            onChange={(value) => {
              void patchConfig('modelKey', {
                modelKey: value === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : value,
              });
            }}
          />}
        />

        <Item
          label={copy.includeCli}
          description={copy.includeCliHelp}
          endContent={<Switch
            label={copy.includeCli}
            isLabelHidden
            value={effectiveConfig?.includeClaudeCode ?? false}
            isDisabled={formDisabled || savingKey === 'includeClaudeCode'}
            onChange={(includeClaudeCode) => void patchConfig('includeClaudeCode', { includeClaudeCode })}
          />}
        />

        <Item
          label={copy.notify}
          description={copy.notifyHelp}
          endContent={<Switch
            label={copy.notify}
            isLabelHidden
            value={false}
            isDisabled={true}
            onChange={() => undefined}
          />}
        />
      </Card>
      {(props.onOpenDailyReview || hasRunOnceIpc) && (
        <div className="settingsPageFooterActions" role="toolbar" aria-label={copy.actionsAria}>
          {hasRunOnceIpc && (
            <>
              <Button
                variant="secondary"
                onClick={() => void triggerRun('deep')}
                isDisabled={runningMode !== null}
                label={runningMode === 'deep' ? copy.generating : copy.generateDeep}
              />
              <Button
                variant="secondary"
                onClick={() => void triggerRun('daily')}
                isDisabled={runningMode !== null}
                label={runningMode === 'daily' ? copy.generating : copy.generateDaily}
              />
            </>
          )}
          {props.onOpenDailyReview && (
            <Button
              variant="primary"
              onClick={props.onOpenDailyReview}
              label={copy.open}
            />
          )}
        </div>
      )}
    </section>
  );
}
