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

import {
  decodeModelCallAttempt,
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { DatabaseSync } from 'node:sqlite';
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
 * Recovery compares the AgentRun stream's durable sequence with this
 * projection's applied-through checkpoint. There is no second "dirty" fact to
 * race with the authority: any committed event beyond the checkpoint remains
 * discoverable until it has been projected in the same transaction that
 * advances the checkpoint.
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
  read(
    range: { readonly from: number; readonly to: number },
    sessionId?: string,
  ): ModelCallLedgerPage;
}

export interface ModelCallLedgerPage {
  readonly attempts: readonly ModelCallAttempt[];
  readonly unreadableRecords: number;
}

export interface CatchUpModelCallProjectionInput {
  readonly sessionId?: string;
  readonly runId?: string;
  /** Bounds the number of lagging runs processed in one pass. */
  readonly limit?: number;
  /** Bounds authority events processed for each run in one pass. */
  readonly eventsPerRun?: number;
}

export interface CatchUpModelCallProjectionResult {
  readonly changedSessionIds: readonly string[];
  readonly pendingRuns: number;
  readonly unreadableEvents: number;
}

export interface ModelCallLedgerWriter extends ModelCallLedgerReader {
  /** Advances the read model from the AgentRun authority's durable sequence. */
  catchUpProjection(
    input?: CatchUpModelCallProjectionInput,
  ): Promise<CatchUpModelCallProjectionResult>;
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

