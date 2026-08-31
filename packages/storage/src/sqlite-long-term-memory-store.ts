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

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  MemoryItemStoreConflictError,
  isMemoryItemKind,
  isMemoryItemOrigin,
  isMemoryKeyOrigin,
  isMemoryKeyType,
  isMemoryLifecycleState,
  isMemoryScopeType,
  isMemoryStatementType,
  isMemoryTemporalType,
  normalizeLongTermMemoryContent,
  validateMemoryTemporalBounds,
  type ApplyMemoryMutationsRequest,
  type CommitMemoryExtractionRequest,
  type MemoryExtractionCommitResult,
  type MemoryCompactionPolicyDenial,
  type MemoryExtractionCursor,
  type MemoryExtractionFailureClass,
  type MemoryExtractionReceipt,
  type MemoryItem,
  type MemoryItemKey,
  type MemoryItemKeyInput,
  type MemoryItemMutation,
  type MemoryItemRecord,
  type MemoryItemSource,
  type MemoryItemStore,
  type MemoryItemWrite,
  type MemoryMutationResult,
  type MemoryWriteOperationResult,
  type PendingMemoryExtractionFailure,
  type SearchMemoryItemsByKeyRequest,
  type SettleMemoryExtractionFailureRequest,
  type SettleMemoryExtractionFailureResult,
} from '@maka/core/long-term-memory';
import { isWorkspaceIdentity } from '@maka/core/workspace-identity';
import {
  assertSupportedSqliteLongTermMemorySchemaVersion,
  configureSqliteLongTermMemoryDatabase,
  migrateSqliteLongTermMemoryDatabase,
  readSqliteLongTermMemorySchemaVersion,
  type SqliteLongTermMemoryMigrationFailpoint,
} from './sqlite-long-term-memory-schema.js';

const MAX_MUTATIONS_PER_OPERATION = 32;
const MAX_KEYS_PER_ITEM = 32;
const MAX_SOURCES_PER_ITEM = 256;
const MAX_SEARCH_TERMS = 32;
const MAX_SEARCH_RESULTS = 100;
const MAX_IDENTIFIER_CODE_POINTS = 512;
const MAX_KEY_CODE_POINTS = 256;
const MAX_OPERATION_RESULT_JSON_CODE_UNITS = 128 * 1_024;

const require = createRequire(import.meta.url);

export type SqliteMemoryItemStoreFailpoint =
  | 'after_item_write'
  | 'after_keys_write'
  | 'after_sources_write'
  | 'after_cursor_write'
  | 'before_operation_write'
  | 'after_commit';

export interface SqliteMemoryItemStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly failpoint?: (point: SqliteMemoryItemStoreFailpoint) => void;
  readonly migrationFailpoint?: (point: SqliteLongTermMemoryMigrationFailpoint) => void;
}

interface NormalizedMemoryWrite {
  readonly content: string;
  readonly kind: MemoryItem['kind'];
  readonly statementType: MemoryItem['statementType'];
  readonly temporalType: MemoryItem['temporalType'];
  readonly scopeType: MemoryItem['scopeType'];
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly observedAt: number;
  readonly origin: MemoryItem['origin'];
  readonly contentHash: string;
  readonly keys: readonly MemoryItemKey[];
  readonly sources: readonly MemoryItemSource[];
}

type NormalizedMutation =
  | { readonly type: 'create'; readonly item: NormalizedMemoryWrite }
  | {
      readonly type: 'update';
      readonly itemId: string;
      readonly expectedVersion: number;
      readonly item: NormalizedMemoryWrite;
    }
  | { readonly type: 'archive'; readonly itemId: string; readonly expectedVersion: number }
  | { readonly type: 'restore'; readonly itemId: string; readonly expectedVersion: number };

interface MemoryItemRow {
  item_id: unknown;
  version: unknown;
  content: unknown;
  kind: unknown;
  statement_type: unknown;
  temporal_type: unknown;
  scope_type: unknown;
  scope_key: unknown;
  event_started_at: unknown;
  event_ended_at: unknown;
  observed_at: unknown;
  lifecycle_state: unknown;
  origin: unknown;
  content_hash: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface MemoryKeyRow {
  key_text: unknown;
  normalized_key: unknown;
  key_type: unknown;
  key_origin: unknown;
}

interface MemorySourceRow {
  session_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  event_id: unknown;
}

interface MemoryOperationRow {
  operation_id: unknown;
  operation_type: unknown;
  request_hash: unknown;
  result_json: unknown;
  committed_at: unknown;
}

interface MemoryExtractionCursorRow {
  session_id: unknown;
  processed_ordinal: unknown;
  updated_at: unknown;
}

interface MemoryExtractionFailureRow {
  session_id: unknown;
  from_ordinal: unknown;
  through_ordinal: unknown;
  coverage_hash: unknown;
  first_operation_id: unknown;
  first_trigger: unknown;
  compaction_checkpoint_id: unknown;
  first_failure_class: unknown;
  failed_at: unknown;
}

interface MemoryExtractionReceiptRow {
  operation_id: unknown;
  session_id: unknown;
  request_hash: unknown;
  result_json: unknown;
  committed_at: unknown;
}

interface SqliteMemoryKeySearchQuery {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

/** Low-level implementation; production callers must use the StorageRoot authority facade. */
export class SqliteMemoryItemStore implements MemoryItemStore {
  readonly #database: DatabaseSync;
  readonly #options: SqliteMemoryItemStoreOptions;
  #closed = false;

