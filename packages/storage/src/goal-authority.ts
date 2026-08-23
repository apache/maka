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

import { decodeGoalAuthorityRecord, type GoalAuthorityRecord } from '@maka/core/goal';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

const writerBrand: unique symbol = Symbol('InteractiveGoalAuthorityWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveGoalAuthorityWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveGoalAuthorityWriter>>();

export interface GoalAuthoritySnapshot {
  readonly authorityRevision: number;
  readonly record: GoalAuthorityRecord;
}

export interface CommitGoalAuthorityInput {
  readonly sessionId: string;
  readonly expectedAuthorityRevision: number | null;
  readonly record: GoalAuthorityRecord | null;
}

export type CommitGoalAuthorityResult =
  | {
      readonly kind: 'committed';
      readonly snapshot: GoalAuthoritySnapshot | null;
    }
  | {
      readonly kind: 'revision_conflict';
      readonly actualAuthorityRevision: number | null;
    };

export interface InteractiveGoalAuthorityWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  list(): Promise<readonly GoalAuthoritySnapshot[]>;
  read(sessionId: string): Promise<GoalAuthoritySnapshot | null>;
  commit(input: CommitGoalAuthorityInput): Promise<CommitGoalAuthorityResult>;
  close(): Promise<void>;
}

export function authenticateInteractiveGoalAuthorityWriter(
  writer: InteractiveGoalAuthorityWriter,
): InteractiveGoalAuthorityWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive Goal authority writer',
    );
  }
  return writer;
}

export async function openInteractiveGoalAuthorityForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveGoalAuthorityWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let repository: SqliteGoalAuthority | undefined;
    try {
      repository = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) =>
        createSqliteGoalAuthority(root),
      );
      await assertStorageRootLease(lease, 'interactive', 'write');
      const raced = writerByLease.get(lease);
      if (raced) {
        repository.close();
        return raced;
      }
      const writer = createWriterFacade(lease, repository);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      repository?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  repository: SqliteGoalAuthority,
): InteractiveGoalAuthorityWriter {
  let closed = false;
  let closeTask: Promise<void> | undefined;
  const activeOperations = new Set<Promise<unknown>>();
  const run = <T>(operation: () => T): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Goal authority writer is closed'),
      );
    }
    const pending = runWithStorageRootLease(lease, 'interactive', 'write', async () => operation());
    activeOperations.add(pending);
    void pending.finally(() => activeOperations.delete(pending)).catch(() => undefined);
    return pending;
  };
  const writer: InteractiveGoalAuthorityWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    list: () => run(() => repository.list()),
    read: (sessionId) => run(() => repository.read(sessionId)),
    commit: (input) => {
      const normalized = normalizeCommitInput(input);
      return run(() => repository.commit(normalized));
    },
    close: () => {
      closeTask ??= (async () => {
        closed = true;
        if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
        writers.delete(writer);
        await Promise.allSettled([...activeOperations]);
        repository.close();
      })();
      return closeTask;
    },
  };
  return Object.freeze(writer);
}

class SqliteGoalAuthority {
  readonly #database: OperationalStateDatabaseLease;

  constructor(root: string) {
    this.#database = acquireOperationalStateDatabase(root);
  }

