import { BUDGET_EXHAUSTED_RUNTIME_UNAVAILABLE_REASON } from './fixed-prompt-controller.js';
import type { FixedPromptTaskWalEvent } from './fixed-prompt-wal-types.js';
import type { HarborCellTokenSummary } from './cell-output.js';
import { assertRatio } from './numeric-guards.js';
import type {
  AbArmSummary,
  AbArmLabel,
  AbAttemptRef,
  AbAttemptPairSummary,
  AbComparisonSummary,
  AbContinuationSummary,
  AbContextBudgetSummary,
  AbContextBudgetPolicySummary,
  AbDecision,
  AbInvestigationRefs,
  AbPairInvestigationRef,
  AbNonInferioritySummary,
  AbTaskArmSummary,
  AbTaskComparison,
  AbTaskLevelSummary,
  AbTaskToolSummary,
  AbTokenCostSummary,
  SummarizeAbComparisonInput,
} from './ab-types.js';
import type { HarborCellContextBudgetSummary, HarborCellTaskToolSummary } from './cell-output.js';

const DEFAULT_NON_INFERIORITY_MARGIN = 0.1;
const NON_INFERIORITY_CONFIDENCE_LEVEL = 0.95;
// Two one-sided 97.5% score bounds give at least 95% simultaneous coverage by
// Bonferroni; subtracting loss.upper from win.lower is therefore a valid paired
// lower bound without pretending the multinomial cells are independent.
const ONE_SIDED_97_5_Z = 1.959963984540054;

export function summarizeAbComparison(input: SummarizeAbComparisonInput): AbComparisonSummary {
  assertSameRunCount(input.baselineRuns, input.candidateRuns);
  const nonInferiorityMargin =
    input.nonInferiorityMargin !== undefined
      ? assertRatio('nonInferiorityMargin', input.nonInferiorityMargin)
      : DEFAULT_NON_INFERIORITY_MARGIN;
  const reps = input.baselineRuns.length;
  const taskIds = [...input.evaluationTaskIds];
  const activePrunePairIds = candidateActivePrunePairIds(
    observedArmAttempts(input.candidateRuns, taskIds, 'B'),
  );
  const baseline = summarizeArm(
    input.baselineRuns,
    taskIds,
    reps,
    'A',
    activePrunePairIds,
    input.budgetMs,
  );
  const candidate = summarizeArm(
    input.candidateRuns,
    taskIds,
    reps,
    'B',
    activePrunePairIds,
    input.budgetMs,
  );
  const taskLevel = summarizeTasks(input.baselineRuns, input.candidateRuns, taskIds, reps);
  const pairedAttempts = summarizeAttemptPairs(input.baselineRuns, input.candidateRuns, taskIds);
  const investigationRefs = summarizeInvestigationRefs(
    input.baselineRuns,
    input.candidateRuns,
    taskIds,
  );
  const passRateDelta =
    pairedAttempts.evaluatedPairs > 0
      ? roundRateDelta(
          (pairedAttempts.wins - pairedAttempts.losses) / pairedAttempts.evaluatedPairs,
        )
      : null;
  const nonInferiority = summarizeNonInferiority(pairedAttempts, passRateDelta);
  const formalDecision = decide(
    baseline,
    candidate,
    pairedAttempts,
    passRateDelta,
    nonInferiority,
    nonInferiorityMargin,
  );
  const { decision, reason } =
    reps === 1 && formalDecision.decision !== 'invalid'
      ? { decision: 'diagnostic' as const, reason: 'single_rep_diagnostic_only' }
      : formalDecision;

  return {
    runId: input.runId,
    roundId: input.roundId,
    baselineArmId: input.baselineArmId,
    candidateArmId: input.candidateArmId,
    taskCount: taskIds.length,
    reps,
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    nonInferiorityMargin,
    passRateDelta,
    nonInferiority,
    decision,
    reason,
    baseline,
    candidate,
    taskLevel,
    pairedAttempts,
    investigationRefs,
  };
}

interface ObservedAttempt {
  arm: AbArmLabel;
  rep: number;
  taskId: string;
  event: FixedPromptTaskWalEvent;
}

