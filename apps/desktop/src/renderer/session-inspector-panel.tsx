import { type ReactNode, useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { uiLocaleToIntlLocale, type UiLocale } from '@maka/core';
import type { TraceTotals } from '@maka/core/session-trace';
import { useUiLocale } from '@maka/ui';
import { Activity, AlertTriangle } from '@maka/ui/icons';
import {
  getDesktopConversationCopy,
  type InspectorCopy,
  inspectorStepKindLabel,
} from './locales/conversation-copy.js';
import { applyInspectorFilter, type InspectorFilter } from './session-inspector-filter.js';
import { deriveInspectorOverviewModel } from './session-inspector-overview-model.js';
import {
  deriveInspectorPanelModel,
  type InspectorStepRow,
  type InspectorTurnRow,
} from './session-inspector-panel-model.js';
import { useSessionTrace } from './use-session-trace.js';


/**
 * Per-session trace (#1625), read top to bottom rather than through a
 * switcher: the overview answers where the session stands — how full the
 * context is, what the tokens and cache did, what it cost — and the timeline
 * under it answers what happened, turn by turn. They are the same question at
 * two zoom levels, so a reader wants one after the other, not one instead of
 * the other; a session with no metered overview simply starts at the timeline.
 *
 * Read-only. Every judgement it makes lives in `deriveInspectorOverviewModel`
 * and `deriveInspectorPanelModel`; this file lays the result out — in the
 * same components the rest of the workbar uses, so a read that failed looks
 * like every other failed read (Banner), and a session that did nothing looks
 * like every other empty surface (EmptyState) rather than like a stray
 * paragraph.
 */
export function SessionInspectorPanel(props: { sessionId: string; active: boolean }) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).inspector;
  const snapshot = useSessionTrace(props.sessionId, props.active, {
    loadFailed: copy.loadFailed,
    locale,
  });
  const [filter, setFilter] = useState<InspectorFilter>({});
  const trace = useMemo(() => deriveInspectorPanelModel(snapshot.trace), [snapshot.trace]);
  const model = useMemo(() => applyInspectorFilter(trace, filter, copy), [trace, filter, copy]);
  const overview = useMemo(() => deriveInspectorOverviewModel(snapshot.trace), [snapshot.trace]);
  // Counted on the unfiltered trace, so turning the filter on cannot change
  // the number that named it.
  const failedTurns = trace.turns.filter((turn) => turn.failed).length;
  const hidden = model.hiddenTurns + model.hiddenSteps;

  return (
    <Section
      variant="transparent"
      padding={4}
      className="maka-inspector-panel"
      data-maka-contract="session-inspector"
      aria-label={copy.ariaLabel}
      aria-busy={snapshot.loading || undefined}
    >
      {/* 24px between blocks against 8px inside one: proximity is the only
          grouping tool a panel without boxes has, and it used to spend the
          same 16px on "these are two parts of one block" and "this is a
          different block". */}
      <VStack gap={6} height="100%">
        {snapshot.error && (
          <Banner
            status="error"
            title={snapshot.error}
            endContent={
              <Button variant="ghost" size="sm" label={copy.retry} onClick={snapshot.retry} />
            }
          />
        )}

        {/* A session that did nothing, which is not the same silence as a read
            that failed (the Banner above) or a filter that matches nothing
            (announced down in the timeline, next to the rows it is about). */}
        <div
          role="status"
          aria-live="polite"
          className="maka-inspector-status"
          /* With nothing to trace the region IS the panel, so it takes the
             leftover height and centres its empty state the way every other
             workbar tab does. */
          data-empty={model.empty || undefined}
        >
          {model.empty && !snapshot.loading && !snapshot.error && (
            <EmptyState
              isCompact
              title={copy.empty}
              icon={<Activity size={20} aria-hidden="true" />}
            />
          )}
        </div>

        {!model.empty && (
          <InspectorOverview copy={copy} locale={locale} totals={model.totals} overview={overview} />
        )}

        {!model.empty && (
          <div className="maka-inspector-raw" data-maka-contract="session-inspector-raw">
            <VStack gap={2}>
              <div className="maka-inspector-section-head maka-inspector-timeline-head">
                <Heading level={3} className="maka-inspector-section-title">
                  {copy.overview.timelineTab}
                </Heading>
                {/* The failure count IS the failure filter. A count is a fact
                    the reader wanted anyway, so it earns its place before it
                    is asked to be a control, and it costs a word where a
                    Switch cost a track, a label and a wrapped line. */}
                {failedTurns > 0 && (
                  <button
                    type="button"
                    className="maka-inspector-failed-filter"
                    aria-pressed={filter.failedOnly ?? false}
                    onClick={() => setFilter({ ...filter, failedOnly: !filter.failedOnly })}
                  >
                    {copy.filterFailedOnly(failedTurns)}
                  </button>
                )}
                <TextInput
                  size="sm"
                  className="maka-inspector-search"
                  label={copy.filterLabel}
                  isLabelHidden
                  hasClear
                  value={filter.query ?? ''}
                  placeholder={copy.filterPlaceholder}
                  onChange={(value) => setFilter({ ...filter, query: value })}
                />
              </div>

              {/* What the filter is doing, beside the rows it did it to. A
                  persistent live region rather than a conditional one: a
                  container that mounts and unmounts is not announced, and this
                  message changes as the reader types. */}
              <div role="status" aria-live="polite" className="maka-inspector-status">
                {model.filtered && model.turns.length === 0 && (
                  <EmptyState
                    isCompact
                    title={copy.noMatches}
                    data-maka-contract="session-inspector-no-matches"
                  />
                )}
                {model.filtered && hidden > 0 && model.turns.length > 0 && (
                  <p className="maka-inspector-meta" data-maka-contract="session-inspector-hidden">
                    {copy.hiddenByFilter(hidden)}
                  </p>
                )}
              </div>

              {model.coverage && (
                <p
                  className="maka-inspector-coverage-note"
                  data-maka-contract="session-inspector-coverage"
                >
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    {(model.coverage.kind === 'absent'
                      ? copy.coverageAbsent
                      : copy.coveragePartial)(
                      [
                        model.coverage.turnsMissing > 0 &&
                          copy.turnsMissing(model.coverage.turnsMissing),
                        model.coverage.turnsShort > 0 &&
                          copy.turnsShort(model.coverage.turnsShort),
                        model.coverage.unreadableRecords > 0 &&
                          copy.unreadable(model.coverage.unreadableRecords),
                      ].filter((part): part is string => typeof part === 'string'),
                    )}
                  </span>
                </p>
              )}

              <ol className="maka-inspector-turns">
                {model.turns.map((turn) => (
                  <TurnRow key={turn.turnId} turn={turn} copy={copy} />
                ))}
              </ol>
            </VStack>
          </div>
        )}
      </VStack>
    </Section>
  );
}

