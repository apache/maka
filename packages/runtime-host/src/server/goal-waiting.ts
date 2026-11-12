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
import {
  decodeConsumerEventWaitRecord,
  eventWaitDeliveryKey,
  type ConsumerEventWaitRecord,
  type EventWaitConditionSpec,
} from '@maka/core/event-wait';
import {
  sameGoalControlLease,
  type GoalCheckpoint,
  type GoalControlLease,
  type GoalPendingContinuation,
  type GoalWaitingContinuation,
  type GoalWaitingObservation,
} from '@maka/core/goal';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { GoalAuthoritySnapshot } from '@maka/storage/goal-authority';
import { eventWaitResultDigest } from '@maka/storage/event-wait-bridge';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import type { HostEventWaitSources } from './event-wait-sources.js';
import type { HostEventWaitObserver } from './event-wait-manager.js';
import type { EventWaitObservationAccess } from './event-wait-adapter.js';

interface GoalWaitingPort {
  readonly stores: Pick<
    ExecutionStoresWriter<'interactive'>,
    'eventWaitStore' | 'runtimeEventStore' | 'agentRunStore'
  >;
  readonly authority: (sessionId: string) => GoalAuthoritySnapshot | undefined;
  readonly authorities: () => Iterable<GoalAuthoritySnapshot>;
  /** Atomically wake the exact waiting checkpoint and retain its outbox identity. */
  readonly ready: (wait: ConsumerEventWaitRecord) => Promise<GoalPendingContinuation | undefined>;
  /** Persist a validated outbox before registration, or restore the explicit fallback. */
  readonly finishPreparation: (
    wait: ConsumerEventWaitRecord,
    result: { observation: GoalWaitingObservation } | { reason: string },
  ) => Promise<GoalPendingContinuation | undefined>;
  readonly deliver: (pending: GoalPendingContinuation) => void;
  readonly onError: (error: unknown) => void;
  readonly now: () => number;
}

/** Replaces only a naturally completed Goal's waiting timer. It never owns a running tool. */
export class HostGoalWaitingCoordinator {
  readonly #abort = new AbortController();
  #scan?: Promise<void>;
  #timer?: () => void;
  #ready = false;
  #closed = false;
  readonly #preparations = new Map<string, { abort: AbortController; task: Promise<void> }>();

  constructor(
    readonly port: GoalWaitingPort,
    readonly sources: HostEventWaitSources,
    readonly observer: HostEventWaitObserver,
  ) {}

  async prepare(input: {
    sessionId: string;
    turnId: string;
    checkpoint: GoalCheckpoint;
    controlLease: GoalControlLease;
    condition: EventWaitConditionSpec;
    signal: AbortSignal;
  }): Promise<
    { observation: GoalWaitingObservation; observationPreparation?: 'pending' } | { reason: string }
  > {
    const admission = await this.port.stores.agentRunStore.readRootTurnAdmission(
      input.sessionId,
      input.turnId,
    );
    if (!admission) return { reason: 'the source Turn has no admitted execution' };
    const logical = await readLogicalRuntimeExecution(
      this.port.stores.runtimeEventStore,
      admission,
    );
    const terminal = logical?.tip.terminalEvent;
    if (!terminal || terminal.status !== 'completed')
      return { reason: 'the source Turn has no natural completion' };
    const waitId = `goal_wait_${createHash('sha256')
      .update(JSON.stringify([input.sessionId, input.turnId, input.controlLease]))
      .digest('hex')}`;
    const observation: GoalWaitingObservation = {
      ...input.condition,
      waitId,
      sourceRunId: logical!.tip.runId,
      completionEventId: terminal.id,
    };
    // Expiry contains no source data and skips source validation.
    if (observation.deadlineAt !== null && observation.deadlineAt <= this.port.now())
      return { observation, observationPreparation: 'pending' };
    const record = this.#record(
      input.sessionId,
      input.turnId,
      input.controlLease,
      input.checkpoint.revision + 1,
      observation,
      terminal.ts,
    );
    if (!this.sources.adapters.get(record))
      return { reason: 'the source or deterministic condition is unsupported' };
    input.signal.throwIfAborted();
    if (this.#closed) return { reason: 'Host is closing' };
    // Source I/O starts only from the durable outbox. It must never retain the
    // completed Turn's settlement promise or Root admission ownership.
    return { observation, observationPreparation: 'pending' };
  }