function summarizeArm(
  runs: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
  reps: number,
  arm: AbArmLabel,
  activePrunePairIds: ReadonlySet<string>,
  wallTimeoutMs: number | undefined,
): AbArmSummary {
  const attempts = taskIds.length * reps;
  const observedAttempts = observedArmAttempts(runs, taskIds, arm);
  const observed = observedAttempts.map((attempt) => attempt.event);
  const valid = observed.filter(isEvaluatedOutcome);
  const budgetedRuns = valid.filter(
    (event): event is Extract<FixedPromptTaskWalEvent, { type: 'task_completed' }> =>
      event.type === 'task_completed' && abOutcomeCategory(event) !== 'budget',
  );
  const passed = valid.filter((event) => event.passed).length;
  const durations = budgetedRuns.map((event) => event.durationMs);
  const contextBudget = summarizeContextBudget(observedAttempts);
  const continuation = summarizeContinuation(observed, wallTimeoutMs);
  const taskTools = summarizeTaskTools(observed);
  const activePruneSubset = summarizeActivePruneSubset(observedAttempts, activePrunePairIds);
  const contextBudgetPolicy = summarizeContextBudgetPolicy(observed);
  const tokenCostSummary = summarizeTokenCost(observed);
  return {
    attempts,
    observed: observed.length,
    valid: valid.length,
    passed,
    passRate: valid.length > 0 ? passed / valid.length : null,
    completed: observed.filter((event) => abOutcomeCategory(event) === 'completed').length,
    budgetExhausted: observed.filter((event) => abOutcomeCategory(event) === 'budget').length,
    infraFailed: observed.filter((event) => abOutcomeCategory(event) === 'infra').length,
    plumbingFailed: observed.filter((event) => abOutcomeCategory(event) === 'plumbing').length,
    missingFinalUsage: valid.filter((event) => !hasCompleteTokenSummary(event)).length,
    attestationWarnings: observed.filter(isMissingExecutionIdentityTimeout).length,
    missing: attempts - observed.length,
    coverageRate: attempts > 0 ? valid.length / attempts : 1,
    totalCostUsd: tokenCostSummary.costUsd,
    meanDurationMs: durations.length > 0 ? sum(durations) / durations.length : null,
    tokenCostSummary,
    ...(contextBudgetPolicy ? { contextBudgetPolicy } : {}),
    ...(contextBudget ? { contextBudget } : {}),
    ...(continuation ? { continuation } : {}),
    ...(taskTools ? { taskTools } : {}),
    ...(activePruneSubset ? { activePruneSubset } : {}),
  };
}

function candidateActivePrunePairIds(attempts: readonly ObservedAttempt[]): ReadonlySet<string> {
  return new Set(
    attempts
      .filter(
        (attempt) =>
          'contextBudgetSummary' in attempt.event &&
          isActivePruneActivated(attempt.event.contextBudgetSummary),
      )
      .map(attemptPairId),
  );
}

function summarizeActivePruneSubset(
  attempts: readonly ObservedAttempt[],
  activePrunePairIds: ReadonlySet<string>,
): AbArmSummary['activePruneSubset'] {
  if (activePrunePairIds.size === 0) return undefined;
  const sliceAttempts = attempts.filter((attempt) =>
    activePrunePairIds.has(attemptPairId(attempt)),
  );
  const observed = sliceAttempts.map((attempt) => attempt.event);
  const valid = observed.filter(isEvaluatedOutcome);
  const budgetedRuns = valid.filter(
    (event): event is Extract<FixedPromptTaskWalEvent, { type: 'task_completed' }> =>
      event.type === 'task_completed' && abOutcomeCategory(event) !== 'budget',
  );
  const passed = valid.filter((event) => event.passed).length;
  const durations = budgetedRuns.map((event) => event.durationMs);
  const tokenCostSummary = summarizeTokenCost(observed);
  const contextBudget = summarizeContextBudget(sliceAttempts);
  return {
    taskCount: new Set([...activePrunePairIds].map(pairTaskId)).size,
    attempts: activePrunePairIds.size,
    observed: observed.length,
    valid: valid.length,
    passed,
    passRate: valid.length > 0 ? passed / valid.length : null,
    completed: observed.filter((event) => abOutcomeCategory(event) === 'completed').length,
    budgetExhausted: observed.filter((event) => abOutcomeCategory(event) === 'budget').length,
    infraFailed: observed.filter((event) => abOutcomeCategory(event) === 'infra').length,
    plumbingFailed: observed.filter((event) => abOutcomeCategory(event) === 'plumbing').length,
    attestationWarnings: observed.filter(isMissingExecutionIdentityTimeout).length,
    missing: activePrunePairIds.size - observed.length,
    coverageRate: activePrunePairIds.size > 0 ? valid.length / activePrunePairIds.size : 1,
    totalCostUsd: tokenCostSummary.costUsd,
    meanDurationMs: durations.length > 0 ? sum(durations) / durations.length : null,
    tokenCostSummary,
    ...(contextBudget ? { contextBudget } : {}),
  };
}

