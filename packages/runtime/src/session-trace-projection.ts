import {
  dedupeModelCallAttempts,
  groupModelCallAttempts,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import { TERMINAL_RUNTIME_EVENT_STATUSES, type RuntimeEvent } from '@maka/core/runtime-event';
import {
  emptyTraceTotals,
  mergeTraceTotals,
  SESSION_TRACE_SCHEMA_VERSION,
  type SessionTrace,
  type SessionTraceCoverage,
  type TraceFailureAttribution,
  type TraceModelAttempt,
  type TraceModelCallStep,
  type TraceStep,
  type TraceTotals,
  type TurnTrace,
} from '@maka/core/session-trace';

/**
 * Builds the per-session causal trace the Inspector renders (#1625).
 *
 * Pure and synchronous by construction: both ledgers are handed in already
 * read. The caller owns the I/O — `readSessionRuntimeEvents` for structure and
 * the AgentRun stream for canonical records — which keeps this file testable
 * against fixtures and keeps `@maka/storage` out of `@maka/runtime`.
 *
 * The two inputs are joined on `(runId, turnId)`, the identity both ledgers
 * carry. Nothing is inferred across that boundary: a turn with events and no
 * records renders its structure and reports the gap, rather than borrowing
 * numbers from a neighbouring turn.
 */
export interface SessionTraceInput {
  sessionId: string;
  /** Causal structure, from `RuntimeEventStore.readSessionRuntimeEvents`. */
  runtimeEvents: readonly RuntimeEvent[];
  /** Canonical metering, from the AgentRun stream's `model_call_attempt_recorded`. */
  modelCallAttempts: readonly ModelCallAttempt[];
  /**
   * Records the caller could not read or decode. Carried through to coverage so
   * unreadable spend is visible instead of silently absent; the caller decides
   * the unit, and a whole unreadable run counting as one is a floor.
   */
  unreadableRecords?: number;
}

export function projectSessionTrace(input: SessionTraceInput): SessionTrace {
  const events = input.runtimeEvents.filter((event) => !event.partial);
  // An aborted attempt and its later settlement are appended under one
  // `attemptId`; the ledger dedupes on write, a stream read does not. Without
  // this the trace invents a retry and can double-count a priced settlement,
  // which would put it out of step with Settings → Usage over the same records.
  const attempts = dedupeModelCallAttempts(input.modelCallAttempts);
  const turnIds = orderedTurnIds(events, attempts);
  const eventsByTurn = groupBy(events, (event) => event.turnId);
  const attemptsByTurn = groupBy(attempts, (attempt) => attempt.turnId);

  const turns: TurnTrace[] = [];
  const turnsMissingModelCalls: string[] = [];
  const turnsWithFewerModelCallsThanSteps: string[] = [];
  let turnsWithModelActivity = 0;

  for (const turnId of turnIds) {
    const turnEvents = eventsByTurn.get(turnId) ?? [];
    const turnAttempts = attemptsByTurn.get(turnId) ?? [];
    const turn = projectTurn(turnId, turnEvents, turnAttempts);
    if (!turn) continue;
    turns.push(turn);

    // Aggregate usage on the ledger means the turn made model calls, whatever
    // the metering ledger holds. That disagreement is the coverage signal.
    const hasAggregateUsage = turnEvents.some((event) => event.actions?.tokenUsage !== undefined);
    if (hasAggregateUsage || turnAttempts.length > 0) turnsWithModelActivity += 1;
    if (hasAggregateUsage && turnAttempts.length === 0) {
      turnsMissingModelCalls.push(turnId);
    } else if (hasAggregateUsage && missesRuntimeSteps(turnEvents, turn)) {
      turnsWithFewerModelCallsThanSteps.push(turnId);
    }
  }

  const totals = turns.reduce<TraceTotals>(
    (carry, turn) => mergeTraceTotals(carry, turn.totals),
    emptyTraceTotals(),
  );

  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    turns,
    totals,
    coverage: resolveCoverage(
      turnsWithModelActivity,
      turnsMissingModelCalls,
      turnsWithFewerModelCallsThanSteps,
      input.unreadableRecords ?? 0,
    ),
  };
}

/**
 * Coverage is a session-level fact, because that is the scale at which the
 * dangerous case is legible: a backend outside canonical accounting produces a
 * trace that looks like an idle session unless something says otherwise.
 */