  authorizeObservation(
    wait: ConsumerEventWaitRecord,
    signal: AbortSignal,
  ): Promise<EventWaitObservationAccess> {
    // Host shutdown preserves the outbox; it does not revoke its business owner.
    if (this.#closed || signal.aborted)
      return Promise.resolve({ kind: 'unknown', reason: 'host_stopping' });
    if (!this.#owns(wait))
      return Promise.resolve({ kind: 'revoked', reason: 'goal_waiting_superseded' });
    return this.sources.authorize(wait, signal);
  }

  preflightAdmission(
    sessionId: string,
    continuation: GoalWaitingContinuation,
  ): Promise<boolean | 'defer'> {
    return this.authorizeAdmission(sessionId, continuation);
  }

  async authorizeAdmission(
    sessionId: string,
    continuation: GoalWaitingContinuation,
  ): Promise<boolean | 'defer'> {
    const record = await this.#readAdmissionWait(sessionId, continuation);
    if (record === false || record === 'defer') return record;
    if (record.status === 'cancelled' || record.status === 'expired') return true; // Diagnostics contain no source data.
    const access = await this.observer.checkSourceAccess(
      record,
      this.#abort.signal,
      (wait, signal) => this.sources.authorize(wait, signal),
    );
    // Source I/O can overlap a legitimate cancellation. Revalidate both ownership
    // and the exact result before interpreting that request's authorization.
    const latest = await this.#readAdmissionWait(sessionId, continuation);
    if (latest === false || latest === 'defer') return latest;
    if (access.kind === 'unknown') return 'defer';
    if (access.kind === 'revoked') {
      await this.cancel(sessionId, record.waitId, 'source_access_revoked');
      return 'defer';
    }
    return true;
  }

  async #readAdmissionWait(
    sessionId: string,
    continuation: GoalWaitingContinuation,
  ): Promise<ConsumerEventWaitRecord | false | 'defer'> {
    const snapshot = await this.port.stores.eventWaitStore.readAny({
      sessionId,
      waitId: continuation.waitId,
    });
    const record = snapshot?.record;
    if (
      !record ||
      record.schemaVersion !== 2 ||
      record.consumer.kind !== 'goal_waiting' ||
      record.delivery ||
      !this.#owns(record) ||
      record.status === 'waiting' ||
      this.port.authority(sessionId)?.record.pendingContinuation?.goalWaiting?.execution.turnId !==
        continuation.execution.turnId
    )
      return false;
    // The same outbox may now carry a cancelled result. Release this unadmitted
    // attempt so reconciliation can retry its frozen identity with the new digest;
    // settling it as a failed work Turn would pause and retire valid pending work.
    if (eventWaitResultDigest(record) !== continuation.resultDigest) return 'defer';
    return record;
  }

  async cancel(sessionId: string, waitId: string, reason = 'cancelled_by_user'): Promise<boolean> {
    const snapshot = await this.port.stores.eventWaitStore.readAny({ sessionId, waitId });
    const record = snapshot?.record;
    if (
      !snapshot ||
      !record ||
      record.schemaVersion !== 2 ||
      record.consumer.kind !== 'goal_waiting' ||
      record.delivery ||
      record.status === 'expired' ||
      !this.#owns(record)
    )
      return false;
    if (record.status !== 'cancelled') {
      const at = Math.max(this.port.now(), record.updatedAt);
      const { status: _status, ...base } = record;
      // Lifecycle-specific fields are removed; prior resolution remains historical evidence only.
      const next = decodeConsumerEventWaitRecord({
        ...Object.fromEntries(
          Object.entries(base).filter(
            ([key]) => !['resolvedAt', 'resolution', 'expiredAt'].includes(key),
          ),
        ),
        updatedAt: at,
        status: 'cancelled',
        cancelledAt: at,
        reason,
        ...(record.status === 'resolved'
          ? { priorResolution: { resolvedAt: record.resolvedAt, resolution: record.resolution } }
          : {}),
      });
      const result = await this.port.stores.eventWaitStore.commitAny({
        sessionId,
        waitId,
        expectedAuthorityRevision: snapshot.authorityRevision,
        record: next,
      });
      if (result.kind !== 'committed') return false;
    }
    void this.reconcile().catch(this.port.onError);
    return true;
  }

  async start(): Promise<void> {
    this.#ready = true;
    await this.reconcile();
  }

  reconcile(): Promise<void> {
    if (this.#closed || !this.#ready) return Promise.resolve();
    if (this.#scan) return this.#scan;
    const task = this.#reconcile();
    this.#scan = task;
    void task
      .finally(() => {
        this.#scan = undefined;
        this.#schedule();
      })
      .catch(this.port.onError);
    return task;
  }

  async #reconcile(): Promise<void> {
    for (const [waitId, preparation] of this.#preparations) {
      const owned = [...this.port.authorities()].some(
        ({ record }) =>
          record.pendingContinuation?.observation?.waitId === waitId &&
          ['active', 'waiting'].includes(record.goal.status),
      );
      if (!owned) preparation.abort.abort();
    }
    for (const authority of this.port.authorities()) {
      if (this.#closed) return;
      const pending = authority.record.pendingContinuation;
      const observation = pending?.observation;
      if (!pending || !observation || !pending.triggeringTurnId) continue;
      const sessionId = authority.record.goal.sessionId;
      // Goal authority is adopted in memory before its durable write receipt.
      // The preparation task retains this fence until that receipt completes.
      if (this.#preparations.has(observation.waitId)) continue;
      if (pending.observationPreparation === 'pending') {
        this.#startPreparation(sessionId, pending);
        continue;
      }
      let snapshot = await this.port.stores.eventWaitStore.readAny({
        sessionId,
        waitId: observation.waitId,
      });
      if (!snapshot) {
        const invocation = await this.port.stores.runtimeEventStore.readRunInvocation(
          sessionId,
          observation.sourceRunId,
        );
        if (!invocation?.terminalEvent) throw new Error('Goal waiting lost its completion fact');
        const record = this.#record(
          sessionId,
          pending.triggeringTurnId,
          pending.controlLease,
          pending.checkpoint.revision,
          observation,
          invocation.terminalEvent.ts,
        );
        try {
          snapshot = await this.port.stores.eventWaitStore.registerGoalWaitingWait({ record });
        } catch (error) {
          // A newer real Turn/control mutation can supersede this pending continuation during I/O.
          if (!this.#owns(record)) continue;
          throw error;
        }
        void this.observer.reconcile().catch(this.port.onError);
      }
      const wait = snapshot.record;
      if (
        wait.schemaVersion !== 2 ||
        wait.consumer.kind !== 'goal_waiting' ||
        wait.delivery ||
        !this.#owns(wait)
      )
        continue;
      if (wait.status === 'waiting') continue;
      if (wait.status === 'resolved') {
        const access = await this.observer.checkSourceAccess(
          wait,
          this.#abort.signal,
          (record, signal) => this.sources.authorize(record, signal),
        );
        if (access.kind === 'unknown') continue;
        if (access.kind === 'revoked') {
          await this.cancel(sessionId, wait.waitId, 'source_access_revoked');
          continue;
        }
      }
      if (this.#closed || !this.#owns(wait)) continue;
      const ready = await this.port.ready(wait);
      if (ready) this.port.deliver(ready);
    }
  }

  #startPreparation(sessionId: string, pending: GoalPendingContinuation): void {
    const observation = pending.observation!;
    if (this.#preparations.has(observation.waitId)) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.#abort.signal]);
    let prepared = false;
    const task = this.#prepareOutbox(sessionId, pending, signal)
      .then((settled) => {
        prepared = settled;
      })
      .catch((error) => {
        if (!signal.aborted && !this.#closed) this.port.onError(error);
      })
      .finally(() => {
        if (this.#preparations.get(observation.waitId)?.abort === abort)
          this.#preparations.delete(observation.waitId);
        // Unknown access retains the raw outbox. The existing scan timer retries
        // it without spinning when capacity or the source remains unavailable.
        if (prepared && !this.#closed) void this.reconcile().catch(this.port.onError);
      });
    this.#preparations.set(observation.waitId, { abort, task });
  }

  async #prepareOutbox(
    sessionId: string,
    pending: GoalPendingContinuation,
    signal: AbortSignal,
  ): Promise<boolean> {
    const observation = pending.observation!;
    const invocation = await this.port.stores.runtimeEventStore.readRunInvocation(
      sessionId,
      observation.sourceRunId,
    );
    if (!invocation?.terminalEvent) throw new Error('Goal waiting lost its completion fact');
    const original = this.#record(
      sessionId,
      pending.triggeringTurnId!,
      pending.controlLease,
      pending.checkpoint.revision,
      observation,
      invocation.terminalEvent.ts,
    );
    if (!this.#owns(original)) return false;
    const expired = () => original.deadlineAt !== null && original.deadlineAt <= this.port.now();
    let failure: string | undefined;
    try {
      if (!expired()) this.sources.adapters.validate(original);
    } catch {
      failure = 'the source or deterministic condition is unsupported';
    }
    if (!failure && !expired()) {
      const access = await this.observer.checkSourceAccess(original, signal, (wait, signal) =>
        this.sources.authorize(wait, signal),
      );
      // Only a valid initial source establishes observation. Later revocation
      // remains a terminal observation result; initial rejection uses backoff.
      if (!expired()) {
        if (access.kind === 'unknown') return false;
        if (access.kind === 'revoked') failure = access.reason;
      }
    }
    if (signal.aborted || !this.#owns(original)) return false;
    const settled = await this.port.finishPreparation(
      original,
      failure
        ? { reason: failure }
        : {
            observation,
          },
    );
    // The outbox is durable before registration, including after restart.
    if (settled && failure) this.port.deliver(settled);
    return !!settled;
  }

  #owns(wait: ConsumerEventWaitRecord): boolean {
    if (this.#closed || wait.consumer.kind !== 'goal_waiting') return false;
    const current = this.port.authority(wait.sessionId)?.record;
    const pending = current?.pendingContinuation;
    return (
      !!current &&
      ['active', 'waiting'].includes(current.goal.status) &&
      sameGoalControlLease(current.controlLease, wait.consumer.goalControlLease) &&
      pending?.observation?.waitId === wait.waitId &&
      pending.triggeringTurnId === wait.sourceTurnId
    );
  }

  #record(
    sessionId: string,
    turnId: string,
    controlLease: GoalControlLease,
    revision: number,
    observation: GoalWaitingObservation,
    createdAt: number,
  ): ConsumerEventWaitRecord {
    return decodeConsumerEventWaitRecord({
      schemaVersion: 2,
      waitId: observation.waitId,
      sessionId,
      sourceTurnId: turnId,
      consumer: {
        kind: 'goal_waiting',
        sourceRunId: observation.sourceRunId,
        completionEventId: observation.completionEventId,
        goalControlLease: controlLease,
        goalRevision: revision,
      },
      resource: observation.resource,
      condition: observation.condition,
      deadlineAt: observation.deadlineAt,
      deliveryKey: eventWaitDeliveryKey(observation.waitId),
      createdAt,
      updatedAt: createdAt,
      status: 'waiting',
    });
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return;
    const callback = () => {
      this.#timer = undefined;
      void this.reconcile().catch(this.port.onError);
    };
    if (this.sources.clock) this.#timer = this.sources.clock.schedule(callback, 1_000);
    else {
      const timer = setTimeout(callback, 1_000);
      timer.unref();
      this.#timer = () => clearTimeout(timer);
    }
  }

  beginDrain(): void {
    this.#closed = true;
    this.#abort.abort();
    for (const preparation of this.#preparations.values()) preparation.abort.abort();
    this.#timer?.();
    this.#timer = undefined;
  }
  async close(): Promise<void> {
    this.beginDrain();
    await this.#scan;
    await Promise.all([...this.#preparations.values()].map(({ task }) => task));
  }
}