  constructor(path: string, options: SqliteMemoryItemStoreOptions = {}) {
    if (path.trim() === '') throw new Error('Long-term memory SQLite path cannot be empty');
    this.#options = options;
    if (path !== ':memory:') preparePrivateDatabaseFiles(path);
    const Database = loadDatabaseSync();
    this.#database = new Database(path);
    try {
      assertSupportedSqliteLongTermMemorySchemaVersion(this.#database);
      configureSqliteLongTermMemoryDatabase(this.#database);
      migrateSqliteLongTermMemoryDatabase(this.#database, {
        failpoint: options.migrationFailpoint,
      });
      if (path !== ':memory:') secureExistingDatabaseFiles(path);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  schemaVersion(): number {
    this.#assertOpen();
    return readSqliteLongTermMemorySchemaVersion(this.#database);
  }

  journalMode(): string {
    this.#assertOpen();
    const row = this.#database.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  foreignKeysEnabled(): boolean {
    this.#assertOpen();
    const row = this.#database.prepare('PRAGMA foreign_keys').get() as
      | { foreign_keys?: unknown }
      | undefined;
    return row?.foreign_keys === 1;
  }

  async applyMutations(request: ApplyMemoryMutationsRequest): Promise<MemoryWriteOperationResult> {
    this.#assertOpen();
    const committedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const mutations = normalizeMutations(request.mutations);
    const requestHash = hashCanonical(mutations);
    const operationType = mutations.length === 1 ? mutations[0]!.type : 'batch';

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#readOperationRow(operationId);
      if (existing) {
        if (requiredHash(existing.request_hash, 'request_hash') !== requestHash) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory operation ${operationId} was already used for a different request`,
          );
        }
        this.#database.exec('COMMIT');
        return { ...decodeOperation(existing), replayed: true };
      }

      validateObservedAtForCommit(mutations, committedAt);

      const results: MemoryMutationResult[] = [];
      for (let index = 0; index < mutations.length; index += 1) {
        const result = this.#applyMutation(mutations[index]!, index, committedAt);
        results.push(result);
      }

      this.#options.failpoint?.('before_operation_write');
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, operationType, requestHash, JSON.stringify(results), committedAt);
      this.#database.exec('COMMIT');
      this.#options.failpoint?.('after_commit');
      return { operationId, operationType, replayed: false, committedAt, results };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async commitExtraction(
    request: CommitMemoryExtractionRequest,
  ): Promise<MemoryExtractionCommitResult> {
    this.#assertOpen();
    const committedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const sessionId = normalizeIdentifier(request.sessionId, 'sessionId');
    const expectedCursorOrdinal = normalizeCursorOrdinal(
      request.expectedCursorOrdinal,
      'expectedCursorOrdinal',
      true,
    );
    const nextCursorOrdinal = normalizeCursorOrdinal(
      request.nextCursorOrdinal,
      'nextCursorOrdinal',
      false,
    );
    const coverageHash = requiredHash(request.coverageHash, 'coverageHash');
    if (nextCursorOrdinal <= expectedCursorOrdinal) {
      throw new Error('Memory extraction Cursor must advance');
    }
    const items = normalizeExtractionItems(request.items);
    const requestedItemIndexes = normalizeRequestedItemIndexes(
      request.requestedItemIndexes,
      items.length,
    );
    const noOpReason = normalizeExtractionNoOpReason(request.noOpReason);
    const skipReason = normalizeExtractionSkipReason(request.skipReason);
    const trigger = normalizeExtractionTrigger(request.trigger);
    const compactionCheckpointId = normalizeCompactionCheckpointId(
      trigger,
      request.compactionCheckpointId,
    );
    if (trigger !== 'remember' && requestedItemIndexes.length > 0) {
      throw new Error('Incidental extraction cannot expose requested Items');
    }
    if (
      noOpReason &&
      (trigger !== 'remember' || items.length > 0 || requestedItemIndexes.length > 0)
    ) {
      throw new Error('A rejected explicit Memory request must commit as an empty no-op');
    }
    if (
      skipReason &&
      (trigger !== 'compaction' || items.length > 0 || requestedItemIndexes.length > 0)
    ) {
      throw new Error('A policy-skipped Memory extraction must be an empty Compaction commit');
    }
    validateExtractionObservedAtForCommit(items, committedAt);
    const requestHash = hashCanonical({
      kind: 'memory_extraction',
      sessionId,
      expectedCursorOrdinal,
      nextCursorOrdinal,
      coverageHash,
      items,
      requestedItemIndexes,
      noOpReason: noOpReason ?? null,
      skipReason: skipReason ?? null,
      trigger,
      compactionCheckpointId: compactionCheckpointId ?? null,
    });

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existingReceipt = this.#readExtractionReceiptRow(operationId);
      if (existingReceipt) {
        if (requiredHash(existingReceipt.request_hash, 'request_hash') !== requestHash) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory operation ${operationId} was already used for a different request`,
          );
        }
        const existing = this.#readOperationRow(operationId);
        if (!existing) throw new Error(`Memory extraction ${operationId} is missing its operation`);
        const decoded = decodeOperation(existing);
        const receipt = decodeExtractionReceipt(existingReceipt);
        this.#database.exec('COMMIT');
        return {
          ...decoded,
          replayed: true,
          cursor: {
            sessionId,
            processedOrdinal: nextCursorOrdinal,
            updatedAt: decoded.committedAt,
          },
          receipt,
        };
      }

      const currentCursor = this.#readExtractionCursorRow(sessionId);
      const currentOrdinal = currentCursor
        ? requiredPositiveInteger(currentCursor.processed_ordinal, 'processed_ordinal')
        : 0;
      if (currentOrdinal !== expectedCursorOrdinal) {
        throw new MemoryItemStoreConflictError(
          'cursor_conflict',
          `Memory extraction Cursor for Session ${sessionId} is ${currentOrdinal}, expected ${expectedCursorOrdinal}`,
        );
      }

      const pendingFailure = this.#readPendingExtractionFailureRow(sessionId);
      if (pendingFailure) {
        const pending = decodePendingExtractionFailure(pendingFailure);
        const pendingMatchesCommit = skipReason
          ? pending.firstTrigger === 'compaction' &&
            pending.fromOrdinal === expectedCursorOrdinal + 1 &&
            pending.throughOrdinal <= nextCursorOrdinal
          : pending.firstOperationId !== operationId &&
            pending.fromOrdinal === expectedCursorOrdinal + 1 &&
            pending.throughOrdinal === nextCursorOrdinal &&
            pending.coverageHash === coverageHash &&
            pending.firstTrigger === trigger &&
            pending.compactionCheckpointId === compactionCheckpointId;
        if (!pendingMatchesCommit) {
          throw new MemoryItemStoreConflictError(
            'cursor_conflict',
            `Memory extraction pending range for Session ${sessionId} does not match the commit`,
          );
        }
      }

      const results = items.map((item, index) => this.#createItem(item, index, committedAt));
      const requestedItems = requestedItemIndexes.map((index) => {
        const result = results[index]!;
        return { itemId: result.itemId, content: items[index]!.content };
      });
      const receipt: MemoryExtractionReceipt = {
        operationId,
        sessionId,
        status: skipReason
          ? 'skipped'
          : trigger !== 'remember'
            ? 'extracted'
            : requestedItems.length > 0
              ? 'remembered'
              : 'not_applicable',
        requestedItems,
        ...(noOpReason ? { noOpReason } : {}),
        ...(skipReason ? { skipReason } : {}),
        committedAt,
      };

      if (currentCursor) {
        const updated = this.#database
          .prepare(
            `UPDATE memory_extraction_cursors
             SET processed_ordinal = ?, updated_at = ?
             WHERE session_id = ? AND processed_ordinal = ?`,
          )
          .run(nextCursorOrdinal, committedAt, sessionId, expectedCursorOrdinal);
        if (updated.changes !== 1) {
          throw new MemoryItemStoreConflictError(
            'cursor_conflict',
            `Memory extraction Cursor for Session ${sessionId} changed during commit`,
          );
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO memory_extraction_cursors(session_id, processed_ordinal, updated_at)
             VALUES (?, ?, ?)`,
          )
          .run(sessionId, nextCursorOrdinal, committedAt);
      }
      if (pendingFailure) {
        this.#database
          .prepare('DELETE FROM memory_extraction_failures WHERE session_id = ?')
          .run(sessionId);
      }
      this.#options.failpoint?.('after_cursor_write');

      this.#options.failpoint?.('before_operation_write');
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, 'batch', ?, ?, ?)`,
        )
        .run(operationId, requestHash, JSON.stringify(results), committedAt);
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_receipts(
             operation_id, session_id, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, sessionId, requestHash, JSON.stringify(receipt), committedAt);
      this.#database.exec('COMMIT');
      this.#options.failpoint?.('after_commit');
      return {
        operationId,
        operationType: 'batch',
        replayed: false,
        committedAt,
        results,
        cursor: { sessionId, processedOrdinal: nextCursorOrdinal, updatedAt: committedAt },
        receipt,
      };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async recordCompactionPolicyDenial(
    denial: MemoryCompactionPolicyDenial,
  ): Promise<MemoryCompactionPolicyDenial> {
    this.#assertOpen();
    const normalized = {
      sessionId: normalizeIdentifier(denial.sessionId, 'sessionId'),
      compactionCheckpointId: normalizeIdentifier(
        denial.compactionCheckpointId,
        'compactionCheckpointId',
      ),
      deniedAt: normalizeTimestamp(denial.deniedAt, 'deniedAt'),
    };
    this.#database
      .prepare(
        `INSERT INTO memory_compaction_policy_denials(
           session_id, compaction_checkpoint_id, denied_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(session_id, compaction_checkpoint_id) DO NOTHING`,
      )
      .run(normalized.sessionId, normalized.compactionCheckpointId, normalized.deniedAt);
    const row = this.#database
      .prepare(
        `SELECT session_id, compaction_checkpoint_id, denied_at
         FROM memory_compaction_policy_denials
         WHERE session_id = ? AND compaction_checkpoint_id = ?`,
      )
      .get(normalized.sessionId, normalized.compactionCheckpointId) as
      | { session_id: unknown; compaction_checkpoint_id: unknown; denied_at: unknown }
      | undefined;
    if (!row) throw new Error('Compaction policy denial was not persisted');
    return decodeCompactionPolicyDenial(row);
  }

  async readCompactionPolicyDenials(
    sessionId: string,
  ): Promise<readonly MemoryCompactionPolicyDenial[]> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, 'sessionId');
    return (
      this.#database
        .prepare(
          `SELECT session_id, compaction_checkpoint_id, denied_at
           FROM memory_compaction_policy_denials
           WHERE session_id = ?
           ORDER BY denied_at ASC, compaction_checkpoint_id ASC`,
        )
        .all(normalizedSessionId) as Array<{
        session_id: unknown;
        compaction_checkpoint_id: unknown;
        denied_at: unknown;
      }>
    ).map(decodeCompactionPolicyDenial);
  }

  async initializeExtractionCursor(
    sessionId: string,
    processedOrdinal: number,
  ): Promise<MemoryExtractionCursor> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, 'sessionId');
    const normalizedOrdinal = normalizeCursorOrdinal(processedOrdinal, 'processedOrdinal', false);
    const updatedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#readExtractionCursorRow(normalizedSessionId);
      if (existing) {
        const decoded = decodeExtractionCursor(existing);
        this.#database.exec('COMMIT');
        return decoded;
      }
      if (this.#readPendingExtractionFailureRow(normalizedSessionId)) {
        throw new MemoryItemStoreConflictError(
          'cursor_conflict',
          `Memory extraction for Session ${normalizedSessionId} has a pending failed range`,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_cursors(session_id, processed_ordinal, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(normalizedSessionId, normalizedOrdinal, updatedAt);
      this.#database.exec('COMMIT');
      return { sessionId: normalizedSessionId, processedOrdinal: normalizedOrdinal, updatedAt };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readExtractionCursor(sessionId: string): Promise<MemoryExtractionCursor | undefined> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, 'sessionId');
    return this.#readSnapshot(() => {
      const row = this.#readExtractionCursorRow(normalizedSessionId);
      return row ? decodeExtractionCursor(row) : undefined;
    });
  }

  async readPendingExtractionFailure(
    sessionId: string,
  ): Promise<PendingMemoryExtractionFailure | undefined> {
    this.#assertOpen();
    const normalizedSessionId = normalizeIdentifier(sessionId, 'sessionId');
    return this.#readSnapshot(() => {
      const row = this.#readPendingExtractionFailureRow(normalizedSessionId);
      return row ? decodePendingExtractionFailure(row) : undefined;
    });
  }