function attemptPairId(attempt: ObservedAttempt): string {
  return `${attempt.taskId}#r${attempt.rep}`;
}

function pairTaskId(pairId: string): string {
  return pairId.slice(0, pairId.lastIndexOf('#r'));
}

function summarizeTokenCost(events: readonly FixedPromptTaskWalEvent[]): AbTokenCostSummary {
  const withUsage = events.filter(hasTokenSummary);
  const durations = events.flatMap((event) =>
    'durationMs' in event && event.durationMs !== undefined ? [event.durationMs] : [],
  );
  return {
    input: sum(withUsage.map((event) => event.tokenSummary.input)),
    cachedInput: sum(withUsage.map((event) => event.tokenSummary.cachedInput)),
    cacheHitInput: sum(withUsage.map((event) => event.tokenSummary.cacheHitInput)),
    cacheMissInput: sum(withUsage.map((event) => event.tokenSummary.cacheMissInput)),
    cacheWriteInput: sum(withUsage.map((event) => event.tokenSummary.cacheWriteInput)),
    output: sum(withUsage.map((event) => event.tokenSummary.output)),
    reasoning: sum(withUsage.map((event) => event.tokenSummary.reasoning)),
    total: sum(withUsage.map((event) => event.tokenSummary.total)),
    costUsd: sum(withUsage.map((event) => event.tokenSummary.costUsd)),
    meanDurationMs: durations.length > 0 ? sum(durations) / durations.length : null,
  };
}

function observedArmAttempts(
  runs: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
  arm: AbArmLabel,
): ObservedAttempt[] {
  const attempts: ObservedAttempt[] = [];
  for (const taskId of taskIds) {
    for (let rep = 0; rep < runs.length; rep += 1) {
      const event = runs[rep]?.find((candidate) => candidate.taskId === taskId);
      if (event) attempts.push({ arm, rep, taskId, event });
    }
  }
  return attempts;
}

function summarizeContextBudgetPolicy(
  events: readonly FixedPromptTaskWalEvent[],
): AbContextBudgetPolicySummary | undefined {
  const snapshots = events
    .map((event) => ('contextBudgetPolicy' in event ? event.contextBudgetPolicy : undefined))
    .filter((policy): policy is NonNullable<typeof policy> => policy !== undefined);
  if (snapshots.length === 0) return undefined;
  const unique = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    unique.set(canonicalJson(snapshot), snapshot);
  }
  return {
    attempts: snapshots.length,
    enabledAttempts: snapshots.filter((snapshot) => snapshot.enabled).length,
    snapshots: [...unique.keys()].sort().map((key) => unique.get(key)!),
  };
}

