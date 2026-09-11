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

import { join } from 'node:path';
import type {
  ApplyMemoryMutationsRequest,
  CommitMemoryExtractionRequest,
  MemoryItemStore,
  MemoryItemWrite,
  SearchMemoryItemsByKeyRequest,
} from '@maka/core/long-term-memory';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { SqliteMemoryItemStore } from './sqlite-long-term-memory-store.js';

export { SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION } from './sqlite-long-term-memory-schema.js';

export const LONG_TERM_MEMORY_DATABASE_NAME = 'memory.sqlite';

const writerBrand: unique symbol = Symbol('InteractiveLongTermMemoryWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveLongTermMemoryWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveLongTermMemoryWriter>>();

export interface InteractiveLongTermMemoryWriter extends MemoryItemStore {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  close(): void;
}

export function authenticateInteractiveLongTermMemoryWriter(
  writer: InteractiveLongTermMemoryWriter,
): InteractiveLongTermMemoryWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive long-term memory writer',
    );
  }
  return writer;
}

/**
 * Open the dedicated memory.sqlite through an authenticated Storage Root lease.
 * Production code must use this facade rather than opening the low-level Store.
 */
export function openInteractiveLongTermMemoryStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveLongTermMemoryWriter> {
  return openLongTermMemoryStoreForWrite(lease);
}

async function openLongTermMemoryStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveLongTermMemoryWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteMemoryItemStore | undefined;
    try {
      store = await runWithStorageRootLease(
        lease,
        'interactive',
        'write',
        async (root) => new SqliteMemoryItemStore(join(root, LONG_TERM_MEMORY_DATABASE_NAME)),
      );
      await assertStorageRootLease(lease, 'interactive', 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        store.close();
        return recoveredExisting;
      }
      const writer = createWriterFacade(lease, store);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      store?.close();
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
  store: SqliteMemoryItemStore,
): InteractiveLongTermMemoryWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Long-term memory writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractiveLongTermMemoryWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    applyMutations: (request) => {
      const snapshot = snapshotApplyRequest(request);
      return run(() => store.applyMutations(snapshot));
    },
    commitExtraction: (request) => {
      const snapshot = snapshotCommitExtractionRequest(request);
      return run(() => store.commitExtraction(snapshot));
    },
    initializeExtractionCursor: (sessionId, processedOrdinal) =>
      run(() => store.initializeExtractionCursor(sessionId, processedOrdinal)),
    readExtractionCursor: (sessionId) => run(() => store.readExtractionCursor(sessionId)),
    readPendingExtractionFailure: (sessionId) =>
      run(() => store.readPendingExtractionFailure(sessionId)),
    recordCompactionPolicyDenial: (denial) => {
      const snapshot = Object.freeze({ ...denial });
      return run(() => store.recordCompactionPolicyDenial(snapshot));
    },
    readCompactionPolicyDenials: (sessionId) =>
      run(() => store.readCompactionPolicyDenials(sessionId)),
    settleExtractionFailure: (request) => {
      const snapshot = Object.freeze({ ...request });
      return run(() => store.settleExtractionFailure(snapshot));
    },
    readExtractionReceipt: (operationId) => run(() => store.readExtractionReceipt(operationId)),
    readItem: (itemId) => run(() => store.readItem(itemId)),
    searchByKeys: (request) => {
      const snapshot = snapshotSearchRequest(request);
      return run(() => store.searchByKeys(snapshot));
    },
    readOperation: (operationId) => run(() => store.readOperation(operationId)),
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      store.close();
    },
  };
  return Object.freeze(writer);
}

function snapshotCommitExtractionRequest(
  request: CommitMemoryExtractionRequest,
): CommitMemoryExtractionRequest {
  return Object.freeze({
    operationId: request.operationId,
    sessionId: request.sessionId,
    expectedCursorOrdinal: request.expectedCursorOrdinal,
    nextCursorOrdinal: request.nextCursorOrdinal,
    coverageHash: request.coverageHash,
    items: Object.freeze(request.items.map(snapshotItemWrite)),
    requestedItemIndexes: Object.freeze([...request.requestedItemIndexes]),
    ...(request.noOpReason ? { noOpReason: request.noOpReason } : {}),
    ...(request.skipReason ? { skipReason: request.skipReason } : {}),
    trigger: request.trigger,
    ...(request.compactionCheckpointId
      ? { compactionCheckpointId: request.compactionCheckpointId }
      : {}),
  });
}

function snapshotApplyRequest(request: ApplyMemoryMutationsRequest): ApplyMemoryMutationsRequest {
  return Object.freeze({
    operationId: request.operationId,
    mutations: Object.freeze(
      request.mutations.map((mutation) => {
        if (mutation.type === 'create') {
          return Object.freeze({ type: mutation.type, item: snapshotItemWrite(mutation.item) });
        }
        if (mutation.type === 'update') {
          return Object.freeze({
            type: mutation.type,
            itemId: mutation.itemId,
            expectedVersion: mutation.expectedVersion,
            item: snapshotItemWrite(mutation.item),
          });
        }
        return Object.freeze({
          type: mutation.type,
          itemId: mutation.itemId,
          expectedVersion: mutation.expectedVersion,
        });
      }),
    ),
  });
}

function snapshotItemWrite(item: MemoryItemWrite): MemoryItemWrite {
  return Object.freeze({
    ...item,
    keys: Object.freeze(item.keys.map((key) => Object.freeze({ ...key }))),
    sources: Object.freeze(item.sources.map((source) => Object.freeze({ ...source }))),
  });
}

function snapshotSearchRequest(
  request: SearchMemoryItemsByKeyRequest,
): SearchMemoryItemsByKeyRequest {
  return Object.freeze({ ...request, terms: Object.freeze([...request.terms]) });
}
