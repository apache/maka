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
  ContextOffloadLimits,
  ContextOffloadOwner,
  ContextOffloadStore,
} from '@maka/core/context-offload';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import {
  CONTEXT_OFFLOAD_DATABASE_NAME,
  SqliteContextOffloadStore,
} from './sqlite-context-offload-store.js';

const writerBrand: unique symbol = Symbol('InteractiveContextOffloadWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<
  object,
  { readonly writer: InteractiveContextOffloadWriter; readonly limitsKey: string }
>();
const writerOpeningByLease = new WeakMap<
  object,
  { readonly pending: Promise<InteractiveContextOffloadWriter>; readonly limitsKey: string }
>();
const writerClosingByLease = new WeakMap<
  object,
  { readonly pending: Promise<void>; readonly limitsKey: string }
>();

export interface OpenInteractiveContextOffloadStoreOptions {
  readonly limits: ContextOffloadLimits;
}

export interface InteractiveContextOffloadWriter extends Omit<ContextOffloadStore, 'close'> {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  close(): Promise<void>;
}

export function authenticateInteractiveContextOffloadWriter(
  writer: InteractiveContextOffloadWriter,
): InteractiveContextOffloadWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive context-offload writer',
    );
  }
  return writer;
}

/**
 * Opens context-offload storage through an authenticated interactive write
 * lease. Production callers must use this facade instead of constructing the
 * low-level SQLite Store directly.
 */
export async function openInteractiveContextOffloadStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
  options: OpenInteractiveContextOffloadStoreOptions,
): Promise<InteractiveContextOffloadWriter> {
  const limits = snapshotLimits(options.limits);
  const limitsKey = serializeLimits(limits);
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) {
    assertSameLimits(existing.limitsKey, limitsKey);
    return existing.writer;
  }
  const opening = writerOpeningByLease.get(lease);
  if (opening) {
    assertSameLimits(opening.limitsKey, limitsKey);
    return opening.pending;
  }
  const closing = writerClosingByLease.get(lease);
  if (closing) {
    assertSameLimits(closing.limitsKey, limitsKey);
    await closing.pending;
    return openInteractiveContextOffloadStoreForWrite(lease, { limits });
  }

  const pending = Promise.resolve().then(async () => {
    let store: SqliteContextOffloadStore | undefined;
    try {
      store = await runWithStorageRootLease(
        lease,
        'interactive',
        'write',
        async (root) =>
          new SqliteContextOffloadStore(join(root, CONTEXT_OFFLOAD_DATABASE_NAME), { limits }),
      );
      await assertStorageRootLease(lease, 'interactive', 'write');
      const raced = writerByLease.get(lease);
      if (raced) {
        store.close();
        assertSameLimits(raced.limitsKey, limitsKey);
        return raced.writer;
      }
      const writer = createWriterFacade(lease, store, limitsKey);
      writers.add(writer);
      writerByLease.set(lease, { writer, limitsKey });
      return writer;
    } catch (error) {
      store?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, { pending, limitsKey });
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease)?.pending === pending) {
      writerOpeningByLease.delete(lease);
    }
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: SqliteContextOffloadStore,
  limitsKey: string,
): InteractiveContextOffloadWriter {
  let closed = false;
  let closeTask: Promise<void> | undefined;
  const activeOperations = new Set<Promise<unknown>>();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Context-offload writer is closed'),
      );
    }
    const pending = runWithStorageRootLease(lease, 'interactive', 'write', operation);
    activeOperations.add(pending);
    void pending.finally(() => activeOperations.delete(pending)).catch(() => undefined);
    return pending;
  };
  const writer: InteractiveContextOffloadWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    put: (input) => {
      const accepted = Object.freeze({
        sessionId: input.sessionId,
        owner: Object.freeze({ ...input.owner }),
        bytes: new Uint8Array(input.bytes),
        mediaType: input.mediaType,
        ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      });
      return run(() => store.put(accepted));
    },
    read: (input) => {
      const accepted = Object.freeze({ ...input });
      return run(() => store.read(accepted));
    },
    copyReferences: (input) => {
      const accepted = Object.freeze({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        references: Object.freeze(
          input.references.map((reference) =>
            Object.freeze({
              sourceRefId: reference.sourceRefId,
              targetOwner: Object.freeze({ ...reference.targetOwner }),
            }),
          ),
        ),
      });
      return run(() => store.copyReferences(accepted));
    },
    releaseReference: (input) => {
      const accepted = Object.freeze({ ...input });
      return run(() => store.releaseReference(accepted));
    },
    retireSession: (sessionId) => run(() => store.retireSession(sessionId)),
    collectGarbage: (input) => {
      const accepted = Object.freeze({ ...input });
      return run(() => store.collectGarbage(accepted));
    },
    usage: (sessionId) => run(() => store.usage(sessionId)),
    close: () => {
      if (closeTask) return closeTask;
      closed = true;
      if (writerByLease.get(lease)?.writer === writer) writerByLease.delete(lease);
      writers.delete(writer);
      let pending!: Promise<void>;
      pending = (async () => {
        try {
          await Promise.allSettled([...activeOperations]);
          store.close();
        } finally {
          if (writerClosingByLease.get(lease)?.pending === pending) {
            writerClosingByLease.delete(lease);
          }
        }
      })();
      closeTask = pending;
      writerClosingByLease.set(lease, { pending, limitsKey });
      return pending;
    },
  };
  return Object.freeze(writer);
}

function snapshotLimits(limits: ContextOffloadLimits): ContextOffloadLimits {
  const ownerMaxBytes = Object.freeze({
    read_image_snapshot: readLimit(
      limits.ownerMaxBytes?.read_image_snapshot,
      'Read image snapshot byte limit',
    ),
    tool_result_archive: readLimit(
      limits.ownerMaxBytes?.tool_result_archive,
      'Tool Result archive byte limit',
    ),
  }) satisfies Readonly<Record<ContextOffloadOwner['kind'], number>>;
  return Object.freeze({
    ownerMaxBytes,
    sessionLogicalBytes: readLimit(limits.sessionLogicalBytes, 'Session context quota'),
    workspacePhysicalBytes: readLimit(limits.workspacePhysicalBytes, 'Workspace context quota'),
  });
}

function readLimit(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function serializeLimits(limits: ContextOffloadLimits): string {
  return [
    limits.ownerMaxBytes.read_image_snapshot,
    limits.ownerMaxBytes.tool_result_archive,
    limits.sessionLogicalBytes,
    limits.workspacePhysicalBytes,
  ].join(':');
}

function assertSameLimits(existing: string, requested: string): void {
  if (existing !== requested) {
    throw new Error('Context-offload writer is already bound to different limits for this lease');
  }
}