  list(): readonly GoalAuthoritySnapshot[] {
    return this.#database.transaction('read', () =>
      this.#database.database
        .prepare(
          `SELECT session_id, authority_revision, goal_id, goal_revision, status, record_json
           FROM workflow_goal_authority
           ORDER BY session_id`,
        )
        .all()
        .map(readRow),
    );
  }

  read(sessionId: string): GoalAuthoritySnapshot | null {
    requireId(sessionId, 'Session');
    return this.#database.transaction('read', () => {
      const row = this.#database.database
        .prepare(
          `SELECT session_id, authority_revision, goal_id, goal_revision, status, record_json
           FROM workflow_goal_authority
           WHERE session_id = ?`,
        )
        .get(sessionId);
      return row === undefined ? null : readRow(row);
    });
  }

  commit(input: CommitGoalAuthorityInput): CommitGoalAuthorityResult {
    return this.#database.transaction('write', () => {
      const current = readRevision(this.#database, input.sessionId);
      if (current !== input.expectedAuthorityRevision) {
        return { kind: 'revision_conflict', actualAuthorityRevision: current };
      }
      if (input.record === null) {
        this.#database.database
          .prepare('DELETE FROM workflow_goal_authority WHERE session_id = ?')
          .run(input.sessionId);
        return { kind: 'committed', snapshot: null };
      }
      const authorityRevision = (current ?? -1) + 1;
      const record = input.record;
      this.#database.database
        .prepare(
          `INSERT INTO workflow_goal_authority(
             session_id, authority_revision, goal_id, goal_revision, status, record_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             authority_revision = excluded.authority_revision,
             goal_id = excluded.goal_id,
             goal_revision = excluded.goal_revision,
             status = excluded.status,
             record_json = excluded.record_json`,
        )
        .run(
          input.sessionId,
          authorityRevision,
          record.goal.id,
          record.goal.revision,
          record.goal.status,
          JSON.stringify(record),
        );
      return {
        kind: 'committed',
        snapshot: cloneSnapshot({ authorityRevision, record }),
      };
    });
  }

  close(): void {
    this.#database.close();
  }
}

function createSqliteGoalAuthority(root: string): SqliteGoalAuthority {
  return new SqliteGoalAuthority(root);
}

function normalizeCommitInput(input: CommitGoalAuthorityInput): CommitGoalAuthorityInput {
  requireId(input.sessionId, 'Session');
  if (
    input.expectedAuthorityRevision !== null &&
    (!Number.isSafeInteger(input.expectedAuthorityRevision) || input.expectedAuthorityRevision < 0)
  ) {
    throw new TypeError('Goal authority expected revision is invalid');
  }
  const record = input.record === null ? null : decodeGoalAuthorityRecord(input.record);
  if (record && record.goal.sessionId !== input.sessionId) {
    throw new TypeError('Goal authority Session identity changed');
  }
  return { ...input, record };
}

function readRevision(database: OperationalStateDatabaseLease, sessionId: string): number | null {
  const row = database.database
    .prepare(
      'SELECT authority_revision AS authorityRevision FROM workflow_goal_authority WHERE session_id = ?',
    )
    .get(sessionId) as { authorityRevision?: unknown } | undefined;
  if (!row) return null;
  if (!Number.isSafeInteger(row.authorityRevision) || (row.authorityRevision as number) < 0) {
    throw new Error('Goal authority revision is corrupt');
  }
  return row.authorityRevision as number;
}

function readRow(value: unknown): GoalAuthoritySnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('Goal authority row is corrupt');
  const row = value as Record<string, unknown>;
  const authorityRevision = row.authority_revision;
  if (!Number.isSafeInteger(authorityRevision) || (authorityRevision as number) < 0) {
    throw new Error('Goal authority revision is corrupt');
  }
  if (typeof row.record_json !== 'string') throw new Error('Goal authority record is corrupt');
  const record = decodeGoalAuthorityRecord(JSON.parse(row.record_json));
  if (
    row.session_id !== record.goal.sessionId ||
    row.goal_id !== record.goal.id ||
    row.goal_revision !== record.goal.revision ||
    row.status !== record.goal.status
  ) {
    throw new Error('Goal authority indexed identity is corrupt');
  }
  return cloneSnapshot({
    authorityRevision: authorityRevision as number,
    record,
  });
}

function cloneSnapshot(snapshot: GoalAuthoritySnapshot): GoalAuthoritySnapshot {
  return Object.freeze({
    authorityRevision: snapshot.authorityRevision,
    record: decodeGoalAuthorityRecord(structuredClone(snapshot.record)),
  });
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError(`${label} identity is invalid`);
}
