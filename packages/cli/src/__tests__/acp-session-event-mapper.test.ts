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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AcpSessionEventMapper } from '../acp/session-event-mapper.js';

describe('ACP Session event mapper', () => {
  test('streams text and thinking while deduplicating matching completion events', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);

    await mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'hel' }));
    await mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'lo' }));
    await mapper.accept(event({ type: 'text_complete', messageId: 'answer', text: 'hello' }));
    await mapper.accept(event({ type: 'thinking_delta', messageId: 'thought', text: 'hmm' }));
    await mapper.accept(event({ type: 'thinking_complete', messageId: 'thought', text: 'hmm' }));

    assert.deepEqual(
      notifications.map(({ update }) => update),
      [
        chunk('agent_message_chunk', 'answer', 'hel'),
        chunk('agent_message_chunk', 'answer', 'lo'),
        chunk('agent_thought_chunk', 'thought', 'hmm'),
      ],
    );
  });

  test('fills a completion suffix and assigns deterministic IDs to non-prefix revisions', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);

    await mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'hel' }));
    await mapper.accept(event({ type: 'text_complete', messageId: 'answer', text: 'hello' }));
    await mapper.accept(event({ type: 'text_complete', messageId: 'answer', text: 'hullo' }));
    await mapper.accept(event({ type: 'text_complete', messageId: 'answer', text: 'hullo' }));
    await mapper.accept(event({ type: 'text_complete', messageId: 'answer', text: 'hello' }));
    await mapper.accept(event({ type: 'text_complete', messageId: 'answer', text: 'hullo' }));

    assert.equal(notifications.length, 5);
    assert.deepEqual(notifications[1]?.update, chunk('agent_message_chunk', 'answer', 'lo'));
    const replacement = notifications[2]?.update;
    assert.equal(replacement?.sessionUpdate, 'agent_message_chunk');
    if (replacement?.sessionUpdate !== 'agent_message_chunk') return;
    assert.equal(replacement.content.type, 'text');
    assert.equal(replacement.content.type === 'text' && replacement.content.text, 'hullo');
    assert.match(replacement.messageId ?? '', /^answer:revision:[0-9a-f]{16}$/u);
    const repeatedRevision = notifications[4]?.update;
    assert.equal(repeatedRevision?.sessionUpdate, 'agent_message_chunk');
    if (repeatedRevision?.sessionUpdate !== 'agent_message_chunk') return;
    assert.notEqual(repeatedRevision.messageId, replacement.messageId);
  });

  test('serializes canonical transcript replacement with live notifications', async () => {
    const notifications: SessionNotification[] = [];
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const mapper = new AcpSessionEventMapper({
      sessionId: 'session-1',
      notify: async (notification) => {
        calls += 1;
        if (calls === 1) await firstPending;
        notifications.push(notification);
      },
    });

    const live = mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'old' }));
    const replacement = mapper.replaceTranscript('turn-1', [
      {
        type: 'assistant',
        id: 'answer',
        turnId: 'turn-1',
        ts: 2,
        text: 'new',
        modelId: 'model',
      },
    ]);
    releaseFirst();
    await Promise.all([live, replacement]);

    assert.equal(notifications.length, 2);
    const update = notifications[1]?.update;
    assert.equal(update?.sessionUpdate, 'agent_message_chunk');
    if (update?.sessionUpdate !== 'agent_message_chunk') return;
    assert.equal(update.content.type === 'text' && update.content.text, 'new');
    assert.match(update.messageId ?? '', /^answer:revision:[0-9a-f]{16}$/u);
  });

  test('emits exactly one terminal result', async () => {
    const mapper = eventMapper([]);
    assert.equal(
      await mapper.accept(event({ type: 'complete', stopReason: 'max_tokens' })),
      'end_turn',
    );
    assert.equal(await mapper.accept(event({ type: 'abort', reason: 'crash' })), 'end_turn');
    assert.equal(await mapper.cancel(), 'end_turn');

    const cancelled = eventMapper([]);
    assert.equal(await cancelled.cancel(), 'cancelled');
    assert.equal(
      await cancelled.accept(event({ type: 'complete', stopReason: 'end_turn' })),
      'cancelled',
    );
  });
});

function eventMapper(notifications: SessionNotification[]): AcpSessionEventMapper {
  return new AcpSessionEventMapper({
    sessionId: 'session-1',
    notify: async (notification) => void notifications.push(notification),
  });
}

function chunk(
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
  messageId: string,
  text: string,
) {
  return { sessionUpdate, content: { type: 'text' as const, text }, messageId };
}

function event<T extends Omit<SessionEvent, 'id' | 'turnId' | 'ts'>>(value: T): SessionEvent {
  return { id: 'event', turnId: 'turn-1', ts: 1, ...value } as unknown as SessionEvent;
}
