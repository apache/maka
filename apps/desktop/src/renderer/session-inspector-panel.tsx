/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { uiLocaleToIntlLocale, type UiLocale } from '@maka/core/ui-locale';
import { traceTurnIdentityKey } from '@maka/core/session-trace';
import { useToast, useUiLocale } from '@maka/ui';
import { ICON_SIZE, Activity, AlertTriangle, Copy } from '@maka/ui/icons';
import {
  getDesktopConversationCopy,
  type InspectorCopy,
  inspectorStepKindLabel,
} from './locales/conversation-copy.js';
import {
  deriveInspectorOverviewModel,
  estimatedSessionCost,
  hasUnavailableSessionUsage,
} from './session-inspector-overview-model.js';
import {
  deriveInspectorPanelModel,
  type InspectorStepRow,
  type InspectorTurnRow,
} from './session-inspector-panel-model.js';
import { useSessionTrace } from './use-session-trace.js';

/**
 * The record file is the workspace's operational-state database — the file
 * both trace ledgers live in. Its exact path is resolved once, in main
 * (`app:info.operationalStateDatabasePath` via @maka/storage's
 * `resolveOperationalStateDatabasePath`); the renderer cannot import that
 * package at runtime (it pulls node:sqlite into the browser bundle), and
 * recomputing the path here would create a second authority. The row only
 * displays and copies the value it receives.
 */

/**
 * Split a record-file path for display only: `dir` is everything before the
 * last separator (both platform separators, since the path came from main and
 * may be POSIX or Windows), `name` is the filename. The name is never
 * truncated by the row's ellipsis; the dir is. The full path is not rebuilt
 * here — the row shows exactly the parts of the value it received.
 */
