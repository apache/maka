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
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_SCHEMA_VERSION = 1 as const;
const RECEIPT_MAX_BYTES = 64 * 1024;

export type MessageReceiptOperation = 'submit' | 'retract' | 'interrupt';

export interface MessageOperationReceipt {
  readonly payload: unknown;
  readonly result: unknown;
}

export interface MessageReceiptStore {
  beginHostEpoch(hostEpoch: string): Promise<void>;
  read(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): Promise<MessageOperationReceipt | undefined>;
  commit(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
    receipt: MessageOperationReceipt,
  ): Promise<MessageOperationReceipt>;
}

interface StoredMessageOperationReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly hostEpoch: string;
  readonly operation: MessageReceiptOperation;
  readonly sessionId: string;
  readonly operationId: string;
  readonly payload: unknown;
  readonly result: unknown;
}

export interface ClosableMessageReceiptStore extends MessageReceiptStore {
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteMessageReceiptStore(
  workspaceRoot: string,
): ClosableMessageReceiptStore {
  return new SqliteMessageReceiptStore(workspaceRoot);
}

class SqliteMessageReceiptStore implements ClosableMessageReceiptStore {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async beginHostEpoch(hostEpoch: string): Promise<void> {
    validateHostEpoch(hostEpoch);
    this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)')
        .run(hostEpoch);
      this.#lease.database
        .prepare('DELETE FROM core_message_host_epochs WHERE host_epoch <> ?')
        .run(hostEpoch);
    });
  }

  async read(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): Promise<MessageOperationReceipt | undefined> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    const row = this.#lease.database
      .prepare(`
        SELECT payload_json, result_json
        FROM core_message_receipts
        WHERE host_epoch = ? AND operation = ? AND session_id = ? AND operation_id = ?
      `)
      .get(hostEpoch, operation, sessionId, operationId) as
      | { payload_json?: unknown; result_json?: unknown }
      | undefined;
    if (!row) return undefined;
    if (typeof row.payload_json !== 'string' || typeof row.result_json !== 'string') {
      throw new Error('Invalid SQLite message operation receipt');
    }
    return Object.freeze({
      payload: JSON.parse(row.payload_json),
      result: JSON.parse(row.result_json),
    });
  }

  async commit(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
    receipt: MessageOperationReceipt,
  ): Promise<MessageOperationReceipt> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    const stored = normalizeReceipt(hostEpoch, operation, sessionId, operationId, receipt);
    return this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)')
        .run(hostEpoch);
      const inserted = this.#lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_message_receipts(
            host_epoch, operation, session_id, operation_id, payload_json, result_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          hostEpoch,
          operation,
          sessionId,
          operationId,
          JSON.stringify(stored.payload),
          JSON.stringify(stored.result),
        );
      if (inserted.changes === 0) {
        const existing = readSqliteReceipt(
          this.#lease.database,
          hostEpoch,
          operation,
          sessionId,
          operationId,
        );
        if (!existing || !isDeepStrictEqual(existing, stored)) {
          throw new Error('Message operation receipt identity conflict');
        }
        return existing;
      }
      return stored;
    });
  }

  close(): void {
    this.#lease.close();
  }
}

function readSqliteReceipt(
  db: DatabaseSync,
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
): MessageOperationReceipt | undefined {
  const row = db
    .prepare(`
      SELECT payload_json, result_json
      FROM core_message_receipts
      WHERE host_epoch = ? AND operation = ? AND session_id = ? AND operation_id = ?
    `)
    .get(hostEpoch, operation, sessionId, operationId) as
    | { payload_json?: unknown; result_json?: unknown }
    | undefined;
  if (!row) return undefined;
  if (typeof row.payload_json !== 'string' || typeof row.result_json !== 'string') {
    throw new Error('Invalid SQLite message operation receipt');
  }
  return Object.freeze({
    payload: JSON.parse(row.payload_json),
    result: JSON.parse(row.result_json),
  });
}

function normalizeReceipt(
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
  receipt: MessageOperationReceipt,
): MessageOperationReceipt {
  const encoded = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    hostEpoch,
    operation,
    sessionId,
    operationId,
    payload: receipt.payload,
    result: receipt.result,
  });
  if (Buffer.byteLength(`${encoded}\n`, 'utf8') > RECEIPT_MAX_BYTES) {
    throw new Error('Message operation receipt exceeds size limit');
  }
  const decoded = decodeStoredReceipt(JSON.parse(encoded), {
    hostEpoch,
    operation,
    sessionId,
    operationId,
  });
  return Object.freeze({ payload: decoded.payload, result: decoded.result });
}

function validateHostEpoch(hostEpoch: string): void {
  assertSafeId(hostEpoch, 'Invalid Host Epoch');
}

function validateIdentity(
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
): void {
  assertSafeId(hostEpoch, 'Invalid Host Epoch');
  if (operation !== 'submit' && operation !== 'retract' && operation !== 'interrupt') {
    throw new Error('Invalid message receipt operation');
  }
  assertSafeId(sessionId, 'Invalid Session identity');
  assertSafeId(operationId, 'Invalid message operation identity');
}

function decodeStoredReceipt(
  value: unknown,
  expected: {
    hostEpoch: string;
    operation: MessageReceiptOperation;
    sessionId: string;
    operationId: string;
  },
): StoredMessageOperationReceipt {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7
  ) {
    throw new Error('Invalid message operation receipt');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    record.hostEpoch !== expected.hostEpoch ||
    record.operation !== expected.operation ||
    record.sessionId !== expected.sessionId ||
    record.operationId !== expected.operationId ||
    !Object.hasOwn(record, 'payload') ||
    !Object.hasOwn(record, 'result')
  ) {
    throw new Error('Invalid message operation receipt');
  }
  return record as unknown as StoredMessageOperationReceipt;
}

function assertSafeId(value: string, message: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(message);
}
