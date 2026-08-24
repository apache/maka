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
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';
import { MODEL_CALL_KINDS, type ModelCallKind, type PricingConfig } from './usage-stats/types.js';

export { MODEL_CALL_KINDS, type ModelCallKind } from './usage-stats/types.js';

/**
 * Canonical accounting record for one physical provider request attempt.
 *
 * This is the metering source of truth: every real model call that is dispatched
 * to a provider settles into exactly one `ModelCallAttempt`. Aggregate token
 * usage on `RuntimeEvent` remains a per-turn projection for replay and recovery;
 * it is not an accounting authority and is not derived from these records.
 *
 * Two properties are deliberate and must survive future edits:
 *
 * - `costUsd` is absent unless `costBasis` is `'priced'`. A zero cost means the
 *   call was genuinely free, never that the price was unknown.
 * - These records are authoritative only for the calls they contain. A crash
 *   between provider dispatch and settlement leaves no record and no way to
 *   detect the omission, so no consumer may treat a set of attempts as proof of
 *   completeness. See {@link ModelCallCoverage}.
 */
export const MODEL_CALL_ATTEMPT_SCHEMA_VERSION = 1 as const;

/** AgentRun event type carrying a {@link ModelCallAttempt} in `data`. */
export const MODEL_CALL_ATTEMPT_EVENT_TYPE = 'model_call_attempt_recorded' as const;

export const MODEL_CALL_ATTEMPT_STATUSES = [
  'completed',
  'failed',
  'interrupted',
  'aborted',
] as const;
export type ModelCallAttemptStatus = (typeof MODEL_CALL_ATTEMPT_STATUSES)[number];

/**
 * Whether the provider reported usage for this attempt. Distinct from
 * {@link ModelCallCostBasis}: "the provider never reported tokens" and "we have
 * tokens but no price for this model" are different failures and must not
 * collapse into one counter.
 */
export const MODEL_CALL_USAGE_BASES = ['reported', 'partial', 'missing'] as const;
export type ModelCallUsageBasis = (typeof MODEL_CALL_USAGE_BASES)[number];

/** Whether a price could be resolved for this attempt at record time. */
export const MODEL_CALL_COST_BASES = ['priced', 'unpriced'] as const;
export type ModelCallCostBasis = (typeof MODEL_CALL_COST_BASES)[number];

/** How a history-compaction call reduced the covered conversation. */
export const HISTORY_COMPACT_ROUTES = ['text_summary', 'provider_native'] as const;
export type HistoryCompactRoute = (typeof HISTORY_COMPACT_ROUTES)[number];

/** Hard bound for provider-supplied diagnostic identifiers stored on an attempt. */
export const MODEL_CALL_DIAGNOSTIC_FIELD_MAX_LENGTH = 256;

export interface ModelCallAttempt {
  schemaVersion: typeof MODEL_CALL_ATTEMPT_SCHEMA_VERSION;

  /**
   * One logical model call. Every attempt of the same call — first try and each
   * retry — shares this id. Explicit rather than reconstructed from
   * `(traceId, step)`, because a compound key that each consumer has to rebuild
   * is the kind of implicit contract this record exists to remove.
   */
  logicalCallId: string;
  /** Idempotency key: appending the same `attemptId` twice records once. */
  attemptId: string;
  /** Tracker instance id, retained to join request-shape capture artifacts. */
  traceId: string;

  /**
   * Session, run, and turn the call belongs to. This payload identity is the
   * portable source of truth: when the record is written as an AgentRun event it
   * must agree with the envelope, so a record stays attributable on its own once
   * it leaves the event stream.
   */
  sessionId: string;
  runId: string;
  turnId: string;

  /** Runtime tool-loop step index within the turn. */
  step: number;
  /** Retry ordinal within the logical call; 0 is the first dispatch. */
  attempt: number;

