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

import { createHash } from 'node:crypto';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  decodeConsumerEventWaitRecord,
  eventWaitDeliveryKey,
  type AnyEventWaitRecord,
  type ConsumerEventWaitRecord,
} from '@maka/core/event-wait';
import {
  buildEventWaitTool,
  type EventWaitRequest,
  type EventWaitToolResult,
} from '@maka/runtime/event-wait-tool';
import type { MakaToolContext, MakaToolDurableOutcome } from '@maka/runtime/tool-runtime';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import { type HostEventWaitObserver, type EventWaitClock } from './event-wait-manager.js';
import type { HostEventWaitSources } from './event-wait-sources.js';
import type { EventWaitObservationAccess } from './event-wait-adapter.js';

interface Receiver {
  readonly context: MakaToolContext;
  readonly resolve: (result: EventWaitToolResult) => void;
  readonly reject: (error: unknown) => void;
  delivering: boolean;
  settled: boolean;
}
interface SteeringObservation {
  readonly ready: Promise<boolean>;
  interrupted: boolean;
}
export interface HostInvocationEventWaitOptions {
  readonly stores: ExecutionStoresWriter<'interactive'>;
  readonly observer: HostEventWaitObserver;
  readonly sources: HostEventWaitSources;
  readonly onError: (error: unknown) => void;
  readonly onChanged?: (sessionId: string) => void;
  readonly clock?: EventWaitClock;
}
export interface InvocationEventWaitTarget {
  readonly sessionId: string;
  readonly waitId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly operationId: string;
}
const waitIdentity = (sessionId: string, operationId: string): string =>
  `wait_${createHash('sha256')
    .update(JSON.stringify([sessionId, operationId]))
    .digest('hex')}`;
