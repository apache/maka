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

import {
  HISTORY_COMPACT_ROUTES,
  MODEL_CALL_DIAGNOSTIC_FIELD_MAX_LENGTH,
  MODEL_CALL_ATTEMPT_STATUSES,
  MODEL_CALL_COST_BASES,
  MODEL_CALL_KINDS,
  MODEL_CALL_USAGE_BASES,
  type HistoryCompactRoute,
  type ModelCallAttemptStatus,
  type ModelCallKind,
} from './model-call-attempt.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';

/**
 * Per-session causal trace: what happened inside a session's runs, in order,
 * with the cost and latency of the model calls that drove it (#1625).
 *
 * This is a **projection, not a record**. Two authorities feed it and neither is
 * restated here:
 *
 * - `RuntimeEvent` supplies causal structure — tool dispatch, permission
 *   decisions, errors, the shape of a turn.
 * - `ModelCallAttempt` supplies metering — one record per physical provider
 *   request, with the cost frozen at call time (#1679).
 *
 * The projection joins them and reports what it could not see. It never derives
 * a number the ledgers do not carry: an unpriced call has no cost here either,
 * and a backend that emits no canonical records produces a trace that says so
 * rather than one that looks idle.
 */
export const SESSION_TRACE_SCHEMA_VERSION = 1 as const;

/**
 * Why a step exists. Deliberately not the RuntimeEvent content kind: this is the
 * causal vocabulary a reader thinks in ("the model called a tool, the tool
 * failed, the context compacted"), which is a projection of several event
 * shapes rather than a rename of one.
 */
export type TraceStepKind = 'model_call' | 'tool' | 'permission' | 'compaction' | 'error';

/** One physical provider request, as metered. */
export interface TraceModelAttempt {
  attemptId: string;
  /** Retry ordinal within the logical call; 0 is the first dispatch. */
  attempt: number;
  status: ModelCallAttemptStatus;
  startedAt: number;
  completedAt: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
  errorClass?: string;
  httpStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
  retryable?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningTokens?: number;
  /**
   * The context window the call was metered against, frozen at call time.
   * Passed through so a reader can set the prompt size against the ceiling it
   * was actually run under, rather than against whatever a catalog says today.
   */
  contextWindow?: number;
  /**
   * Absent when the record carries no price. Never rendered as zero: a call
   * nobody could price and a call that was free are different facts, and the
   * canonical record keeps them apart (#1679).
   */
  costUsd?: number;
  /** Whether the amount above is real, and if not, why there isn't one. */
  costBasis: 'priced' | 'unpriced';
  /** Whether the tokens above were reported by the provider or are partial. */
  usageBasis: 'reported' | 'partial' | 'missing';
}

/**
 * One logical model call and every attempt of it.
 *
 * Retries are nested rather than flattened because "this call was retried three
 * times" is the fact a reader is looking for; a flat list of four steps that
 * happen to share an id makes them reconstruct it.
 */
export interface TraceModelCallStep {
  kind: 'model_call';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  callKind: ModelCallKind;
  /** How a history-compaction call reduced the covered conversation. */
  historyCompactRoute?: HistoryCompactRoute;
  providerId: string;
  modelId: string;
  connectionSlug?: string;
  /** Runtime tool-loop step index within the turn. */
  step: number;
  attempts: TraceModelAttempt[];
  /** Terminal status of the last attempt. */
  status: ModelCallAttemptStatus;
  /** Sum over attempts that carry a price; absent when none do. */
  costUsd?: number;
}

/**
 * A durable recovery decision, correlated to a dispatch by `operationId`.
 *
 * Separate from the policy below because they answer different questions. Every
 * dispatch declares a `recoveryPolicy`, including ordinary first executions;
 * only a recovery that actually happened writes one of these.
 */
export interface TraceToolRecovery {
  disposition: 'completed' | 'parked';
  reasonCode: string;
}

export interface TraceToolStep {
  kind: 'tool';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  toolName: string;
  toolCallId?: string;
  operationId?: string;
  status: 'completed' | 'failed' | 'in_flight';
  /**
   * What the dispatch declared it would be safe to do on resume. Present on
   * normal executions too — it is a policy, not evidence that anything was
   * recovered.
   */
  recoveryPolicy?: string;
  /** Present only when a recovery decision was durably recorded. */
  recovered?: TraceToolRecovery;
}

