import type {
  FixedPromptTaskWalEvent,
  PromptCandidateFailurePattern,
  PromptCandidateRationale,
  RsiPredictedFixOutcome,
  RsiRiskTaskOutcome,
  RsiRootCauseSignalMatch,
} from './fixed-prompt-wal-types.js';
import type { PromptAcceptanceResult } from './prompt-acceptance-policy.js';
import type { RsiRoundAnalysis, RsiTaskOutcome, RsiTaskTransition } from './rsi-round-analysis.js';

export type {
  RsiPredictedFixOutcome,
  RsiRiskTaskOutcome,
  RsiRootCauseSignalMatch,
} from './fixed-prompt-wal-types.js';

export interface RsiControllerAttribution {
  runId: string;
  roundId: string;
  candidateCommitSha: string;
  heldInTaskSetHash: string;
  candidateRationaleHash: string;
  evidenceRefs: string[];
  predictedFixes: Array<{ taskId: string; outcome: RsiPredictedFixOutcome }>;
  riskTasks: Array<{ taskId: string; outcome: RsiRiskTaskOutcome }>;
  unexpectedHeldInFlips: RsiTaskTransition[];
  decision: {
    decision: PromptAcceptanceResult['decision'];
    reason: PromptAcceptanceResult['reason'];
  };
  rootCauseSignalMatch: RsiRootCauseSignalMatch;
}

export interface RsiPromptAttribution {
  predictedFixes: ReadonlyArray<{ taskId: string; outcome: RsiPredictedFixOutcome }>;
  riskTasks: ReadonlyArray<{ taskId: string; outcome: RsiRiskTaskOutcome }>;
  unexpectedHeldInFlips: ReadonlyArray<{ taskId: string; from: string; to: string }>;
  rootCauseSignalMatch: RsiRootCauseSignalMatch;
}

export type ProjectRsiPromptAttributionInput = RsiPromptAttribution;

export interface RsiControllerAttributionValidationTarget {
  evidenceRefs: readonly string[];
  predictedFixes: ReadonlyArray<{ taskId: string; outcome: RsiPredictedFixOutcome }>;
  riskTasks: ReadonlyArray<{ taskId: string; outcome: RsiRiskTaskOutcome }>;
  unexpectedHeldInFlips: ReadonlyArray<{ taskId: string; from: string; to: string }>;
  decision: {
    decision: PromptAcceptanceResult['decision'];
    reason: string;
  };
  rootCauseSignalMatch: RsiRootCauseSignalMatch;
}

export interface RsiControllerAttributionValidationInput {
  attribution: RsiControllerAttributionValidationTarget;
  candidateRationale: PromptCandidateRationale;
  heldInTaskIds: readonly string[];
  decision: {
    decision: PromptAcceptanceResult['decision'];
    reason: string;
  };
}

export interface RsiControllerAttributionValidation {
  malformed: boolean;
  outOfScope: boolean;
}

export interface BuildRsiControllerAttributionInput {
  runId: string;
  roundId: string;
  candidateCommitSha: string;
  candidateRationaleHash: string;
  candidateRationale: PromptCandidateRationale;
  promptTimeAnalysis?: RsiRoundAnalysis;
  analysis: RsiRoundAnalysis;
  heldInTaskIds: readonly string[];
  lastKeptEvents: readonly FixedPromptTaskWalEvent[];
  candidateEvents: readonly FixedPromptTaskWalEvent[];
  decision: PromptAcceptanceResult;
}

export function buildRsiControllerAttribution(
  input: BuildRsiControllerAttributionInput,
): RsiControllerAttribution {
  const heldInTaskIds = [...new Set(input.heldInTaskIds)].sort(compareStrings);
  const heldIn = new Set(heldInTaskIds);
  const previous = eventsByTask(input.lastKeptEvents, heldIn);
  const current = eventsByTask(input.candidateEvents, heldIn);
  const predictedFixes = sortedUnique(input.candidateRationale.predictedFixes).map((taskId) => ({
    taskId,
    outcome: predictedFixOutcome(
      taskOutcome(previous.get(taskId)),
      taskOutcome(current.get(taskId)),
    ),
  }));
  const riskTasks = sortedUnique(input.candidateRationale.riskTasks).map((taskId) => ({
    taskId,
    outcome: riskTaskOutcome(taskOutcome(previous.get(taskId)), taskOutcome(current.get(taskId))),
  }));
  const predictedOrRisk = new Set([
    ...input.candidateRationale.predictedFixes,
    ...input.candidateRationale.riskTasks,
  ]);
  return {
    runId: input.runId,
    roundId: input.roundId,
    candidateCommitSha: input.candidateCommitSha,
    heldInTaskSetHash: input.analysis.heldInTaskSetHash,
    candidateRationaleHash: input.candidateRationaleHash,
    evidenceRefs: sortedUnique(input.candidateRationale.evidenceRefs),
    predictedFixes,
    riskTasks,
    unexpectedHeldInFlips: input.analysis.transitionVsLastKept.filter(
      (transition) => heldIn.has(transition.taskId) && !predictedOrRisk.has(transition.taskId),
    ),
    decision: {
      decision: input.decision.decision,
      reason: input.decision.reason,
    },
    rootCauseSignalMatch: rootCauseSignalMatch(
      input.candidateRationale,
      input.promptTimeAnalysis ?? input.analysis,
    ),
  };
}

