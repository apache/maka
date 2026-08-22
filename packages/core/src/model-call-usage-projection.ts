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
  dedupeModelCallAttempts,
  summarizeModelCallCoverage,
  type ModelCallAttempt,
  type ModelCallCoverage,
} from './model-call-attempt.js';
import { usageBucketKey } from './usage-stats/bucket-key.js';
import type {
  TimeRange,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from './usage-stats/types.js';

/**
 * Usage projections over the canonical `ModelCallAttempt` ledger.
 *
 * Pure: the caller supplies the records and owns their materialization. This is
 * the aggregation the Usage surface reads once the read path moves off the
 * per-send `LlmCallRecord` table.
 *
 * The one behavioural difference from that table is deliberate. `totalCostUsd`
 * sums only records whose price was resolvable, and every result carries the
 * {@link ModelCallCoverage} that qualifies it. The old schema had nowhere to say
 * "this call cost something we could not price", so it wrote zero — making
 * unpriced spend indistinguishable from a free call. A total presented without
 * its coverage repeats that claim.
 */
export interface ModelCallUsageSummary extends UsageSummaryV2 {
  coverage: ModelCallCoverage;
}

export interface ModelCallUsageLogs {
  rows: UsageLogRow[];
  total: number;
  coverage: ModelCallCoverage;
}

const DAY_MS = 86_400_000;

export function resolveUsageRange(range: TimeRange, now: number): { from: number; to: number } {
  if (typeof range === 'object') return { from: range.from, to: range.to };
  if (range === 'all') return { from: 0, to: now };
  const spans: Record<Exclude<TimeRange & string, 'all'>, number> = {
    '24h': DAY_MS,
    '7d': 7 * DAY_MS,
    '30d': 30 * DAY_MS,
  };
  return { from: now - spans[range], to: now };
}

/**
 * Maps a physical attempt outcome onto the status vocabulary the Usage surface
 * filters by. `interrupted` joins `aborted`: both mean the call stopped short
 * without the provider reporting a failure, and collapsing it into `error`
 * would inflate the error rate with user cancellations.
 */
export function usageStatusForAttempt(
  status: ModelCallAttempt['status'],
): 'success' | 'error' | 'aborted' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return 'aborted';
}

function matchesQuery(
  attempt: ModelCallAttempt,
  query: UsageQuery,
  range: { from: number; to: number },
): boolean {
  if (attempt.completedAt < range.from || attempt.completedAt > range.to) return false;
  if (query.sessionId !== undefined && attempt.sessionId !== query.sessionId) return false;
  if (query.providerId !== undefined && attempt.providerId !== query.providerId) return false;
  if (query.modelId !== undefined && attempt.modelId !== query.modelId) return false;
  if (query.connectionSlug !== undefined && attempt.connectionSlug !== query.connectionSlug) {
    return false;
  }
  if (query.status !== undefined && query.status !== 'all') {
    if (usageStatusForAttempt(attempt.status) !== query.status) return false;
  }
  return true;
}

/**
 * Selects the attempts a query addresses, in append order, deduped by
 * `attemptId` so a re-appended settlement counts once.
 */
export function selectModelCallAttempts(
  attempts: readonly ModelCallAttempt[],
  query: UsageQuery,
  now: number,
): { rows: ModelCallAttempt[]; range: { from: number; to: number } } {
  const range = resolveUsageRange(query.range, now);
  const rows = dedupeModelCallAttempts(attempts).filter((a) => matchesQuery(a, query, range));
  return { rows, range };
}

function tokens(attempt: ModelCallAttempt): {
  input: number;
  output: number;
  cacheMiss: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
} {
  const reportedCacheRead = attempt.cacheReadInputTokens ?? 0;
  const input = attempt.inputTokens ?? 0;
  const output = attempt.outputTokens ?? 0;
  const cacheMiss = attempt.cacheMissInputTokens ?? 0;
  // With no reported prompt total there is no denominator to validate against,
  // but the provider's cache evidence remains authoritative. Presentation code
  // must leave ratios unavailable while Usage coverage is partial.
  const cacheRead =
    attempt.inputTokens === undefined
      ? reportedCacheRead
      : clampCacheReadTokens(input, reportedCacheRead);
  const cacheWrite = attempt.cacheWriteInputTokens ?? 0;
  const reasoning = attempt.reasoningTokens ?? 0;
  return { input, output, cacheMiss, cacheRead, cacheWrite, reasoning, total: input + output };
}

export function clampCacheReadTokens(inputTokens: number, cacheReadTokens: number): number {
  return Math.min(cacheReadTokens, inputTokens);
}

/** Cost contributed by an attempt. Unpriced records contribute nothing to the
 * sum and are surfaced through coverage instead of being counted as zero. */
function pricedCost(attempt: ModelCallAttempt): number {
  return attempt.costBasis === 'priced' ? (attempt.costUsd ?? 0) : 0;
}

