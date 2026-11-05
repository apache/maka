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
import {
  isAssistantCard,
  assistantMessageText,
  assistantCardImageMarkdown,
  type AssistantCard,
} from '../assistant-card.js';
import { decodeCanonicalMessage } from '../session.js';
import { decodeRuntimeEvent } from '../runtime-event.js';
const card: AssistantCard = {
  type: 'offer',
  title: '出差报销',
  items: [
    {
      title: '整理提交包',
      facts: [{ label: '还差', value: '酒店发票' }],
      actions: [
        { kind: 'reply', label: '帮我整理', value: '请整理这次广州出差报销的已有材料，暂不提交。' },
      ],
    },
  ],
};
test('card survives canonical message and event decoding with legacy compatibility', () => {
  const m = {
    type: 'assistant',
    id: 'a',
    turnId: 't',
    ts: 1,
    text: '我可以帮你。',
    modelId: 'bot',
    card,
  };
  assert.deepEqual(decodeCanonicalMessage(JSON.parse(JSON.stringify(m))), m);
  const event = {
    id: 'e',
    invocationId: 'i',
    runId: 'r',
    sessionId: 's',
    turnId: 't',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text: '我可以帮你。', card },
  };
  assert.deepEqual(decodeRuntimeEvent(event).content, event.content);
  assert.equal(decodeCanonicalMessage({ ...m, card: undefined }).type, 'assistant');
});
test('rejects executable markup fields, unsafe URLs and unbounded collections', () => {
  for (const bad of [
    { ...card, html: '<script>hi</script>' },
    { ...card, items: [] },
    { ...card, items: Array(7).fill(card.items[0]) },
    {
      ...card,
      items: [
        { title: 'bad', actions: [{ label: 'go', kind: 'link', value: 'javascript:alert(1)' }] },
      ],
    },
    { ...card, items: [{ title: 'bad', image: { url: 'file:///secret', alt: 'cover' } }] },
  ])
    assert.equal(isAssistantCard(bad), false);
  assert.equal(isAssistantCard(card), true);
});
test('text fallback includes facts and concrete replies; image source projection is separate', () => {
  const text = assistantMessageText({ text: '我可以帮你。', card });
  assert.match(text, /酒店发票/);
  assert.match(text, /暂不提交/);
  assert.equal(assistantMessageText({ text: '短消息' }), '短消息');
  assert.equal(
    assistantCardImageMarkdown({
      ...card,
      items: [{ title: '封面', image: { url: 'https://example.com/image.png', alt: '图片' } }],
    }),
    '![](<https://example.com/image.png>)',
  );
});