export interface TracePermissionStep {
  kind: 'permission';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  toolName?: string;
  decision: string;
}

/**
 * A compaction boundary that was durably written — the checkpoint the next
 * request replays from.
 *
 * Distinct from a `history_compact` model call, which is the summarizer request
 * that produced the text. One is the spend, the other is the boundary; a turn
 * can show either without the other.
 */
export interface TraceCompactionStep {
  kind: 'compaction';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  /** Checkpoint identity, when the boundary carries one. */
  checkpointId?: string;
}

export interface TraceErrorStep {
  kind: 'error';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  message: string;
}

export type TraceStep =
  | TraceModelCallStep
  | TraceToolStep
  | TracePermissionStep
  | TraceCompactionStep
  | TraceErrorStep;

/**
 * What ended a turn badly, and what the trace believes caused it.
 *
 * `attributedToStepId` is a claim about *sequence*, not about intent: the step
 * that failed first. The projection does not diagnose; it points at evidence.
 */
export interface TraceFailureAttribution {
  code: string;
  message?: string;
  attributedToStepId?: string;
}

export interface TurnTrace {
  turnId: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  steps: TraceStep[];
  failure?: TraceFailureAttribution;
}

export interface TraceTurnIdentity {
  runId: string;
  turnId: string;
}

const TRACE_TURN_IDENTITY_SHAPE = defineObjectShape<TraceTurnIdentity>()(['runId', 'turnId'], []);

export function traceTurnIdentityKey(identity: TraceTurnIdentity): string {
  return `${identity.runId}\0${identity.turnId}`;
}

/**
 * What the trace could not see.
 *
 * Stated per session rather than inferred per view, because incompleteness that
 * only shows as an empty timeline is indistinguishable from an idle session —
 * and the pi backend produces exactly that: `token_usage` events with no
 * canonical records behind them.
 */
export interface SessionTraceCoverage {
  /**
   * `no_known_gap` — nothing detectable is missing. Deliberately not
   * "complete": present settlements cannot prove that every call settled, so
   * this states the absence of evidence of a gap, not the presence of proof.
   * `partial` — a shortfall is detectable, either a turn with aggregate usage
   * and no records, or fewer main calls than the aggregate says it stood for.
   * `absent` — model activity with no canonical records anywhere, which is what
   * a backend outside canonical accounting looks like.
   * `none` — no model activity to cover.
   */
  modelCalls: 'no_known_gap' | 'partial' | 'absent' | 'none';
  /** Turns with aggregate usage but no canonical record behind them. */
  turnsMissingModelCalls: TraceTurnIdentity[];
  /**
   * Canonical records the reader could not read or decode.
   *
   * Counted rather than dropped: spend the trace cannot show is the difference
   * between a gap that is visible and one that is not. The unit is deliberately
   * loose — a run whose events cannot be read at all counts as one, because
   * nothing is known about how many records it held. Read it as a floor.
   */
  unreadableRecords: number;
  /** Runs whose durable evidence exists but exceeds the bounded online view. */
  oversizedRuns: number;
  /**
   * Turns where the aggregate usage stands for more runtime steps than there
   * are main model calls on record. A shortfall this narrow is still only what
   * the ledgers disagree about — it is a floor on what is missing, not a count.
   */
  turnsWithFewerModelCallsThanSteps: TraceTurnIdentity[];
}

export interface SessionTrace {
  schemaVersion: typeof SESSION_TRACE_SCHEMA_VERSION;
  sessionId: string;
  turns: TurnTrace[];
  coverage: SessionTraceCoverage;
}

