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

import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { decodeAgentRunEvent, decodeRuntimeEvent } from './execution-record-codec.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  assertEvidenceReadBudget,
  measureEvidenceRows,
  type BoundedEvidenceReadResult,
  type EvidenceReadBudget,
} from './bounded-evidence.js';
import type { DurableStoreWriteError } from '@maka/core/runtime-event-store';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { MODEL_CALL_ATTEMPT_EVENT_TYPE } from '@maka/core/model-call-attempt';
import {
  LATEST_CONTEXT_PROJECTION_TYPE,
  RUN_COMPOSITION_RECORDED_EVENT_TYPE,
  supersedesLatestContext,
  type AgentRunProjectionKey,
  type AgentRunAppendOptions,
  type LatestContextProjectionInput,
  type AgentRunEvent,
  type AgentRunEventType,
  type EmittedAgentRunEvent,
} from '@maka/core/agent-run';
import { isSessionInlineInvocation } from '@maka/core/runtime-invocation';
import {
  decodeRuntimeInvocationOpened,
  runtimeEventInvocationOpening,
} from '@maka/core/runtime-event';

import {
  type RootTurnAdmission,
  type RootTurnStartRejection,
  type AdmitRootTurnInput,
  type CommitRootTurnStartRejectionInput,
  type CommitRootTurnStartRejectionResult,
  type RootTurnSourceMessageReceipt,
  type AdmitRootTurnResult,
  type DurableAgentRunStore,
  normalizeRootTurnStartRejection,
  normalizeStoredRootTurnStartRejection,
  normalizeAdmitRootTurnInput,
  shouldPreserveCheckpointProjectionDuringAppend,
  shouldPreserveProjectionDuringRepair,
  isProjectedAgentRunEvent,
  assertSafeId,
  normalizeRootTurnAdmission,
  orderRootTurnAdmissionChain,
  rootTurnAdmissionPayloadsEqual,
  sanitizeJson,
} from './agent-run-store-contract.js';
export {
  ROOT_TURN_ADMISSION_SCHEMA_VERSION,
  ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES,
  ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES,
  ROOT_TURN_ADMISSION_MAX_RECORD_BYTES,
  type RootTurnSourceMessage,
  type RootTurnAdmission,
  type RootTurnAdmissionAuthorization,
  type RootTurnStartRejection,
  type AdmitRootTurnInput,
  type CommitRootTurnStartRejectionInput,
  type CommitRootTurnStartRejectionResult,
  type RootTurnSourceMessageReceipt,
  type ImmutableSteeringMessageProof,
  type AdmitRootTurnResult,
  type RootTurnAdmissionStore,
  type RootTurnStartRejectionStore,
  type DurableAgentRunStore,
  type ConversationCopyRuntimeEventBatch,
  type RuntimeEventScanBudget,
  type RuntimeEventScanResult,
  type DurableRuntimeEventStore,
  rootTurnAdmissionRecordFits,
  normalizeRootTurnAdmissionPayload,
  type BoundedEvidenceReadResult,
  type EvidenceReadBudget,
} from './agent-run-store-contract.js';

interface RuntimePartialSnapshot {
  version: 1;
  event: RuntimeEvent;
  afterEventId?: string;
}

class RuntimeEventPostEffectError extends Error {
  readonly name = 'RuntimeEventPostEffectError';

  constructor(
    message: string,
    readonly cause: DurableStoreWriteError,
  ) {
    super(message);
  }
}

export function createSqliteAgentRunStore(workspaceRoot: string): DurableAgentRunStore {
  return new SqliteAgentRunStore(workspaceRoot);
}

