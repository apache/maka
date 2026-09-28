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

import { isDeepStrictEqual } from 'node:util';
import {
  clientCapabilityScopeIdentity,
  decodeClientCapabilitySessionGrant,
  decodeClientCapabilitySessionGrantKey,
  type ClientCapabilitySessionGrant,
  type ClientCapabilitySessionGrantKey,
} from '@maka/core/client-capability-grant';
import {
  decodeInteractionCanonicalOutcome,
  decodeInteractionRequest,
  isInteractionCanonicalOutcomeValidForRequest,
  projectInteractionFormRequest,
  projectInteractionQuestionRequest,
  type InteractionCanonicalOutcome,
  type InteractionRequest,
} from '@maka/core/interaction';
import { isSafeStorageId } from './storage-id.js';

export const REMEMBER_SCOPE_ID = /^[0-9a-f]{64}$/;
export const STORED_INTERACTION_REQUEST_MAX_BYTES = 20 * 1024;
export const STORED_INTERACTION_OUTCOME_MAX_BYTES = 12 * 1024;
export const STORED_CLIENT_CAPABILITY_SESSION_GRANT_MAX_BYTES = 12 * 1024;

export interface InteractionIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly requestId: string;
}

export interface StoredInteractionRequest extends InteractionIdentity {
  readonly createdAt: number;
  readonly request: InteractionRequest;
  readonly rememberScopeId?: string;
}

export interface StoredInteractionOutcome extends InteractionIdentity {
  readonly outcome: InteractionCanonicalOutcome;
}

export interface InteractionRecord {
  readonly request: StoredInteractionRequest;
  readonly outcome?: StoredInteractionOutcome;
}

export interface PendingInteractionFilter {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly kind?: InteractionRequest['kind'];
}

export type InteractionStoreErrorCode =
  | 'invalid_input'
  | 'invalid_record'
  | 'request_not_found'
  | 'io_failed';

export class InteractionStoreError extends Error {
  constructor(
    readonly code: InteractionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InteractionStoreError';
  }
}

export type InteractionMutationFailureResult =
  | {
      readonly status: 'definitely_not_published';
      readonly failure: InteractionStoreError;
    }
  | { readonly status: 'unresolved'; readonly failure: InteractionStoreError };

export type EstablishInteractionRequestResult =
  | {
      readonly status: 'stable';
      readonly matches: boolean;
      readonly record: InteractionRecord;
    }
  | InteractionMutationFailureResult;

export type CommitInteractionOutcomeResult =
  | {
      readonly status: 'stable';
      readonly matches: boolean;
      readonly record: InteractionRecord & {
        readonly outcome: StoredInteractionOutcome;
      };
    }
  | InteractionMutationFailureResult;

export interface InteractionStoreReader {
  readInteraction(requestId: string): Promise<InteractionRecord | undefined>;
  listSessionPending(sessionId: string): Promise<StoredInteractionRequest[]>;
  listPending(filter?: PendingInteractionFilter): Promise<StoredInteractionRequest[]>;
  readClientCapabilitySessionGrant(
    key: ClientCapabilitySessionGrantKey,
  ): Promise<ClientCapabilitySessionGrant | undefined>;
}

export interface InteractionStoreWriter extends InteractionStoreReader {
  establishRequest(input: StoredInteractionRequest): Promise<EstablishInteractionRequestResult>;
  commitOutcome(
    requestId: string,
    outcome: InteractionCanonicalOutcome,
  ): Promise<CommitInteractionOutcomeResult>;
  commitClientCapabilitySessionGrant(
    grant: ClientCapabilitySessionGrant,
  ): Promise<ClientCapabilitySessionGrant>;
  commitClientCapabilityOutcome(
    requestId: string,
    outcome: Extract<
      InteractionCanonicalOutcome,
      { kind: 'client_capability_decision' | 'closure' }
    >,
    grant?: ClientCapabilitySessionGrant,
  ): Promise<CommitInteractionOutcomeResult>;
}