const SESSION_TRACE_SHAPE = defineObjectShape<SessionTrace>()(
  ['schemaVersion', 'sessionId', 'turns', 'coverage'],
  [],
);
const TRACE_COVERAGE_SHAPE = defineObjectShape<SessionTraceCoverage>()(
  [
    'modelCalls',
    'turnsMissingModelCalls',
    'unreadableRecords',
    'oversizedRuns',
    'turnsWithFewerModelCallsThanSteps',
  ],
  [],
);
const TURN_TRACE_SHAPE = defineObjectShape<TurnTrace>()(
  ['turnId', 'runId', 'startedAt', 'endedAt', 'durationMs', 'steps'],
  ['failure'],
);
const TRACE_FAILURE_SHAPE = defineObjectShape<TraceFailureAttribution>()(
  ['code'],
  ['message', 'attributedToStepId'],
);
const MODEL_CALL_STEP_SHAPE = defineObjectShape<TraceModelCallStep>()(
  [
    'kind',
    'id',
    'turnId',
    'runId',
    'startedAt',
    'endedAt',
    'durationMs',
    'callKind',
    'providerId',
    'modelId',
    'step',
    'attempts',
    'status',
  ],
  ['connectionSlug', 'historyCompactRoute', 'costUsd'],
);
const MODEL_ATTEMPT_SHAPE = defineObjectShape<TraceModelAttempt>()(
  [
    'attemptId',
    'attempt',
    'status',
    'startedAt',
    'completedAt',
    'latencyMs',
    'costBasis',
    'usageBasis',
  ],
  [
    'timeToFirstTokenMs',
    'finishReason',
    'errorClass',
    'httpStatus',
    'providerCode',
    'providerRequestId',
    'retryable',
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'reasoningTokens',
    'contextWindow',
    'costUsd',
  ],
);
const TOOL_STEP_SHAPE = defineObjectShape<TraceToolStep>()(
  ['kind', 'id', 'turnId', 'runId', 'startedAt', 'toolName', 'status'],
  ['endedAt', 'durationMs', 'toolCallId', 'operationId', 'recoveryPolicy', 'recovered'],
);
const TOOL_RECOVERY_SHAPE = defineObjectShape<TraceToolRecovery>()(
  ['disposition', 'reasonCode'],
  [],
);
const PERMISSION_STEP_SHAPE = defineObjectShape<TracePermissionStep>()(
  ['kind', 'id', 'turnId', 'runId', 'startedAt', 'decision'],
  ['toolName'],
);
const COMPACTION_STEP_SHAPE = defineObjectShape<TraceCompactionStep>()(
  ['kind', 'id', 'turnId', 'runId', 'startedAt'],
  ['checkpointId'],
);
const ERROR_STEP_SHAPE = defineObjectShape<TraceErrorStep>()(
  ['kind', 'id', 'turnId', 'runId', 'startedAt', 'message'],
  [],
);

export function isSessionTrace(value: unknown): value is SessionTrace {
  return (
    isRecord(value) &&
    hasExactShape(value, SESSION_TRACE_SHAPE) &&
    value.schemaVersion === SESSION_TRACE_SCHEMA_VERSION &&
    typeof value.sessionId === 'string' &&
    Array.isArray(value.turns) &&
    value.turns.every(isTurnTrace) &&
    isTraceCoverage(value.coverage)
  );
}

export function isTurnTrace(value: unknown): value is TurnTrace {
  return (
    isRecord(value) &&
    hasExactShape(value, TURN_TRACE_SHAPE) &&
    typeof value.turnId === 'string' &&
    typeof value.runId === 'string' &&
    isNonnegativeNumber(value.startedAt) &&
    isNonnegativeNumber(value.endedAt) &&
    isNonnegativeNumber(value.durationMs) &&
    Array.isArray(value.steps) &&
    value.steps.every(isTraceStep) &&
    (value.failure === undefined || isTraceFailure(value.failure))
  );
}

function isTraceCoverage(value: unknown): value is SessionTraceCoverage {
  return (
    isRecord(value) &&
    hasExactShape(value, TRACE_COVERAGE_SHAPE) &&
    (value.modelCalls === 'no_known_gap' ||
      value.modelCalls === 'partial' ||
      value.modelCalls === 'absent' ||
      value.modelCalls === 'none') &&
    isTraceTurnIdentityArray(value.turnsMissingModelCalls) &&
    isTraceTurnIdentityArray(value.turnsWithFewerModelCallsThanSteps) &&
    isNonnegativeInteger(value.unreadableRecords) &&
    isNonnegativeInteger(value.oversizedRuns)
  );
}

