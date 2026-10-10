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

import { isDeepStrictEqual } from 'node:util';
import {
  assertEventWaitTransition,
  decodeEventWaitRecord,
  EVENT_WAIT_LIMITS,
} from '@maka/core/event-wait';
import {
  eventWaitPage,
  normalizeEventWaitCommit,
  validateEventWaitPage,
  validateEventWaitRead,
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
  #closed = false;
  constructor(root: string) {
    this.#database = acquireOperationalStateDatabase(root);
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
            "SELECT * FROM workflow_event_waits WHERE status IN ('waiting', 'resolved') AND wait_id > ? ORDER BY wait_id LIMIT ?",
          )
          .all(input.afterWaitId ?? '', input.limit + 1)
          .map(readRow),
        input.limit,
      ),
    );
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
      if (input.record.status === 'waiting' || input.record.status === 'resolved') {
        const other = db
          .prepare(
            "SELECT wait_id FROM workflow_event_waits WHERE session_id = ? AND status IN ('waiting', 'resolved') AND wait_id <> ?",
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
  close(): void {
    this.#closed = true;
    this.#database.close();
  }
}
export function createSqliteEventWaitAuthority(root: string): EventWaitAuthorityRepository {
  return new SqliteEventWaitAuthority(root);
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
