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
  registerGoalWait,
  readGoalWaitRootExecution,
  readCompletedGoalWaitExecution,
  type GoalWaitRuntimeReader,
  settleGoalWait,
  queueGoalWait,
  type RegisterGoalWaitInput,
  type SettleGoalWaitInput,
  type QueueGoalWaitInput,
  type GoalWaitSnapshot,
} from './event-wait-bridge.js';
import {
  readBridgeGoal,
  readBridgeWait,
  readBridgeTermination,
  writeBridgeSnapshot,
  assertBridgeSession,
} from './sqlite-event-wait-bridge.js';
import { createWorkspaceRuntimeStore } from './runtime-event-persistence.js';
import { normalizeRootTurnAdmission } from './agent-run-store-contract.js';
import { isDeepStrictEqual } from 'node:util';
import {
  assertEventWaitTransition,
  decodeEventWaitRecord,
  EVENT_WAIT_LIMITS,
} from '@maka/core/event-wait';
import {
  eventWaitPage,
  eventWaitSourceKey,
  EVENT_WAIT_PAGE_LIMIT,
  normalizeEventWaitCommit,
  validateEventWaitPage,
  validateEventWaitRead,
  validateEventWaitStatusPage,
  validateEventWaitObservationList,
  validateEventWaitSource,
  validateEventWaitSourceCooldown,
  validateEventWaitSourceDispatch,
  type EventWaitSource,
  type ExtendEventWaitSourceCooldownInput,
  type ReserveEventWaitSourceDispatchInput,
  type CompleteEventWaitSourceDispatchInput,
  type ListEventWaitsByStatusInput,
  type ListEventWaitsForObservationInput,
  type CommitEventWaitInput,
  type CommitEventWaitResult,
  type EventWaitAuthorityRepository,
  type EventWaitPage,
  type EventWaitSnapshot,
  type ListPendingEventWaitsInput,
  type ListSessionEventWaitsInput,
  type ReadEventWaitInput,
} from './event-wait-authority.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

