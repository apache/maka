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
  decodeEventWaitRecord,
  decodeAnyEventWaitRecord,
  type AnyEventWaitRecord,
  type ConsumerEventWaitRecord,
  type EventWaitConsumerKind,
  type EventWaitRecord,
  type EventWaitStatus,
} from '@maka/core/event-wait';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { assertSafeStorageId } from './storage-id.js';

export const EVENT_WAIT_PAGE_LIMIT = 200;
export const EVENT_WAIT_OBSERVATION_HINT_LIMIT = 10_000;
export interface EventWaitSnapshot {
  readonly authorityRevision: number;
  readonly record: EventWaitRecord;
}
export interface AnyEventWaitSnapshot {
  readonly authorityRevision: number;
  readonly record: AnyEventWaitRecord;
}
export interface AnyEventWaitPage {
  readonly items: readonly AnyEventWaitSnapshot[];
  readonly nextCursor: string | null;
}
export interface ListAnyEventWaitsInput extends ListEventWaitPageInput {
  readonly sessionId?: string;
  readonly status?: EventWaitStatus;
  readonly consumerKind?: EventWaitConsumerKind;
  readonly deliveryOutstanding?: true;
}
export interface CommitAnyEventWaitInput extends Omit<CommitEventWaitInput, 'record'> {
  readonly record: AnyEventWaitRecord;
}
export type CommitAnyEventWaitResult =
  | Exclude<CommitEventWaitResult, { kind: 'committed' }>
  | { readonly kind: 'committed'; readonly snapshot: AnyEventWaitSnapshot };
export interface RegisterInvocationWaitInput {
  readonly record: ConsumerEventWaitRecord;
}
export interface AcknowledgeInvocationWaitResultInput extends ReadEventWaitInput {
  readonly operationId: string;
  readonly resultEventId: string;
  readonly at: number;
}
export interface RetireInvocationWaitInput extends ReadEventWaitInput {
  readonly operationId: string;
  readonly reason: string;
  readonly at: number;
}
export interface AcknowledgeGoalWaitingAdmissionInput extends ReadEventWaitInput {
  readonly turnId: string;
  readonly runId: string;
  readonly at: number;
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
  | { readonly kind: 'session_unavailable' };
export interface ReadEventWaitInput {
  readonly sessionId: string;
  readonly waitId: string;
}
export interface ListEventWaitPageInput {
  readonly afterWaitId?: string;
  readonly limit: number;
}
export interface ListSessionEventWaitsInput extends ListEventWaitPageInput {
  readonly sessionId: string;
}
/** A fact query, not an acknowledgement or a delivery queue. */
export interface ListEventWaitsByStatusInput extends ListEventWaitPageInput {
  readonly status: EventWaitStatus;
}
export interface EventWaitPage {
  readonly items: readonly EventWaitSnapshot[];
  readonly nextCursor: string | null;
}
export interface EventWaitSource {
  readonly providerId: string;
  readonly connectionId: string | null;
}
/** Ready waits; oldest attempted first by default. Scheduling hints are never authority. */
export interface ListEventWaitsForObservationInput {
  readonly limit: number;
  readonly now: number;
  /** Recovery traversal by immutable ID; eligibility filters remain unchanged. */
  readonly scan?: { readonly afterWaitId?: string };
  readonly dirtyWaitIds?: readonly string[];
  readonly excludedWaitIds?: readonly string[];
  readonly excludedSources?: readonly EventWaitSource[];
}
/** Source throttling outlives any individual wait or Session. */
export interface ExtendEventWaitSourceCooldownInput extends EventWaitSource {
  readonly observedAt: number;
  readonly until: number;
}
/** A crash-safe dispatch reservation, separate from source-reported cooldown facts. */
export interface ReserveEventWaitSourceDispatchInput extends ExtendEventWaitSourceCooldownInput {
  readonly token: string;
}
export type CompleteEventWaitSourceDispatchInput = ReserveEventWaitSourceDispatchInput;
type MaybePromise<T> = T | Promise<T>;
/** Internal backend port. Root leases authorize storage, not future observation or admission. */
export interface EventWaitAuthorityRepository {
  readAny(input: ReadEventWaitInput): MaybePromise<AnyEventWaitSnapshot | null>;
  listAny(input: ListAnyEventWaitsInput): MaybePromise<AnyEventWaitPage>;
  listAnyForObservation(
    input: ListEventWaitsForObservationInput,
  ): MaybePromise<readonly AnyEventWaitSnapshot[]>;
  commitAny(input: CommitAnyEventWaitInput): MaybePromise<CommitAnyEventWaitResult>;
  registerInvocationWait(input: RegisterInvocationWaitInput): MaybePromise<AnyEventWaitSnapshot>;
  acknowledgeInvocationWaitResult(
    input: AcknowledgeInvocationWaitResultInput,
  ): MaybePromise<AnyEventWaitSnapshot | null>;
  retireInvocationWait(input: RetireInvocationWaitInput): MaybePromise<AnyEventWaitSnapshot | null>;
  registerGoalWaitingWait(input: RegisterInvocationWaitInput): MaybePromise<AnyEventWaitSnapshot>;
  acknowledgeGoalWaitingAdmission(
    input: AcknowledgeGoalWaitingAdmissionInput,
  ): MaybePromise<AnyEventWaitSnapshot | null>;

