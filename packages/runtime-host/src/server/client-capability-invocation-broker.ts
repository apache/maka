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
import type { InteractionFormInput, InteractionFormResult } from '@maka/core/interaction';
import {
  CLIENT_CAPABILITY_MAX_RESULT_BYTES,
  CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES,
  decodeClientCapabilityResult,
  type ClientCapabilityCallResult,
  type ClientCapabilityAdmissionEvidence,
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
  readonly resolveAccepted: (evidence: ClientCapabilityAdmissionEvidence) => void;
  readonly rejectAccepted: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  onProgress?: (current: number, total: number) => void;
  requestInteraction?: ClientCapabilityInteractionHandler;
  readonly timeoutMs: number;
  readonly providerAvailability: AbortController;
  cancelTimer?: () => void;
  interaction?: InvocationInteraction;
  acceptedSettled: boolean;
  phase:
    | 'dispatched'
    | 'accepted'
    | 'admitted'
    | 'awaiting_interaction'
    | 'delivering_interaction_result'
    | 'chunks';
  progress?: { current: number; total: number };
  chunks?: {
    readonly byteLength: number;
    readonly chunkCount: number;
    readonly values: Buffer[];
    receivedBytes: number;
  };
}

interface InvocationInteraction {
  readonly interactionId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  terminal?: { readonly error: Error; readonly releaseRemote: boolean };
}

type ClientCapabilityInteractionHandler = (
  form: InteractionFormInput,
  options?: { readonly cancellationSignal?: AbortSignal },
) => Promise<InteractionFormResult>;

export interface PreparedClientCapabilityInvocation {
  readonly invocationId: string;
  /** Resolves once the provider has parsed the call and is waiting at its admission cut. */
  waitUntilAccepted(): Promise<ClientCapabilityAdmissionEvidence>;
  /** Crosses the admission cut and returns the provider result. */
  admit(
    onProgress?: (current: number, total: number) => void,
    requestInteraction?: ClientCapabilityInteractionHandler,
  ): Promise<ClientCapabilityCallResult>;
  /** Cancels an accepted call that will not cross the admission cut. */
  cancel(): void;
  /** Aborts when the provider connection disappears before this call is admitted. */
  readonly providerSignal: AbortSignal;
}

export interface ClientCapabilityInvocationBrokerOptions<
  Registration extends ClientCapabilityInvocationRegistration,
> {
  readonly senderFor: (connectionId: string) => ClientCapabilityConnectionSender | undefined;
  readonly onRegistrationIdle: (registration: Registration) => void;
  readonly scheduleTimeout?: (callback: () => void, timeoutMs: number) => () => void;
}

export class ClientCapabilityInvocationBroker<
  Registration extends ClientCapabilityInvocationRegistration,
