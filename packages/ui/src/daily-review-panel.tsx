import { useEffect, useMemo, useRef, useState } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { useMountedRef } from './use-mounted-ref.js';
import { CalendarDays, ChevronLeft, ChevronRight } from './icons.js';
import { SettingsSelect } from './primitives/settings-select.js';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewMode,
  DailyReviewSummary,
  DailyReviewTopEntry,
} from '@maka/core';
import { uiLocaleToIntlLocale } from '@maka/core';
import {
  type DailyReviewRange,
  dailyReviewPanelErrorMessage,
  dailyReviewScopeKey,
  formatDailyReviewArchiveGeneratedAt,
  formatDailyReviewArchiveTitle,
  formatDailyReviewMarkdown,
  formatDailyReviewModelLabel,
} from './daily-review-helpers.js';
import { Button as UiButton } from './ui.js';
import { Chip, type ChipProps } from './primitives/chip.js';
import { Segmented } from './primitives/segmented.js';
import { Alert, AlertAction, AlertDescription } from './primitives/alert.js';
import { EmptyState } from './empty-state.js';
import { StatTile } from './primitives/stat-tile.js';
import { SectionHeader } from './primitives/section-header.js';
import { PageHeader } from './primitives/page-header.js';
import type { DailyReviewBridge, DailyReviewMarkdownActionInput } from './module-panel-types.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import { RelativeTime } from './relative-time.js';
import { Markdown } from './markdown.js';
import { useUiLocale } from './locale-context.js';
import { getDailyReviewCopy } from './daily-review-copy.js';

type DailyReviewArchiveSectionKey = keyof DailyReviewArchive['sections'];

const EMPTY_MODEL_OPTIONS: ReadonlyArray<readonly [string, string]> = [];

// Archive-status Chip tone. ok = generated cleanly (success), failed /
// no_model = the run could not produce a report (destructive). no_data /
// skipped are expected non-events and stay neutral (exception-only color).
function dailyReviewArchiveChipTone(status: DailyReviewArchive['status']): ChipProps['variant'] {
  // Status-color restraint (#651 rule): 已生成 is the EXPECTED outcome —
  // neutral ink, matching 健康 正常 and 权限 已授权. Color stays reserved
  // for the failures that need attention.
  if (status === 'failed' || status === 'no_model') return 'destructive';
  return 'neutral';
}