class SqliteEventWaitAuthority implements EventWaitAuthorityRepository {
  readonly #database: OperationalStateDatabaseLease;
  readonly #runtime: GoalWaitRuntimeReader;
  readonly #closeRuntime?: () => void;
  #closed = false;
  constructor(root: string, runtime?: GoalWaitRuntimeReader) {
    this.#database = acquireOperationalStateDatabase(root);
    try {
      if (runtime) this.#runtime = runtime;
      else {
        const owned = createWorkspaceRuntimeStore(root);
        this.#runtime = owned;
        this.#closeRuntime = () => owned.close();
      }
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('SQLite event wait authority is closed');
  }
  read(input: ReadEventWaitInput): EventWaitSnapshot | null {
    this.#assertOpen();
    validateEventWaitRead(input);
    return this.#database.transaction('read', () => {
      const row = this.#database.database
        .prepare('SELECT * FROM workflow_event_waits WHERE session_id = ? AND wait_id = ?')
        .get(input.sessionId, input.waitId);
      return row === undefined ? null : readRow(row);
    });
  }
  listSession(input: ListSessionEventWaitsInput): EventWaitPage {
    this.#assertOpen();
    validateEventWaitPage(input, true);
    return this.#database.transaction('read', () =>
      eventWaitPage(
        this.#database.database
          .prepare(
            'SELECT * FROM workflow_event_waits WHERE session_id = ? AND wait_id > ? ORDER BY wait_id LIMIT ?',
          )
          .all(input.sessionId, input.afterWaitId ?? '', input.limit + 1)
          .map(readRow),
        input.limit,
      ),
    );
  }
  listPending(input: ListPendingEventWaitsInput): EventWaitPage {
    this.#assertOpen();
    validateEventWaitPage(input);
    return this.#database.transaction('read', () =>
      eventWaitPage(
        this.#database.database
          .prepare(
            "SELECT * FROM workflow_event_waits WHERE status IN ('waiting', 'resolved') AND json_extract(record_json, '$.delivery') IS NULL AND wait_id > ? ORDER BY wait_id LIMIT ?",
          )
          .all(input.afterWaitId ?? '', input.limit + 1)
          .map(readRow),
        input.limit,
      ),
    );
  }
  listByStatus(input: ListEventWaitsByStatusInput): EventWaitPage {
    this.#assertOpen();
    validateEventWaitStatusPage(input);
    return this.#database.transaction('read', () =>
      eventWaitPage(
        this.#database.database
          .prepare(
            `SELECT * FROM workflow_event_waits WHERE status = ? ${input.deliveryOutstanding ? "AND json_extract(record_json, '$.delivery') IS NULL" : ''} AND wait_id > ? ORDER BY wait_id LIMIT ?`,
          )
          .all(input.status, input.afterWaitId ?? '', input.limit + 1)
          .map(readRow),
        input.limit,
      ),
    );
  }
  listForObservation(input: ListEventWaitsForObservationInput): readonly EventWaitSnapshot[] {
    this.#assertOpen();
    validateEventWaitObservationList(input);
    const index = input.scan
      ? 'workflow_event_waits_by_status'
      : 'workflow_event_waits_observation_order';
    const order = input.scan
      ? 'w.wait_id'
      : "COALESCE(json_extract(w.record_json, '$.observation.lastAttemptAt'), 0), w.wait_id";
    return this.#database.transaction('read', () =>
      this.#database.database
        .prepare(`SELECT w.* FROM workflow_event_waits AS w
          INDEXED BY ${index}
          LEFT JOIN workflow_event_wait_source_cooldowns AS c
            ON c.source_key = json_array(json_extract(w.record_json, '$.resource.providerId'),
              json_extract(w.record_json, '$.resource.connectionId'))
          WHERE w.status = 'waiting' AND w.deadline_at > ? AND w.wait_id > ?
            AND COALESCE(MAX(c.until_ms, c.dispatch_until_ms), 0) <= ?
            AND w.wait_id NOT IN (SELECT value FROM json_each(?))
            AND json_array(json_extract(w.record_json, '$.resource.providerId'),
              json_extract(w.record_json, '$.resource.connectionId'))
              NOT IN (SELECT value FROM json_each(?))
            AND CASE
              WHEN json_type(w.record_json, '$.observation') IS NULL
                THEN json_extract(w.record_json, '$.createdAt')
              WHEN w.wait_id IN (SELECT value FROM json_each(?))
                THEN json_extract(w.record_json, '$.observation.nextObserveAt')
              ELSE json_extract(w.record_json, '$.observation.nextPollAt')
            END <= ?
          ORDER BY ${order} LIMIT ?`)
        .all(
          input.now,
          input.scan?.afterWaitId ?? '',
          input.now,
          JSON.stringify(input.excludedWaitIds ?? []),
          JSON.stringify((input.excludedSources ?? []).map(eventWaitSourceKey)),
          JSON.stringify(input.dirtyWaitIds ?? []),
          input.now,
          input.limit,
        )
        .map(readRow),
    );
  }
  readSourceCooldown(input: EventWaitSource): number | null {
    this.#assertOpen();
    validateEventWaitSource(input);
    return this.#database.transaction('read', () => {
      const row = this.#database.database
        .prepare(`SELECT MAX(until_ms, dispatch_until_ms) AS until_ms
          FROM workflow_event_wait_source_cooldowns WHERE source_key = ?`)
        .get(eventWaitSourceKey(input));
      if (!row) return null;
      if (
        typeof row.until_ms !== 'number' ||
        !Number.isSafeInteger(row.until_ms) ||
        row.until_ms < 0
      )
        throw new Error('Corrupt event wait source cooldown');
      return row.until_ms;
    });
  }
  extendSourceCooldown(input: ExtendEventWaitSourceCooldownInput): number {
    this.#assertOpen();
    validateEventWaitSourceCooldown(input);
    return this.#database.transaction('write', () => {
      const db = this.#database.database;
      // Bounded expiry cleanup; active limits have no Session foreign key.
      db.prepare(`DELETE FROM workflow_event_wait_source_cooldowns WHERE source_key IN (
        SELECT source_key FROM workflow_event_wait_source_cooldowns
        WHERE MAX(until_ms, dispatch_until_ms) <= ?
        ORDER BY MAX(until_ms, dispatch_until_ms), source_key LIMIT ?
      )`).run(input.observedAt, EVENT_WAIT_PAGE_LIMIT);
      const row = db
        .prepare(`INSERT INTO workflow_event_wait_source_cooldowns(source_key, until_ms)
        VALUES (?, ?) ON CONFLICT(source_key) DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms)
        RETURNING until_ms`)
        .get(eventWaitSourceKey(input), input.until)!;
      return Number(row.until_ms);
    });
  }
  reserveSourceDispatch(input: ReserveEventWaitSourceDispatchInput): boolean {
    this.#assertOpen();
    validateEventWaitSourceDispatch(input);
    return this.#database.transaction('write', () => {
      this.#database.database
        .prepare(`DELETE FROM workflow_event_wait_source_cooldowns
        WHERE source_key IN (SELECT source_key FROM workflow_event_wait_source_cooldowns
          WHERE MAX(until_ms, dispatch_until_ms) <= ?
          ORDER BY MAX(until_ms, dispatch_until_ms), source_key LIMIT ?)
      `)
        .run(input.observedAt, EVENT_WAIT_PAGE_LIMIT);
      const row = this.#database.database
        .prepare(`INSERT INTO workflow_event_wait_source_cooldowns
          (source_key, until_ms, dispatch_token, dispatch_until_ms) VALUES (?, 0, ?, ?)
          ON CONFLICT(source_key) DO UPDATE SET
            dispatch_token = excluded.dispatch_token,
            dispatch_until_ms = MAX(dispatch_until_ms, excluded.dispatch_until_ms)
          WHERE dispatch_token = excluded.dispatch_token OR MAX(until_ms, dispatch_until_ms) <= ?
          RETURNING source_key`)
        .get(eventWaitSourceKey(input), input.token, input.until, input.observedAt);
      return row !== undefined;
    });
  }
  completeSourceDispatch(input: CompleteEventWaitSourceDispatchInput): number {
    this.#assertOpen();
    validateEventWaitSourceDispatch(input, true);
    return this.#database.transaction('write', () => {
      const db = this.#database.database;
      const key = eventWaitSourceKey(input);
      db.prepare(`UPDATE workflow_event_wait_source_cooldowns
        SET until_ms = MAX(until_ms, ?), dispatch_token = NULL, dispatch_until_ms = 0
        WHERE source_key = ? AND dispatch_token = ?`).run(input.until, key, input.token);
      const row = db
        .prepare(`SELECT MAX(until_ms, dispatch_until_ms) AS until_ms
        FROM workflow_event_wait_source_cooldowns WHERE source_key = ?`)
        .get(key);
      return row ? Number(row.until_ms) : 0;
    });
  }
  commit(raw: CommitEventWaitInput): CommitEventWaitResult {
    this.#assertOpen();
    const input = normalizeEventWaitCommit(raw);
    return this.#database.transaction('write', () => {
      const db = this.#database.database;
      if (
        !db
          .prepare(`SELECT session_id FROM session_metadata WHERE session_id = ? AND is_archived = 0
        AND NOT EXISTS (SELECT 1 FROM session_metadata_tombstones WHERE session_id = ?)`)
          .get(input.sessionId, input.sessionId)
      )
        return { kind: 'session_unavailable' };
      const row = db
        .prepare('SELECT * FROM workflow_event_waits WHERE wait_id = ?')
        .get(input.waitId);
      const current = row === undefined ? null : readRow(row);
      if (current && current.record.sessionId !== input.sessionId)
        throw new TypeError('Event wait ownership mismatch');
      if ((current?.authorityRevision ?? null) !== input.expectedAuthorityRevision)
        return {
          kind: 'revision_conflict',
          actualAuthorityRevision: current?.authorityRevision ?? null,
        };
      if (current) {
        if (!isDeepStrictEqual(current.record.delivery, input.record.delivery))
          throw new Error('Delivery requires joint Goal admission');
        assertEventWaitTransition(current.record, input.record);
        if (isDeepStrictEqual(current.record, input.record))
          return { kind: 'committed', snapshot: current };
      } else if (input.record.status !== 'waiting')
        throw new TypeError('Event waits must be created waiting');
      if (
        !input.record.delivery &&
        (input.record.status === 'waiting' || input.record.status === 'resolved')
      ) {
        const other = db
          .prepare(
            "SELECT wait_id FROM workflow_event_waits WHERE session_id = ? AND status IN ('waiting', 'resolved') AND json_extract(record_json, '$.delivery') IS NULL AND wait_id <> ?",
          )
          .get(input.sessionId, input.waitId);
        if (other) return { kind: 'active_wait_conflict', waitId: String(other.wait_id) };
      }
      const authorityRevision = (current?.authorityRevision ?? -1) + 1;
      if (!Number.isSafeInteger(authorityRevision))
        throw new TypeError('Event wait revision exhausted');
      const r = input.record;
      db.prepare(`INSERT INTO workflow_event_waits(wait_id, session_id, authority_revision, status, delivery_key, deadline_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wait_id) DO UPDATE SET
        authority_revision = excluded.authority_revision, status = excluded.status, record_json = excluded.record_json`).run(
        r.waitId,
        r.sessionId,
        authorityRevision,
        r.status,
        r.deliveryKey,
        r.deadlineAt,
        JSON.stringify(r),
      );
      return { kind: 'committed', snapshot: { authorityRevision, record: r } };
    });
  }
  async registerGoalWait(input: RegisterGoalWaitInput): Promise<GoalWaitSnapshot> {
    this.#assertOpen();
    const r = input.record;
    const readSource = () => {
      const row = this.#database.database
        .prepare(
          'SELECT record_json FROM core_root_turn_admissions WHERE session_id = ? AND turn_id = ?',
        )
        .get(r.sessionId, r.sourceTurnId);
      return row
        ? normalizeRootTurnAdmission(
            JSON.parse(String(row.record_json)),
            r.sessionId,
            r.sourceTurnId,
          )
        : undefined;
    };
    const logicalSource = await readGoalWaitRootExecution(
      this.#runtime,
      input,
      this.#database.transaction('read', readSource),
    );
    const completedExecution = await readCompletedGoalWaitExecution(
      this.#runtime,
      this.#database.transaction(
        'read',
        () => readBridgeGoal(this.#database.database, r.sessionId)?.record.currentExecution,
      ),
      logicalSource,
    );
    this.#assertOpen();
    return this.#database.transaction('write', () => {
      const db = this.#database.database;
      assertBridgeSession(db, r.sessionId);
      const old = readBridgeWait(db, r.sessionId, r.waitId);
      if (
        !old &&
        db
          .prepare(
            "SELECT 1 FROM runtime_events WHERE session_id = ? AND run_id = ? AND (json_extract(payload_json, '$.actions.endInvocation') = 1 OR json_extract(payload_json, '$.status') IN ('completed', 'failed', 'cancelled', 'aborted')) LIMIT 1",
          )
          .get(r.sessionId, input.sourceExecution.runId)
      )
        throw new Error('Source already ended');
      return writeBridgeSnapshot(
        db,
        registerGoalWait(
          input,
          readBridgeGoal(db, r.sessionId),
          old,
          readSource(),
          logicalSource,
          completedExecution,
        ),
      );
    });
  }
  settleGoalWait(input: SettleGoalWaitInput): GoalWaitSnapshot {
    return this.#updateGoalWait(input, 'settle');
  }
  queueGoalWait(input: QueueGoalWaitInput): GoalWaitSnapshot {
    return this.#updateGoalWait(input, 'queue');
  }
  #updateGoalWait(
    input: SettleGoalWaitInput | QueueGoalWaitInput,
    operation: 'settle' | 'queue',
  ): GoalWaitSnapshot {
    this.#assertOpen();
    return this.#database.transaction('write', () => {
      const db = this.#database.database;
      assertBridgeSession(db, input.sessionId);
      const goal = readBridgeGoal(db, input.sessionId),
        wait = readBridgeWait(db, input.sessionId, input.waitId);
      if (!wait || !goal?.record.activeEventWait) throw new Error('Wait gate missing');
      const events = readBridgeTermination(
        db,
        input.sessionId,
        goal.record.activeEventWait.sourceExecution.runId,
      );
      return writeBridgeSnapshot(
        db,
        operation === 'settle'
          ? settleGoalWait(input as SettleGoalWaitInput, goal, wait, events)
          : queueGoalWait(input as QueueGoalWaitInput, goal, wait, events),
      );
    });
  }
  close(): void {
    this.#closed = true;
    try {
      this.#closeRuntime?.();
    } finally {
      this.#database.close();
    }
  }
}
export function createSqliteEventWaitAuthority(
  root: string,
  runtime?: GoalWaitRuntimeReader,
): EventWaitAuthorityRepository {
  return new SqliteEventWaitAuthority(root, runtime);
}
function readRow(value: unknown): EventWaitSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Corrupt event wait row');
  const row = value as Record<string, unknown>;
  if (
    typeof row.authority_revision !== 'number' ||
    !Number.isSafeInteger(row.authority_revision) ||
    row.authority_revision < 0 ||
    typeof row.record_json !== 'string'
  )
    throw new Error('Corrupt event wait revision or JSON');
  if (Buffer.byteLength(row.record_json, 'utf8') > EVENT_WAIT_LIMITS.recordBytes)
    throw new Error('Corrupt oversized event wait JSON');
  const record = decodeEventWaitRecord(JSON.parse(row.record_json));
  if (
    row.wait_id !== record.waitId ||
    row.session_id !== record.sessionId ||
    row.status !== record.status ||
    row.delivery_key !== record.deliveryKey ||
    row.deadline_at !== record.deadlineAt
  )
    throw new Error('Corrupt event wait indexed identity');
  return { authorityRevision: row.authority_revision, record };
}