  async settleExtractionFailure(
    request: SettleMemoryExtractionFailureRequest,
  ): Promise<SettleMemoryExtractionFailureResult> {
    this.#assertOpen();
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const sessionId = normalizeIdentifier(request.sessionId, 'sessionId');
    const expectedCursorOrdinal = normalizeCursorOrdinal(
      request.expectedCursorOrdinal,
      'expectedCursorOrdinal',
      true,
    );
    const failedThroughOrdinal = normalizeCursorOrdinal(
      request.failedThroughOrdinal,
      'failedThroughOrdinal',
      false,
    );
    if (failedThroughOrdinal <= expectedCursorOrdinal) {
      throw new Error('Memory extraction failed range must advance beyond the Cursor');
    }
    const coverageHash = requiredHash(request.coverageHash, 'coverageHash');
    const failureClass = normalizeExtractionFailureClass(request.failureClass);
    const trigger = normalizeExtractionTrigger(request.trigger);
    const compactionCheckpointId = normalizeCompactionCheckpointId(
      trigger,
      request.compactionCheckpointId,
    );
    const recordedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existingReceipt = this.#readExtractionReceiptRow(operationId);
      if (existingReceipt) {
        const receipt = decodeExtractionReceipt(existingReceipt);
        if (receipt.status !== 'discarded') {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory operation ${operationId} already completed successfully`,
          );
        }
        const discarded = receipt.discardedRange!;
        const replayHash = hashCanonical({
          kind: 'memory_extraction_discard',
          sessionId,
          trigger,
          compactionCheckpointId: compactionCheckpointId ?? null,
          discardedRange: discarded,
        });
        if (
          receipt.sessionId !== sessionId ||
          requiredHash(existingReceipt.request_hash, 'request_hash') !== replayHash ||
          discarded.fromOrdinal !== expectedCursorOrdinal + 1 ||
          discarded.throughOrdinal !== failedThroughOrdinal ||
          discarded.coverageHash !== coverageHash ||
          discarded.finalFailureClass !== failureClass
        ) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory operation ${operationId} was already used for a different failed range`,
          );
        }
        const cursor = this.#readExtractionCursorRow(sessionId);
        if (!cursor) throw new Error(`Discarded Memory extraction ${operationId} lost its Cursor`);
        this.#database.exec('COMMIT');
        return {
          status: 'discarded',
          replayed: true,
          receipt,
          cursor: decodeExtractionCursor(cursor),
        };
      }

      const cursorRow = this.#readExtractionCursorRow(sessionId);
      const currentOrdinal = cursorRow
        ? requiredPositiveInteger(cursorRow.processed_ordinal, 'processed_ordinal')
        : 0;
      if (currentOrdinal !== expectedCursorOrdinal) {
        throw new MemoryItemStoreConflictError(
          'cursor_conflict',
          `Memory extraction Cursor for Session ${sessionId} is ${currentOrdinal}, expected ${expectedCursorOrdinal}`,
        );
      }

      const pendingRow = this.#readPendingExtractionFailureRow(sessionId);
      if (!pendingRow) {
        const pending: PendingMemoryExtractionFailure = {
          sessionId,
          fromOrdinal: expectedCursorOrdinal + 1,
          throughOrdinal: failedThroughOrdinal,
          coverageHash,
          firstOperationId: operationId,
          firstTrigger: trigger,
          ...(compactionCheckpointId ? { compactionCheckpointId } : {}),
          firstFailureClass: failureClass,
          failedAt: recordedAt,
        };
        this.#database
          .prepare(
            `INSERT INTO memory_extraction_failures(
               session_id, from_ordinal, through_ordinal, coverage_hash,
               first_operation_id, first_trigger, compaction_checkpoint_id,
               first_failure_class, failed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            pending.fromOrdinal,
            pending.throughOrdinal,
            pending.coverageHash,
            pending.firstOperationId,
            pending.firstTrigger,
            pending.compactionCheckpointId ?? null,
            pending.firstFailureClass,
            pending.failedAt,
          );
        this.#database.exec('COMMIT');
        return { status: 'retry_later', replayed: false, pending };
      }

      const pending = decodePendingExtractionFailure(pendingRow);
      if (pending.firstOperationId === operationId) {
        if (
          pending.fromOrdinal !== expectedCursorOrdinal + 1 ||
          pending.throughOrdinal !== failedThroughOrdinal ||
          pending.coverageHash !== coverageHash ||
          pending.firstTrigger !== trigger ||
          pending.compactionCheckpointId !== compactionCheckpointId ||
          pending.firstFailureClass !== failureClass
        ) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory operation ${operationId} was already used for a different failed range`,
          );
        }
        this.#database.exec('COMMIT');
        return { status: 'retry_later', replayed: true, pending };
      }
      if (
        pending.fromOrdinal !== expectedCursorOrdinal + 1 ||
        pending.throughOrdinal !== failedThroughOrdinal ||
        pending.coverageHash !== coverageHash ||
        pending.firstTrigger !== trigger ||
        pending.compactionCheckpointId !== compactionCheckpointId
      ) {
        throw new MemoryItemStoreConflictError(
          'cursor_conflict',
          `Memory extraction failed range for Session ${sessionId} changed before discard`,
        );
      }

      const discardedRange = {
        fromOrdinal: pending.fromOrdinal,
        throughOrdinal: pending.throughOrdinal,
        coverageHash: pending.coverageHash,
        firstFailureClass: pending.firstFailureClass,
        finalFailureClass: failureClass,
      } as const;
      const receipt: MemoryExtractionReceipt = {
        operationId,
        sessionId,
        status: 'discarded',
        requestedItems: [],
        discardedRange,
        committedAt: recordedAt,
      };
      const requestHash = hashCanonical({
        kind: 'memory_extraction_discard',
        sessionId,
        trigger,
        compactionCheckpointId: compactionCheckpointId ?? null,
        discardedRange,
      });

