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
import { RuntimeMessageAuthorityInvariantError } from '@maka/runtime/message-authority';
import type { HostOperationErrorCode, OperationSpec } from '../protocol/operation-spec.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';

export type QueuedMutationKind =
  | 'retract'
  | 'retract_entry'
  | 'promote'
  | 'update_entry'
  | 'reorder';

type MutationInput = {
  readonly originHostEpoch: string;
  readonly sessionId: string;
};

type QueuedMutationErrorCode =
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'outcome_unknown';

type MutationOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: QueuedMutationErrorCode; readonly message: string };
    };

export interface CompletedQueuedMutation {
  readonly payloadIdentity: object;
  readonly result: object;
}

export interface QueuedMutationRequest<I extends MutationInput, R> {
  readonly spec: OperationSpec<I, R, HostOperationErrorCode>;
  readonly kind: QueuedMutationKind;
  readonly id: string;
  readonly verb: string;
  readonly input: I;
  readonly payloadIdentity: object;
  readonly execute: () => Promise<MutationOutcome<R>>;
}

interface PendingMutation {
  readonly payload: MutationInput;
  readonly result: Promise<MutationOutcome<unknown>>;
}

interface QueuedMutationExecutorOptions {
  readonly hostEpoch: string;
  readonly admissions: SessionAdmissionGate;
  readonly isFailStopped: () => boolean;
  readonly readCompleted: (
    kind: QueuedMutationKind,
    sessionId: string,
    operationId: string,
  ) => CompletedQueuedMutation | undefined;
}

/** Epoch-local idempotency and Session admission for all queue mutations. */
export class QueuedMutationExecutor {
  readonly #hostEpoch: string;
  readonly #admissions: SessionAdmissionGate;
  readonly #isFailStopped: () => boolean;
  readonly #readCompleted: QueuedMutationExecutorOptions['readCompleted'];
  readonly #pending = new Map<string, PendingMutation>();

  constructor(options: QueuedMutationExecutorOptions) {
    this.#hostEpoch = options.hostEpoch;
    this.#admissions = options.admissions;
    this.#isFailStopped = options.isFailStopped;
    this.#readCompleted = options.readCompleted;
  }

  run<I extends MutationInput, R>(
    request: QueuedMutationRequest<I, R>,
  ): Promise<MutationOutcome<R>> {
    const currentEpoch = request.input.originHostEpoch === this.#hostEpoch;
    const key = mutationKey(request.kind, request.input.sessionId, request.id);
    if (currentEpoch) {
      const pending = this.#pending.get(key);
      if (pending) {
        return isDeepStrictEqual(pending.payload, request.input)
          ? (pending.result as Promise<MutationOutcome<R>>)
          : Promise.resolve(conflict(`${request.verb} identity has a different payload`));
      }
    }
    if (this.#isFailStopped()) return Promise.resolve(draining());
    if (!currentEpoch) {
      return Promise.resolve(
        failed('outcome_unknown', `${request.verb} outcome is not durable across Host Epochs`),
      );
    }

    const result = this.#admit(request);
    this.#pending.set(key, { payload: request.input, result });
    void result.then(
      () => this.#settle(key, result),
      () => this.#settle(key, result),
    );
    return result;
  }

  pendingResults(sessionId: string): readonly Promise<MutationOutcome<unknown>>[] {
    return [...this.#pending.values()]
      .filter(({ payload }) => payload.sessionId === sessionId)
      .map(({ result }) => result);
  }

  #admit<I extends MutationInput, R>(
    request: QueuedMutationRequest<I, R>,
  ): Promise<MutationOutcome<R>> {
    return this.#admissions.run(request.input.sessionId, async () => {
      if (this.#isFailStopped()) return draining();
      const completed = this.#readCompleted(request.kind, request.input.sessionId, request.id);
      if (!completed) return request.execute();
      if (!isDeepStrictEqual(completed.payloadIdentity, request.payloadIdentity)) {
        return conflict(`${request.verb} identity has a different payload`);
      }
      try {
        return { ok: true, result: request.spec.decodeOutput(completed.result) };
      } catch (error) {
        throw new RuntimeMessageAuthorityInvariantError(
          `Invalid queued mutation replay outcome: ${
            error instanceof Error ? error.message : 'malformed'
          }`,
        );
      }
    });
  }

  #settle(key: string, result: Promise<MutationOutcome<unknown>>): void {
    if (this.#pending.get(key)?.result === result) this.#pending.delete(key);
  }
}

function mutationKey(kind: QueuedMutationKind, sessionId: string, operationId: string): string {
  return `${kind}\0${sessionId}\0${operationId}`;
}

function draining(): MutationOutcome<never> {
  return failed('host_draining', 'Runtime Host message authority has failed');
}

function conflict(message: string): MutationOutcome<never> {
  return failed('operation_conflict', message);
}

function failed(code: QueuedMutationErrorCode, message: string): MutationOutcome<never> {
  return { ok: false, error: { code, message } };
}