  callKind: ModelCallKind;
  /** Present on history-compaction calls when the selected route is known. */
  historyCompactRoute?: HistoryCompactRoute;
  connectionSlug?: string;
  providerId: string;
  modelId: string;
  contextWindow?: number;
  /** Join key for request-shape diagnostics; absent when capture is disabled. */
  captureArtifactId?: string;

  startedAt: number;
  completedAt: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;

  status: ModelCallAttemptStatus;
  finishReason?: string;
  errorClass?: string;
  httpStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
  retryable?: boolean;

  usageBasis: ModelCallUsageBasis;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;

  costBasis: ModelCallCostBasis;
  /** Present only when `costBasis` is `'priced'`. Frozen at record time. */
  costUsd?: number;
  /** Pricing authority revision the cost was computed against. */
  pricingRevision?: number;
  /** Rates actually applied, so a recorded amount stays auditable. */
  pricingRates?: PricingConfig;
}

const MODEL_CALL_ATTEMPT_SHAPE = defineObjectShape<ModelCallAttempt>()(
  [
    'schemaVersion',
    'logicalCallId',
    'attemptId',
    'traceId',
    'sessionId',
    'runId',
    'turnId',
    'step',
    'attempt',
    'callKind',
    'providerId',
    'modelId',
    'startedAt',
    'completedAt',
    'latencyMs',
    'status',
    'usageBasis',
    'costBasis',
  ],
  [
    'connectionSlug',
    'historyCompactRoute',
    'contextWindow',
    'captureArtifactId',
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
    'cacheMissInputTokens',
    'cacheWriteInputTokens',
    'reasoningTokens',
    'costUsd',
    'pricingRevision',
    'pricingRates',
  ],
);

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheMissInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
] as const satisfies readonly (keyof ModelCallAttempt)[];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function isOptionalDiagnosticString(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MODEL_CALL_DIAGNOSTIC_FIELD_MAX_LENGTH)
  );
}

function isOptionalHttpStatus(value: unknown): boolean {
  return (
    value === undefined ||
    (isFiniteNumber(value) && Number.isInteger(value) && value >= 100 && value <= 599)
  );
}

const PRICING_RATES_SHAPE = defineObjectShape<PricingConfig>()(
  ['modelKey', 'inputUsdPer1M', 'outputUsdPer1M'],
  ['cacheReadUsdPer1M', 'cacheWriteUsdPer1M'],
);

/**
 * Audit-quality gate on the rates a cost was computed against. Held to the same
 * exact shape as the top-level record: a negative rate or an unrecognized nested
 * key makes a recorded amount unexplainable, which defeats the point of storing
 * the basis at all.
 */
function isPricingRates(value: unknown): value is PricingConfig {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasExactShape(value, PRICING_RATES_SHAPE)) return false;
  return (
    typeof value.modelKey === 'string' &&
    value.modelKey.length > 0 &&
    isNonNegativeNumber(value.inputUsdPer1M) &&
    isNonNegativeNumber(value.outputUsdPer1M) &&
    isOptionalNonNegativeNumber(value.cacheReadUsdPer1M) &&
    isOptionalNonNegativeNumber(value.cacheWriteUsdPer1M)
  );
}

/**
 * Strict subtype codec. The generic AgentRun event decoder only checks that
 * `data` is a record, which is not enough for an accounting record — an
 * unvalidated field silently becomes a wrong number in a cost report.
 */
