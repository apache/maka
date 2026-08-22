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

import { randomUUID } from 'node:crypto';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import {
  CLIENT_CAPABILITY_MAX_RESULT_BYTES,
  CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES,
  decodeClientCapabilityResult,
  type ClientCapabilityCallResult,
  type ClientCapabilityClientFrame,
  type ClientCapabilityHostFrame,
  type ClientCapabilityHostPathAccess,
  type ClientCapabilityToolDescriptor,
} from '../protocol/index.js';
import type { ClientCapabilityConnectionSender } from './client-capability-service.js';

const MAX_CONCURRENT_INVOCATIONS_PER_CONNECTION = 8;
const MAX_RETIRED_INVOCATIONS = 1_024;

export type ClientCapabilityInvocationFailure =
  | 'capability_ambiguous'
  | 'capability_lost'
  | 'provider_overloaded'
  | 'provider_rejected'
  | 'provider_failed'
  | 'timed_out';

export class ClientCapabilityInvocationError extends Error {
  constructor(
    readonly code: ClientCapabilityInvocationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ClientCapabilityInvocationError';
  }
}

export interface ClientCapabilityInvocationRegistration {
  readonly connectionId: string;
  readonly registrationId: string;
}

export interface ClientCapabilityInvocationBinding {
  readonly offerId: string;
  readonly hostPathAccess: ClientCapabilityHostPathAccess;
  readonly descriptor: ClientCapabilityToolDescriptor;
}

interface ClientCapabilityInvocationContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly cwd: string;
}

interface InvocationState<Registration extends ClientCapabilityInvocationRegistration> {
  readonly invocationId: string;
  readonly registration: Registration;
  readonly resolve: (result: ClientCapabilityCallResult) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  readonly timer: NodeJS.Timeout;
  phase: 'dispatched' | 'accepted' | 'chunks';
  chunks?: {
    readonly byteLength: number;
    readonly chunkCount: number;
    readonly values: Buffer[];
    receivedBytes: number;
  };
}

export interface ClientCapabilityInvocationBrokerOptions<
  Registration extends ClientCapabilityInvocationRegistration,
> {
  readonly senderFor: (connectionId: string) => ClientCapabilityConnectionSender | undefined;
  readonly onRegistrationIdle: (registration: Registration) => void;
}

export class ClientCapabilityInvocationBroker<
  Registration extends ClientCapabilityInvocationRegistration,
