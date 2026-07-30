import { useEffect, useMemo, useState } from 'react';
import type { DailyReviewConfig, DailyReviewMode, LlmConnection } from '@maka/core';
import { Alert, AlertDescription, Button, SettingsSelect, SettingsSwitch as Switch, TimePicker, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { buildCatalogDailyReviewModelOptions } from '../model-catalog-choices';
import { getDailyReviewSettingsCopy, type DailyReviewSettingsCopy } from '../locales/settings-daily-review-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsRows } from './settings-rows';
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
): Array<readonly [string, string]> {
  const options: Array<readonly [string, string]> = [
    [DAILY_REVIEW_DEFAULT_MODEL_VALUE, copy.defaultModel],
  ];
  options.push(...buildCatalogDailyReviewModelOptions(
    connections,
    currentModelKey.trim() === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : currentModelKey,
    locale,
  ));
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
        <header className="settingsFeatureStatusBanner" role="status">
          <span className="settingsFeatureStatusBannerDot" aria-hidden="true" />
          <span>{copy.unavailable}</span>
        </header>
      )}

      {loadError ? (
        <Alert variant="error" className="settingsSurfaceAlert">
          <AlertDescription>{copy.loadFailed(loadError)}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsRows>
        <div className="settingsRow">
          <div>
            <strong>{copy.enabled}</strong>
            <small>{copy.enabledHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.enabled}
            checked={effectiveConfig?.enabled ?? false}
            disabled={formDisabled || savingKey === 'enabled'}
            onChange={(enabled) => void patchConfig('enabled', { enabled })}
          />
        </div>

        <div className="settingsRow" data-control-width="compact">
          <div>
            <strong>{copy.executeTime}</strong>
            <small>{copy.executeTimeHelp}</small>
          </div>
          {/* Was a native time field. WebKit draws that control's popup
              itself — platform-blue columns, platform metrics, no dark
              mode — and no `::-webkit-*` selector reaches it, so the only
              way onto the design system was to own the popup. TimePicker
              keeps the same `HH:MM` value contract, so the persisted
              config shape is unchanged. */}
          <TimePicker
            ariaLabel={copy.executeTimeAria}
            className="settingsTimeInput"
            value={effectiveConfig?.executeTime ?? '08:00'}
            disabled={formDisabled || savingKey === 'executeTime'}
            hourLabel={copy.executeTimeHour}
            minuteLabel={copy.executeTimeMinute}
            onChange={(executeTime) => {
              void patchConfig('executeTime', { executeTime });
            }}
          />
        </div>

        {DAILY_REVIEW_SECTION_KEYS.map((key) => (
          <div key={key} className="settingsRow">
            <div>
              <strong>{copy.sections[key].title}</strong>
              <small>{copy.sections[key].detail}</small>
            </div>
            <Switch
              ariaLabel={copy.sections[key].title}
              checked={effectiveConfig?.sections[key] ?? false}
              disabled={formDisabled || savingKey === `section:${key}` || !(effectiveConfig?.enabled ?? false)}
              onChange={(next) =>
                void patchConfig(`section:${key}`, {
                  sections: {
                    ...(effectiveConfig?.sections ?? { summary: false, gaps: false, usage: false, code: false }),
                    [key]: next,
                  },
                })
              }
            />
          </div>
        ))}

        <div className="settingsRow">
          <div>
            <strong>{copy.deep}</strong>
            <small>{copy.deepHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.deep}
            checked={effectiveConfig?.deepEnabled ?? false}
            disabled={formDisabled || savingKey === 'deepEnabled'}
            onChange={(deepEnabled) => void patchConfig('deepEnabled', { deepEnabled })}
          />
        </div>

        <div className="settingsRow" data-control-width="select">
          <div>
            <strong>{copy.model}</strong>
            <small>{copy.modelHelp}</small>
          </div>
          <SettingsSelect
            value={selectedModelValue}
            ariaLabel={copy.modelAria}
            options={modelOptions}
            disabled={formDisabled || savingKey === 'modelKey' || modelOptions.length === 0}
            onChange={(value) => {
              void patchConfig('modelKey', {
                modelKey: value === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : value,
              });
            }}
          />
        </div>

        <div className="settingsRow">
          <div>
            <strong>{copy.includeCli}</strong>
            <small>{copy.includeCliHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.includeCli}
            checked={effectiveConfig?.includeClaudeCode ?? false}
            disabled={formDisabled || savingKey === 'includeClaudeCode'}
            onChange={(includeClaudeCode) => void patchConfig('includeClaudeCode', { includeClaudeCode })}
          />
        </div>

        <div className="settingsRow">
          <div>
            <strong>{copy.notify}</strong>
            <small>{copy.notifyHelp}</small>
          </div>
          <Switch
            ariaLabel={copy.notify}
            checked={false}
            disabled={true}
            onChange={() => undefined}
          />
        </div>
      </SettingsRows>

      {(props.onOpenDailyReview || hasRunOnceIpc) && (
        <div className="settingsPageFooterActions" role="toolbar" aria-label={copy.actionsAria}>
          {hasRunOnceIpc && (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void triggerRun('deep')}
                disabled={runningMode !== null}
              >
                {runningMode === 'deep' ? copy.generating : copy.generateDeep}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void triggerRun('daily')}
                disabled={runningMode !== null}
              >
                {runningMode === 'daily' ? copy.generating : copy.generateDaily}
              </Button>
            </>
          )}
          {props.onOpenDailyReview && (
            <Button
              type="button"
              onClick={props.onOpenDailyReview}
            >
              {copy.open}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
