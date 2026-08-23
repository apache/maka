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

import { type ToolResultContent } from '@maka/core/events';
import { type UiLocale } from '@maka/core/ui-locale';
import { ICON_SIZE, Check, Copy } from '../icons.js';
import { useClipboardCopyFeedback } from '../clipboard-feedback.js';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { Button as UiButton } from '@astryxdesign/core';
import { cn } from '../ui.js';
import { formatBytes, formatDuration } from './preview-utils.js';
import { useUiLocale } from '../locale-context.js';
import { getToolActivityCopy } from './copy.js';

type ExploreAgentResult = Extract<ToolResultContent, { kind: 'explore_agent' }>;

export function ExploreAgentPreview(props: {
  result: ExploreAgentResult;
}) {
  const locale = useUiLocale();
  const copy = getToolActivityCopy(locale).agent;
  const { result } = props;
  const copyFeedback = useClipboardCopyFeedback();
  const {
    candidateFiles,
    matches,
    progress,
    evidence,
    resultSummary,
    terminalStatus,
    status,
    reportLines,
    notes,
    roots,
    queries,
    ignoredPaths,
    stoppingCondition,
    limitReasons,
    filesDiscovered,
    skippedSummary,
    duration,
    continuationReason,
    continuationText,
    copyPayloads,
  } = buildExploreAgentPreviewModel(result, locale);

  function copyButtonState(key: string, idleLabel: string, copiedAria: string) {
    const phase = copyFeedback.phaseFor(key);
    return {
      phase,
      disabled: copyFeedback.isPending,
      label: phase === 'pending'
        ? copy.copyState.pending
        : phase === 'copied'
          ? copy.copyState.copied
          : phase === 'failed'
            ? copy.copyState.failed
            : idleLabel,
      ariaLabel: phase === 'pending'
        ? copy.copyState.pendingAria(idleLabel)
        : phase === 'copied'
          ? copiedAria
          : phase === 'failed'
            ? copy.copyState.failedAria(idleLabel)
            : idleLabel,
    };
  }

  const summaryCopy = copyButtonState('summary', copy.copyButtons.summary.idle, copy.copyButtons.summary.copied);
  const continuationCopy = copyButtonState('continuation', copy.copyButtons.continuation.idle, copy.copyButtons.continuation.copied);
  const processCopy = copyButtonState('process', copy.copyButtons.process.idle, copy.copyButtons.process.copied);
  const evidenceCopy = copyButtonState('evidence', copy.copyButtons.evidence.idle, copy.copyButtons.evidence.copied);
  const reportCopy = copyButtonState('report', copy.copyButtons.report.idle, copy.copyButtons.report.copied);
  const candidateCopy = copyButtonState('candidate', copy.copyButtons.candidate.idle, copy.copyButtons.candidate.copied);
  const matchesCopy = copyButtonState('matches', copy.copyButtons.matches.idle, copy.copyButtons.matches.copied);

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'agent' }))} data-kind="explore_agent" data-ok={result.ok ? 'true' : 'false'}>
      <header className={previewVariants({ part: 'agent-head' })}>
        <strong>{redactSecrets(result.objective || copy.objectiveFallback)}</strong>
        <small>
          {status} · {copy.foundRead(filesDiscovered, result.filesInspected)} · {skippedSummary} · {formatBytes(result.bytesRead)}
          {limitReasons ? ` · ${copy.budgetLimited}` : ''}
          {continuationReason ? ` · ${copy.continuationSuggested(continuationReason)}` : ''}
          {duration ? ` · ${copy.duration(duration)}` : ''}
        </small>
        {resultSummary.length > 0 && (
          <div className={previewVariants({ part: 'agent-summary-line' })}>
            <small>{redactSecrets(resultSummary)}</small>
            <UiButton
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('summary', copyPayloads.summary)}
              isDisabled={summaryCopy.disabled}
              aria-label={summaryCopy.ariaLabel}
              aria-busy={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={summaryCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={summaryCopy.phase === 'failed' ? 'true' : undefined}
              icon={summaryCopy.phase === 'copied' ? <Check size={ICON_SIZE.meta} aria-hidden="true" /> : <Copy size={ICON_SIZE.meta} aria-hidden="true" />}
              label={summaryCopy.label}
            />
          </div>
        )}
        {continuationText.length > 0 && (
          <div className={previewVariants({ part: 'agent-actions' })} role="group" aria-label={copy.followupActionsAriaLabel}>
            <UiButton
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('continuation', copyPayloads.continuation)}
              isDisabled={continuationCopy.disabled}
              aria-label={continuationCopy.ariaLabel}
              aria-busy={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={continuationCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={continuationCopy.phase === 'failed' ? 'true' : undefined}
              tooltip={copy.continuationTitle}
              icon={continuationCopy.phase === 'copied' ? <Check size={ICON_SIZE.meta} aria-hidden="true" /> : <Copy size={ICON_SIZE.meta} aria-hidden="true" />}
              label={continuationCopy.label}
            />
          </div>
        )}
      </header>
      {!result.ok && (
        <div className={previewVariants({ part: 'agent-message' })} role="note">
          {redactSecrets(result.message ?? copy.incompleteFallback)}
        </div>
      )}
      <dl className={previewVariants({ part: 'agent-meta' })}>
        <div>
          <dt>{copy.detail.terminal}</dt>
          <dd>{terminalStatus}</dd>
        </div>
        <div>
          <dt>{copy.detail.foundRead}</dt>
          <dd>{filesDiscovered} / {copy.files(result.filesInspected)}</dd>
        </div>
        <div>
          <dt>{copy.detail.scope}</dt>
          <dd>{redactSecrets(roots)}</dd>
        </div>
        <div>
          <dt>{copy.detail.queries}</dt>
          <dd>{redactSecrets(queries)}</dd>
        </div>
        {ignoredPaths && (
          <div>
            <dt>{copy.detail.ignored}</dt>
            <dd>{redactSecrets(ignoredPaths)}</dd>
          </div>
        )}
        {stoppingCondition && (
          <div>
            <dt>{copy.detail.stopping}</dt>
            <dd>{redactSecrets(stoppingCondition)}</dd>
          </div>
        )}
        {limitReasons && (
          <div>
            <dt>{copy.detail.boundary}</dt>
            <dd>{redactSecrets(limitReasons)}</dd>
          </div>
        )}
        {continuationReason && (
          <div>
            <dt>{copy.detail.next}</dt>
            <dd>{copy.continuationSuggested(redactSecrets(continuationReason))}</dd>
          </div>
        )}
      </dl>
      {progress.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label={copy.section.process.ariaLabel}>
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>{copy.section.process.title}</strong>
            <UiButton
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('process', copyPayloads.process)}
              isDisabled={processCopy.disabled}
              aria-label={processCopy.ariaLabel}
              aria-busy={processCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={processCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={processCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={processCopy.phase === 'failed' ? 'true' : undefined}
              icon={processCopy.phase === 'copied' ? <Check size={ICON_SIZE.meta} aria-hidden="true" /> : <Copy size={ICON_SIZE.meta} aria-hidden="true" />}
              label={processCopy.label}
            />
          </div>
          <ul>
            {progress.map((item, index) => (
              <li key={`${index}:${item.slice(0, 24)}`}>
                <span>{redactSecrets(item)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {evidence.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label={copy.section.evidence.ariaLabel}>
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>{copy.section.evidence.title}</strong>
            <UiButton
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('evidence', copyPayloads.evidence)}
              isDisabled={evidenceCopy.disabled}
              aria-label={evidenceCopy.ariaLabel}
              aria-busy={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={evidenceCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={evidenceCopy.phase === 'failed' ? 'true' : undefined}
              icon={evidenceCopy.phase === 'copied' ? <Check size={ICON_SIZE.meta} aria-hidden="true" /> : <Copy size={ICON_SIZE.meta} aria-hidden="true" />}
              label={evidenceCopy.label}
            />
          </div>
          <ul>
            {evidence.map((item, index) => (
              <li key={`${item.path}:${item.line ?? 'file'}:${index}`}>
                <code>
                  {redactSecrets(item.path)}
                  {typeof item.line === 'number' ? `:${item.line}` : ''}
                </code>
                <small>
                  {redactSecrets(item.label)}
                  {typeof item.score === 'number' ? ` · ${copy.score(item.score)}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reportLines.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label={copy.section.report.ariaLabel}>
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>{copy.section.report.title}</strong>
            <UiButton
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('report', copyPayloads.report)}
              isDisabled={reportCopy.disabled}
              aria-label={reportCopy.ariaLabel}
              aria-busy={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={reportCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={reportCopy.phase === 'failed' ? 'true' : undefined}
              icon={reportCopy.phase === 'copied' ? <Check size={ICON_SIZE.meta} aria-hidden="true" /> : <Copy size={ICON_SIZE.meta} aria-hidden="true" />}
              label={reportCopy.label}
            />
          </div>
          <ul>
            {reportLines.map((line, index) => (
              <li key={`${index}:${line.slice(0, 24)}`}>
                <span>{redactSecrets(line)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {candidateFiles.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label={copy.section.candidates.ariaLabel}>
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>{copy.section.candidates.title}</strong>
            <UiButton
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('candidate', copyPayloads.candidate)}
              isDisabled={candidateCopy.disabled}
              aria-label={candidateCopy.ariaLabel}
              aria-busy={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={candidateCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={candidateCopy.phase === 'failed' ? 'true' : undefined}
              icon={candidateCopy.phase === 'copied' ? <Check size={ICON_SIZE.meta} aria-hidden="true" /> : <Copy size={ICON_SIZE.meta} aria-hidden="true" />}
              label={candidateCopy.label}
            />
          </div>
          <ul>
            {candidateFiles.map((file) => (
              <li key={file.path}>
                <code>{redactSecrets(file.path)}</code>
                <small>
                  {copy.score(file.score)}
                  {file.reasons.length > 0 ? ` · ${presentExploreAgentCandidateReasons(file.reasons, locale)}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {matches.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label={copy.section.matches.ariaLabel}>
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>{copy.section.matches.title}</strong>
            <UiButton
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('matches', copyPayloads.matches)}
              isDisabled={matchesCopy.disabled}
              aria-label={matchesCopy.ariaLabel}
              aria-busy={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={matchesCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={matchesCopy.phase === 'failed' ? 'true' : undefined}
              icon={matchesCopy.phase === 'copied' ? <Check size={ICON_SIZE.meta} aria-hidden="true" /> : <Copy size={ICON_SIZE.meta} aria-hidden="true" />}
              label={matchesCopy.label}
            />
          </div>
          <ul>
            {matches.map((match, index) => (
              <li key={`${match.path}:${match.line}:${index}`}>
                <code>{redactSecrets(match.path)}:{match.line}</code>
                <small>{redactSecrets(match.query)}</small>
                <p>{redactSecrets(match.snippet)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {notes.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label={copy.section.notes.ariaLabel}>
          <strong>{copy.section.notes.title}</strong>
          <ul>
            {notes.map((note, index) => (
              <li key={`${index}:${note.slice(0, 24)}`}>
                <span>{redactSecrets(note)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * @knipignore Consumed via dynamic `await import(uiModuleUrl)` from the built
 * dist in tool-activity-result-preview-contract.test.ts, which knip cannot
 * trace through the runtime module URL.
 */
export function buildExploreAgentCopyPayloads(result: ExploreAgentResult, locale: UiLocale = 'zh'): Record<'summary' | 'process' | 'evidence' | 'report' | 'candidate' | 'matches' | 'continuation', string> {
  return buildExploreAgentPreviewModel(result, locale).copyPayloads;
}

function buildExploreAgentPreviewModel(result: ExploreAgentResult, locale: UiLocale) {
  const copy = getToolActivityCopy(locale).agent;
  const candidateFiles = result.candidateFiles.slice(0, 8);
  const matches = result.matches.slice(0, 8);
  const processLines = Array.isArray(result.recentEvents) && result.recentEvents.length > 0
    ? result.recentEvents.slice(0, 20).map((event) => formatExploreAgentEvent(event, result.startedAt, locale))
    : (result.progress ?? []).slice(0, 12);
  const progress = processLines.slice(0, 6);
  const evidence = (result.evidence ?? []).slice(0, 6);
  const resultSummary = typeof result.summary === 'string' ? result.summary.trim() : '';
  const reportText = typeof result.report === 'string' ? result.report.trim() : '';
  const terminalStatus = presentExploreAgentTerminalStatus(result.terminalStatus, result.ok, result.partial === true, result.reason, locale);
  const status = result.ok
    ? copy.complete
    : result.reason === 'aborted' && result.partial === true
      ? copy.cancelledPartial
      : presentExploreAgentReason(result.reason, locale) ?? copy.incomplete;
  const reportLines = reportText.split('\n').filter((line) => line.trim().length > 0).slice(0, 8);
  const notes = result.notes.slice(0, 4);
  const roots = result.roots.length > 0 ? result.roots.join(', ') : '.';
  const queries = result.queries.length > 0 ? result.queries.join(', ') : copy.notSpecified;
  const ignoredPaths = Array.isArray(result.ignoredPaths) && result.ignoredPaths.length > 0
    ? result.ignoredPaths.join(', ')
    : '';
  const stoppingCondition = typeof result.stoppingCondition === 'string'
    ? result.stoppingCondition.trim()
    : '';
  const limitReasons = Array.isArray(result.limitReasons)
    ? result.limitReasons.map((reason) => presentExploreAgentLimitReason(reason, locale)).filter(Boolean).join(locale === 'en' ? ', ' : '、')
    : '';
  const filesDiscovered = typeof result.filesDiscovered === 'number' && Number.isFinite(result.filesDiscovered)
    ? Math.max(0, Math.floor(result.filesDiscovered))
    : result.filesInspected;
  const skippedSummary = result.sensitiveFilesSkipped && result.sensitiveFilesSkipped > 0
    ? copy.skipped(result.filesSkipped, result.sensitiveFilesSkipped)
    : copy.skipped(result.filesSkipped);
  const duration = formatDuration(result.durationMs);
  const summaryText = resultSummary.length > 0
    ? [
      `${copy.field.status}: ${status}`,
      `${copy.field.terminal}: ${terminalStatus}`,
      `${copy.field.objective}: ${result.objective || copy.objectiveFallback}`,
      `${copy.field.summary}: ${resultSummary}`,
      `${copy.field.scope}: ${roots}`,
      `${copy.field.queries}: ${queries}`,
      `${copy.field.foundRead}: ${filesDiscovered} / ${copy.files(result.filesInspected)}`,
      duration ? `${copy.field.duration}: ${duration}` : '',
      ignoredPaths ? `${copy.field.ignored}: ${ignoredPaths}` : '',
      stoppingCondition ? `${copy.field.stopping}: ${stoppingCondition}` : '',
      limitReasons ? `${copy.field.boundary}: ${limitReasons}` : '',
    ].filter((line) => line.length > 0).join('\n')
    : '';
  const processText = [
    summaryText,
    processLines.length > 0 ? `${copy.field.events}: ${processLines.length}` : '',
    processLines.join('\n'),
  ].filter((line) => line.trim().length > 0).join('\n').trim();
  const evidenceText = evidence.length > 0
    ? [
      `${copy.field.status}: ${status}`,
      `${copy.field.terminal}: ${terminalStatus}`,
      `${copy.field.objective}: ${result.objective || copy.objectiveFallback}`,
      `${copy.field.evidence}: ${evidence.length}`,
      ...evidence.map((item) => [
        `- ${item.path}${typeof item.line === 'number' ? `:${item.line}` : ''}`,
        item.label,
        typeof item.score === 'number' ? copy.score(item.score) : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const candidateText = candidateFiles.length > 0
    ? [
      `${copy.field.status}: ${status}`,
      `${copy.field.terminal}: ${terminalStatus}`,
      `${copy.field.objective}: ${result.objective || copy.objectiveFallback}`,
      `${copy.field.foundRead}: ${filesDiscovered} / ${copy.files(result.filesInspected)}`,
      `${copy.field.candidates}: ${candidateFiles.length}`,
      ...candidateFiles.map((file) => [
        `- ${file.path}`,
        copy.score(file.score),
        file.reasons.length > 0 ? presentExploreAgentCandidateReasons(file.reasons, locale) : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const matchesText = matches.length > 0
    ? [
      `${copy.field.status}: ${status}`,
      `${copy.field.terminal}: ${terminalStatus}`,
      `${copy.field.objective}: ${result.objective || copy.objectiveFallback}`,
      `${copy.field.queries}: ${queries}`,
      `${copy.field.matches}: ${matches.length}`,
      ...matches.map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
    ].join('\n')
    : '';
  const needsContinuation =
    result.partial === true ||
    !result.ok ||
    Boolean(limitReasons) ||
    result.terminalStatus === 'completed_empty';
  const continuationReason = needsContinuation
    ? presentExploreAgentContinuationReason({
      partial: result.partial === true,
      ok: result.ok,
      hasLimitReasons: Boolean(limitReasons),
      terminalStatus: result.terminalStatus,
    }, locale)
    : '';
  const continuationText = needsContinuation
    ? [
      copy.continuationIntro,
      continuationReason ? `${copy.field.continuationReason}: ${continuationReason}` : '',
      `${copy.field.previousStatus}: ${status}`,
      `${copy.field.previousTerminal}: ${terminalStatus}`,
      `${copy.field.objective}: ${result.objective || copy.objectiveFallback}`,
      `${copy.field.scope}: ${roots}`,
      `${copy.field.queries}: ${queries}`,
      `${copy.field.foundRead}: ${filesDiscovered} / ${copy.files(result.filesInspected)}`,
      duration ? `${copy.field.previousDuration}: ${duration}` : '',
      ignoredPaths ? `${copy.field.ignored}: ${ignoredPaths}` : '',
      stoppingCondition ? `${copy.field.stopping}: ${stoppingCondition}` : '',
      limitReasons ? `${copy.field.previousBoundary}: ${limitReasons}` : '',
      resultSummary ? `${copy.field.previousSummary}: ${resultSummary}` : '',
      candidateFiles.length > 0
        ? [
          copy.continuationCandidates,
          ...candidateFiles.slice(0, 5).map((file) => `- ${file.path} (${copy.score(file.score)})`),
        ].join('\n')
        : '',
      matches.length > 0
        ? [
          copy.continuationMatches,
          ...matches.slice(0, 5).map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
        ].join('\n')
        : '',
      copy.continuationOutro,
    ].filter((line) => line.trim().length > 0).join('\n')
    : '';
  const copyPayloads = {
    summary: redactSecrets(summaryText),
    process: redactSecrets(processText),
    evidence: redactSecrets(evidenceText),
    report: redactSecrets(reportText),
    candidate: redactSecrets(candidateText),
    matches: redactSecrets(matchesText),
    continuation: redactSecrets(continuationText),
  };

  return {
    candidateFiles,
    matches,
    progress,
    evidence,
    resultSummary,
    reportLines,
    notes,
    roots,
    queries,
    ignoredPaths,
    stoppingCondition,
    limitReasons,
    filesDiscovered,
    skippedSummary,
    duration,
    terminalStatus,
    status,
    continuationReason,
    continuationText,
    copyPayloads,
  };
}

function presentExploreAgentTerminalStatus(
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'],
  ok: boolean,
  partial: boolean,
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
  locale: UiLocale,
): string {
  const copy = getToolActivityCopy(locale).agent;
  switch (terminalStatus) {
    case 'completed':
      return copy.terminalStatus.completed;
    case 'completed_empty':
      return copy.terminalStatus.completed_empty;
    case 'failed':
      return copy.terminalStatus.failed;
    case 'canceled':
      return copy.terminalStatus.canceled;
    case 'canceled_partial':
      return copy.terminalStatus.canceled_partial;
    case undefined:
      if (reason === 'aborted' && partial) return copy.terminalStatus.canceled_partial;
      if (reason === 'aborted') return copy.terminalStatus.canceled;
      if (!ok) return copy.terminalStatus.failed;
      return copy.complete;
    default:
      return copy.terminalStatus.unknown;
  }
}

function presentExploreAgentReason(
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
  locale: UiLocale,
): string | undefined {
  const copy = getToolActivityCopy(locale).agent.reason;
  switch (reason) {
    case 'invalid_objective':
      return copy.invalid_objective;
    case 'invalid_root':
      return copy.invalid_root;
    case 'no_readable_roots':
      return copy.no_readable_roots;
    case 'aborted':
      return copy.aborted;
    case undefined:
      return undefined;
    default:
      return copy.unknown;
  }
}

function presentExploreAgentLimitReason(reason: string, locale: UiLocale): string {
  const copy = getToolActivityCopy(locale).agent.limitReason;
  switch (reason) {
    case 'candidate_budget':
      return copy.candidate_budget;
    case 'file_budget':
      return copy.file_budget;
    case 'match_budget':
      return copy.match_budget;
    case 'byte_budget':
      return copy.byte_budget;
    default:
      return '';
  }
}

function presentExploreAgentContinuationReason(input: {
  partial: boolean;
  ok: boolean;
  hasLimitReasons: boolean;
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'];
}, locale: UiLocale): string {
  const copy = getToolActivityCopy(locale).agent.continuationReason;
  if (input.partial) return copy.partial;
  if (!input.ok) return copy.failed;
  if (input.hasLimitReasons) return copy.budget;
  if (input.terminalStatus === 'completed_empty') return copy.empty;
  return copy.missing;
}

function formatExploreAgentEvent(event: { type: string; message: string; at?: number }, startedAt: number | undefined, locale: UiLocale): string {
  const label = presentExploreAgentEventType(event.type, locale);
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  const offset = formatExploreAgentEventOffset(event.at, startedAt);
  const prefix = [label, offset].filter(Boolean).join(' ');
  return prefix ? `${prefix}：${message}` : message;
}

function formatExploreAgentEventOffset(at: number | undefined, startedAt: number | undefined): string {
  if (typeof at !== 'number' || typeof startedAt !== 'number') return '';
  if (!Number.isFinite(at) || !Number.isFinite(startedAt)) return '';
  const delta = Math.max(0, Math.floor(at - startedAt));
  const formatted = formatDuration(delta);
  return formatted ? `+${formatted}` : '';
}

function presentExploreAgentEventType(type: string, locale: UiLocale): string {
  const copy = getToolActivityCopy(locale).agent.eventType;
  switch (type) {
    case 'started':
      return copy.started;
    case 'scope_resolved':
      return copy.scope_resolved;
    case 'scan':
      return copy.scan;
    case 'read':
      return copy.read;
    case 'checkpoint':
      return copy.checkpoint;
    case 'completed':
      return copy.completed;
    case 'failed':
      return copy.failed;
    case 'aborted':
      return copy.aborted;
    default:
      return '';
  }
}

function presentExploreAgentCandidateReasons(reasons: string[], locale: UiLocale): string {
  const copy = getToolActivityCopy(locale).agent;
  return reasons.map((reason) => {
    if (reason in copy.candidateReason && reason !== 'fallback') return copy.candidateReason[reason as Exclude<keyof typeof copy.candidateReason, 'fallback'>];
    const pathMatch = reason.match(/^path contains "(.+)"$/);
    if (pathMatch) return copy.pathMatch(redactSecrets(pathMatch[1] ?? ''));
    return copy.candidateReason.fallback;
  }).join(', ');
}
