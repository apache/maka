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
  comparePricingModelKeys,
  normalizePricingModelKey,
  validateCanonicalPricingConfig,
} from '@maka/core/usage-stats/pricing';
import type {
  CacheMissInputSource,
  ModelCallKind,
  PricingConfig,
  ToolInvocationResultSummary,
  UsageBucket,
  UsageGroupBy,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import { MODEL_CALL_KINDS } from '@maka/core/usage-stats/types';
import type { UsageProvenance } from '@maka/core/usage-ledger-merge';
import { requireCount, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const USAGE_PAGE_MAX_ITEMS = 100;
export const USAGE_PAGE_MAX_BYTES = 48 * 1024;
export const USAGE_PROJECTION_TEXT_MAX_BYTES = 1024;
export const PRICING_PAGE_MAX_ITEMS = 128;
export const PRICING_PAGE_MAX_BYTES = 48 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'persistence_failed',
  'internal_failure',
] as const;
const USAGE_QUERY_ERRORS = [...QUERY_ERRORS, 'invalid_request'] as const;
const PRICING_QUERY_ERRORS = [...QUERY_ERRORS, 'invalid_request'] as const;
const MUTATION_ERRORS = [...QUERY_ERRORS, 'invalid_request', 'commit_outcome_unknown'] as const;
const LLM_USAGE_QUERY_FIELDS = new Set([
  'range',
  'sessionId',
  'connectionSlug',
  'providerId',
  'modelId',
  'status',
]);
const TOOL_USAGE_QUERY_FIELDS = new Set(['range', 'toolName', 'status']);
const USAGE_BUCKET_FIELDS = new Set([
  'key',
  'label',
  'requests',
  'inputTokens',
  'outputTokens',
  'cacheMissTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheMissInputSource',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
  'avgLatencyMs',
  'errorRate',
]);
const LLM_USAGE_LOG_FIELDS = new Set([
  'source',
  'id',
  'ts',
  'callKind',
  'callId',
  'connectionSlug',
  'providerId',
  'modelId',
  'inputTokens',
  'outputTokens',
  'cacheMissTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheMissInputSource',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
  'costBasis',
  'latencyMs',
  'status',
  'errorClass',
  'sessionId',
  'turnId',
]);
const TOOL_USAGE_LOG_FIELDS = new Set([
  'source',
  'id',
  'ts',
  'toolCallId',
  'toolName',
  'providerId',
  'modelId',
  'durationMs',
  'status',
  'errorClass',
  'argsSummary',
  'resultSummary',
  'bytesIn',
  'bytesOut',
  'startedAt',
  'sessionId',
  'turnId',
]);
const TOOL_RESULT_SUMMARY_FIELDS = new Set([
  'kind',
  'status',
  'itemCount',
  'startedItemCount',
  'completedItemCount',
  'failedItemCount',
  'cancelledItemCount',
  'artifactCount',
]);

export type LlmUsageQuery = Omit<UsageQuery, 'toolName'>;

export interface ToolUsageQuery {
  readonly range: UsageQuery['range'];
  readonly toolName?: string;
  readonly status?: UsageQuery['status'];
}

export interface LlmUsageLogProjection {
  readonly source: 'llm';
  readonly id: string;
  readonly ts: number;
  readonly callKind?: ModelCallKind;
  readonly callId?: string;
  readonly connectionSlug?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheMissTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheMissInputSource?: CacheMissInputSource;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  /** Absent when `costBasis` is `'unpriced'`. Zero means genuinely free. */
  readonly costUsd?: number;
  /** Undefined for rows from the frozen table, which never recorded a basis. */
  readonly costBasis?: 'priced' | 'unpriced';
  readonly latencyMs: number;
  readonly status: 'success' | 'error' | 'aborted';
  readonly errorClass?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface ToolUsageLogProjection {
  readonly source: 'tool';
  readonly id: string;
  readonly ts: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly durationMs: number;
  readonly status: 'success' | 'error' | 'aborted';
  readonly errorClass?: string;
  readonly argsSummary?: string;
  readonly resultSummary?: ToolInvocationResultSummary;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly startedAt: number;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export type UsageLogProjection = LlmUsageLogProjection | ToolUsageLogProjection;

export type UsageQueryInput =
  | { readonly kind: 'summary'; readonly query: LlmUsageQuery }
  | {
      readonly kind: 'buckets';
      readonly query: LlmUsageQuery;
      readonly groupBy: Exclude<UsageGroupBy, 'tool'>;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: 'buckets';
      readonly query: ToolUsageQuery;
      readonly groupBy: 'tool';
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: 'logs';
      readonly source: 'llm';
      readonly query: LlmUsageQuery;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: 'logs';
      readonly source: 'tool';
      readonly query: ToolUsageQuery;
      readonly offset?: number;
      readonly limit?: number;
    };

export type UsageQueryResult =
  | {
      readonly kind: 'summary';
      readonly summary: UsageSummaryV2;
      readonly provenance: UsageProvenance;
    }
  | {
      readonly kind: 'buckets';
      readonly buckets: readonly UsageBucket[];
      readonly offset: number;
      readonly total: number;
      readonly nextOffset: number | null;
      readonly provenance: UsageProvenance;
    }
  | {
      readonly kind: 'logs';
      readonly source: 'llm';
      readonly rows: readonly LlmUsageLogProjection[];
      readonly offset: number;
      readonly total: number;
      readonly nextOffset: number | null;
      readonly provenance: UsageProvenance;
    }
  | {
      readonly kind: 'logs';
      readonly source: 'tool';
      readonly rows: readonly ToolUsageLogProjection[];
      readonly offset: number;
      readonly total: number;
      readonly nextOffset: number | null;
    };

export type PricingQueryInput =
  | { readonly kind: 'start' }
  | { readonly kind: 'continue'; readonly revision: number; readonly offset: number };

/**
 * Effective for one Host epoch: `revision` pins persisted overrides, while the
 * bundled table is fixed by the running Host build.
 */
export type EffectivePricingEntry =
  | {
      readonly pricing: Readonly<PricingConfig>;
      readonly source: 'builtin';
    }
  | {
      readonly pricing: Readonly<PricingConfig>;
      readonly source: 'custom';
      readonly resetEffect: 'restore_builtin' | 'become_unpriced';
    };

export type PricingQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: number;
      readonly offset: number;
      readonly entries: readonly EffectivePricingEntry[];
      readonly nextOffset: number | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export type PricingMutation =
  | { readonly kind: 'upsert'; readonly pricing: PricingConfig }
  | { readonly kind: 'delete'; readonly modelKey: string };

export interface PricingMutateInput {
  readonly expectedRevision: number;
  readonly mutation: PricingMutation;
}

export type PricingMutateResult =
  | { readonly kind: 'committed' | 'unchanged'; readonly revision: number }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export const USAGE_PRICING_OPERATION_SPECS = {
  'usage.query': defineOperation<
    UsageQueryInput,
    UsageQueryResult,
    (typeof USAGE_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: USAGE_QUERY_ERRORS,
    decodeInput: decodeUsageQueryInput,
    decodeOutput: decodeUsageQueryResult,
    assertOutputForInput: assertUsageQueryOutputForInput,
  }),
  'pricing.query': defineOperation<
    PricingQueryInput,
    PricingQueryResult,
    (typeof PRICING_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: PRICING_QUERY_ERRORS,
    decodeInput: decodePricingQueryInput,
    decodeOutput: decodePricingQueryResult,
    assertOutputForInput: assertPricingQueryOutputForInput,
  }),
  'pricing.mutate': defineOperation<
    PricingMutateInput,
    PricingMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePricingMutateInput,
    decodeOutput: decodePricingMutateResult,
    assertOutputForInput: assertPricingMutateOutputForInput,
  }),
} as const;