/**
 * The glance layer: three figures, then the window.
 *
 * What survived a pass over "who reads this number, and to decide what":
 *
 * - Cost, duration and cache hit rate are the three a reader opens the tab
 *   for, and as figures rather than table rows they also give the column
 *   something to fill. They open the panel with nothing over them: a heading
 *   above a 20px figure is a caption ranking below what it captions, and a
 *   StatCell's own label already does that job at the right size.
 * - The context bar stays, because it is the only thing here that answers a
 *   question about NOW rather than about the past.
 *
 * What went, and why nothing was lost:
 *
 * - The model name. It is not a measurement, it is the session's setup — the
 *   composer names the model you are about to use, and the timeline below
 *   names the model each call actually used, per call. A single title picking
 *   the most recent one repeated that and, in a session that switched models,
 *   was less true than the rows it sat over.
 * - Token totals and the reasoning split. Cost already prices the tokens, the
 *   bar already sizes the prompt, and the hit rate already reports the cache;
 *   `248,800 / 740` mostly restated how many turns there were. The exact
 *   counts live in the run ledger, which is where an audit belongs.
 * - The retry and compaction counts. Both are EVENTS, and the timeline below
 *   lists them — a retry as `×2` on the step that retried, a compaction as
 *   its own step. Counting them again up here was summarising a list that is
 *   already on screen.
 * - Model call count and last-activity. The count had no decision attached,
 *   and the timestamp is already on the session in the sidebar.
 */
