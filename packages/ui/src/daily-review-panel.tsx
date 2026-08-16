import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSectionContent,
  DailyReviewArchiveSummary,
  DailyReviewRange,
  DailyReviewSectionKey,
  DailyReviewSummary,
} from '@maka/core/daily-review';
import { DAILY_REVIEW_RANGES, DAILY_REVIEW_SECTION_KEYS } from '@maka/core/daily-review';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import {
  Banner,
  Button,
  Divider,
  EmptyState,
  Heading,
  HStack,
  List,
  ListItem,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  StackItem,
  Toolbar,
  Text,
  VStack,
} from '@astryxdesign/core';
import { ICON_SIZE, ArrowLeft, CalendarDays, ChevronLeft, ChevronRight } from './icons.js';
import {
  dailyReviewPanelErrorMessage,
  dailyReviewScopeKey,
  formatDailyReviewArchiveGeneratedAt,
  formatDailyReviewArchiveTitle,
  formatDailyReviewModelLabel,
} from './daily-review-helpers.js';
import type { DailyReviewBridge, DailyReviewMarkdownActionInput } from './module-panel-types.js';
import type { ModuleHubHeader } from './module-hub-selector.js';
import { getDailyReviewCopy } from './daily-review-copy.js';
import { ModulePage } from './primitives/module-page.js';
import { Markdown } from './markdown.js';
import { RelativeTime } from './relative-time.js';
import { useUiLocale } from './locale-context.js';
import { useMountedRef } from './use-mounted-ref.js';
import {
  createDailyReviewActivityState,
  dailyReviewActivityReducer,
  shiftDailyReviewScope,
  type DailyReviewScope,
} from './daily-review-view-state.js';

type DailyReviewRoute =
  | { kind: 'activity' }
  | { kind: 'report'; archive: DailyReviewArchive };