      if (cursorRow) {
        const updated = this.#database
          .prepare(
            `UPDATE memory_extraction_cursors
             SET processed_ordinal = ?, updated_at = ?
             WHERE session_id = ? AND processed_ordinal = ?`,
          )
          .run(failedThroughOrdinal, recordedAt, sessionId, expectedCursorOrdinal);
        if (updated.changes !== 1) {
          throw new MemoryItemStoreConflictError(
            'cursor_conflict',
            `Memory extraction Cursor for Session ${sessionId} changed during discard`,
          );
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO memory_extraction_cursors(session_id, processed_ordinal, updated_at)
             VALUES (?, ?, ?)`,
          )
          .run(sessionId, failedThroughOrdinal, recordedAt);
      }
      this.#options.failpoint?.('after_cursor_write');
      this.#database
        .prepare('DELETE FROM memory_extraction_failures WHERE session_id = ?')
        .run(sessionId);
      this.#options.failpoint?.('before_operation_write');
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, 'batch', ?, '[]', ?)`,
        )
        .run(operationId, requestHash, recordedAt);
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_receipts(
             operation_id, session_id, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, sessionId, requestHash, JSON.stringify(receipt), recordedAt);
      this.#database.exec('COMMIT');
      this.#options.failpoint?.('after_commit');
      return {
        status: 'discarded',
        replayed: false,
        receipt,
        cursor: { sessionId, processedOrdinal: failedThroughOrdinal, updatedAt: recordedAt },
      };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readExtractionReceipt(operationId: string): Promise<MemoryExtractionReceipt | undefined> {
    this.#assertOpen();
    const normalizedOperationId = normalizeIdentifier(operationId, 'operationId');
    return this.#readSnapshot(() => {
      const row = this.#readExtractionReceiptRow(normalizedOperationId);
      return row ? decodeExtractionReceipt(row) : undefined;
    });
  }

  async readItem(itemId: string): Promise<MemoryItemRecord | undefined> {
    this.#assertOpen();
    return this.#readSnapshot(() => this.#readItemRecord(normalizeIdentifier(itemId, 'itemId')));
  }

  async searchByKeys(request: SearchMemoryItemsByKeyRequest): Promise<readonly MemoryItemRecord[]> {
    this.#assertOpen();
    if (request.match !== 'exact' && request.match !== 'prefix') {
      throw new Error('Memory key match must be exact or prefix');
    }
    if (!Array.isArray(request.terms) || request.terms.length === 0) {
      throw new Error('Memory key search requires at least one term');
    }
    if (request.terms.length > MAX_SEARCH_TERMS) {
      throw new Error(`Memory key search accepts at most ${MAX_SEARCH_TERMS} terms`);
    }
    if (request.includeArchived !== undefined && typeof request.includeArchived !== 'boolean') {
      throw new Error('Memory key includeArchived must be a boolean');
    }
    const terms = [...new Set(request.terms.map(normalizeSearchTerm))].sort(compareText);
    const workspaceKey =
      request.workspaceKey === undefined
        ? undefined
        : normalizeIdentifier(request.workspaceKey, 'workspaceKey');
    if (workspaceKey !== undefined && !isWorkspaceIdentity(workspaceKey)) {
      throw new Error('Memory search workspaceKey must be a stable Workspace identity');
    }
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new Error(`Memory key search limit must be between 1 and ${MAX_SEARCH_RESULTS}`);
    }

    const query = buildSqliteMemoryKeySearchQuery({
      terms,
      match: request.match,
      workspaceKey,
      includeArchived: request.includeArchived ?? false,
      limit,
    });
    return this.#readSnapshot(() => {
      const rows = this.#database.prepare(query.sql).all(...query.parameters) as Array<{
        item_id?: unknown;
      }>;

      return rows.map((row) => {
        if (typeof row.item_id !== 'string') throw new Error('Invalid Memory Item search result');
        const record = this.#readItemRecord(row.item_id);
        if (!record) throw new Error(`Memory Item ${row.item_id} disappeared during read`);
        return record;
      });
    });
  }

  async readOperation(operationId: string): Promise<MemoryWriteOperationResult | undefined> {
    this.#assertOpen();
    const row = this.#readOperationRow(normalizeIdentifier(operationId, 'operationId'));
    return row ? decodeOperation(row) : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #applyMutation(
    mutation: NormalizedMutation,
    mutationIndex: number,
    committedAt: number,
  ): MemoryMutationResult {
    switch (mutation.type) {
      case 'create':
        return this.#createItem(mutation.item, mutationIndex, committedAt);
      case 'update':
        return this.#updateItem(mutation, mutationIndex, committedAt);
      case 'archive':
        return this.#changeLifecycle(mutation, mutationIndex, committedAt, 'archived');
      case 'restore':
        return this.#changeLifecycle(mutation, mutationIndex, committedAt, 'active');
    }
  }

  #createItem(
    write: NormalizedMemoryWrite,
    mutationIndex: number,
    committedAt: number,
  ): MemoryMutationResult {
    const itemId = normalizeIdentifier(
      (this.#options.idFactory ?? randomUUID)(),
      'generated itemId',
    );
    this.#database
      .prepare(
        `INSERT INTO memory_items(
           item_id, version, content, kind, statement_type, temporal_type,
           scope_type, scope_key, event_started_at, event_ended_at, observed_at,
           lifecycle_state, origin, content_hash, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        write.content,
        write.kind,
        write.statementType,
        write.temporalType,
        write.scopeType,
        write.scopeKey,
        write.eventStartedAt,
        write.eventEndedAt,
        write.observedAt,
        write.origin,
        write.contentHash,
        committedAt,
        committedAt,
      );
    this.#options.failpoint?.('after_item_write');
    this.#replaceKeys(itemId, write.keys);
    this.#options.failpoint?.('after_keys_write');
    this.#replaceSources(itemId, write.sources);
    this.#options.failpoint?.('after_sources_write');
    return mutationResult(mutationIndex, 'create', this.#requireItemRecord(itemId).item, 'created');
  }

  #updateItem(
    mutation: Extract<NormalizedMutation, { type: 'update' }>,
    mutationIndex: number,
    committedAt: number,
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    const currentRecord = this.#requireItemRecord(mutation.itemId);
    if (recordMatchesWrite(currentRecord, mutation.item)) {
      return mutationResult(mutationIndex, 'update', current, 'noop');
    }
    const updatedAt = Math.max(committedAt, current.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1,
             content = ?, kind = ?, statement_type = ?, temporal_type = ?,
             scope_type = ?, scope_key = ?, event_started_at = ?, event_ended_at = ?,
             observed_at = ?, origin = ?, content_hash = ?, updated_at = ?
         WHERE item_id = ? AND version = ?`,
      )
      .run(
        mutation.item.content,
        mutation.item.kind,
        mutation.item.statementType,
        mutation.item.temporalType,
        mutation.item.scopeType,
        mutation.item.scopeKey,
        mutation.item.eventStartedAt,
        mutation.item.eventEndedAt,
        mutation.item.observedAt,
        mutation.item.origin,
        mutation.item.contentHash,
        updatedAt,
        mutation.itemId,
        mutation.expectedVersion,
      );
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.('after_item_write');
    this.#replaceKeys(mutation.itemId, mutation.item.keys);
    this.#options.failpoint?.('after_keys_write');
    this.#replaceSources(mutation.itemId, mutation.item.sources);
    this.#options.failpoint?.('after_sources_write');
    return mutationResult(
      mutationIndex,
      'update',
      this.#requireItemRecord(mutation.itemId).item,
      'updated',
    );
  }

  #changeLifecycle(
    mutation: Extract<NormalizedMutation, { type: 'archive' | 'restore' }>,
    mutationIndex: number,
    committedAt: number,
    target: MemoryItem['lifecycleState'],
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    const expected = target === 'archived' ? 'active' : 'archived';
    if (current.lifecycleState !== expected) {
      throw new MemoryItemStoreConflictError(
        'invalid_lifecycle_transition',
        `Memory Item ${mutation.itemId} is ${current.lifecycleState}, expected ${expected}`,
        mutation.itemId,
      );
    }
    const updatedAt = Math.max(committedAt, current.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1, lifecycle_state = ?, updated_at = ?
         WHERE item_id = ? AND version = ? AND lifecycle_state = ?`,
      )
      .run(target, updatedAt, mutation.itemId, mutation.expectedVersion, expected);
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.('after_item_write');
    return mutationResult(
      mutationIndex,
      mutation.type,
      this.#requireItemRecord(mutation.itemId).item,
      target === 'active' ? 'restored' : 'archived',
    );
  }

  #requireVersion(itemId: string, expectedVersion: number): MemoryItem {
    const record = this.#readItemRecord(itemId);
    if (!record) {
      throw new MemoryItemStoreConflictError(
        'item_not_found',
        `Memory Item ${itemId} does not exist`,
        itemId,
      );
    }
    if (record.item.version !== expectedVersion) {
      throw new MemoryItemStoreConflictError(
        'version_conflict',
        `Memory Item ${itemId} is version ${record.item.version}, expected ${expectedVersion}`,
        itemId,
      );
    }
    return record.item;
  }

  #replaceKeys(itemId: string, keys: readonly MemoryItemKey[]): void {
    this.#database.prepare('DELETE FROM memory_item_keys WHERE item_id = ?').run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_keys(item_id, key_text, normalized_key, key_type, key_origin)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const key of keys) {
      insert.run(itemId, key.key, key.normalizedKey, key.keyType, key.keyOrigin);
    }
  }

  #replaceSources(itemId: string, sources: readonly MemoryItemSource[]): void {
    this.#database.prepare('DELETE FROM memory_item_sources WHERE item_id = ?').run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_sources(item_id, session_id, run_id, turn_id, event_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const source of sources) {
      insert.run(itemId, source.sessionId, source.runId, source.turnId, source.eventId);
    }
  }

  #readItemRecord(itemId: string): MemoryItemRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM memory_items WHERE item_id = ?')
      .get(itemId) as MemoryItemRow | undefined;
    if (!row) return undefined;
    const keys = this.#database
      .prepare(
        `SELECT key_text, normalized_key, key_type, key_origin
         FROM memory_item_keys WHERE item_id = ? ORDER BY normalized_key ASC
         LIMIT ${MAX_KEYS_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemoryKeyRow[];
    const sources = this.#database
      .prepare(
        `SELECT session_id, run_id, turn_id, event_id
         FROM memory_item_sources WHERE item_id = ? ORDER BY event_id ASC
         LIMIT ${MAX_SOURCES_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemorySourceRow[];
    assertChildCardinality('keys', keys.length, MAX_KEYS_PER_ITEM);
    assertChildCardinality('sources', sources.length, MAX_SOURCES_PER_ITEM);
    return {
      item: decodeItem(row),
      keys: keys.map(decodeKey),
      sources: sources.map(decodeSource),
    };
  }

  #requireItemRecord(itemId: string): MemoryItemRecord {
    const record = this.#readItemRecord(itemId);
    if (!record) throw new Error(`Memory Item ${itemId} disappeared during transaction`);
    return record;
  }

  #readOperationRow(operationId: string): MemoryOperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, operation_type, request_hash, result_json, committed_at
         FROM memory_write_operations WHERE operation_id = ?`,
      )
      .get(operationId) as MemoryOperationRow | undefined;
  }

  #readExtractionCursorRow(sessionId: string): MemoryExtractionCursorRow | undefined {
    return this.#database
      .prepare(
        `SELECT session_id, processed_ordinal, updated_at
         FROM memory_extraction_cursors WHERE session_id = ?`,
      )
      .get(sessionId) as MemoryExtractionCursorRow | undefined;
  }

  #readPendingExtractionFailureRow(sessionId: string): MemoryExtractionFailureRow | undefined {
    return this.#database
      .prepare(
        `SELECT session_id, from_ordinal, through_ordinal, coverage_hash,
                first_operation_id, first_trigger, compaction_checkpoint_id,
                first_failure_class, failed_at
         FROM memory_extraction_failures WHERE session_id = ?`,
      )
      .get(sessionId) as MemoryExtractionFailureRow | undefined;
  }

  #readExtractionReceiptRow(operationId: string): MemoryExtractionReceiptRow | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, session_id, request_hash, result_json, committed_at
         FROM memory_extraction_receipts WHERE operation_id = ?`,
      )
      .get(operationId) as MemoryExtractionReceiptRow | undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('SQLite Memory Item Store is closed');
  }

  #readSnapshot<T>(operation: () => T): T {
    this.#database.exec('BEGIN');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

export function buildSqliteMemoryKeySearchQuery(input: {
  readonly terms: readonly string[];
  readonly match: 'exact' | 'prefix';
  readonly workspaceKey?: string;
  readonly includeArchived: boolean;
  readonly limit: number;
}): SqliteMemoryKeySearchQuery {
  const parameters: Array<string | number> = [];
  let matchingKeysSql: string;
  if (input.match === 'exact') {
    matchingKeysSql = `
      SELECT item_id, normalized_key AS matched_term
      FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
      WHERE normalized_key IN (${placeholders(input.terms.length)})`;
    parameters.push(...input.terms);
  } else {
    matchingKeysSql = input.terms
      .map((term, index) => {
        const upperBound = prefixUpperBound(term);
        parameters.push(term);
        if (upperBound) {
          parameters.push(upperBound);
          return `
            SELECT item_id, ${index} AS matched_term
            FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
            WHERE normalized_key >= ? AND normalized_key < ?`;
        }
        return `
          SELECT item_id, ${index} AS matched_term
          FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
          WHERE normalized_key >= ?`;
      })
      .join('\nUNION ALL\n');
  }
  const scopeClause = input.workspaceKey
    ? `(i.scope_type = 'global' OR (i.scope_type = 'workspace' AND i.scope_key = ?))`
    : `i.scope_type = 'global'`;
  if (input.workspaceKey) parameters.push(input.workspaceKey);
  parameters.push(input.limit);
  return {
    sql: `
      WITH matching_keys AS MATERIALIZED (
        ${matchingKeysSql}
      )
      SELECT i.item_id
      FROM matching_keys m
      JOIN memory_items i ON i.item_id = m.item_id
      WHERE ${scopeClause}
        AND ${input.includeArchived ? '1 = 1' : `i.lifecycle_state = 'active'`}
      GROUP BY i.item_id
      ORDER BY COUNT(DISTINCT m.matched_term) DESC, i.updated_at DESC, i.item_id ASC
      LIMIT ?`,
    parameters,
  };
}

function normalizeMutations(
  mutations: readonly MemoryItemMutation[],
): readonly NormalizedMutation[] {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new Error('Memory operation requires at least one mutation');
  }
  if (mutations.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory operation accepts at most ${MAX_MUTATIONS_PER_OPERATION} mutations`);
  }
  return mutations.map((mutation): NormalizedMutation => {
    if (!mutation || typeof mutation !== 'object') throw new Error('Invalid Memory mutation');
    switch (mutation.type) {
      case 'create':
        return { type: 'create', item: normalizeWrite(mutation.item) };
      case 'update':
        return {
          type: 'update',
          itemId: normalizeIdentifier(mutation.itemId, 'itemId'),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
          item: normalizeWrite(mutation.item),
        };
      case 'archive':
      case 'restore':
        return {
          type: mutation.type,
          itemId: normalizeIdentifier(mutation.itemId, 'itemId'),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
        };
      default:
        throw new Error('Unknown Memory mutation type');
    }
  });
}

