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
import {
  extractInlineMentionIds,
  formatInlineMention,
  formatRoomPreviewText,
  isGroupContinuation,
  roomMentionAt,
  roomTextNeedsMarkdown,
  stripInlineMention,
} from '../app/roomMessage.ts';

test('roomMentionAt triggers seamlessly after CJK, punctuation, whitespace, or start of line', () => {
  assert.deepEqual(roomMentionAt('@codex', { start: 6, end: 6 }), {
    start: 0,
    end: 6,
    query: 'codex',
  });
  assert.deepEqual(roomMentionAt('帮我看下@前端', { start: 7, end: 7 }), {
    start: 4,
    end: 7,
    query: '前端',
  });
  assert.deepEqual(roomMentionAt('请(@bot', { start: 6, end: 6 }), {
    start: 2,
    end: 6,
    query: 'bot',
  });
  // Email addresses and already-formatted inline mention tokens must not trigger picker.
  assert.equal(roomMentionAt('contact foo@bar', { start: 15, end: 15 }), null);
  assert.equal(roomMentionAt('[@Alice](maka://session/s1)', { start: 7, end: 7 }), null);
  // Active range selection does not trigger.
  assert.equal(roomMentionAt('@bot', { start: 1, end: 4 }), null);
});

test('inline mention formatting, extraction, and stripping preserve surrounding prose', () => {
  const tokenA = formatInlineMention('ma_alpha', 'Frontend [v2]');
  const tokenB = formatInlineMention('ma_beta', 'Backend');
  const draft =
    '请 ' +
    tokenA +
    '改样式，并参考 [详情](maka://session/ma_plain) 和 [#设计群](maka://session/ma_room) 给 ' +
    tokenB +
    '对接口';

  assert.deepEqual(extractInlineMentionIds(draft), ['ma_alpha', 'ma_beta']);
  const removed = stripInlineMention(draft, 'ma_alpha');
  assert.equal(removed.includes('ma_alpha'), false);
  assert.equal(removed.includes('改样式'), true);
  assert.deepEqual(extractInlineMentionIds(removed), ['ma_beta']);
});

test('isGroupContinuation groups same-author messages within 5 minutes and breaks on replies, gaps, or deletions', () => {
  const baseAt = new Date(2026, 10, 22, 10, 0, 0).getTime();
  const make = (overrides) => ({
    id: 'm',
    sequence: 1,
    at: baseAt,
    author: { kind: 'session', execution: { sessionId: 'alice', runId: 'r1', turnId: 't1' } },
    content: { text: 'hi', attachments: [] },
    replyTo: null,
    mentions: [],
    deliveries: [],
    ...overrides,
  });

  const m1 = make({ id: 'm1', at: baseAt });
  assert.equal(isGroupContinuation(undefined, m1), false);
  assert.equal(isGroupContinuation(m1, make({ id: 'm2', at: baseAt + 60_000 })), true);
  // Gap >= 5 minutes breaks group.
  assert.equal(isGroupContinuation(m1, make({ id: 'm3', at: baseAt + 5 * 60_000 })), false);
  // Different author breaks group.
  assert.equal(
    isGroupContinuation(m1, make({ id: 'm4', at: baseAt + 10_000, author: { kind: 'human' } })),
    false,
  );
  // Quoted reply breaks group so reply context stays clearly anchored.
  assert.equal(
    isGroupContinuation(m1, make({ id: 'm5', at: baseAt + 10_000, replyTo: 'm0' })),
    false,
  );
  // Deleted message breaks group.
  assert.equal(
    isGroupContinuation(m1, make({ id: 'm6', at: baseAt + 10_000, deletedAt: baseAt + 11_000 })),
    false,
  );
});

test('formatRoomPreviewText strips session link URIs and roomTextNeedsMarkdown keeps plain prose compact', () => {
  assert.equal(
    formatRoomPreviewText(
      'Please review [@Room reviewer](maka://session/s1) and [spec](https://example.com)',
    ),
    'Please review @Room reviewer and spec',
  );
  assert.equal(roomTextNeedsMarkdown('The patch is ready.'), false);
  assert.equal(roomTextNeedsMarkdown('Please review [@Room reviewer](maka://session/s1)'), true);
  assert.equal(roomTextNeedsMarkdown('line 1\nline 2'), true);
});