  read(input: ReadEventWaitInput): MaybePromise<EventWaitSnapshot | null>;
  listSession(input: ListSessionEventWaitsInput): MaybePromise<EventWaitPage>;
  listByStatus(input: ListEventWaitsByStatusInput): MaybePromise<EventWaitPage>;
  listForObservation(
    input: ListEventWaitsForObservationInput,
  ): MaybePromise<readonly EventWaitSnapshot[]>;
  /** Effective limit, including an unfinished dispatch reservation. */
  readSourceCooldown(input: EventWaitSource): MaybePromise<number | null>;
  /** Returns only the real source cooldown; a dispatch reservation is independent. */
  extendSourceCooldown(input: ExtendEventWaitSourceCooldownInput): MaybePromise<number>;
  reserveSourceDispatch(input: ReserveEventWaitSourceDispatchInput): MaybePromise<boolean>;
  completeSourceDispatch(input: CompleteEventWaitSourceDispatchInput): MaybePromise<number>;
  commit(input: CommitEventWaitInput): MaybePromise<CommitEventWaitResult>;
  close(): MaybePromise<void>;
}
const writerBrand: unique symbol = Symbol('InteractiveEventWaitAuthorityWriter');
const writers = new WeakSet<object>();
export interface InteractiveEventWaitAuthorityWriter {
  readAny(input: ReadEventWaitInput): Promise<AnyEventWaitSnapshot | null>;
  listAny(input: ListAnyEventWaitsInput): Promise<AnyEventWaitPage>;
  listAnyForObservation(
    input: ListEventWaitsForObservationInput,
  ): Promise<readonly AnyEventWaitSnapshot[]>;
  commitAny(input: CommitAnyEventWaitInput): Promise<CommitAnyEventWaitResult>;
  registerInvocationWait(input: RegisterInvocationWaitInput): Promise<AnyEventWaitSnapshot>;
  acknowledgeInvocationWaitResult(
    input: AcknowledgeInvocationWaitResultInput,
  ): Promise<AnyEventWaitSnapshot | null>;
  retireInvocationWait(input: RetireInvocationWaitInput): Promise<AnyEventWaitSnapshot | null>;
  registerGoalWaitingWait(input: RegisterInvocationWaitInput): Promise<AnyEventWaitSnapshot>;
  acknowledgeGoalWaitingAdmission(
    input: AcknowledgeGoalWaitingAdmissionInput,
  ): Promise<AnyEventWaitSnapshot | null>;

  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  read(input: ReadEventWaitInput): Promise<EventWaitSnapshot | null>;
  listSession(input: ListSessionEventWaitsInput): Promise<EventWaitPage>;
  listByStatus(input: ListEventWaitsByStatusInput): Promise<EventWaitPage>;
  listForObservation(
    input: ListEventWaitsForObservationInput,
  ): Promise<readonly EventWaitSnapshot[]>;
  /** Effective limit, including an unfinished dispatch reservation. */
  readSourceCooldown(input: EventWaitSource): Promise<number | null>;
  /** Returns only the real source cooldown; a dispatch reservation is independent. */
  extendSourceCooldown(input: ExtendEventWaitSourceCooldownInput): Promise<number>;
  reserveSourceDispatch(input: ReserveEventWaitSourceDispatchInput): Promise<boolean>;
  completeSourceDispatch(input: CompleteEventWaitSourceDispatchInput): Promise<number>;
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
    [
      'readAny',
      'listAny',
      'listAnyForObservation',
      'commitAny',
      'registerInvocationWait',
      'acknowledgeInvocationWaitResult',
      'retireInvocationWait',
      'registerGoalWaitingWait',
      'acknowledgeGoalWaitingAdmission',
      'read',
      'listSession',
      'listByStatus',
      'listForObservation',
      'readSourceCooldown',
      'extendSourceCooldown',
      'reserveSourceDispatch',
      'completeSourceDispatch',
      'commit',
      'close',
    ].some((k) => typeof Reflect.get(repository, k) !== 'function')
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
    readAny: (input: ReadEventWaitInput) => {
      validateEventWaitRead(input);
      const captured = { ...input };
      return run(() => repository.readAny(captured));
    },
    listAny: (input: ListAnyEventWaitsInput) => {
      validateAnyEventWaitPage(input);
      const captured = { ...input };
      return run(() => repository.listAny(captured));
    },
    listAnyForObservation: (input: ListEventWaitsForObservationInput) => {
      validateEventWaitObservationList(input);
      const captured = structuredClone(input);
      return run(() => repository.listAnyForObservation(captured));
    },
    commitAny: (input: CommitAnyEventWaitInput) => {
      const captured = normalizeAnyEventWaitCommit(input);
      return run(() => repository.commitAny(captured));
    },
    registerInvocationWait: (input: RegisterInvocationWaitInput) => {
      const captured = structuredClone(input);
      return run(() => repository.registerInvocationWait(captured));
    },
    acknowledgeInvocationWaitResult: (input: AcknowledgeInvocationWaitResultInput) => {
      const captured = structuredClone(input);
      return run(() => repository.acknowledgeInvocationWaitResult(captured));
    },
    retireInvocationWait: (input: RetireInvocationWaitInput) => {
      const captured = structuredClone(input);
      return run(() => repository.retireInvocationWait(captured));
    },
    registerGoalWaitingWait: (input: RegisterInvocationWaitInput) => {
      const captured = structuredClone(input);
      return run(() => repository.registerGoalWaitingWait(captured));
    },
    acknowledgeGoalWaitingAdmission: (input: AcknowledgeGoalWaitingAdmissionInput) => {
      const captured = structuredClone(input);
      return run(() => repository.acknowledgeGoalWaitingAdmission(captured));
    },
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
    listByStatus: async (input: ListEventWaitsByStatusInput) => {
      validateEventWaitStatusPage(input);
      const captured = { ...input };
      return run(() => repository.listByStatus(captured));
    },
    listForObservation: async (input: ListEventWaitsForObservationInput) => {
      validateEventWaitObservationList(input);
      const captured = {
        limit: input.limit,
        now: input.now,
        ...(input.scan ? { scan: { ...input.scan } } : {}),
        ...(input.dirtyWaitIds ? { dirtyWaitIds: [...input.dirtyWaitIds] } : {}),
        ...(input.excludedWaitIds ? { excludedWaitIds: [...input.excludedWaitIds] } : {}),
        ...(input.excludedSources
          ? { excludedSources: input.excludedSources.map((source) => ({ ...source })) }
          : {}),
      };
      return run(() => repository.listForObservation(captured));
    },
    readSourceCooldown: async (input: EventWaitSource) => {
      validateEventWaitSource(input);
      const captured = { ...input };
      return run(() => repository.readSourceCooldown(captured));
    },
    extendSourceCooldown: async (input: ExtendEventWaitSourceCooldownInput) => {
      validateEventWaitSourceCooldown(input);
      const captured = { ...input };
      return run(() => repository.extendSourceCooldown(captured));
    },
    reserveSourceDispatch: async (input: ReserveEventWaitSourceDispatchInput) => {
      validateEventWaitSourceDispatch(input);
      const captured = { ...input };
      return run(() => repository.reserveSourceDispatch(captured));
    },
    completeSourceDispatch: async (input: CompleteEventWaitSourceDispatchInput) => {
      validateEventWaitSourceDispatch(input, true);
      const captured = { ...input };
      return run(() => repository.completeSourceDispatch(captured));
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
export function validateEventWaitPage(input: ListEventWaitPageInput, session = false): void {
  exactInput(input, session ? ['sessionId', 'limit'] : ['limit'], ['afterWaitId']);
  if (session) assertEventWaitStorageId((input as ListSessionEventWaitsInput).sessionId);
  if (Object.hasOwn(input, 'afterWaitId')) assertEventWaitStorageId(input.afterWaitId);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > EVENT_WAIT_PAGE_LIMIT)
    throw new TypeError('Invalid event wait page limit');
}
export function validateEventWaitObservationList(input: ListEventWaitsForObservationInput): void {
  exactInput(
    input,
    ['limit', 'now'],
    ['scan', 'dirtyWaitIds', 'excludedWaitIds', 'excludedSources'],
  );
  validateEventWaitPage({ limit: input.limit });
  if (!Number.isSafeInteger(input.now) || input.now < 0)
    throw new TypeError('Invalid event wait observation time');
  if (Object.hasOwn(input, 'scan')) {
    exactInput(input.scan, [], ['afterWaitId']);
    if (Object.hasOwn(input.scan!, 'afterWaitId'))
      assertEventWaitStorageId(input.scan!.afterWaitId);
  }
  for (const key of ['dirtyWaitIds', 'excludedWaitIds', 'excludedSources'] as const) {
    if (!Object.hasOwn(input, key)) continue;
    const values = input[key];
    if (
      !Array.isArray(values) ||
      values.length > EVENT_WAIT_OBSERVATION_HINT_LIMIT ||
      Reflect.ownKeys(values).length !== values.length + 1
    )
      throw new TypeError('Invalid event wait observation hints');
    for (let i = 0; i < values.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(values, i);
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new TypeError('Invalid event wait observation hint');
      if (key === 'excludedSources') validateEventWaitSource(descriptor.value);
      else assertEventWaitStorageId(descriptor.value);
    }
  }
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
export function validateEventWaitStatusPage(input: ListEventWaitsByStatusInput): void {
  exactInput(input, ['status', 'limit'], ['afterWaitId']);
  if (!['waiting', 'resolved', 'expired', 'cancelled'].includes(input.status))
    throw new TypeError('Invalid event wait status');
  validateEventWaitPage({
    limit: input.limit,
    ...(Object.hasOwn(input, 'afterWaitId') ? { afterWaitId: input.afterWaitId } : {}),
  });
}
export function eventWaitPage(items: readonly EventWaitSnapshot[], limit: number): EventWaitPage {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? items[limit - 1]!.record.waitId : null,
  };
}

export function validateEventWaitSource(input: EventWaitSource): void {
  exactInput(input, ['providerId', 'connectionId']);
  if (
    typeof input.providerId !== 'string' ||
    input.providerId.length < 1 ||
    input.providerId.length > 128 ||
    /[^A-Za-z0-9_.-]/.test(input.providerId)
  )
    throw new TypeError('Invalid event wait provider');
  if (input.connectionId !== null) {
    assertEventWaitStorageId(input.connectionId);
    if (input.connectionId.length > 128) throw new TypeError('Invalid event wait connection');
  }
}
export function validateEventWaitSourceCooldown(input: ExtendEventWaitSourceCooldownInput): void {
  exactInput(input, ['providerId', 'connectionId', 'observedAt', 'until']);
  validateEventWaitSource({ providerId: input.providerId, connectionId: input.connectionId });
  if (
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0 ||
    !Number.isSafeInteger(input.until) ||
    input.until <= input.observedAt
  )
    throw new TypeError('Invalid event wait source cooldown');
}
export function eventWaitSourceKey(input: EventWaitSource): string {
  return JSON.stringify([input.providerId, input.connectionId]);
}

export function validateEventWaitSourceDispatch(
  input: ReserveEventWaitSourceDispatchInput,
  completion = false,
): void {
  exactInput(input, ['providerId', 'connectionId', 'token', 'observedAt', 'until']);
  validateEventWaitSource({
    providerId: input.providerId,
    connectionId: input.connectionId,
  });
  if (
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0 ||
    !Number.isSafeInteger(input.until) ||
    (completion ? input.until < input.observedAt : input.until <= input.observedAt)
  )
    throw new TypeError('Invalid event wait dispatch time');
  assertEventWaitStorageId(input.token);
  if (input.token.length > 128) throw new TypeError('Invalid event wait dispatch token');
}

export function normalizeAnyEventWaitCommit(
  input: CommitAnyEventWaitInput,
): CommitAnyEventWaitInput {
  exactInput(input, ['sessionId', 'waitId', 'expectedAuthorityRevision', 'record']);
  validateEventWaitRead({ sessionId: input.sessionId, waitId: input.waitId });
  if (
    input.expectedAuthorityRevision !== null &&
    (!Number.isSafeInteger(input.expectedAuthorityRevision) || input.expectedAuthorityRevision < 0)
  )
    throw new TypeError('Invalid event wait revision');
  const record = decodeAnyEventWaitRecord(input.record);
  if (record.sessionId !== input.sessionId || record.waitId !== input.waitId)
    throw new TypeError('Event wait identity mismatch');
  return { ...input, record };
}
export function validateAnyEventWaitPage(input: ListAnyEventWaitsInput): void {
  exactInput(
    input,
    ['limit'],
    ['afterWaitId', 'sessionId', 'status', 'consumerKind', 'deliveryOutstanding'],
  );
  validateEventWaitPage({
    limit: input.limit,
    ...(input.afterWaitId === undefined ? {} : { afterWaitId: input.afterWaitId }),
  });
  if (input.sessionId !== undefined) assertEventWaitStorageId(input.sessionId);
  if (
    input.status !== undefined &&
    !['waiting', 'resolved', 'expired', 'cancelled'].includes(input.status)
  )
    throw new TypeError('Invalid event wait status');
  if (
    input.consumerKind !== undefined &&
    !['observation', 'tool_invocation', 'goal_waiting'].includes(input.consumerKind)
  )
    throw new TypeError('Invalid event wait consumer filter');
  if (input.deliveryOutstanding !== undefined && input.deliveryOutstanding !== true)
    throw new TypeError('Invalid event wait delivery filter');
}
export function anyEventWaitPage(
  items: readonly AnyEventWaitSnapshot[],
  limit: number,
): AnyEventWaitPage {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? items[limit - 1]!.record.waitId : null,
  };
}