function normalizeExtractionItems(
  items: readonly MemoryItemWrite[],
): readonly NormalizedMemoryWrite[] {
  if (!Array.isArray(items)) throw new Error('Memory extraction items must be an array');
  if (items.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory extraction accepts at most ${MAX_MUTATIONS_PER_OPERATION} Items`);
  }
  return items.map(normalizeWrite);
}

function assertChildCardinality(child: 'keys' | 'sources', count: number, maximum: number): void {
  if (count < 1 || count > maximum) {
    throw new Error(
      `Invalid Memory Item ${child} cardinality: expected 1..${maximum}, got ${count}`,
    );
  }
}

function validateObservedAtForCommit(
  mutations: readonly NormalizedMutation[],
  committedAt: number,
): void {
  for (const mutation of mutations) {
    if (
      (mutation.type === 'create' || mutation.type === 'update') &&
      mutation.item.observedAt > committedAt
    ) {
      throw new Error('observedAt cannot be later than commit time');
    }
  }
}

function validateExtractionObservedAtForCommit(
  items: readonly NormalizedMemoryWrite[],
  committedAt: number,
): void {
  for (const item of items) {
    if (item.observedAt > committedAt) {
      throw new Error('observedAt cannot be later than commit time');
    }
  }
}

function normalizeWrite(input: MemoryItemWrite): NormalizedMemoryWrite {
  if (!input || typeof input !== 'object') throw new Error('Memory Item write must be an object');
  const content = normalizeLongTermMemoryContent(input.content);
  if (!content.ok) throw new Error(content.message);
  if (!isMemoryItemKind(input.kind)) throw new Error('Invalid Memory Item kind');
  if (!isMemoryStatementType(input.statementType)) throw new Error('Invalid Memory statement type');
  if (!isMemoryTemporalType(input.temporalType)) throw new Error('Invalid Memory temporal type');
  if (!isMemoryScopeType(input.scopeType)) throw new Error('Invalid Memory scope type');
  if (!isMemoryItemOrigin(input.origin)) throw new Error('Invalid Memory Item origin');

  const scopeKey = normalizeScopeKey(input.scopeType, input.scopeKey);
  const eventStartedAt = normalizeOptionalTimestamp(input.eventStartedAt, 'eventStartedAt');
  const eventEndedAt = normalizeOptionalTimestamp(input.eventEndedAt, 'eventEndedAt');
  validateMemoryTemporalBounds({
    temporalType: input.temporalType,
    eventStartedAt,
    eventEndedAt,
  });
  const observedAt = normalizeTimestamp(input.observedAt, 'observedAt');
  return {
    content: content.value,
    kind: input.kind,
    statementType: input.statementType,
    temporalType: input.temporalType,
    scopeType: input.scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    origin: input.origin,
    contentHash: hashText(content.value),
    keys: normalizeKeys(input.keys),
    sources: normalizeSources(input.sources),
  };
}

function normalizeScopeKey(
  scopeType: MemoryItem['scopeType'],
  input: string | null | undefined,
): string | null {
  if (scopeType === 'global') {
    if (input !== undefined && input !== null) {
      throw new Error('Global Memory Item cannot have a scopeKey');
    }
    return null;
  }
  const scopeKey = normalizeIdentifier(input, 'workspace scopeKey');
  if (!isWorkspaceIdentity(scopeKey)) {
    throw new Error('Workspace Memory scopeKey must be a stable Workspace identity');
  }
  return scopeKey;
}

function normalizeKeys(input: readonly MemoryItemKeyInput[]): readonly MemoryItemKey[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Memory Item requires at least one search key');
  }
  if (input.length > MAX_KEYS_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_KEYS_PER_ITEM} search keys`);
  }
  const winners = new Map<string, MemoryItemKey>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid Memory search key');
    if (!isMemoryKeyType(candidate.keyType)) throw new Error('Invalid Memory key type');
    if (!isMemoryKeyOrigin(candidate.keyOrigin)) throw new Error('Invalid Memory key origin');
    const key = normalizeVisibleText(candidate.key, 'Memory search key', MAX_KEY_CODE_POINTS);
    const normalized: MemoryItemKey = {
      key,
      normalizedKey: normalizeSearchTerm(key),
      keyType: candidate.keyType,
      keyOrigin: candidate.keyOrigin,
    };
    const existing = winners.get(normalized.normalizedKey);
    if (!existing || keyPriority(normalized) > keyPriority(existing)) {
      winners.set(normalized.normalizedKey, normalized);
    } else if (
      existing &&
      keyPriority(normalized) === keyPriority(existing) &&
      compareText(normalized.key, existing.key) < 0
    ) {
      winners.set(normalized.normalizedKey, normalized);
    }
  }
  return [...winners.values()].sort((left, right) =>
    compareText(left.normalizedKey, right.normalizedKey),
  );
}