class SqliteAgentRunStore implements DurableAgentRunStore {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async appendEvent(
    sessionId: string,
    runId: string,
    event: EmittedAgentRunEvent,
    options: AgentRunAppendOptions = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    this.#lease.transaction('write', () => {
      const anchor = readSqliteRunAnchor(this.#lease.database, sessionId, runId);
      this.#openLedgerStream(sessionId, runId, anchor.openedAt);
      const normalized = decodeAgentRunEvent(JSON.parse(JSON.stringify(event, sanitizeJson)), {
        sessionId,
        runId,
        turnId: anchor.turnId,
      });
      const type = normalized.type as AgentRunEventType;
      if (type === RUN_COMPOSITION_RECORDED_EVENT_TYPE) {
        // Write-once, enforced where the record lives. The composition is what
        // the run was dispatched against; a second, different one would claim
        // the run ran on a prompt and tool surface it never saw. An identical
        // re-append is the writer retrying, so it is absorbed rather than
        // refused.
        const recorded = readSqliteRunCompositionEvent(this.#lease.database, sessionId, runId);
        if (recorded) {
          if (!isDeepStrictEqual(recorded.data, normalized.data)) {
            throw new Error('AgentRun Run Composition is immutable');
          }
          return;
        }
      }
      const projectsCheckpoint = type === 'history_compact_checkpoint_recorded';
      const projection = projectsCheckpoint
        ? inspectSqliteAgentRunProjection(this.#lease.database, sessionId, type)
        : undefined;
      insertAgentRunEvent(this.#lease.database, normalized);
      if (projection && projection.state !== 'malformed') {
        const current = projectionValue(projection);
        const row = shouldPreserveCheckpointProjectionDuringAppend(current, normalized)
          ? current!
          : normalized;
        writeSqliteAgentRunProjection(this.#lease.database, sessionId, type, row);
      }
      // Derived state, committed with the event that authorises it (#2323).
      // Inside THIS transaction, so the projection cannot outlive a metering
      // append that failed, nor describe a request the ledger never recorded.
      //
      // Skipped for a subagent's run: those requests are real, but presenting
      // one as the SESSION's latest context attributes another agent's prompt
      // to this one. The opening fact is already loaded here, so the check is
      // free.
      const latestContext = options.latestContext;
      if (latestContext && anchor.sessionInline) {
        this.#writeLatestContextProjection(sessionId, normalized, latestContext);
      }
    });
  }

  /**
   * Give this run's ledger its stream row, and the Session its first one.
   *
   * The row carries no semantic state: it is the parent `core_agent_run_events`
   * hangs off and the place the model-call high water lives. Creating it on the
   * first append is what stops it from being a second record of the run's
   * existence — the opening fact already is that.
   *
   * The Session's first stream also initialises the compaction-checkpoint
   * projection to an explicit empty, which is how a reader tells "no checkpoint
   * yet" from "projection never built".
   */
  #openLedgerStream(sessionId: string, runId: string, createdAt: number): void {
    const inserted = this.#lease.database
      .prepare(
        'INSERT OR IGNORE INTO core_agent_runs(session_id, run_id, created_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, runId, createdAt);
    if (inserted.changes !== 1) return;
    const count = this.#lease.database
      .prepare('SELECT COUNT(*) AS count FROM core_agent_runs WHERE session_id = ?')
      .get(sessionId) as { count?: unknown };
    if (count.count !== 1) return;
    const projection = this.#lease.database
      .prepare(`
        SELECT 1 AS present
        FROM core_agent_run_projections
        WHERE session_id = ? AND event_type = 'history_compact_checkpoint_recorded'
      `)
      .get(sessionId);
    if (projection) return;
    this.#lease.database
      .prepare(`
        INSERT INTO core_agent_run_projections(session_id, event_type, event_json)
        VALUES (?, 'history_compact_checkpoint_recorded', NULL)
      `)
      .run(sessionId);
  }

  /**
   * Monotonic by the request's own completion, not by arrival.
   *
   * Overlapping turns append on independent queues, so a request that finished
   * at 10 can arrive after one that finished at 20. Taking the newest arrival
   * would move the answer backwards and leave a warm read disagreeing with a
   * cold rebuild of the same ledger. Ties break on `attemptId` so two requests
   * sharing a millisecond still order the same way everywhere.
   */
  #writeLatestContextProjection(
    sessionId: string,
    event: AgentRunEvent,
    latest: LatestContextProjectionInput,
  ): void {
    const inspected = inspectSqliteAgentRunProjection(
      this.#lease.database,
      sessionId,
      LATEST_CONTEXT_PROJECTION_TYPE,
    );
    // The canonical append must survive a damaged derived row, but the row's
    // ordering is unknowable. Leave it untouched until a ledger rebuild can
    // select the real latest attempt and repair it without guessing.
    if (inspected.state === 'malformed') return;
    const existing = projectionValue(inspected);
    // Compared against the stored row's own completion, which the snapshot
    // carries — not against an ordering field the row does not have, which is
    // how the first version of this guard silently never fired. The rule
    // itself is shared with the cold rebuild, so the two cannot disagree about
    // which request is the latest one.
    const current = existing?.data as { completedAt?: unknown; attemptId?: unknown } | undefined;
    if (current && typeof current.completedAt === 'number') {
      const incumbent = {
        completedAt: current.completedAt,
        attemptId: String(current.attemptId ?? ''),
      };
      const arriving = { completedAt: latest.orderedAt, attemptId: String(latest.attemptId) };
      if (!supersedesLatestContext(arriving, incumbent)) return;
    }
    writeSqliteAgentRunProjection(this.#lease.database, sessionId, LATEST_CONTEXT_PROJECTION_TYPE, {
      ...event,
      type: LATEST_CONTEXT_PROJECTION_TYPE,
      id: `latest-context-${latest.attemptId}`,
      data: latest.snapshot,
    });
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.readEventsForRecovery(sessionId, runId);
  }

  async readEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<AgentRunEvent>> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    assertEvidenceReadBudget(budget);
    return readBoundedSqliteAgentRunEvents(this.#lease.database, sessionId, runId, budget);
  }

  async readEventsByTypeBounded(
    sessionId: string,
    runId: string,
    type: AgentRunEventType,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<AgentRunEvent>> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    assertEvidenceReadBudget(budget);
    return readBoundedSqliteAgentRunEvents(this.#lease.database, sessionId, runId, budget, type);
  }

  async readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readSqliteAgentRunEvents(this.#lease.database, sessionId, runId);
  }

  async readEventsForEvidence(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readSqliteAgentRunEventsForEvidence(this.#lease.database, sessionId, runId);
  }

  async readEventProjection(
    sessionId: string,
    type: AgentRunProjectionKey,
  ): Promise<AgentRunEvent | null | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    return readSqliteAgentRunProjection(this.#lease.database, sessionId, type);
  }

  async readEventLedgerRevision(sessionId: string): Promise<string> {
    assertSafeId(sessionId, 'Invalid session id');
    return readSqliteAgentRunLedgerRevision(this.#lease.database, sessionId);
  }

  async repairEventProjection(
    sessionId: string,
    type: AgentRunProjectionKey,
    event: AgentRunEvent | null,
    options: { ifLedgerRevision: string; replaceEventId?: string },
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    if (!options || typeof options.ifLedgerRevision !== 'string') {
      throw new Error('AgentRun projection repair requires a canonical ledger revision');
    }
    if (event !== null && !isProjectedAgentRunEvent(event, sessionId, type)) {
      throw new Error(`Invalid AgentRun event projection repair for ${type}`);
    }
    this.#lease.transaction('write', () => {
      if (
        readSqliteAgentRunLedgerRevision(this.#lease.database, sessionId) !==
        options.ifLedgerRevision
      ) {
        return;
      }
      const inspected = inspectSqliteAgentRunProjection(this.#lease.database, sessionId, type);
      const current = projectionValue(inspected);
      if (
        inspected.state !== 'malformed' &&
        current?.id !== options.replaceEventId &&
        shouldPreserveProjectionDuringRepair(current, event, type)
      ) {
        return;
      }
      writeSqliteAgentRunProjection(this.#lease.database, sessionId, type, event);
    });
  }

  async admitRootTurn(input: AdmitRootTurnInput): Promise<AdmitRootTurnResult> {
    const admission = normalizeAdmitRootTurnInput(input);
    return this.#lease.transaction('write', () => {
      const existing = readSqliteRootTurnAdmission(
        this.#lease.database,
        admission.sessionId,
        admission.turnId,
      );
      if (existing) {
        return existing.previousRootTurnId === input.previousRootTurnId &&
          rootTurnAdmissionPayloadsEqual(existing, admission)
          ? { kind: 'existing', admission: existing }
          : { kind: 'conflict', admission: existing };
      }
      if (
        readSqliteRootTurnStartRejection(
          this.#lease.database,
          admission.sessionId,
          admission.turnId,
        )
      ) {
        throw new Error('Root Turn identity is already rejected');
      }
      if (admission.execution.kind === 'safe_boundary_continuation') {
        const sourceOwner = this.#lease.database
          .prepare(`
            SELECT turn_id
            FROM core_root_turn_admissions
            WHERE session_id = ?
              AND json_extract(record_json, '$.execution.sourceTurnId') = ?
              AND json_extract(record_json, '$.execution.sourceRunId') = ?
              AND json_extract(record_json, '$.execution.kind') = 'safe_boundary_continuation'
            ORDER BY admitted_at, turn_id
            LIMIT 1
          `)
          .get(
            admission.sessionId,
            admission.execution.sourceTurnId,
            admission.execution.sourceRunId,
          ) as { turn_id?: unknown } | undefined;
        if (typeof sourceOwner?.turn_id === 'string') {
          const owner = readSqliteRootTurnAdmission(
            this.#lease.database,
            admission.sessionId,
            sourceOwner.turn_id,
          );
          if (!owner) throw new Error('Root continuation index has no durable admission');
          return { kind: 'conflict', admission: owner };
        }
      }
      for (const source of admission.sourceMessages) {
        const proof = this.#lease.database
          .prepare(`
            SELECT turn_id
            FROM core_root_source_message_proofs
            WHERE session_id = ? AND message_id = ?
          `)
          .get(admission.sessionId, source.messageId) as { turn_id?: unknown } | undefined;
        if (proof && proof.turn_id !== admission.turnId) {
          throw new Error(
            `Root source message identity belongs to both ${String(proof.turn_id)} and ${admission.turnId}`,
          );
        }
      }
      this.#lease.database
        .prepare(`
          INSERT INTO core_root_turn_admissions(
            session_id, turn_id, admitted_at, record_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(
          admission.sessionId,
          admission.turnId,
          admission.admittedAt,
          JSON.stringify(admission),
        );
      for (const source of admission.sourceMessages) {
        this.#lease.database
          .prepare(`
            INSERT INTO core_root_source_message_proofs(session_id, message_id, turn_id)
            VALUES (?, ?, ?)
          `)
          .run(admission.sessionId, source.messageId, admission.turnId);
      }
      return { kind: 'admitted', admission };
    });
  }

  async readRootTurnAdmission(
    sessionId: string,
    turnId: string,
  ): Promise<RootTurnAdmission | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(turnId, 'Invalid turn id');
    return readSqliteRootTurnAdmission(this.#lease.database, sessionId, turnId);
  }

  async readRootTurnContinuationAdmission(
    sessionId: string,
    sourceTurnId: string,
    sourceRunId: string,
  ): Promise<RootTurnAdmission | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(sourceTurnId, 'Invalid source turn id');
    assertSafeId(sourceRunId, 'Invalid source run id');
    const row = this.#lease.database
      .prepare(`
        SELECT turn_id, record_json
        FROM core_root_turn_admissions
        WHERE session_id = ?
          AND json_extract(record_json, '$.execution.sourceTurnId') = ?
          AND json_extract(record_json, '$.execution.sourceRunId') = ?
          AND json_extract(record_json, '$.execution.kind') = 'safe_boundary_continuation'
        ORDER BY admitted_at, turn_id
        LIMIT 1
      `)
      .get(sessionId, sourceTurnId, sourceRunId) as
      | {
          turn_id?: unknown;
          record_json?: unknown;
        }
      | undefined;
    if (!row) return undefined;
    if (typeof row.turn_id !== 'string' || typeof row.record_json !== 'string') {
      throw new Error('Invalid SQLite root turn continuation admission row');
    }
    const admission = normalizeRootTurnAdmission(
      JSON.parse(row.record_json),
      sessionId,
      row.turn_id,
    );
    return admission;
  }

  async readRootTurnStartRejection(
    sessionId: string,
    turnId: string,
  ): Promise<RootTurnStartRejection | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(turnId, 'Invalid turn id');
    return readSqliteRootTurnStartRejection(this.#lease.database, sessionId, turnId);
  }

  async commitRootTurnStartRejection(
    input: CommitRootTurnStartRejectionInput,
  ): Promise<CommitRootTurnStartRejectionResult> {
    const rejection = normalizeRootTurnStartRejection(input);
    return this.#lease.transaction('write', () => {
      const admission = readSqliteRootTurnAdmission(
        this.#lease.database,
        rejection.sessionId,
        rejection.turnId,
      );
      if (admission) {
        throw new Error('Root Turn identity is already admitted');
      }
      const existing = readSqliteRootTurnStartRejection(
        this.#lease.database,
        rejection.sessionId,
        rejection.turnId,
      );
      if (existing) {
        return isDeepStrictEqual(existing.execution, rejection.execution) &&
          isDeepStrictEqual(existing.skillInvocation, rejection.skillInvocation)
          ? { kind: 'existing', rejection: existing }
          : { kind: 'conflict', rejection: existing };
      }
      this.#lease.database
        .prepare(`
          INSERT INTO core_root_turn_start_rejections(
            session_id, turn_id, rejected_at, record_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(
          rejection.sessionId,
          rejection.turnId,
          rejection.rejectedAt,
          JSON.stringify(rejection),
        );
      return { kind: 'committed', rejection };
    });
  }

  async readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(sourceMessageId, 'Invalid source message id');
    const row = this.#lease.database
      .prepare(`
        SELECT turn_id
        FROM core_root_source_message_proofs
        WHERE session_id = ? AND message_id = ?
      `)
      .get(sessionId, sourceMessageId) as { turn_id?: unknown } | undefined;
    if (!row) return undefined;
    if (typeof row.turn_id !== 'string') throw new Error('Invalid root source message proof row');
    const admission = readSqliteRootTurnAdmission(this.#lease.database, sessionId, row.turn_id);
    if (!admission) {
      throw new Error(`Root source message proof references missing Turn ${row.turn_id}`);
    }
    const matches = admission.sourceMessages.filter(
      (source) => source.messageId === sourceMessageId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Root source message proof does not identify exactly one source: ${sourceMessageId}`,
      );
    }
    return Object.freeze({ admission, sourceMessage: matches[0]! });
  }

  async listRootTurnAdmissionsForRecovery(sessionId: string): Promise<RootTurnAdmission[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const rows = this.#lease.database
      .prepare(`
        SELECT turn_id, record_json
        FROM core_root_turn_admissions
        WHERE session_id = ?
        ORDER BY admitted_at, turn_id
      `)
      .all(sessionId) as Array<{ turn_id?: unknown; record_json?: unknown }>;
    const admissions = rows.map((row) => {
      if (typeof row.turn_id !== 'string' || typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite root turn admission row');
      }
      return normalizeRootTurnAdmission(JSON.parse(row.record_json), sessionId, row.turn_id);
    });
    return orderRootTurnAdmissionChain(sessionId, admissions);
  }

  close(): void {
    this.#lease.close();
  }
}

function readSqliteAgentRunLedgerRevision(db: DatabaseSync, sessionId: string): string {
  const rows = db
    .prepare(`
      SELECT run.run_id, COUNT(event.sequence) AS event_count,
             COALESCE(MAX(event.sequence), -1) AS high_water
      FROM core_agent_runs AS run
      LEFT JOIN core_agent_run_events AS event
        ON event.session_id = run.session_id AND event.run_id = run.run_id
      WHERE run.session_id = ?
      GROUP BY run.run_id
      ORDER BY run.run_id
    `)
    .all(sessionId) as Array<{
    run_id?: unknown;
    event_count?: unknown;
    high_water?: unknown;
  }>;
  return JSON.stringify(
    rows.map((row) => {
      if (
        typeof row.run_id !== 'string' ||
        typeof row.event_count !== 'number' ||
        !Number.isSafeInteger(row.event_count) ||
        typeof row.high_water !== 'number' ||
        !Number.isSafeInteger(row.high_water)
      ) {
        throw new Error('Invalid SQLite AgentRun ledger revision');
      }
      return [row.run_id, row.event_count, row.high_water];
    }),
  );
}

/**
 * What the operational ledger needs to know about the run it belongs to.
 *
 * All of it is read off the event spine rather than kept beside the ledger: the
 * turn the records must agree with, when the invocation opened, and whether its
 * output is the owning Session's own conversation. Copying any of it into a
 * second row is what made the Run header a rival authority.
 *
 * An invocation whose opening the migration could not project keeps a readable
 * ledger: its turn and clock come from the events it does have, and it fails
 * closed on the one judgement the opening was needed for.
 */
interface LedgerRunAnchor {
  turnId: string;
  openedAt: number;
  sessionInline: boolean;
}

function readSqliteRunAnchor(db: DatabaseSync, sessionId: string, runId: string): LedgerRunAnchor {
  const opening = db
    .prepare(`
      SELECT turn_id, committed_at, payload_json
      FROM runtime_events
      WHERE session_id = ? AND run_id = ? AND event_kind = 'invocation_opened'
      LIMIT 1
    `)
    .get(sessionId, runId) as
    | { turn_id: string; committed_at: number; payload_json: string }
    | undefined;
  if (opening) {
    const content = runtimeEventInvocationOpening(
      decodeRuntimeEvent(JSON.parse(opening.payload_json), {
        sessionId,
        runId,
        turnId: opening.turn_id,
      }),
    );
    if (!content) throw new Error(`RuntimeEvent for run ${runId} is not an opening fact`);
    return {
      turnId: opening.turn_id,
      openedAt: opening.committed_at,
      sessionInline: isSessionInlineInvocation(content),
    };
  }
  const legacy = db
    .prepare(`
      SELECT turn_id, opened_at, opening_json
      FROM runtime_legacy_invocation_openings
      WHERE session_id = ? AND run_id = ?
      LIMIT 1
    `)
    .get(sessionId, runId) as
    | { turn_id: string; opened_at: number; opening_json: string }
    | undefined;
  if (legacy) {
    return {
      turnId: legacy.turn_id,
      openedAt: legacy.opened_at,
      sessionInline: isSessionInlineInvocation(
        decodeRuntimeInvocationOpened(JSON.parse(legacy.opening_json)),
      ),
    };
  }
  const error = new Error(`Agent run does not exist: ${runId}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}

function readSqliteAgentRunEvents(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
): AgentRunEvent[] {
  const rows = db
    .prepare(`
      SELECT record_json
      FROM core_agent_run_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY sequence
    `)
    .all(sessionId, runId) as Array<{ record_json?: unknown }>;
  if (rows.length === 0) return [];
  const anchor = readSqliteRunAnchor(db, sessionId, runId);
  return rows.map((row) => {
    if (typeof row.record_json !== 'string') {
      throw new Error('Invalid SQLite AgentRun event row');
    }
    return decodeAgentRunEvent(JSON.parse(row.record_json), {
      sessionId,
      runId,
      turnId: anchor.turnId,
    });
  });
}

/** The run's one composition row, or nothing if it has not been dispatched yet. */
function readSqliteRunCompositionEvent(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
): AgentRunEvent | undefined {
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_agent_run_events
      WHERE session_id = ? AND run_id = ? AND event_type = ?
      ORDER BY sequence
      LIMIT 1
    `)
    .get(sessionId, runId, RUN_COMPOSITION_RECORDED_EVENT_TYPE) as
    | { record_json?: unknown }
    | undefined;
  if (!row) return undefined;
  if (typeof row.record_json !== 'string') {
    throw new Error('Invalid SQLite AgentRun event row');
  }
  const anchor = readSqliteRunAnchor(db, sessionId, runId);
  return decodeAgentRunEvent(JSON.parse(row.record_json), {
    sessionId,
    runId,
    turnId: anchor.turnId,
  });
}

function readSqliteAgentRunEventsForEvidence(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
  type?: AgentRunEventType,
): AgentRunEvent[] {
  const rows = (
    type === undefined
      ? db
          .prepare(`
            SELECT sequence, record_json
            FROM core_agent_run_events
            WHERE session_id = ? AND run_id = ?
            ORDER BY sequence
          `)
          .all(sessionId, runId)
      : db
          .prepare(`
            SELECT sequence, record_json
            FROM core_agent_run_events
            WHERE session_id = ? AND run_id = ? AND event_type = ?
            ORDER BY sequence
          `)
          .all(sessionId, runId, type)
  ) as Array<{ sequence?: unknown; record_json?: unknown }>;
  if (rows.length === 0) return [];
  const anchor = readSqliteRunAnchor(db, sessionId, runId);
  return rows.map((row) => {
    const lineNumber =
      typeof row.sequence === 'number' && Number.isSafeInteger(row.sequence) ? row.sequence + 1 : 0;
    try {
      if (typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite AgentRun event row');
      }
      return decodeAgentRunEvent(JSON.parse(row.record_json), {
        sessionId,
        runId,
        turnId: anchor.turnId,
      });
    } catch (error) {
      return {
        type: 'event_corrupt',
        id: `run-event-corrupt-${lineNumber}`,
        runId,
        sessionId,
        turnId: anchor.turnId,
        ts: anchor.openedAt,
        message: error instanceof Error ? error.message : 'Invalid SQLite AgentRun event row',
        data: { lineNumber },
      };
    }
  });
}

function readBoundedSqliteAgentRunEvents(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
  budget: EvidenceReadBudget,
  type?: AgentRunEventType,
): BoundedEvidenceReadResult<AgentRunEvent> {
  const rows = (
    type === undefined
      ? db
          .prepare(`
            SELECT length(CAST(record_json AS BLOB)) AS stored_bytes
            FROM core_agent_run_events
            WHERE session_id = ? AND run_id = ?
            ORDER BY sequence
            LIMIT ?
          `)
          .all(sessionId, runId, budget.maxRecords + 1)
      : db
          .prepare(`
            SELECT length(CAST(record_json AS BLOB)) AS stored_bytes
            FROM core_agent_run_events
            WHERE session_id = ? AND run_id = ? AND event_type = ?
            ORDER BY sequence
            LIMIT ?
          `)
          .all(sessionId, runId, type, budget.maxRecords + 1)
  ) as Array<{ stored_bytes?: unknown }>;
  const measurement = measureEvidenceRows(
    rows,
    budget,
    'Invalid SQLite AgentRun evidence measurement row',
  );
  if (!measurement) return { status: 'limit_exceeded' };
  return {
    status: 'complete',
    records: readSqliteAgentRunEventsForEvidence(db, sessionId, runId, type),
    ...measurement,
  };
}

function insertAgentRunEvent(db: DatabaseSync, event: AgentRunEvent): void {
  const row = db
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM core_agent_run_events
      WHERE session_id = ? AND run_id = ?
    `)
    .get(event.sessionId, event.runId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next AgentRun event sequence');
  }
  db.prepare(`
    INSERT INTO core_agent_run_events(
      session_id, run_id, sequence, event_id, event_type, event_ts, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.sessionId,
    event.runId,
    row.sequence,
    event.id,
    event.type,
    event.ts,
    JSON.stringify(event, sanitizeJson),
  );
  if (event.type === MODEL_CALL_ATTEMPT_EVENT_TYPE) {
    const updated = db
      .prepare(`
        UPDATE core_agent_runs
        SET latest_model_call_sequence = ?
        WHERE session_id = ? AND run_id = ?
          AND (latest_model_call_sequence IS NULL OR latest_model_call_sequence < ?)
      `)
      .run(row.sequence, event.sessionId, event.runId, row.sequence).changes;
    if (updated !== 1) throw new Error('Failed to advance model-call authority high-water');
  }
}

function readSqliteAgentRunProjection(
  db: DatabaseSync,
  sessionId: string,
  // A projection key, not necessarily an event type: `latest_context` names a
  // derived row nothing ever appends under (#2323).
  type: string,
): AgentRunEvent | null | undefined {
  const inspected = inspectSqliteAgentRunProjection(db, sessionId, type);
  if (inspected.state === 'malformed') {
    throw new Error(`Invalid AgentRun event projection for ${type}`);
  }
  return projectionValue(inspected);
}

type SqliteAgentRunProjectionInspection =
  | { state: 'missing' }
  | { state: 'empty' }
  | { state: 'malformed' }
  | { state: 'valid'; event: AgentRunEvent };

function inspectSqliteAgentRunProjection(
  db: DatabaseSync,
  sessionId: string,
  type: string,
): SqliteAgentRunProjectionInspection {
  const row = db
    .prepare(`
      SELECT event_json
      FROM core_agent_run_projections
      WHERE session_id = ? AND event_type = ?
    `)
    .get(sessionId, type) as { event_json?: unknown } | undefined;
  if (!row) return { state: 'missing' };
  if (row.event_json === null) return { state: 'empty' };
  if (typeof row.event_json !== 'string') return { state: 'malformed' };
  let event: unknown;
  try {
    event = JSON.parse(row.event_json);
  } catch {
    return { state: 'malformed' };
  }
  if (!isProjectedAgentRunEvent(event, sessionId, type)) {
    return { state: 'malformed' };
  }
  return { state: 'valid', event };
}

function projectionValue(
  inspected: SqliteAgentRunProjectionInspection,
): AgentRunEvent | null | undefined {
  if (inspected.state === 'valid') return inspected.event;
  return inspected.state === 'empty' ? null : undefined;
}

function writeSqliteAgentRunProjection(
  db: DatabaseSync,
  sessionId: string,
  type: string,
  event: AgentRunEvent | null,
): void {
  db.prepare(`
    INSERT INTO core_agent_run_projections(session_id, event_type, event_json)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, event_type) DO UPDATE SET event_json = excluded.event_json
  `).run(sessionId, type, event === null ? null : JSON.stringify(event, sanitizeJson));
}

function readSqliteRootTurnAdmission(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
): RootTurnAdmission | undefined {
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_root_turn_admissions
      WHERE session_id = ? AND turn_id = ?
    `)
    .get(sessionId, turnId) as { record_json?: unknown } | undefined;
  if (!row) return undefined;
  if (typeof row.record_json !== 'string') throw new Error('Invalid root turn admission row');
  return normalizeRootTurnAdmission(JSON.parse(row.record_json), sessionId, turnId);
}

function readSqliteRootTurnStartRejection(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
): RootTurnStartRejection | undefined {
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_root_turn_start_rejections
      WHERE session_id = ? AND turn_id = ?
    `)
    .get(sessionId, turnId) as { record_json?: unknown } | undefined;
  if (!row) return undefined;
  if (typeof row.record_json !== 'string') {
    throw new Error('Invalid root Turn start rejection row');
  }
  return normalizeStoredRootTurnStartRejection(JSON.parse(row.record_json), sessionId, turnId);
}