export function decodeUsageQueryInput(value: unknown): UsageQueryInput {
  const input = requireRecord(value, 'usage query input');
  if (input.kind === 'summary') {
    const exact = requireExactRecord(input, 'usage summary input', ['kind', 'query']);
    return { kind: 'summary', query: decodeLlmUsageQuery(exact.query) };
  }
  if (input.kind === 'buckets') {
    assertOptionalExactKeys(
      input,
      'usage buckets input',
      ['kind', 'query', 'groupBy'],
      ['offset', 'limit'],
    );
    const groupBy = decodeUsageGroupBy(input.groupBy);
    const page = { offset: decodeOffset(input.offset), limit: decodeLimit(input.limit) };
    return groupBy === 'tool'
      ? { kind: 'buckets', query: decodeToolUsageQuery(input.query), groupBy, ...page }
      : { kind: 'buckets', query: decodeLlmUsageQuery(input.query), groupBy, ...page };
  }
  if (input.kind === 'logs') {
    assertOptionalExactKeys(
      input,
      'usage logs input',
      ['kind', 'source', 'query'],
      ['offset', 'limit'],
    );
    const page = { offset: decodeOffset(input.offset), limit: decodeLimit(input.limit) };
    if (input.source === 'llm') {
      return {
        kind: 'logs',
        source: 'llm',
        query: decodeLlmUsageQuery(input.query),
        ...page,
      };
    }
    if (input.source === 'tool') {
      return {
        kind: 'logs',
        source: 'tool',
        query: decodeToolUsageQuery(input.query),
        ...page,
      };
    }
    throw invalidProtocolFrame('Invalid usage log source');
  }
  throw invalidProtocolFrame('Invalid usage query kind');
}