function normalizeSources(input: readonly MemoryItemSource[]): readonly MemoryItemSource[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Memory Item requires at least one source Event');
  }
  if (input.length > MAX_SOURCES_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_SOURCES_PER_ITEM} sources`);
  }
  const sources = new Map<string, MemoryItemSource>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid Memory Item source');
    const source: MemoryItemSource = {
      sessionId: normalizeIdentifier(candidate.sessionId, 'source sessionId'),
      runId: normalizeIdentifier(candidate.runId, 'source runId'),
      turnId: normalizeIdentifier(candidate.turnId, 'source turnId'),
      eventId: normalizeIdentifier(candidate.eventId, 'source eventId'),
    };
    const existing = sources.get(source.eventId);
    if (existing && !sameSource(existing, source)) {
      throw new Error(`Source eventId ${source.eventId} has conflicting provenance`);
    }
    sources.set(source.eventId, source);
  }
  return [...sources.values()].sort((left, right) => compareText(left.eventId, right.eventId));
}

function sameSource(left: MemoryItemSource, right: MemoryItemSource): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.eventId === right.eventId
  );
}

function normalizeIdentifier(input: unknown, name: string): string {
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  if (input.normalize('NFC') !== input || input.trim() !== input) {
    throw new Error(`${name} must already be NFC-normalized without surrounding whitespace`);
  }
  return normalizeVisibleText(input, name, MAX_IDENTIFIER_CODE_POINTS);
}

function normalizeVisibleText(input: unknown, name: string, maxCodePoints: number): string {
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  const value = input.normalize('NFC').trim();
  if (value === '') throw new Error(`${name} cannot be empty`);
  if (/[\p{Cc}\p{Cs}\u200B\u200C\u200D\uFEFF]/u.test(value)) {
    throw new Error(`${name} cannot contain control or zero-width characters`);
  }
  if (Array.from(value).length > maxCodePoints) {
    throw new Error(`${name} must be ${maxCodePoints} code points or fewer`);
  }
  return value;
}

function normalizeSearchTerm(input: unknown): string {
  return normalizeVisibleText(input, 'Memory search term', MAX_KEY_CODE_POINTS)
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function normalizeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('expectedVersion must be a positive safe integer');
  }
  return value as number;
}

function normalizeCursorOrdinal(value: unknown, name: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
  }
  return value as number;
}

function normalizeExtractionFailureClass(value: unknown): MemoryExtractionFailureClass {
  if (
    value !== 'provider' &&
    value !== 'schema' &&
    value !== 'evidence' &&
    value !== 'localization' &&
    value !== 'requested_admission'
  ) {
    throw new Error('Invalid Memory extraction failure class');
  }
  return value;
}

function normalizeExtractionTrigger(value: unknown): 'remember' | 'extract' | 'compaction' {
  if (value !== 'remember' && value !== 'extract' && value !== 'compaction') {
    throw new Error('Invalid Memory extraction trigger');
  }
  return value;
}

function normalizeCompactionCheckpointId(
  trigger: 'remember' | 'extract' | 'compaction',
  value: unknown,
): string | undefined {
  if (trigger === 'compaction') {
    return normalizeIdentifier(value, 'compactionCheckpointId');
  }
  if (value !== undefined) {
    throw new Error('Only Compaction extraction may carry a checkpoint ID');
  }
  return undefined;
}

function normalizeExtractionNoOpReason(value: unknown): 'sensitive_information' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'sensitive_information') {
    throw new Error('Invalid Memory extraction no-op reason');
  }
  return value;
}

function normalizeExtractionSkipReason(value: unknown): 'policy_denied' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'policy_denied') {
    throw new Error('Invalid Memory extraction skip reason');
  }
  return value;
}

function normalizeRequestedItemIndexes(value: unknown, itemCount: number): number[] {
  if (!Array.isArray(value)) throw new Error('requestedItemIndexes must be an array');
  const indexes = [...new Set(value)];
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= itemCount) {
      throw new Error('requestedItemIndexes contains an out-of-range index');
    }
  }
  return (indexes as number[]).sort((left, right) => left - right);
}

function normalizeTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer UTC millisecond timestamp`);
  }
  return value as number;
}

function normalizeOptionalTimestamp(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, name);
}

function keyPriority(key: MemoryItemKey): number {
  const origin = { user: 3, deterministic: 2, llm: 1 } as const;
  const type = { code: 5, exact: 4, entity: 3, concept: 2, alias: 1 } as const;
  return origin[key.keyOrigin] * 10 + type[key.keyType];
}

