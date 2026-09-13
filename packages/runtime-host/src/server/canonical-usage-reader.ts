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

import type {
  ModelCallUsageBuckets,
  ModelCallUsageLogs,
  ModelCallUsageSummary,
} from '@maka/core/model-call-usage-projection';
import type { UsageGroupBy, UsageQuery } from '@maka/core/usage-stats/types';
import type { CanonicalUsageSource } from '@maka/core/usage-ledger-merge';
import type {
  InteractiveUsageStoresWriter,
  ModelCallLedgerResult,
} from '@maka/storage/usage-stores';
export class CanonicalUsageProjectionIncompleteError extends Error {
  constructor() {
    super('Canonical Usage projection is incomplete');
    this.name = 'CanonicalUsageProjectionIncompleteError';
  }
}

/**
 * Repairs the projection, then asks the ledger for one answer.
 *
 * `catchUpModelCallProjection` is a write. Paged log reads call this once per
 * page, so a caller that already repaired on its first page passes
 * `repair: false` on later pages to avoid a redundant repair write per page.
 */
async function readCanonical<T>(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  repair: boolean,
  ask: () => Promise<ModelCallLedgerResult<T>>,
): Promise<CanonicalUsageSource<T>> {
  const repairOutcome = repair
    ? await stores.modelCalls
        .catchUpModelCallProjection(
          query.sessionId === undefined ? undefined : { sessionId: query.sessionId },
        )
        .catch(() => ({ pendingRuns: 1, unreadableEvents: 0 }))
    : { pendingRuns: 0, unreadableEvents: 0 };
  const answer = await ask();
  return {
    projection: answer.projection,
    unreadableRecords: answer.unreadableRecords + repairOutcome.unreadableEvents,
    pendingRepairs: repairOutcome.pendingRuns,
  };
}

export function readCanonicalUsageSummary(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  now: number,
  repair = true,
): Promise<CanonicalUsageSource<ModelCallUsageSummary>> {
  return readCanonical(stores, query, repair, () => stores.modelCalls.modelCallSummary(query, now));
}

export function readCanonicalUsageBuckets(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  groupBy: UsageGroupBy,
  now: number,
  repair = true,
): Promise<CanonicalUsageSource<ModelCallUsageBuckets>> {
  return readCanonical(stores, query, repair, () =>
    stores.modelCalls.modelCallBuckets(query, groupBy, now),
  );
}

export function readCanonicalUsageLogs(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  now: number,
  limit: number,
  repair = true,
): Promise<CanonicalUsageSource<ModelCallUsageLogs>> {
  // Both sources are newest-first, so a merged page can only be drawn from each
  // source's own first `offset + limit` rows.
  return readCanonical(stores, query, repair, () =>
    stores.modelCalls.modelCallLogs(query, now, 0, limit),
  );
}

/** Runs one bounded repair pass and rejects data still unsafe for durable derivatives. */
export async function readCompleteCanonicalUsageSummary(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  now: number,
): Promise<CanonicalUsageSource<ModelCallUsageSummary>> {
  const source = await readCanonicalUsageSummary(stores, query, now);
  if (source.unreadableRecords > 0 || source.pendingRepairs > 0) {
    throw new CanonicalUsageProjectionIncompleteError();
  }
  return source;
}