function resolveCoverage(
  turnsWithModelActivity: number,
  turnsMissingModelCalls: string[],
  turnsWithFewerModelCallsThanSteps: string[],
  unreadableRecords: number,
): SessionTraceCoverage {
  if (turnsWithModelActivity === 0 && unreadableRecords === 0) {
    return {
      modelCalls: 'none',
      turnsMissingModelCalls: [],
      turnsWithFewerModelCallsThanSteps: [],
      unreadableRecords: 0,
    };
  }
  if (turnsWithModelActivity > 0 && turnsMissingModelCalls.length === turnsWithModelActivity) {
    return {
      modelCalls: 'absent',
      turnsMissingModelCalls,
      turnsWithFewerModelCallsThanSteps,
      unreadableRecords,
    };
  }
  const gaps =
    turnsMissingModelCalls.length + turnsWithFewerModelCallsThanSteps.length + unreadableRecords;
  return {
    // "No known gap" rather than "complete": records that are present cannot
    // prove that every call settled, so this is the absence of evidence of a
    // gap, not evidence of its absence.
    modelCalls: gaps === 0 ? 'no_known_gap' : 'partial',
    turnsMissingModelCalls,
    turnsWithFewerModelCallsThanSteps,
    unreadableRecords,
  };
}

/**
 * Whether the aggregate usage stands for more runtime steps than the turn has
 * main model calls on record.
 *
 * `runtimeSteps` counts the provider tool-loop steps one aggregate usage event
 * represents, and each of those steps is one main call. Fewer main calls than
 * that is a shortfall the ledgers themselves disagree about — a floor on what
 * is missing, never a count of it. Compaction kinds are excluded because they
 * are not part of that count.
 */
function missesRuntimeSteps(events: readonly RuntimeEvent[], turn: TurnTrace): boolean {
  const declaredSteps = events.reduce(
    (carry, event) => carry + (event.actions?.tokenUsage?.runtimeSteps ?? 0),
    0,
  );
  if (declaredSteps === 0) return false;
  const mainCalls = turn.steps.filter(
    (step) => step.kind === 'model_call' && step.callKind === 'main',
  ).length;
  return mainCalls < declaredSteps;
}

function projectTurn(
  turnId: string,
  events: readonly RuntimeEvent[],
  attempts: readonly ModelCallAttempt[],
): TurnTrace | undefined {
  if (events.length === 0 && attempts.length === 0) return undefined;
  const runId = events[0]?.runId ?? attempts[0]?.runId ?? '';
  const steps = [...projectModelCallSteps(attempts), ...projectEventSteps(events)].sort(
    (left, right) => left.startedAt - right.startedAt,
  );

  // Bounds come from the ledger facts, not from the steps that happen to be
  // visible: a usage-only or text-only turn projects no steps at all, and
  // folding an empty list gives ±Infinity, which JSON renders as `null`.
  const instants = [
    ...events.map((event) => event.ts),
    ...attempts.map((attempt) => attempt.startedAt),
    ...attempts.map((attempt) => attempt.completedAt),
    ...steps.map((step) => step.startedAt),
    ...steps.map(stepEndedAt),
  ];
  const startedAt = Math.min(...instants);
  const endedAt = Math.max(...instants);
  const totals = turnTotals(steps, endedAt - startedAt);
  const failure = attributeTurnFailure(steps, events);

  return {
    turnId,
    runId,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    steps,
    totals,
    ...(failure ? { failure } : {}),
  };
}

/**
 * One step per logical call, attempts nested under it.
 *
 * Retries share a `logicalCallId` by contract, so this is a grouping rather
 * than a heuristic — the reason that field is explicit on the record instead of
 * reconstructed from `(traceId, step)` by every consumer.
 */
function projectModelCallSteps(attempts: readonly ModelCallAttempt[]): TraceModelCallStep[] {
  const steps: TraceModelCallStep[] = [];

  for (const { logicalCallId, attempts: group } of groupModelCallAttempts(attempts)) {
    const ordered = [...group].sort((left, right) => left.attempt - right.attempt);
    const last = ordered[ordered.length - 1]!;
    const first = ordered[0]!;
    const startedAt = Math.min(...ordered.map((attempt) => attempt.startedAt));
    const endedAt = Math.max(...ordered.map((attempt) => attempt.completedAt));
    const priced = ordered.filter((attempt) => attempt.costUsd !== undefined);

    steps.push({
      kind: 'model_call',
      id: logicalCallId,
      turnId: first.turnId,
      runId: first.runId,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      callKind: first.callKind,
      ...(first.historyCompactRoute !== undefined
        ? { historyCompactRoute: first.historyCompactRoute }
        : {}),
      providerId: first.providerId,
      modelId: first.modelId,
      ...(first.connectionSlug !== undefined ? { connectionSlug: first.connectionSlug } : {}),
      step: first.step,
      attempts: ordered.map(toTraceAttempt),
      status: last.status,
      // Absent rather than zero when nothing in the group was priced: the sum of
      // no prices is not a price (#1679).
      ...(priced.length > 0
        ? { costUsd: priced.reduce((carry, attempt) => carry + (attempt.costUsd ?? 0), 0) }
        : {}),
    });
  }

  return steps;
}

