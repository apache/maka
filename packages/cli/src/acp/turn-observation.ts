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

import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { TurnSnapshot } from '@maka/runtime-host/protocol';
import type { RequestError, SessionNotification, StopReason } from '@agentclientprotocol/sdk';
import { RuntimeHostRequestInterruptedError } from '@maka/runtime-host/client';
import type { RuntimeHostTerminalTurn } from '@maka/runtime-host/adapter';
import { RuntimeHostSessionChannel } from '../runtime-host-session-channel.js';
import { AcpSessionEventMapper } from './session-event-mapper.js';

/** One consumer for a Host Turn, shared by prompt admission and resumed attachments. */
export class AcpTurnObservation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly mapper: AcpSessionEventMapper;
  readonly deliveredTextByMessage = new Map<string, string>();
  readonly projectionAbort = new AbortController();
  readonly reconciliationAbort = new AbortController();
  attachment?: RuntimeHostSessionChannel;
  transcript?: ReturnType<RuntimeHostSessionChannel['trackPromptTranscript']>;
  projectionFailure?: unknown;
  terminalTurn?: RuntimeHostTerminalTurn;
  terminalOutcome?: { status: 'completed' | 'failed' | 'cancelled'; failureClass?: string };
  /** Keep the Host transport alive until a requested Stop has settled. */
  stopTask?: Promise<void>;
  cancelled = false;
  finished = false;
  #muteDepth = 0;
  #liveGate?: { promise: Promise<void>; release(): void };

  constructor(options: {
    sessionId: string;
    turnId: string;
    runId?: string;
    notify: ConstructorParameters<typeof AcpSessionEventMapper>[0]['notify'];
  }) {
    this.sessionId = options.sessionId;
    this.turnId = options.turnId;
    this.runId = options.runId;
    this.mapper = new AcpSessionEventMapper({
      sessionId: options.sessionId,
      notify: async (notification) => {
        if (this.#muteDepth === 0) await options.notify(notification);
      },
      signal: this.projectionAbort.signal,
    });
  }

  async seed(messages: readonly StoredMessage[]): Promise<void> {
    this.#muteDepth += 1;
    try {
      await this.mapper.acceptTranscriptMessages(this.turnId, messages, true);
      await this.mapper.flush();
    } finally {
      this.#muteDepth -= 1;
    }
  }

  recordDeliveredText(notification: SessionNotification): string | undefined {
    const update = notification.update;
    if (
      update.sessionUpdate !== 'agent_message_chunk' &&
      update.sessionUpdate !== 'agent_thought_chunk'
    )
      return;
    if (update.content.type !== 'text' || !update.messageId) return;
    const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking';
    const prefix = this.mapper.textForMessage(kind, update.messageId);
    const key = `${update.sessionUpdate}:${update.messageId}`;
    const previous = this.deliveredTextByMessage.get(key) ?? '';
    // A resumed mapper may have silently seeded older text. Only a prefix
    // actually sent to this client can suppress historical replay.
    if (prefix !== previous + update.content.text) return;
    this.deliveredTextByMessage.set(key, prefix);
    return prefix;
  }

  holdLive(): Promise<void> {
    if (!this.#liveGate) {
      let release!: () => void;
      this.#liveGate = {
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
        release,
      };
    }
    return this.mapper.flush();
  }

  releaseLive(): void {
    const gate = this.#liveGate;
    this.#liveGate = undefined;
    gate?.release();
  }

  async #waitForLive(): Promise<void> {
    while (this.#liveGate && !this.finished) await this.#liveGate.promise;
  }

  async pendingInteraction(
    pending: Parameters<AcpSessionEventMapper['pendingInteraction']>[0],
  ): Promise<void> {
    await this.#waitForLive();
    if (!this.finished) await this.mapper.pendingInteraction(pending);
  }

  async resolvedInteraction(
    resolved: Parameters<AcpSessionEventMapper['resolvedInteraction']>[0],
    pending: Parameters<AcpSessionEventMapper['resolvedInteraction']>[1],
  ): Promise<void> {
    await this.#waitForLive();
    if (!this.finished) await this.mapper.resolvedInteraction(resolved, pending);
  }

  async replaceTranscript(messages: readonly StoredMessage[]): Promise<void> {
    await this.#waitForLive();
    if (!this.finished) await this.mapper.replaceTranscript(this.turnId, messages);
  }

  start(channel: RuntimeHostSessionChannel): Promise<StopReason> {
    this.attachment = channel;
    this.transcript = channel.trackPromptTranscript(this.turnId);
    const task = this.consume(channel.eventsForTurn(this.turnId));
    void task.catch(() => undefined);
    return task;
  }

  async consume(events: AsyncIterable<SessionEvent>): Promise<StopReason> {
    let terminalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    try {
      for await (const event of events) {
        await this.#waitForLive();
        if (event.type === 'abort') {
          terminalStatus = 'cancelled';
          this.terminalOutcome = { status: 'cancelled' };
        } else if (event.type === 'error' && !event.recoverable) {
          terminalStatus = 'failed';
          this.terminalOutcome = { status: 'failed', failureClass: event.reason };
        } else if (event.type === 'complete') {
          this.terminalOutcome = { status: 'completed' };
        }
        if (terminalStatus !== 'completed') this.reconciliationAbort.abort();
        if (!this.cancelled) await this.mapper.accept(event);
      }
      if (this.cancelled) return this.cancelledStopReason();
      if (terminalStatus === 'completed') await this.reconcile(true);
      else this.reconciliationAbort.abort();
      if (this.projectionFailure) throw this.projectionFailure;
      await this.mapper.finishTools(this.turnId, terminalStatus);
      await this.mapper.flush();
      return this.cancelled ? this.cancelledStopReason() : 'end_turn';
    } catch (error) {
      if (this.cancelled) return this.cancelledStopReason();
      throw error;
    }
  }

  async reconcile(replay = false): Promise<void> {
    await this.#waitForLive();
    if (this.cancelled || this.finished || !this.transcript) return;
    try {
      await this.transcript.reconcile(
        (messages) => this.mapper.acceptTranscriptMessages(this.turnId, messages),
        AbortSignal.any([this.projectionAbort.signal, this.reconciliationAbort.signal]),
        { replay },
      );
    } catch (error) {
      if (
        this.cancelled ||
        this.finished ||
        this.projectionAbort.signal.aborted ||
        this.reconciliationAbort.signal.aborted
      )
        return;
      this.projectionFailure ??= error;
      this.attachment?.failTurn(this.turnId, error);
      throw error;
    }
  }

  async cancelledStopReason(): Promise<'cancelled'> {
    await this.mapper.flush().catch(() => undefined);
    return 'cancelled';
  }

  dispose(): void {
    this.finished = true;
    this.releaseLive();
    this.projectionAbort.abort();
    this.reconciliationAbort.abort();
    this.transcript?.dispose();
  }
}

