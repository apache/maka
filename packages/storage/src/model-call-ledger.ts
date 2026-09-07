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
  type ModelCallCoverage,
} from '@maka/core/model-call-attempt';
import {
  resolveUsageRange,
  type ModelCallUsageBuckets,
  type ModelCallUsageLogs,
  type ModelCallUsageSummary,
} from '@maka/core/model-call-usage-projection';
import { usageBucketKey } from '@maka/core/usage-stats/bucket-key';
import type {
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
} from '@maka/core/usage-stats/types';
import type { DatabaseSync } from 'node:sqlite';
import {
  bucketGrouping,
  CACHE_READ_TOKENS,
  count,
  countableFilter,
  COVERAGE_SUMS,
  PRICED_COST,
  REQUEST_SUMS,
  TOKEN_SUMS,
  unreadableFilter,
  type SqlFilter,
} from './model-call-usage-sql.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import { MODEL_CALL_COLUMNS } from './sqlite-usage-schema.js';
import type { ModelCallLedgerResult } from './usage-stores.js';

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
 * That recovery covers live Sessions only. Deleting a Session drops its
 * `core_agent_runs` rows and cascades both their events and this projection's
 * checkpoints, while these rows are deliberately left standing — spend does not
 * disappear from all-time totals because a conversation was deleted. For those
 * rows the projection is the last copy, so nothing may rebuild this table by
 * clearing it and replaying the stream. See
 * `ConversationOperationalStateStore.purge`.
 *
 * A row holds one column per field a cost answer reads, and nothing else.
 * Request shape and provider diagnostics are answered from the AgentRun stream;
 * copied here they would make a row grow with the conversation rather than with
 * spend. Because they are columns, a Usage total is a `SUM` this table computes
 * — the reads below return answers, not records, so asking for an all-time
 * total no longer means handing every call a workspace ever made to the caller.
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
   * Usage answers over the rows a query addresses, alongside the number of rows
   * in that window whose pricing was lost before this table held columns.
   *
   * Those are real calls whose cost is now unknown: they are reported rather
   * than dropped, because a total that silently omits them overstates what the
   * ledger knows. One of them cannot fail the query (#1638).
   */
  summary(query: UsageQuery, now: number): ModelCallLedgerResult<ModelCallUsageSummary>;
  buckets(
    query: UsageQuery,
    groupBy: UsageGroupBy,
    now: number,
  ): ModelCallLedgerResult<ModelCallUsageBuckets>;
  logs(
    query: UsageQuery,
    now: number,
    offset: number,
    limit: number,
  ): ModelCallLedgerResult<ModelCallUsageLogs>;
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

  summary(query: UsageQuery, now: number): ModelCallLedgerResult<ModelCallUsageSummary> {
    const db = this.#open();
    const range = resolveUsageRange(query.range, now);
    const filter = countableFilter(query, range);
    const row = db
      .prepare(
        `SELECT ${REQUEST_SUMS}, ${TOKEN_SUMS}, ${COVERAGE_SUMS}
         FROM usage_model_call_attempts WHERE ${filter.sql}`,
      )
      .get(...filter.parameters) as Record<string, unknown> | undefined;
    return {
      projection: {
        range,
        totalRequests: count(row?.totalRequests),
        totalCostUsd: count(row?.totalCostUsd),
        totalDurationMs: count(row?.totalDurationMs),
        totalTokens: readTokens(row),
        cacheHitRequests: count(row?.cacheHitRequests),
        cacheCreateRequests: count(row?.cacheCreateRequests),
        errorRequests: count(row?.errorRequests),
        coverage: readCoverage(row),
      },
      unreadableRecords: this.#unreadable(query, range),
    };
  }

  buckets(
    query: UsageQuery,
    groupBy: UsageGroupBy,
    now: number,
  ): ModelCallLedgerResult<ModelCallUsageBuckets> {
    const db = this.#open();
    const range = resolveUsageRange(query.range, now);
    const filter = countableFilter(query, range);
    const rows = db
      .prepare(
        `SELECT MIN(provider_id) AS providerId, MIN(model_id) AS modelId,
                MIN(completed_at) AS ts, COUNT(*) AS requests,
                SUM(${PRICED_COST}) AS costUsd, SUM(latency_ms) AS latency,
                SUM(status = 'failed') AS errors, ${TOKEN_SUMS}
         FROM usage_model_call_attempts WHERE ${filter.sql}
         GROUP BY ${bucketGrouping(groupBy)}`,
      )
      .all(...filter.parameters) as Array<Record<string, unknown>>;
    const buckets = rows
      .map((row) => {
        const requests = count(row.requests);
        const tokens = readTokens(row);
        const key = usageBucketKey(
          {
            providerId: String(row.providerId ?? ''),
            modelId: String(row.modelId ?? ''),
            ts: count(row.ts),
          },
          groupBy,
        );
        return {
          key,
          label: key,
          requests,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cacheMissTokens: tokens.cacheMiss,
          cacheReadTokens: tokens.cacheRead,
          cacheWriteTokens: tokens.cacheWrite,
          reasoningTokens: tokens.reasoning,
          totalTokens: tokens.total,
          costUsd: count(row.costUsd),
          avgLatencyMs: requests === 0 ? 0 : count(row.latency) / requests,
          errorRate: requests === 0 ? 0 : count(row.errors) / requests,
        } satisfies UsageBucket;
      })
      .sort((left, right) => right.requests - left.requests);
    return {
      projection: { buckets, coverage: this.#coverage(filter) },
      unreadableRecords: this.#unreadable(query, range),
    };
  }

  logs(
    query: UsageQuery,
    now: number,
    offset: number,
    limit: number,
  ): ModelCallLedgerResult<ModelCallUsageLogs> {
    const db = this.#open();
    const range = resolveUsageRange(query.range, now);
    const filter = countableFilter(query, range);
    const rows = db
      .prepare(
        `SELECT attempt_id, completed_at, call_kind, logical_call_id, connection_slug,
                provider_id, model_id, cost_basis, cost_usd, latency_ms, status, error_class,
                session_id, turn_id,
                COALESCE(input_tokens, 0) AS input,
                COALESCE(output_tokens, 0) AS output,
                COALESCE(cache_miss_input_tokens, 0) AS cacheMiss,
                ${CACHE_READ_TOKENS} AS cacheRead,
                COALESCE(cache_write_input_tokens, 0) AS cacheWrite,
                COALESCE(reasoning_tokens, 0) AS reasoning
         FROM usage_model_call_attempts WHERE ${filter.sql}
         ORDER BY completed_at DESC, attempt_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...filter.parameters, limit, offset) as Array<Record<string, unknown>>;
    const coverage = this.#coverage(filter);
    return {
      projection: { rows: rows.map(toUsageLogRow), total: coverage.attempts, coverage },
      unreadableRecords: this.#unreadable(query, range),
    };
  }

  #open(): DatabaseSync {
    if (this.#state !== 'open') throw new ModelCallLedgerClosedError();
    return this.#lease.database;
  }

  #coverage(filter: SqlFilter): ModelCallCoverage {
    const row = this.#lease.database
      .prepare(`SELECT ${COVERAGE_SUMS} FROM usage_model_call_attempts WHERE ${filter.sql}`)
      .get(...filter.parameters) as Record<string, unknown> | undefined;
    return readCoverage(row);
  }

  #unreadable(query: UsageQuery, range: { from: number; to: number }): number {
    const filter = unreadableFilter(query, range);
    return count(
      this.#lease.database
        .prepare(`SELECT COUNT(*) AS unreadable FROM usage_model_call_attempts WHERE ${filter.sql}`)
        .get(...filter.parameters)?.unreadable,
    );
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

function readTokens(row: Record<string, unknown> | undefined): {
  input: number;
  output: number;
  cacheMiss: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
} {
  return {
    input: count(row?.input),
    output: count(row?.output),
    cacheMiss: count(row?.cacheMiss),
    cacheRead: count(row?.cacheRead),
    cacheWrite: count(row?.cacheWrite),
    reasoning: count(row?.reasoning),
    total: count(row?.total),
  };
}

function readCoverage(row: Record<string, unknown> | undefined): ModelCallCoverage {
  return {
    attempts: count(row?.attempts),
    pricedAttempts: count(row?.pricedAttempts),
    unpricedAttempts: count(row?.unpricedAttempts),
    usageReportedAttempts: count(row?.usageReportedAttempts),
    usagePartialAttempts: count(row?.usagePartialAttempts),
    usageMissingAttempts: count(row?.usageMissingAttempts),
  };
}

function toUsageLogRow(row: Record<string, unknown>): UsageLogRow {
  const costBasis = row.cost_basis as UsageLogRow['costBasis'];
  return {
    id: String(row.attempt_id),
    ts: count(row.completed_at),
    callKind: row.call_kind as UsageLogRow['callKind'],
    callId: String(row.logical_call_id),
    ...(row.connection_slug === null ? {} : { connectionSlug: String(row.connection_slug) }),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    inputTokens: count(row.input),
    outputTokens: count(row.output),
    cacheMissTokens: count(row.cacheMiss),
    cacheReadTokens: count(row.cacheRead),
    cacheWriteTokens: count(row.cacheWrite),
    reasoningTokens: count(row.reasoning),
    totalTokens: count(row.input) + count(row.output),
    // A row keeps its basis, not just its number. Collapsing an unpriced call
    // to 0 here would reproduce, per row, exactly the ambiguity the coverage
    // breakdown removes from the totals.
    ...(costBasis === 'priced' ? { costUsd: count(row.cost_usd) } : {}),
    costBasis,
    latencyMs: count(row.latency_ms),
    status: row.status === 'completed' ? 'success' : row.status === 'failed' ? 'error' : 'aborted',
    ...(row.error_class === null ? {} : { errorClass: String(row.error_class) }),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
  };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`Invalid ${label}`);
  return resolved;
}

const MODEL_CALL_UPSERT = `
  INSERT INTO usage_model_call_attempts(${MODEL_CALL_COLUMNS.join(', ')})
  VALUES (${MODEL_CALL_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(attempt_id) DO UPDATE SET
    ${MODEL_CALL_COLUMNS.filter((column) => column !== 'attempt_id')
      .map((column) => `${column} = excluded.${column}`)
      .join(', ')}
`;

/**
 * The attempt's pricing fields, in column order.
 *
 * Keyed by column so the binding list cannot drift from the table: a column
 * added to `MODEL_CALL_COLUMNS` without a value here is a compile error.
 */
function bindModelCallAttempt(attempt: ModelCallAttempt): (string | number | null)[] {
  const values: Record<(typeof MODEL_CALL_COLUMNS)[number], string | number | null> = {
    attempt_id: attempt.attemptId,
    completed_at: attempt.completedAt,
    session_id: attempt.sessionId,
    logical_call_id: attempt.logicalCallId,
    turn_id: attempt.turnId,
    call_kind: attempt.callKind,
    connection_slug: attempt.connectionSlug ?? null,
    provider_id: attempt.providerId,
    model_id: attempt.modelId,
    latency_ms: attempt.latencyMs,
    status: attempt.status,
    error_class: attempt.errorClass ?? null,
    usage_basis: attempt.usageBasis,
    input_tokens: attempt.inputTokens ?? null,
    output_tokens: attempt.outputTokens ?? null,
    cache_read_input_tokens: attempt.cacheReadInputTokens ?? null,
    cache_miss_input_tokens: attempt.cacheMissInputTokens ?? null,
    cache_write_input_tokens: attempt.cacheWriteInputTokens ?? null,
    reasoning_tokens: attempt.reasoningTokens ?? null,
    cost_basis: attempt.costBasis,
    cost_usd: attempt.costUsd ?? null,
  };
  return MODEL_CALL_COLUMNS.map((column) => values[column]);
}

function writeModelCallAttempt(db: DatabaseSync, attempt: ModelCallAttempt): void {
  db.prepare(MODEL_CALL_UPSERT).run(...bindModelCallAttempt(attempt));
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
