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
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  createSessionTranscriptBootstrap,
  prepareSessionTranscriptOverlay,
  readSessionTranscriptPage,
  TranscriptPageRequestError,
  updateSubscriberTranscriptHighWater,
} from '../server/session-transcript-pager.js';
import type { SessionTranscriptReader } from '../server/session-transcript-reader.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';

test('reads newly durable messages forward from an announced watermark', async () => {
  const durable = [userMessage(0), userMessage(1)];
  const reader = transcriptReader(durable);
  const { bootstrap, state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 1024,
  });
  assert.equal(bootstrap.throughSequence, 1);

  durable.push(userMessage(2), userMessage(3));
  assert.equal(updateSubscriberTranscriptHighWater(state, 3), true);
  const page = await readSessionTranscriptPage({
    reader,
    state,
    request: {
      subscriptionId: 'subscription-1',
      source: 'durable',
      direction: 'newer',
      throughSequence: 3,
      cursor: null,
      anchorSequence: 1,
      maxBytes: 1024,
    },
  });
  assert.deepEqual(
    page.fragments.map((fragment) =>
      fragment.kind === 'durable' ? fragment.sequence : fragment.messageIndex,
    ),
    [2, 3],
  );
  assert.equal(page.nextCursor, null);
});

test('rejects cursor tampering and cross-subscription replay', async () => {
  const reader = transcriptReader([userMessage(0, 'x'.repeat(2_000))]);
  const first = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 0,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 128,
  });
  const second = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-2',
    throughSequence: 0,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 128,
  });
  const cursor = first.bootstrap.durable.nextCursor;
  assert.ok(cursor);
  if (!cursor) return;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  const request = {
    subscriptionId: 'subscription-1',
    source: 'durable' as const,
    direction: 'older' as const,
    throughSequence: 0,
    cursor,
    anchorSequence: null,
    maxBytes: 128,
  };

  await assert.rejects(
    readSessionTranscriptPage({
      reader,
      state: first.state,
      request: { ...request, cursor: tampered },
    }),
    TranscriptPageRequestError,
  );
  await assert.rejects(
    readSessionTranscriptPage({ reader, state: second.state, request }),
    TranscriptPageRequestError,
  );
});

test('keeps a durable continuation when overlay bytes reduce the bootstrap budget', async () => {
  const durable = [userMessage(0, 'a'.repeat(240)), userMessage(1, 'b'.repeat(240))];
  const reader = transcriptReader(durable, [userMessage(0, 'overlay'.repeat(40))]);
  const { bootstrap } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: Buffer.byteLength(JSON.stringify(durable[0]), 'utf8') * 2,
  });
  assert.ok(bootstrap.overlay.rawBytes > 0);
  assert.ok(bootstrap.durable.nextCursor);
});

test('shrinks the raw bootstrap until it fits its aggregate encoded budget', async () => {
  const durable = Array.from({ length: 100 }, (_, index) => userMessage(index, `message-${index}`));
  const { bootstrap } = await createSessionTranscriptBootstrap({
    reader: transcriptReader(durable),
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    throughSequence: durable.length - 1,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: 16 * 1024,
    maxEncodedBytes: 4 * 1024,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bootstrap), 'utf8') <= 4 * 1024);
  assert.ok(bootstrap.durable.nextCursor);
});

test('rejects an active overlay that exceeds its retained message bound', async () => {
  const overlay = Array.from({ length: 4_097 }, (_, index) => userMessage(index));
  await assert.rejects(
    prepareSessionTranscriptOverlay({
      reader: transcriptReader([], overlay),
      sessionId: 'session-1',
      throughSequence: null,
      rootTurn: null,
      activeAssistantStreams: [],
    }),
    /overlay exceeds its message limit/,
  );
});

test('delegates one deduplicated and bounded durable reconciliation request', async () => {
  const messages = Array.from({ length: 257 }, (_, index) => assistantMessage(index));
  const requests: Parameters<SessionTranscriptReader['readDurableMessagesById']>[1][] = [];
  const base = transcriptReader(messages, messages);
  const reader: SessionTranscriptReader = {
    ...base,
    readDurableMessagesById: async (_sessionId, request) => {
      requests.push(request);
      return messages.filter((message) => request.messageIds.includes(message.id));
    },
  };
  const activeAssistantStreams = messages.flatMap((message, index) => [
    {
      turnId: message.turnId,
      messageId: message.id,
      kind: 'text' as const,
      text: message.text,
    },
    ...(index === 0
      ? [
          {
            turnId: message.turnId,
            messageId: message.id,
            kind: 'thinking' as const,
            text: message.thinking!.text,
          },
        ]
      : []),
  ]);

  const overlay = await prepareSessionTranscriptOverlay({
    reader,
    sessionId: 'session-1',
    throughSequence: 256,
    rootTurn: null,
    activeAssistantStreams,
  });

  assert.equal(overlay.length, 257);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.messageIds.length, 257);
  assert.equal(new Set(requests[0]?.messageIds).size, 257);
  assert.equal(requests[0]?.throughSequence, 256);
  assert.equal(requests[0]?.maxMessages, 4_096);
  assert.equal(requests[0]?.maxBytes, 16 * 1024 * 1024);
});

function userMessage(index: number, text = `message-${index}`): StoredMessage {
  return {
    type: 'user',
    id: `message-${index}`,
    turnId: `turn-${index}`,
    ts: index + 1,
    text,
  };
}

function assistantMessage(index: number): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id: `message-${index}`,
    turnId: `turn-${index}`,
    ts: index + 1,
    modelId: 'model-1',
    text: `message-${index}`,
    thinking: { text: `thinking-${index}`, signature: '' },
  };
}