const clock: EventWaitClock = {
  now: Date.now,
  schedule(callback, delay) {
    const timer = setTimeout(callback, Math.min(delay, 2_147_483_647));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Observation only returns to the original Runtime operation. It never admits a Turn. */
export class HostInvocationEventWaitCoordinator {
  readonly #options: HostInvocationEventWaitOptions;
  readonly #clock: EventWaitClock;
  readonly #receivers = new Map<string, Receiver>();
  readonly #abort = new AbortController();
  readonly #runs = new Map<
    string,
    {
      sessionId: string;
      enabled: boolean;
      interrupted: Map<string, { key: string; deadline: number | null }>;
    }
  >();
  #ready = false;
  #closed = false;
  #scan?: Promise<void>;
  #timer?: () => void;
  #cursor?: string;

  constructor(options: HostInvocationEventWaitOptions) {
    this.#options = options;
    this.#clock = options.clock ?? clock;
  }

  admitRun(identity: { sessionId: string; runId: string }, enabled: boolean): void {
    const key = JSON.stringify([identity.sessionId, identity.runId]);
    const prior = this.#runs.get(key);
    if (prior) prior.enabled ||= enabled;
    else this.#runs.set(key, { sessionId: identity.sessionId, enabled, interrupted: new Map() });
  }
  refreshCapabilities(sessionId: string, enabled: boolean): void {
    if (enabled)
      for (const run of this.#runs.values()) if (run.sessionId === sessionId) run.enabled = true;
  }
  releaseRun(identity: { sessionId: string; runId: string }): void {
    this.#runs.delete(JSON.stringify([identity.sessionId, identity.runId]));
  }

  /** A backend may be reused concurrently; all capabilities belong to a specific Run. */
  createTool(sessionId: string, hasGoal: () => boolean) {
    const available = (identity?: { sessionId?: string; runId?: string }) => {
      if (identity?.sessionId !== undefined && identity.sessionId !== sessionId) return false;
      if (!identity?.runId) return hasGoal();
      this.admitRun({ sessionId, runId: identity.runId }, hasGoal());
      return this.#runs.get(JSON.stringify([sessionId, identity.runId]))!.enabled;
    };
    const tool = buildEventWaitTool(
      async (request, context) => {
        if (context.sessionId !== sessionId || !context.runId || !available(context))
          throw new Error('Event wait is unavailable for this execution');
        const interrupted = this.#runs.get(JSON.stringify([sessionId, context.runId]))!.interrupted;
        const key = canonicalToolArgsHash('WaitForEvent', {
          resource: request.resource,
          condition: request.condition,
        });
        // Equal conditions do not select an interrupted operation. Only an
        // explicit resume identity may consume it and inherit its deadline.
        const resumeWaitId = request.resumeWaitId;
        const prior = resumeWaitId ? interrupted.get(resumeWaitId) : undefined;
        if (resumeWaitId && (!prior || prior.key !== key))
          throw new Error(
            'Specify resumeWaitId for the exact interrupted wait and retain its resource and condition',
          );
        if (resumeWaitId) interrupted.delete(resumeWaitId);
        let result: EventWaitToolResult;
        try {
          result = await this.awaitCondition(request, context, prior?.deadline);
        } catch (error) {
          if (resumeWaitId && prior) interrupted.set(resumeWaitId, prior);
          throw error;
        }
        if (result.outcome === 'interrupted')
          interrupted.set(result.waitId, { key, deadline: result.deadlineAt });
        return result;
      },
      (outcome) => this.acknowledge(outcome),
    );
    return { tool, available };
  }

  async authorizeObservation(
    wait: AnyEventWaitRecord,
    signal: AbortSignal,
  ): Promise<EventWaitObservationAccess> {
    if (wait.schemaVersion !== 2 || wait.consumer.kind !== 'tool_invocation')
      return { kind: 'revoked', reason: 'wrong_event_wait_consumer' };
    const invocation = await this.#options.stores.runtimeEventStore.readRunInvocation(
      wait.sessionId,
      wait.consumer.runId,
    );
    if (
      !invocation ||
      invocation.terminalEvent ||
      invocation.invocationId !== wait.consumer.invocationId ||
      invocation.turnId !== wait.sourceTurnId
    )
      return { kind: 'revoked', reason: 'source_execution_ended' };
    const header = await this.#options.stores.sessionStore.readHeaderSnapshot(wait.sessionId);
    if (header.isArchived) return { kind: 'revoked', reason: 'session_archived' };
    if (signal.aborted || this.#closed) return { kind: 'unknown', reason: 'host_stopping' };
    return this.#options.sources.authorize(wait, signal);
  }

  async awaitCondition(
    request: EventWaitRequest,
    context: MakaToolContext,
    originalDeadline?: number | null,
  ): Promise<EventWaitToolResult> {
    const local = new AbortController();
    const steering: SteeringObservation = {
      interrupted: false,
      ready: Promise.resolve(false),
    };
    try {
      const ready = context.waitForSteering
        ? context
            .waitForSteering(
              AbortSignal.any([local.signal, context.abortSignal, this.#abort.signal]),
            )
            .then(() => {
              steering.interrupted = true;
              return true;
            })
            .catch((error: unknown) => {
              if (
                !local.signal.aborted &&
                !context.abortSignal.aborted &&
                !this.#closed &&
                !(error instanceof Error && error.name === 'AbortError')
              )
                this.#options.onError(error);
              return false;
            })
        : steering.ready;
      return await this.#awaitCondition(request, context, originalDeadline, {
        get interrupted() {
          return steering.interrupted;
        },
        ready,
      });
    } finally {
      local.abort();
    }
  }

  async #awaitCondition(
    request: EventWaitRequest,
    context: MakaToolContext,
    originalDeadline: number | null | undefined,
    steering: SteeringObservation,
  ): Promise<EventWaitToolResult> {
    if (
      !this.#ready ||
      this.#closed ||
      context.abortSignal.aborted ||
      !context.runId ||
      !context.invocationId ||
      !context.operationId
    )
      throw new Error('Event wait requires a live admitted tool operation');
    const waitId = waitIdentity(context.sessionId, context.operationId);
    const identity = { sessionId: context.sessionId, waitId };
    const existing = await this.#options.stores.eventWaitStore.readAny(identity);
    const createdAt = existing?.record.createdAt ?? this.#clock.now();
    const deadlineAt = existing
      ? existing.record.deadlineAt
      : originalDeadline !== undefined
        ? originalDeadline
        : request.timeoutMs === undefined
          ? null
          : createdAt + request.timeoutMs;
    if (deadlineAt !== null && !Number.isSafeInteger(deadlineAt))
      throw new Error('Invalid event wait deadline');
    const record = decodeConsumerEventWaitRecord({
      schemaVersion: 2,
      waitId,
      sessionId: context.sessionId,
      sourceTurnId: context.turnId,
      consumer: {
        kind: 'tool_invocation',
        runId: context.runId,
        invocationId: context.invocationId,
        operationId: context.operationId,
        toolCallId: context.toolCallId,
      },
      resource: request.resource,
      condition: request.condition,
      deliveryKey: eventWaitDeliveryKey(waitId),
      createdAt,
      updatedAt: createdAt,
      deadlineAt,
      status: 'waiting',
    });
    this.#options.observer.validate(record);
    // T1 registration checks operation identity/arguments atomically in the same store.
    await this.#options.stores.eventWaitStore.registerInvocationWait({ record });
    this.#notifyChanged(record.sessionId);
    context.abortSignal.throwIfAborted();
    if (this.#receivers.has(waitId)) throw new Error('Event wait already has a live receiver');
    let receiver!: Receiver;
    const result = new Promise<EventWaitToolResult>((resolve, reject) => {
      receiver = { context, resolve, reject, delivering: false, settled: false };
    });
    this.#receivers.set(waitId, receiver);
    const abort = () => {
      receiver.reject(context.abortSignal.reason ?? new Error('Event wait execution cancelled'));
      receiver.settled = true;
      void this.#options.observer
        .cancel(identity, 'execution_cancelled')
        .catch(this.#options.onError);
    };
    context.abortSignal.addEventListener('abort', abort, { once: true });
    if (context.abortSignal.aborted) abort();
    try {
      const beginDelivery = async () => {
        if (steering.interrupted) await this.#options.observer.cancel(identity, 'user_input');
        else
          void steering.ready
            .then(async (interrupted) => {
              if (!interrupted || receiver.settled || this.#receivers.get(waitId) !== receiver)
                return;
              await this.#options.observer.cancel(identity, 'user_input');
              await this.#deliver(waitId, receiver);
            })
            .catch(this.#options.onError);
        void this.#deliver(waitId, receiver).catch(this.#options.onError);
        void this.#options.observer.reconcile().catch(this.#options.onError);
      };
      void beginDelivery().catch((error: unknown) => {
        receiver.settled = true;
        receiver.reject(error);
      });
      return await result;
    } finally {
      context.abortSignal.removeEventListener('abort', abort);
      if (this.#receivers.get(waitId) === receiver) this.#receivers.delete(waitId);
    }
  }

  changed(wait: AnyEventWaitRecord): void {
    if (wait.schemaVersion !== 2 || wait.consumer.kind !== 'tool_invocation') return;
    const receiver = this.#receivers.get(wait.waitId);
    if (receiver) void this.#deliver(wait.waitId, receiver).catch(this.#options.onError);
  }

  /** Client authority is checked by the operation handler; this proves the exact target. */
  async cancel(target: InvocationEventWaitTarget): Promise<boolean> {
    const identity = { sessionId: target.sessionId, waitId: target.waitId };
    const snapshot = await this.#options.stores.eventWaitStore.readAny(identity);
    const wait = snapshot?.record;
    if (!wait || wait.schemaVersion !== 2 || wait.consumer.kind !== 'tool_invocation') return false;
    const consumer = wait.consumer;
    if (
      consumer.runId !== target.runId ||
      consumer.invocationId !== target.invocationId ||
      consumer.operationId !== target.operationId ||
      wait.delivery
    )
      return false;
    await this.#options.observer.cancel(identity, 'user_cancelled');
    const receiver = this.#receivers.get(wait.waitId);
    if (receiver) await this.#deliver(wait.waitId, receiver);
    // Expiry or durable consumption can win after the initial target check.
    const current = await this.#options.stores.eventWaitStore.readAny(identity);
    return current?.record.status === 'cancelled' && current.record.reason === 'user_cancelled';
  }

  async #deliver(waitId: string, receiver: Receiver): Promise<void> {
    if (receiver.delivering || receiver.settled || this.#closed) return;
    receiver.delivering = true;
    try {
      const snapshot = await this.#options.stores.eventWaitStore.readAny({
        sessionId: receiver.context.sessionId,
        waitId,
      });
      const wait = snapshot?.record;
      if (
        !wait ||
        wait.schemaVersion !== 2 ||
        wait.consumer.kind !== 'tool_invocation' ||
        wait.status === 'waiting' ||
        wait.delivery
      )
        return;
      if (wait.status === 'resolved') {
        const access = await this.#options.observer.checkSourceAccess(
          wait,
          receiver.context.abortSignal,
          (record, signal) => this.authorizeObservation(record, signal),
        );
        if (access.kind === 'unknown') return;
        if (access.kind === 'revoked') {
          await this.#options.observer.cancel({ sessionId: wait.sessionId, waitId }, access.reason);
          return;
        }
      }
      // A cancellation can race source authorization; only the current durable result wins.
      const current = await this.#options.stores.eventWaitStore.readAny({
        sessionId: wait.sessionId,
        waitId,
      });
      if (!current || current.authorityRevision !== snapshot.authorityRevision) return;
      if (receiver.settled || receiver.context.abortSignal.aborted) return;
      receiver.settled = true;
      receiver.resolve(this.#result(wait));
    } finally {
      receiver.delivering = false;
    }
  }

  #result(wait: ConsumerEventWaitRecord): EventWaitToolResult {
    if (wait.status === 'waiting') throw new Error('Event wait is still pending');
    return {
      kind: 'event_wait_result',
      waitId: wait.waitId,
      deadlineAt: wait.deadlineAt,
      outcome:
        wait.status === 'resolved'
          ? wait.resolution.outcome
          : wait.status === 'cancelled' && wait.reason === 'user_input'
            ? 'interrupted'
            : wait.status,
      observedAt:
        wait.status === 'resolved'
          ? wait.resolution.observedAt
          : wait.status === 'expired'
            ? wait.expiredAt
            : wait.cancelledAt,
      evidenceRefs: wait.status === 'resolved' ? wait.resolution.evidenceRefs : [],
      ...(wait.status === 'cancelled' ? { reason: wait.reason } : {}),
    };
  }

  #notifyChanged(sessionId: string): void {
    try {
      this.#options.onChanged?.(sessionId);
    } catch (error) {
      this.#options.onError(error);
    }
  }

  async acknowledge(outcome: MakaToolDurableOutcome): Promise<void> {
    const waitId = waitIdentity(outcome.sessionId, outcome.operationId);
    try {
      if (outcome.isError)
        await this.#options.stores.eventWaitStore.retireInvocationWait({
          sessionId: outcome.sessionId,
          waitId,
          operationId: outcome.operationId,
          reason: 'tool_failed',
          at: this.#clock.now(),
        });
      else
        await this.#options.stores.eventWaitStore.acknowledgeInvocationWaitResult({
          sessionId: outcome.sessionId,
          waitId,
          operationId: outcome.operationId,
          resultEventId: outcome.resultEventId,
          at: this.#clock.now(),
        });
      this.#notifyChanged(outcome.sessionId);
    } catch (error) {
      this.#options.onError(error);
    }
  }

  /** Only start after Runtime recovery has reconstructed and closed interrupted invocations. */
  async start(): Promise<void> {
    if (this.#closed || this.#ready) return;
    this.#ready = true;
    await this.reconcile();
    this.#schedule();
  }
  #schedule(): void {
    if (this.#closed) return;
    this.#timer = this.#clock.schedule(() => {
      void this.reconcile()
        .catch(this.#options.onError)
        .finally(() => this.#schedule());
    }, 1_000);
  }
  reconcile(): Promise<void> {
    if (this.#closed || !this.#ready) return Promise.resolve();
    return (this.#scan ??= this.#reconcile().finally(() => {
      this.#scan = undefined;
    }));
  }
  async #reconcile(): Promise<void> {
    const page = await this.#options.stores.eventWaitStore.listAny({
      limit: 64,
      consumerKind: 'tool_invocation',
      deliveryOutstanding: true,
      ...(this.#cursor ? { afterWaitId: this.#cursor } : {}),
    });
    for (const snapshot of page.items) {
      if (this.#closed) return;
      const wait = snapshot.record;
      if (wait.schemaVersion !== 2 || wait.consumer.kind !== 'tool_invocation') continue;
      const consumer = wait.consumer;
      try {
        const proof = await this.#options.stores.runtimeEventStore.readToolProvenanceEvents(
          wait.sessionId,
          consumer.runId,
          consumer.toolCallId,
          { maxRecords: 64, maxBytes: 1_048_576 },
        );
        if (proof.status !== 'complete')
          throw new Error('Event wait tool proof exceeded its bound');
        const result = proof.records.find(
          (event) =>
            event.invocationId === consumer.invocationId &&
            event.refs?.operationId === consumer.operationId &&
            event.content?.kind === 'function_response',
        );
        if (result) {
          if (result.content?.kind === 'function_response' && result.content.isError === true)
            await this.#options.stores.eventWaitStore.retireInvocationWait({
              sessionId: wait.sessionId,
              waitId: wait.waitId,
              operationId: consumer.operationId,
              reason: 'tool_failed',
              at: this.#clock.now(),
            });
          else
            await this.#options.stores.eventWaitStore.acknowledgeInvocationWaitResult({
              sessionId: wait.sessionId,
              waitId: wait.waitId,
              operationId: consumer.operationId,
              resultEventId: result.id,
              at: this.#clock.now(),
            });
          this.#notifyChanged(wait.sessionId);
          continue;
        }
        const invocation = await this.#options.stores.runtimeEventStore.readRunInvocation(
          wait.sessionId,
          consumer.runId,
        );
        if (invocation?.terminalEvent) {
          await this.#options.stores.eventWaitStore.retireInvocationWait({
            sessionId: wait.sessionId,
            waitId: wait.waitId,
            operationId: consumer.operationId,
            reason: 'execution_ended',
            at: this.#clock.now(),
          });
          this.#notifyChanged(wait.sessionId);
        } else {
          const receiver = this.#receivers.get(wait.waitId);
          if (receiver) await this.#deliver(wait.waitId, receiver);
        }
      } catch (error) {
        this.#options.onError(error);
      }
    }
    this.#cursor = page.nextCursor ?? undefined;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    this.#timer?.();
    for (const receiver of this.#receivers.values()) {
      receiver.settled = true;
      receiver.reject(new Error('Host stopped during event wait'));
    }
    this.#receivers.clear();
    this.#runs.clear();
    await this.#scan;
  }
}