function summarizeContextBudget(
  attempts: readonly ObservedAttempt[],
): AbContextBudgetSummary | undefined {
  const summaries = attempts
    .map((attempt) =>
      'contextBudgetSummary' in attempt.event ? attempt.event.contextBudgetSummary : undefined,
    )
    .filter((summary): summary is NonNullable<typeof summary> => summary !== undefined);
  if (summaries.length === 0) return undefined;
  const activatedAttemptIds = attempts
    .filter(
      (attempt) =>
        'contextBudgetSummary' in attempt.event &&
        isActivePruneActivated(attempt.event.contextBudgetSummary),
    )
    .map((attempt) => attempt.event.id);
  return {
    diagnosticAttempts: summaries.length,
    activatedAttempts: summaries.filter(isActivePruneActivated).length,
    activatedAttemptIds,
    diagnosticEvents: sum(summaries.map((summary) => summary.diagnosticEvents)),
    prunedToolResults: sum(summaries.map((summary) => summary.prunedToolResults)),
    activePrunedToolResults: sum(summaries.map((summary) => summary.activePrunedToolResults)),
    activeEstimatedTokensSaved: sum(summaries.map((summary) => summary.activeEstimatedTokensSaved)),
    activeArchiveFailures: sum(summaries.map((summary) => summary.activeArchiveFailures)),
    archivePlaceholders: sum(summaries.map((summary) => summary.archivePlaceholders)),
    archivePlaceholderReasonCounts: sumCountRecords(
      summaries.map((summary) => summary.archivePlaceholderReasonCounts),
    ),
    archiveWriteFailures: sum(summaries.map((summary) => summary.archiveWriteFailures)),
    retrievedArchiveToolResults: sum(
      summaries.map((summary) => summary.retrievedArchiveToolResults),
    ),
    retrievedArchiveEstimatedTokens: sum(
      summaries.map((summary) => summary.retrievedArchiveEstimatedTokens),
    ),
    archiveRetrievalSkipped: sum(summaries.map((summary) => summary.archiveRetrievalSkipped)),
    archiveRetrievalSkippedReasonCounts: sumCountRecords(
      summaries.map((summary) => summary.archiveRetrievalSkippedReasonCounts),
    ),
    archiveRetrievalFailures: sum(summaries.map((summary) => summary.archiveRetrievalFailures)),
    archiveRetrievalFailureReasonCounts: sumCountRecords(
      summaries.map((summary) => summary.archiveRetrievalFailureReasonCounts),
    ),
  };
}

function summarizeContinuation(
  events: readonly FixedPromptTaskWalEvent[],
  wallTimeoutMs: number | undefined,
): AbContinuationSummary | undefined {
  const summaries = events
    .map((event) => ('continuationSummary' in event ? event.continuationSummary : undefined))
    .filter((summary): summary is NonNullable<typeof summary> => summary !== undefined);
  if (summaries.length === 0) return undefined;
  return {
    attempts: summaries.length,
    enabledAttempts: summaries.filter((summary) => summary.enabled).length,
    wallTimeoutMs: wallTimeoutMs ?? null,
    turnsUsed: sum(summaries.map((summary) => summary.turnsUsed)),
    continuedTurns: sum(summaries.map((summary) => summary.continuedTurns)),
    stepCapHits: sum(summaries.map((summary) => summary.stepCapHits)),
    capExhaustedAttempts: summaries.filter((summary) => summary.capExhausted).length,
    totalRuntimeSteps: sum(summaries.map((summary) => summary.totalRuntimeSteps)),
    perTurnStepCapHits: summaries.flatMap((summary) =>
      summary.turns.map((turn) => turn.stepCapHit),
    ),
    maxTurns:
      summaries.length > 0 ? Math.max(...summaries.map((summary) => summary.maxTurns)) : null,
    maxTotalRuntimeSteps:
      summaries.length > 0
        ? Math.max(...summaries.map((summary) => summary.maxTotalRuntimeSteps))
        : null,
  };
}

function summarizeTaskTools(
  events: readonly FixedPromptTaskWalEvent[],
): AbTaskToolSummary | undefined {
  const summaries: { event: FixedPromptTaskWalEvent; summary: HarborCellTaskToolSummary }[] = [];
  for (const event of events) {
    if ('taskToolSummary' in event && event.taskToolSummary) {
      summaries.push({ event, summary: event.taskToolSummary });
    }
  }
  if (summaries.length === 0) return undefined;
  const activatedSummaries = summaries.filter((entry) => entry.summary.todoWriteCalls > 0);
  return {
    attempts: events.length,
    activatedAttempts: activatedSummaries.length,
    activatedAttemptIds: activatedSummaries.map((entry) => entry.event.id),
    todoWriteCalls: sum(summaries.map((entry) => entry.summary.todoWriteCalls)),
  };
}