export function decodeUsageQueryResult(value: unknown): UsageQueryResult {
  const result = requireRecord(value, 'usage query result');
  if (result.kind === 'summary') {
    const exact = requireExactRecord(result, 'usage summary result', [
      'kind',
      'summary',
      'provenance',
    ]);
    return {
      kind: 'summary',
      summary: decodeUsageSummary(exact.summary),
      provenance: decodeUsageProvenance(exact.provenance),
    };
  }
  if (result.kind === 'buckets') {
    const exact = requireExactRecord(result, 'usage buckets result', [
      'kind',
      'buckets',
      'offset',
      'total',
      'nextOffset',
      'provenance',
    ]);
    return decodeUsagePage('buckets', exact, decodeUsageBucket);
  }
  if (result.kind === 'logs') {
    // Only LLM logs are drawn from the model-call ledger, so only they carry
    // provenance; tool logs have no canonical source to qualify.
    if (result.source === 'llm') {
      const exact = requireExactRecord(result, 'usage llm logs result', [
        'kind',
        'source',
        'rows',
        'offset',
        'total',
        'nextOffset',
        'provenance',
      ]);
      return decodeUsageLogPage('llm', exact, decodeLlmUsageLog);
    }
    if (result.source === 'tool') {
      const exact = requireExactRecord(result, 'usage tool logs result', [
        'kind',
        'source',
        'rows',
        'offset',
        'total',
        'nextOffset',
      ]);
      return decodeUsageLogPage('tool', exact, decodeToolUsageLog);
    }
    throw invalidProtocolFrame('Invalid usage log source');
  }
  throw invalidProtocolFrame('Invalid usage query result kind');
}

export const encodeUsageQueryResult = decodeUsageQueryResult;

export function decodePricingQueryInput(value: unknown): PricingQueryInput {
  const input = requireRecord(value, 'pricing query input');
  if (input.kind === 'start') {
    requireExactRecord(input, 'pricing query start input', ['kind']);
    return { kind: 'start' };
  }
  if (input.kind === 'continue') {
    const exact = requireExactRecord(input, 'pricing query continuation input', [
      'kind',
      'revision',
      'offset',
    ]);
    return {
      kind: 'continue',
      revision: requireCount(exact.revision, 'pricing revision'),
      offset: requireCount(exact.offset, 'pricing offset'),
    };
  }
  throw invalidProtocolFrame('Invalid pricing query kind');
}

export function decodePricingQueryResult(value: unknown): PricingQueryResult {
  const result = requireRecord(value, 'pricing query result');
  if (result.kind === 'revision_changed') {
    const exact = requireExactRecord(result, 'pricing revision changed result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    const decoded = {
      kind: 'revision_changed',
      expectedRevision: requireCount(exact.expectedRevision, 'expected pricing revision'),
      actualRevision: requireCount(exact.actualRevision, 'actual pricing revision'),
    } as const;
    if (decoded.expectedRevision === decoded.actualRevision) {
      throw invalidProtocolFrame('Pricing revision did not change');
    }
    return decoded;
  }
  if (result.kind !== 'page') throw invalidProtocolFrame('Invalid pricing query result kind');
  const exact = requireExactRecord(result, 'pricing page result', [
    'kind',
    'revision',
    'offset',
    'entries',
    'nextOffset',
  ]);
  if (!Array.isArray(exact.entries) || exact.entries.length > PRICING_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Pricing entries exceed item limit');
  }
  const entries = exact.entries.map(decodeEffectivePricingEntry);
  if (
    entries.some(
      (item, index) =>
        index > 0 &&
        comparePricingModelKeys(entries[index - 1]!.pricing.modelKey, item.pricing.modelKey) >= 0,
    )
  ) {
    throw invalidProtocolFrame('Pricing entries are not canonically ordered');
  }
  const offset = requireCount(exact.offset, 'pricing offset');
  const nextOffset =
    exact.nextOffset === null ? null : requireCount(exact.nextOffset, 'pricing next offset');
  const advancedOffset = offset + entries.length;
  if (nextOffset !== null && (entries.length === 0 || nextOffset !== advancedOffset)) {
    throw invalidProtocolFrame('Pricing page does not make canonical progress');
  }
  const decoded: PricingQueryResult = {
    kind: 'page',
    revision: requireCount(exact.revision, 'pricing revision'),
    offset,
    entries,
    nextOffset,
  };
  assertJsonBytes(decoded, PRICING_PAGE_MAX_BYTES, 'Pricing page');
  return decoded;
}

export const encodePricingQueryResult = decodePricingQueryResult;