function toTraceAttempt(attempt: ModelCallAttempt): TraceModelAttempt {
  return {
    attemptId: attempt.attemptId,
    attempt: attempt.attempt,
    status: attempt.status,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    latencyMs: attempt.latencyMs,
    ...(attempt.timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: attempt.timeToFirstTokenMs }
      : {}),
    ...(attempt.finishReason !== undefined ? { finishReason: attempt.finishReason } : {}),
    ...(attempt.errorClass !== undefined ? { errorClass: attempt.errorClass } : {}),
    ...(attempt.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}),
    ...(attempt.providerCode !== undefined ? { providerCode: attempt.providerCode } : {}),
    ...(attempt.providerRequestId !== undefined
      ? { providerRequestId: attempt.providerRequestId }
      : {}),
    ...(attempt.retryable !== undefined ? { retryable: attempt.retryable } : {}),
    ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
    ...(attempt.outputTokens !== undefined ? { outputTokens: attempt.outputTokens } : {}),
    ...(attempt.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: attempt.cacheReadInputTokens }
      : {}),
    ...(attempt.reasoningTokens !== undefined ? { reasoningTokens: attempt.reasoningTokens } : {}),
    ...(attempt.contextWindow !== undefined ? { contextWindow: attempt.contextWindow } : {}),
    ...(attempt.costUsd !== undefined ? { costUsd: attempt.costUsd } : {}),
    costBasis: attempt.costBasis,
    usageBasis: attempt.usageBasis,
  };
}

/** Prefix the runtime gives a written history-compaction boundary. */
const HISTORY_COMPACT_EVENT_PREFIX = 'history-compact:';

/** Causal steps the metering ledger knows nothing about. */
function projectEventSteps(events: readonly RuntimeEvent[]): TraceStep[] {
  const steps: TraceStep[] = [];
  const toolStarts = new Map<string, { id: string; startedAt: number }>();
  const toolStepsByOperation = new Map<string, TraceStep & { kind: 'tool' }>();

  for (const event of events) {
    // A written compaction boundary, which is not the same fact as the
    // summarizer call that produced its text: one is the checkpoint the next
    // request replays from, the other is the spend.
    if (event.id.startsWith(HISTORY_COMPACT_EVENT_PREFIX)) {
      steps.push({
        kind: 'compaction',
        id: event.id,
        turnId: event.turnId,
        runId: event.runId,
        startedAt: event.ts,
        checkpointId: event.id.slice(HISTORY_COMPACT_EVENT_PREFIX.length),
      });
      continue;
    }

    const recovery = event.actions?.toolRecovery;
    if (recovery?.kind === 'maka.tool.recovery_decision') {
      // Correlated by `operationId` rather than by position: the decision is
      // appended by the recovery writer, not by the dispatch it settles.
      const settled = toolStepsByOperation.get(recovery.payload.operationId);
      if (settled) {
        settled.recovered = {
          disposition: recovery.payload.disposition,
          reasonCode: recovery.payload.reasonCode,
        };
      }
      continue;
    }

    const dispatch = event.actions?.toolDispatch;
    if (dispatch) {
      toolStarts.set(dispatch.providerToolCallId, { id: event.id, startedAt: event.ts });
      const step: TraceStep & { kind: 'tool' } = {
        kind: 'tool',
        id: event.id,
        turnId: event.turnId,
        runId: event.runId,
        startedAt: event.ts,
        toolName: dispatch.toolName,
        toolCallId: dispatch.providerToolCallId,
        operationId: dispatch.operationId,
        status: 'in_flight',
        // The declared policy, present on ordinary first executions too. What
        // actually recovered, if anything, arrives as a decision fact above.
        ...(dispatch.recoveryMode ? { recoveryPolicy: dispatch.recoveryMode } : {}),
      };
      toolStepsByOperation.set(dispatch.operationId, step);
      steps.push(step);
      continue;
    }

    if (event.content?.kind === 'function_response') {
      // Settle the dispatch this result answers rather than emitting a second
      // step: a call and its result are one thing to a reader.
      const response = event.content;
      const started = toolStarts.get(response.id);
      const settled = steps.find(
        (step): step is Extract<TraceStep, { kind: 'tool' }> =>
          step.kind === 'tool' && step.id === started?.id,
      );
      if (settled) {
        settled.endedAt = event.ts;
        settled.durationMs = Math.max(0, event.ts - settled.startedAt);
        settled.status = response.isError === true ? 'failed' : 'completed';
      }
      continue;
    }

    const decision = event.actions?.permissionDecision;
    if (decision) {
      steps.push({
        kind: 'permission',
        id: event.id,
        turnId: event.turnId,
        runId: event.runId,
        startedAt: event.ts,
        ...(decision.toolName !== undefined ? { toolName: decision.toolName } : {}),
        decision: decision.decision,
      });
      continue;
    }

    if (event.content?.kind === 'error') {
      steps.push({
        kind: 'error',
        id: event.id,
        turnId: event.turnId,
        runId: event.runId,
        startedAt: event.ts,
        message: event.content.message,
      });
    }
  }

  return steps;
}