export function projectRsiPromptAttribution(
  attribution: ProjectRsiPromptAttributionInput,
): RsiPromptAttribution {
  return {
    predictedFixes: attribution.predictedFixes.map(({ taskId, outcome }) => ({ taskId, outcome })),
    riskTasks: attribution.riskTasks.map(({ taskId, outcome }) => ({ taskId, outcome })),
    unexpectedHeldInFlips: attribution.unexpectedHeldInFlips.map(({ taskId, from, to }) => ({
      taskId,
      from,
      to,
    })),
    rootCauseSignalMatch: attribution.rootCauseSignalMatch,
  };
}

export function validateRsiControllerAttribution(
  input: RsiControllerAttributionValidationInput,
): RsiControllerAttributionValidation {
  const attribution = input.attribution;
  const outOfScope = rsiControllerAttributionOutOfScope(attribution, input.heldInTaskIds);
  const malformed =
    !sameStringSet(attribution.evidenceRefs, input.candidateRationale.evidenceRefs) ||
    !sameStringSet(
      attribution.predictedFixes.map((item) => item.taskId),
      input.candidateRationale.predictedFixes,
    ) ||
    !sameStringSet(
      attribution.riskTasks.map((item) => item.taskId),
      input.candidateRationale.riskTasks,
    ) ||
    attribution.decision.decision !== input.decision.decision ||
    attribution.decision.reason !== input.decision.reason ||
    hasUnsafePromptAttributionProjection(attribution);
  return { malformed, outOfScope };
}

function rsiControllerAttributionOutOfScope(
  attribution: RsiControllerAttributionValidationTarget,
  heldInTaskIds: readonly string[],
): boolean {
  const heldIn = new Set(heldInTaskIds);
  const taskIds = [
    ...attribution.predictedFixes.map((item) => item.taskId),
    ...attribution.riskTasks.map((item) => item.taskId),
    ...attribution.unexpectedHeldInFlips.map((item) => item.taskId),
  ];
  return taskIds.some((taskId) => !heldIn.has(taskId));
}

function hasUnsafePromptAttributionProjection(
  attribution: RsiControllerAttributionValidationTarget,
): boolean {
  const projection = projectRsiPromptAttribution(attribution);
  const allowedFields = new Set([
    'predictedFixes',
    'riskTasks',
    'unexpectedHeldInFlips',
    'rootCauseSignalMatch',
  ]);
  if (Object.keys(projection).some((field) => !allowedFields.has(field))) return true;
  return /decisionReason|held[-_ ]?out|coverage_regressed|held_out_regressed/i.test(
    JSON.stringify(projection),
  );
}

function eventsByTask(
  events: readonly FixedPromptTaskWalEvent[],
  heldIn: ReadonlySet<string>,
): Map<string, FixedPromptTaskWalEvent> {
  const byTask = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of events) {
    if (heldIn.has(event.taskId)) byTask.set(event.taskId, event);
  }
  return byTask;
}

function predictedFixOutcome(from: RsiTaskOutcome, to: RsiTaskOutcome): RsiPredictedFixOutcome {
  if (to === 'missing') return 'missing';
  if (to === 'unscored' || to === 'infra' || to === 'budget' || to === 'plumbing')
    return 'unscored';
  if (score(to) > score(from)) return 'improved';
  if (score(to) < score(from)) return 'regressed';
  return 'unchanged';
}

function riskTaskOutcome(from: RsiTaskOutcome, to: RsiTaskOutcome): RsiRiskTaskOutcome {
  if (to === 'missing') return 'missing';
  if (to === 'unscored' || to === 'infra' || to === 'budget' || to === 'plumbing')
    return 'unscored';
  return score(to) < score(from) ? 'regressed' : 'safe';
}

function taskOutcome(event: FixedPromptTaskWalEvent | undefined): RsiTaskOutcome {
  if (!event) return 'missing';
  if (event.type === 'task_infra_failed') return 'infra';
  if (event.type === 'task_budget_exhausted') return 'budget';
  if (event.type === 'task_plumbing_failed') return 'plumbing';
  if (!event.eligible || !event.scored) return 'unscored';
  return event.passed ? 'pass' : 'fail';
}

function score(outcome: RsiTaskOutcome): number {
  return outcome === 'pass' ? 1 : 0;
}

function rootCauseSignalMatch(
  rationale: PromptCandidateRationale,
  analysis: RsiRoundAnalysis,
): RsiRootCauseSignalMatch {
  if (rationale.evidenceRefs.length === 0) return 'unknown';
  const referenced = new Set(rationale.evidenceRefs);
  const referencedSignals = analysis.signals.filter((signal) => referenced.has(signal.id));
  if (typeof rationale.failurePattern === 'undefined') {
    return referencedSignals.length > 0 ? 'matched' : 'unknown';
  }
  const signalKinds = new Set(referencedSignals.map((signal) => signal.kind));
  if (rationale.failurePattern === 'coverage_regression') {
    return signalKinds.has('coverage_regression') ? 'matched' : 'contradicted';
  }
  if (rationale.failurePattern === 'tool_failed') {
    return signalKinds.has('tool_failure_cluster') ? 'matched' : 'contradicted';
  }
  if (isErrorClassBackedFailurePattern(rationale.failurePattern)) {
    return referencedSignals.some(
      (signal) => signal.kind === 'error_class' && signal.errorClass === rationale.failurePattern,
    )
      ? 'matched'
      : 'contradicted';
  }
  return 'unknown';
}

function isErrorClassBackedFailurePattern(failurePattern: PromptCandidateFailurePattern): boolean {
  return (
    failurePattern === 'max_tokens' ||
    failurePattern === 'runtime_error' ||
    failurePattern === 'verification_failed'
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = sortedUnique(left);
  const sortedRight = sortedUnique(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