function decodeEffectivePricingEntry(value: unknown): EffectivePricingEntry {
  const entry = requireRecord(value, 'effective pricing entry');
  if (entry.source === 'builtin') {
    const exact = requireExactRecord(entry, 'built-in pricing entry', ['pricing', 'source']);
    return { pricing: decodePricingConfig(exact.pricing), source: 'builtin' };
  }
  if (entry.source === 'custom') {
    const exact = requireExactRecord(entry, 'custom pricing entry', [
      'pricing',
      'source',
      'resetEffect',
    ]);
    if (exact.resetEffect !== 'restore_builtin' && exact.resetEffect !== 'become_unpriced') {
      throw invalidProtocolFrame('Invalid custom pricing reset effect');
    }
    return {
      pricing: decodePricingConfig(exact.pricing),
      source: 'custom',
      resetEffect: exact.resetEffect,
    };
  }
  throw invalidProtocolFrame('Invalid effective pricing source');
}

export function decodePricingMutateInput(value: unknown): PricingMutateInput {
  const input = requireExactRecord(value, 'pricing mutation input', [
    'expectedRevision',
    'mutation',
  ]);
  const expectedRevision = requireCount(input.expectedRevision, 'expected pricing revision');
  const mutation = requireRecord(input.mutation, 'pricing mutation');
  if (mutation.kind === 'upsert') {
    const exact = requireExactRecord(mutation, 'pricing upsert mutation', ['kind', 'pricing']);
    return {
      expectedRevision,
      mutation: { kind: 'upsert', pricing: decodePricingConfig(exact.pricing) },
    };
  }
  if (mutation.kind === 'delete') {
    const exact = requireExactRecord(mutation, 'pricing delete mutation', ['kind', 'modelKey']);
    const normalized = normalizePricingModelKey(exact.modelKey);
    if (!normalized.ok) throw invalidProtocolFrame('Invalid pricing model key');
    return {
      expectedRevision,
      mutation: { kind: 'delete', modelKey: normalized.value },
    };
  }
  throw invalidProtocolFrame('Invalid pricing mutation kind');
}