function isTraceFailure(value: unknown): value is TraceFailureAttribution {
  return (
    isRecord(value) &&
    hasExactShape(value, TRACE_FAILURE_SHAPE) &&
    typeof value.code === 'string' &&
    isOptionalString(value.message) &&
    isOptionalString(value.attributedToStepId)
  );
}

function isTraceStep(value: unknown): value is TraceStep {
  if (!isRecord(value)) return false;
  if (value.kind === 'model_call') return isModelCallStep(value);
  if (value.kind === 'tool') return isToolStep(value);
  const common =
    typeof value.id === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.runId === 'string' &&
    isNonnegativeNumber(value.startedAt);
  if (value.kind === 'permission') {
    return (
      hasExactShape(value, PERMISSION_STEP_SHAPE) &&
      common &&
      isOptionalString(value.toolName) &&
      typeof value.decision === 'string'
    );
  }
  if (value.kind === 'compaction') {
    return (
      hasExactShape(value, COMPACTION_STEP_SHAPE) && common && isOptionalString(value.checkpointId)
    );
  }
  return (
    value.kind === 'error' &&
    hasExactShape(value, ERROR_STEP_SHAPE) &&
    common &&
    typeof value.message === 'string'
  );
}

function isModelCallStep(value: Record<string, unknown>): boolean {
  return (
    hasExactShape(value, MODEL_CALL_STEP_SHAPE) &&
    [value.id, value.turnId, value.runId, value.providerId, value.modelId].every(
      (item) => typeof item === 'string',
    ) &&
    [value.startedAt, value.endedAt, value.durationMs].every(isNonnegativeNumber) &&
    MODEL_CALL_KINDS.includes(value.callKind as ModelCallKind) &&
    (value.historyCompactRoute === undefined ||
      (value.callKind === 'history_compact' &&
        HISTORY_COMPACT_ROUTES.includes(value.historyCompactRoute as HistoryCompactRoute))) &&
    isOptionalString(value.connectionSlug) &&
    isNonnegativeInteger(value.step) &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isModelAttempt) &&
    MODEL_CALL_ATTEMPT_STATUSES.includes(value.status as ModelCallAttemptStatus) &&
    isOptionalNonnegativeNumber(value.costUsd)
  );
}

function isModelAttempt(value: unknown): value is TraceModelAttempt {
  return (
    isRecord(value) &&
    hasExactShape(value, MODEL_ATTEMPT_SHAPE) &&
    typeof value.attemptId === 'string' &&
    isNonnegativeInteger(value.attempt) &&
    MODEL_CALL_ATTEMPT_STATUSES.includes(value.status as ModelCallAttemptStatus) &&
    [value.startedAt, value.completedAt, value.latencyMs].every(isNonnegativeNumber) &&
    [
      value.timeToFirstTokenMs,
      value.inputTokens,
      value.outputTokens,
      value.cacheReadInputTokens,
      value.reasoningTokens,
      value.contextWindow,
      value.costUsd,
    ].every(isOptionalNonnegativeNumber) &&
    isOptionalString(value.finishReason) &&
    isOptionalString(value.errorClass) &&
    isOptionalHttpStatus(value.httpStatus) &&
    isOptionalDiagnosticString(value.providerCode) &&
    isOptionalDiagnosticString(value.providerRequestId) &&
    (value.retryable === undefined || typeof value.retryable === 'boolean') &&
    MODEL_CALL_COST_BASES.includes(value.costBasis as TraceModelAttempt['costBasis']) &&
    MODEL_CALL_USAGE_BASES.includes(value.usageBasis as TraceModelAttempt['usageBasis'])
  );
}

function isOptionalHttpStatus(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599)
  );
}

function isOptionalDiagnosticString(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MODEL_CALL_DIAGNOSTIC_FIELD_MAX_LENGTH)
  );
}