function splitRecordFileDisplayPath(path: string): { dir: string; name: string } {
  const separatorIndex = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (separatorIndex === -1) return { dir: '', name: path };
  return { dir: path.slice(0, separatorIndex + 1), name: path.slice(separatorIndex + 1) };
}

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
  const toast = useToast();
  const snapshot = useSessionTrace(props.sessionId, props.active, {
    loadFailed: copy.loadFailed,
    locale,
  });
  const model = useMemo(() => deriveInspectorPanelModel(snapshot.trace), [snapshot.trace]);
  const overview = useMemo(
    () => deriveInspectorOverviewModel(snapshot.context, snapshot.summary),
    [snapshot.context, snapshot.summary],
  );

  // The record file is a fact about the workspace, not about the session's
  // activity: it exists whether the trace is empty or not, and it never
  // changes while the app is running. `app:info` resolves the exact database
  // path in main (the same value the data-settings row shows), so the row has
  // no second authority and no separator guessing. Read once on mount —
  // before the user can open the tab — so the row is already painted when the
  // trace lands and the banner never shifts; a failure hides the row — it is
  // auxiliary, and a path that will not load should not masquerade as a trace
  // that failed to read.
  const [recordFile, setRecordFile] = useState<string | undefined>();
  useEffect(() => {
    if (recordFile !== undefined) return;
    let mounted = true;
    void window.maka.app
      .info()
      .then((info) => {
        if (mounted) {
          setRecordFile(info.operationalStateDatabasePath);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [recordFile]);

  async function copyRecordFile() {
    if (!recordFile) return;
    try {
      await navigator.clipboard.writeText(recordFile);
      toast.success(copy.pathCopied);
    } catch {
      toast.error(copy.copyFailed, copy.copyFailedDetail);
    }
  }

  async function copyPricingKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      toast.success(copy.pricingKeyCopied, key);
    } catch {
      toast.error(copy.copyFailed, copy.copyFailedDetail);
    }
  }

  // The path is split for display only — the directory part truncates while
  // the filename never does, so a narrow panel still says which file the row
  // is about. The full path stays the tooltip and clipboard value, and the
  // authoritative string is the one `app:info` returned.
  const pathParts = recordFile ? splitRecordFileDisplayPath(recordFile) : undefined;
  return (
    <Section
      variant="transparent"
      padding={4}
      className="maka-inspector-panel"
      data-maka-contract="session-inspector"
      aria-label={copy.ariaLabel}
      aria-busy={snapshot.loading || snapshot.summaryLoading || undefined}
    >
      {/* 24px between blocks against 8px inside one: proximity is the only
          grouping tool a panel without boxes has, and it used to spend the
          same 16px on "these are two parts of one block" and "this is a
          different block". */}
      <VStack gap={6} height="100%">
        {recordFile && pathParts && (
          <HStack
            gap={2}
            vAlign="center"
            className="maka-inspector-record-file-row"
            data-maka-contract="session-inspector-record-file"
            data-full-path={recordFile}
          >
            <Text type="label" color="secondary" className="maka-inspector-record-file-label">
              {copy.recordFile}
            </Text>
            <Tooltip content={recordFile}>
              {/* Keyboard-reachable tooltip trigger: the row is one Tab stop,
                  the tooltip opens on focus-visible and dismisses on Escape,
                  and the full path never depends on the tooltip alone (it is
                  the visible filename and the clipboard value too). */}
              <HStack
                gap={1}
                vAlign="center"
                className="maka-inspector-record-file"
                tabIndex={0}
              >
                <Text type="supporting" className="maka-inspector-record-file-dir">
                  {pathParts.dir}
                </Text>
                <Text type="supporting" className="maka-inspector-record-file-name">
                  {pathParts.name}
                </Text>
              </HStack>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy size={ICON_SIZE.control} aria-hidden="true" />}
              label={copy.copyPath}
              onClick={() => {
                void copyRecordFile();
              }}
            />
          </HStack>
        )}
        {snapshot.error && (
          <Banner
            status="error"
            title={snapshot.error}
            endContent={
              <Button variant="ghost" size="sm" label={copy.retry} onClick={snapshot.retry} />
            }
          />
        )}

        {/* A session that did nothing is not the same silence as a read that
            failed in the Banner above. */}
        <div
          role="status"
          aria-live="polite"
          className="maka-inspector-status"
          data-empty={model.empty || undefined}
        >
          {model.empty && !snapshot.nextCursor && !snapshot.loading && !snapshot.error && (
            <EmptyState
              title={copy.empty}
              description={copy.emptyHelp}
              icon={<Activity size={ICON_SIZE.empty} aria-hidden="true" />}
            />
          )}
        </div>

        {snapshot.loading && !snapshot.trace && (
          <Text type="supporting" color="secondary">
            {copy.loadingTrace}
          </Text>
        )}

        {/* Usage and context answer to different owners, so a successful
            snapshot beside an empty or failed trace remains visible (#2323). */}
        {snapshot.summaryLoading && (
          <Text type="supporting" color="secondary">
            {copy.loadingSummary}
          </Text>
        )}
        {snapshot.summaryError && !snapshot.summary && (
          <Text type="supporting" color="secondary">
            {copy.summaryUnavailable}
          </Text>
        )}
        {snapshot.summary && hasUnavailableSessionUsage(snapshot.summary) && (
          <Text type="supporting" color="secondary">
            {copy.summaryUnavailable}
          </Text>
        )}
        {(snapshot.summary || overview.context || overview.composition) && (
          <InspectorOverview
            copy={copy}
            locale={locale}
            summary={snapshot.summary}
            overview={overview}
            showTotals={Boolean(snapshot.summary && snapshot.summary.totalRequests > 0)}
          />
        )}

        {(!model.empty || snapshot.nextCursor) && (
          <div className="maka-inspector-raw" data-maka-contract="session-inspector-raw">
            <VStack gap={2}>
              <div className="maka-inspector-section-head">
                <Heading level={3} className="maka-inspector-section-title">
                  {copy.overview.timelineTab}
                </Heading>
              </div>

              {model.coverage && (
                <p
                  className="maka-inspector-coverage-note"
                  data-maka-contract="session-inspector-coverage"
                >
                  <AlertTriangle size={ICON_SIZE.control} aria-hidden="true" />
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
                        model.coverage.oversizedRuns > 0 &&
                          copy.oversizedRuns(model.coverage.oversizedRuns),
                      ].filter((part): part is string => typeof part === 'string'),
                    )}
                  </span>
                </p>
              )}

              {snapshot.nextCursor && (
                <Button
                  variant="ghost"
                  size="sm"
                  label={snapshot.loadingEarlier ? copy.loadingEarlier : copy.loadEarlier}
                  isDisabled={snapshot.loading || snapshot.loadingEarlier}
                  onClick={snapshot.loadEarlier}
                />
              )}
              <ol className="maka-inspector-turns">
                {model.turns.map((turn) => (
                  <TurnRow
                    key={traceTurnIdentityKey(turn)}
                    turn={turn}
                    copy={copy}
                    locale={locale}
                    onCopyPricingKey={copyPricingKey}
                  />
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
 * The glance layer: two figures, then the window.
 *
 * What survived a pass over "who reads this number, and to decide what":
 *
 * - Cost and cache hit rate are the Session-wide figures a reader opens the tab
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
  summary: ReturnType<typeof useSessionTrace>['summary'];
  overview: ReturnType<typeof deriveInspectorOverviewModel>;
  /** Session-usage figures; absent when no recorded request can support them. */
  showTotals: boolean;
}) {
  const { copy, overview } = props;
  const formatNumber = numberFormatter(props.locale);
  const context = overview.context;

  return (
    <VStack gap={6} data-maka-contract="session-inspector-overview">
      {/* The figures open the panel with nothing above them. Every heading
          tried here ranked below the numbers it introduced, because a label
          over a 20px figure is exactly what a StatCell already is — the three
          cells label themselves. */}
      {props.showTotals && (
        <>
          <dl className="maka-inspector-stats" data-maka-contract="session-inspector-stats">
            <StatCell
              label={copy.totals.cost}
              value={formatCost(estimatedSessionCost(props.summary), copy.costUnavailable)}
            />
            {overview.cacheHitRate !== undefined && (
              <StatCell label={copy.overview.cacheHit} value={formatPercent(overview.cacheHitRate)} />
            )}
          </dl>
          <Text type="supporting" color="secondary">
            {copy.costEstimateHelp}
          </Text>
        </>
      )}

      {context && (
        <InspectorContextSection copy={copy} context={context} formatNumber={formatNumber} />
      )}

      {overview.composition && (
        <InspectorCompositionSection
          copy={copy}
          state={overview.composition}
          formatNumber={formatNumber}
        />
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
function FactRow(props: { label: ReactNode; value: ReactNode; swatch?: ReactNode }) {
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

/**
 * What filled the context, under the bar that says how full it is (#2323).
 *
 * A separate block rather than bands inside that bar, and the separation is the
 * point: the bar's numbers are provider-reported tokens summing to the metered
 * prompt, these are estimates over serialized bytes summing to the request. One
 * track holding both would present the estimate as a decomposition of the
 * reported figure — the confusion #1679 exists to prevent — so the heading says
 * estimate, the basis line says what the unit is, and every figure carries `≈`.
 *
 * Tools are listed by name because that is the only row a reader can act on:
 * "tool definitions ≈ 40%" names nothing to remove.
 */
function InspectorCompositionSection(props: {
  copy: InspectorCopy;
  state: NonNullable<ReturnType<typeof deriveInspectorOverviewModel>['composition']>;
  formatNumber: (value: number) => string;
}) {
  const { copy, formatNumber, state } = props;
  const labels = copy.overview.composition;
  const estimate = (tokens: number) => `≈${formatNumber(tokens)}`;

  return (
    <VStack gap={2} data-maka-contract="session-inspector-composition">
      <div className="maka-inspector-section-head">
        <Heading level={3} className="maka-inspector-section-title">
          {labels.title}
        </Heading>
      </div>
      <p className="maka-inspector-section-note">{labels.basis}</p>

      {state.status === 'unrecorded' ? (
        // Stated, not hidden: a metered call whose capture never landed is a
        // gap in what the reader can see, and an absent section would read as
        // "nothing to explain" instead.
        <p className="maka-inspector-section-note">{labels.unrecorded}</p>
      ) : (
        <>
          <dl className="maka-inspector-grid">
            {state.composition.parts.map((part) => (
              <FactRow
                key={part.kind}
                label={labels.part[part.kind]}
                value={estimate(part.estimatedTokens)}
              />
            ))}
          </dl>

          {/* Gated on either, not on the named list alone: a session recorded
              before tools carried a name has bytes and no names, and that is
              exactly when the unnamed row is the only thing to show. */}
          {(state.composition.tools.length > 0 || state.composition.unlabelledTools) && (
            <>
              <Heading level={4} className="maka-inspector-section-subtitle">
                {labels.tools}
              </Heading>
              <dl className="maka-inspector-grid">
                {state.composition.tools.map((tool) => (
                  <FactRow
                    key={tool.name}
                    label={<span className="maka-inspector-composition-name">{tool.name}</span>}
                    value={estimate(tool.estimatedTokens)}
                  />
                ))}
                {state.composition.remainingTools && (
                  <FactRow
                    label={labels.remainingTools(state.composition.remainingTools.count)}
                    value={estimate(state.composition.remainingTools.estimatedTokens)}
                  />
                )}
                {state.composition.unlabelledTools && (
                  <FactRow
                    label={labels.unlabelled}
                    value={estimate(state.composition.unlabelledTools.estimatedTokens)}
                  />
                )}
              </dl>
            </>
          )}
        </>
      )}
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
function TurnRow(props: {
  turn: InspectorTurnRow;
  copy: InspectorCopy;
  locale: UiLocale;
  onCopyPricingKey: (key: string) => void | Promise<void>;
}) {
  const { copy, turn } = props;
  return (
    <li
      className="maka-inspector-turn"
      data-maka-contract="session-inspector-turn"
      data-failed={turn.failed || undefined}
    >
      <div className="maka-inspector-turn-head">
        <Text type="label" className="maka-inspector-turn-label">
          {copy.turnLabel(formatTurnStartedAt(turn.startedAt, props.locale))}
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
            {formatCost(turn.costUsd, copy.costUnavailable)}
          </span>
        </span>
      </div>
      <ol className="maka-inspector-steps">
        {turn.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            copy={copy}
            onCopyPricingKey={props.onCopyPricingKey}
          />
        ))}
      </ol>
    </li>
  );
}

function formatTurnStartedAt(startedAt: number, locale: UiLocale): string {
  const date = new Date(startedAt);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
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
function StepRow(props: {
  step: InspectorStepRow;
  copy: InspectorCopy;
  onCopyPricingKey: (key: string) => void | Promise<void>;
}) {
  const { copy, step } = props;
  const pricingKey = step.unpricedPricingKey;
  // A row names itself with whatever identity it has: a model, a tool, or —
  // for a compaction, an error, a permission prompt with no tool — its kind.
  const label = step.label ?? inspectorStepKindLabel(copy, step.kind);
  const qualifier = [
    step.callKind !== undefined ? copy.callKind(step.callKind) : undefined,
    step.decision !== undefined ? copy.permissionDecision(step.decision) : undefined,
    step.detail,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
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
        {pricingKey && (
          <span className="maka-inspector-pricing-key">
            <span>{copy.unpricedPricingKey}</span>
            <code>{pricingKey}</code>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy size={14} aria-hidden="true" />}
              label={`${copy.copyPricingKey}: ${pricingKey}`}
              onClick={() => {
                void props.onCopyPricingKey(pricingKey);
              }}
            >
              {copy.copyPricingKey}
            </Button>
          </span>
        )}
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