export function decodePricingMutateResult(value: unknown): PricingMutateResult {
  const result = requireRecord(value, 'pricing mutation result');
  if (result.kind === 'committed' || result.kind === 'unchanged') {
    const exact = requireExactRecord(result, 'pricing mutation outcome', ['kind', 'revision']);
    return { kind: result.kind, revision: requireCount(exact.revision, 'pricing revision') };
  }
  if (result.kind === 'revision_conflict') {
    const exact = requireExactRecord(result, 'pricing revision conflict', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    const decoded = {
      kind: 'revision_conflict',
      expectedRevision: requireCount(exact.expectedRevision, 'expected pricing revision'),
      actualRevision: requireCount(exact.actualRevision, 'actual pricing revision'),
    } as const;
    if (decoded.expectedRevision === decoded.actualRevision) {
      throw invalidProtocolFrame('Pricing revision did not conflict');
    }
    return decoded;
  }
  throw invalidProtocolFrame('Invalid pricing mutation result kind');
}

function assertUsageQueryOutputForInput(input: UsageQueryInput, output: UsageQueryResult): void {
  if (output.kind !== input.kind) {
    throw invalidProtocolFrame('Usage response kind does not match its request');
  }
  if (input.kind === 'summary') return;
  if (output.kind === 'summary') {
    throw invalidProtocolFrame('Usage response kind does not match its request');
  }
  const expectedOffset = input.offset ?? 0;
  if (output.offset !== expectedOffset) {
    throw invalidProtocolFrame('Usage response offset does not match its request');
  }
  if (input.kind === 'logs' && output.kind === 'logs' && output.source !== input.source) {
    throw invalidProtocolFrame('Usage log source does not match its request');
  }
}

function assertPricingQueryOutputForInput(
  input: PricingQueryInput,
  output: PricingQueryResult,
): void {
  if (input.kind === 'start') {
    if (output.kind !== 'page' || output.offset !== 0) {
      throw invalidProtocolFrame('Pricing start response does not match its request');
    }
    return;
  }
  if (output.kind === 'revision_changed') {
    if (output.expectedRevision !== input.revision) {
      throw invalidProtocolFrame('Pricing revision change does not match its request');
    }
    return;
  }
  if (output.revision !== input.revision || output.offset !== input.offset) {
    throw invalidProtocolFrame('Pricing page does not match its request');
  }
}

function assertPricingMutateOutputForInput(
  input: PricingMutateInput,
  output: PricingMutateResult,
): void {
  if (output.kind === 'revision_conflict') {
    if (output.expectedRevision !== input.expectedRevision) {
      throw invalidProtocolFrame('Pricing conflict does not match its request');
    }
    return;
  }
  const expectedRevision =
    output.kind === 'committed' ? input.expectedRevision + 1 : input.expectedRevision;
  if (output.revision !== expectedRevision) {
    throw invalidProtocolFrame('Pricing mutation result does not match its request');
  }
}

function decodeLlmUsageQuery(value: unknown): LlmUsageQuery {
  const query = requireRecord(value, 'usage query');
  assertAllowedKeys(query, LLM_USAGE_QUERY_FIELDS, 'LLM usage query');
  if (!Object.hasOwn(query, 'range')) throw invalidProtocolFrame('Invalid usage query fields');
  return {
    range: decodeUsageRange(query.range),
    ...optionalQueryText(query, 'sessionId'),
    ...optionalQueryText(query, 'connectionSlug'),
    ...optionalQueryText(query, 'providerId'),
    ...optionalQueryText(query, 'modelId'),
    ...(query.status === undefined ? {} : { status: decodeUsageStatus(query.status) }),
  };
}

function decodeToolUsageQuery(value: unknown): ToolUsageQuery {
  const query = requireRecord(value, 'tool usage query');
  assertAllowedKeys(query, TOOL_USAGE_QUERY_FIELDS, 'tool usage query');
  if (!Object.hasOwn(query, 'range')) {
    throw invalidProtocolFrame('Invalid tool usage query fields');
  }
  return {
    range: decodeUsageRange(query.range),
    ...optionalQueryText(query, 'toolName'),
    ...(query.status === undefined ? {} : { status: decodeUsageStatus(query.status) }),
  };
}

function decodeUsageRange(value: unknown): UsageQuery['range'] {
  if (value === '24h' || value === '7d' || value === '30d' || value === 'all') return value;
  const range = requireExactRecord(value, 'usage range', ['from', 'to']);
  const from = nonnegativeFinite(range.from, 'usage range from');
  const to = nonnegativeFinite(range.to, 'usage range to');
  if (from > to) throw invalidProtocolFrame('Invalid usage range');
  return { from, to };
}

function decodeUsageStatus(value: unknown): NonNullable<UsageQuery['status']> {
  if (value === 'success' || value === 'error' || value === 'aborted' || value === 'all') {
    return value;
  }
  throw invalidProtocolFrame('Invalid usage query status');
}

function decodeUsageGroupBy(value: unknown): UsageGroupBy {
  if (
    value === 'provider' ||
    value === 'model' ||
    value === 'tool' ||
    value === 'day' ||
    value === 'hour'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid usage groupBy');
}

function decodeOffset(value: unknown): number {
  return value === undefined ? 0 : requireCount(value, 'usage offset');
}

function decodeLimit(value: unknown): number {
  if (value === undefined) return USAGE_PAGE_MAX_ITEMS;
  const limit = requireCount(value, 'usage limit');
  if (limit === 0 || limit > USAGE_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid usage limit');
  }
  return limit;
}

function decodeUsagePage(
  kind: 'buckets',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => UsageBucket,
): Extract<UsageQueryResult, { kind: 'buckets' }>;
function decodeUsagePage(
  kind: 'buckets',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => UsageBucket,
): Extract<UsageQueryResult, { kind: 'buckets' }> {
  const rawItems = result.buckets;
  if (!Array.isArray(rawItems) || rawItems.length > USAGE_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Usage page exceeds item limit');
  }
  const items = rawItems.map(decodeItem);
  const page = decodeUsagePagePosition(result, items.length);
  const decoded = {
    kind,
    buckets: items,
    ...page,
    provenance: decodeUsageProvenance(result.provenance),
  } as const;
  assertJsonBytes(decoded, USAGE_PAGE_MAX_BYTES, 'Usage page');
  return decoded;
}

function decodeUsageLogPage(
  source: 'llm',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => LlmUsageLogProjection,
): Extract<UsageQueryResult, { kind: 'logs'; source: 'llm' }>;
function decodeUsageLogPage(
  source: 'tool',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => ToolUsageLogProjection,
): Extract<UsageQueryResult, { kind: 'logs'; source: 'tool' }>;
function decodeUsageLogPage(
  source: 'llm' | 'tool',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => UsageLogProjection,
): Extract<UsageQueryResult, { kind: 'logs' }> {
  const rawItems = result.rows;
  if (!Array.isArray(rawItems) || rawItems.length > USAGE_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Usage page exceeds item limit');
  }
  const items = rawItems.map(decodeItem);
  const page = decodeUsagePagePosition(result, items.length);
  const decoded = {
    kind: 'logs',
    source,
    rows: items,
    ...page,
    ...(source === 'llm' ? { provenance: decodeUsageProvenance(result.provenance) } : {}),
  } as Extract<UsageQueryResult, { kind: 'logs' }>;
  assertJsonBytes(decoded, USAGE_PAGE_MAX_BYTES, 'Usage page');
  return decoded;
}

function decodeUsagePagePosition(
  result: Record<string, unknown>,
  itemCount: number,
): { readonly offset: number; readonly total: number; readonly nextOffset: number | null } {
  const offset = requireCount(result.offset, 'usage result offset');
  const total = requireCount(result.total, 'usage result total');
  const nextOffset =
    result.nextOffset === null ? null : requireCount(result.nextOffset, 'usage next offset');
  if (offset > total || itemCount > total - offset) {
    throw invalidProtocolFrame('Usage page exceeds remaining total');
  }
  const advancedOffset = offset + itemCount;
  if (nextOffset === null) {
    if (advancedOffset !== total) {
      throw invalidProtocolFrame('Terminal usage page does not reach total');
    }
  } else if (itemCount === 0 || nextOffset !== advancedOffset || advancedOffset >= total) {
    throw invalidProtocolFrame('Usage page does not make canonical progress');
  }
  return { offset, total, nextOffset };
}

function decodeUsageSummary(value: unknown): UsageSummaryV2 {
  const summary = requireExactRecord(value, 'usage summary', [
    'range',
    'totalRequests',
    'totalCostUsd',
    'totalTokens',
    'cacheHitRequests',
    'cacheCreateRequests',
    'errorRequests',
  ]);
  const range = requireExactRecord(summary.range, 'usage summary range', ['from', 'to']);
  const tokens = requireExactRecord(summary.totalTokens, 'usage summary tokens', [
    'input',
    'output',
    'cacheMiss',
    'cacheRead',
    'cacheWrite',
    'reasoning',
    'total',
  ]);
  return {
    range: {
      from: nonnegativeFinite(range.from, 'usage summary range from'),
      to: nonnegativeFinite(range.to, 'usage summary range to'),
    },
    totalRequests: requireCount(summary.totalRequests, 'usage total requests'),
    totalCostUsd: nonnegativeFinite(summary.totalCostUsd, 'usage total cost'),
    totalTokens: {
      input: requireCount(tokens.input, 'usage input tokens'),
      output: requireCount(tokens.output, 'usage output tokens'),
      cacheMiss: requireCount(tokens.cacheMiss, 'usage cache miss tokens'),
      cacheRead: requireCount(tokens.cacheRead, 'usage cache read tokens'),
      cacheWrite: requireCount(tokens.cacheWrite, 'usage cache write tokens'),
      reasoning: requireCount(tokens.reasoning, 'usage reasoning tokens'),
      total: requireCount(tokens.total, 'usage total tokens'),
    },
    cacheHitRequests: requireCount(summary.cacheHitRequests, 'usage cache hit requests'),
    cacheCreateRequests: requireCount(summary.cacheCreateRequests, 'usage cache create requests'),
    errorRequests: requireCount(summary.errorRequests, 'usage error requests'),
  };
}

/**
 * What qualifies the numbers in a usage result (#1679): how the canonical
 * records behind it were classified, how many rows still come from the frozen
 * legacy table, and how many stored records could not be read. A total
 * crossing the wire without this cannot be presented honestly.
 */
function decodeUsageProvenance(value: unknown): UsageProvenance {
  const provenance = requireExactRecord(value, 'usage provenance', [
    'coverage',
    'legacyRecords',
    'unreadableRecords',
    'pendingRepairs',
  ]);
  const coverage = requireExactRecord(provenance.coverage, 'usage provenance coverage', [
    'attempts',
    'pricedAttempts',
    'unpricedAttempts',
    'usageReportedAttempts',
    'usagePartialAttempts',
    'usageMissingAttempts',
  ]);
  return {
    coverage: {
      attempts: requireCount(coverage.attempts, 'usage coverage attempts'),
      pricedAttempts: requireCount(coverage.pricedAttempts, 'usage coverage priced attempts'),
      unpricedAttempts: requireCount(coverage.unpricedAttempts, 'usage coverage unpriced attempts'),
      usageReportedAttempts: requireCount(
        coverage.usageReportedAttempts,
        'usage coverage reported attempts',
      ),
      usagePartialAttempts: requireCount(
        coverage.usagePartialAttempts,
        'usage coverage partial attempts',
      ),
      usageMissingAttempts: requireCount(
        coverage.usageMissingAttempts,
        'usage coverage missing attempts',
      ),
    },
    legacyRecords: requireCount(provenance.legacyRecords, 'usage provenance legacy records'),
    unreadableRecords: requireCount(
      provenance.unreadableRecords,
      'usage provenance unreadable records',
    ),
    pendingRepairs: requireCount(provenance.pendingRepairs, 'usage provenance pending repairs'),
  };
}

function decodeUsageBucket(value: unknown): UsageBucket {
  const bucket = requireRecord(value, 'usage bucket');
  assertAllowedKeys(bucket, USAGE_BUCKET_FIELDS, 'usage bucket');
  requireFields(bucket, [
    'key',
    'label',
    'requests',
    'inputTokens',
    'outputTokens',
    'cacheMissTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
    'costUsd',
    'avgLatencyMs',
    'errorRate',
  ]);
  const errorRate = nonnegativeFinite(bucket.errorRate, 'usage bucket error rate');
  if (errorRate > 1) throw invalidProtocolFrame('Invalid usage bucket error rate');
  return {
    key: projectionText(bucket.key, 'usage bucket key'),
    label: projectionText(bucket.label, 'usage bucket label'),
    requests: requireCount(bucket.requests, 'usage bucket requests'),
    inputTokens: requireCount(bucket.inputTokens, 'usage bucket input tokens'),
    outputTokens: requireCount(bucket.outputTokens, 'usage bucket output tokens'),
    cacheMissTokens: requireCount(bucket.cacheMissTokens, 'usage bucket cache miss tokens'),
    cacheReadTokens: requireCount(bucket.cacheReadTokens, 'usage bucket cache read tokens'),
    cacheWriteTokens: requireCount(bucket.cacheWriteTokens, 'usage bucket cache write tokens'),
    ...(bucket.cacheMissInputSource === undefined
      ? {}
      : { cacheMissInputSource: decodeCacheMissInputSource(bucket.cacheMissInputSource) }),
    reasoningTokens: requireCount(bucket.reasoningTokens, 'usage bucket reasoning tokens'),
    totalTokens: requireCount(bucket.totalTokens, 'usage bucket total tokens'),
    costUsd: nonnegativeFinite(bucket.costUsd, 'usage bucket cost'),
    avgLatencyMs: nonnegativeFinite(bucket.avgLatencyMs, 'usage bucket average latency'),
    errorRate,
  };
}

function decodeLlmUsageLog(value: unknown): LlmUsageLogProjection {
  const row = requireRecord(value, 'usage log row');
  assertAllowedKeys(row, LLM_USAGE_LOG_FIELDS, 'LLM usage log row');
  requireFields(row, [
    'source',
    'id',
    'ts',
    'providerId',
    'modelId',
    'inputTokens',
    'outputTokens',
    'cacheMissTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
    'latencyMs',
    'status',
  ]);
  if (row.source !== 'llm') throw invalidProtocolFrame('Invalid LLM usage log source');
  const costBasis = optionalEnum(row, 'costBasis', ['priced', 'unpriced'] as const);
  // An unpriced row carries no amount. Admitting one would put a number on the
  // wire that reads as a price and is not one.
  if ('costBasis' in costBasis && costBasis.costBasis === 'unpriced' && row.costUsd !== undefined) {
    throw invalidProtocolFrame('Unpriced usage log row carries a cost');
  }
  return {
    source: 'llm',
    id: projectionText(row.id, 'usage log id'),
    ts: nonnegativeFinite(row.ts, 'usage log timestamp'),
    ...optionalEnum(row, 'callKind', MODEL_CALL_KINDS),
    ...optionalProjectionText(row, 'callId'),
    ...optionalProjectionText(row, 'connectionSlug'),
    providerId: projectionText(row.providerId, 'usage log provider'),
    modelId: projectionText(row.modelId, 'usage log model'),
    inputTokens: requireCount(row.inputTokens, 'usage log input tokens'),
    outputTokens: requireCount(row.outputTokens, 'usage log output tokens'),
    cacheMissTokens: requireCount(row.cacheMissTokens, 'usage log cache miss tokens'),
    cacheReadTokens: requireCount(row.cacheReadTokens, 'usage log cache read tokens'),
    cacheWriteTokens: requireCount(row.cacheWriteTokens, 'usage log cache write tokens'),
    ...(row.cacheMissInputSource === undefined
      ? {}
      : { cacheMissInputSource: decodeCacheMissInputSource(row.cacheMissInputSource) }),
    reasoningTokens: requireCount(row.reasoningTokens, 'usage log reasoning tokens'),
    totalTokens: requireCount(row.totalTokens, 'usage log total tokens'),
    ...(row.costUsd === undefined
      ? {}
      : { costUsd: nonnegativeFinite(row.costUsd, 'usage log cost') }),
    ...costBasis,
    latencyMs: nonnegativeFinite(row.latencyMs, 'usage log latency'),
    status: decodeUsageLogStatus(row.status),
    ...optionalProjectionText(row, 'errorClass'),
    ...optionalProjectionText(row, 'sessionId'),
    ...optionalProjectionText(row, 'turnId'),
  };
}

function decodeToolUsageLog(value: unknown): ToolUsageLogProjection {
  const row = requireRecord(value, 'tool usage log row');
  assertAllowedKeys(row, TOOL_USAGE_LOG_FIELDS, 'tool usage log row');
  requireFields(row, [
    'source',
    'id',
    'ts',
    'toolName',
    'durationMs',
    'status',
    'bytesIn',
    'bytesOut',
    'startedAt',
  ]);
  if (row.source !== 'tool') throw invalidProtocolFrame('Invalid tool usage log source');
  return {
    source: 'tool',
    id: projectionText(row.id, 'tool usage log id'),
    ts: nonnegativeFinite(row.ts, 'tool usage log timestamp'),
    ...optionalProjectionText(row, 'toolCallId'),
    toolName: projectionText(row.toolName, 'tool usage log name'),
    ...optionalProjectionText(row, 'providerId'),
    ...optionalProjectionText(row, 'modelId'),
    durationMs: nonnegativeFinite(row.durationMs, 'tool usage log duration'),
    status: decodeUsageLogStatus(row.status),
    ...optionalProjectionText(row, 'errorClass'),
    ...optionalProjectionText(row, 'argsSummary'),
    ...(row.resultSummary === undefined
      ? {}
      : { resultSummary: decodeToolResultSummary(row.resultSummary) }),
    bytesIn: requireCount(row.bytesIn, 'tool usage log bytes in'),
    bytesOut: requireCount(row.bytesOut, 'tool usage log bytes out'),
    startedAt: nonnegativeFinite(row.startedAt, 'tool usage log start time'),
    ...optionalProjectionText(row, 'sessionId'),
    ...optionalProjectionText(row, 'turnId'),
  };
}

function decodeToolResultSummary(value: unknown): ToolInvocationResultSummary {
  const summary = requireRecord(value, 'tool result summary');
  assertAllowedKeys(summary, TOOL_RESULT_SUMMARY_FIELDS, 'tool result summary');
  requireFields(summary, ['kind']);
  return {
    kind: projectionText(summary.kind, 'tool result summary kind'),
    ...optionalProjectionText(summary, 'status'),
    ...optionalCount(summary, 'itemCount'),
    ...optionalCount(summary, 'startedItemCount'),
    ...optionalCount(summary, 'completedItemCount'),
    ...optionalCount(summary, 'failedItemCount'),
    ...optionalCount(summary, 'cancelledItemCount'),
    ...optionalCount(summary, 'artifactCount'),
  };
}

function decodePricingConfig(value: unknown): PricingConfig {
  const canonical = validateCanonicalPricingConfig(value);
  if (!canonical.ok) throw invalidProtocolFrame('Invalid pricing config');
  return canonical.value;
}

function optionalQueryText<Field extends keyof UsageQuery>(
  query: Record<string, unknown>,
  field: Field,
): Partial<Pick<UsageQuery, Field>> {
  if (query[field] === undefined) return {};
  const value = boundedText(query[field], `usage query ${String(field)}`, 512);
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidProtocolFrame(`Invalid usage query ${String(field)}`);
  }
  return { [field]: value } as Partial<Pick<UsageQuery, Field>>;
}

function optionalProjectionText<Field extends string>(
  record: Record<string, unknown>,
  field: Field,
): Record<Field, string> | Record<string, never> {
  return record[field] === undefined
    ? {}
    : ({ [field]: projectionText(record[field], `usage ${field}`) } as Record<Field, string>);
}

function optionalEnum<Field extends string, Value extends string>(
  record: Record<string, unknown>,
  field: Field,
  values: readonly Value[],
): Record<Field, Value> | Record<string, never> {
  const value = record[field];
  if (value === undefined) return {};
  if (typeof value !== 'string' || !values.includes(value as Value)) {
    throw invalidProtocolFrame(`Invalid usage ${field}`);
  }
  return { [field]: value } as Record<Field, Value>;
}

function optionalCount<Field extends string>(
  record: Record<string, unknown>,
  field: Field,
): Record<Field, number> | Record<string, never> {
  return record[field] === undefined
    ? {}
    : ({ [field]: requireCount(record[field], `usage ${field}`) } as Record<Field, number>);
}

function decodeCacheMissInputSource(value: unknown): CacheMissInputSource {
  if (value === 'explicit' || value === 'derived') return value;
  throw invalidProtocolFrame('Invalid cache miss input source');
}

function decodeUsageLogStatus(value: unknown): UsageLogProjection['status'] {
  if (value === 'success' || value === 'error' || value === 'aborted') return value;
  throw invalidProtocolFrame('Invalid usage log status');
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function projectionText(value: unknown, label: string): string {
  const text = boundedText(value, label, USAGE_PROJECTION_TEXT_MAX_BYTES);
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw invalidProtocolFrame(`Invalid ${label}`);
  return text;
}

function nonnegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireFields(record: Record<string, unknown>, required: readonly string[]): void {
  if (required.some((field) => !Object.hasOwn(record, field))) {
    throw invalidProtocolFrame('Invalid protocol fields');
  }
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(record).some((field) => !allowed.has(field))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
}

function assertOptionalExactKeys(
  record: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  requireFields(record, required);
  assertAllowedKeys(record, new Set([...required, ...optional]), label);
}

function assertJsonBytes(value: unknown, maxBytes: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`${label} exceeds byte limit`);
  }
}
