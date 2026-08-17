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

export interface CanonicalUsageRepairStats {
  /** Runs still marked after the bounded pass — spend not yet folded in. */
  readonly remaining: number;
  /** Authority events that could not be decoded into an attempt. */
  readonly unreadableEvents: number;
}

export class CanonicalUsageProjectionIncompleteError extends Error {
  constructor() {
    super('Canonical Usage projection is incomplete');
    this.name = 'CanonicalUsageProjectionIncompleteError';
  }
}

/**
 * Runs one bounded repair pass against the authority. This must happen outside
 * a revision fence: `record`/`clear` advance the Usage snapshot revision, so a
 * fenced reader that repaired mid-read would observe its own writes and never
 * settle.
 */
export async function repairPendingCanonicalUsage(
  stores: InteractiveUsageStoresWriter,
  readRunEvents: RunEventReader,
): Promise<CanonicalUsageRepairStats> {
  const repair = await repairPendingModelCallProjections({
    ledger: {
      record: (attempt) => stores.modelCalls.recordModelCallAttempt(attempt),
      pending: () => stores.modelCalls.pendingReprojections(),
      clear: (sessionId, runId) => stores.modelCalls.clearPendingReprojection(sessionId, runId),
    },
    readRunEvents,
    limit: USAGE_REPAIR_RUNS_PER_QUERY,
  });
  return { remaining: repair.remaining, unreadableEvents: repair.unreadableEvents };
}

/**
 * Reads the canonical usage source without writing. Callers that repaired
 * first pass the pass stats so the answer stays qualified; this read itself
 * never mutates the read model.
 */
export async function readCanonicalUsage(
  stores: InteractiveUsageStoresWriter,
  query: UsageQuery,
  now: number,
  repair: CanonicalUsageRepairStats = { remaining: 0, unreadableEvents: 0 },
): Promise<CanonicalUsageSource> {
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
  const repair = await repairPendingCanonicalUsage(stores, readRunEvents);
  const source = await readCanonicalUsage(stores, query, now, repair);
  if (source.unreadableRecords > 0 || source.pendingRepairs > 0) {
    throw new CanonicalUsageProjectionIncompleteError();
  }
  return source;
}
