import { resolveUsageRange } from '@maka/core/model-call-usage-projection';
import type { UsageQuery } from '@maka/core/usage-stats/types';
import type { CanonicalUsageSource } from '@maka/core/usage-ledger-merge';
import { repairPendingModelCallProjections } from '@maka/storage/model-call-ledger';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';

export type RunEventReader = (
  sessionId: string,
  runId: string,
) => Promise<readonly { readonly type: string; readonly data?: Record<string, unknown> }[]>;

const USAGE_REPAIR_RUNS_PER_QUERY = 16;
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
  readRunEvents?: RunEventReader,
): Promise<CanonicalUsageSource> {
  const repair = readRunEvents
    ? await repairPendingModelCallProjections({
        ledger: {
          record: (attempt) => stores.modelCalls.recordModelCallAttempt(attempt),
          pending: () => stores.modelCalls.pendingReprojections(),
          clear: (sessionId, runId) => stores.modelCalls.clearPendingReprojection(sessionId, runId),
        },
        readRunEvents,
        limit: USAGE_REPAIR_RUNS_PER_QUERY,
      })
    : { remaining: 0, unreadableEvents: 0 };
  const page = await stores.modelCalls.modelCallAttempts(resolveUsageRange(query.range, now));
  return {
    attempts: page.attempts,
    unreadableRecords: page.unreadableRecords + repair.unreadableEvents,
    pendingRepairs: repair.remaining,
  };
}

/** Runs one bounded repair pass and rejects data still unsafe for durable derivatives. */
export async function readCompleteCanonicalUsage(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  now: number,
  readRunEvents: RunEventReader,
): Promise<CanonicalUsageSource> {
  const source = await readCanonicalUsage(stores, query, now, readRunEvents);
  if (source.unreadableRecords > 0 || source.pendingRepairs > 0) {
    throw new CanonicalUsageProjectionIncompleteError();
  }
  return source;
}