/**
 * The first thing that failed, not the last thing that happened.
 *
 * A turn that ends in an error usually ends there *because* of something
 * earlier — a tool that failed, a call that exhausted its retries. Pointing at
 * the terminal event would name the symptom.
 */
export function attributeTurnFailure(
  steps: readonly TraceStep[],
  events: readonly RuntimeEvent[] = [],
): TraceFailureAttribution | undefined {
  // Whether the turn failed is the ledger's call, not the projection's. A tool
  // that errored and was recovered from is a step that failed inside a turn
  // that succeeded, and marking that turn failed would be wrong in the
  // direction that matters — it is the reading a user acts on.
  const terminalStatus = [...events]
    .reverse()
    .find(
      (event) =>
        event.status !== undefined &&
        (TERMINAL_RUNTIME_EVENT_STATUSES as readonly string[]).includes(event.status),
    )?.status;
  if (terminalStatus === 'completed') return undefined;

  const terminalError = [...steps].reverse().find((step) => step.kind === 'error');
  const firstFailure = steps.find(
    (step) =>
      (step.kind === 'tool' && step.status === 'failed') ||
      (step.kind === 'model_call' && step.status === 'failed') ||
      step.kind === 'error',
  );
  // With no terminal verdict and nothing that failed there is nothing to
  // report; a non-completed verdict on its own is still a failed turn.
  if (!terminalError && !firstFailure && terminalStatus === undefined) return undefined;

  const code =
    firstFailure?.kind === 'tool'
      ? 'tool_failed'
      : firstFailure?.kind === 'model_call'
        ? 'model_call_failed'
        : terminalStatus !== undefined
          ? `turn_${terminalStatus}`
          : 'error';
  return {
    code,
    ...(terminalError?.kind === 'error' ? { message: terminalError.message } : {}),
    ...(firstFailure ? { attributedToStepId: firstFailure.id } : {}),
  };
}

function turnTotals(steps: readonly TraceStep[], durationMs: number): TraceTotals {
  const totals = emptyTraceTotals();
  totals.durationMs = Math.max(0, durationMs);

  for (const step of steps) {
    if (step.kind === 'model_call') {
      totals.modelAttempts += step.attempts.length;
      totals.retries += Math.max(0, step.attempts.length - 1);
      if (step.callKind === 'history_compact' || step.callKind === 'semantic_compact') {
        totals.compactions += 1;
      }
      for (const attempt of step.attempts) {
        totals.inputTokens += attempt.inputTokens ?? 0;
        totals.outputTokens += attempt.outputTokens ?? 0;
        if (attempt.costUsd === undefined) totals.unpricedAttempts += 1;
      }
      if (step.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + step.costUsd;
    }
  }

  return totals;
}

function stepEndedAt(step: TraceStep): number {
  if (step.kind === 'model_call') return step.endedAt;
  if (step.kind === 'tool') return step.endedAt ?? step.startedAt;
  return step.startedAt;
}

/** Turn order follows first appearance, so a trace reads in the order it ran. */
function orderedTurnIds(
  events: readonly RuntimeEvent[],
  attempts: readonly ModelCallAttempt[],
): string[] {
  const seen = new Map<string, number>();
  for (const event of events) {
    const at = seen.get(event.turnId);
    if (at === undefined || event.ts < at) seen.set(event.turnId, event.ts);
  }
  for (const attempt of attempts) {
    const at = seen.get(attempt.turnId);
    if (at === undefined || attempt.startedAt < at) seen.set(attempt.turnId, attempt.startedAt);
  }
  return [...seen.entries()].sort((left, right) => left[1] - right[1]).map(([turnId]) => turnId);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return groups;
}
