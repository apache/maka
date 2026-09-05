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
import type { SessionNotification, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';

type StreamKind = 'text' | 'thinking';

interface StreamState {
  text: string;
  messageId: string;
}

export interface AcpSessionEventMapperOptions {
  readonly sessionId: string;
  readonly notify: (notification: SessionNotification) => Promise<void>;
}

/** Serializes one ACP prompt's live projection and terminal outcome. */
export class AcpSessionEventMapper {
  readonly #sessionId: string;
  readonly #notify: (notification: SessionNotification) => Promise<void>;
  readonly #streams = new Map<string, StreamState>();
  #tail: Promise<unknown> = Promise.resolve();
  #terminal: StopReason | undefined;

  constructor(options: AcpSessionEventMapperOptions) {
    this.#sessionId = options.sessionId;
    this.#notify = options.notify;
  }

  accept(event: SessionEvent): Promise<StopReason | undefined> {
    return this.#enqueue(async () => {
      if (this.#terminal) return this.#terminal;
      switch (event.type) {
        case 'text_delta':
          await this.#acceptText(
            'text',
            event.messageId,
            deltaText(event, this.#state('text', event.messageId)?.text),
          );
          break;
        case 'text_complete':
          await this.#acceptText('text', event.messageId, event.text);
          break;
        case 'thinking_delta':
          await this.#acceptText(
            'thinking',
            event.messageId,
            deltaText(event, this.#state('thinking', event.messageId)?.text),
          );
          break;
        case 'thinking_complete':
          await this.#acceptText('thinking', event.messageId, event.text);
          break;
        case 'complete':
          this.#terminal = 'end_turn';
          break;
        case 'abort':
          this.#terminal = 'cancelled';
          break;
        default:
          break;
      }
      return this.#terminal;
    });
  }

  replaceTranscript(turnId: string, messages: readonly StoredMessage[]): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#terminal) return;
      for (const message of messages) {
        if (message.turnId !== turnId || message.type !== 'assistant') continue;
        if (message.thinking?.text !== undefined) {
          await this.#acceptText('thinking', message.id, message.thinking.text);
        }
        await this.#acceptText('text', message.id, message.text);
      }
    });
  }

  cancel(): Promise<StopReason> {
    return this.#enqueue(async () => {
      this.#terminal ??= 'cancelled';
      return this.#terminal;
    });
  }

  get terminal(): StopReason | undefined {
    return this.#terminal;
  }

  async #acceptText(kind: StreamKind, hostMessageId: string, nextText: string): Promise<void> {
    const key = streamKey(kind, hostMessageId);
    const current = this.#streams.get(key);
    if (current?.text === nextText) return;
    let messageId = current?.messageId ?? hostMessageId;
    let chunk = nextText;
    if (current && nextText.startsWith(current.text)) {
      chunk = nextText.slice(current.text.length);
    } else if (current) {
      messageId = revisionMessageId(hostMessageId, kind, current.messageId, nextText);
    }
    this.#streams.set(key, { text: nextText, messageId });
    if (chunk.length === 0) return;
    const update: SessionUpdate = {
      sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
      content: { type: 'text', text: chunk },
      messageId,
    };
    await this.#notify({ sessionId: this.#sessionId, update });
  }

  #state(kind: StreamKind, messageId: string): StreamState | undefined {
    return this.#streams.get(streamKey(kind, messageId));
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
  if (event.startOffset === undefined) return current + event.text;
  if (event.startOffset > current.length) return current + event.text;
  return current.slice(0, event.startOffset) + event.text;
}

function streamKey(kind: StreamKind, messageId: string): string {
  return `${kind}:${messageId}`;
}

function revisionMessageId(
  messageId: string,
  kind: StreamKind,
  previousMessageId: string,
  text: string,
): string {
  const digest = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(previousMessageId)
    .update('\0')
    .update(text)
    .digest('hex')
    .slice(0, 16);
  return `${messageId}:revision:${digest}`;
}