> {
  readonly #senderFor: ClientCapabilityInvocationBrokerOptions<Registration>['senderFor'];
  readonly #onRegistrationIdle: ClientCapabilityInvocationBrokerOptions<Registration>['onRegistrationIdle'];
  readonly #invocations = new Map<string, InvocationState<Registration>>();
  readonly #retiredInvocationIds = new Set<string>();

  constructor(options: ClientCapabilityInvocationBrokerOptions<Registration>) {
    this.#senderFor = options.senderFor;
    this.#onRegistrationIdle = options.onRegistrationIdle;
  }

  invoke(
    registration: Registration,
    binding: ClientCapabilityInvocationBinding,
    args: Record<string, unknown>,
    context: ClientCapabilityInvocationContext,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ClientCapabilityCallResult> {
    return this.#invoke(registration, signal, timeoutMs, (invocationId) => ({
      kind: 'client.capability.call',
      invocationId,
      registrationId: registration.registrationId,
      offerId: binding.offerId,
      serverId: binding.descriptor.serverId,
      toolName: binding.descriptor.name,
      arguments: args,
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      ...(binding.hostPathAccess === 'cwd' ? { cwd: context.cwd } : {}),
    }));
  }

  invokeService(
    registration: Registration,
    serviceId: string,
    version: string,
    method: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ClientCapabilityCallResult> {
    return this.#invoke(registration, signal, timeoutMs, (invocationId) => ({
      kind: 'client.capability.service_call',
      invocationId,
      registrationId: registration.registrationId,
      serviceId,
      version,
      method,
      input,
    }));
  }

  #invoke(
    registration: Registration,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    frameFor: (invocationId: string) => ClientCapabilityHostFrame,
  ): Promise<ClientCapabilityCallResult> {
    const sender = this.#senderFor(registration.connectionId);
    if (!sender) {
      return Promise.reject(
        new ClientCapabilityInvocationError(
          'capability_lost',
          'Client Capability provider is unavailable',
        ),
      );
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const activeForConnection = [...this.#invocations.values()].filter(
      (invocation) => invocation.registration.connectionId === registration.connectionId,
    ).length;
    if (activeForConnection >= MAX_CONCURRENT_INVOCATIONS_PER_CONNECTION) {
      return Promise.reject(
        new ClientCapabilityInvocationError(
          'provider_overloaded',
          'Client Capability provider has too many active invocations',
        ),
      );
    }

    const invocationId = randomUUID();
    return new Promise<ClientCapabilityCallResult>((resolve, reject) => {
      const onAbort = signal
        ? () => {
            const invocation = this.#invocations.get(invocationId);
            if (!invocation) return;
            void sender.send({ kind: 'client.capability.cancel', invocationId }).catch(() => {});
            this.#settle(
              invocation,
              undefined,
              invocation.phase === 'dispatched'
                ? asError(abortReason(signal))
                : new ToolOutcomeUnknownError(
                    'Client Capability invocation was cancelled after provider acceptance',
                  ),
              true,
            );
          }
        : undefined;
      const timer = setTimeout(() => {
        const invocation = this.#invocations.get(invocationId);
        if (!invocation) return;
        void sender.send({ kind: 'client.capability.cancel', invocationId }).catch(() => {});
        this.#settle(
          invocation,
          undefined,
          invocation.phase === 'dispatched'
            ? new ClientCapabilityInvocationError(
                'timed_out',
                'Client Capability invocation timed out before provider acceptance',
              )
            : new ToolOutcomeUnknownError(
                'Client Capability invocation timed out after provider acceptance',
              ),
          true,
        );
      }, timeoutMs);
      const invocation: InvocationState<Registration> = {
        invocationId,
        registration,
        resolve,
        reject,
        signal,
        onAbort,
        timer,
        phase: 'dispatched',
      };
      this.#invocations.set(invocationId, invocation);
      if (onAbort) signal?.addEventListener('abort', onAbort, { once: true });
      void sender.send(frameFor(invocationId)).catch(() => {
        const current = this.#invocations.get(invocationId);
        if (!current) return;
        this.#settle(
          current,
          undefined,
          new ClientCapabilityInvocationError(
            'capability_lost',
            'Client Capability call could not be delivered',
          ),
          false,
        );
      });
    });
  }

  accept(connectionId: string, frame: ClientCapabilityClientFrame): void {
    const invocation = this.#invocations.get(frame.invocationId);
    if (!invocation) {
      if (this.#retiredInvocationIds.has(frame.invocationId)) return;
      throw new Error('Client Capability provider returned an unmatched invocation frame');
    }
    if (invocation.registration.connectionId !== connectionId) {
      throw new Error('Client Capability provider returned another connection invocation');
    }
    switch (frame.kind) {
      case 'client.capability.accepted': {
        if (invocation.phase !== 'dispatched') {
          throw new Error('Client Capability invocation was accepted more than once');
        }
        invocation.phase = 'accepted';
        const sender = this.#senderFor(invocation.registration.connectionId);
        if (!sender) {
          this.#settle(
            invocation,
            undefined,
            new ClientCapabilityInvocationError(
              'capability_lost',
              'Client Capability provider disappeared during acceptance',
            ),
            false,
          );
          return;
        }
        void sender
          .send({
            kind: 'client.capability.admitted',
            invocationId: invocation.invocationId,
          })
          .catch(() => {
            const current = this.#invocations.get(invocation.invocationId);
            if (!current) return;
            this.#settle(
              current,
              undefined,
              new ToolOutcomeUnknownError(
                'Client Capability acceptance acknowledgement could not be delivered',
              ),
              false,
            );
          });
        return;
      }
      case 'client.capability.rejected':
        if (invocation.phase !== 'dispatched') {
          throw new Error('Accepted Client Capability invocation cannot be rejected');
        }
        this.#settle(
          invocation,
          undefined,
          new ClientCapabilityInvocationError('provider_rejected', frame.message),
          true,
        );
        return;
      case 'client.capability.failed':
        if (invocation.phase === 'dispatched') {
          throw new Error('Client Capability failure arrived before acceptance');
        }
        this.#settle(
          invocation,
          undefined,
          new ClientCapabilityInvocationError('provider_failed', frame.message),
          true,
        );
        return;
      case 'client.capability.result':
        if (invocation.phase !== 'accepted') {
          throw new Error('Client Capability result arrived outside the accepted phase');
        }
        this.#settle(invocation, frame.result, undefined, true);
        return;
      case 'client.capability.result_start':
        if (invocation.phase !== 'accepted') {
          throw new Error('Client Capability result chunks started outside the accepted phase');
        }
        invocation.phase = 'chunks';
        invocation.chunks = {
          byteLength: frame.byteLength,
          chunkCount: frame.chunkCount,
          values: [],
          receivedBytes: 0,
        };
        return;
      case 'client.capability.result_chunk':
        this.#acceptChunk(invocation, frame.index, frame.data);
    }
  }

  releaseConnection(connectionId: string): void {
    for (const invocation of [...this.#invocations.values()]) {
      if (invocation.registration.connectionId !== connectionId) continue;
      this.#settle(
        invocation,
        undefined,
        invocation.phase === 'dispatched'
          ? new ClientCapabilityInvocationError(
              'capability_lost',
              'Client Capability provider disconnected before accepting the call',
            )
          : new ToolOutcomeUnknownError(
              'Client Capability provider disconnected after accepting the call',
            ),
        false,
      );
    }
  }

  holdsRegistration(registration: Registration): boolean {
    return [...this.#invocations.values()].some(
      (invocation) => invocation.registration === registration,
    );
  }

  close(): void {
    if (this.#invocations.size !== 0) {
      throw new Error('Client Capability invocation broker closed with active invocations');
    }
    this.#retiredInvocationIds.clear();
  }

  #acceptChunk(invocation: InvocationState<Registration>, index: number, data: string): void {
    const chunks = invocation.chunks;
    if (invocation.phase !== 'chunks' || !chunks || index !== chunks.values.length) {
      throw new Error('Client Capability result chunk is out of sequence');
    }
    const value = Buffer.from(data, 'base64');
    const remaining = chunks.byteLength - chunks.receivedBytes;
    const expectedLength = Math.min(CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES, remaining);
    if (value.byteLength !== expectedLength || index >= chunks.chunkCount) {
      throw new Error('Client Capability result chunk has invalid bounds');
    }
    chunks.values.push(value);
    chunks.receivedBytes += value.byteLength;
    if (chunks.values.length !== chunks.chunkCount) return;
    if (
      chunks.receivedBytes !== chunks.byteLength ||
      chunks.receivedBytes > CLIENT_CAPABILITY_MAX_RESULT_BYTES
    ) {
      throw new Error('Client Capability chunked result length changed');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.concat(chunks.values).toString('utf8'));
    } catch {
      throw new Error('Client Capability chunked result is not valid JSON');
    }
    this.#settle(invocation, decodeClientCapabilityResult(decoded), undefined, true);
  }

  #settle(
    invocation: InvocationState<Registration>,
    result: ClientCapabilityCallResult | undefined,
    error: Error | undefined,
    releaseRemote: boolean,
  ): void {
    if (this.#invocations.get(invocation.invocationId) !== invocation) return;
    this.#invocations.delete(invocation.invocationId);
    clearTimeout(invocation.timer);
    if (invocation.onAbort && invocation.signal) {
      invocation.signal.removeEventListener('abort', invocation.onAbort);
    }
    this.#rememberRetired(invocation.invocationId);
    if (releaseRemote) {
      const sender = this.#senderFor(invocation.registration.connectionId);
      void sender
        ?.send({
          kind: 'client.capability.release',
          invocationId: invocation.invocationId,
        })
        .catch(() => {});
    }
    if (error) invocation.reject(error);
    else if (result) invocation.resolve(result);
    else invocation.reject(new Error('Client Capability invocation settled without an outcome'));
    this.#onRegistrationIdle(invocation.registration);
  }

  #rememberRetired(invocationId: string): void {
    this.#retiredInvocationIds.add(invocationId);
    if (this.#retiredInvocationIds.size <= MAX_RETIRED_INVOCATIONS) return;
    const oldest = this.#retiredInvocationIds.values().next().value;
    if (typeof oldest === 'string') this.#retiredInvocationIds.delete(oldest);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Client Capability invocation cancelled');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