function recordMatchesWrite(record: MemoryItemRecord, write: NormalizedMemoryWrite): boolean {
  return hashCanonical(writeFromRecord(record)) === hashCanonical(write);
}

function writeFromRecord(record: MemoryItemRecord): NormalizedMemoryWrite {
  return {
    content: record.item.content,
    kind: record.item.kind,
    statementType: record.item.statementType,
    temporalType: record.item.temporalType,
    scopeType: record.item.scopeType,
    scopeKey: record.item.scopeKey,
    eventStartedAt: record.item.eventStartedAt,
    eventEndedAt: record.item.eventEndedAt,
    observedAt: record.item.observedAt,
    origin: record.item.origin,
    contentHash: record.item.contentHash,
    keys: record.keys,
    sources: record.sources,
  };
}

function mutationResult(
  mutationIndex: number,
  mutationType: MemoryMutationResult['mutationType'],
  item: MemoryItem,
  outcome: MemoryMutationResult['outcome'],
): MemoryMutationResult {
  return {
    mutationIndex,
    mutationType,
    itemId: item.itemId,
    version: item.version,
    lifecycleState: item.lifecycleState,
    outcome,
  };
}

function decodeItem(row: MemoryItemRow): MemoryItem {
  const kind = requiredString(row.kind, 'kind');
  const statementType = requiredString(row.statement_type, 'statement_type');
  const temporalType = requiredString(row.temporal_type, 'temporal_type');
  const scopeType = requiredString(row.scope_type, 'scope_type');
  const lifecycleState = requiredString(row.lifecycle_state, 'lifecycle_state');
  const origin = requiredString(row.origin, 'origin');
  if (!isMemoryItemKind(kind)) throw invalidColumn('kind');
  if (!isMemoryStatementType(statementType)) throw invalidColumn('statement_type');
  if (!isMemoryTemporalType(temporalType)) throw invalidColumn('temporal_type');
  if (!isMemoryScopeType(scopeType)) throw invalidColumn('scope_type');
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn('lifecycle_state');
  if (!isMemoryItemOrigin(origin)) throw invalidColumn('origin');
  const itemId = requiredIdentifierString(row.item_id, 'item_id');
  const version = requiredPositiveInteger(row.version, 'version');
  const content = requiredNonEmptyString(row.content, 'content');
  const normalizedContent = normalizeLongTermMemoryContent(content);
  if (!normalizedContent.ok || normalizedContent.value !== content) throw invalidColumn('content');
  const scopeKey = nullableIdentifierString(row.scope_key, 'scope_key');
  const eventStartedAt = nullableNonNegativeInteger(row.event_started_at, 'event_started_at');
  const eventEndedAt = nullableNonNegativeInteger(row.event_ended_at, 'event_ended_at');
  const observedAt = requiredNonNegativeInteger(row.observed_at, 'observed_at');
  const contentHash = requiredHash(row.content_hash, 'content_hash');
  const createdAt = requiredNonNegativeInteger(row.created_at, 'created_at');
  const updatedAt = requiredNonNegativeInteger(row.updated_at, 'updated_at');
  if (
    (scopeType === 'global' && scopeKey !== null) ||
    (scopeType === 'workspace' && (scopeKey === null || scopeKey.length === 0))
  ) {
    throw invalidColumn('scope_key');
  }
  validateMemoryTemporalBounds({ temporalType, eventStartedAt, eventEndedAt });
  if (createdAt > updatedAt || observedAt > updatedAt) throw invalidColumn('timestamps');
  if (hashText(content) !== contentHash) throw invalidColumn('content_hash');
  return {
    itemId,
    version,
    content,
    kind,
    statementType,
    temporalType,
    scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    lifecycleState,
    origin,
    contentHash,
    createdAt,
    updatedAt,
  };
}

function decodeKey(row: MemoryKeyRow): MemoryItemKey {
  const keyType = requiredString(row.key_type, 'key_type');
  const keyOrigin = requiredString(row.key_origin, 'key_origin');
  if (!isMemoryKeyType(keyType)) throw invalidColumn('key_type');
  if (!isMemoryKeyOrigin(keyOrigin)) throw invalidColumn('key_origin');
  const key = requiredNonEmptyString(row.key_text, 'key_text');
  const normalizedKey = requiredNonEmptyString(row.normalized_key, 'normalized_key');
  if (normalizeSearchTerm(key) !== normalizedKey) throw invalidColumn('normalized_key');
  return {
    key,
    normalizedKey,
    keyType,
    keyOrigin,
  };
}

function decodeSource(row: MemorySourceRow): MemoryItemSource {
  return {
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    runId: requiredIdentifierString(row.run_id, 'run_id'),
    turnId: requiredIdentifierString(row.turn_id, 'turn_id'),
    eventId: requiredIdentifierString(row.event_id, 'event_id'),
  };
}

function decodeExtractionCursor(row: MemoryExtractionCursorRow): MemoryExtractionCursor {
  return {
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    processedOrdinal: requiredPositiveInteger(row.processed_ordinal, 'processed_ordinal'),
    updatedAt: requiredNonNegativeInteger(row.updated_at, 'updated_at'),
  };
}

function decodeCompactionPolicyDenial(row: {
  readonly session_id: unknown;
  readonly compaction_checkpoint_id: unknown;
  readonly denied_at: unknown;
}): MemoryCompactionPolicyDenial {
  return {
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    compactionCheckpointId: requiredIdentifierString(
      row.compaction_checkpoint_id,
      'compaction_checkpoint_id',
    ),
    deniedAt: requiredNonNegativeInteger(row.denied_at, 'denied_at'),
  };
}

function decodePendingExtractionFailure(
  row: MemoryExtractionFailureRow,
): PendingMemoryExtractionFailure {
  return {
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    fromOrdinal: requiredPositiveInteger(row.from_ordinal, 'from_ordinal'),
    throughOrdinal: requiredPositiveInteger(row.through_ordinal, 'through_ordinal'),
    coverageHash: requiredHash(row.coverage_hash, 'coverage_hash'),
    firstOperationId: requiredIdentifierString(row.first_operation_id, 'first_operation_id'),
    firstTrigger: normalizeExtractionTrigger(row.first_trigger),
    ...(row.compaction_checkpoint_id === null
      ? {}
      : {
          compactionCheckpointId: requiredIdentifierString(
            row.compaction_checkpoint_id,
            'compaction_checkpoint_id',
          ),
        }),
    firstFailureClass: normalizeExtractionFailureClass(row.first_failure_class),
    failedAt: requiredNonNegativeInteger(row.failed_at, 'failed_at'),
  };
}

