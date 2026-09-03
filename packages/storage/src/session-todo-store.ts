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
   * Return the initialized current document, persisting an empty one on the
   * first read so later reads and copies see the same row.
   */
  readOrBootstrap(sessionId: string): Promise<SessionTodoSnapshot>;
  /** Replace the complete document. */
  replaceAll(sessionId: string, items: unknown): Promise<SessionTodoSnapshot>;
  /** Initialize one conversation-copy target without overwriting conflicting state. */
  initializeCopy(input: {
    sourceSessionId: string;
    targetSessionId: string;
    copyCurrent: boolean;
  }): Promise<SessionTodoSnapshot>;
  /** Purge current state. */
  purgeSessionState(sessionId: string): Promise<void>;
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
    await this.#write(async () => {
      snapshot = this.#lease.transaction('write', () => {
        const existing = readStoredDocument(this.#lease.database, sessionId);
        if (existing) return snapshotFromDocument(existing);

        const initial = emptyDocument();
        insertDocument(this.#lease.database, sessionId, initial);
        return snapshotFromDocument(initial);
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
    await this.#write(async () => {
      this.#lease.transaction('write', () =>
        upsertDocument(this.#lease.database, sessionId, document),
      );
    });
    return snapshotFromDocument(document);
  }

  async initializeCopy(input: {
    sourceSessionId: string;
    targetSessionId: string;
    copyCurrent: boolean;
  }): Promise<SessionTodoSnapshot> {
    assertSafeSessionId(input.sourceSessionId);
    assertSafeSessionId(input.targetSessionId);
    if (input.sourceSessionId === input.targetSessionId) {
      throw new Error('SessionTodo copy source and target must differ');
    }
    let snapshot: SessionTodoSnapshot | undefined;
    await this.#write(async () => {
      snapshot = this.#lease.transaction('write', () => {
        const source =
          (input.copyCurrent
            ? readStoredDocument(this.#lease.database, input.sourceSessionId)
            : undefined) ?? emptyDocument();
        const existing = readStoredDocument(this.#lease.database, input.targetSessionId);
        if (existing) {
          if (!sameDocument(existing, source)) {
            throw new Error('SessionTodo copy target already has different state');
          }
          return snapshotFromDocument(existing);
        }
        insertDocument(this.#lease.database, input.targetSessionId, source);
        return snapshotFromDocument(source);
      });
    });
    return snapshot!;
  }

  async purgeSessionState(sessionId: string): Promise<void> {
    assertSafeSessionId(sessionId);
    await this.#write(async () => {
      this.#lease.transaction('write', () => {
        this.#lease.database
          .prepare('DELETE FROM workflow_session_todo_documents WHERE session_id = ?')
          .run(sessionId);
      });
    });
  }

  #write(operation: () => Promise<void>): Promise<void> {
    // Todo documents are small and infrequently mutated. One queue makes
    // cross-Session initialization linearizable without lock ordering.
    return chainWrite(this.writeQueues, 'session-todo', operation);
  }
}

function emptyDocument(): StoredSessionTodoDocument {
  return { schemaVersion: SESSION_TODO_DOCUMENT_SCHEMA_VERSION, items: [] };
}

function sameDocument(left: StoredSessionTodoDocument, right: StoredSessionTodoDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
