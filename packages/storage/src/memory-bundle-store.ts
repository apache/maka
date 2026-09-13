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
  invalidMemoryDocument,
  isRevision,
  memoryBundleIoFailed,
  type CommitMemoryBundleInput,
  MemoryBundleBackupRevisionConflictError,
  MemoryBundleBackupNotFoundError,
  type MemoryBackupSnapshot,
  type MemoryBundleMutationResult,
  MemoryBundleRevisionConflictError,
  type MemoryBundleSnapshot,
  MemoryBundleStoreError,
  type RestoreMemoryBackupInput,
} from './memory-bundle-model.js';
import {
  commitMemoryBundle,
  readMemoryBackups,
  readMemoryBundle,
  recoverMemoryBundle,
  restoreMemoryBackup,
} from './memory-bundle-io.js';
import { SerializedOperationLane } from './serialized-operation-lane.js';

export {
  MEMORY_DOCUMENT_MAX_BYTES,
  MemoryBundleBackupRevisionConflictError,
  MemoryBundleBackupNotFoundError,
  MemoryBundleRevisionConflictError,
  MemoryBundleStoreError,
} from './memory-bundle-model.js';
export type {
  CommitMemoryBundleInput,
  MemoryBackupKind,
  MemoryBackupSnapshot,
  MemoryBundleMutationResult,
  MemoryBundleSnapshot,
  MemoryBundleStoreErrorCode,
  MemoryDocumentName,
  MemoryRevision,
  MemoryDocumentSnapshot,
  RestoreMemoryBackupInput,
} from './memory-bundle-model.js';

const readerBrand: unique symbol = Symbol('InteractiveMemoryBundleStoreReader');
const writerBrand: unique symbol = Symbol('InteractiveMemoryBundleStoreWriter');

export interface InteractiveMemoryBundleStoreReader {
  readonly kind: 'interactive';
  readonly access: 'read';
  readonly [readerBrand]: true;
  read(): Promise<MemoryBundleSnapshot>;
  listBackups(): Promise<readonly MemoryBackupSnapshot[]>;
}

export interface InteractiveMemoryBundleStoreWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  read(): Promise<MemoryBundleSnapshot>;
  listBackups(): Promise<readonly MemoryBackupSnapshot[]>;
  commit(input: CommitMemoryBundleInput): Promise<MemoryBundleMutationResult>;
  restoreBackup(input: RestoreMemoryBackupInput): Promise<MemoryBundleMutationResult>;
}

const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveMemoryBundleStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveMemoryBundleStoreWriter>>();

export function authenticateInteractiveMemoryBundleStoreReader(
  store: InteractiveMemoryBundleStoreReader,
): InteractiveMemoryBundleStoreReader {
  if (!readers.has(store)) throw invalidFacade('read');
  return store;
}

export function authenticateInteractiveMemoryBundleStoreWriter(
  store: InteractiveMemoryBundleStoreWriter,
): InteractiveMemoryBundleStoreWriter {
  if (!writers.has(store)) throw invalidFacade('write');
  return store;
}

export async function openInteractiveMemoryBundleStoreForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveMemoryBundleStoreReader> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const facade = Object.freeze({
    kind: 'interactive' as const,
    access: 'read' as const,
    [readerBrand]: true as const,
    read: () =>
      runMemoryStoreOperation(() =>
        runWithStorageRootLease(lease, 'interactive', 'read', (root) => readMemoryBundle(root)),
      ),
    listBackups: () =>
      runMemoryStoreOperation(() =>
        runWithStorageRootLease(lease, 'interactive', 'read', (root) => readMemoryBackups(root)),
      ),
  });
  readers.add(facade);
  return facade;
}

export async function openInteractiveMemoryBundleStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveMemoryBundleStoreWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const coordinator = new MemoryBundleCoordinator(<T>(operation: (root: string) => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', operation),
  );
  const pending = Promise.resolve().then(async () => {
    await coordinator.recoverForWrite();
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recoveredExisting = writerByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const facade = Object.freeze({
      kind: 'interactive' as const,
      access: 'write' as const,
      [writerBrand]: true as const,
      read: () => coordinator.read(),
      listBackups: () => coordinator.listBackups(),
      commit: (input: CommitMemoryBundleInput) => coordinator.commit(admitCommitInput(input)),
      restoreBackup: (input: RestoreMemoryBackupInput) =>
        coordinator.restoreBackup(admitRestoreInput(input)),
    });
    writers.add(facade);
    writerByLease.set(lease, facade);
    return facade;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) {
      writerOpeningByLease.delete(lease);
    }
  }
}

type RootExecutor = <T>(operation: (root: string) => Promise<T>) => Promise<T>;

class MemoryBundleCoordinator {
  private readonly lane: SerializedOperationLane<string>;

  constructor(execute: RootExecutor) {
    this.lane = new SerializedOperationLane(execute);
  }

  recoverForWrite(): Promise<void> {
    return this.inLane((root) => recoverMemoryBundle(root));
  }

  read(): Promise<MemoryBundleSnapshot> {
    return this.inLane((root) => readMemoryBundle(root));
  }

  listBackups(): Promise<readonly MemoryBackupSnapshot[]> {
    return this.inLane((root) => readMemoryBackups(root));
  }

  commit(input: CommitMemoryBundleInput): Promise<MemoryBundleMutationResult> {
    return this.inLane((root) => commitMemoryBundle(root, input));
  }

  restoreBackup(input: RestoreMemoryBackupInput): Promise<MemoryBundleMutationResult> {
    return this.inLane((root) => restoreMemoryBackup(root, input));
  }

  private inLane<T>(operation: (root: string) => Promise<T>): Promise<T> {
    return this.lane.run(operation).catch(rethrowMemoryStoreError);
  }
}

function admitCommitInput(input: CommitMemoryBundleInput): CommitMemoryBundleInput {
  if (!isRevision(input.expectedRevision)) {
    throw invalidMemoryDocument('Expected Memory bundle revision must be SHA-256');
  }
  return {
    expectedRevision: input.expectedRevision,
    memory: Uint8Array.from(input.memory),
    pending: input.pending === null ? null : Uint8Array.from(input.pending),
    ...(input.backup === undefined ? {} : { backup: requireCommitBackupKind(input.backup) }),
  };
}

function admitRestoreInput(input: RestoreMemoryBackupInput): RestoreMemoryBackupInput {
  if (!isRevision(input.expectedRevision)) {
    throw invalidMemoryDocument('Expected Memory bundle revision must be SHA-256');
  }
  if (!isRevision(input.expectedBackupRevision)) {
    throw invalidMemoryDocument('Expected Memory backup revision must be SHA-256');
  }
  if (input.kind !== 'save' && input.kind !== 'reset' && input.kind !== 'restore') {
    throw invalidMemoryDocument('Memory backup kind is invalid');
  }
  return {
    expectedRevision: input.expectedRevision,
    expectedBackupRevision: input.expectedBackupRevision,
    kind: input.kind,
  };
}

function requireCommitBackupKind(input: unknown): 'save' | 'reset' {
  if (input !== 'save' && input !== 'reset') {
    throw invalidMemoryDocument('Memory commit backup kind is invalid');
  }
  return input;
}

function runMemoryStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch(rethrowMemoryStoreError);
}

function rethrowMemoryStoreError(error: unknown): never {
  if (
    error instanceof MemoryBundleStoreError ||
    error instanceof MemoryBundleRevisionConflictError ||
    error instanceof MemoryBundleBackupRevisionConflictError ||
    error instanceof MemoryBundleBackupNotFoundError ||
    error instanceof StorageRootAuthorityError
  ) {
    throw error;
  }
  if (isNodeError(error)) {
    throw memoryBundleIoFailed('Memory bundle I/O failed', error);
  }
  throw error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  );
}

function invalidFacade(access: 'read' | 'write'): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic interactive ${access} Memory bundle store`,
  );
}