function decodeExtractionReceipt(row: MemoryExtractionReceiptRow): MemoryExtractionReceipt {
  const operationId = requiredIdentifierString(row.operation_id, 'operation_id');
  const sessionId = requiredIdentifierString(row.session_id, 'session_id');
  requiredHash(row.request_hash, 'request_hash');
  const committedAt = requiredNonNegativeInteger(row.committed_at, 'committed_at');
  const encoded = requiredString(row.result_json, 'result_json');
  if (encoded.length > MAX_OPERATION_RESULT_JSON_CODE_UNITS) {
    throw new Error(`Memory extraction ${operationId} result JSON is too large`);
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`Invalid result JSON for Memory extraction ${operationId}`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid receipt for Memory extraction ${operationId}`);
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.operationId !== operationId ||
    receipt.sessionId !== sessionId ||
    !['remembered', 'not_applicable', 'extracted', 'discarded', 'skipped'].includes(
      String(receipt.status),
    ) ||
    receipt.committedAt !== committedAt ||
    !Array.isArray(receipt.requestedItems)
  ) {
    throw new Error(`Invalid receipt for Memory extraction ${operationId}`);
  }
  const requestedItems = receipt.requestedItems.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid requested Item in Memory extraction ${operationId}`);
    }
    const record = item as Record<string, unknown>;
    return {
      itemId: normalizeIdentifier(record.itemId, 'receipt itemId'),
      content: requiredString(record.content, 'receipt content'),
    };
  });
  if (requestedItems.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory extraction ${operationId} has too many requested Items`);
  }
  if (
    (receipt.status === 'remembered' && requestedItems.length === 0) ||
    (receipt.status !== 'remembered' && requestedItems.length > 0)
  ) {
    throw new Error(`Memory extraction ${operationId} has inconsistent requested Items`);
  }
  const noOpReason = normalizeExtractionNoOpReason(receipt.noOpReason);
  if (noOpReason && receipt.status !== 'not_applicable') {
    throw new Error(`Memory extraction ${operationId} has an invalid no-op reason`);
  }
  const skipReason = normalizeExtractionSkipReason(receipt.skipReason);
  if ((receipt.status === 'skipped') !== Boolean(skipReason)) {
    throw new Error(`Memory extraction ${operationId} has an invalid skip reason`);
  }
  let discardedRange: MemoryExtractionReceipt['discardedRange'];
  if (receipt.status === 'discarded') {
    const value = receipt.discardedRange;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Memory extraction ${operationId} is missing its discarded range`);
    }
    const range = value as Record<string, unknown>;
    discardedRange = {
      fromOrdinal: requiredPositiveInteger(range.fromOrdinal, 'discarded fromOrdinal'),
      throughOrdinal: requiredPositiveInteger(range.throughOrdinal, 'discarded throughOrdinal'),
      coverageHash: requiredHash(range.coverageHash, 'discarded coverageHash'),
      firstFailureClass: normalizeExtractionFailureClass(range.firstFailureClass),
      finalFailureClass: normalizeExtractionFailureClass(range.finalFailureClass),
    };
    if (discardedRange.throughOrdinal < discardedRange.fromOrdinal) {
      throw new Error(`Memory extraction ${operationId} has an invalid discarded range`);
    }
  } else if (receipt.discardedRange !== undefined) {
    throw new Error(`Memory extraction ${operationId} has an unexpected discarded range`);
  }
  return {
    operationId,
    sessionId,
    status: receipt.status as MemoryExtractionReceipt['status'],
    requestedItems,
    ...(noOpReason ? { noOpReason } : {}),
    ...(skipReason ? { skipReason } : {}),
    ...(discardedRange ? { discardedRange } : {}),
    committedAt,
  };
}

function decodeOperation(row: MemoryOperationRow): MemoryWriteOperationResult {
  const operationId = requiredIdentifierString(row.operation_id, 'operation_id');
  const operationType = requiredString(row.operation_type, 'operation_type');
  if (!['create', 'update', 'archive', 'restore', 'batch'].includes(operationType)) {
    throw invalidColumn('operation_type');
  }
  requiredHash(row.request_hash, 'request_hash');
  const resultJson = requiredString(row.result_json, 'result_json');
  if (resultJson.length > MAX_OPERATION_RESULT_JSON_CODE_UNITS) {
    throw new Error(`Memory operation ${operationId} result JSON is too large`);
  }
  let results: unknown;
  try {
    results = JSON.parse(resultJson);
  } catch (error) {
    throw new Error(`Invalid result JSON for Memory operation ${operationId}`, { cause: error });
  }
  if (!Array.isArray(results))
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  if (results.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(
      `Memory operation results accept at most ${MAX_MUTATIONS_PER_OPERATION} mutations`,
    );
  }
  const decodedResults = results.map((result, index) => decodeMutationResult(result, index));
  if (
    operationType !== 'batch' &&
    (decodedResults.length !== 1 || decodedResults[0]?.mutationType !== operationType)
  ) {
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  }
  for (const result of decodedResults) validateMutationResultOutcome(result);
  return {
    operationId,
    operationType: operationType as MemoryWriteOperationResult['operationType'],
    replayed: false,
    committedAt: requiredNonNegativeInteger(row.committed_at, 'committed_at'),
    results: decodedResults,
  };
}

function decodeMutationResult(value: unknown, expectedIndex: number): MemoryMutationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Memory mutation result');
  }
  const result = value as Record<string, unknown>;
  const mutationIndex = requiredNonNegativeInteger(result.mutationIndex, 'mutationIndex');
  const mutationType = requiredString(result.mutationType, 'mutationType');
  const lifecycleState = requiredString(result.lifecycleState, 'lifecycleState');
  const outcome = requiredString(result.outcome, 'outcome');
  if (mutationIndex !== expectedIndex) throw invalidColumn('mutationIndex');
  if (!['create', 'update', 'archive', 'restore'].includes(mutationType)) {
    throw invalidColumn('mutationType');
  }
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn('lifecycleState');
  if (!['created', 'updated', 'archived', 'restored', 'noop'].includes(outcome)) {
    throw invalidColumn('outcome');
  }
  return {
    mutationIndex,
    mutationType: mutationType as MemoryMutationResult['mutationType'],
    itemId: requiredIdentifierString(result.itemId, 'itemId'),
    version: requiredPositiveInteger(result.version, 'version'),
    lifecycleState,
    outcome: outcome as MemoryMutationResult['outcome'],
  };
}

function validateMutationResultOutcome(result: MemoryMutationResult): void {
  const valid =
    (result.mutationType === 'create' &&
      result.outcome === 'created' &&
      result.lifecycleState === 'active') ||
    (result.mutationType === 'update' &&
      (result.outcome === 'updated' || result.outcome === 'noop')) ||
    (result.mutationType === 'archive' &&
      result.outcome === 'archived' &&
      result.lifecycleState === 'archived') ||
    (result.mutationType === 'restore' &&
      result.outcome === 'restored' &&
      result.lifecycleState === 'active');
  if (!valid) throw new Error('Invalid Memory mutation result outcome');
}

function requiredString(value: unknown, column: string): string {
  if (typeof value !== 'string') throw invalidColumn(column);
  return value;
}

function requiredNonEmptyString(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (result.length === 0) throw invalidColumn(column);
  return result;
}

function requiredIdentifierString(value: unknown, column: string): string {
  const result = requiredNonEmptyString(value, column);
  try {
    return normalizeIdentifier(result, column);
  } catch {
    throw invalidColumn(column);
  }
}

function nullableIdentifierString(value: unknown, column: string): string | null {
  return value === null ? null : requiredIdentifierString(value, column);
}

function requiredInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidColumn(column);
  return value;
}

function requiredNonNegativeInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 0) throw invalidColumn(column);
  return result;
}

function requiredPositiveInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 1) throw invalidColumn(column);
  return result;
}

function nullableNonNegativeInteger(value: unknown, column: string): number | null {
  return value === null ? null : requiredNonNegativeInteger(value, column);
}

function requiredHash(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw invalidColumn(column);
  return result;
}

function invalidColumn(column: string): Error {
  return new Error(`Invalid long-term memory SQLite column ${column}`);
}

function assertChanged(changes: number | bigint, itemId: string): void {
  if (Number(changes) !== 1) {
    throw new MemoryItemStoreConflictError(
      'version_conflict',
      `Memory Item ${itemId} changed concurrently`,
      itemId,
    );
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashCanonical(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Smallest Unicode string strictly greater than every string with this prefix. */
function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix, (character) => character.codePointAt(0)!);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point < 0x10ffff) {
      const successor = point === 0xd7ff ? 0xe000 : point + 1;
      return String.fromCodePoint(...points.slice(0, index), successor);
    }
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function preparePrivateDatabaseFiles(path: string): void {
  secureFile(path, true, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureExistingDatabaseFiles(path: string): void {
  secureFile(path, false, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureFile(path: string, create: boolean, allowUnlinked: boolean): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Long-term memory SQLite path must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
  }
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR | noFollow | (create ? fsConstants.O_CREAT : 0),
      0o600,
    );
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw new Error(`Long-term memory SQLite path is not a regular file: ${path}`);
    }
    if (status.nlink === 0 && allowUnlinked) return;
    if (status.nlink !== 1) {
      throw new Error(`Long-term memory SQLite path must not be hard-linked: ${path}`);
    }
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (!create && isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function databaseSidecars(path: string): readonly string[] {
  return [`${path}-wal`, `${path}-shm`, `${path}-journal`];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the write failure that triggered rollback.
  }
}
