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

  test('rejects non-prefix revisions instead of reporting a second message or success', async () => {
    for (const kind of ['text', 'thinking'] as const) {
      for (const text of ['new', '']) {
        const notifications: SessionNotification[] = [];
        const mapper = eventMapper(notifications);
        await mapper.accept(event({ type: `${kind}_delta`, messageId: 'answer', text: 'old' }));
        await assert.rejects(
          mapper.accept(event({ type: `${kind}_complete`, messageId: 'answer', text })),
          { data: { source: 'adapter', code: 'unsupported_stream_revision' } },
        );
        await assert.rejects(mapper.accept(event({ type: 'complete', stopReason: 'end_turn' })));
        assert.deepEqual(
          notifications.map(({ update }) => update),
          [chunk(kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', 'answer', 'old')],
        );
      }
    }
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
        text: 'older',
        modelId: 'model',
      },
    ]);
    releaseFirst();
    await Promise.all([live, replacement]);

    assert.equal(notifications.length, 2);
    const update = notifications[1]?.update;
    assert.equal(update?.sessionUpdate, 'agent_message_chunk');
    if (update?.sessionUpdate !== 'agent_message_chunk') return;
    assert.equal(update.content.type === 'text' && update.content.text, 'er');
    assert.equal(update.messageId, 'answer');
  });

  test('rejects a canonical message that clears already delivered thinking', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(event({ type: 'thinking_delta', messageId: 'answer', text: 'old' }));
    await assert.rejects(
      mapper.replaceTranscript('turn-1', [
        {
          type: 'assistant',
          id: 'answer',
          turnId: 'turn-1',
          ts: 2,
          text: 'answer',
          modelId: 'model',
        },
      ]),
      { data: { source: 'adapter', code: 'unsupported_stream_revision' } },
    );
    await assert.rejects(mapper.accept(event({ type: 'complete', stopReason: 'end_turn' })));
    assert.equal(notifications.length, 1);
  });

  test('leaves terminal classification to the Runtime Host Session channel', async () => {
    const notifications: SessionNotification[] = [];
    const mapper = eventMapper(notifications);
    await mapper.accept(event({ type: 'error', recoverable: true, message: 'retry' }));
    await mapper.accept(event({ type: 'error', recoverable: false, message: 'failed' }));
    await mapper.accept(event({ type: 'complete', stopReason: 'end_turn' }));
    await mapper.accept(event({ type: 'abort', reason: 'crash' }));
    await mapper.accept(event({ type: 'text_delta', messageId: 'answer', text: 'projected' }));

    assert.deepEqual(
      notifications.map(({ update }) => update),
      [chunk('agent_message_chunk', 'answer', 'projected')],
    );
  });

  test('flush waits for every already accepted notification', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered = false;
    const mapper = new AcpSessionEventMapper({
      sessionId: 'session-1',
      notify: async () => {
        await pending;
        delivered = true;
      },
    });

    const accepting = mapper.accept(
      event({ type: 'text_delta', messageId: 'answer', text: 'pending' }),
    );
    let flushed = false;
    const flushing = mapper.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered, false);
    assert.equal(flushed, false);
    release();
    await flushing;
    assert.equal(delivered, true);
    assert.equal(flushed, true);
    await accepting;
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
