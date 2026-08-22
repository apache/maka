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
import { openInteractiveDailyReviewAuthorityForWrite } from './daily-review-authority.js';
import { openInteractiveDeepResearchStoreForWrite } from './deep-research-authority.js';
import { openInteractiveExecutionStoresForWrite } from './execution-stores.js';
import { openInteractiveGoalAuthorityForWrite } from './goal-authority.js';
import { openInteractiveLongTermMemoryStoreForWrite } from './long-term-memory-store.js';
import { openInteractiveMemoryBundleStoreForWrite } from './memory-bundle-store.js';
import { openInteractivePlanStoreForWrite } from './plan-authority.js';
import { openInteractiveProjectCatalogForWrite } from './project-catalog-authority.js';
import { assertStorageRootLease, type StorageRootLease } from './root-authority.js';
import { openInteractiveRuntimePolicyStoresForWrite } from './runtime-policy-stores.js';
import { openInteractiveScheduledTaskStoreForWrite } from './scheduled-task-store.js';
import { openInteractiveShellRunStoreForWrite } from './shell-run-authority.js';
import { openInteractiveTaskLedgerStoreForWrite } from './task-ledger-authority.js';
import { openInteractiveUsageStoresForWrite } from './usage-stores.js';

export interface OpenStorageWriterCompositionOptions {
  /** Runs after the runtime-policy stores open and before the remaining writers open. */
  afterRuntimePolicyOpened?: (
    stores: Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>,
  ) => void | Promise<void>;
}

export interface StorageWriterComposition {
  readonly execution: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
  readonly projectCatalog: Awaited<ReturnType<typeof openInteractiveProjectCatalogForWrite>>;
  readonly runtimePolicy: Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;
  readonly scheduledTasks: Awaited<ReturnType<typeof openInteractiveScheduledTaskStoreForWrite>>;
  readonly plan: Awaited<ReturnType<typeof openInteractivePlanStoreForWrite>>;
  readonly deepResearch: Awaited<ReturnType<typeof openInteractiveDeepResearchStoreForWrite>>;
  readonly dailyReview: Awaited<ReturnType<typeof openInteractiveDailyReviewAuthorityForWrite>>;
  readonly goal: Awaited<ReturnType<typeof openInteractiveGoalAuthorityForWrite>>;
  readonly memoryBundle: Awaited<ReturnType<typeof openInteractiveMemoryBundleStoreForWrite>>;
  readonly longTermMemory: Awaited<ReturnType<typeof openInteractiveLongTermMemoryStoreForWrite>>;
  readonly taskLedger: Awaited<ReturnType<typeof openInteractiveTaskLedgerStoreForWrite>>;
  readonly artifacts: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>>;
  readonly usage: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>;
  readonly shellRuns: Awaited<ReturnType<typeof openInteractiveShellRunStoreForWrite>>;
  close(): Promise<void>;
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
    () => openInteractiveExecutionStoresForWrite(lease),
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
  const deepResearch = await openWriter(
    () => openInteractiveDeepResearchStoreForWrite(lease),
    closeWriter,
  );
  const dailyReview = await openWriter(
    () => openInteractiveDailyReviewAuthorityForWrite(lease),
    closeWriter,
  );
  const goal = await openWriter(() => openInteractiveGoalAuthorityForWrite(lease), closeWriter);
  const memoryBundle = await openWriter(() => openInteractiveMemoryBundleStoreForWrite(lease));
  const longTermMemory = await openWriter(
    () => openInteractiveLongTermMemoryStoreForWrite(lease),
    closeWriter,
  );
  const taskLedger = await openWriter(
    () => openInteractiveTaskLedgerStoreForWrite(lease),
    closeWriter,
  );
  const artifacts = await openWriter(
    () => openInteractiveArtifactStoreForWrite(lease),
    closeWriter,
  );
  const usage = await openWriter(() => openInteractiveUsageStoresForWrite(lease), closeWriter);
  const shellRuns = await openWriter(
    () => openInteractiveShellRunStoreForWrite(lease),
    closeWriter,
  );
  return Object.freeze({
    execution,
    projectCatalog,
    runtimePolicy,
    scheduledTasks,
    plan,
    deepResearch,
    dailyReview,
    goal,
    memoryBundle,
    longTermMemory,
    taskLedger,
    artifacts,
    usage,
    shellRuns,
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
