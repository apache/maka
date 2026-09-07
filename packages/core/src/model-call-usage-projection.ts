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

import type { ModelCallAttemptStatus, ModelCallCoverage } from './model-call-attempt.js';
import type { TimeRange, UsageBucket, UsageLogRow, UsageSummaryV2 } from './usage-stats/types.js';

/**
 * What a Usage answer over the canonical model-call ledger looks like.
 *
 * The aggregation itself belongs to the ledger, which holds these fields as
 * columns and can sum them without materializing a workspace's history. What
 * lives here is the vocabulary both Usage sources share: the shape of an
 * answer, the window a query resolves to, and the rules a `SUM` has to mirror.
 *
 * One behavioural rule runs through all of it. `totalCostUsd` sums only records
 * whose price was resolvable, and every result carries the
 * {@link ModelCallCoverage} that qualifies it. The frozen pre-cutover table had
 * nowhere to say "this call cost something we could not price", so it wrote
 * zero — making unpriced spend indistinguishable from a free call. A total
 * presented without its coverage repeats that claim.
 */
export interface ModelCallUsageSummary extends UsageSummaryV2 {
  /** Always present: the projection measures every attempt it counts. */
  totalDurationMs: number;
  coverage: ModelCallCoverage;
}

export interface ModelCallUsageBuckets {
  buckets: UsageBucket[];
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
  status: ModelCallAttemptStatus,
): 'success' | 'error' | 'aborted' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return 'aborted';
}

export function clampCacheReadTokens(inputTokens: number, cacheReadTokens: number): number {
  return Math.min(cacheReadTokens, inputTokens);
}