function sumCountRecords(records: readonly Record<string, number>[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value;
    }
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isActivePruneActivated(summary: HarborCellContextBudgetSummary | undefined): boolean {
  return (summary?.activePrunedToolResults ?? 0) > 0;
}

function summarizeInvestigationRefs(
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
): AbInvestigationRefs {
  const baselineByPair = attemptMap(observedArmAttempts(baselineRuns, taskIds, 'A'));
  const candidateByPair = attemptMap(observedArmAttempts(candidateRuns, taskIds, 'B'));
  const candidateLosses: AbPairInvestigationRef[] = [];
  const budgetDiscordantPairs: AbPairInvestigationRef[] = [];
  const infraOrPlumbingDiscordantPairs: AbPairInvestigationRef[] = [];
  const activatedAttempts = [...baselineByPair.values(), ...candidateByPair.values()]
    .filter(
      (attempt) =>
        'contextBudgetSummary' in attempt.event &&
        isActivePruneActivated(attempt.event.contextBudgetSummary),
    )
    .map(attemptRef);

  for (let rep = 0; rep < baselineRuns.length; rep += 1) {
    for (const taskId of taskIds) {
      const pairId = `${taskId}#r${rep}`;
      const baseline = baselineByPair.get(pairId);
      const candidate = candidateByPair.get(pairId);
      const baselineEvent = baseline?.event;
      const candidateEvent = candidate?.event;
      if (baselineEvent && candidateEvent) {
        if (
          isEvaluatedOutcome(baselineEvent) &&
          isEvaluatedOutcome(candidateEvent) &&
          baselineEvent.passed &&
          !candidateEvent.passed
        ) {
          candidateLosses.push(pairRef(pairId, baseline, candidate));
        }
        if (isBudgetExhaustedOutcome(baselineEvent) !== isBudgetExhaustedOutcome(candidateEvent)) {
          budgetDiscordantPairs.push(pairRef(pairId, baseline, candidate));
        }
        if (isInfraOrPlumbingOutcome(baselineEvent) !== isInfraOrPlumbingOutcome(candidateEvent)) {
          infraOrPlumbingDiscordantPairs.push(pairRef(pairId, baseline, candidate));
        }
      }
    }
  }

  return {
    activatedAttempts,
    candidateLosses,
    budgetDiscordantPairs,
    infraOrPlumbingDiscordantPairs,
  };
}

function attemptMap(attempts: readonly ObservedAttempt[]): Map<string, ObservedAttempt> {
  return new Map(attempts.map((attempt) => [`${attempt.taskId}#r${attempt.rep}`, attempt]));
}

function pairRef(
  pairId: string,
  baseline: ObservedAttempt | undefined,
  candidate: ObservedAttempt | undefined,
): AbPairInvestigationRef {
  return {
    pairId,
    ...(baseline ? { baseline: attemptRef(baseline) } : {}),
    ...(candidate ? { candidate: attemptRef(candidate) } : {}),
  };
}

function attemptRef(attempt: ObservedAttempt): AbAttemptRef {
  const event = attempt.event;
  const runtimeEventsPath = 'runtimeEventsPath' in event ? event.runtimeEventsPath : undefined;
  const runtimeEventsUnavailableReason =
    event.type === 'task_budget_exhausted' && !runtimeEventsPath
      ? (event.runtimeEventsUnavailableReason ?? BUDGET_EXHAUSTED_RUNTIME_UNAVAILABLE_REASON)
      : undefined;
  return {
    arm: attempt.arm,
    attemptId: event.id,
    taskId: attempt.taskId,
    rep: attempt.rep,
    roundId: event.roundId,
    ...(runtimeEventsPath ? { runtimeEventsPath } : {}),
    ...('traceEventsPath' in event && event.traceEventsPath
      ? { traceEventsPath: event.traceEventsPath }
      : {}),
    ...(runtimeEventsUnavailableReason ? { runtimeEventsUnavailableReason } : {}),
  };
}

function summarizeTasks(
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
  reps: number,
): AbTaskLevelSummary {
  const tasks = taskIds.map((taskId) => summarizeTask(taskId, baselineRuns, candidateRuns, reps));
  const comparable = tasks.filter((task) => task.passRateDelta !== null);
  const deltas = comparable.map((task) => task.passRateDelta as number);
  const wins = comparable.filter((task) => task.outcome === 'candidate_win').length;
  const losses = comparable.filter((task) => task.outcome === 'baseline_win').length;
  const ties = comparable.filter((task) => task.outcome === 'tie').length;
  const signTestNonTieTasks = wins + losses;
  return {
    comparableTasks: comparable.length,
    wins,
    losses,
    ties,
    signTestNonTieTasks,
    signTestPValue:
      signTestNonTieTasks > 0
        ? exactTwoSidedSignTestPValue(signTestNonTieTasks, Math.max(wins, losses))
        : null,
    missingTaskIds: tasks
      .filter((task) => task.baseline.missing > 0 || task.candidate.missing > 0)
      .map((task) => task.taskId),
    excludedTaskIds: tasks.filter((task) => task.outcome === 'excluded').map((task) => task.taskId),
    meanPassRateDelta: deltas.length > 0 ? sum(deltas) / deltas.length : null,
    medianPassRateDelta: median(deltas),
    tasks,
  };
}

function summarizeTask(
  taskId: string,
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  reps: number,
): AbTaskComparison {
  const baseline = summarizeTaskArm(taskId, baselineRuns, reps);
  const candidate = summarizeTaskArm(taskId, candidateRuns, reps);
  const evaluatedPairs = baselineRuns.flatMap((run, rep) => {
    const baselineEvent = run.find((event) => event.taskId === taskId);
    const candidateEvent = candidateRuns[rep]?.find((event) => event.taskId === taskId);
    return baselineEvent &&
      candidateEvent &&
      isEvaluatedOutcome(baselineEvent) &&
      isEvaluatedOutcome(candidateEvent)
      ? [{ baseline: baselineEvent, candidate: candidateEvent }]
      : [];
  });
  const passRateDelta =
    evaluatedPairs.length > 0
      ? (evaluatedPairs.filter(({ candidate }) => candidate.passed).length -
          evaluatedPairs.filter(({ baseline: event }) => event.passed).length) /
        evaluatedPairs.length
      : null;
  let outcome: AbTaskComparison['outcome'] = 'missing';
  if (passRateDelta !== null) {
    outcome = passRateDelta > 0 ? 'candidate_win' : passRateDelta < 0 ? 'baseline_win' : 'tie';
  } else if (baseline.missing === 0 && candidate.missing === 0) {
    outcome = 'excluded';
  }
  return { taskId, baseline, candidate, passRateDelta, outcome };
}

function summarizeTaskArm(
  taskId: string,
  runs: readonly (readonly FixedPromptTaskWalEvent[])[],
  reps: number,
): AbTaskArmSummary {
  const observed = runs
    .map((run) => run.find((event) => event.taskId === taskId))
    .filter((event): event is FixedPromptTaskWalEvent => event !== undefined);
  const valid = observed.filter(isEvaluatedOutcome);
  const passed = valid.filter((event) => event.passed).length;
  return {
    observed: observed.length,
    valid: valid.length,
    passed,
    passRate: valid.length > 0 ? passed / valid.length : null,
    completed: observed.filter((event) => abOutcomeCategory(event) === 'completed').length,
    budgetExhausted: observed.filter((event) => abOutcomeCategory(event) === 'budget').length,
    infraFailed: observed.filter((event) => abOutcomeCategory(event) === 'infra').length,
    plumbingFailed: observed.filter((event) => abOutcomeCategory(event) === 'plumbing').length,
    attestationWarnings: observed.filter(isMissingExecutionIdentityTimeout).length,
    missing: reps - observed.length,
  };
}

function summarizeAttemptPairs(
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
): AbAttemptPairSummary {
  const missingPairIds: string[] = [];
  const excludedPairIds: string[] = [];
  const missingUsagePairIds: string[] = [];
  const budgetDiscordantPairIds: string[] = [];
  const infraOrPlumbingDiscordantPairIds: string[] = [];
  const baselineEvaluatedEvents: FixedPromptTaskWalEvent[] = [];
  const candidateEvaluatedEvents: FixedPromptTaskWalEvent[] = [];
  let observedPairs = 0;
  let evaluatedPairs = 0;
  let baselinePassed = 0;
  let candidatePassed = 0;
  let fullyMeteredPairs = 0;
  let baselineMeteredPassed = 0;
  let candidateMeteredPassed = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let rep = 0; rep < baselineRuns.length; rep += 1) {
    const baselineByTask = new Map((baselineRuns[rep] ?? []).map((event) => [event.taskId, event]));
    const candidateByTask = new Map(
      (candidateRuns[rep] ?? []).map((event) => [event.taskId, event]),
    );
    for (const taskId of taskIds) {
      const pairId = `${taskId}#r${rep}`;
      const baseline = baselineByTask.get(taskId);
      const candidate = candidateByTask.get(taskId);
      if (!baseline || !candidate) {
        missingPairIds.push(pairId);
        continue;
      }
      observedPairs += 1;
      if (isBudgetExhaustedOutcome(baseline) !== isBudgetExhaustedOutcome(candidate)) {
        budgetDiscordantPairIds.push(pairId);
      }
      if (isInfraOrPlumbingOutcome(baseline) !== isInfraOrPlumbingOutcome(candidate)) {
        infraOrPlumbingDiscordantPairIds.push(pairId);
      }
      if (!isEvaluatedOutcome(baseline) || !isEvaluatedOutcome(candidate)) {
        excludedPairIds.push(pairId);
        continue;
      }
      evaluatedPairs += 1;
      if (baseline.passed) baselinePassed += 1;
      if (candidate.passed) candidatePassed += 1;
      if (hasCompleteTokenSummary(baseline) && hasCompleteTokenSummary(candidate)) {
        fullyMeteredPairs += 1;
        baselineEvaluatedEvents.push(baseline);
        candidateEvaluatedEvents.push(candidate);
        if (baseline.passed) baselineMeteredPassed += 1;
        if (candidate.passed) candidateMeteredPassed += 1;
      } else {
        missingUsagePairIds.push(pairId);
      }
      if (candidate.passed === baseline.passed) {
        ties += 1;
      } else if (candidate.passed) {
        wins += 1;
      } else {
        losses += 1;
      }
    }
  }
  return {
    pairs: taskIds.length * baselineRuns.length,
    observedPairs,
    evaluatedPairs,
    baselinePassed,
    candidatePassed,
    fullyMeteredPairs,
    baselineMeteredPassed,
    candidateMeteredPassed,
    baselineTokenCostSummary: summarizeTokenCost(baselineEvaluatedEvents),
    candidateTokenCostSummary: summarizeTokenCost(candidateEvaluatedEvents),
    wins,
    losses,
    ties,
    missingPairIds,
    excludedPairIds,
    missingUsagePairIds,
    budgetDiscordantPairIds,
    infraOrPlumbingDiscordantPairIds,
  };
}