function InspectorOverview(props: {
  copy: InspectorCopy;
  locale: UiLocale;
  totals: TraceTotals;
  overview: ReturnType<typeof deriveInspectorOverviewModel>;
}) {
  const { copy, overview, totals } = props;
  const formatNumber = numberFormatter(props.locale);
  const context = overview.context;

  return (
    <VStack gap={6} data-maka-contract="session-inspector-overview">
      {/* The figures open the panel with nothing above them. Every heading
          tried here ranked below the numbers it introduced, because a label
          over a 20px figure is exactly what a StatCell already is — the three
          cells label themselves. */}
      <dl className="maka-inspector-stats" data-maka-contract="session-inspector-stats">
        <StatCell label={copy.totals.cost} value={formatCost(totals.costUsd, copy.costUnavailable)} />
        <StatCell label={copy.totals.duration} value={formatDuration(totals.durationMs)} />
        {overview.cacheHitRate !== undefined && (
          <StatCell label={copy.overview.cacheHit} value={formatPercent(overview.cacheHitRate)} />
        )}
      </dl>

      {context && (
        <InspectorContextSection copy={copy} context={context} formatNumber={formatNumber} />
      )}
    </VStack>
  );
}

/**
 * One headline figure. A label small enough to stay out of the way over a
 * number big enough to be the thing the eye lands on — the inverse of a table
 * row, and the reason these three do not need a section heading to rank them.
 */
