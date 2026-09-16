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
import type { SessionEvent } from '@maka/core/events';
import type {
  AgentBackend,
  BackendSendInput,
  HostedFormSettlement,
} from '@maka/core/backend-types';
import type { FormRequestEvent } from '@maka/core/events';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { AsyncEventQueue } from './async-queue.js';
import type {
  PluginExecutorBinding,
  PluginExecutorOutputEvent,
  PluginExecutorPermissionRequest,
  PluginExecutorPermissionResult,
  PluginExecutorResult,
} from './plugin-executor-service.js';

interface ActiveExecution {
  readonly abort: AbortController;
  readonly settled: Promise<void>;
}

export interface PluginExecutorBackendInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly instructions?: string;
  readonly binding: PluginExecutorBinding;
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** Converts a small plugin executor contract into Maka's existing Run event stream. */
export class PluginExecutorBackend implements AgentBackend {
  readonly kind = 'plugin-executor' as const;
  readonly sessionId: string;
  readonly #cwd: string;
  readonly #instructions?: string;
  readonly #binding: PluginExecutorBinding;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #active = new Set<ActiveExecution>();
  #disposed = false;

  constructor(input: PluginExecutorBackendInput) {
    this.sessionId = input.sessionId;
    this.#cwd = input.cwd;
    this.#instructions = input.instructions;
    this.#binding = input.binding;
    this.#newId = input.newId ?? randomUUID;
    this.#now = input.now ?? Date.now;
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
    let thinkingText = '';
    const toolUseIds = new Map<string, string>();
    let result: PluginExecutorResult | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await this.#binding.execute(
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
            if (event.type === 'thinking_delta') thinkingText += event.text;
            this.#publishOutputEvent(turnId, messageId, event, toolUseIds, queue);
          },
          onPermissionRequest: (request) =>
            this.#requestPermission(input, request, signal, toolUseIds, queue),
        },
      );
    } catch (error) {
      failed = true;
      failure = error;
    }

    this.#closeOptionalOutput(turnId, messageId, thinkingText, toolUseIds, queue);
    if (failed) {
      if (signal.aborted)
        this.#publishCancellation(turnId, { status: 'cancelled', source: 'caller' }, queue);
      else
        this.#publishFailure(
          turnId,
          failure instanceof Error ? failure.message : 'External executor failed',
          undefined,
          false,
          queue,
        );
      return;
    }
    if (result === undefined) {
      this.#publishFailure(
        turnId,
        'External executor returned no terminal result',
        undefined,
        false,
        queue,
      );
      return;
    }
    this.#publishResult(turnId, messageId, result, queue);
  }

  async #requestPermission(
    input: BackendSendInput,
    request: PluginExecutorPermissionRequest,
    signal: AbortSignal,
    toolUseIds: ReadonlyMap<string, string>,
    queue: AsyncEventQueue<SessionEvent>,
  ): Promise<PluginExecutorPermissionResult> {
    const hosted = input.hostedInteraction;
    if (!hosted || signal.aborted) return { outcome: 'cancelled' };
    const requestId = this.#newId();
    const event: FormRequestEvent = {
      type: 'form_request',
      id: this.#newId(),
      turnId: input.turnId,
      ts: this.#now(),
      requestId,
      toolUseId: toolUseIds.get(request.toolCallId) ?? request.toolCallId,
      message: request.title,
      requester: {
        name: this.#binding.identity.displayName,
        source: this.#binding.identity.extensionId,
      },
      fields: [
        {
          kind: 'single_select',
          name: 'optionId',
          label: 'Permission',
          required: true,
          options: request.options.map((option) => ({
            value: option.optionId,
            label: option.name,
          })),
        },
      ],
    };
    let settle!: (result: PluginExecutorPermissionResult) => void;
    const answer = new Promise<PluginExecutorPermissionResult>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const finish = (result: PluginExecutorPermissionResult): void => {
      if (settled) return;
      settled = true;
      settle(result);
    };
    const settlement: HostedFormSettlement = {
      applyAnswer: async (result) => {
        if (result.action !== 'accept') return finish({ outcome: 'cancelled' });
        const selected = result.values.optionId;
        if (
          typeof selected !== 'string' ||
          !request.options.some((option) => option.optionId === selected)
        ) {
          return finish({ outcome: 'cancelled' });
        }
        finish({ outcome: 'selected', optionId: selected });
      },
      applyClosure: async () => finish({ outcome: 'cancelled' }),
    };
    let admission: Promise<void> | undefined;
    const onAbort = (): void => {
      finish({ outcome: 'cancelled' });
      void Promise.resolve().then(async () => {
        await admission?.catch(() => undefined);
        await hosted.withdrawFormRequest(requestId).catch(() => undefined);
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      admission = hosted.admitFormRequest({ request: event, settlement });
      await admission;
      if (signal.aborted) return { outcome: 'cancelled' };
      queue.push(event);
      return await answer;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  #closeOptionalOutput(
    turnId: string,
    messageId: string,
    thinkingText: string,
    toolUseIds: Map<string, string>,
    queue: AsyncEventQueue<SessionEvent>,
  ): void {
    if (thinkingText) {
      queue.push({
        type: 'thinking_complete',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        messageId,
        text: thinkingText,
      });
    }
    for (const toolUseId of toolUseIds.values()) {
      queue.push({
        type: 'tool_result',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        toolUseId,
        providerExecuted: true,
        isError: true,
        content: { kind: 'text', text: 'External executor ended before reporting a tool result' },
      });
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
      this.#publishCancellation(turnId, result, queue);
      return;
    }
    this.#publishFailure(turnId, result.message, result.code, result.recoverable ?? false, queue);
  }

  #publishCancellation(
    turnId: string,
    result: Extract<PluginExecutorResult, { status: 'cancelled' }>,
    queue: AsyncEventQueue<SessionEvent>,
  ): void {
    const reason = cancellationEventReason(result);
    queue.push({
      type: 'abort',
      id: this.#newId(),
      turnId,
      ts: this.#now(),
      reason,
    });
    queue.push({
      type: 'complete',
      id: this.#newId(),
      turnId,
      ts: this.#now(),
      stopReason: 'user_stop',
    });
  }

  #publishOutputEvent(
    turnId: string,
    messageId: string,
    event: PluginExecutorOutputEvent,
    toolUseIds: Map<string, string>,
    queue: AsyncEventQueue<SessionEvent>,
  ): void {
    if (event.type === 'output_delta') {
      if (!event.text) return;
      queue.push({
        type: 'text_delta',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        messageId,
        text: event.text,
      });
      return;
    }
    if (event.type === 'thinking_delta') {
      if (!event.text) return;
      queue.push({
        type: 'thinking_delta',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        messageId,
        text: event.text,
      });
      return;
    }
    if (event.type === 'tool_start') {
      const previousToolUseId = toolUseIds.get(event.toolCallId);
      if (previousToolUseId) {
        queue.push({
          type: 'tool_result',
          id: this.#newId(),
          turnId,
          ts: this.#now(),
          toolUseId: previousToolUseId,
          providerExecuted: true,
          isError: true,
          content: { kind: 'text', text: 'External executor reused an active tool call id' },
        });
      }
      const toolUseId = this.#newId();
      toolUseIds.set(event.toolCallId, toolUseId);
      queue.push({
        type: 'tool_start',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        toolUseId,
        toolName: event.name,
        args: event.input ?? {},
        providerExecuted: true,
        stepId: messageId,
        ...(event.displayName === undefined ? {} : { displayName: event.displayName }),
        ...(event.activityKind === undefined ? {} : { activityKind: event.activityKind }),
      });
      return;
    }
    const toolUseId = toolUseIds.get(event.toolCallId);
    if (!toolUseId) return;
    if (event.type === 'tool_progress') {
      if (!event.text) return;
      queue.push({
        type: 'tool_progress',
        id: this.#newId(),
        turnId,
        ts: this.#now(),
        toolUseId,
        chunk: event.text,
      });
      return;
    }
    toolUseIds.delete(event.toolCallId);
    queue.push({
      type: 'tool_result',
      id: this.#newId(),
      turnId,
      ts: this.#now(),
      toolUseId,
      providerExecuted: true,
      isError: event.isError ?? false,
      content:
        event.content.kind === 'text'
          ? event.content
          : { kind: 'file_diff', paths: [...event.content.paths], diff: event.content.diff },
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

function cancellationEventReason(
  result: Extract<PluginExecutorResult, { status: 'cancelled' }>,
): 'user_stop' | 'redirect' | 'timeout' | 'crash' {
  if (result.reason === 'redirect') return 'redirect';
  if (result.reason === 'timeout') return 'timeout';
  if (result.source === 'executor_retired') return 'crash';
  return 'user_stop';
}