type DailyReviewArchiveState =
  | { status: 'loading' }
  | { status: 'ready'; archives: DailyReviewArchiveSummary[] }
  | { status: 'error'; error: string };

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
  const mounted = useMountedRef();
  const bridgeRef = useRef(props.bridge);
  bridgeRef.current = props.bridge;

  const [activityState, dispatchActivity] = useReducer(
    dailyReviewActivityReducer,
    { range: 1, offsetDays: 0 },
    createDailyReviewActivityState,
  );
  const [reloadToken, setReloadToken] = useState(0);
  const [archiveState, setArchiveState] = useState<DailyReviewArchiveState>({ status: 'loading' });
  const [archivesReloadToken, setArchivesReloadToken] = useState(0);
  const [route, setRoute] = useState<DailyReviewRoute>({ kind: 'activity' });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { range, offsetDays } = activityState.selection;
  const scopeKey = dailyReviewScopeKey(offsetDays, range);
  const resolvedView = activityState.resolvedView;
  const displayedSummary = resolvedView?.summary ?? null;
  const visibleSummary = resolvedView?.scopeKey === scopeKey ? resolvedView.summary : null;
  const loading = activityState.pendingScopeKey !== null;
  const error = actionError
    ?? activityState.error
    ?? (archiveState.status === 'error' ? archiveState.error : null);
  const currentArchive = useMemo(() => {
    if (!visibleSummary || archiveState.status !== 'ready') return null;
    return archiveState.archives.find((archive) =>
      archive.range === range
      && archive.day.fromMs === visibleSummary.day.fromMs
      && archive.day.toMs === visibleSummary.day.toMs,
    ) ?? null;
  }, [archiveState, range, visibleSummary]);

  useEffect(() => {
    let cancelled = false;
    const requestedScope = { range, offsetDays };
    dispatchActivity({ type: 'selected', scope: requestedScope });
    bridgeRef.current.fetchDay(offsetDays, range).then((next) => {
      if (cancelled) return;
      dispatchActivity({ type: 'resolved', scope: requestedScope, summary: next });
    }).catch((nextError: unknown) => {
      if (cancelled) return;
      dispatchActivity({
        type: 'rejected',
        scope: requestedScope,
        error: dailyReviewPanelErrorMessage(nextError, locale),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [locale, offsetDays, range, reloadToken]);

  useEffect(() => {
    const listArchives = bridgeRef.current.listArchives;
    if (!listArchives) {
      setArchiveState({ status: 'ready', archives: [] });
      return;
    }
    let cancelled = false;
    setArchiveState({ status: 'loading' });
    listArchives().then((next) => {
      if (!cancelled) setArchiveState({ status: 'ready', archives: next });
    }).catch((nextError: unknown) => {
      if (!cancelled) {
        setArchiveState({
          status: 'error',
          error: dailyReviewPanelErrorMessage(nextError, locale),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [archivesReloadToken, locale]);

  const rangeLabel = formatScopeLabel(activityState.selection);
  const displayedRangeLabel = resolvedView ? formatScopeLabel(resolvedView.scope) : rangeLabel;

  function formatScopeLabel(scope: DailyReviewScope): string {
    if (scope.range === 1) {
      if (scope.offsetDays === 0) return copy.date.today;
      if (scope.offsetDays === -1) return copy.date.yesterday;
      return copy.date.daysAgo(-scope.offsetDays);
    }
    const base = scope.range === 7 ? copy.date.recent7Days : copy.date.recent30Days;
    return scope.offsetDays === 0 ? base : copy.date.shiftedRange(base, -scope.offsetDays);
  }

  function selectScope(scope: DailyReviewScope) {
    setActionError(null);
    dispatchActivity({ type: 'selected', scope });
    setRoute({ kind: 'activity' });
  }

  function changeRange(value: string) {
    const next = Number(value) as DailyReviewRange;
    if (!DAILY_REVIEW_RANGES.includes(next)) return;
    selectScope({ range: next, offsetDays: 0 });
  }

  async function openArchive(summaryRow: DailyReviewArchiveSummary) {
    const getArchive = props.bridge.getArchive;
    if (!getArchive || pendingAction !== null) return;
    setPendingAction('open');
    try {
      const archive = await getArchive(summaryRow.id);
      if (mounted.current) setRoute({ kind: 'report', archive });
    } catch (nextError) {
      if (mounted.current) setActionError(dailyReviewPanelErrorMessage(nextError, locale));
    } finally {
      if (mounted.current) setPendingAction(null);
    }
  }

  async function generateAnalysis() {
    const runOnce = props.bridge.runOnce;
    const getArchive = props.bridge.getArchive;
    if (!runOnce || !getArchive || pendingAction !== null) return;
    setPendingAction('generate');
    setActionError(null);
    try {
      const result = await runOnce({ range, offsetDays });
      const archive = await getArchive(result.archiveId);
      if (!mounted.current) return;
      setArchivesReloadToken((value) => value + 1);
      setRoute({ kind: 'report', archive });
    } catch (nextError) {
      if (mounted.current) setActionError(dailyReviewPanelErrorMessage(nextError, locale));
    } finally {
      if (mounted.current) setPendingAction(null);
    }
  }

  const totals = displayedSummary?.totals;
  const currentTotals = visibleSummary?.totals;
  const hasActivity = Boolean(currentTotals && currentTotals.sessionCount + currentTotals.requestCount > 0);
  const canAnalyze = Boolean(
    props.bridge.runOnce
    && props.bridge.listArchives
    && props.bridge.getArchive,
  );

  const primaryAction = currentArchive?.status === 'ok' ? (
    <Button
      variant="primary"
      label={copy.page.viewAnalysis}
      isLoading={pendingAction === 'open'}
      isDisabled={pendingAction !== null}
      onClick={() => void openArchive(currentArchive)}
    />
  ) : canAnalyze ? (
    <Button
      variant="primary"
      label={currentArchive ? copy.page.retryAnalysis : copy.page.generateAnalysis}
      isLoading={pendingAction === 'generate'}
      isDisabled={
        archiveState.status !== 'ready'
        || pendingAction !== null
        || !visibleSummary
        || !hasActivity
      }
      onClick={() => void generateAnalysis()}
    />
  ) : null;

  if (route.kind === 'report') {
    return (
      <ModulePage title={props.hubHeader?.title ?? copy.page.title}>
        <div key="report" className="maka-module-page-panel">
          <DailyReviewReport
            archive={route.archive}
            onBack={() => setRoute({ kind: 'activity' })}
            onCopyMarkdown={props.onCopyMarkdown}
            onAppendMarkdown={props.onAppendMarkdown}
            onSaveMarkdown={props.onSaveMarkdown}
          />
        </div>
      </ModulePage>
    );
  }

  return (
    <ModulePage
      title={props.hubHeader?.title ?? copy.page.title}
      meta={totals ? copy.archive.sessionCount(totals.sessionCount) : undefined}
      actions={primaryAction}
      toolbar={(
        <div className="maka-module-page-bar">
          {props.hubHeader?.badge}
          <Toolbar
            size="sm"
            label={copy.page.timeRange}
            startContent={(
              <SegmentedControl value={String(range)} onChange={changeRange} label={copy.page.rangeSwitch} size="sm">
                {copy.page.rangeOptions.map(([value, label]) => (
                  <SegmentedControlItem key={value} value={value} label={label} />
                ))}
              </SegmentedControl>
            )}
            endContent={(
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<ChevronLeft size={ICON_SIZE.chrome} />}
                  label={copy.date.earlier(copy.date.unit.day)}
                  onClick={() => selectScope(shiftDailyReviewScope({ range, offsetDays }, -1))}
                />
                <Text type="label" weight="semibold" className="maka-daily-review-range-label">{rangeLabel}</Text>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<ChevronRight size={ICON_SIZE.chrome} />}
                  label={copy.date.later(copy.date.unit.day)}
                  isDisabled={offsetDays >= 0}
                  onClick={() => selectScope(shiftDailyReviewScope({ range, offsetDays }, 1))}
                />
              </>
            )}
          />
        </div>
      )}
    >
      <div key="activity" className="maka-module-page-panel" data-loading={loading ? 'true' : undefined}>
      {error ? (
        <Banner
          status="warning"
          title={copy.overview.refreshFailed(error)}
          endContent={<Button
            variant="ghost"
            size="sm"
            label={copy.overview.retry}
            onClick={() => {
              setActionError(null);
              dispatchActivity({ type: 'selected', scope: activityState.selection });
              setReloadToken((value) => value + 1);
              setArchivesReloadToken((value) => value + 1);
            }}
          />}
        />
      ) : null}

      {!displayedSummary && loading ? (
        <VStack gap={3} aria-busy="true">
          <Skeleton width="100%" height={64} radius="rounded" index={0} />
          <Skeleton width="100%" height={48} radius="rounded" index={1} />
          <Skeleton width="100%" height={48} radius="rounded" index={2} />
        </VStack>
      ) : displayedSummary ? (
        <div
          key={resolvedView?.scopeKey}
          className="maka-daily-review-content"
          aria-busy={loading}
          data-refreshing={loading ? 'true' : undefined}
        >
          <div className="maka-daily-review-metrics" role="group" aria-label={copy.overview.ariaLabel(displayedRangeLabel)}>
            <DailyReviewMetric label={copy.overview.conversations} value={totals?.sessionCount.toString() ?? '0'} />
            <DailyReviewMetric label={copy.overview.requests} value={totals?.requestCount.toString() ?? '0'} />
            <DailyReviewMetric label={copy.overview.tokens} value={(totals?.totalTokens ?? 0).toLocaleString(intlLocale)} />
            <DailyReviewMetric label={copy.overview.cost} value={`$${(totals?.costUsd ?? 0).toFixed(2)}`} />
          </div>

          <VStack gap={2}>
            <Heading level={3}>{copy.overview.activeConversations}</Heading>
            {displayedSummary.sessions.length > 0 ? (
              <List density="balanced" hasDividers className="maka-module-page-rows">
                {displayedSummary.sessions.map((session) => (
                  <ListItem
                    key={session.id}
                    label={session.name}
                    description={session.lastMessagePreview}
                    endContent={<RelativeTime ts={session.lastMessageAt} />}
                    onClick={props.onSelectSession ? () => props.onSelectSession?.(session.id) : undefined}
                  />
                ))}
              </List>
            ) : (
              /* Section-local absence (DESIGN.md §10 tier 1): the range
                 stepper above is a scope control, not a filter, so this stays
                 compact and actionless. */
              (<EmptyState
                isCompact
                title={resolvedView?.scope.offsetDays === 0 && resolvedView.scope.range === 1 ? copy.emptyOverview.todayTitle : copy.emptyOverview.rangeTitle(displayedRangeLabel)}
              />)
            )}
          </VStack>
        </div>
      ) : null}
      </div>
    </ModulePage>
  );
}

function DailyReviewMetric(props: { label: string; value: string }) {
  return (
    <VStack className="maka-daily-review-metric" gap={0}>
      <Text type="supporting" color="secondary">{props.label}</Text>
      <Text type="large" weight="semibold">{props.value}</Text>
    </VStack>
  );
}

function DailyReviewReport(props: {
  archive: DailyReviewArchive;
  onBack(): void;
  onCopyMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
}) {
  const locale = useUiLocale();
  const copy = getDailyReviewCopy(locale);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const title = formatDailyReviewArchiveTitle(props.archive, locale);
  const sections = reportSections(props.archive.sections);
  const markdown = formatArchiveMarkdown(title, sections, copy.archive.section);
  const meta = [
    formatDailyReviewArchiveGeneratedAt(props.archive.generatedAt, locale),
    props.archive.modelKey ? formatDailyReviewModelLabel(props.archive.modelKey) : copy.archive.defaultModel,
  ].join(' · ');

  async function runAction(key: string, action: (() => Promise<void> | void) | undefined) {
    if (!action || pendingAction !== null) return;
    setPendingAction(key);
    try {
      await action();
    } finally {
      setPendingAction(null);
    }
  }

  const actionInput = {
    day: props.archive.day,
    range: props.archive.range,
    totals: props.archive.totals,
    markdown,
    label: title,
  };
  return (
    <VStack className="maka-daily-review-report" gap={5}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={ICON_SIZE.chrome} />} label={copy.page.backToActivity} onClick={props.onBack} />
        <StackItem size="fill" />
        {props.onCopyMarkdown ? (
          <Button variant="secondary" size="sm" label={pendingAction === 'copy' ? copy.export.copying : copy.export.copy} isDisabled={pendingAction !== null} onClick={() => void runAction('copy', () => props.onCopyMarkdown?.(actionInput))} />
        ) : null}
        {props.onAppendMarkdown ? (
          <Button variant="secondary" size="sm" label={pendingAction === 'append' ? copy.export.appending : copy.export.append} isDisabled={pendingAction !== null} onClick={() => void runAction('append', () => props.onAppendMarkdown?.(actionInput))} />
        ) : null}
        {props.onSaveMarkdown ? (
          <Button variant="secondary" size="sm" label={pendingAction === 'save' ? copy.export.saving : copy.export.save} isDisabled={pendingAction !== null} onClick={() => void runAction('save', () => props.onSaveMarkdown?.(actionInput))} />
        ) : null}
      </HStack>
      <VStack gap={1}>
        <Heading level={3}>{title}</Heading>
        <Text type="supporting" color="secondary">{meta}</Text>
      </VStack>
      {props.archive.status !== 'ok' ? (
        <Banner
          status={props.archive.status === 'failed' || props.archive.status === 'no_model' ? 'error' : 'info'}
          title={copy.archive.status[props.archive.status]}
          description={props.archive.errorMessage}
        />
      ) : null}
      <Divider />
      {sections.length > 0 ? (
        <VStack gap={6}>
          {sections.map((section, index) => (
            <VStack key={section.key} gap={2}>
              {index > 0 ? <Divider /> : null}
              <Heading level={3}>{copy.archive.section[section.key]}</Heading>
              <div className="maka-daily-review-report-prose">
                <Markdown text={section.content} />
              </div>
            </VStack>
          ))}
        </VStack>
      ) : (
        /* Panel empty (DESIGN.md §10 tier 2): the whole report body is empty,
           so it carries icon and description. */
        (<EmptyState
          icon={<CalendarDays size={ICON_SIZE.empty} />}
          title={copy.archive.noContent}
          description={copy.archive.noContentHelp}
        />)
      )}
    </VStack>
  );
}

function reportSections(sections: DailyReviewArchiveSectionContent): Array<{
  key: DailyReviewSectionKey;
  content: string;
}> {
  return DAILY_REVIEW_SECTION_KEYS.flatMap((key) => {
    const content = sections[key]?.trim();
    return content ? [{ key, content }] : [];
  });
}

function formatArchiveMarkdown(
  title: string,
  sections: ReadonlyArray<{ key: DailyReviewSectionKey; content: string }>,
  labels: Record<DailyReviewSectionKey, string>,
): string {
  return [`# ${title}`, ...sections.flatMap((section) => ['', `## ${labels[section.key]}`, section.content])].join('\n');
}
