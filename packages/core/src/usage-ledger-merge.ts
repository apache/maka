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

import type { ModelCallAttempt, ModelCallCoverage } from './model-call-attempt.js';
import {
  projectModelCallUsageBuckets,
  projectModelCallUsageLogs,
  projectModelCallUsageSummary,
} from './model-call-usage-projection.js';
import type {
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from './usage-stats/types.js';

/**
 * Merges the canonical `ModelCallAttempt` ledger with the frozen pre-cutover
 * `LlmCallRecord` table (#1679).
 *
 * Both sources are real. The canonical ledger starts empty at cutover and the
 * old table is never migrated into it — the old schema cannot express
 * `usageBasis` or `costBasis`, so a migration would have to invent one, landing
 * unpriced spend as `costUsd: 0`. Instead every all-time answer sums both and
 * says how much came from where, until the old table ages out of the queried
 * range and `legacyRecords` reaches zero on its own.
 *
 * Model calls that have not yet been routed through the canonical seam —
 * `semantic_compact` and `history_compact` — still write only to the old table,
 * so this merge is what keeps them counted in the meantime.
 */
export interface UsageProvenance {
  /** Classification of the canonical records behind this result. */
  coverage: ModelCallCoverage;
  /**
   * Records served from the frozen table, whose cost basis was never recorded.
   * Their cost is included in the totals as stored; it cannot be qualified the
   * way canonical spend can.
   */
  legacyRecords: number;
  /**
   * Stored canonical records that failed to decode. Real calls whose cost is
   * now unknown and is missing from the totals — reported rather than dropped,
   * because a total that silently omits them overstates what is known.
   */
  unreadableRecords: number;
  /**
   * Runs whose attempts the authority holds but the read model has not folded
   * in yet. Their spend is missing from these numbers and is recoverable, which
   * is a different claim from "this is everything".
   */
  pendingRepairs: number;
}

export interface MergedUsageSummary extends UsageSummaryV2 {
  provenance: UsageProvenance;
}

export interface MergedUsageBuckets {
  buckets: UsageBucket[];
  provenance: UsageProvenance;
}

export interface MergedUsageLogs {
  rows: UsageLogRow[];
  total: number;
  provenance: UsageProvenance;
}

export interface CanonicalUsageSource {
  attempts: readonly ModelCallAttempt[];
  unreadableRecords: number;
  pendingRepairs: number;
}

export function mergeUsageSummary(
  legacy: UsageSummaryV2,
  canonical: CanonicalUsageSource,
  query: UsageQuery,
  now: number,
): MergedUsageSummary {
  const projected = projectModelCallUsageSummary(canonical.attempts, query, now);
  return {
    range: projected.range,
    totalRequests: legacy.totalRequests + projected.totalRequests,
    totalCostUsd: legacy.totalCostUsd + projected.totalCostUsd,
    totalTokens: {
      input: legacy.totalTokens.input + projected.totalTokens.input,
      output: legacy.totalTokens.output + projected.totalTokens.output,
      cacheMiss: legacy.totalTokens.cacheMiss + projected.totalTokens.cacheMiss,
      cacheRead: legacy.totalTokens.cacheRead + projected.totalTokens.cacheRead,
      cacheWrite: legacy.totalTokens.cacheWrite + projected.totalTokens.cacheWrite,
      reasoning: legacy.totalTokens.reasoning + projected.totalTokens.reasoning,
      total: legacy.totalTokens.total + projected.totalTokens.total,
    },
    cacheHitRequests: legacy.cacheHitRequests + projected.cacheHitRequests,
    cacheCreateRequests: legacy.cacheCreateRequests + projected.cacheCreateRequests,
    errorRequests: legacy.errorRequests + projected.errorRequests,
    provenance: {
      coverage: projected.coverage,
      legacyRecords: legacy.totalRequests,
      unreadableRecords: canonical.unreadableRecords,
      pendingRepairs: canonical.pendingRepairs,
    },
  };
}

export function mergeUsageBuckets(
  legacy: readonly UsageBucket[],
  canonical: CanonicalUsageSource,
  query: UsageQuery,
  groupBy: UsageGroupBy,
  now: number,
): MergedUsageBuckets {
  const projected = projectModelCallUsageBuckets(canonical.attempts, query, groupBy, now);
  const merged = new Map<string, UsageBucket>();
  for (const bucket of [...legacy, ...projected]) {
    const existing = merged.get(bucket.key);
    merged.set(bucket.key, existing ? combineBuckets(existing, bucket) : { ...bucket });
  }
  return {
    buckets: [...merged.values()].sort((left, right) => right.requests - left.requests),
    provenance: {
      coverage: projectModelCallUsageSummary(canonical.attempts, query, now).coverage,
      legacyRecords: legacy.reduce((total, bucket) => total + bucket.requests, 0),
      unreadableRecords: canonical.unreadableRecords,
      pendingRepairs: canonical.pendingRepairs,
    },
  };
}

/**
 * Both sources are sorted newest first, so the first `offset + limit` rows of
 * the merged order can only come from the first `offset + limit` rows of each —
 * callers may bound their reads to that prefix and still page exactly.
 */
export function mergeUsageLogs(
  legacy: { rows: readonly UsageLogRow[]; total: number },
  canonical: CanonicalUsageSource,
  query: UsageQuery,
  now: number,
  offset: number,
  limit: number,
): MergedUsageLogs {
  const projected = projectModelCallUsageLogs(canonical.attempts, query, now, 0, offset + limit);
  const rows: UsageLogRow[] = [];
  let left = 0;
  let right = 0;
  while (left < legacy.rows.length || right < projected.rows.length) {
    const nextLegacy = legacy.rows[left];
    const nextCanonical = projected.rows[right];
    if (
      nextLegacy !== undefined &&
      (nextCanonical === undefined || nextLegacy.ts >= nextCanonical.ts)
    ) {
      rows.push(nextLegacy);
      left += 1;
    } else if (nextCanonical !== undefined) {
      rows.push(nextCanonical);
      right += 1;
    } else {
      break;
    }
    if (rows.length >= offset + limit) break;
  }
  return {
    rows: rows.slice(offset, offset + limit),
    total: legacy.total + projected.total,
    provenance: {
      coverage: projected.coverage,
      legacyRecords: legacy.total,
      unreadableRecords: canonical.unreadableRecords,
      pendingRepairs: canonical.pendingRepairs,
    },
  };
}

function combineBuckets(left: UsageBucket, right: UsageBucket): UsageBucket {
  const requests = left.requests + right.requests;
  return {
    key: left.key,
    label: left.label,
    requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheMissTokens: left.cacheMissTokens + right.cacheMissTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    // Both inputs are per-request means over their own record set, so the
    // combined mean has to be re-weighted rather than averaged again.
    avgLatencyMs:
      requests === 0
        ? 0
        : (left.avgLatencyMs * left.requests + right.avgLatencyMs * right.requests) / requests,
    errorRate:
      requests === 0
        ? 0
        : (left.errorRate * left.requests + right.errorRate * right.requests) / requests,
  };
}