function StatCell(props: { label: string; value: ReactNode }) {
  return (
    <div className="maka-inspector-stat">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/**
 * One legend row: band, figure.
 *
 * The share column is gone — the bar IS the share, and the section readout
 * already states the one share that is not obvious by eye. Two right-aligned
 * number columns per row was what made this read as a spreadsheet; what is
 * left is name-left / number-right, the same skeleton as a step row, so the
 * whole panel scans on one rhythm.
 */
function FactRow(props: { label: string; value: ReactNode; swatch?: ReactNode }) {
  return (
    <div className="maka-inspector-grid-row">
      <dt>
        {props.swatch}
        {props.label}
      </dt>
      <dd className="maka-inspector-grid-value">{props.value}</dd>
    </div>
  );
}

/**
 * The context window as a band chart rather than a single fill.
 *
 * A one-value bar answers "how full", which is the smaller half of the
 * question; the half a reader acts on is "full of what". Only the split the
 * ledger actually carries is drawn — cache hit vs fresh prompt — and when the
 * provider reports no cache figure the prompt stays one band, because an
 * unreported cache is not a zero cache (#1679).
 *
 * The bands are decoration: the same numbers are read from the legend below,
 * which is why the track is `aria-hidden` and the legend is a real list.
 */
function InspectorContextSection(props: {
  copy: InspectorCopy;
  context: NonNullable<ReturnType<typeof deriveInspectorOverviewModel>['context']>;
  formatNumber: (value: number) => string;
}) {
  const { context, copy, formatNumber } = props;
  const level = context.ratio >= 0.9 ? 'error' : context.ratio >= 0.7 ? 'warning' : undefined;

  return (
    <VStack gap={2} data-maka-contract="session-inspector-context">
      <div className="maka-inspector-section-head" data-level={level}>
        <Heading level={3} className="maka-inspector-section-title">
          {copy.overview.context}
        </Heading>
        <span className="maka-inspector-section-readout">
          {formatNumber(context.usedTokens)} / {formatNumber(context.windowTokens)} ·{' '}
          {formatPercent(context.ratio)}
        </span>
      </div>

      <div className="maka-inspector-context-track" data-level={level} aria-hidden="true">
        {context.segments.map((segment) => (
          <span
            key={segment.kind}
            className="maka-inspector-context-band"
            data-segment={segment.kind}
            /* Grow-weighted rather than percentage-width so a prompt that
               overran its window still fills exactly one track. */
            style={{ flexGrow: segment.tokens }}
          />
        ))}
      </div>

      {/* The legend is the accessible copy of the bar, on the same grid as the
          session facts below — one reading rhythm across the whole overview. */}
      <dl className="maka-inspector-grid">
        {context.segments.map((segment) => (
          <FactRow
            key={segment.kind}
            label={copy.overview.segment[segment.kind]}
            swatch={
              <span
                className="maka-inspector-context-swatch"
                data-segment={segment.kind}
                data-level={level}
                aria-hidden="true"
              />
            }
            value={formatNumber(segment.tokens)}
          />
        ))}
      </dl>
    </VStack>
  );
}

function numberFormatter(locale: UiLocale): (value: number) => string {
  const formatter = new Intl.NumberFormat(uiLocaleToIntlLocale(locale));
  return (value) => formatter.format(value);
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * One turn, ranked.
 *
 * Three tiers and no fourth: which turn this is and whether it failed carry
 * full ink on the head line; what it cost in time and money trails the same
 * line in supporting grey because nobody reads it until the head line has
 * already caught them; the steps below are the detail you descend into.
 *
 * The failure is stated as red text rather than a filled Badge — a solid chip
 * out-shouts the turn label it qualifies, and the red dot on the rail has
 * already flagged the row from the margin.
 */
function TurnRow(props: { turn: InspectorTurnRow; copy: InspectorCopy }) {
  const { copy, turn } = props;
  return (
    <li
      className="maka-inspector-turn"
      data-maka-contract="session-inspector-turn"
      data-failed={turn.failed || undefined}
    >
      <div className="maka-inspector-turn-head">
        <Text type="label" className="maka-inspector-turn-label">
          {copy.turnLabel(turn.index)}
        </Text>
        {/* One phrase, not a label plus a raw code: `本轮失败 · tool_failed`
            said the same thing twice, once in engineering vocabulary. */}
        {turn.failed && (
          <span
            className="maka-inspector-turn-failure"
            data-maka-contract="session-inspector-turn-failed"
          >
            {copy.turnFailure(turn.failureCode ?? '')}
          </span>
        )}
        {/* Two tiers inside the meta, not one: the cost is what a reader
            compares down the column, the duration is the context around it.
            One grey for both made the whole right edge of the timeline read
            as a single texture. */}
        <span className="maka-inspector-turn-meta">
          {formatDuration(turn.durationMs)} ·{' '}
          <span className="maka-inspector-turn-cost">
            {formatCost(turn.totals.costUsd, copy.costUnavailable)}
          </span>
        </span>
      </div>
      <ol className="maka-inspector-steps">
        {turn.steps.map((step) => (
          <StepRow key={step.id} step={step} copy={copy} />
        ))}
      </ol>
    </li>
  );
}

/**
 * One step: what it was, then what qualifies it, then how long it took.
 *
 * The step's own cost is gone. It was the fourth number on a 12px line whose
 * first three already said more, and the turn above states the same money at
 * the level a reader can act on — nobody re-prices a single tool call.
 *
 * A recovery is the one qualifier that changes the reading of the row, so it
 * keeps its own tier; the retry count sits on the measurement side, where it
 * is a fact about the attempt rather than about the step. It is spelled out
 * rather than written `×2`, which is the attempts counter's own notation and
 * asks the reader to work out that one of them was a retry.
 */
function StepRow(props: { step: InspectorStepRow; copy: InspectorCopy }) {
  const { copy, step } = props;
  // A row names itself with whatever identity it has: a model, a tool, or —
  // for a compaction, an error, a permission prompt with no tool — its kind.
  const label = step.label ?? inspectorStepKindLabel(copy, step.kind);
  const qualifier =
    step.callKind !== undefined
      ? copy.callKind(step.callKind)
      : step.decision !== undefined
        ? copy.permissionDecision(step.decision)
        : step.detail;
  const meta = [
    step.retries !== undefined ? copy.retries(step.retries) : undefined,
    step.durationMs !== undefined ? formatDuration(step.durationMs) : undefined,
  ].filter(Boolean);

  return (
    <li
      className="maka-inspector-step"
      data-maka-contract="session-inspector-step"
      data-failed={step.failed || undefined}
    >
      <span className="maka-inspector-step-text">
        <span className="maka-inspector-step-label">{label}</span>
        {qualifier && <span className="maka-inspector-step-detail">{qualifier}</span>}
        {step.recovered && (
          <span className="maka-inspector-step-recovered">{copy.recoveredAs(step.recovered)}</span>
        )}
      </span>
      {meta.length > 0 && <span className="maka-inspector-step-meta">{meta.join(' · ')}</span>}
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * Absent cost renders as words, never as `$0.00`: the canonical record keeps
 * "nobody could price this" and "this was free" apart, and so does the panel.
 */
function formatCost(costUsd: number | undefined, unavailable: string): string {
  if (costUsd === undefined) return unavailable;
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}
