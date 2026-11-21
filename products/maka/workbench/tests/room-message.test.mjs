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
  roomAvatarColor,
  roomDayKey,
  roomDeliveryReasonKey,
  roomMentionAt,
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
    '请 ' + tokenA + '改样式，并参考 [#设计群](maka://session/ma_room) 给 ' + tokenB + '对接口';

  assert.deepEqual(extractInlineMentionIds(draft), ['ma_alpha', 'ma_beta']);
  const removed = stripInlineMention(draft, 'ma_alpha');
  assert.equal(removed.includes('ma_alpha'), false);
  assert.equal(removed.includes('改样式'), true);
  assert.deepEqual(extractInlineMentionIds(removed), ['ma_beta']);
});

test('room avatar color, day key, and localized delivery failure keys are deterministic', () => {
  assert.equal(roomAvatarColor('ma_session_1'), roomAvatarColor('ma_session_1'));
  assert.equal(roomDeliveryReasonKey('agent_room_hop_limit_reached'), 'Reason hop limit');
  assert.equal(roomDeliveryReasonKey('agent_room_self_mention'), 'Reason self mention');
  assert.equal(
    roomDeliveryReasonKey('agent_room_reply_tool_unavailable'),
    'Reason reply tool unavailable',
  );
  assert.equal(roomDeliveryReasonKey('unknown_custom_error'), null);
  assert.match(roomDayKey(Date.UTC(2026, 10, 21, 12, 0, 0)), /^\d{4}-\d{2}-\d{2}$/);
});