export function sameGrantAuthority(
  left: ClientCapabilitySessionGrantKey,
  right: ClientCapabilitySessionGrantKey,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.providerId === right.providerId &&
    left.contractId === right.contractId &&
    left.capability === right.capability &&
    left.scope.kind === right.scope.kind &&
    clientCapabilityScopeIdentity(left.scope) === clientCapabilityScopeIdentity(right.scope)
  );
}

export function sortPending(requests: StoredInteractionRequest[]): StoredInteractionRequest[] {
  return requests.sort(
    (a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId),
  );
}

export type DecodeSource = 'input' | 'record';

export function normalizeRequest(value: unknown, source: DecodeSource): StoredInteractionRequest {
  const record = closedRecord(
    value,
    ['sessionId', 'turnId', 'runId', 'requestId', 'createdAt', 'request'],
    ['rememberScopeId'],
    source,
  );
  const createdAt = record.createdAt;
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0)
    decodeFailure(source, 'createdAt must be a non-negative safe integer');
  let request: InteractionRequest;
  try {
    request = decodeInteractionRequest(record.request);
    if (request.kind === 'question') {
      const canonical = projectInteractionQuestionRequest({
        toolUseId: request.toolUseId,
        questions: request.questions,
      });
      if (!isDeepStrictEqual(request, canonical))
        decodeFailure(source, 'Interaction question request is not canonical safe text');
      request = canonical;
    } else if (request.kind === 'form') {
      const canonical = projectInteractionFormRequest({
        toolUseId: request.toolUseId,
        message: request.message,
        requester: request.requester,
        fields: request.fields,
      });
      if (!isDeepStrictEqual(request, canonical)) {
        decodeFailure(source, 'Interaction form request is not canonical');
      }
      request = canonical;
    }
  } catch (error) {
    if (error instanceof InteractionStoreError) throw error;
    decodeFailure(source, 'Invalid Interaction request', error);
  }
  const rememberScopeId =
    record.rememberScopeId === undefined
      ? undefined
      : assertRememberScopeId(record.rememberScopeId, source);
  if (rememberScopeId !== undefined && !isRememberScopeEligible(request))
    decodeFailure(source, 'rememberScopeId requires a rememberable tool permission request');
  return {
    sessionId: assertId(record.sessionId, source),
    turnId: assertId(record.turnId, source),
    runId: assertId(record.runId, source),
    requestId: assertId(record.requestId, source),
    createdAt: createdAt as number,
    request,
    ...(rememberScopeId === undefined ? {} : { rememberScopeId }),
  };
}

export function normalizeOutcome(
  value: unknown,
  request: StoredInteractionRequest,
): StoredInteractionOutcome {
  const record = closedRecord(
    value,
    ['sessionId', 'turnId', 'runId', 'requestId', 'outcome'],
    [],
    'record',
  );
  const storedIdentity: InteractionIdentity = {
    sessionId: assertId(record.sessionId, 'record'),
    turnId: assertId(record.turnId, 'record'),
    runId: assertId(record.runId, 'record'),
    requestId: assertId(record.requestId, 'record'),
  };
  if (!isDeepStrictEqual(storedIdentity, identity(request)))
    throw new InteractionStoreError('invalid_record', 'Outcome identity does not match request');
  let outcome: InteractionCanonicalOutcome;
  try {
    outcome = decodeInteractionCanonicalOutcome(record.outcome);
  } catch (error) {
    decodeFailure('record', 'Invalid stored Interaction outcome', error);
  }
  if (!isInteractionCanonicalOutcomeValidForRequest(request.request, outcome))
    throw new InteractionStoreError('invalid_record', 'Stored outcome is invalid for request');
  return { ...identity(request), outcome };
}