function hasCompleteTokenSummary(
  event: FixedPromptTaskWalEvent,
): event is FixedPromptTaskWalEvent & { tokenSummary: HarborCellTokenSummary } {
  if (!hasTokenSummary(event)) return false;
  return event.type !== 'task_budget_exhausted' || event.tokenSummarySource === 'final';
}

function hasTokenSummary(
  event: FixedPromptTaskWalEvent,
): event is FixedPromptTaskWalEvent & { tokenSummary: HarborCellTokenSummary } {
  return 'tokenSummary' in event && event.tokenSummary !== undefined;
}

function decide(
  baseline: AbArmSummary,
  candidate: AbArmSummary,
  pairedAttempts: AbAttemptPairSummary,
  passRateDelta: number | null,
  nonInferiority: AbNonInferioritySummary,
  nonInferiorityMargin: number,
): { decision: AbDecision; reason: string } {
  const coverage =
    pairedAttempts.pairs > 0 ? pairedAttempts.evaluatedPairs / pairedAttempts.pairs : 0;
  if (baseline.plumbingFailed + candidate.plumbingFailed > 0)
    return { decision: 'invalid', reason: 'plumbing_failure_observed' };
  if (coverage < 0.9) return { decision: 'not_cleared', reason: 'low_effective_coverage' };
  if (pairedAttempts.missingPairIds.length > 0)
    return { decision: 'not_cleared', reason: 'missing_attempt_pair' };
  if (passRateDelta === null) return { decision: 'not_cleared', reason: 'missing_pass_rate_delta' };
  if (passRateDelta < -nonInferiorityMargin)
    return { decision: 'inferior', reason: 'pass_rate_delta_below_non_inferiority_margin' };
  if (nonInferiority.lowerBound !== null && nonInferiority.lowerBound >= -nonInferiorityMargin) {
    return { decision: 'non_inferior', reason: 'non_inferiority_lower_bound_within_margin' };
  }
  return { decision: 'not_cleared', reason: 'non_inferiority_confidence_interval_crosses_margin' };
}

