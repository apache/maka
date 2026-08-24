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

import type { ShellRunPatch, ShellRunRecord, ShellRunStore } from '@maka/core/shell-run';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { createSqliteShellRunStore, type ClosableShellRunStore } from './shell-run-store.js';

const writerBrand: unique symbol = Symbol('InteractiveShellRunWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveShellRunWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveShellRunWriter>>();

export interface InteractiveShellRunWriter extends ShellRunStore {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  close(): void;
}

export function authenticateInteractiveShellRunWriter(
  writer: InteractiveShellRunWriter,
): InteractiveShellRunWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive ShellRun writer',
    );
  }
  return writer;
}

export async function openInteractiveShellRunStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveShellRunWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: ClosableShellRunStore | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = createSqliteShellRunStore(root);
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
  store: ClosableShellRunStore,
): InteractiveShellRunWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'ShellRun writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractiveShellRunWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    createShellRun: (record) => {
      const accepted = cloneRecord(record);
      return run(() => store.createShellRun(accepted));
    },
    updateShellRun: (sessionId, shellRunId, patch) => {
      const accepted = clonePatch(patch);
      return run(() => store.updateShellRun(sessionId, shellRunId, accepted));
    },
    readShellRun: (sessionId, shellRunId) => run(() => store.readShellRun(sessionId, shellRunId)),
    listSessionShellRuns: (sessionId) => run(() => store.listSessionShellRuns(sessionId)),
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

function cloneRecord(record: ShellRunRecord): ShellRunRecord {
  return structuredClone(record);
}

function clonePatch(patch: ShellRunPatch): ShellRunPatch {
  return structuredClone(patch);
}
