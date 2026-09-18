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
  AbandonPlanProposalInput,
  ApprovePlanProposalInput,
  CancelPlanExecutionInput,
  PlanMutationResult,
  PlanStore,
  RequestPlanRevisionInput,
  SubmitPlanProposalInput,
  UpdatePlanExecutionInput,
} from '@maka/core/plan';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { createSqlitePlanStore, type SqlitePlanStore } from './plan-store.js';

const writerBrand: unique symbol = Symbol('InteractivePlanStoreWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractivePlanStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractivePlanStoreWriter>>();

export interface InteractivePlanStoreWriter extends PlanStore {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  purgeSessionState(sessionId: string): Promise<void>;
  close(): void;
}

export function authenticateInteractivePlanStoreWriter(
  writer: InteractivePlanStoreWriter,
): InteractivePlanStoreWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive Plan Store writer',
    );
  }
  return writer;
}

/**
 * Decorates the one authoritative interactive Plan writer. Every committed
 * mutation crosses this seam, so callers publish a projection invalidation once
 * instead of remembering individual tool or control paths.
 */
export function observeInteractivePlanStoreWriter(
  source: InteractivePlanStoreWriter,
  onChanged: (sessionId: string) => void,
  onPublicationFailure: () => void,
): InteractivePlanStoreWriter {
  const writer = authenticateInteractivePlanStoreWriter(source);
  const publish = <T extends PlanMutationResult | null>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> =>
    operation().then((result) => {
      if (result === null) return result;
      try {
        onChanged(sessionId);
      } catch {
        // The mutation is durable. Draining is safer than reporting an ambiguous
        // retry that could overwrite a later Plan writer.
        onPublicationFailure();
      }
      return result;
    });
  const observed: InteractivePlanStoreWriter = {
    kind: writer.kind,
    access: writer.access,
    [writerBrand]: true,
    readState: (sessionId) => writer.readState(sessionId),
    readOperationReceipt: (sessionId, operationId, operationInput) =>
      writer.readOperationReceipt(sessionId, operationId, operationInput),
    submitProposal: (input) => publish(input.sessionId, () => writer.submitProposal(input)),
    requestRevision: (input) => publish(input.sessionId, () => writer.requestRevision(input)),
    abandonProposal: (input) => publish(input.sessionId, () => writer.abandonProposal(input)),
    approveProposal: (input) => publish(input.sessionId, () => writer.approveProposal(input)),
    updateExecution: (input) => publish(input.sessionId, () => writer.updateExecution(input)),
    cancelExecution: (input) => publish(input.sessionId, () => writer.cancelExecution(input)),
    interruptActiveExecution: (sessionId, reason, operationId) =>
      publish(sessionId, () => writer.interruptActiveExecution(sessionId, reason, operationId)),
    resumeExecution: (sessionId, executionId, operationId) =>
      publish(sessionId, () => writer.resumeExecution(sessionId, executionId, operationId)),
    // Session retirement cleanup is not a running Plan business mutation. The
    // caller is deleting the Session projection, so publishing a per-Session
    // `plan` invalidation here would target state that is being removed.
    purgeSessionState: (sessionId) => writer.purgeSessionState(sessionId),
    close: () => {
      // The decorator authenticates like any other writer, so it has to retire
      // itself: the underlying writer only removes itself from the registry.
      writers.delete(observed);
      writer.close();
    },
  };
  writers.add(observed);
  return Object.freeze(observed);
}

export async function openInteractivePlanStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractivePlanStoreWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqlitePlanStore | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = createSqlitePlanStore(root);
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
  store: SqlitePlanStore,
): InteractivePlanStoreWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Plan Store writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractivePlanStoreWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    readState: (sessionId) => run(() => store.readState(sessionId)),
    readOperationReceipt: (sessionId, operationId, operationInput) =>
      run(() =>
        store.readOperationReceipt(sessionId, operationId, structuredClone(operationInput)),
      ),
    submitProposal: (input) => run(() => store.submitProposal(cloneSubmit(input))),
    requestRevision: (input) => run(() => store.requestRevision(cloneInput(input))),
    abandonProposal: (input) => run(() => store.abandonProposal(cloneInput(input))),
    approveProposal: (input) => run(() => store.approveProposal(cloneInput(input))),
    updateExecution: (input) => run(() => store.updateExecution(cloneUpdate(input))),
    cancelExecution: (input) => run(() => store.cancelExecution(cloneInput(input))),
    interruptActiveExecution: (sessionId, reason, operationId) =>
      run(() => store.interruptActiveExecution(sessionId, reason, operationId)),
    resumeExecution: (sessionId, executionId, operationId) =>
      run(() => store.resumeExecution(sessionId, executionId, operationId)),
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

function cloneSubmit(input: SubmitPlanProposalInput): SubmitPlanProposalInput {
  return structuredClone(input);
}

function cloneUpdate(input: UpdatePlanExecutionInput): UpdatePlanExecutionInput {
  return structuredClone(input);
}

function cloneInput<
  T extends
    | RequestPlanRevisionInput
    | AbandonPlanProposalInput
    | ApprovePlanProposalInput
    | CancelPlanExecutionInput,
>(input: T): T {
  return structuredClone(input);
}