function isToolStep(value: Record<string, unknown>): boolean {
  return (
    hasExactShape(value, TOOL_STEP_SHAPE) &&
    [value.id, value.turnId, value.runId, value.toolName].every(
      (item) => typeof item === 'string',
    ) &&
    isNonnegativeNumber(value.startedAt) &&
    isOptionalNonnegativeNumber(value.endedAt) &&
    isOptionalNonnegativeNumber(value.durationMs) &&
    [value.toolCallId, value.operationId, value.recoveryPolicy].every(isOptionalString) &&
    (value.status === 'completed' || value.status === 'failed' || value.status === 'in_flight') &&
    (value.recovered === undefined || isToolRecovery(value.recovered))
  );
}

function isToolRecovery(value: unknown): value is TraceToolRecovery {
  return (
    isRecord(value) &&
    hasExactShape(value, TOOL_RECOVERY_SHAPE) &&
    (value.disposition === 'completed' || value.disposition === 'parked') &&
    typeof value.reasonCode === 'string'
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isOptionalNonnegativeNumber(value: unknown): boolean {
  return value === undefined || isNonnegativeNumber(value);
}

/**
 * Combines coverage from disjoint trace partitions.
 *
 * Callers own the disjointness proof. Keeping that precondition explicit is
 * what makes unreadable-record addition truthful: refreshing one partition
 * must replace it before this fold runs, never merge it with its former value.
 */
export function mergeDisjointTraceCoverage(
  base: SessionTraceCoverage,
  next: SessionTraceCoverage,
): SessionTraceCoverage {
  const modelCalls =
    base.modelCalls === 'none'
      ? next.modelCalls
      : next.modelCalls === 'none'
        ? base.modelCalls
        : base.modelCalls === 'absent' && next.modelCalls === 'absent'
          ? 'absent'
          : base.modelCalls === 'no_known_gap' && next.modelCalls === 'no_known_gap'
            ? 'no_known_gap'
            : 'partial';
  return {
    modelCalls,
    turnsMissingModelCalls: mergeTraceTurnIdentities(
      base.turnsMissingModelCalls,
      next.turnsMissingModelCalls,
    ),
    turnsWithFewerModelCallsThanSteps: mergeTraceTurnIdentities(
      base.turnsWithFewerModelCallsThanSteps,
      next.turnsWithFewerModelCallsThanSteps,
    ),
    unreadableRecords: base.unreadableRecords + next.unreadableRecords,
    oversizedRuns: base.oversizedRuns + next.oversizedRuns,
  };
}

/**
 * Combines independently read pages of one Session trace.
 *
 * Page boundaries are transport detail: callers receive the same ordered,
 * deduplicated trace they would have received from one bounded projection.
 */
export function mergeSessionTraces(traces: readonly SessionTrace[]): SessionTrace {
  const first = traces[0];
  if (!first) throw new Error('At least one Session trace page is required');
  return traces.slice(1).reduce((current, page) => {
    if (page.schemaVersion !== current.schemaVersion || page.sessionId !== current.sessionId) {
      throw new Error('Session trace pages do not describe the same Session');
    }
    const turns = new Map(current.turns.map((turn) => [traceTurnIdentityKey(turn), turn] as const));
    for (const turn of page.turns) turns.set(traceTurnIdentityKey(turn), turn);
    const ordered = [...turns.values()].sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.runId.localeCompare(right.runId) ||
        left.turnId.localeCompare(right.turnId),
    );
    return {
      schemaVersion: current.schemaVersion,
      sessionId: current.sessionId,
      turns: ordered,
      coverage: mergeDisjointTraceCoverage(current.coverage, page.coverage),
    };
  }, first);
}

function isTraceTurnIdentityArray(value: unknown): value is TraceTurnIdentity[] {
  return (
    Array.isArray(value) &&
    value.every(
      (identity) =>
        isRecord(identity) &&
        hasExactShape(identity, TRACE_TURN_IDENTITY_SHAPE) &&
        typeof identity.runId === 'string' &&
        identity.runId.length > 0 &&
        typeof identity.turnId === 'string' &&
        identity.turnId.length > 0,
    )
  );
}

function mergeTraceTurnIdentities(
  base: readonly TraceTurnIdentity[],
  next: readonly TraceTurnIdentity[],
): TraceTurnIdentity[] {
  return [
    ...new Map(
      [...base, ...next].map((identity) => [traceTurnIdentityKey(identity), identity]),
    ).values(),
  ];
}
