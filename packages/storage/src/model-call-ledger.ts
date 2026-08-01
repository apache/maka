import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

/**
 * Materialization of the canonical model-call accounting ledger (#1679).
 *
 * The durable log of record is the AgentRun event stream: every attempt is
 * appended there as `model_call_attempt_recorded`. This table is the queryable
 * read model over the same records — the AgentRun store answers "what happened
 * in this run", and no Usage question is shaped that way.
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

export interface ModelCallLedgerWriter extends ModelCallLedgerReader {
  record(attempt: ModelCallAttempt): Promise<void>;
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
    const accepted = this.#queue.then(() => {
      try {
        this.#lease.transaction('write', () => {
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
      } catch (cause) {
        throw new ModelCallLedgerPublicationError(false, { cause });
      }
    });
    this.#queue = accepted.catch(() => undefined);
    return accepted;
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
