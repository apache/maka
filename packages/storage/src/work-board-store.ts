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

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  WORK_BOARD_DEFAULT_PAGE_SIZE,
  applyWorkBoardItemPatch,
  archiveWorkBoardItem,
  decodeWorkBoardItem,
  isSafeWorkBoardId,
  normalizeCreateWorkBoardItemInput,
  normalizeUpdateWorkBoardItemInput,
  normalizeWorkBoardListQuery,
  unarchiveWorkBoardItem,
  type WorkBoardItem,
  type WorkBoardPage,
} from '@maka/core/work-board';
import {
  buildWorkBoardListStatement,
  encodeWorkBoardCursor,
  workBoardFilterFingerprint,
} from './work-board-list-query.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import { chainWrite } from './write-queue.js';
import { WorkBoardStoreError, type WorkBoardStoreErrorCode } from './work-board-store-error.js';

export { WorkBoardStoreError } from './work-board-store-error.js';
export type { WorkBoardStoreErrorCode } from './work-board-store-error.js';

const WORK_BOARD_WRITE_KEY = 'work-board';

export interface WorkBoardMutationOptions {
  /** Optimistic concurrency guard. When provided, the mutation fails if the stored revision differs. */
  expectedRevision?: number;
}

export interface WorkBoardStore {
  list(query?: unknown): Promise<WorkBoardPage>;
  get(id: string): Promise<WorkBoardItem | undefined>;
  create(input: unknown, now?: number): Promise<WorkBoardItem>;
  update(
    id: string,
    patch: unknown,
    options?: WorkBoardMutationOptions,
    now?: number,
  ): Promise<WorkBoardItem>;
  archive(id: string, options?: WorkBoardMutationOptions, now?: number): Promise<WorkBoardItem>;
  unarchive(id: string, options?: WorkBoardMutationOptions, now?: number): Promise<WorkBoardItem>;
  remove(id: string, options?: WorkBoardMutationOptions): Promise<void>;
  close(): void;
}

export function createWorkBoardStore(workspaceRoot: string): WorkBoardStore {
  return new SqliteWorkBoardStore(workspaceRoot);
}

interface WorkBoardRow {
  item_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  scope_kind: string;
  project_id: string | null;
  archived: number;
  record_json: string;
}

