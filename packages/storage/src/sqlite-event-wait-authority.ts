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

import { readBridgeGoal, assertBridgeSession } from './sqlite-event-wait-bridge.js';
import type { RuntimeContinuationAuthorityStore } from '@maka/core/runtime-event-store';
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
  type ListSessionEventWaitsInput,
  type ReadEventWaitInput,
} from './event-wait-authority.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

import {
  decodeAnyEventWaitRecord,
  decodeConsumerEventWaitRecord,
  assertAnyEventWaitTransition,
  type ConsumerEventWaitRecord,
} from '@maka/core/event-wait';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ToolOperationRecord } from './runtime-event-store-contract.js';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import {
  assertConsumerWaitRegistration,
  acknowledgeInvocationWait,
  retireInvocationWait,
  acknowledgeGoalWaitingAdmission,
  type EventWaitConsumerFacts,
} from './event-wait-consumer.js';
import {
  anyEventWaitPage,
  normalizeAnyEventWaitCommit,
  validateAnyEventWaitPage,
  type AnyEventWaitSnapshot,
  type AnyEventWaitPage,
  type ListAnyEventWaitsInput,
  type CommitAnyEventWaitInput,
  type CommitAnyEventWaitResult,
  type RegisterInvocationWaitInput,
  type AcknowledgeInvocationWaitResultInput,
  type RetireInvocationWaitInput,
  type AcknowledgeGoalWaitingAdmissionInput,
} from './event-wait-authority.js';

