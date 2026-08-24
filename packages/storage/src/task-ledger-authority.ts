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

import type { TaskLedgerStore } from '@maka/core/task-ledger';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import {
  createSqliteTaskLedgerStore,
  type ConversationTaskLedgerCopyInput,
  type SqliteTaskLedgerStore,
} from './task-ledger-store.js';
import {
  getTaskLedgerCanonicalReader,
  type TaskLedgerCanonicalReader,
} from './task-ledger-store-internal.js';

export type { TaskLedgerCanonicalReader } from './task-ledger-store-internal.js';
export type { ConversationTaskLedgerCopyInput } from './task-ledger-store.js';

const writerBrand: unique symbol = Symbol('InteractiveTaskLedgerWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveTaskLedgerWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveTaskLedgerWriter>>();

export interface InteractiveTaskLedgerWriter extends TaskLedgerStore, TaskLedgerCanonicalReader {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  close(): void;
  copyConversationTaskLedger(input: ConversationTaskLedgerCopyInput): Promise<void>;
  purgeConversationTaskLedger(sessionId: string): Promise<void>;
}

export function authenticateInteractiveTaskLedgerWriter(
  writer: InteractiveTaskLedgerWriter,
): InteractiveTaskLedgerWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive task ledger writer',
    );
  }
  return writer;
}

export async function openInteractiveTaskLedgerStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveTaskLedgerWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteTaskLedgerStore | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = createSqliteTaskLedgerStore(root);
        try {
          await opened.ready();
          return opened;
        } catch (error) {
          opened.close();
          throw error;
        }
      });
      await assertStorageRootLease(lease, 'interactive', 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        store.close();
        return recoveredExisting;
      }
      const writer = createInteractiveWriterFacade(
        lease,
        store,
        getTaskLedgerCanonicalReader(store),
      );
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

function createInteractiveWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: SqliteTaskLedgerStore,
  canonicalReader: TaskLedgerCanonicalReader,
): InteractiveTaskLedgerWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>) => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Task ledger writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', async () => operation());
  };
  const writer: InteractiveTaskLedgerWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    list: (sessionId, options) => run(() => canonicalReader.list(sessionId, options)),
    get: (sessionId, id, options) => run(() => canonicalReader.get(sessionId, id, options)),
    create: (sessionId, drafts, context) => run(() => store.create(sessionId, drafts, context)),
    update: (sessionId, id, patch, context) =>
      run(() => store.update(sessionId, id, patch, context)),
    claim: (sessionId, id, owner, context) => run(() => store.claim(sessionId, id, owner, context)),
    claimAvailable: (sessionId, id, owner, scope, context) =>
      run(() => store.claimAvailable(sessionId, id, owner, scope, context)),
    settleAgentOutcome: (sessionId, id, outcome, context) =>
      run(() => store.settleAgentOutcome(sessionId, id, outcome, context)),
    copyConversationTaskLedger: (input) => {
      const acceptedInput: ConversationTaskLedgerCopyInput = Object.freeze({
        ...input,
        turnIds: Object.freeze([...input.turnIds]),
        runIdMap: Object.freeze(input.runIdMap.map((entry) => Object.freeze({ ...entry }))),
      });
      return run(() => store.copyConversationTaskLedger(acceptedInput));
    },
    purgeConversationTaskLedger: (sessionId) =>
      run(() => store.purgeConversationTaskLedger(sessionId)),
    subscribe: (listener) => store.subscribe(listener),
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      store.close();
    },
  };
  Object.freeze(writer);
  return writer;
}