export function decodeGrant(value: unknown, source: DecodeSource): ClientCapabilitySessionGrant {
  try {
    return decodeClientCapabilitySessionGrant(value);
  } catch (error) {
    decodeFailure(source, 'Invalid Client Capability Session Grant', error);
  }
}

export function decodeGrantKey(
  value: unknown,
  source: DecodeSource,
): ClientCapabilitySessionGrantKey {
  try {
    return decodeClientCapabilitySessionGrantKey(value);
  } catch (error) {
    decodeFailure(source, 'Invalid Client Capability Session Grant key', error);
  }
}

export function decodeClientCapabilityOutcome(
  value: unknown,
): Extract<InteractionCanonicalOutcome, { kind: 'client_capability_decision' | 'closure' }> {
  let outcome: InteractionCanonicalOutcome;
  try {
    outcome = decodeInteractionCanonicalOutcome(value);
  } catch (error) {
    decodeFailure('input', 'Invalid Client Capability Interaction outcome', error);
  }
  if (outcome.kind !== 'client_capability_decision' && outcome.kind !== 'closure') {
    decodeFailure('input', 'Invalid Client Capability Interaction outcome kind');
  }
  return outcome;
}

export function identity(value: InteractionIdentity): InteractionIdentity {
  return {
    sessionId: value.sessionId,
    turnId: value.turnId,
    runId: value.runId,
    requestId: value.requestId,
  };
}
export function assertId(
  value: unknown,
  source: DecodeSource = 'input',
  message = 'Invalid Interaction identity',
): string {
  if (!isSafeStorageId(value)) decodeFailure(source, message);
  return value;
}

export function assertRememberScopeId(value: unknown, source: DecodeSource): string {
  if (typeof value !== 'string' || !REMEMBER_SCOPE_ID.test(value))
    decodeFailure(source, 'rememberScopeId must be a lowercase 64-character SHA-256 digest');
  return value;
}

export function isRememberScopeEligible(request: InteractionRequest): boolean {
  return (
    request.kind === 'permission' &&
    request.prompt.kind === 'tool_permission' &&
    request.prompt.rememberForTurnAllowed
  );
}

export function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  source: DecodeSource,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    decodeFailure(source, 'Stored Interaction request must be a plain object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    decodeFailure(source, 'Stored Interaction request must be a plain object');
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    Reflect.ownKeys(record).some((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor === undefined || !('value' in descriptor);
    }) ||
    required.some((key) => !Object.hasOwn(record, key))
  )
    decodeFailure(source, 'Stored Interaction request has invalid fields');
  return record;
}

export function parseJsonRecord(serialized: string, context: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new InteractionStoreError('invalid_record', `Invalid stored Interaction ${context}`, {
      cause: error,
    });
  }
}

export function decodeFailure(source: DecodeSource, message: string, cause?: unknown): never {
  throw new InteractionStoreError(
    source === 'input' ? 'invalid_input' : 'invalid_record',
    message,
    {
      cause,
    },
  );
}
export function encode(value: unknown, limit: number): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > limit)
    throw new InteractionStoreError('invalid_input', 'Interaction document exceeds size limit');
  return bytes;
}
export function failure(error: unknown, message: string): InteractionStoreError {
  return error instanceof InteractionStoreError
    ? error
    : new InteractionStoreError('io_failed', message, { cause: error });
}
export function normalizeFilter(filter: PendingInteractionFilter): void {
  for (const value of [filter.sessionId, filter.turnId, filter.runId])
    if (value !== undefined) assertId(value);
}
export function matches(
  request: StoredInteractionRequest,
  filter: PendingInteractionFilter,
): boolean {
  return (
    (filter.sessionId === undefined || filter.sessionId === request.sessionId) &&
    (filter.turnId === undefined || filter.turnId === request.turnId) &&
    (filter.runId === undefined || filter.runId === request.runId) &&
    (filter.kind === undefined || filter.kind === request.request.kind)
  );
}
export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