class SqliteEventWaitAuthority implements EventWaitAuthorityRepository {
  readonly #database: OperationalStateDatabaseLease;
  readonly #runtime: RuntimeContinuationAuthorityStore;
  readonly #closeRuntime?: () => void;
  #closed = false;
  constructor(root: string, runtime?: RuntimeContinuationAuthorityStore) {
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
        .prepare(
          "SELECT * FROM workflow_event_waits WHERE session_id = ? AND wait_id = ? AND json_extract(record_json, '$.schemaVersion') = 1",
        )
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
            "SELECT * FROM workflow_event_waits WHERE session_id = ? AND wait_id > ? AND json_extract(record_json, '$.schemaVersion') = 1 ORDER BY wait_id LIMIT ?",
          )
          .all(input.sessionId, input.afterWaitId ?? '', input.limit + 1)
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
            "SELECT * FROM workflow_event_waits WHERE status = ? AND json_extract(record_json, '$.schemaVersion') = 1 AND wait_id > ? ORDER BY wait_id LIMIT ?",
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
          WHERE json_extract(w.record_json, '$.schemaVersion') = 1 AND w.status = 'waiting' AND w.deadline_at > ? AND w.wait_id > ?
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
  listAnyForObservation(input: ListEventWaitsForObservationInput): readonly AnyEventWaitSnapshot[] {
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
          WHERE w.status = 'waiting' AND (w.deadline_at IS NULL OR w.deadline_at > ?) AND w.wait_id > ?
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
        .map(readAnyRow),
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
        assertEventWaitTransition(current.record, input.record);
        if (isDeepStrictEqual(current.record, input.record))
          return { kind: 'committed', snapshot: current };
      } else if (input.record.status !== 'waiting')
        throw new TypeError('Event waits must be created waiting');
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
  readAny(input: ReadEventWaitInput): AnyEventWaitSnapshot | null {
    this.#assertOpen();
    validateEventWaitRead(input);
    return this.#database.transaction('read', () => {
      const row = this.#database.database
        .prepare('SELECT * FROM workflow_event_waits WHERE session_id = ? AND wait_id = ?')
        .get(input.sessionId, input.waitId);
      return row ? readAnyRow(row) : null;
    });
  }
  listAny(input: ListAnyEventWaitsInput): AnyEventWaitPage {
    this.#assertOpen();
    validateAnyEventWaitPage(input);
    return this.#database.transaction('read', () =>
      anyEventWaitPage(
        this.#database.database
          .prepare(`SELECT * FROM workflow_event_waits
      WHERE wait_id > ? AND (? IS NULL OR session_id = ?) AND (? IS NULL OR status = ?)
      AND (? IS NULL OR COALESCE(json_extract(record_json, '$.consumer.kind'), 'observation') = ?)
      AND (? = 0 OR json_extract(record_json, '$.delivery') IS NULL) ORDER BY wait_id LIMIT ?`)
          .all(
            input.afterWaitId ?? '',
            input.sessionId ?? null,
            input.sessionId ?? null,
            input.status ?? null,
            input.status ?? null,
            input.consumerKind ?? null,
            input.consumerKind ?? null,
            input.deliveryOutstanding ? 1 : 0,
            input.limit + 1,
          )
          .map(readAnyRow),
        input.limit,
      ),
    );
  }
  commitAny(raw: CommitAnyEventWaitInput): CommitAnyEventWaitResult {
    this.#assertOpen();
    const input = normalizeAnyEventWaitCommit(raw);
    if (input.record.schemaVersion === 1) return this.commit({ ...input, record: input.record });
    return this.#database.transaction('write', () => {
      const db = this.#database.database;
      if (
        !db
          .prepare(
            'SELECT 1 FROM session_metadata WHERE session_id = ? AND is_archived = 0 AND NOT EXISTS (SELECT 1 FROM session_metadata_tombstones WHERE session_id = ?)',
          )
          .get(input.sessionId, input.sessionId)
      )
        return { kind: 'session_unavailable' };
      const row = db
        .prepare('SELECT * FROM workflow_event_waits WHERE wait_id = ?')
        .get(input.waitId);
      const old = row ? readAnyRow(row) : null;
      if (old && old.record.sessionId !== input.sessionId)
        throw new Error('Event wait ownership mismatch');
      if ((old?.authorityRevision ?? null) !== input.expectedAuthorityRevision)
        return {
          kind: 'revision_conflict',
          actualAuthorityRevision: old?.authorityRevision ?? null,
        };
      if (!old) throw new Error('Consumer waits require authenticated registration');
      if (!isDeepStrictEqual(old.record.delivery, input.record.delivery))
        throw new Error('Consumer delivery requires authenticated acknowledgement');
      assertAnyEventWaitTransition(old.record, input.record);
      if (isDeepStrictEqual(old.record, input.record)) return { kind: 'committed', snapshot: old };
      const snapshot = { authorityRevision: old.authorityRevision + 1, record: input.record };
      this.#writeAny(snapshot);
      return { kind: 'committed', snapshot };
    });
  }
  #writeAny(snapshot: AnyEventWaitSnapshot): void {
    if (!Number.isSafeInteger(snapshot.authorityRevision))
      throw new Error('Event wait revision exhausted');
    const r = snapshot.record;
    this.#database.database
      .prepare(`INSERT INTO workflow_event_waits(wait_id, session_id, authority_revision, status, delivery_key, deadline_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wait_id) DO UPDATE SET authority_revision = excluded.authority_revision, status = excluded.status, record_json = excluded.record_json`)
      .run(
        r.waitId,
        r.sessionId,
        snapshot.authorityRevision,
        r.status,
        r.deliveryKey,
        r.deadlineAt,
        JSON.stringify(r),
      );
  }
  #consumerAdmission(sessionId: string, turnId: string) {
    const row = this.#database.database
      .prepare(
        'SELECT record_json FROM core_root_turn_admissions WHERE session_id = ? AND turn_id = ?',
      )
      .get(sessionId, turnId);
    return row
      ? normalizeRootTurnAdmission(JSON.parse(String(row.record_json)), sessionId, turnId)
      : undefined;
  }
  #consumerFacts(
    record: ConsumerEventWaitRecord,
    admissionTurnId?: string,
  ): EventWaitConsumerFacts {
    if (admissionTurnId !== undefined)
      return {
        events: [],
        runTerminated: false,
        admission: this.#consumerAdmission(record.sessionId, admissionTurnId),
      };
    const db = this.#database.database;
    const c = record.consumer;
    const op =
      c.kind === 'tool_invocation'
        ? db.prepare('SELECT * FROM tool_operations WHERE operation_id = ?').get(c.operationId)
        : undefined;
    const operation: ToolOperationRecord | undefined = op
      ? {
          operationId: String(op.operation_id),
          invocationId: String(op.invocation_id),
          runId: String(op.run_id),
          turnId: String(op.turn_id),
          providerToolCallId: String(op.provider_tool_call_id),
          toolName: String(op.tool_name),
          canonicalArgsHash: String(op.canonical_args_hash),
          recoveryMode: op.recovery_mode as ToolOperationRecord['recoveryMode'],
          currentState: op.current_state as ToolOperationRecord['currentState'],
          callEventId: String(op.call_event_id),
          ...(op.dispatch_event_id ? { dispatchEventId: String(op.dispatch_event_id) } : {}),
          ...(op.result_event_id ? { resultEventId: String(op.result_event_id) } : {}),
          version: Number(op.version),
        }
      : undefined;
    const runId = c.kind === 'tool_invocation' ? c.runId : c.sourceRunId;
    const eventIds =
      c.kind === 'tool_invocation'
        ? [operation?.callEventId, operation?.dispatchEventId, operation?.resultEventId]
        : [c.completionEventId];
    return {
      events: db
        .prepare(
          'SELECT payload_json FROM runtime_events WHERE session_id = ? AND run_id = ? AND event_id IN (?, ?, ?)',
        )
        .all(record.sessionId, runId, eventIds[0] ?? null, eventIds[1] ?? null, eventIds[2] ?? null)
        .map((row) => JSON.parse(String(row.payload_json)) as RuntimeEvent),
      // The terminal payload can itself be large; only its existence is needed.
      runTerminated:
        c.kind === 'tool_invocation' &&
        db
          .prepare(`SELECT 1 FROM runtime_events
        WHERE session_id = ? AND run_id = ? AND (
          json_type(payload_json, '$.actions.endInvocation') = 'true'
          OR json_extract(payload_json, '$.status') IN ('completed', 'failed', 'cancelled', 'aborted'))
        LIMIT 1`)
          .get(record.sessionId, runId) !== undefined,
      ...(operation ? { operation } : {}),
      admission: this.#consumerAdmission(record.sessionId, record.sourceTurnId),
      goal: readBridgeGoal(db, record.sessionId),
    };
  }
  async registerInvocationWait(input: RegisterInvocationWaitInput): Promise<AnyEventWaitSnapshot> {
    this.#assertOpen();
    const record = decodeConsumerEventWaitRecord(input.record);
    if (record.consumer.kind !== 'tool_invocation') throw new Error('Expected invocation consumer');
    const prior = this.#database.transaction('read', () =>
      this.#consumerAdmission(record.sessionId, record.sourceTurnId),
    );
    if (!prior) throw new Error('Event wait has no Root admission');
    if (prior.runId !== record.consumer.runId) {
      const logical = await readLogicalRuntimeExecution(this.#runtime, {
        sessionId: prior.sessionId,
        turnId: prior.turnId,
        runId: prior.runId,
      });
      if (!logical || logical.pendingHandoff || logical.tip.runId !== record.consumer.runId)
        throw new Error('Event wait is not the current logical execution');
    }
    return this.#registerConsumer(record, prior);
  }
  registerGoalWaitingWait(input: RegisterInvocationWaitInput): AnyEventWaitSnapshot {
    this.#assertOpen();
    const record = decodeConsumerEventWaitRecord(input.record);
    if (record.consumer.kind !== 'goal_waiting') throw new Error('Expected Goal waiting consumer');
    return this.#registerConsumer(record);
  }
  #registerConsumer(
    record: ConsumerEventWaitRecord,
    prior?: import('./agent-run-store-contract.js').RootTurnAdmission,
  ): AnyEventWaitSnapshot {
    this.#assertOpen();
    return this.#database.transaction('write', () => {
      const db = this.#database.database;
      assertBridgeSession(db, record.sessionId);
      const row = db
        .prepare('SELECT * FROM workflow_event_waits WHERE wait_id = ?')
        .get(record.waitId);
      if (row) {
        const old = readAnyRow(row);
        const {
          observation: _observation,
          delivery: _delivery,
          updatedAt: _updated,
          ...a
        } = old.record;
        const { updatedAt: _newUpdated, ...b } = record;
        if (
          old.record.schemaVersion !== 2 ||
          old.record.status !== 'waiting' ||
          !isDeepStrictEqual(a, b)
        ) {
          // Re-registration can recover a terminal record, but immutable request identity must match.
          const fields = [
            'schemaVersion',
            'waitId',
            'sessionId',
            'sourceTurnId',
            'consumer',
            'resource',
            'condition',
            'deliveryKey',
            'createdAt',
            'deadlineAt',
          ] as const;
          if (
            old.record.schemaVersion !== 2 ||
            fields.some(
              (k) => !isDeepStrictEqual((old.record as ConsumerEventWaitRecord)[k], record[k]),
            )
          )
            throw new Error('Conflicting consumer wait registration');
        }
        return old;
      }
      const facts = this.#consumerFacts(record);
      if (prior && !isDeepStrictEqual(prior, facts.admission))
        throw new Error('Root admission changed');
      assertConsumerWaitRegistration(record, facts);
      const snapshot = { authorityRevision: 0, record };
      this.#writeAny(snapshot);
      return snapshot;
    });
  }
  acknowledgeInvocationWaitResult(
    input: AcknowledgeInvocationWaitResultInput,
  ): AnyEventWaitSnapshot | null {
    return this.#updateConsumer(input, (snapshot, facts) =>
      acknowledgeInvocationWait(snapshot, input, facts),
    );
  }
  retireInvocationWait(input: RetireInvocationWaitInput): AnyEventWaitSnapshot | null {
    return this.#updateConsumer(input, (snapshot, facts) =>
      retireInvocationWait(snapshot, input, facts),
    );
  }
  acknowledgeGoalWaitingAdmission(
    input: AcknowledgeGoalWaitingAdmissionInput,
  ): AnyEventWaitSnapshot | null {
    return this.#updateConsumer(
      input,
      (snapshot, facts) => acknowledgeGoalWaitingAdmission(snapshot, input, facts),
      input.turnId,
    );
  }
  #updateConsumer(
    input: ReadEventWaitInput,
    update: (snapshot: AnyEventWaitSnapshot, facts: EventWaitConsumerFacts) => AnyEventWaitSnapshot,
    admissionTurnId?: string,
  ): AnyEventWaitSnapshot | null {
    this.#assertOpen();
    validateEventWaitRead({ sessionId: input.sessionId, waitId: input.waitId });
    return this.#database.transaction('write', () => {
      const row = this.#database.database
        .prepare('SELECT * FROM workflow_event_waits WHERE session_id = ? AND wait_id = ?')
        .get(input.sessionId, input.waitId);
      if (!row) return null;
      const old = readAnyRow(row);
      if (old.record.schemaVersion !== 2) throw new Error('Expected consumer wait');
      const next = update(old, this.#consumerFacts(old.record, admissionTurnId));
      if (next !== old) this.#writeAny(next);
      return next;
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
  runtime?: RuntimeContinuationAuthorityStore,
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

function readAnyRow(value: unknown): AnyEventWaitSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Corrupt event wait row');
  const row = value as Record<string, unknown>;
  if (
    typeof row.authority_revision !== 'number' ||
    !Number.isSafeInteger(row.authority_revision) ||
    row.authority_revision < 0 ||
    typeof row.record_json !== 'string' ||
    Buffer.byteLength(row.record_json, 'utf8') > EVENT_WAIT_LIMITS.recordBytes
  )
    throw new Error('Corrupt event wait revision or JSON');
  const record = decodeAnyEventWaitRecord(JSON.parse(row.record_json));
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
