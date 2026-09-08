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

import type { UsageGroupBy, UsageQuery } from '@maka/core/usage-stats/types';

/**
 * The Usage aggregation, expressed over the canonical ledger's columns.
 *
 * These fragments are the SQL half of rules whose vocabulary lives in
 * `@maka/core`. Each one names the function it mirrors; change them together.
 */

/** Mirrors `clampCacheReadTokens`: cache reads cannot exceed the prompt they came from. */
export const CACHE_READ_TOKENS = `
  CASE WHEN input_tokens IS NULL
    THEN COALESCE(cache_read_input_tokens, 0)
    ELSE MIN(COALESCE(cache_read_input_tokens, 0), input_tokens)
  END`;

/**
 * Unpriced records contribute nothing rather than zero. What they cost is
 * reported through coverage instead, so a total never claims a call was free
 * when the price was simply never resolved.
 */
export const PRICED_COST = `CASE WHEN cost_basis = 'priced' THEN COALESCE(cost_usd, 0) ELSE 0 END`;

/** Mirrors `usageStatusForAttempt`: only a provider failure is an error. */
const ERROR_ROW = `status = 'failed'`;

export const TOKEN_SUMS = `
  SUM(COALESCE(input_tokens, 0)) AS input,
  SUM(COALESCE(output_tokens, 0)) AS output,
  SUM(COALESCE(cache_miss_input_tokens, 0)) AS cacheMiss,
  SUM(${CACHE_READ_TOKENS}) AS cacheRead,
  SUM(COALESCE(cache_write_input_tokens, 0)) AS cacheWrite,
  SUM(COALESCE(reasoning_tokens, 0)) AS reasoning,
  SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS total`;

export const COVERAGE_SUMS = `
  COUNT(*) AS attempts,
  SUM(cost_basis = 'priced') AS pricedAttempts,
  SUM(cost_basis = 'unpriced') AS unpricedAttempts,
  SUM(usage_basis = 'reported') AS usageReportedAttempts,
  SUM(usage_basis = 'partial') AS usagePartialAttempts,
  SUM(usage_basis = 'missing') AS usageMissingAttempts`;

export const REQUEST_SUMS = `
  COUNT(*) AS totalRequests,
  SUM(${PRICED_COST}) AS totalCostUsd,
  SUM(latency_ms) AS totalDurationMs,
  SUM((${CACHE_READ_TOKENS}) > 0) AS cacheHitRequests,
  SUM(COALESCE(cache_write_input_tokens, 0) > 0) AS cacheCreateRequests,
  SUM(${ERROR_ROW}) AS errorRequests`;

export interface SqlFilter {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

/**
 * Rows a query addresses that can be counted.
 *
 * A tombstone — a row whose stored form was damaged before the ledger held
 * columns — matches no filter and is excluded here; {@link unreadableFilter}
 * counts it instead.
 */
export function countableFilter(
  query: UsageQuery,
  range: { readonly from: number; readonly to: number },
): SqlFilter {
  const clauses = ['cost_basis IS NOT NULL', 'completed_at >= ?', 'completed_at <= ?'];
  const parameters: (string | number)[] = [range.from, range.to];
  const equals = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    parameters.push(value);
  };
  equals('session_id', query.sessionId);
  equals('provider_id', query.providerId);
  equals('model_id', query.modelId);
  equals('connection_slug', query.connectionSlug);
  if (query.status !== undefined && query.status !== 'all') {
    // `interrupted` joins `aborted`: both mean the call stopped short without
    // the provider reporting a failure.
    if (query.status === 'success') clauses.push(`status = 'completed'`);
    else if (query.status === 'error') clauses.push(ERROR_ROW);
    else clauses.push(`status NOT IN ('completed', 'failed')`);
  }
  return { sql: clauses.join(' AND '), parameters };
}

/**
 * Rows a query addresses whose pricing was lost.
 *
 * Scoped by window and Session only — the columns a tombstone keeps. Narrowing
 * it by provider or status would drop the row from the report on the strength
 * of a field the row no longer has, which is how a total quietly stops
 * mentioning spend it cannot account for.
 */
export function unreadableFilter(
  query: UsageQuery,
  range: { readonly from: number; readonly to: number },
): SqlFilter {
  const clauses = ['cost_basis IS NULL', 'completed_at >= ?', 'completed_at <= ?'];
  const parameters: (string | number)[] = [range.from, range.to];
  if (query.sessionId !== undefined) {
    clauses.push('session_id = ?');
    parameters.push(query.sessionId);
  }
  return { sql: clauses.join(' AND '), parameters };
}

/**
 * How SQL groups rows for a bucket query.
 *
 * SQLite decides only which rows belong together; the key string itself is
 * still built by `usageBucketKey`, so both Usage sources keep deriving it from
 * one place. `MIN(completed_at)` gives the time bucket a timestamp to name
 * itself from.
 */
export function bucketGrouping(groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case 'provider':
      return 'provider_id';
    case 'model':
      return 'provider_id, model_id';
    case 'day':
      return `strftime('%Y-%m-%d', completed_at / 1000, 'unixepoch')`;
    case 'hour':
      return `strftime('%Y-%m-%dT%H', completed_at / 1000, 'unixepoch')`;
    case 'tool':
      // Tool invocations live in their own ledger; nothing here describes them.
      return `''`;
  }
}

/** SQL aggregates arrive as `null` for an empty set and as bigint-safe numbers. */
export function count(value: unknown): number {
  return Number(value ?? 0);
}
