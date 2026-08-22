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

import type {
  DeepResearchArtifactRef,
  DeepResearchChecklistItem,
  DeepResearchCheckpoint,
  DeepResearchChangedEvent,
  DeepResearchEvent,
  DeepResearchHandoff,
  DeepResearchMutationContext,
  DeepResearchRun,
  DeepResearchScopeLevel,
  DeepResearchStep,
  DeepResearchStore,
} from '@maka/core/deep-research-run';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import {
  createSqliteDeepResearchStore,
  type SqliteDeepResearchStore,
} from './deep-research-store.js';

const writerBrand: unique symbol = Symbol('InteractiveDeepResearchStoreWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveDeepResearchStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveDeepResearchStoreWriter>>();

export interface InteractiveDeepResearchStoreWriter extends DeepResearchStore {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  purgeSessionState(sessionId: string): Promise<void>;
  close(): void;
}

export function authenticateInteractiveDeepResearchStoreWriter(
  writer: InteractiveDeepResearchStoreWriter,
): InteractiveDeepResearchStoreWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive Deep Research Store writer',
    );
  }
  return writer;
}

export async function openInteractiveDeepResearchStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveDeepResearchStoreWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteDeepResearchStore | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = createSqliteDeepResearchStore(root);
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
  store: SqliteDeepResearchStore,
): InteractiveDeepResearchStoreWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Deep Research Store writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractiveDeepResearchStoreWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    read: (sessionId) => run(() => store.read(sessionId)),
    readEvents: (sessionId) => run(() => store.readEvents(sessionId)),
    start: (sessionId, objective, scopeLevel, context) =>
      run(() => store.start(sessionId, objective, scopeLevel, cloneContext(context))),
    recordArtifact: (sessionId, artifact, context) =>
      run(() => store.recordArtifact(sessionId, cloneArtifact(artifact), cloneContext(context))),
    updateChecklist: (sessionId, item, context) =>
      run(() => store.updateChecklist(sessionId, cloneChecklist(item), cloneContext(context))),
    recordStep: (sessionId, step, context) =>
      run(() => store.recordStep(sessionId, cloneStep(step), cloneContext(context))),
    recordCheckpoint: (sessionId, checkpoint, context) =>
      run(() =>
        store.recordCheckpoint(sessionId, cloneCheckpoint(checkpoint), cloneContext(context)),
      ),
    complete: (sessionId, reportArtifactId, handoff, context) =>
      run(() =>
        store.complete(sessionId, reportArtifactId, cloneHandoff(handoff), cloneContext(context)),
      ),
    subscribe: (listener) => store.subscribe(listener),
    purgeSessionState: (sessionId) => run(() => store.purgeSessionState(sessionId)),
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

function cloneContext(
  context: DeepResearchMutationContext | undefined,
): DeepResearchMutationContext | undefined {
  return context ? { ...context } : undefined;
}

function cloneArtifact(artifact: DeepResearchArtifactRef): DeepResearchArtifactRef {
  return structuredClone(artifact);
}

function cloneChecklist(
  item: Omit<DeepResearchChecklistItem, 'title' | 'updatedAt'>,
): Omit<DeepResearchChecklistItem, 'title' | 'updatedAt'> {
  return structuredClone(item);
}

function cloneStep(
  step: Omit<DeepResearchStep, 'stepId' | 'createdAt'>,
): Omit<DeepResearchStep, 'stepId' | 'createdAt'> {
  return structuredClone(step);
}

function cloneCheckpoint(
  checkpoint: Omit<DeepResearchCheckpoint, 'checkpointId' | 'createdAt'>,
): Omit<DeepResearchCheckpoint, 'checkpointId' | 'createdAt'> {
  return structuredClone(checkpoint);
}

function cloneHandoff(handoff: DeepResearchHandoff): DeepResearchHandoff {
  return structuredClone(handoff);
}

export type {
  DeepResearchChangedEvent,
  DeepResearchEvent,
  DeepResearchRun,
  DeepResearchScopeLevel,
};
