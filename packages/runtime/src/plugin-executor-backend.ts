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

import { createHash, randomUUID } from 'node:crypto';
import type { SessionEvent } from '@maka/core/events';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { AsyncEventQueue } from './async-queue.js';
import type { PluginExecutorResult, PluginExecutorService } from './plugin-executor-service.js';

interface ActiveExecution {
  readonly abort: AbortController;
  readonly settled: Promise<void>;
}

export interface PluginExecutorBackendInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly executorId: string;
  readonly instructions?: string;
  readonly service: PluginExecutorService;
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** Converts a small plugin executor contract into Maka's existing Run event stream. */
export class PluginExecutorBackend implements AgentBackend {
  readonly kind = 'plugin-executor' as const;
  readonly sessionId: string;
  readonly #cwd: string;
  readonly #executorId: string;
  readonly #instructions?: string;
  readonly #service: PluginExecutorService;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #active = new Set<ActiveExecution>();
  #disposed = false;

  constructor(input: PluginExecutorBackendInput) {
    this.sessionId = input.sessionId;
    this.#cwd = input.cwd;
    this.#executorId = input.executorId;
    this.#instructions = input.instructions;
    this.#service = input.service;
    this.#newId = input.newId ?? randomUUID;
    this.#now = input.now ?? Date.now;
  }

  providerStateIdentity(): `sha256:${string}` {
    const identity = this.#service.identity(this.sessionId, this.#executorId);
    return `sha256:${createHash('sha256')
      .update(
        JSON.stringify([
          'plugin-executor.v1',
          identity.id,
          identity.extensionId,
          identity.entryId,
          identity.generation,
        ]),
      )
      .digest('hex')}`;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.#disposed) throw new Error('Plugin executor backend is disposed');
    const abort = new AbortController();
    const queue = new AsyncEventQueue<SessionEvent>();
    const messageId = this.#newId();
    const producer = this.#produce(input, messageId, abort.signal, queue).finally(() =>
      queue.close(),
    );
    const active: ActiveExecution = { abort, settled: producer };
    this.#active.add(active);
    try {
      for await (const event of queue) {
        yield event;
        queue.ackConsumed();
      }
      await producer;
    } finally {
      queue.noteConsumerDetached();
      abort.abort(new Error('Plugin executor event consumer detached'));
      await producer.catch(() => undefined);
      this.#active.delete(active);
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    const active = [...this.#active];
    for (const execution of active) execution.abort.abort(new Error(reason));
    await Promise.allSettled(active.map((execution) => execution.settled));
  }

  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {
    throw new Error('Plugin executor does not expose Maka sandbox-boundary requests');
  }

  async respondToUserQuestion(_response: UserQuestionResponse): Promise<void> {
    throw new Error('Plugin executor does not expose Maka user-question requests');
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.stop('user_stop');
  }

  async #produce(
    input: BackendSendInput,
    messageId: string,
    signal: AbortSignal,
    queue: AsyncEventQueue<SessionEvent>,
  ): Promise<void> {
    const turnId = input.turnId;
    try {
      const result = await this.#service.execute(
        this.#executorId,
        {
          sessionId: this.sessionId,
          turnId,
          ...(input.runId ? { runId: input.runId } : {}),
          conversationKey: this.sessionId,
          text: input.text,
          cwd: this.#cwd,
          ...(this.#instructions ? { instructions: this.#instructions } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.directoryReferences ? { directoryReferences: input.directoryReferences } : {}),
          ...(input.quotes ? { quotes: input.quotes } : {}),
        },
        {
          signal,
          onEvent: (event) => {
            if (!event.text) return;
            queue.push({
              type: 'text_delta',
              id: this.#newId(),
              turnId,
              ts: this.#now(),
              messageId,
              text: event.text,
            });
          },
        },
      );
      this.#publishResult(turnId, messageId, result, queue);
    } catch (error) {
      if (signal.aborted) {
        this.#publishCancellation(turnId, queue);
        return;
      }
      this.#publishFailure(
        turnId,
        error instanceof Error ? error.message : 'External executor failed',
        undefined,
        false,
        queue,
      );
    }
  }

  #publishResult(
    turnId: string,
    messageId: string,
    result: PluginExecutorResult,
    queue: AsyncEventQueue<SessionEvent>,
  ): void {
    if (result.status === 'completed') {
      queue.push({
        type: 'text_complete',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        messageId,
        text: result.text,
      });
      queue.push({
        type: 'complete',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        stopReason: 'end_turn',
      });
      return;
    }
    if (result.status === 'cancelled') {
      this.#publishCancellation(turnId, queue);
      return;
    }
    this.#publishFailure(turnId, result.message, result.code, result.recoverable ?? false, queue);
  }

  #publishCancellation(turnId: string, queue: AsyncEventQueue<SessionEvent>): void {
    queue.push({
      type: 'abort',
      id: this.#newId(),
      turnId,
      ts: this.#now(),
      reason: 'user_stop',
    });
    queue.push({
      type: 'complete',
      id: this.#newId(),
      turnId,
      ts: this.#now(),
      stopReason: 'user_stop',
    });
  }

  #publishFailure(
    turnId: string,
    message: string,
    code: string | undefined,
    recoverable: boolean,
    queue: AsyncEventQueue<SessionEvent>,
  ): void {
    queue.push({
      type: 'error',
      id: this.#newId(),
      turnId,
      ts: this.#now(),
      recoverable,
      ...(code ? { code, reason: code } : {}),
      message: boundedMessage(message),
    });
    queue.push({
      type: 'complete',
      id: this.#newId(),
      turnId,
      ts: this.#now(),
      stopReason: 'error',
    });
  }
}

function boundedMessage(value: string): string {
  if (value.length <= 8_192) return value;
  return `${value.slice(0, 8_191)}…`;
}