  private write<T>(operation: () => T): Promise<T> {
    const accepted = this.#queue.then(() => {
      try {
        return this.#lease.transaction('write', operation);
      } catch (cause) {
        throw new ModelCallLedgerPublicationError(false, { cause });
      }
    });
    this.#queue = accepted.then(
      () => undefined,
      () => undefined,
    );
    return accepted;
  }

  catchUpProjection(
    input: CatchUpModelCallProjectionInput = {},
  ): Promise<CatchUpModelCallProjectionResult> {
    if (this.#state !== 'open') return Promise.reject(new ModelCallLedgerClosedError());
    if (input.runId !== undefined && input.sessionId === undefined) {
      return Promise.reject(new Error('A run-scoped projection catch-up requires sessionId'));
    }
    const limit = positiveInteger(input.limit, 16, 'projection catch-up limit');
    const eventsPerRun = positiveInteger(
      input.eventsPerRun,
      512,
      'projection catch-up event limit',
    );
    return this.write(() =>
      catchUpModelCallProjection(this.#lease.database, input, limit, eventsPerRun),
    );
  }

  read(
    range: { readonly from: number; readonly to: number },
    sessionId?: string,
  ): ModelCallLedgerPage {
    if (this.#state !== 'open') throw new ModelCallLedgerClosedError();
    const rows = this.#lease.database
      .prepare(
        sessionId
          ? `SELECT record_json FROM usage_model_call_attempts
             WHERE session_id = ? AND completed_at >= ? AND completed_at <= ?
             ORDER BY completed_at ASC, attempt_id ASC`
          : `SELECT record_json FROM usage_model_call_attempts
             WHERE completed_at >= ? AND completed_at <= ?
             ORDER BY completed_at ASC, attempt_id ASC`,
      )
      .all(...(sessionId ? [sessionId, range.from, range.to] : [range.from, range.to])) as Array<{
      record_json: string;
    }>;
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

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`Invalid ${label}`);
  return resolved;
}

function writeModelCallAttempt(db: DatabaseSync, attempt: ModelCallAttempt): void {
  db.prepare(`
      INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json, session_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        completed_at = excluded.completed_at,
        record_json = excluded.record_json,
        session_id = excluded.session_id
      WHERE completed_at IS NOT excluded.completed_at
         OR record_json IS NOT excluded.record_json
         OR session_id IS NOT excluded.session_id
    `).run(attempt.attemptId, attempt.completedAt, JSON.stringify(attempt), attempt.sessionId);
}

interface LaggingRunRow {
  readonly session_id: string;
  readonly run_id: string;
  readonly high_water: number;
  readonly applied_through: number;
}

function catchUpModelCallProjection(
  db: DatabaseSync,
  input: CatchUpModelCallProjectionInput,
  limit: number,
  eventsPerRun: number,
): CatchUpModelCallProjectionResult {
  const scope = projectionScope(input);
  const lagging = db
    .prepare(`
      WITH source AS (
        SELECT session_id, run_id, latest_model_call_sequence AS high_water
        FROM core_agent_runs
        WHERE latest_model_call_sequence IS NOT NULL${scope.sourceWhere}
      )
      SELECT source.session_id, source.run_id, source.high_water,
             COALESCE(checkpoint.applied_through_sequence, -1) AS applied_through
      FROM source
      LEFT JOIN usage_model_call_projection_checkpoints AS checkpoint
        ON checkpoint.session_id = source.session_id
       AND checkpoint.run_id = source.run_id
      WHERE source.high_water > COALESCE(checkpoint.applied_through_sequence, -1)
      ORDER BY source.session_id, source.run_id
      LIMIT ?
    `)
    .all(...scope.parameters, limit) as unknown as LaggingRunRow[];

  const changedSessionIds = new Set<string>();
  for (const run of lagging) {
    const rows = db
      .prepare(`
        SELECT sequence, record_json
        FROM core_agent_run_events
        WHERE session_id = ? AND run_id = ? AND event_type = ?
          AND sequence > ? AND sequence <= ?
        ORDER BY sequence ASC
        LIMIT ?
      `)
      .all(
        run.session_id,
        run.run_id,
        MODEL_CALL_ATTEMPT_EVENT_TYPE,
        run.applied_through,
        run.high_water,
        eventsPerRun,
      ) as Array<{ sequence: number; record_json: string }>;
    if (rows.length === 0) continue;

    let unreadableEvents = 0;
    for (const row of rows) {
      let attempt: ModelCallAttempt;
      try {
        const event = JSON.parse(row.record_json) as { readonly data?: unknown };
        attempt = decodeModelCallAttempt(event.data);
        if (attempt.sessionId !== run.session_id || attempt.runId !== run.run_id) {
          throw new Error('Model-call attempt identity disagrees with its AgentRun envelope');
        }
      } catch {
        unreadableEvents += 1;
        continue;
      }
      // Projection storage failures must roll the transaction back. Treating
      // one as corrupt authority would advance the checkpoint past a valid,
      // still-unprojected billed call.
      writeModelCallAttempt(db, attempt);
    }
    const appliedThrough = rows.at(-1)?.sequence;
    if (appliedThrough === undefined) continue;
    db.prepare(`
      INSERT INTO usage_model_call_projection_checkpoints(
        session_id, run_id, applied_through_sequence, unreadable_events
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, run_id) DO UPDATE SET
        applied_through_sequence = excluded.applied_through_sequence,
        unreadable_events = usage_model_call_projection_checkpoints.unreadable_events
          + excluded.unreadable_events
    `).run(run.session_id, run.run_id, appliedThrough, unreadableEvents);
    changedSessionIds.add(run.session_id);
  }

  const pendingRuns = Number(
    db
      .prepare(`
        WITH source AS (
          SELECT session_id, run_id, latest_model_call_sequence AS high_water
          FROM core_agent_runs
          WHERE latest_model_call_sequence IS NOT NULL${scope.sourceWhere}
        )
        SELECT COUNT(*) AS count
        FROM source
        LEFT JOIN usage_model_call_projection_checkpoints AS checkpoint
          ON checkpoint.session_id = source.session_id
         AND checkpoint.run_id = source.run_id
        WHERE source.high_water > COALESCE(checkpoint.applied_through_sequence, -1)
      `)
      .get(...scope.parameters)?.count ?? 0,
  );
  const unreadableEvents = Number(
    db
      .prepare(`
        SELECT COALESCE(SUM(unreadable_events), 0) AS count
        FROM usage_model_call_projection_checkpoints
        WHERE 1 = 1${scope.checkpointWhere}
      `)
      .get(...scope.parameters)?.count ?? 0,
  );
  return { changedSessionIds: [...changedSessionIds], pendingRuns, unreadableEvents };
}

function projectionScope(input: CatchUpModelCallProjectionInput): {
  readonly sourceWhere: string;
  readonly checkpointWhere: string;
  readonly parameters: readonly string[];
} {
  if (input.runId !== undefined) {
    return {
      sourceWhere: ' AND session_id = ? AND run_id = ?',
      checkpointWhere: ' AND session_id = ? AND run_id = ?',
      parameters: [input.sessionId!, input.runId],
    };
  }
  if (input.sessionId !== undefined) {
    return {
      sourceWhere: ' AND session_id = ?',
      checkpointWhere: ' AND session_id = ?',
      parameters: [input.sessionId],
    };
  }
  return { sourceWhere: '', checkpointWhere: '', parameters: [] };
}