function summarizeNonInferiority(
  pairedAttempts: AbAttemptPairSummary,
  passRateDelta: number | null,
): AbNonInferioritySummary {
  if (passRateDelta === null || pairedAttempts.evaluatedPairs === 0) {
    return {
      method: 'unavailable',
      confidenceLevel: NON_INFERIORITY_CONFIDENCE_LEVEL,
      lowerBound: null,
    };
  }
  const winInterval = wilsonScoreInterval(
    pairedAttempts.wins,
    pairedAttempts.evaluatedPairs,
    ONE_SIDED_97_5_Z,
  );
  const lossInterval = wilsonScoreInterval(
    pairedAttempts.losses,
    pairedAttempts.evaluatedPairs,
    ONE_SIDED_97_5_Z,
  );
  return {
    method: 'paired_bonferroni_wilson',
    confidenceLevel: NON_INFERIORITY_CONFIDENCE_LEVEL,
    lowerBound: roundRateDelta(clampRateDelta(winInterval.lower - lossInterval.upper)),
  };
}

function wilsonScoreInterval(
  passed: number,
  total: number,
  z: number,
): { lower: number; upper: number } {
  const proportion = passed / total;
  const z2 = z ** 2;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const halfWidth =
    (z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total)) / denominator;
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
  };
}

