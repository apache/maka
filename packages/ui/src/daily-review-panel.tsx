import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSectionContent,
  DailyReviewArchiveSummary,
  DailyReviewRange,
  DailyReviewSectionKey,
  DailyReviewSummary,
} from '@maka/core';
import { DAILY_REVIEW_RANGES, uiLocaleToIntlLocale } from '@maka/core';
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
  Text,
  VStack,
} from '@astryxdesign/core';
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight } from './icons.js';
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
import { Markdown } from './markdown.js';
import { RelativeTime } from './relative-time.js';
import { useUiLocale } from './locale-context.js';
import { useMountedRef } from './use-mounted-ref.js';

type DailyReviewRoute =
  | { kind: 'activity' }
  | { kind: 'report'; archive: DailyReviewArchive };

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

  const [range, setRange] = useState<DailyReviewRange>(1);
  const [offsetDays, setOffsetDays] = useState(0);
  const [summary, setSummary] = useState<DailyReviewSummary | null>(null);
  const [summaryScopeKey, setSummaryScopeKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [archives, setArchives] = useState<DailyReviewArchiveSummary[]>([]);
  const [archivesReloadToken, setArchivesReloadToken] = useState(0);
  const [route, setRoute] = useState<DailyReviewRoute>({ kind: 'activity' });
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const scopeKey = dailyReviewScopeKey(offsetDays, range);
  const visibleSummary = summaryScopeKey === scopeKey ? summary : null;
  const currentArchive = useMemo(() => {
    if (!visibleSummary) return null;
    return archives.find((archive) =>
      archive.range === range
      && archive.day.fromMs === visibleSummary.day.fromMs
      && archive.day.toMs === visibleSummary.day.toMs,
    ) ?? null;
  }, [archives, range, visibleSummary]);

  useEffect(() => {
    let cancelled = false;
    const requestedScope = dailyReviewScopeKey(offsetDays, range);
    setLoading(true);
    setError(null);
    bridgeRef.current.fetchDay(offsetDays, range).then((next) => {
      if (cancelled) return;
      setSummary(next);
      setSummaryScopeKey(requestedScope);
      setLoading(false);
    }).catch((nextError: unknown) => {
      if (cancelled) return;
      setSummary(null);
      setSummaryScopeKey(null);
      setError(dailyReviewPanelErrorMessage(nextError, locale));
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
      return;
    }
    let cancelled = false;
    listArchives().then((next) => {
      if (!cancelled) setArchives(next);
    }).catch(() => {
      if (!cancelled) setArchives([]);
    });
    return () => {
      cancelled = true;
    };
  }, [archivesReloadToken]);

  const rangeLabel = (() => {
    if (range === 1) {
      if (offsetDays === 0) return copy.date.today;
      if (offsetDays === -1) return copy.date.yesterday;
      return copy.date.daysAgo(-offsetDays);
    }
    const base = range === 7 ? copy.date.recent7Days : copy.date.recent30Days;
    return offsetDays === 0 ? base : copy.date.shiftedRange(base, -offsetDays);
  })();

  function changeRange(value: string) {
    const next = Number(value) as DailyReviewRange;
    if (!DAILY_REVIEW_RANGES.includes(next)) return;
    setRange(next);
    setOffsetDays(0);
    setRoute({ kind: 'activity' });
  }

  async function openArchive(summaryRow: DailyReviewArchiveSummary) {
    const getArchive = props.bridge.getArchive;
    if (!getArchive || pendingAction !== null) return;
    setPendingAction('open');
    try {
      const archive = await getArchive(summaryRow.id);
      if (mounted.current) setRoute({ kind: 'report', archive });
    } catch (nextError) {
      if (mounted.current) setError(dailyReviewPanelErrorMessage(nextError, locale));
    } finally {
      if (mounted.current) setPendingAction(null);
    }
  }

  async function generateAnalysis() {
    const runOnce = props.bridge.runOnce;
    const getArchive = props.bridge.getArchive;
    if (!runOnce || !getArchive || pendingAction !== null) return;
    setPendingAction('generate');
    setError(null);
    try {
      const result = await runOnce({ range, offsetDays });
      const archive = await getArchive(result.archiveId);
      if (!mounted.current) return;
      setArchivesReloadToken((value) => value + 1);
      setRoute({ kind: 'report', archive });
    } catch (nextError) {
      if (mounted.current) setError(dailyReviewPanelErrorMessage(nextError, locale));
    } finally {
      if (mounted.current) setPendingAction(null);
    }
  }

  if (route.kind === 'report') {
    return (
      <DailyReviewReport
        archive={route.archive}
        summary={visibleSummary}
        onBack={() => setRoute({ kind: 'activity' })}
        onCopyMarkdown={props.onCopyMarkdown}
        onAppendMarkdown={props.onAppendMarkdown}
        onSaveMarkdown={props.onSaveMarkdown}
      />
    );
  }

  const totals = visibleSummary?.totals;
  const hasActivity = Boolean(totals && totals.sessionCount + totals.requestCount > 0);
  const canAnalyze = Boolean(props.bridge.runOnce && props.bridge.getArchive);

  return (
    <VStack className="maka-daily-review-panel" gap={5} data-loading={loading ? 'true' : undefined}>
      <HStack gap={4} vAlign="start" wrap="wrap">
        <StackItem size="fill">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap" className={props.hubHeader ? 'maka-module-hub-heading' : undefined}>
              <Heading level={2}>{props.hubHeader?.title ?? copy.page.title}</Heading>
              {props.hubHeader?.badge}
            </HStack>
          </VStack>
        </StackItem>
        <SegmentedControl
          value={String(range)}
          onChange={changeRange}
          label={copy.page.rangeSwitch}
          size="sm"
        >
          {copy.page.rangeOptions.map(([value, label]) => (
            <SegmentedControlItem key={value} value={value} label={label} />
          ))}
        </SegmentedControl>
      </HStack>

      <HStack className="maka-daily-review-toolbar" gap={2} vAlign="center" wrap="wrap" role="toolbar" aria-label={copy.page.timeRange}>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<ChevronLeft />}
          label={copy.date.earlier(range === 1 ? copy.date.unit.day : range === 7 ? copy.date.unit.week : copy.date.unit.month)}
          onClick={() => setOffsetDays((value) => value - range)}
        />
        <Text type="label" weight="semibold" className="maka-daily-review-range-label">{rangeLabel}</Text>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<ChevronRight />}
          label={copy.date.later(range === 1 ? copy.date.unit.day : range === 7 ? copy.date.unit.week : copy.date.unit.month)}
          isDisabled={offsetDays >= 0}
          onClick={() => setOffsetDays((value) => Math.min(0, value + range))}
        />
        <StackItem size="fill" />
        {currentArchive ? (
          <Button
            variant="primary"
            size="sm"
            label={copy.page.viewAnalysis}
            isLoading={pendingAction === 'open'}
            isDisabled={pendingAction !== null}
            onClick={() => void openArchive(currentArchive)}
          />
        ) : canAnalyze ? (
          <Button
            variant="primary"
            size="sm"
            label={copy.page.generateAnalysis}
            isLoading={pendingAction === 'generate'}
            isDisabled={pendingAction !== null || !visibleSummary || !hasActivity}
            onClick={() => void generateAnalysis()}
          />
        ) : null}
      </HStack>

      <Divider />

      {error ? (
        <Banner
          status="warning"
          title={copy.overview.refreshFailed(error)}
          endContent={<Button variant="ghost" size="sm" label={copy.overview.retry} onClick={() => setReloadToken((value) => value + 1)} />}
        />
      ) : null}

      {loading || !visibleSummary ? (
        <VStack gap={3} aria-busy="true">
          <Skeleton width="100%" height={64} radius="rounded" index={0} />
          <Skeleton width="100%" height={48} radius="rounded" index={1} />
          <Skeleton width="100%" height={48} radius="rounded" index={2} />
        </VStack>
      ) : (
        <>
          <div className="maka-daily-review-metrics" aria-label={copy.overview.ariaLabel(rangeLabel)}>
            <DailyReviewMetric label={copy.overview.conversations} value={totals?.sessionCount.toString() ?? '0'} />
            <DailyReviewMetric label={copy.overview.requests} value={totals?.requestCount.toString() ?? '0'} />
            <DailyReviewMetric label={copy.overview.tokens} value={(totals?.totalTokens ?? 0).toLocaleString(intlLocale)} />
            <DailyReviewMetric label={copy.overview.cost} value={`$${(totals?.costUsd ?? 0).toFixed(2)}`} />
            {(totals?.errorCount ?? 0) > 0 ? (
              <DailyReviewMetric label={copy.overview.errors} value={totals!.errorCount.toString()} tone="error" />
            ) : null}
          </div>

          <VStack gap={2}>
            <Heading level={3}>{copy.overview.activeConversations}</Heading>
            {visibleSummary.sessions.length > 0 ? (
              <List density="balanced" hasDividers>
                {visibleSummary.sessions.map((session) => (
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
              <EmptyState
                icon={<CalendarDays />}
                title={offsetDays === 0 && range === 1 ? copy.emptyOverview.todayTitle : copy.emptyOverview.rangeTitle(rangeLabel)}
                description={offsetDays === 0 && range === 1 ? copy.emptyOverview.todayBody : copy.emptyOverview.rangeBody(rangeLabel)}
              />
            )}
          </VStack>
        </>
      )}
    </VStack>
  );
}

function DailyReviewMetric(props: { label: string; value: string; tone?: 'error' }) {
  return (
    <VStack className="maka-daily-review-metric" gap={0} data-tone={props.tone}>
      <Text type="supporting" color="secondary">{props.label}</Text>
      <Text type="large" weight="semibold">{props.value}</Text>
    </VStack>
  );
}

function DailyReviewReport(props: {
  archive: DailyReviewArchive;
  summary: DailyReviewSummary | null;
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

  const actionInput = props.summary ? { markdown, label: title, summary: props.summary } : null;
  return (
    <VStack className="maka-daily-review-panel maka-daily-review-report" gap={5}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button variant="ghost" size="sm" icon={<ArrowLeft />} label={copy.page.backToActivity} onClick={props.onBack} />
        <StackItem size="fill" />
        {actionInput && props.onCopyMarkdown ? (
          <Button variant="secondary" size="sm" label={pendingAction === 'copy' ? copy.export.copying : copy.export.copy} isDisabled={pendingAction !== null} onClick={() => void runAction('copy', () => props.onCopyMarkdown?.(actionInput))} />
        ) : null}
        {actionInput && props.onAppendMarkdown ? (
          <Button variant="secondary" size="sm" label={pendingAction === 'append' ? copy.export.appending : copy.export.append} isDisabled={pendingAction !== null} onClick={() => void runAction('append', () => props.onAppendMarkdown?.(actionInput))} />
        ) : null}
        {actionInput && props.onSaveMarkdown ? (
          <Button variant="secondary" size="sm" label={pendingAction === 'save' ? copy.export.saving : copy.export.save} isDisabled={pendingAction !== null} onClick={() => void runAction('save', () => props.onSaveMarkdown?.(actionInput))} />
        ) : null}
      </HStack>
      <VStack gap={1}>
        <Heading level={2}>{title}</Heading>
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
        <EmptyState title={copy.archive.noContent} />
      )}
    </VStack>
  );
}

function reportSections(sections: DailyReviewArchiveSectionContent): Array<{
  key: DailyReviewSectionKey;
  content: string;
}> {
  const keys: DailyReviewSectionKey[] = ['summary', 'gaps', 'usage', 'code'];
  return keys.flatMap((key) => {
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
