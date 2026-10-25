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

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';
import type { AssistantMessage, SessionHeader } from '@maka/core/session';
import { publishBotConversationMessage } from '../assistant/bot/conversation.js';
import { projectRuntimeEventsToStoredMessages } from '@maka/runtime/runtime-event-read-model';
import { createAssistantMessageReader } from '../server/session-transcript-reader.js';

test('cards survive canonical ledger publication and cannot change under the same message identity', async () => {
  let events: RuntimeEvent[] = [];
  const stores = {
    runtimeEventStore: {
      readRuntimeEvents: async () => events,
      importConversationCopyRuntimeEvents: async (_: string, copies: any[]) => {
        events = copies[0].events.map(decodeRuntimeEvent);
      },
    },
  } as any;
  const header = {
    id: 'owner',
    cwd: '/owner',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    model: 'model',
    permissionMode: 'ask',
  } as unknown as SessionHeader;
  const message: AssistantMessage = {
    id: 'card-message',
    type: 'assistant',
    turnId: 't',
    ts: 1,
    text: '报告已准备好',
    modelId: 'bot',
    card: {
      type: 'delivery',
      title: '研究报告',
      items: [
        {
          title: '报告',
          image: { url: 'https://example.com/cover.png', alt: '封面' },
          actions: [{ kind: 'link', label: '查看', value: 'https://example.com/report' }],
        },
      ],
    },
  };
  await publishBotConversationMessage(stores, header, message);
  await publishBotConversationMessage(stores, header, message);
  const opening = events.find((e) => e.content?.kind === 'invocation_opened')!;
  const projected = projectRuntimeEventsToStoredMessages(events, {
    invocations: [
      {
        sessionId: 'owner',
        invocationId: opening.invocationId,
        runId: opening.runId,
        turnId: 't',
        openedAt: 1,
        opening: opening.content as any,
      },
    ],
  });
  const result = projected.messages.find((m) => m.type === 'assistant');
  assert.deepEqual(result?.type === 'assistant' && result.card, message.card);
  await assert.rejects(
    publishBotConversationMessage(stores, header, {
      ...message,
      card: { ...message.card!, title: 'changed' },
    }),
    /identity conflict/,
  );
  const reader = createAssistantMessageReader({
    ensureTranscriptLedger: async () => {},
    events: {
      readTranscriptTurns: async () => [{ firstOrdinal: 1, lastOrdinal: 1 }],
      readTranscriptRun: async (_s: string, _q: any, read: any) =>
        read(
          { lastOrdinal: 1 },
          events.map((event) => ({ event })),
        ),
    } as any,
  });
  assert.match(
    (await reader({ sessionId: 'owner', turnId: 't', messageId: 'card-message' }))!,
    /!\[\]\(<https:\/\/example.com\/cover.png>\)/,
  );
});