function isEvaluatedOutcome(
  event: FixedPromptTaskWalEvent,
): event is Extract<FixedPromptTaskWalEvent, { type: 'task_completed' | 'task_budget_exhausted' }> {
  const category = abOutcomeCategory(event);
  return (
    (event.type === 'task_completed' || event.type === 'task_budget_exhausted') &&
    (category === 'completed' || category === 'budget')
  );
}

function isMissingExecutionIdentityTimeout(event: FixedPromptTaskWalEvent): boolean {
  return (
    event.type === 'task_budget_exhausted' &&
    event.evidenceErrorClass === 'missing_execution_identity'
  );
}

function isBudgetExhaustedOutcome(event: FixedPromptTaskWalEvent): boolean {
  return abOutcomeCategory(event) === 'budget';
}

function isInfraOrPlumbingOutcome(event: FixedPromptTaskWalEvent): boolean {
  const category = abOutcomeCategory(event);
  return category === 'infra' || category === 'plumbing';
}

type AbOutcomeCategory = 'completed' | 'budget' | 'infra' | 'plumbing';

function abOutcomeCategory(event: FixedPromptTaskWalEvent): AbOutcomeCategory {
  if (event.type === 'task_infra_failed') return 'infra';
  if (event.type === 'task_plumbing_failed') return 'plumbing';
  if (event.type === 'task_completed') {
    if (isHardPlumbingErrorClass(event.errorClass)) return 'plumbing';
    if (event.errorClass === 'tool_step_cap_reached') return 'budget';
    return event.scored ? 'completed' : 'infra';
  }
  if (
    event.evidenceErrorClass === undefined ||
    event.evidenceErrorClass === 'missing_execution_identity'
  )
    return 'budget';
  if (isHardPlumbingErrorClass(event.evidenceErrorClass)) return 'plumbing';
  return 'infra';
}

function isHardPlumbingErrorClass(errorClass: string | undefined): boolean {
  return (
    errorClass === 'zero_cost_with_tokens' ||
    errorClass === 'prompt_hash_mismatch' ||
    errorClass === 'missing_prompt_hash' ||
    errorClass === 'execution_identity_mismatch'
  );
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function exactTwoSidedSignTestPValue(nonTieTasks: number, majorityWins: number): number {
  if (nonTieTasks <= 0) return 1;
  const minorityWins = Math.min(majorityWins, nonTieTasks - majorityWins);
  let tail = 0;
  for (let wins = 0; wins <= minorityWins; wins += 1) {
    tail += binomialProbability(nonTieTasks, wins, 0.5);
  }
  return Math.min(1, tail * 2);
}

function binomialProbability(n: number, k: number, p: number): number {
  let combinations = 1;
  for (let i = 1; i <= k; i += 1) {
    combinations *= (n - k + i) / i;
  }
  return combinations * p ** k * (1 - p) ** (n - k);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundRateDelta(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function clampRateDelta(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSameRunCount(
  baselineRuns: readonly unknown[],
  candidateRuns: readonly unknown[],
): void {
  if (baselineRuns.length !== candidateRuns.length) {
    throw new Error('baseline and candidate runs must have the same rep count');
  }
}