export function decodeModelCallAttempt(value: unknown): ModelCallAttempt {
  if (!isRecord(value) || !hasExactShape(value, MODEL_CALL_ATTEMPT_SHAPE)) {
    throw new Error('Invalid ModelCallAttempt schema');
  }
  const valid =
    value.schemaVersion === MODEL_CALL_ATTEMPT_SCHEMA_VERSION &&
    isNonEmptyString(value.logicalCallId) &&
    isNonEmptyString(value.attemptId) &&
    isNonEmptyString(value.traceId) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.turnId) &&
    isNonNegativeInteger(value.step) &&
    isNonNegativeInteger(value.attempt) &&
    (MODEL_CALL_KINDS as readonly unknown[]).includes(value.callKind) &&
    (value.historyCompactRoute === undefined ||
      (HISTORY_COMPACT_ROUTES as readonly unknown[]).includes(value.historyCompactRoute)) &&
    isOptionalString(value.connectionSlug) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId) &&
    isOptionalNonNegativeNumber(value.contextWindow) &&
    isOptionalString(value.captureArtifactId) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.completedAt) &&
    isNonNegativeNumber(value.latencyMs) &&
    isOptionalNonNegativeNumber(value.timeToFirstTokenMs) &&
    (MODEL_CALL_ATTEMPT_STATUSES as readonly unknown[]).includes(value.status) &&
    isOptionalString(value.finishReason) &&
    isOptionalDiagnosticString(value.errorClass) &&
    isOptionalHttpStatus(value.httpStatus) &&
    isOptionalDiagnosticString(value.providerCode) &&
    isOptionalDiagnosticString(value.providerRequestId) &&
    (value.retryable === undefined || typeof value.retryable === 'boolean') &&
    (MODEL_CALL_USAGE_BASES as readonly unknown[]).includes(value.usageBasis) &&
    TOKEN_FIELDS.every((field) => isOptionalNonNegativeNumber(value[field])) &&
    (MODEL_CALL_COST_BASES as readonly unknown[]).includes(value.costBasis) &&
    isOptionalNonNegativeNumber(value.costUsd) &&
    isOptionalNonNegativeNumber(value.pricingRevision) &&
    isPricingRates(value.pricingRates);
  if (!valid) throw new Error('Invalid ModelCallAttempt schema');

  const startedAt = value.startedAt as number;
  const completedAt = value.completedAt as number;
  if (completedAt < startedAt) {
    throw new Error('ModelCallAttempt completedAt precedes startedAt');
  }
  if (value.historyCompactRoute !== undefined && value.callKind !== 'history_compact') {
    throw new Error('ModelCallAttempt non-compaction call carries historyCompactRoute');
  }
  // `costBasis` and `costUsd` travel together in both directions. A price we
  // could not resolve must never be published as an amount, and a priced record
  // must carry one — otherwise coverage counts it as priced while the sum skips
  // it, and "every call priced, total $0" reads as genuinely free. Zero stays
  // legal, and is the only way to say a call cost nothing.
  if (value.costBasis === 'unpriced' && value.costUsd !== undefined) {
    throw new Error('ModelCallAttempt unpriced record carries a cost');
  }
  if (value.costBasis === 'priced' && value.costUsd === undefined) {
    throw new Error('ModelCallAttempt priced record carries no cost');
  }
  if (value.usageBasis === 'missing' && TOKEN_FIELDS.some((f) => value[f] !== undefined)) {
    throw new Error('ModelCallAttempt reports missing usage but carries tokens');
  }
  return value as unknown as ModelCallAttempt;
}

