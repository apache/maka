import { resolveUsageRange } from '@maka/core/model-call-usage-projection';
import type { UsageQuery } from '@maka/core/usage-stats/types';
import type { CanonicalUsageSource } from '@maka/core/usage-ledger-merge';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
export class CanonicalUsageProjectionIncompleteError extends Error {
  constructor() {
    super('Canonical Usage projection is incomplete');
    this.name = 'CanonicalUsageProjectionIncompleteError';
  }
}

/** Reads and repairs the canonical usage source shared by Host-owned projections. */
export async function readCanonicalUsage(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  now: number,
): Promise<CanonicalUsageSource> {
  const repair = await stores.modelCalls
    .catchUpModelCallProjection(
      query.sessionId === undefined ? undefined : { sessionId: query.sessionId },
    )
    .catch(() => ({ pendingRuns: 1, unreadableEvents: 0 }));
  const page = await stores.modelCalls.modelCallAttempts(
    resolveUsageRange(query.range, now),
    query.sessionId,
  );
  return {
    attempts: page.attempts,
    unreadableRecords: page.unreadableRecords + repair.unreadableEvents,
    pendingRepairs: repair.pendingRuns,
  };
}

/** Runs one bounded repair pass and rejects data still unsafe for durable derivatives. */
export async function readCompleteCanonicalUsage(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  now: number,
): Promise<CanonicalUsageSource> {
  const source = await readCanonicalUsage(stores, query, now);
  if (source.unreadableRecords > 0 || source.pendingRepairs > 0) {
    throw new CanonicalUsageProjectionIncompleteError();
  }
  return source;
}
