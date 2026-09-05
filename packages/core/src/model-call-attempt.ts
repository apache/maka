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

export const PREPARED_REQUEST_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const PREPARED_REQUEST_OBSERVATION_MAX_SEGMENTS = 256;
export const PREPARED_REQUEST_OBSERVATION_TEXT_MAX_LENGTH = 256;

export type PreparedRequestObservationSegmentKind =
  | 'tool_schema'
  | 'system_prompt'
  | 'message'
  | 'provider_options';

/**
 * One ordered semantic part of what Maka handed to the AI SDK model-call seam.
 *
 * `opaque` means the digest is useful for identity and auditing but MUST NOT be
 * used to claim exact equality. It covers redacted content and bounded
 * remainders that intentionally summarize more than one source segment.
 */
export interface PreparedRequestObservationSegment {
  kind: PreparedRequestObservationSegmentKind;
  index: number;
  cacheable: boolean;
  comparison: 'exact' | 'opaque';
  digest: string;
  bytes: number;
  /** Present only on an opaque bounded remainder; the value is the source-segment count. */
  representedSegments?: number;
  role?: string;
  label?: string;
}

export type PromptCompositionSegmentKind =
  | 'system_instructions'
  | 'tool_definitions'
  | 'messages'
  | 'other';

/**
 * One part of a prepared request, measured in bytes of serialized request.
 *
 * Bytes only. `bytes / 4` is a rule of thumb over serialized JSON — wrong in a
 * direction nobody here can correct for, badly so for an attachment's base64 —
 * so the estimate is made where it is shown and labelled `≈` there. A figure
 * rounded into this contract could no longer be labelled at all (#2323).
 */
export interface PromptCompositionSegment {
  kind: PromptCompositionSegmentKind;
  bytes: number;
}

/** One tool's schema, sized on its own, so a reader knows which to remove. */
export interface PromptCompositionTool {
  name: string;
  bytes: number;
}

/**
 * What a prepared request was made of, folded at the moment it was prepared.
 *
 * This is the whole durable answer to "what filled the context". The per-part
 * detail it folds is not kept: every reader wanted these buckets, so storing
 * the parts meant writing hundreds of rows per call for a fold nobody could
 * do differently.
 */
export interface PromptComposition {
  segments: PromptCompositionSegment[];
  /** The largest named tool schemas, largest first; bounded at the fold. */
  tools?: PromptCompositionTool[];
  /** Everything past the named rows, so the bytes still account for every tool. */
  remainingTools?: { count: number; bytes: number };
  /** Tool schemas the payload did not name, so their bytes are still counted. */
  unlabelledToolBytes?: number;
}

/**
 * Bounded, secret-free observation of one prepared semantic model request.
 *
 * Historical only: `promptComposition` replaced it. Attempts recorded before
 * that still carry it, and folding their segments is the only way to say what
 * those requests were made of, so it stays decodable.
 */
export interface PreparedRequestObservation {
  schemaVersion: typeof PREPARED_REQUEST_OBSERVATION_SCHEMA_VERSION;
  /**
   * Identity of the complete secret-free normalized serialization. It does not
   * prove semantic equality when any segment is `opaque`; continuity consumers
   * must compare the ordered segment identity and each segment's `comparison`.
   */
  digest: string;
  bytes: number;
  segments: PreparedRequestObservationSegment[];
}

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
  /** Tracker instance id, retained to join private prepared-request artifacts. */
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
  /**
   * Join key for the private prepared-request artifact.
   *
   * Historical only: nothing writes it any more. Every capture was a copy of
   * the conversation the run already stores, and the copies grew with the
   * conversation. Attempts recorded before that sink was removed still carry
   * the key, so it stays decodable.
   */
  captureArtifactId?: string;
  /** What the request prepared for this dispatched physical attempt was made of. */
  promptComposition?: PromptComposition;
  /** Replaced by `promptComposition`; still read on attempts recorded before it. */
  requestObservation?: PreparedRequestObservation;

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
    'promptComposition',
    'requestObservation',
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

const PREPARED_REQUEST_OBSERVATION_SHAPE = defineObjectShape<PreparedRequestObservation>()(
  ['schemaVersion', 'digest', 'bytes', 'segments'],
  [],
);

const PREPARED_REQUEST_OBSERVATION_SEGMENT_SHAPE =
  defineObjectShape<PreparedRequestObservationSegment>()(
    ['kind', 'index', 'cacheable', 'comparison', 'digest', 'bytes'],
    ['representedSegments', 'role', 'label'],
  );

const PREPARED_REQUEST_SEGMENT_KINDS: readonly PreparedRequestObservationSegmentKind[] = [
  'tool_schema',
  'system_prompt',
  'message',
  'provider_options',
];

const PROMPT_COMPOSITION_SHAPE = defineObjectShape<PromptComposition>()(
  ['segments'],
  ['tools', 'remainingTools', 'unlabelledToolBytes'],
);

const PROMPT_COMPOSITION_SEGMENT_SHAPE = defineObjectShape<PromptCompositionSegment>()(
  ['kind', 'bytes'],
  [],
);

const PROMPT_COMPOSITION_TOOL_SHAPE = defineObjectShape<PromptCompositionTool>()(
  ['name', 'bytes'],
  [],
);

const PROMPT_COMPOSITION_REMAINING_TOOLS_SHAPE = defineObjectShape<{
  count: number;
  bytes: number;
}>()(['count', 'bytes'], []);

