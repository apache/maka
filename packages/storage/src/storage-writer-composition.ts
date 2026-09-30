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

import { openInteractiveArtifactStoreForWrite } from './artifact-stores.js';
import type { ContextOffloadLimits } from '@maka/core/context-offload';
import { openInteractiveContextOffloadStoreForWrite } from './context-offload-store.js';
import { openInteractiveDailyReviewAuthorityForWrite } from './daily-review-authority.js';
import { openInteractiveExecutionStoresForWrite } from './execution-stores.js';
import type { ExecutionPersistenceProvider } from './execution-persistence-provider.js';
import type { InteractiveGoalAuthorityWriter } from './goal-authority.js';
import { openInteractiveLongTermMemoryStoreForWrite } from './long-term-memory-store.js';
import { openInteractiveMemoryBundleStoreForWrite } from './memory-bundle-store.js';
import { openInteractivePlanStoreForWrite } from './plan-authority.js';
import { openInteractiveProjectCatalogForWrite } from './project-catalog-authority.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from './root-authority.js';
import { openInteractiveRuntimePolicyStoresForWrite } from './runtime-policy-stores.js';
import { openInteractiveScheduledTaskStoreForWrite } from './scheduled-task-store.js';
import { openInteractiveSessionTodoStoreForWrite } from './session-todo-authority.js';
import { openInteractiveShellRunStoreForWrite } from './shell-run-authority.js';
import {
  openStorageFootprintReader,
  type SessionStorageFootprint,
  type StorageFootprint,
} from './storage-footprint.js';
import { openInteractiveUsageStoresForWrite } from './usage-stores.js';

export type {
  SessionStorageFootprint,
  StorageFootprint,
  StorageFootprintKind,
  StorageFootprintTotal,
} from './storage-footprint.js';

export interface OpenStorageWriterCompositionOptions {
  /** One trusted backend for the complete execution transaction domain. */
  executionProvider?: ExecutionPersistenceProvider;
  /** Runs after the runtime-policy stores open and before the remaining writers open. */
  afterRuntimePolicyOpened?: (
    stores: Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>,
  ) => void | Promise<void>;
  /** Opens the context-offload authority only when a reader or writer is composed. */
  contextOffloadLimits?: ContextOffloadLimits;
}

export interface StorageWriterComposition {
  readonly execution: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
  readonly projectCatalog: Awaited<ReturnType<typeof openInteractiveProjectCatalogForWrite>>;
  readonly runtimePolicy: Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;
  readonly scheduledTasks: Awaited<ReturnType<typeof openInteractiveScheduledTaskStoreForWrite>>;
  readonly plan: Awaited<ReturnType<typeof openInteractivePlanStoreForWrite>>;
  readonly dailyReview: Awaited<ReturnType<typeof openInteractiveDailyReviewAuthorityForWrite>>;
  readonly goal: InteractiveGoalAuthorityWriter;
  readonly memoryBundle: Awaited<ReturnType<typeof openInteractiveMemoryBundleStoreForWrite>>;
  readonly longTermMemory: Awaited<ReturnType<typeof openInteractiveLongTermMemoryStoreForWrite>>;
  readonly sessionTodo: Awaited<ReturnType<typeof openInteractiveSessionTodoStoreForWrite>>;
  readonly artifacts: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>>;
  readonly contextOffload?: Awaited<ReturnType<typeof openInteractiveContextOffloadStoreForWrite>>;
  /** Present when the optional context-offload capability could not be opened. */
  readonly contextOffloadUnavailable?: { readonly cause: unknown };
  readonly usage: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>;
  readonly shellRuns: Awaited<ReturnType<typeof openInteractiveShellRunStoreForWrite>>;
  readonly footprint: InteractiveStorageFootprintReader;
  close(): Promise<void>;
}

/** Read-only State Root size measurement, bound to the composition's write lease. */
export interface InteractiveStorageFootprintReader {
  measure(): Promise<StorageFootprint>;
  measureSessions(sessionIds: readonly string[]): Promise<readonly SessionStorageFootprint[]>;
}

const activeCompositions = new WeakSet<object>();

export async function openStorageWriterComposition(
  lease: StorageRootLease<'interactive', 'write'>,
  options: OpenStorageWriterCompositionOptions = {},
): Promise<StorageWriterComposition> {
  if (activeCompositions.has(lease)) {
    throw new Error('Storage writer composition is already active for this lease');
  }
  await assertStorageRootLease(lease, 'interactive', 'write');
  if (activeCompositions.has(lease)) {
    throw new Error('Storage writer composition is already active for this lease');
  }
  activeCompositions.add(lease);
  return createComposition(lease, options);
}