export function isModelCallAttempt(value: unknown): value is ModelCallAttempt {
  try {
    decodeModelCallAttempt(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collapses re-appended records by `attemptId`, keeping the last occurrence.
 *
 * Order is the caller's append order, never `ts`: attempt events are appended
 * asynchronously and carry the provider settlement time, so timestamp order and
 * append order disagree.
 */
export function dedupeModelCallAttempts(attempts: readonly ModelCallAttempt[]): ModelCallAttempt[] {
  const byId = new Map<string, ModelCallAttempt>();
  for (const attempt of attempts) byId.set(attempt.attemptId, attempt);
  return [...byId.values()];
}

/** Attempts of one logical model call, in append order. */
export interface ModelCallGroup {
  logicalCallId: string;
  attempts: ModelCallAttempt[];
}

/**
 * Groups attempts into logical calls. Retries are not separate calls: they are
 * additional attempts of the same `logicalCallId`.
 */
export function groupModelCallAttempts(attempts: readonly ModelCallAttempt[]): ModelCallGroup[] {
  const groups = new Map<string, ModelCallGroup>();
  for (const attempt of dedupeModelCallAttempts(attempts)) {
    const existing = groups.get(attempt.logicalCallId);
    if (existing) existing.attempts.push(attempt);
    else
      groups.set(attempt.logicalCallId, {
        logicalCallId: attempt.logicalCallId,
        attempts: [attempt],
      });
  }
  return [...groups.values()];
}

/**
 * The attempt that settled a logical call: the highest `attempt` ordinal that
 * reached a provider outcome. Terminality is a projection concern, not a stored
 * field, so it is derived rather than recorded.
 */
export function settledAttempt(group: ModelCallGroup): ModelCallAttempt | undefined {
  let settled: ModelCallAttempt | undefined;
  for (const attempt of group.attempts) {
    if (!settled || attempt.attempt > settled.attempt) settled = attempt;
  }
  return settled;
}

/**
 * Extracts the canonical attempts a run committed, from that run's AgentRun
 * events. This is the projection the Usage read model is rebuilt through, so it
 * has to be total: an event that cannot be decoded is counted, not thrown, or
 * one bad record would block every later one in the same run from ever being
 * projected.
 */
export function modelCallAttemptsFromRunEvents(
  events: readonly { readonly type: string; readonly data?: Record<string, unknown> }[],
): { attempts: ModelCallAttempt[]; unreadableEvents: number } {
  const attempts: ModelCallAttempt[] = [];
  let unreadableEvents = 0;
  for (const event of events) {
    if (event.type !== MODEL_CALL_ATTEMPT_EVENT_TYPE) continue;
    try {
      attempts.push(decodeModelCallAttempt(event.data));
    } catch {
      unreadableEvents += 1;
    }
  }
  return { attempts, unreadableEvents };
}

/**
 * Classification of the records present in a set.
 *
 * This is not a completeness proof and must never be presented as one. Nothing
 * records an expected dispatch count, so an attempt lost between dispatch and
 * settlement is invisible here. A total cost shown without this breakdown
 * overstates what the ledger knows.
 */
export interface ModelCallCoverage {
  attempts: number;
  pricedAttempts: number;
  /** Real spend whose price could not be resolved. */
  unpricedAttempts: number;
  usageReportedAttempts: number;
  usagePartialAttempts: number;
  /** Dispatched calls the provider never reported usage for. */
  usageMissingAttempts: number;
}

export function summarizeModelCallCoverage(
  attempts: readonly ModelCallAttempt[],
): ModelCallCoverage {
  const unique = dedupeModelCallAttempts(attempts);
  const coverage: ModelCallCoverage = {
    attempts: unique.length,
    pricedAttempts: 0,
    unpricedAttempts: 0,
    usageReportedAttempts: 0,
    usagePartialAttempts: 0,
    usageMissingAttempts: 0,
  };
  for (const attempt of unique) {
    if (attempt.costBasis === 'priced') coverage.pricedAttempts += 1;
    else coverage.unpricedAttempts += 1;
    if (attempt.usageBasis === 'reported') coverage.usageReportedAttempts += 1;
    else if (attempt.usageBasis === 'partial') coverage.usagePartialAttempts += 1;
    else coverage.usageMissingAttempts += 1;
  }
  return coverage;
}

/**
 * Sums cost across attempts. Returns the total alongside the coverage that
 * qualifies it, because a bare number cannot express "plus an unknown amount
 * from unpriced calls".
 */
export function sumModelCallCostUsd(attempts: readonly ModelCallAttempt[]): {
  costUsd: number;
  coverage: ModelCallCoverage;
} {
  const unique = dedupeModelCallAttempts(attempts);
  let costUsd = 0;
  for (const attempt of unique) {
    if (attempt.costBasis === 'priced' && attempt.costUsd !== undefined) costUsd += attempt.costUsd;
  }
  return { costUsd, coverage: summarizeModelCallCoverage(unique) };
}