class SqliteWorkBoardStore implements WorkBoardStore {
  readonly #lease: OperationalStateDatabaseLease;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  close(): void {
    this.#lease.close();
  }

  async list(query: unknown = {}): Promise<WorkBoardPage> {
    const normalized = normalizeWorkBoardListQuery(query);
    if (!normalized.ok) throw storeError('invalid_input', normalized.message);
    const value = normalized.value;
    const filterFingerprint = workBoardFilterFingerprint(value);
    const limit = value.limit ?? WORK_BOARD_DEFAULT_PAGE_SIZE;
    const statement = buildWorkBoardListStatement(value, limit);
    const rows = this.#lease.database
      .prepare(statement.sql)
      .all(...statement.params) as unknown as WorkBoardRow[];
    const items = rows.slice(0, limit).map((row) => this.#decodeRow(row));
    const last = items[items.length - 1];
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: encodeWorkBoardCursor(last, filterFingerprint) }
        : {}),
    };
  }

  async get(id: string): Promise<WorkBoardItem | undefined> {
    const row = this.#readRow(id);
    return row ? this.#decodeRow(row) : undefined;
  }

  async create(input: unknown, now = Date.now()): Promise<WorkBoardItem> {
    const normalized = normalizeCreateWorkBoardItemInput(input);
    if (!normalized.ok) throw storeError('invalid_input', normalized.message);
    const value = normalized.value;
    assertValidNow(now);
    const item: WorkBoardItem = {
      schemaVersion: 1,
      id: randomUUID(),
      revision: 1,
      scope: value.scope,
      title: value.title,
      ...(value.notes === undefined ? {} : { notes: value.notes }),
      state: 'todo',
      archived: false,
      creator: value.creator,
      provenance: value.provenance,
      createdAt: now,
      updatedAt: now,
    };
    await chainWrite(this.writeQueues, WORK_BOARD_WRITE_KEY, async () => {
      this.#writeItem(item);
    });
    return item;
  }

  async update(
    id: string,
    patch: unknown,
    options: WorkBoardMutationOptions = {},
    now = Date.now(),
  ): Promise<WorkBoardItem> {
    const normalizedPatch = normalizeUpdateWorkBoardItemInput(patch);
    if (!normalizedPatch.ok) throw storeError('invalid_input', normalizedPatch.message);
    const expectedRevision = normalizeExpectedRevision(options);
    assertValidNow(now);
    let result: WorkBoardItem | undefined;
    await chainWrite(this.writeQueues, WORK_BOARD_WRITE_KEY, async () => {
      // chainWrite only serializes writers inside this process. The write
      // transaction keeps the read/check/write sequence atomic against other
      // processes, so a stale revision can never be overwritten silently.
      this.#lease.transaction('write', () => {
        const current = this.#requireItem(id);
        assertExpectedRevision(expectedRevision, current);
        const effectiveNow = Math.max(now, current.updatedAt);
        const applied = applyWorkBoardItemPatch(current, normalizedPatch.value, effectiveNow);
        if (applied.changed) {
          this.#writeItem(applied.item);
          result = applied.item;
        } else {
          result = current;
        }
      });
    });
    return result!;
  }

  async archive(
    id: string,
    options: WorkBoardMutationOptions = {},
    now = Date.now(),
  ): Promise<WorkBoardItem> {
    const expectedRevision = normalizeExpectedRevision(options);
    assertValidNow(now);
    let result: WorkBoardItem | undefined;
    await chainWrite(this.writeQueues, WORK_BOARD_WRITE_KEY, async () => {
      // See update(): the revision check must share the write transaction so
      // concurrent processes cannot both pass the CAS check on revision 1.
      this.#lease.transaction('write', () => {
        const current = this.#requireItem(id);
        assertExpectedRevision(expectedRevision, current);
        const effectiveNow = Math.max(now, current.updatedAt);
        const applied = archiveWorkBoardItem(current, effectiveNow);
        if (applied.changed) {
          this.#writeItem(applied.item);
          result = applied.item;
        } else {
          result = current;
        }
      });
    });
    return result!;
  }

  async unarchive(
    id: string,
    options: WorkBoardMutationOptions = {},
    now = Date.now(),
  ): Promise<WorkBoardItem> {
    const expectedRevision = normalizeExpectedRevision(options);
    assertValidNow(now);
    let result: WorkBoardItem | undefined;
    await chainWrite(this.writeQueues, WORK_BOARD_WRITE_KEY, async () => {
      this.#lease.transaction('write', () => {
        const current = this.#requireItem(id);
        assertExpectedRevision(expectedRevision, current);
        const effectiveNow = Math.max(now, current.updatedAt);
        const applied = unarchiveWorkBoardItem(current, effectiveNow);
        if (applied.changed) {
          this.#writeItem(applied.item);
          result = applied.item;
        } else {
          result = current;
        }
      });
    });
    return result!;
  }

  async remove(id: string, options: WorkBoardMutationOptions = {}): Promise<void> {
    const expectedRevision = normalizeExpectedRevision(options);
    await chainWrite(this.writeQueues, WORK_BOARD_WRITE_KEY, async () => {
      this.#lease.transaction('write', () => {
        const current = this.#requireItem(id);
        assertExpectedRevision(expectedRevision, current);
        if (!current.archived) {
          throw storeError('must_archive_first', 'Only archived Work Board items can be deleted');
        }
        this.#lease.database
          .prepare('DELETE FROM workflow_work_board_items WHERE item_id = ?')
          .run(id);
      });
    });
  }

  #readRow(id: string): WorkBoardRow | undefined {
    if (!isSafeWorkBoardId(id)) {
      throw storeError('invalid_input', 'Work Board item id is invalid');
    }
    return this.#lease.database
      .prepare(
        `SELECT item_id, revision, created_at, updated_at, scope_kind, project_id, archived, record_json
         FROM workflow_work_board_items
         WHERE item_id = ?`,
      )
      .get(id) as WorkBoardRow | undefined;
  }

  #requireItem(id: string): WorkBoardItem {
    const row = this.#readRow(id);
    if (!row) throw storeError('not_found', `Work Board item ${id} was not found`);
    return this.#decodeRow(row);
  }

  #decodeRow(row: WorkBoardRow): WorkBoardItem {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.record_json);
    } catch {
      throw storeError('corrupt_record', `Work Board item ${row.item_id} has invalid record_json`);
    }
    const item = decodeWorkBoardItem(parsed);
    if (!item) {
      throw storeError(
        'corrupt_record',
        `Work Board item ${row.item_id} failed contract validation`,
      );
    }
    const expectedScopeKind = item.scope.kind;
    const expectedProjectId = item.scope.kind === 'project' ? item.scope.projectId : null;
    if (
      row.item_id !== item.id ||
      row.revision !== item.revision ||
      row.created_at !== item.createdAt ||
      row.updated_at !== item.updatedAt ||
      row.scope_kind !== expectedScopeKind ||
      row.project_id !== expectedProjectId ||
      row.archived !== (item.archived ? 1 : 0)
    ) {
      throw storeError(
        'corrupt_record',
        `Work Board item ${row.item_id} has indexed columns that disagree with record_json`,
      );
    }
    return item;
  }

  #writeItem(item: WorkBoardItem): void {
    this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare(`
          INSERT INTO workflow_work_board_items(
            item_id, revision, created_at, updated_at, scope_kind, project_id, archived, record_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET
            revision = excluded.revision,
            updated_at = excluded.updated_at,
            scope_kind = excluded.scope_kind,
            project_id = excluded.project_id,
            archived = excluded.archived,
            record_json = excluded.record_json
        `)
        .run(
          item.id,
          item.revision,
          item.createdAt,
          item.updatedAt,
          item.scope.kind,
          item.scope.kind === 'project' ? item.scope.projectId : null,
          item.archived ? 1 : 0,
          JSON.stringify(item),
        );
    });
  }
}

function normalizeExpectedRevision(options: WorkBoardMutationOptions): number | undefined {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw storeError('invalid_input', 'Work Board mutation options must be an object');
  }
  if (Object.keys(options).some((key) => key !== 'expectedRevision')) {
    throw storeError('invalid_input', 'Work Board mutation options contain unknown fields');
  }
  const expected = options.expectedRevision;
  if (expected === undefined) return undefined;
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw storeError('invalid_input', 'expectedRevision must be a positive integer');
  }
  return expected;
}

function assertValidNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw storeError('invalid_input', 'now must be a non-negative integer');
  }
}

function assertExpectedRevision(expected: number | undefined, item: WorkBoardItem): void {
  if (expected !== undefined && item.revision !== expected) {
    throw storeError(
      'operation_conflict',
      `Work Board item ${item.id} revision changed from ${expected} to ${item.revision}`,
    );
  }
}

function storeError(code: WorkBoardStoreErrorCode, message: string): WorkBoardStoreError {
  return new WorkBoardStoreError(code, message);
}
