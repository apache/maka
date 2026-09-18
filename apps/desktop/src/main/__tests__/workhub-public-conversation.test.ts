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
import { test } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import type { LiveTurnProjection } from '@maka/ui';
import { workHubPublicConversation } from '../../renderer/features/workhub/testing.js';
const turnId = 'opaque-turn-id';
const user: StoredMessage = { type: 'user', id: 'input', turnId, ts: 1, text: 'Task result', workhubSource: 'voice_maintenance', presentation: 'internal' };
const raw = (text: string): LiveTurnProjection => ({ turnId, startedAt: 1,
  steps: [{ stepId: 'raw-step', contentOrder: ['text'], tools: [], text: { text, complete: false, truncated: false } }] });
const publication: StoredMessage = { type: 'assistant', id: 'publication', turnId, ts: 3, text: 'Top5 已修改。', modelId: '', presentation: 'public' };
test('untagged maintenance never flashes at any stream boundary, including before input metadata arrives', () => {
  const text = '队列为空，正在维护优先级';
  for (let end = 0; end <= text.length; end++) {
    assert.equal(workHubPublicConversation([user], raw(text.slice(0, end))).liveTurn, undefined);
    assert.equal(workHubPublicConversation([], raw(text.slice(0, end))).liveTurn, undefined);
  }
});
test('live, refreshed history and reload use the same public record exactly once', () => {
  const hidden: StoredMessage = { ...publication, id: 'private', presentation: 'internal', text: 'PRIVATE_QUEUE_STATE' };
  const messages = [user, hidden, publication];
  for (const live of [raw('PRIVATE_RAW_TEXT'), undefined]) {
    const view = workHubPublicConversation(messages, live);
    assert.deepEqual(view.messages, [publication]);
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE|Task result/);
  }
  assert.deepEqual(workHubPublicConversation([...messages, publication]).messages, [publication]);
});
test('voice request steering into maintenance cannot make raw prose public', () => {
  const live = raw('PRIVATE_PROCESS');
  live.steps[0]!.leadingSteering = [{ id: 'real-user', ts: 2, content: { text: '改成 Top5', workhubSource: 'voice_request' } }];
  const request: StoredMessage = { type: 'user', id: 'real-user', turnId, ts: 2, text: '改成 Top5', workhubSource: 'voice_request' };
  const view = workHubPublicConversation([user, request, publication], live);
  assert.deepEqual(view.messages, [request, publication]);
  assert.equal(view.liveTurn, undefined);
});
test('normal text stays intact, including strings that previously acted as hiding tags', () => {
  const input: StoredMessage = { type: 'user', id: 'input', turnId, ts: 1, text: '解释 <voice_queue> 标签', workhubSource: 'text_request' };
  const live = raw('示例 <voice_queue>正文</voice_queue>');
  const before = structuredClone(live);
  assert.equal(workHubPublicConversation([input], live).liveTurn?.steps[0]?.text?.text, live.steps[0]?.text?.text);
  assert.deepEqual(live, before);
  assert.equal(workHubPublicConversation([input], live).liveTurn, live, 'ordinary WorkHub streams keep their tool and progress presentation');
  assert.deepEqual(workHubPublicConversation([input]).messages, [input]);
});

test('a publication revised in a later turn replaces its original public row', () => {
  const original = { ...publication, text: 'Old joke' };
  const revised = { ...publication, turnId: 'later-maintenance', ts: 8, text: 'Revised joke' };
  const other = { ...publication, id: 'other', text: 'Another result' };
  assert.deepEqual(workHubPublicConversation([original, other, revised]).messages, [revised, other]);
  assert.equal(original.text, 'Old joke');
});