export function DailyReviewPanel(props: {
  bridge: DailyReviewBridge;
  hubHeader?: ModuleHubHeader;
  onSelectSession?: (sessionId: string) => void;
  onCopyMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getDailyReviewCopy(locale);
  const intlLocale = uiLocaleToIntlLocale(locale);
  const [offsetDays, setOffsetDays] = useState(0);
  // PR-DAILY-REVIEW-RANGE-0: 今日 / 本周 / 本月 tabs that map to a
  // 1 / 7 / 30 day aggregation. When span > 1, the day-stepper
  // navigates by the same span (一个 30 天 window steps back 30 days).
  const [range, setRange] = useState<DailyReviewRange>(1);
  const [summary, setSummary] = useState<DailyReviewSummary | null>(null);
  const [summaryScopeKey, setSummaryScopeKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingDailyReviewAction, setPendingDailyReviewAction] = useState<string | null>(null);
  const [archives, setArchives] = useState<DailyReviewArchiveSummary[]>([]);
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);
  const [selectedArchive, setSelectedArchive] = useState<DailyReviewArchive | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveReloadToken, setArchiveReloadToken] = useState(0);
  const modelOptions = useMemo(() => props.bridge.modelOptions ?? EMPTY_MODEL_OPTIONS, [props.bridge.modelOptions]);
  const [selectedModelKey, setSelectedModelKey] = useState<string>(modelOptions[0]?.[0] ?? '');
  const dailyReviewMountedRef = useMountedRef();
  const summaryScopeKeyRef = useRef<string | null>(null);
  const pendingDailyReviewActionRef = useRef<string | null>(null);
  const archiveLoadRequestRef = useRef(0);
  // PR-582-FOLLOWUP: bridge methods (fetchDay, listArchives, getArchive)
  // are thin IPC wrappers that don't depend on the connections array.
  // Track the latest bridge via ref so effects don't re-fire when the
  // bridge object is recreated due to an unrelated connections change
  // (e.g. updatedAt timestamp bump from a provider status refresh).
  const bridgeRef = useRef(props.bridge);
  bridgeRef.current = props.bridge;
  const currentSummaryScopeKey = dailyReviewScopeKey(offsetDays, range);
  const visibleSummary = summaryScopeKey === currentSummaryScopeKey ? summary : null;
  const canLoadArchives = Boolean(props.bridge.listArchives && props.bridge.getArchive);

  useEffect(() => {
    return () => {
      pendingDailyReviewActionRef.current = null;
      archiveLoadRequestRef.current += 1;
    };
  }, []);

  function chooseDailyReviewArchive(archiveId: string) {
    archiveLoadRequestRef.current += 1;
    setSelectedArchiveId(archiveId);
    setSelectedArchive(null);
    setArchiveLoading(Boolean(props.bridge.getArchive));
    setArchiveError(null);
  }

  useEffect(() => {
    let cancelled = false;
    const scopeKey = dailyReviewScopeKey(offsetDays, range);
    setLoading(true);
    setError(null);
    bridgeRef.current
      .fetchDay(offsetDays, range)
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        summaryScopeKeyRef.current = scopeKey;
        setSummaryScopeKey(scopeKey);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (summaryScopeKeyRef.current !== scopeKey) {
          summaryScopeKeyRef.current = null;
          setSummary(null);
          setSummaryScopeKey(null);
        }
        setError(dailyReviewPanelErrorMessage(err, locale));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locale, offsetDays, range, reloadToken]);

  useEffect(() => {
    const listArchives = bridgeRef.current.listArchives;
    if (!listArchives) {
      setArchives([]);
      setSelectedArchiveId(null);
      setSelectedArchive(null);
      return;
    }
    let cancelled = false;
    setArchiveError(null);
    listArchives()
      .then((next) => {
        if (cancelled) return;
        setArchives(next);
        setSelectedArchiveId((current) => {
          if (current && next.some((archive) => archive.id === current)) return current;
          return next[0]?.id ?? null;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setArchiveError(dailyReviewPanelErrorMessage(err, locale));
      });
    return () => {
      cancelled = true;
    };
  }, [archiveReloadToken, locale]);

  useEffect(() => {
    const getArchive = bridgeRef.current.getArchive;
    if (!getArchive || !selectedArchiveId) {
      archiveLoadRequestRef.current += 1;
      setSelectedArchive(null);
      setArchiveLoading(false);
      return;
    }
    let cancelled = false;
    const archiveId = selectedArchiveId;
    const archiveRequestId = ++archiveLoadRequestRef.current;
    setSelectedArchive(null);
    setArchiveLoading(true);
    setArchiveError(null);
    getArchive(archiveId)
      .then((next) => {
        if (cancelled) return;
        if (archiveLoadRequestRef.current !== archiveRequestId) return;
        setSelectedArchive(next);
        setArchiveLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (archiveLoadRequestRef.current !== archiveRequestId) return;
        setSelectedArchive(null);
        setArchiveError(dailyReviewPanelErrorMessage(err, locale));
        setArchiveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [archiveReloadToken, locale, selectedArchiveId]);

  useEffect(() => {
    if (modelOptions.length === 0) {
      setSelectedModelKey('');
      return;
    }
    setSelectedModelKey((current) => {
      if (modelOptions.some(([value]) => value === current)) return current;
      return modelOptions[0]?.[0] ?? '';
    });
  }, [modelOptions]);

  const dayLabel = (() => {
    if (range === 1) {
      if (offsetDays === 0) return copy.date.today;
      if (offsetDays === -1) return copy.date.yesterday;
      return copy.date.daysAgo(-offsetDays);
    }
    const rangeText = range === 7 ? copy.date.recent7Days : copy.date.recent30Days;
    if (offsetDays === 0) return rangeText;
    return copy.date.shiftedRange(rangeText, -offsetDays);
  })();

  // Stepper step matches the range size — for 7-day mode the user
  // skips a whole week at a time, not a single day.
  const stepperLabel = range === 1 ? copy.date.unit.day : range === 7 ? copy.date.unit.week : copy.date.unit.month;
  // IA restructure: the 概览 section is ALWAYS rendered (honest zeros +
  // this one inline hint) so a no-activity scope no longer collapses the
  // page to a floating orphan line at the bottom. The hint absorbs the old
  // bottom-of-page orphan into the 概览 header's flow. Copy keeps the endorsed
  // waiting-state framing (等待记录今天活动 / 无活动 — visible-copy-hygiene).
  const emptyOverviewTitle = offsetDays === 0 && range === 1
    ? copy.emptyOverview.todayTitle
    : copy.emptyOverview.rangeTitle(dayLabel);
  const emptyOverviewBody = offsetDays === 0 && range === 1
    ? copy.emptyOverview.todayBody
    : copy.emptyOverview.rangeBody(dayLabel);

  async function runDailyReviewAction(actionKey: string, action: () => void | Promise<void>) {
    if (pendingDailyReviewActionRef.current !== null) return;
    pendingDailyReviewActionRef.current = actionKey;
    setPendingDailyReviewAction(actionKey);
    try {
      await action();
    } finally {
      if (pendingDailyReviewActionRef.current === actionKey) {
        pendingDailyReviewActionRef.current = null;
        if (dailyReviewMountedRef.current) setPendingDailyReviewAction(null);
      }
    }
  }

  function isDailyReviewActionCurrent(actionKey: string): boolean {
    return dailyReviewMountedRef.current && pendingDailyReviewActionRef.current === actionKey;
  }

  const dailyReviewActionBusy = pendingDailyReviewAction !== null;
  const hasDailyReviewActions = Boolean(props.onCopyMarkdown || props.onAppendMarkdown || props.onSaveMarkdown);
  const canManualRun = Boolean(props.bridge.runOnce);

  async function triggerManualRun(mode: DailyReviewMode) {
    const runOnce = props.bridge.runOnce;
    if (!runOnce) return;
    const actionKey = `run:${mode}`;
    await runDailyReviewAction(actionKey, async () => {
      try {
        const result = await runOnce({ mode, modelKey: selectedModelKey });
        if (!isDailyReviewActionCurrent(actionKey)) return;
        chooseDailyReviewArchive(result.archiveId);
        setArchiveReloadToken((n) => n + 1);
        setReloadToken((n) => n + 1);
      } catch (err) {
        if (isDailyReviewActionCurrent(actionKey)) setError(dailyReviewPanelErrorMessage(err, locale));
      }
    });
  }

  // Export actions ride with the 概览 stats they serialize; the guard keeps
  // them off an all-zero scope (nothing to export). Shape pinned by the
  // daily-review-copy-feedback contract — do not restructure the condition.
  const overviewActions =
    visibleSummary && visibleSummary.totals.sessionCount + visibleSummary.totals.requestCount > 0 && hasDailyReviewActions ? (
      <div className="maka-daily-review-actions" aria-label={copy.export.ariaLabel}>
        {props.onCopyMarkdown && (
          <UiButton
            type="button"
            variant="secondary"
            size="sm"
            className="maka-daily-review-copy min-w-[4rem]"
            onClick={() => void runDailyReviewAction('copy', async () => {
              const md = formatDailyReviewMarkdown(visibleSummary, dayLabel, locale);
              await props.onCopyMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
            })}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
            title={copy.export.copyTitle}
          >
            {pendingDailyReviewAction === 'copy' ? copy.export.copying : copy.export.copy}
          </UiButton>
        )}
        {props.onAppendMarkdown && (
          <UiButton
            type="button"
            variant="secondary"
            size="sm"
            className="maka-daily-review-append min-w-[5rem]"
            onClick={() => void runDailyReviewAction('append', async () => {
              const md = formatDailyReviewMarkdown(visibleSummary, dayLabel, locale);
              await props.onAppendMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
            })}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'append' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'append' ? 'true' : undefined}
            title={copy.export.appendTitle}
          >
            {pendingDailyReviewAction === 'append' ? copy.export.appending : copy.export.append}
          </UiButton>
        )}
        {props.onSaveMarkdown && (
          <UiButton
            type="button"
            variant="secondary"
            size="sm"
            className="maka-daily-review-save min-w-[4rem]"
            onClick={() => void runDailyReviewAction('save', async () => {
              const md = formatDailyReviewMarkdown(visibleSummary, dayLabel, locale);
              await props.onSaveMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
            })}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'save' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'save' ? 'true' : undefined}
            title={copy.export.saveTitle}
          >
            {pendingDailyReviewAction === 'save' ? copy.export.saving : copy.export.save}
          </UiButton>
        )}
      </div>
    ) : null;

  return (
    <div className="maka-daily-review-panel" data-loading={loading ? 'true' : undefined}>
      {/* IA redesign (owner: 每日回顾 页面很乱): the PageHeader is THE page
          shell — title + subtitle, and the 生成 actions ride its actions slot
          (same pattern as the skills page's 添加). The analysis-model select is
          now a COMPACT generation option inside that same cluster, not a
          page-wide row. */}
      <PageHeader
        className="maka-module-main-header"
        as="h2"
        title={props.hubHeader?.title ?? copy.page.title}
        subtitle={props.hubHeader?.subtitle ?? copy.page.subtitle}
        badge={props.hubHeader?.badge}
        headingRowClassName={props.hubHeader ? 'maka-module-hub-heading' : undefined}
        actions={canManualRun ? (
          <div className="maka-daily-review-generate" role="group" aria-label={copy.page.generateAriaLabel}>
            {modelOptions.length > 0 && (
              <SettingsSelect
                value={selectedModelKey}
                ariaLabel={copy.page.analysisModel}
                options={modelOptions}
                onChange={setSelectedModelKey}
                disabled={dailyReviewActionBusy}
                width="compact"
                className="maka-daily-review-model-select"
              />
            )}
            <UiButton
              type="button"
              variant="default"
              size="sm"
              className="maka-daily-review-quick-run min-w-[6rem]"
              onClick={() => void triggerManualRun('daily')}
              disabled={dailyReviewActionBusy}
              data-pending={pendingDailyReviewAction === 'run:daily' ? 'true' : undefined}
              aria-busy={pendingDailyReviewAction === 'run:daily' ? 'true' : undefined}
            >
              {pendingDailyReviewAction === 'run:daily' ? copy.page.generating : copy.page.generateDaily}
            </UiButton>
            <UiButton
              type="button"
              variant="secondary"
              size="sm"
              className="maka-daily-review-quick-run min-w-[6rem]"
              onClick={() => void triggerManualRun('deep')}
              disabled={dailyReviewActionBusy}
              data-pending={pendingDailyReviewAction === 'run:deep' ? 'true' : undefined}
              aria-busy={pendingDailyReviewAction === 'run:deep' ? 'true' : undefined}
            >
              {pendingDailyReviewAction === 'run:deep' ? copy.page.generating : copy.page.generateDeep}
            </UiButton>
          </div>
        ) : undefined}
      />

      {/* One time-scope row directly under the header: the 今日/本周/本月
          segmented + the day-stepper are BOTH time navigation, so they form a
          single visual cluster (was two floating rows at opposite corners). */}
      <div className="maka-daily-review-scope" aria-label={copy.page.timeRange}>
        <Segmented
          value={String(range)}
          options={copy.page.rangeOptions}
          onChange={(v) => {
            setRange(Number(v) as DailyReviewRange);
            setOffsetDays(0);
          }}
          ariaLabel={copy.page.rangeSwitch}
          className="maka-daily-review-range-tabs"
        />
        <div className="maka-daily-review-scope-stepper">
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="maka-daily-review-stepper"
            onClick={() => setOffsetDays((n) => n - range)}
            aria-label={copy.date.earlier(stepperLabel)}
          >
            <ChevronLeft aria-hidden="true" />
          </UiButton>
          <div className="maka-daily-review-day">{dayLabel}</div>
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="maka-daily-review-stepper"
            onClick={() => setOffsetDays((n) => Math.min(0, n + range))}
            disabled={offsetDays >= 0}
            aria-label={copy.date.later(stepperLabel)}
          >
            <ChevronRight aria-hidden="true" />
          </UiButton>
        </div>
      </div>

      {/* 概览 — ALWAYS rendered for the selected scope. Honest zeros + one
          inline hint replace the old bottom orphan line, so a no-activity
          scope no longer collapses the page to nothing. */}
      <section className="maka-daily-review-overview" aria-label={copy.overview.ariaLabel(dayLabel)}>
        <SectionHeader as="h4" accent title={copy.overview.title} action={overviewActions} />
        {error && visibleSummary ? (
          <Alert variant="warning" className="maka-daily-review-alert">
            <AlertDescription>{copy.overview.refreshFailed(error)}</AlertDescription>
            <AlertAction>
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                className="maka-daily-review-alert-retry"
                onClick={() => setReloadToken((n) => n + 1)}
                disabled={loading}
              >
                {copy.overview.retry}
              </UiButton>
            </AlertAction>
          </Alert>
        ) : null}

        {error && !visibleSummary ? (
          <EmptyState
            Icon={CalendarDays}
            title={copy.overview.readFailed}
            body={error}
            cta={{ label: copy.overview.retry, onClick: () => setReloadToken((n) => n + 1) }}
            extraClassName="maka-daily-review-summary-empty"
          />
        ) : !visibleSummary ? (
          <div className="maka-daily-review-loading" aria-busy="true">
            <div className="maka-skeleton maka-skeleton-line" style={{ width: '60%' }} />
            <div className="maka-skeleton maka-skeleton-line" style={{ width: '90%' }} />
            <div className="maka-skeleton maka-skeleton-line" style={{ width: '75%' }} />
          </div>
        ) : (
          <>
            <div className="maka-daily-review-totals">
              <DailyReviewTotalsCell label={copy.overview.conversations} value={visibleSummary.totals.sessionCount.toString()} />
              <DailyReviewTotalsCell label={copy.overview.requests} value={visibleSummary.totals.requestCount.toString()} />
              <DailyReviewTotalsCell
                label="Token"
                value={visibleSummary.totals.totalTokens.toLocaleString(intlLocale)}
              />
              <DailyReviewTotalsCell
                label={copy.overview.cost}
                value={`$${visibleSummary.totals.costUsd.toFixed(2)}`}
              />
              {visibleSummary.totals.errorCount > 0 && (
                <DailyReviewTotalsCell
                  label={copy.overview.errors}
                  value={visibleSummary.totals.errorCount.toString()}
                  tone="error"
                />
              )}
            </div>

            {visibleSummary.totals.sessionCount === 0 && visibleSummary.totals.requestCount === 0 ? (
              <EmptyState variant="inline" title={emptyOverviewTitle} body={emptyOverviewBody} />
            ) : (
              <>
                {visibleSummary.sessions.length > 0 && (
                  <section className="maka-daily-review-section" aria-label={copy.overview.activeConversations}>
                    <SectionHeader as="h4" accent title={copy.overview.activeConversations} />
                    <ul className="maka-daily-review-list" aria-label={copy.overview.activeConversationList}>
                      {visibleSummary.sessions.map((session) => (
                        <li key={session.id} className="maka-daily-review-list-item">
                          {/* Active-conversation rows are composite navigation
                              controls. Their semantic row seam owns layout and state;
                              they are not a shared Button size or variant. */}
                          <BaseButton
                            type="button"
                            className="maka-daily-review-session-button"
                            onClick={() => props.onSelectSession?.(session.id)}
                            disabled={!props.onSelectSession}
                          >
                            <span className="maka-daily-review-session-name">{session.name}</span>
                            <RelativeTime
                              ts={session.lastMessageAt}
                              className="maka-daily-review-session-time"
                            />
                          </BaseButton>
                          {session.lastMessagePreview && (
                            <span className="maka-daily-review-session-preview">
                              {session.lastMessagePreview}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {visibleSummary.topModels.length > 0 && (
                  <DailyReviewTopList title={copy.overview.modelUsage} entries={visibleSummary.topModels} />
                )}

                {visibleSummary.topTools.length > 0 && (
                  <DailyReviewTopList title={copy.overview.toolCalls} entries={visibleSummary.topTools} />
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* 报告 — stacked, newest-first. Each report is a full-width surface
          whose meta header (date · 模式 · N 对话 · 触发+时间 · 模型) is always
          visible; the selected one expands its four content sections below.
          This replaces the broken left-list / right-body master-detail that
          left the list column half-empty. Body loads stay single-selection
          (getArchive) — the archive-body-load contract pins that lazy path. */}
      {canLoadArchives && (
        <section className="maka-daily-review-reports" aria-label={copy.reports.title}>
          <SectionHeader
            as="h4"
            accent
            title={copy.reports.title}
            count={<span className="maka-daily-review-archive-count">{copy.reports.count(archives.length)}</span>}
          />
          {archiveError && (
            <Alert variant="warning" className="maka-daily-review-alert">
              <AlertDescription>{copy.reports.readFailed(archiveError)}</AlertDescription>
              <AlertAction>
                <UiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="maka-daily-review-alert-retry"
                  onClick={() => setArchiveReloadToken((n) => n + 1)}
                  disabled={archiveLoading}
                >
                  {copy.overview.retry}
                </UiButton>
              </AlertAction>
            </Alert>
          )}
          {archives.length === 0 && !archiveError ? (
            <EmptyState
              Icon={CalendarDays}
              title={copy.reports.emptyTitle}
              body={copy.reports.emptyBody}
              cta={canManualRun ? {
                label: copy.page.generateDaily,
                onClick: () => void triggerManualRun('daily'),
                disabled: dailyReviewActionBusy,
              } : undefined}
              extraClassName="maka-daily-review-summary-empty"
            />
          ) : (
            <ul className="maka-daily-review-report-list" aria-label={copy.reports.historyAriaLabel}>
              {archives.map((archive) => {
                const selected = selectedArchiveId === archive.id;
                // Status color is exception-only (#651): 已生成 / 无数据 / 已跳过
                // are EXPECTED outcomes and stay as muted prose meta. Only a
                // failed / no_model run raises a colored Chip that needs eyes.
                const exceptional = archive.status === 'failed' || archive.status === 'no_model';
                const meta = [
                  copy.archive.sessionCount(archive.totals.sessionCount),
                  copy.archive.generated(copy.archive.trigger[archive.trigger], formatDailyReviewArchiveGeneratedAt(archive.generatedAt, locale)),
                  archive.modelKey ? formatDailyReviewModelLabel(archive.modelKey) : copy.archive.defaultModel,
                ].join(' · ');
                return (
                  <li key={archive.id}>
                    <article className="maka-daily-review-report" data-selected={selected ? '' : undefined}>
                      <button
                        type="button"
                        className="maka-daily-review-report-head"
                        onClick={() => chooseDailyReviewArchive(archive.id)}
                        aria-expanded={selected}
                      >
                        <span className="maka-daily-review-report-heading">
                          <span className="maka-daily-review-report-title">
                            {formatDailyReviewArchiveTitle(archive, locale)}
                          </span>
                          <span className="maka-daily-review-archive-row-meta">{meta}</span>
                        </span>
                        {exceptional && (
                          <Chip
                            size="sm"
                            variant={dailyReviewArchiveChipTone(archive.status)}
                            className="maka-daily-review-report-status"
                            data-status={archive.status}
                          >
                            {copy.archive.status[archive.status]}
                          </Chip>
                        )}
                      </button>
                      {selected && (
                        <DailyReviewArchiveBody archive={selectedArchive} loading={archiveLoading} />
                      )}
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function DailyReviewArchiveBody(props: { archive: DailyReviewArchive | null; loading: boolean }) {
  const locale = useUiLocale();
  const copy = getDailyReviewCopy(locale);
  if (props.loading) {
    return (
      <div className="maka-daily-review-report-body" aria-busy="true">
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '58%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '92%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '74%' }} />
      </div>
    );
  }
  if (!props.archive) {
    return (
      <div className="maka-daily-review-report-body maka-daily-review-archive-empty">
        {copy.archive.opening}
      </div>
    );
  }
  const archive = props.archive;
  const sections = (Object.keys(copy.archive.section) as DailyReviewArchiveSectionKey[])
    .map((key) => {
      const content = archive.sections[key]?.trim();
      return content ? { key, content } : null;
    })
    .filter((entry): entry is { key: DailyReviewArchiveSectionKey; content: string } => entry !== null);
  // The report's date / 模式 / 触发 / 时间 / 模型 meta now lives in the surface
  // head above this body (no repeated header, no 已生成 status chip on the
  // expected state) — the body carries only the report substance.
  return (
    <div className="maka-daily-review-report-body" aria-label={formatDailyReviewArchiveTitle(archive, locale)}>
      {archive.errorMessage && (
        <p className="maka-daily-review-archive-error">{archive.errorMessage}</p>
      )}
      {sections.length > 0 ? (
        <div className="maka-daily-review-archive-sections">
          {sections.map((section) => (
            <section key={section.key} className="maka-daily-review-archive-section">
              <SectionHeader as="h4" accent title={copy.archive.section[section.key]} />
              {/* Reports are LLM-generated markdown — bullet lists and
                  inline code rendered as flat pre-wrap text read as mush.
                  Reuse the shared Markdown pipeline (same one chat uses). */}
              <div className="maka-daily-review-archive-section-body maka-prose">
                <Markdown text={section.content} />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="maka-daily-review-archive-empty">
          {copy.archive.noContent}
        </p>
      )}
    </div>
  );
}

function DailyReviewTotalsCell(props: { label: string; value: string; tone?: 'error' }) {
  // Convergence R4: shared StatTile, filled emphasis; the error tone maps
  // to the primitive's destructive ink + this cell's tinted wash (CSS).
  return (
    <StatTile
      className="maka-daily-review-totals-cell"
      emphasis="filled"
      label={props.label}
      value={props.value}
      tone={props.tone === 'error' ? 'destructive' : 'neutral'}
    />
  );
}

function DailyReviewTopList(props: { title: string; entries: ReadonlyArray<DailyReviewTopEntry> }) {
  const locale = useUiLocale();
  const copy = getDailyReviewCopy(locale);
  return (
    <section className="maka-daily-review-section" aria-label={props.title}>
      <SectionHeader as="h4" accent title={props.title} />
      <ul className="maka-daily-review-list" aria-label={copy.list.ariaLabel(props.title)}>
        {props.entries.map((entry) => (
          <li key={entry.key} className="maka-daily-review-list-item">
            <span className="maka-daily-review-top-label">{entry.label}</span>
            <span className="maka-daily-review-top-meta">
              {copy.list.requestCount(entry.requests)} · {entry.totalTokens.toLocaleString(uiLocaleToIntlLocale(locale))} tok
              {entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(2)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