> {
  readonly #senderFor: ClientCapabilityInvocationBrokerOptions<Registration>['senderFor'];
  readonly #onRegistrationIdle: ClientCapabilityInvocationBrokerOptions<Registration>['onRegistrationIdle'];
  readonly #scheduleTimeout: NonNullable<
    ClientCapabilityInvocationBrokerOptions<Registration>['scheduleTimeout']
  >;
  readonly #invocations = new Map<string, InvocationState<Registration>>();
  readonly #retiredInvocationIds = new Set<string>();

  constructor(options: ClientCapabilityInvocationBrokerOptions<Registration>) {
    this.#senderFor = options.senderFor;
    this.#onRegistrationIdle = options.onRegistrationIdle;
    this.#scheduleTimeout =
      options.scheduleTimeout ??
      ((callback, timeoutMs) => {
        const timer = setTimeout(callback, timeoutMs);
        return () => clearTimeout(timer);
      });
  }

  async invoke(
    registration: Registration,
    binding: ClientCapabilityInvocationBinding,
    args: Record<string, unknown>,
    context: ClientCapabilityInvocationContext,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onProgress?: (current: number, total: number) => void,
    requestInteraction?: ClientCapabilityInteractionHandler,
  ): Promise<ClientCapabilityCallResult> {
    const prepared = this.prepare(
      registration,
      binding,
      args,
      context,
      signal,
      timeoutMs,
      onProgress,
      requestInteraction,
    );
    await prepared.waitUntilAccepted();
    return prepared.admit();
  }

  prepare(
    registration: Registration,
    binding: ClientCapabilityInvocationBinding,
    args: Record<string, unknown>,
    context: ClientCapabilityInvocationContext,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onProgress?: (current: number, total: number) => void,
    requestInteraction?: ClientCapabilityInteractionHandler,
  ): PreparedClientCapabilityInvocation {
    return this.#prepare(
      registration,
      signal,
      timeoutMs,
      onProgress,
      requestInteraction,
      (invocationId) => ({
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
      }),
    );
  }

  async invokeService(
    registration: Registration,
    serviceId: string,
    version: string,
    method: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ClientCapabilityCallResult> {
    const prepared = this.prepareService(
      registration,
      serviceId,
      version,
      method,
      input,
      signal,
      timeoutMs,
    );
    await prepared.waitUntilAccepted();
    return prepared.admit();
  }

  prepareService(
    registration: Registration,
    serviceId: string,
    version: string,
    method: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): PreparedClientCapabilityInvocation {
    return this.#prepare(registration, signal, timeoutMs, undefined, undefined, (invocationId) => ({
      kind: 'client.capability.service_call',
      invocationId,
      registrationId: registration.registrationId,
      serviceId,
      version,
      method,
      input,
    }));
  }

  #prepare(
    registration: Registration,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onProgress: ((current: number, total: number) => void) | undefined,
    requestInteraction: ClientCapabilityInteractionHandler | undefined,
    frameFor: (invocationId: string) => ClientCapabilityHostFrame,
  ): PreparedClientCapabilityInvocation {
    const sender = this.#senderFor(registration.connectionId);
    if (!sender) {
      throw new ClientCapabilityInvocationError(
        'capability_lost',
        'Client Capability provider is unavailable',
      );
    }
    if (signal?.aborted) throw abortReason(signal);
    const activeForConnection = [...this.#invocations.values()].filter(
      (invocation) => invocation.registration.connectionId === registration.connectionId,
    ).length;
    if (activeForConnection >= MAX_CONCURRENT_INVOCATIONS_PER_CONNECTION) {
      throw new ClientCapabilityInvocationError(
        'provider_overloaded',
        'Client Capability provider has too many active invocations',
      );
    }

    const invocationId = randomUUID();
    let resolveAccepted!: (evidence: ClientCapabilityAdmissionEvidence) => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<ClientCapabilityAdmissionEvidence>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const result = new Promise<ClientCapabilityCallResult>((resolve, reject) => {
      const onAbort = signal
        ? () => {
            const invocation = this.#invocations.get(invocationId);
            if (!invocation) return;
            void sender.send({ kind: 'client.capability.cancel', invocationId }).catch(() => {});
            const error =
              invocation.phase === 'dispatched' || invocation.phase === 'accepted'
                ? asError(abortReason(signal))
                : new ToolOutcomeUnknownError(
                    'Client Capability invocation was cancelled after admission',
                  );
            if (invocation.interaction) {
              this.#terminateInteraction(invocation, error, true, true);
            } else {
              this.#settle(invocation, undefined, error, true);
            }
          }
        : undefined;
      const invocation: InvocationState<Registration> = {
        invocationId,
        registration,
        resolve,
        reject,
        resolveAccepted,
        rejectAccepted,
        signal,
        onAbort,
        onProgress,
        requestInteraction,
        timeoutMs,
        providerAvailability: new AbortController(),
        acceptedSettled: false,
        phase: 'dispatched',
      };
      this.#invocations.set(invocationId, invocation);
      this.#armTimer(invocation);
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
    // A caller waiting only for provider acceptance still receives the same
    // failure through `accepted`; keep the result rejection from becoming
    // an unrelated unhandled rejection.
    void result.catch(() => {});
    return {
      invocationId,
      providerSignal:
        this.#invocations.get(invocationId)?.providerAvailability.signal ?? AbortSignal.abort(),
      waitUntilAccepted: () => accepted,
      admit: async (onProgress, requestInteraction) => {
        await accepted;
        const invocation = this.#invocations.get(invocationId);
        if (!invocation) return result;
        if (invocation.phase === 'accepted') {
          invocation.onProgress = onProgress ?? invocation.onProgress;
          invocation.requestInteraction = requestInteraction ?? invocation.requestInteraction;
          invocation.phase = 'admitted';
          this.#armTimer(invocation);
          const currentSender = this.#senderFor(invocation.registration.connectionId);
          if (!currentSender) {
            this.#settle(
              invocation,
              undefined,
              new ClientCapabilityInvocationError(
                'capability_lost',
                'Client Capability provider disappeared before admission',
              ),
              false,
            );
          } else {
            void currentSender
              .send({ kind: 'client.capability.admitted', invocationId })
              .catch(() => {
                const current = this.#invocations.get(invocationId);
                if (!current) return;
                this.#settle(
                  current,
                  undefined,
                  new ToolOutcomeUnknownError(
                    'Client Capability admission acknowledgement could not be delivered',
                  ),
                  false,
                );
              });
          }
        }
        return result;
      },
      cancel: () => {
        const invocation = this.#invocations.get(invocationId);
        if (!invocation) return;
        const currentSender = this.#senderFor(invocation.registration.connectionId);
        void currentSender
          ?.send({ kind: 'client.capability.cancel', invocationId })
          .catch(() => {});
        this.#settle(
          invocation,
          undefined,
          new ClientCapabilityInvocationError(
            'provider_rejected',
            'Client Capability invocation was cancelled before admission',
          ),
          true,
        );
      },
    };
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
        this.#clearTimer(invocation);
        invocation.acceptedSettled = true;
        invocation.resolveAccepted(frame.admissionEvidence);
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
        if (invocation.phase === 'dispatched' || invocation.phase === 'accepted') {
          throw new Error('Client Capability failure arrived before admission');
        }
        if (invocation.interaction) {
          this.#terminateInteraction(
            invocation,
            new ClientCapabilityInvocationError('provider_failed', frame.message),
            true,
            true,
          );
        } else {
          this.#settle(
            invocation,
            undefined,
            new ClientCapabilityInvocationError('provider_failed', frame.message),
            true,
          );
        }
        return;
      case 'client.capability.progress':
        if (
          invocation.phase !== 'admitted' &&
          invocation.phase !== 'delivering_interaction_result' &&
          invocation.phase !== 'chunks'
        ) {
          throw new Error('Client Capability progress arrived before admission');
        }
        if (
          invocation.progress &&
          (frame.total !== invocation.progress.total || frame.current < invocation.progress.current)
        ) {
          throw new Error('Client Capability progress moved backwards or changed total');
        }
        if (frame.current === invocation.progress?.current) return;
        invocation.progress = { current: frame.current, total: frame.total };
        invocation.onProgress?.(frame.current, frame.total);
        return;
      case 'client.capability.interaction_request':
        this.#acceptInteraction(invocation, frame.interactionId, frame.request);
        return;
      case 'client.capability.result':
        if (invocation.phase === 'awaiting_interaction') {
          this.#terminateInteraction(
            invocation,
            new ClientCapabilityInvocationError(
              'provider_failed',
              'Client Capability provider returned before its interaction completed',
            ),
            true,
            true,
          );
          return;
        }
        if (
          invocation.phase !== 'admitted' &&
          invocation.phase !== 'delivering_interaction_result'
        ) {
          throw new Error('Client Capability result arrived outside the admitted phase');
        }
        this.#settle(invocation, frame.result, undefined, true);
        return;
      case 'client.capability.result_start':
        if (invocation.phase === 'awaiting_interaction') {
          this.#terminateInteraction(
            invocation,
            new ClientCapabilityInvocationError(
              'provider_failed',
              'Client Capability provider returned before its interaction completed',
            ),
            true,
            true,
          );
          return;
        }
        if (
          invocation.phase !== 'admitted' &&
          invocation.phase !== 'delivering_interaction_result'
        ) {
          throw new Error('Client Capability result chunks started outside the admitted phase');
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

  async releaseConnection(connectionId: string): Promise<void> {
    const interactions: Promise<void>[] = [];
    for (const invocation of [...this.#invocations.values()]) {
      if (invocation.registration.connectionId !== connectionId) continue;
      if (invocation.phase === 'dispatched' || invocation.phase === 'accepted') {
        invocation.providerAvailability.abort(
          new ClientCapabilityInvocationError(
            'capability_lost',
            'Client Capability provider disconnected before admission',
          ),
        );
      }
      const error =
        invocation.phase === 'dispatched' || invocation.phase === 'accepted'
          ? new ClientCapabilityInvocationError(
              'capability_lost',
              'Client Capability provider disconnected before admission',
            )
          : new ToolOutcomeUnknownError(
              'Client Capability provider disconnected after accepting the call',
            );
      if (invocation.interaction) {
        interactions.push(invocation.interaction.done);
        this.#terminateInteraction(invocation, error, false, true);
      } else {
        this.#settle(invocation, undefined, error, false);
      }
    }
    await Promise.all(interactions);
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

  #acceptInteraction(
    invocation: InvocationState<Registration>,
    interactionId: string,
    request: InteractionFormInput,
  ): void {
    if (
      (invocation.phase !== 'admitted' && invocation.phase !== 'delivering_interaction_result') ||
      invocation.interaction
    ) {
      if (invocation.interaction) {
        this.#terminateInteraction(
          invocation,
          new ClientCapabilityInvocationError(
            'provider_failed',
            'Client Capability provider requested overlapping interactions',
          ),
          true,
          true,
        );
        return;
      }
      throw new Error('Client Capability interaction arrived outside the admitted phase');
    }
    if (!invocation.requestInteraction) {
      this.#settle(
        invocation,
        undefined,
        new ClientCapabilityInvocationError(
          'provider_failed',
          'Client Capability interaction is unavailable for this invocation',
        ),
        true,
      );
      return;
    }
    this.#clearTimer(invocation);
    invocation.phase = 'awaiting_interaction';
    let resolveDone!: () => void;
    const interaction: InvocationInteraction = {
      interactionId,
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone: () => resolveDone(),
    };
    invocation.interaction = interaction;
    void this.#runInteraction(invocation, interaction, request);
  }

  async #runInteraction(
    invocation: InvocationState<Registration>,
    interaction: InvocationInteraction,
    request: InteractionFormInput,
  ): Promise<void> {
    try {
      const signal = invocation.signal
        ? AbortSignal.any([invocation.signal, interaction.controller.signal])
        : interaction.controller.signal;
      const result = await invocation.requestInteraction!(request, {
        cancellationSignal: signal,
      });
      if (!this.#isCurrentInteraction(invocation, interaction)) return;
      const terminalBeforeSend = interaction.terminal;
      if (terminalBeforeSend) {
        this.#settle(
          invocation,
          undefined,
          terminalBeforeSend.error,
          terminalBeforeSend.releaseRemote,
        );
        return;
      }
      const sender = this.#senderFor(invocation.registration.connectionId);
      if (!sender) {
        this.#settle(
          invocation,
          undefined,
          new ToolOutcomeUnknownError(
            'Client Capability provider disappeared before receiving an interaction result',
          ),
          false,
        );
        return;
      }
      invocation.interaction = undefined;
      invocation.phase = 'delivering_interaction_result';
      this.#armTimer(invocation);
      await sender.send({
        kind: 'client.capability.interaction_result',
        invocationId: invocation.invocationId,
        interactionId: interaction.interactionId,
        result,
      });
      if (this.#invocations.get(invocation.invocationId) !== invocation) return;
      if (invocation.phase !== 'delivering_interaction_result') return;
      invocation.phase = 'admitted';
      this.#armTimer(invocation);
    } catch (error) {
      if (this.#invocations.get(invocation.invocationId) !== invocation) return;
      if (invocation.interaction !== interaction) {
        if (invocation.phase !== 'delivering_interaction_result') return;
        this.#settle(
          invocation,
          undefined,
          new ToolOutcomeUnknownError(
            `Client Capability interaction result could not be delivered: ${asError(error).message}`,
          ),
          false,
        );
        return;
      }
      this.#settle(
        invocation,
        undefined,
        interaction.terminal?.error ?? asError(error),
        interaction.terminal?.releaseRemote ?? true,
      );
    } finally {
      interaction.resolveDone();
    }
  }

  #terminateInteraction(
    invocation: InvocationState<Registration>,
    error: Error,
    releaseRemote: boolean,
    cancelProducer: boolean,
  ): void {
    const interaction = invocation.interaction;
    if (!interaction || interaction.terminal) return;
    interaction.terminal = { error, releaseRemote };
    if (cancelProducer) interaction.controller.abort(error);
  }

  #isCurrentInteraction(
    invocation: InvocationState<Registration>,
    interaction: InvocationInteraction,
  ): boolean {
    return (
      this.#invocations.get(invocation.invocationId) === invocation &&
      invocation.interaction === interaction
    );
  }

  #armTimer(invocation: InvocationState<Registration>): void {
    this.#clearTimer(invocation);
    invocation.cancelTimer = this.#scheduleTimeout(() => {
      const current = this.#invocations.get(invocation.invocationId);
      if (current !== invocation) return;
      const sender = this.#senderFor(current.registration.connectionId);
      void sender
        ?.send({ kind: 'client.capability.cancel', invocationId: current.invocationId })
        .catch(() => {});
      this.#settle(
        current,
        undefined,
        current.phase === 'dispatched' || current.phase === 'accepted'
          ? new ClientCapabilityInvocationError(
              'timed_out',
              'Client Capability invocation timed out before admission',
            )
          : new ToolOutcomeUnknownError('Client Capability invocation timed out after admission'),
        true,
      );
    }, invocation.timeoutMs);
  }

  #clearTimer(invocation: InvocationState<Registration>): void {
    invocation.cancelTimer?.();
    invocation.cancelTimer = undefined;
  }

  #settle(
    invocation: InvocationState<Registration>,
    result: ClientCapabilityCallResult | undefined,
    error: Error | undefined,
    releaseRemote: boolean,
  ): void {
    if (this.#invocations.get(invocation.invocationId) !== invocation) return;
    this.#invocations.delete(invocation.invocationId);
    this.#clearTimer(invocation);
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
    if (!invocation.acceptedSettled) {
      invocation.acceptedSettled = true;
      if (error) invocation.rejectAccepted(error);
      else
        invocation.rejectAccepted(
          new Error('Client Capability invocation settled before provider acceptance'),
        );
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
