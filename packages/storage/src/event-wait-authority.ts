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

import { decodeEventWaitRecord, type EventWaitRecord } from '@maka/core/event-wait';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { assertSafeStorageId } from './storage-id.js';

export const EVENT_WAIT_PAGE_LIMIT = 200;
export interface EventWaitSnapshot {
  readonly authorityRevision: number;
  readonly record: EventWaitRecord;
}
export interface CommitEventWaitInput {
  readonly sessionId: string;
  readonly waitId: string;
  readonly expectedAuthorityRevision: number | null;
  readonly record: EventWaitRecord;
}
export type CommitEventWaitResult =
  | { readonly kind: 'committed'; readonly snapshot: EventWaitSnapshot }
  | { readonly kind: 'revision_conflict'; readonly actualAuthorityRevision: number | null }
  | { readonly kind: 'active_wait_conflict'; readonly waitId: string }
  | { readonly kind: 'session_unavailable' };
export interface ReadEventWaitInput {
  readonly sessionId: string;
  readonly waitId: string;
}
export interface ListPendingEventWaitsInput {
  readonly afterWaitId?: string;
  readonly limit: number;
}
export interface ListSessionEventWaitsInput extends ListPendingEventWaitsInput {
  readonly sessionId: string;
}
export interface EventWaitPage {
  readonly items: readonly EventWaitSnapshot[];
  readonly nextCursor: string | null;
}
type MaybePromise<T> = T | Promise<T>;
/** Internal backend port. Root leases authorize storage, not future observation or admission. */
export interface EventWaitAuthorityRepository {
  read(input: ReadEventWaitInput): MaybePromise<EventWaitSnapshot | null>;
  listSession(input: ListSessionEventWaitsInput): MaybePromise<EventWaitPage>;
  listPending(input: ListPendingEventWaitsInput): MaybePromise<EventWaitPage>;
  commit(input: CommitEventWaitInput): MaybePromise<CommitEventWaitResult>;
  close(): MaybePromise<void>;
}
const writerBrand: unique symbol = Symbol('InteractiveEventWaitAuthorityWriter');
const writers = new WeakSet<object>();
export interface InteractiveEventWaitAuthorityWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  read(input: ReadEventWaitInput): Promise<EventWaitSnapshot | null>;
  listSession(input: ListSessionEventWaitsInput): Promise<EventWaitPage>;
  listPending(input: ListPendingEventWaitsInput): Promise<EventWaitPage>;
  commit(input: CommitEventWaitInput): Promise<CommitEventWaitResult>;
  close(): Promise<void>;
}
export function authenticateInteractiveEventWaitAuthorityWriter(
  writer: InteractiveEventWaitAuthorityWriter,
): InteractiveEventWaitAuthorityWriter {
  if (!writers.has(writer))
    throw new StorageRootAuthorityError('invalid_lease', 'Expected an authentic event wait writer');
  return writer;
}
/** Composition only: an explicit backend is mandatory; there is no Local fallback. */
export async function openInteractiveEventWaitAuthorityForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
  repository: EventWaitAuthorityRepository,
): Promise<InteractiveEventWaitAuthorityWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  if (
    !repository ||
    ['read', 'listSession', 'listPending', 'commit', 'close'].some(
      (k) => typeof Reflect.get(repository, k) !== 'function',
    )
  ) {
    throw new TypeError('Execution persistence requires an eventWaitStore');
  }
  let closed = false;
  let closeTask: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const run = <T>(operation: () => MaybePromise<T>): Promise<T> => {
    if (closed)
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Event wait writer is closed'),
      );
    const pending = runWithStorageRootLease(lease, 'interactive', 'write', async () => {
      if (closed)
        throw new StorageRootAuthorityError('invalid_lease', 'Event wait writer is closed');
      return operation();
    });
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => undefined);
    return pending;
  };
  const writer: InteractiveEventWaitAuthorityWriter = Object.freeze({
    kind: 'interactive' as const,
    access: 'write' as const,
    [writerBrand]: true as const,
    read: async (input: ReadEventWaitInput) => {
      validateEventWaitRead(input);
      const captured = { ...input };
      return run(() => repository.read(captured));
    },
    listSession: async (input: ListSessionEventWaitsInput) => {
      validateEventWaitPage(input, true);
      const captured = { ...input };
      return run(() => repository.listSession(captured));
    },
    listPending: async (input: ListPendingEventWaitsInput) => {
      validateEventWaitPage(input);
      const captured = { ...input };
      return run(() => repository.listPending(captured));
    },
    commit: async (input: CommitEventWaitInput) => {
      // Capture before the async lease check, so caller mutation cannot change a queued write.
      const normalized = normalizeEventWaitCommit(input);
      return run(() => repository.commit(normalized));
    },
    close: () =>
      (closeTask ??= (async () => {
        closed = true;
        writers.delete(writer);
        await Promise.allSettled([...active]);
        // The execution group alone closes the backend.
      })()),
  });
  writers.add(writer);
  return writer;
}

function exactInput(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Reflect.ownKeys(value).some(
      (k) =>
        typeof k !== 'string' ||
        (!required.includes(k) && !optional.includes(k)) ||
        !Object.getOwnPropertyDescriptor(value, k)?.enumerable ||
        !('value' in Object.getOwnPropertyDescriptor(value, k)!),
    )
  ) {
    throw new TypeError('Invalid event wait input');
  }
}
export function validateEventWaitRead(input: ReadEventWaitInput): void {
  exactInput(input, ['sessionId', 'waitId']);
  assertEventWaitStorageId(input.sessionId);
  assertEventWaitStorageId(input.waitId);
}
function assertEventWaitStorageId(value: unknown): asserts value is string {
  assertSafeStorageId(value);
  // The shared validator's end anchor also matches before a final newline.
  if (/[^A-Za-z0-9_-]/.test(value)) throw new TypeError('Invalid event wait storage identity');
}
export function validateEventWaitPage(input: ListPendingEventWaitsInput, session = false): void {
  exactInput(input, session ? ['sessionId', 'limit'] : ['limit'], ['afterWaitId']);
  if (session) assertEventWaitStorageId((input as ListSessionEventWaitsInput).sessionId);
  if (Object.hasOwn(input, 'afterWaitId')) assertEventWaitStorageId(input.afterWaitId);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > EVENT_WAIT_PAGE_LIMIT)
    throw new TypeError('Invalid event wait page limit');
}
export function normalizeEventWaitCommit(input: CommitEventWaitInput): CommitEventWaitInput {
  exactInput(input, ['sessionId', 'waitId', 'expectedAuthorityRevision', 'record']);
  assertEventWaitStorageId(input.sessionId);
  assertEventWaitStorageId(input.waitId);
  if (
    input.expectedAuthorityRevision !== null &&
    (!Number.isSafeInteger(input.expectedAuthorityRevision) || input.expectedAuthorityRevision < 0)
  )
    throw new TypeError('Invalid event wait revision');
  const record = decodeEventWaitRecord(input.record);
  if (record.sessionId !== input.sessionId || record.waitId !== input.waitId)
    throw new TypeError('Event wait identity mismatch');
  return {
    sessionId: input.sessionId,
    waitId: input.waitId,
    expectedAuthorityRevision: input.expectedAuthorityRevision,
    record,
  };
}
export function eventWaitPage(items: readonly EventWaitSnapshot[], limit: number): EventWaitPage {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? items[limit - 1]!.record.waitId : null,
  };
}