async function createComposition(
  lease: StorageRootLease<'interactive', 'write'>,
  options: OpenStorageWriterCompositionOptions,
): Promise<StorageWriterComposition> {
  const closes: Array<() => void | Promise<void>> = [];
  let closeTask: Promise<void> | undefined;
  const close = () =>
    (closeTask ??= closeInReverse(closes).then(() => {
      // A failed close may leave a writer handle open, so keep this lease unavailable.
      activeCompositions.delete(lease);
    }));
  const failOpen = async (error: unknown): Promise<never> => {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Unable to open storage composition');
    }
    throw error;
  };
  const openWriter = async <T>(
    operation: () => Promise<T>,
    closeWriter?: (writer: T) => void | Promise<void>,
  ): Promise<T> => {
    try {
      const writer = await operation();
      if (closeWriter) closes.push(() => closeWriter(writer));
      return writer;
    } catch (error) {
      return failOpen(error);
    }
  };

  const execution = await openWriter(
    () => openInteractiveExecutionStoresForWrite(lease, options.executionProvider),
    (writer) => writer.sessionStore.close?.(),
  );
  try {
    await execution.sessionStore.ready();
  } catch (error) {
    await failOpen(error);
  }
  const projectCatalog = await openWriter(
    () => openInteractiveProjectCatalogForWrite(lease),
    closeWriter,
  );
  const runtimePolicy = await openWriter(() => openInteractiveRuntimePolicyStoresForWrite(lease));
  try {
    await options.afterRuntimePolicyOpened?.(runtimePolicy);
  } catch (error) {
    await failOpen(error);
  }
  const scheduledTasks = await openWriter(
    () => openInteractiveScheduledTaskStoreForWrite(lease),
    closeWriter,
  );
  const plan = await openWriter(() => openInteractivePlanStoreForWrite(lease), closeWriter);
  const dailyReview = await openWriter(
    () => openInteractiveDailyReviewAuthorityForWrite(lease),
    closeWriter,
  );
  const goal = execution.goalStore;
  const memoryBundle = await openWriter(() => openInteractiveMemoryBundleStoreForWrite(lease));
  const longTermMemory = await openWriter(
    () => openInteractiveLongTermMemoryStoreForWrite(lease),
    closeWriter,
  );
  const sessionTodo = await openWriter(
    () => openInteractiveSessionTodoStoreForWrite(lease),
    closeWriter,
  );
  const artifacts = await openWriter(
    () => openInteractiveArtifactStoreForWrite(lease),
    closeWriter,
  );
  const contextOffloadLimits = options.contextOffloadLimits;
  let contextOffload:
    | Awaited<ReturnType<typeof openInteractiveContextOffloadStoreForWrite>>
    | undefined;
  let contextOffloadUnavailable: { readonly cause: unknown } | undefined;
  if (contextOffloadLimits) {
    try {
      const openedContextOffload = await openInteractiveContextOffloadStoreForWrite(lease, {
        limits: contextOffloadLimits,
      });
      contextOffload = openedContextOffload;
      closes.push(() => closeWriter(openedContextOffload));
    } catch (cause) {
      contextOffloadUnavailable = Object.freeze({ cause });
    }
  }
  const usage = await openWriter(() => openInteractiveUsageStoresForWrite(lease), closeWriter);
  const shellRuns = await openWriter(
    () => openInteractiveShellRunStoreForWrite(lease),
    closeWriter,
  );
  const footprintReader = await openWriter(
    async () =>
      openStorageFootprintReader(lease.canonicalPath, {
        ...(contextOffload ? { contextOffload } : {}),
      }),
    (reader) => reader.close(),
  );
  const footprint: InteractiveStorageFootprintReader = Object.freeze({
    measure: () =>
      runWithStorageRootLease(lease, 'interactive', 'write', () => footprintReader.measure()),
    measureSessions: (sessionIds: readonly string[]) =>
      runWithStorageRootLease(lease, 'interactive', 'write', () =>
        footprintReader.measureSessions(sessionIds),
      ),
  });
  return Object.freeze({
    execution,
    projectCatalog,
    runtimePolicy,
    scheduledTasks,
    plan,
    dailyReview,
    goal,
    memoryBundle,
    longTermMemory,
    sessionTodo,
    artifacts,
    ...(contextOffload ? { contextOffload } : {}),
    ...(contextOffloadUnavailable ? { contextOffloadUnavailable } : {}),
    usage,
    shellRuns,
    footprint,
    close,
  });
}

function closeWriter(writer: { close(): void | Promise<void> }): void | Promise<void> {
  return writer.close();
}

async function closeInReverse(closes: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const close of closes.reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  closes.length = 0;
  if (errors.length) throw new AggregateError(errors, 'Unable to close storage composition');
}