export function projectModelCallUsageSummary(
  attempts: readonly ModelCallAttempt[],
  query: UsageQuery,
  now: number,
): ModelCallUsageSummary {
  const { rows, range } = selectModelCallAttempts(attempts, query, now);
  const totals = {
    input: 0,
    output: 0,
    cacheMiss: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
  };
  let totalCostUsd = 0;
  let cacheHitRequests = 0;
  let cacheCreateRequests = 0;
  let errorRequests = 0;
  for (const attempt of rows) {
    const t = tokens(attempt);
    totals.input += t.input;
    totals.output += t.output;
    totals.cacheMiss += t.cacheMiss;
    totals.cacheRead += t.cacheRead;
    totals.cacheWrite += t.cacheWrite;
    totals.reasoning += t.reasoning;
    totals.total += t.total;
    totalCostUsd += pricedCost(attempt);
    if (t.cacheRead > 0) cacheHitRequests += 1;
    if (t.cacheWrite > 0) cacheCreateRequests += 1;
    if (usageStatusForAttempt(attempt.status) === 'error') errorRequests += 1;
  }
  return {
    range,
    totalRequests: rows.length,
    totalCostUsd,
    totalTokens: totals,
    cacheHitRequests,
    cacheCreateRequests,
    errorRequests,
    coverage: summarizeModelCallCoverage(rows),
  };
}

export function projectModelCallUsageBuckets(
  attempts: readonly ModelCallAttempt[],
  query: UsageQuery,
  groupBy: UsageGroupBy,
  now: number,
): UsageBucket[] {
  const { rows } = selectModelCallAttempts(attempts, query, now);
  const groups = new Map<string, ModelCallAttempt[]>();
  for (const attempt of rows) {
    const key = usageBucketKey(
      { providerId: attempt.providerId, modelId: attempt.modelId, ts: attempt.completedAt },
      groupBy,
    );
    const group = groups.get(key);
    if (group) group.push(attempt);
    else groups.set(key, [attempt]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const agg = {
        input: 0,
        output: 0,
        cacheMiss: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
      };
      let costUsd = 0;
      let latency = 0;
      let errors = 0;
      for (const attempt of group) {
        const t = tokens(attempt);
        agg.input += t.input;
        agg.output += t.output;
        agg.cacheMiss += t.cacheMiss;
        agg.cacheRead += t.cacheRead;
        agg.cacheWrite += t.cacheWrite;
        agg.reasoning += t.reasoning;
        agg.total += t.total;
        costUsd += pricedCost(attempt);
        latency += attempt.latencyMs;
        if (usageStatusForAttempt(attempt.status) === 'error') errors += 1;
      }
      return {
        key,
        label: key,
        requests: group.length,
        inputTokens: agg.input,
        outputTokens: agg.output,
        cacheMissTokens: agg.cacheMiss,
        cacheReadTokens: agg.cacheRead,
        cacheWriteTokens: agg.cacheWrite,
        reasoningTokens: agg.reasoning,
        totalTokens: agg.total,
        costUsd,
        avgLatencyMs: group.length === 0 ? 0 : latency / group.length,
        errorRate: group.length === 0 ? 0 : errors / group.length,
      } satisfies UsageBucket;
    })
    .sort((left, right) => right.requests - left.requests);
}

export function projectModelCallUsageLogs(
  attempts: readonly ModelCallAttempt[],
  query: UsageQuery,
  now: number,
  offset = 0,
  limit = 100,
): ModelCallUsageLogs {
  const { rows } = selectModelCallAttempts(attempts, query, now);
  const ordered = [...rows].sort((left, right) => right.completedAt - left.completedAt);
  const page = ordered.slice(offset, offset + limit).map((attempt) => {
    const t = tokens(attempt);
    return {
      id: attempt.attemptId,
      ts: attempt.completedAt,
      callKind: attempt.callKind,
      callId: attempt.logicalCallId,
      ...(attempt.connectionSlug !== undefined ? { connectionSlug: attempt.connectionSlug } : {}),
      providerId: attempt.providerId,
      modelId: attempt.modelId,
      inputTokens: t.input,
      outputTokens: t.output,
      cacheMissTokens: t.cacheMiss,
      cacheReadTokens: t.cacheRead,
      cacheWriteTokens: t.cacheWrite,
      reasoningTokens: t.reasoning,
      totalTokens: t.total,
      // A row keeps its basis, not just its number. Collapsing an unpriced call
      // to 0 here would reproduce, per row, exactly the ambiguity the coverage
      // breakdown removes from the totals.
      ...(attempt.costBasis === 'priced' ? { costUsd: attempt.costUsd ?? 0 } : {}),
      costBasis: attempt.costBasis,
      latencyMs: attempt.latencyMs,
      status: usageStatusForAttempt(attempt.status),
      ...(attempt.errorClass !== undefined ? { errorClass: attempt.errorClass } : {}),
      sessionId: attempt.sessionId,
      turnId: attempt.turnId,
    } satisfies UsageLogRow;
  });
  return { rows: page, total: ordered.length, coverage: summarizeModelCallCoverage(rows) };
}
