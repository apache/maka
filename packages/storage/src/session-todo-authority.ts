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

import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import {
  createSqliteSessionTodoStore,
  type SessionTodoStore,
  type SqliteSessionTodoStore,
} from './session-todo-store.js';

const writerBrand: unique symbol = Symbol('InteractiveSessionTodoWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveSessionTodoWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveSessionTodoWriter>>();

export interface InteractiveSessionTodoWriter extends SessionTodoStore {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  close(): void;
}

export function authenticateInteractiveSessionTodoWriter(
  writer: InteractiveSessionTodoWriter,
): InteractiveSessionTodoWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive SessionTodo writer',
    );
  }
  return writer;
}

export async function openInteractiveSessionTodoStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveSessionTodoWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteSessionTodoStore | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = createSqliteSessionTodoStore(root);
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
  store: SqliteSessionTodoStore,
): InteractiveSessionTodoWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>) => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'SessionTodo writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', async () => operation());
  };
  const writer: InteractiveSessionTodoWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    readOrBootstrap: (sessionId) => run(() => store.readOrBootstrap(sessionId)),
    replaceAll: (sessionId, items) => run(() => store.replaceAll(sessionId, items)),
    purge: (sessionId) => run(() => store.purge(sessionId)),
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