/** Admission bookkeeping exists only for Turns this connection dispatches. */
export class AcpAdmittedTurnObservation extends AcpTurnObservation {
  readonly admission: {
    readonly waiters: Set<() => void>;
    dispatchStarted: boolean;
    startRequestSettled: boolean;
    settled: boolean;
    rejected?: boolean;
    query?: Promise<void>;
    failure?: RequestError;
    startedTurn?: TurnSnapshot;
  } = {
    waiters: new Set(),
    dispatchStarted: false,
    startRequestSettled: false,
    settled: false,
  };

  markDispatched(): void {
    this.admission.dispatchStarted = true;
    this.wake();
  }

  settleStartRequest(turn?: TurnSnapshot): void {
    this.admission.startRequestSettled = true;
    this.admission.settled = true;
    if (turn) this.admission.startedTurn = turn;
    this.wake();
  }

  failStartRequest(error: unknown): void {
    this.admission.startRequestSettled = true;
    this.admission.settled ||= !(
      this.admission.dispatchStarted &&
      error instanceof RuntimeHostRequestInterruptedError &&
      error.dispatch === 'dispatched'
    );
    this.wake();
  }

  observeStartedTurn(turn: TurnSnapshot): void {
    this.admission.startedTurn ??= turn;
    this.admission.settled = true;
    this.wake();
  }

  settleAbsentTurn(observed?: TurnSnapshot): void {
    if (observed) this.admission.startedTurn ??= observed;
    else if (!this.admission.startedTurn) this.admission.rejected = true;
    this.admission.settled = true;
    this.wake();
  }

  failAdmission(error: RequestError): void {
    this.admission.failure = error;
    this.wake();
  }

  settleOnClose(): void {
    this.admission.settled = true;
    this.wake();
  }

  wake(): void {
    for (const resolve of this.admission.waiters) resolve();
    this.admission.waiters.clear();
  }

  waitForChange(timeoutMs?: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.admission.waiters.delete(wake);
        resolve();
      };
      this.admission.waiters.add(wake);
      if (timeoutMs !== undefined) timer = setTimeout(wake, timeoutMs);
    });
  }
}
