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

import { foldRuntimeHostAssistantDelta } from '@maka/runtime-host/adapter';
import {
  RequestError,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';

type StreamKind = 'text' | 'thinking';

export interface AcpSessionEventMapperOptions {
  readonly sessionId: string;
  readonly notify: (notification: SessionNotification) => Promise<void>;
}

/** Serializes one ACP prompt's live projection delivery. */
export class AcpSessionEventMapper {
  readonly #sessionId: string;
  readonly #notify: (notification: SessionNotification) => Promise<void>;
  readonly #streams = new Map<string, string>();
  #tail: Promise<unknown> = Promise.resolve();
  #failure: RequestError | undefined;

  constructor(options: AcpSessionEventMapperOptions) {
    this.#sessionId = options.sessionId;
    this.#notify = options.notify;
  }

  accept(event: SessionEvent): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#failure) throw this.#failure;
      switch (event.type) {
        case 'text_delta':
          await this.#acceptText(
            'text',
            event.messageId,
            deltaText(event, this.#streams.get(streamKey('text', event.messageId))),
          );
          break;
        case 'text_complete':
          await this.#acceptText('text', event.messageId, event.text);
          break;
        case 'thinking_delta':
          await this.#acceptText(
            'thinking',
            event.messageId,
            deltaText(event, this.#streams.get(streamKey('thinking', event.messageId))),
          );
          break;
        case 'thinking_complete':
          await this.#acceptText('thinking', event.messageId, event.text);
          break;
        default:
          break;
      }
    });
  }

  replaceTranscript(turnId: string, messages: readonly StoredMessage[]): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#failure) throw this.#failure;
      for (const message of messages) {
        if (message.turnId !== turnId || message.type !== 'assistant') continue;
        await this.#acceptText('thinking', message.id, message.thinking?.text ?? '');
        await this.#acceptText('text', message.id, message.text);
      }
    });
  }

  /** Waits until every notification already accepted by this mapper has settled. */
  flush(): Promise<void> {
    return this.#tail.then(() => undefined);
  }

  async #acceptText(kind: StreamKind, hostMessageId: string, nextText: string): Promise<void> {
    const key = streamKey(kind, hostMessageId);
    const current = this.#streams.get(key) ?? '';
    if (!nextText.startsWith(current)) {
      // ACP v1 chunks only append. A new message ID cannot retract prior output.
      this.#failure = RequestError.internalError(
        { source: 'adapter', code: 'unsupported_stream_revision' },
        'Runtime Host revised streamed output that ACP v1 cannot replace; the prompt failed',
      );
      throw this.#failure;
    }
    const chunk = nextText.slice(current.length);
    this.#streams.set(key, nextText);
    if (chunk.length === 0) return;
    const update: SessionUpdate = {
      sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
      content: { type: 'text', text: chunk },
      messageId: hostMessageId,
    };
    await this.#notify({ sessionId: this.#sessionId, update });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function deltaText(
  event: Extract<SessionEvent, { type: 'text_delta' | 'thinking_delta' }>,
  current = '',
): string {
  return foldRuntimeHostAssistantDelta(current, {
    startOffset: event.startOffset ?? current.length,
    text: event.text,
  }).text;
}

function streamKey(kind: StreamKind, messageId: string): string {
  return `${kind}:${messageId}`;
}
