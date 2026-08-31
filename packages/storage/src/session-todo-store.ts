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
import type { DatabaseSync } from 'node:sqlite';
import {
  isTaskLedgerEvent,
  projectTaskLedgerEvents,
  type TaskLedgerEvent,
} from '@maka/core/task-ledger';
import {
  normalizeSessionTodoItems,
  type SessionTodoItem,
  type SessionTodoSnapshot,
} from '@maka/core/session-todo';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import { assertSafeSessionId } from './session-store.js';
import { chainWrite } from './write-queue.js';

const SESSION_TODO_DOCUMENT_SCHEMA_VERSION = 1;

interface StoredSessionTodoDocument {
  schemaVersion: typeof SESSION_TODO_DOCUMENT_SCHEMA_VERSION;
  items: SessionTodoItem[];
}

export interface SessionTodoStore {
  /**
   * Return the initialized current document. On the first read only, bootstrap
   * pending/in-progress legacy Tasks, map blocked Tasks to pending, and persist
   * even an empty result.
   */
  readOrBootstrap(sessionId: string): Promise<SessionTodoSnapshot>;
  /** Replace the complete document without consulting legacy Task state. */
  replaceAll(sessionId: string, items: unknown): Promise<SessionTodoSnapshot>;
  purge(sessionId: string): Promise<void>;
}

export interface SqliteSessionTodoStore extends SessionTodoStore {
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteSessionTodoStore(workspaceRoot: string): SqliteSessionTodoStore {
  return new SqliteSessionTodoStoreImpl(workspaceRoot);
}

class SqliteSessionTodoStoreImpl implements SqliteSessionTodoStore {
  readonly #lease: OperationalStateDatabaseLease;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#lease.close();
  }

  async readOrBootstrap(sessionId: string): Promise<SessionTodoSnapshot> {
    assertSafeSessionId(sessionId);
    let snapshot: SessionTodoSnapshot | undefined;
    await chainWrite(this.writeQueues, sessionId, async () => {
      snapshot = this.#lease.transaction('write', () => {
        const existing = readStoredDocument(this.#lease.database, sessionId);
        if (existing) return snapshotFromDocument(existing);

        const bootstrapped = bootstrapLegacyTasks(this.#lease.database, sessionId);
        insertDocument(this.#lease.database, sessionId, bootstrapped);
        return snapshotFromDocument(bootstrapped);
      });
    });
    return snapshot!;
  }

  async replaceAll(sessionId: string, items: unknown): Promise<SessionTodoSnapshot> {
    assertSafeSessionId(sessionId);
    const normalized = normalizeSessionTodoItems(items);
    if (!normalized.ok) throw new Error(normalized.message);
    const document: StoredSessionTodoDocument = {
      schemaVersion: SESSION_TODO_DOCUMENT_SCHEMA_VERSION,
      items: normalized.value.items,
    };
    await chainWrite(this.writeQueues, sessionId, async () => {
      this.#lease.transaction('write', () =>
        upsertDocument(this.#lease.database, sessionId, document),
      );
    });
    return snapshotFromDocument(document);
  }

  async purge(sessionId: string): Promise<void> {
    assertSafeSessionId(sessionId);
    await chainWrite(this.writeQueues, sessionId, async () => {
      this.#lease.transaction('write', () => {
        this.#lease.database
          .prepare('DELETE FROM workflow_session_todo_documents WHERE session_id = ?')
          .run(sessionId);
      });
    });
  }
}

function readStoredDocument(
  database: DatabaseSync,
  sessionId: string,
): StoredSessionTodoDocument | undefined {
  const row = database
    .prepare('SELECT record_json FROM workflow_session_todo_documents WHERE session_id = ?')
    .get(sessionId) as { record_json?: unknown } | undefined;
  if (!row) return undefined;
  if (typeof row.record_json !== 'string') throw new Error('Invalid SessionTodo document record');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record_json);
  } catch {
    throw new Error('Invalid SessionTodo document JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid SessionTodo document shape');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'items' || keys[1] !== 'schemaVersion') {
    throw new Error('Invalid SessionTodo document fields');
  }
  if (record.schemaVersion !== SESSION_TODO_DOCUMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported SessionTodo document schema: ${String(record.schemaVersion)}`);
  }
  const normalized = normalizeSessionTodoItems(record.items);
  if (!normalized.ok) throw new Error(`Invalid SessionTodo document: ${normalized.message}`);
  return {
    schemaVersion: SESSION_TODO_DOCUMENT_SCHEMA_VERSION,
    items: normalized.value.items,
  };
}

function bootstrapLegacyTasks(
  database: DatabaseSync,
  sessionId: string,
): StoredSessionTodoDocument {
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_task_ledger_events
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(sessionId) as Array<{ record_json?: unknown }>;
  const events = rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid legacy Task event at sequence ${index}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.record_json);
    } catch {
      throw new Error(`Invalid legacy Task event JSON at sequence ${index}`);
    }
    if (!isTaskLedgerEvent(parsed) || parsed.sessionId !== sessionId) {
      throw new Error(`Invalid legacy Task event at sequence ${index}`);
    }
    return parsed;
  }) as TaskLedgerEvent[];
  const projected = projectTaskLedgerEvents(events);
  if (projected.diagnostics.length > 0) {
    throw new Error(`Legacy Task ledger is not projectable: ${projected.diagnostics.join('; ')}`);
  }
  const items = projected.tasks.flatMap((task) => {
    switch (task.status) {
      case 'pending':
      case 'in_progress':
        return [{ content: task.subject, status: task.status }];
      case 'blocked':
        // SessionTodo deliberately has no workflow-specific blocked state or
        // reason field. Keep the unfinished subject visible for replanning.
        return [{ content: task.subject, status: 'pending' as const }];
      case 'completed':
      case 'failed':
      case 'cancelled':
        return [];
    }
  });
  const normalized = normalizeSessionTodoItems(items);
  if (!normalized.ok) throw new Error(`Legacy Task bootstrap failed: ${normalized.message}`);
  return {
    schemaVersion: SESSION_TODO_DOCUMENT_SCHEMA_VERSION,
    items: normalized.value.items,
  };
}

function insertDocument(
  database: DatabaseSync,
  sessionId: string,
  document: StoredSessionTodoDocument,
): void {
  database
    .prepare(`
      INSERT INTO workflow_session_todo_documents(session_id, record_json)
      VALUES (?, ?)
    `)
    .run(sessionId, JSON.stringify(document));
}

function upsertDocument(
  database: DatabaseSync,
  sessionId: string,
  document: StoredSessionTodoDocument,
): void {
  database
    .prepare(`
      INSERT INTO workflow_session_todo_documents(session_id, record_json)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET record_json = excluded.record_json
    `)
    .run(sessionId, JSON.stringify(document));
}

function snapshotFromDocument(document: StoredSessionTodoDocument): SessionTodoSnapshot {
  return { items: document.items.map((item) => ({ ...item })) };
}
