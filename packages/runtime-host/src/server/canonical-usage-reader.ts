import { resolveUsageRange } from '@maka/core/model-call-usage-projection';
import type { UsageQuery } from '@maka/core/usage-stats/types';
import type { CanonicalUsageSource } from '@maka/core/usage-ledger-merge';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';

export interface CanonicalUsageRepairStats {
  /** Runs still pending after the bounded pass — spend not yet folded in. */
  readonly remaining: number;
  /** Authority events that could not be decoded into an attempt. */
  readonly unreadableEvents: number;
}

const NO_REPAIR: CanonicalUsageRepairStats = { remaining: 0, unreadableEvents: 0 };

export class CanonicalUsageProjectionIncompleteError extends Error {
  constructor() {
    super('Canonical Usage projection is incomplete');
    this.name = 'CanonicalUsageProjectionIncompleteError';
  }
}

/**
 * Runs one bounded repair pass against the authority. This must happen outside
 * a revision fence: catch-up writes advance the Usage snapshot revision, so a
 * fenced reader that repaired mid-read would observe its own writes and never
 * settle.
 */
export async function repairCanonicalUsageProjection(
  stores: InteractiveUsageStoresWriter,
  sessionId: string | undefined,
): Promise<CanonicalUsageRepairStats> {
  const repaired = await stores.modelCalls
    .catchUpModelCallProjection(sessionId === undefined ? undefined : { sessionId })
    .catch(() => ({ pendingRuns: 1, unreadableEvents: 0 }));
  return { remaining: repaired.pendingRuns, unreadableEvents: repaired.unreadableEvents };
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
  repair: CanonicalUsageRepairStats = NO_REPAIR,
): Promise<CanonicalUsageSource> {
  const page = await stores.modelCalls.modelCallAttempts(
    resolveUsageRange(query.range, now),
    query.sessionId,
  );
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
): Promise<CanonicalUsageSource> {
  const repair = await repairCanonicalUsageProjection(stores, query.sessionId);
  const source = await readCanonicalUsage(stores, query, now, repair);
  if (source.unreadableRecords > 0 || source.pendingRepairs > 0) {
    throw new CanonicalUsageProjectionIncompleteError();
  }
  return source;
}