/**
 * The fold's buckets, in the order a composition lists them.
 *
 * The order is part of the contract, not presentation: a reader comparing two
 * compositions compares them position by position, and the projection
 * validator rejects a record whose segments arrive out of this order.
 */
export const PROMPT_COMPOSITION_SEGMENT_KINDS: readonly PromptCompositionSegmentKind[] = [
  'system_instructions',
  'tool_definitions',
  'messages',
  'other',
];

/**
 * The fold names one tool per row, so the row count is what bounds this record.
 * Generous enough for a normal registry, small enough that a pathological one
 * cannot make an attempt unbounded. Exported because the fold that produces
 * these rows has to cut at the same number the decoder accepts.
 */
export const PROMPT_COMPOSITION_MAX_TOOLS = 64;

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

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isOptionalBoundedText(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length <= PREPARED_REQUEST_OBSERVATION_TEXT_MAX_LENGTH)
  );
}

function isPreparedRequestObservationSegment(
  value: unknown,
): value is PreparedRequestObservationSegment {
  if (!isRecord(value) || !hasExactShape(value, PREPARED_REQUEST_OBSERVATION_SEGMENT_SHAPE)) {
    return false;
  }
  return (
    PREPARED_REQUEST_SEGMENT_KINDS.includes(value.kind as PreparedRequestObservationSegmentKind) &&
    isNonNegativeInteger(value.index) &&
    typeof value.cacheable === 'boolean' &&
    (value.comparison === 'exact' || value.comparison === 'opaque') &&
    isSha256Digest(value.digest) &&
    isNonNegativeInteger(value.bytes) &&
    (value.representedSegments === undefined ||
      (typeof value.representedSegments === 'number' &&
        Number.isSafeInteger(value.representedSegments) &&
        value.representedSegments > 0)) &&
    (value.representedSegments === undefined || value.comparison === 'opaque') &&
    isOptionalBoundedText(value.role) &&
    isOptionalBoundedText(value.label)
  );
}

function isPromptComposition(value: unknown): value is PromptComposition {
  if (!isRecord(value) || !hasExactShape(value, PROMPT_COMPOSITION_SHAPE)) return false;
  if (!Array.isArray(value.segments) || !value.segments.every(isPromptCompositionSegment)) {
    return false;
  }
  // One kind per row: a fold that named the same bucket twice would let a
  // reader's total disagree with the store's.
  const kinds = value.segments.map((segment) => segment.kind);
  if (new Set(kinds).size !== kinds.length) return false;
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > PROMPT_COMPOSITION_MAX_TOOLS) {
      return false;
    }
    if (!value.tools.every(isPromptCompositionTool)) return false;
  }
  if (
    value.remainingTools !== undefined &&
    !(
      isRecord(value.remainingTools) &&
      hasExactShape(value.remainingTools, PROMPT_COMPOSITION_REMAINING_TOOLS_SHAPE) &&
      isNonNegativeInteger(value.remainingTools.count) &&
      isNonNegativeInteger(value.remainingTools.bytes)
    )
  ) {
    return false;
  }
  return value.unlabelledToolBytes === undefined || isNonNegativeInteger(value.unlabelledToolBytes);
}

function isPromptCompositionSegment(value: unknown): value is PromptCompositionSegment {
  return (
    isRecord(value) &&
    hasExactShape(value, PROMPT_COMPOSITION_SEGMENT_SHAPE) &&
    (PROMPT_COMPOSITION_SEGMENT_KINDS as readonly unknown[]).includes(value.kind) &&
    isNonNegativeInteger(value.bytes)
  );
}

function isPromptCompositionTool(value: unknown): value is PromptCompositionTool {
  return (
    isRecord(value) &&
    hasExactShape(value, PROMPT_COMPOSITION_TOOL_SHAPE) &&
    typeof value.name === 'string' &&
    value.name.length <= PREPARED_REQUEST_OBSERVATION_TEXT_MAX_LENGTH &&
    isNonNegativeInteger(value.bytes)
  );
}

function isPreparedRequestObservation(value: unknown): value is PreparedRequestObservation {
  if (!isRecord(value) || !hasExactShape(value, PREPARED_REQUEST_OBSERVATION_SHAPE)) return false;
  return (
    value.schemaVersion === PREPARED_REQUEST_OBSERVATION_SCHEMA_VERSION &&
    isSha256Digest(value.digest) &&
    isNonNegativeInteger(value.bytes) &&
    Array.isArray(value.segments) &&
    value.segments.length <= PREPARED_REQUEST_OBSERVATION_MAX_SEGMENTS &&
    value.segments.every(isPreparedRequestObservationSegment) &&
    hasOrderedPreparedRequestSegments(value.segments)
  );
}

function hasOrderedPreparedRequestSegments(
  segments: readonly PreparedRequestObservationSegment[],
): boolean {
  let previousKind = -1;
  let previousIndex = -1;
  for (const segment of segments) {
    const kind = PREPARED_REQUEST_SEGMENT_KINDS.indexOf(segment.kind);
    if (kind < previousKind) return false;
    if (kind === previousKind && segment.index <= previousIndex) return false;
    if (kind !== previousKind) previousIndex = -1;
    previousKind = kind;
    previousIndex = segment.index;
  }
  return true;
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
    (value.promptComposition === undefined || isPromptComposition(value.promptComposition)) &&
    (value.requestObservation === undefined ||
      isPreparedRequestObservation(value.requestObservation)) &&
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
