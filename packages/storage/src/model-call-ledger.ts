import {
  decodeModelCallAttempt,
  modelCallAttemptsFromRunEvents,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

/**
 * Materialization of the canonical model-call accounting ledger (#1679).
 *
 * The single durable authority is the AgentRun event stream: an attempt is
 * committed there as `model_call_attempt_recorded` before anything reaches this
 * table. Everything here is a projection of that stream, never an independent
 * write, and the upsert key is `attemptId` so re-projecting is idempotent.
 *
 * The table exists because the AgentRun store answers "what happened in this
 * run" and no Usage question is shaped that way. It may fall behind the stream
 * — a failed upsert, a crash between the two — and that is recoverable: the
 * authority still holds every record, so re-projecting the run restores it.
 *
 * Recovery is driven by {@link ModelCallLedgerWriter.markRunPendingReprojection},
 * which is written *before* the projection is attempted, so it is an intent
 * record rather than an error record: a crash at any point after it still
 * leaves a run the repair finds. The honest limit is the window between the
 * authority append and the marker — a process that dies inside it leaves a
 * committed record this table will not learn about, because nothing sweeps the
 * whole stream. Closing that needs a full re-projection pass over every run,
 * which is not implemented here.
 *
 * Deliberately separate from `usage_llm_calls`. That table is a frozen
 * historical projection with no way to express `usageBasis` or `costBasis`, so
 * writing canonical records into it would land unpriced spend as `costUsd: 0` —
 * the failure this ledger exists to remove.
 */
export interface ModelCallLedgerReader {
  /**
   * Attempts settled within `range`, deduped by `attemptId` with the last write
   * winning, alongside the number of stored rows that could not be decoded.
   *
   * Unreadable rows are reported rather than dropped: they are real calls whose
   * cost is now unknown, and a total that silently omits them overstates what
   * the ledger knows. One corrupt row must not fail the query (#1638).
   */
  read(range: { readonly from: number; readonly to: number }): ModelCallLedgerPage;
}

export interface ModelCallLedgerPage {
  readonly attempts: readonly ModelCallAttempt[];
  readonly unreadableRecords: number;
}

export interface PendingReprojection {
  readonly sessionId: string;
  readonly runId: string;
  readonly markedAt: number;
}

export interface ModelCallLedgerWriter extends ModelCallLedgerReader {
  /** Projects one attempt already committed to the authority. Idempotent. */
  record(attempt: ModelCallAttempt): Promise<void>;
  /**
   * Records that a run's committed attempts may not be fully projected here.
   * Best-effort: losing the marker costs a targeted repair, not the records.
   */
  markRunPendingReprojection(sessionId: string, runId: string): Promise<void>;
  pendingReprojections(): PendingReprojection[];
  clearPendingReprojection(sessionId: string, runId: string): Promise<void>;
}

export interface ModelCallLedger extends ModelCallLedgerWriter {
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class ModelCallLedgerClosedError extends Error {
  constructor() {
    super('Model call ledger is draining or closed');
    this.name = 'ModelCallLedgerClosedError';
  }
}

export class ModelCallLedgerPublicationError extends Error {
  readonly commitUnknown: boolean;

  constructor(commitUnknown: boolean, options?: ErrorOptions) {
    super('Model call ledger publication failed', options);
    this.name = 'ModelCallLedgerPublicationError';
    this.commitUnknown = commitUnknown;
  }
}

export function createSqliteModelCallLedger(workspaceRoot: string): ModelCallLedger {
  return new SqliteModelCallLedger(workspaceRoot);
}

class SqliteModelCallLedger implements ModelCallLedger {
  readonly #lease: OperationalStateDatabaseLease;
  #state: 'open' | 'draining' | 'closed' = 'open';
  #queue: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(workspaceRoot);
  }

  record(attempt: ModelCallAttempt): Promise<void> {
    let admitted: ModelCallAttempt;
    try {
      admitted = decodeModelCallAttempt(attempt);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#state !== 'open') return Promise.reject(new ModelCallLedgerClosedError());
    // Last write wins on `attemptId`: an abort records provisionally and a late
    // `finish` settles the same attempt, so the settled record must replace the
    // provisional one rather than duplicate it.
    return this.write(() => {
      this.#lease.database
        .prepare(`
          INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json)
          VALUES (?, ?, ?)
          ON CONFLICT(attempt_id) DO UPDATE SET
            completed_at = excluded.completed_at,
            record_json = excluded.record_json
        `)
        .run(admitted.attemptId, admitted.completedAt, JSON.stringify(admitted));
    });
  }

  private write(operation: () => void): Promise<void> {
    const accepted = this.#queue.then(() => {
      try {
        this.#lease.transaction('write', operation);
      } catch (cause) {
        throw new ModelCallLedgerPublicationError(false, { cause });
      }
    });
    this.#queue = accepted.catch(() => undefined);
    return accepted;
  }

  markRunPendingReprojection(sessionId: string, runId: string): Promise<void> {
    if (this.#state !== 'open') return Promise.reject(new ModelCallLedgerClosedError());
    return this.write(() => {
      this.#lease.database
        .prepare(`
          INSERT INTO usage_model_call_reprojection(session_id, run_id, marked_at)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id, run_id) DO NOTHING
        `)
        .run(sessionId, runId, Date.now());
    });
  }

  pendingReprojections(): PendingReprojection[] {
    if (this.#state !== 'open') throw new ModelCallLedgerClosedError();
    const rows = this.#lease.database
      .prepare(
        'SELECT session_id, run_id, marked_at FROM usage_model_call_reprojection ORDER BY marked_at ASC',
      )
      .all() as Array<{ session_id: string; run_id: string; marked_at: number }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      runId: row.run_id,
      markedAt: row.marked_at,
    }));
  }

  clearPendingReprojection(sessionId: string, runId: string): Promise<void> {
    if (this.#state !== 'open') return Promise.reject(new ModelCallLedgerClosedError());
    return this.write(() => {
      this.#lease.database
        .prepare('DELETE FROM usage_model_call_reprojection WHERE session_id = ? AND run_id = ?')
        .run(sessionId, runId);
    });
  }

  read(range: { readonly from: number; readonly to: number }): ModelCallLedgerPage {
    if (this.#state !== 'open') throw new ModelCallLedgerClosedError();
    const rows = this.#lease.database
      .prepare(`
        SELECT record_json FROM usage_model_call_attempts
        WHERE completed_at >= ? AND completed_at <= ?
        ORDER BY completed_at ASC, attempt_id ASC
      `)
      .all(range.from, range.to) as Array<{ record_json: string }>;
    const attempts: ModelCallAttempt[] = [];
    let unreadableRecords = 0;
    for (const row of rows) {
      try {
        attempts.push(decodeModelCallAttempt(JSON.parse(row.record_json)));
      } catch {
        unreadableRecords += 1;
      }
    }
    return { attempts, unreadableRecords };
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'draining';
    this.#closePromise = this.#queue
      .catch(() => undefined)
      .finally(() => {
        this.#state = 'closed';
        this.#lease.close();
      });
    return this.#closePromise;
  }
}

/**
 * The write surface a repair needs. Named as a port rather than typed to the
 * store itself so the Host can pass its lease-bound facade and an embedded host
 * can pass the store directly, without either shape leaking into the other.
 */
export interface ModelCallProjectionTarget {
  record(attempt: ModelCallAttempt): Promise<void>;
  pending(): PendingReprojection[] | Promise<PendingReprojection[]>;
  clear(sessionId: string, runId: string): Promise<void>;
}

export interface RepairModelCallProjectionsInput {
  readonly ledger: ModelCallProjectionTarget;
  /**
   * The authority read. Returns the AgentRun events of one run, from which the
   * committed attempts are re-derived.
   */
  readonly readRunEvents: (
    sessionId: string,
    runId: string,
  ) => Promise<readonly { readonly type: string; readonly data?: Record<string, unknown> }[]>;
  /** Bounds one pass so a repair cannot stall a Usage query indefinitely. */
  readonly limit?: number;
}

export interface RepairModelCallProjectionsResult {
  /** Runs re-projected and cleared in this pass. */
  readonly repaired: number;
  /** Runs still marked afterwards — whatever this pass could not fix. */
  readonly remaining: number;
  /**
   * Authority events that could not be decoded into an attempt. Real calls
   * whose cost is now unknown: clearing the marker without carrying this count
   * would drop them out of the totals and out of the pending count at once,
   * leaving nothing to say they existed.
   */
  readonly unreadableEvents: number;
}

/**
 * Re-derives marked runs from the authority and folds them back into the read
 * model, then clears their markers.
 *
 * Idempotent by construction: the upsert key is `attemptId`, so re-projecting a
 * run the table already holds changes nothing. A run whose authority read fails
 * keeps its marker and is retried on a later pass — the records are not lost,
 * only the projection is behind, which {@link RepairModelCallProjectionsResult}
 * reports so a caller can qualify the answer it serves.
 */
export async function repairPendingModelCallProjections(
  input: RepairModelCallProjectionsInput,
): Promise<RepairModelCallProjectionsResult> {
  let pending: readonly PendingReprojection[];
  try {
    pending = await input.ledger.pending();
  } catch {
    return { repaired: 0, remaining: 0, unreadableEvents: 0 };
  }
  if (pending.length === 0) return { repaired: 0, remaining: 0, unreadableEvents: 0 };

  const batch = pending.slice(0, input.limit ?? pending.length);
  let repaired = 0;
  let unreadableEvents = 0;
  for (const entry of batch) {
    try {
      const events = await input.readRunEvents(entry.sessionId, entry.runId);
      const decoded = modelCallAttemptsFromRunEvents(events);
      for (const attempt of decoded.attempts) await input.ledger.record(attempt);
      unreadableEvents += decoded.unreadableEvents;
      if (decoded.unreadableEvents > 0) continue;
      await input.ledger.clear(entry.sessionId, entry.runId);
      repaired += 1;
    } catch {
      // Keep the marker. The authority still holds this run's records.
    }
  }
  return { repaired, remaining: pending.length - repaired, unreadableEvents };
}
