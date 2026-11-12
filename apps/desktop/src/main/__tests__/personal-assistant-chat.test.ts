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
import { disconnectedAvatarState, dismissComposerConfiguration, hasPendingAssistantReply } from '../../renderer/features/personal-assistant/testing.js';
import { getPersonalAssistantChatCopy } from '../../renderer/features/personal-assistant/testing.js';

test('assistant chat catalog includes aria labels and placeholder in every shipped locale', () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    const copy = getPersonalAssistantChatCopy(locale);
    assert.ok(copy.avatarLabel && copy.typingLabel && copy.placeholder);
  }
  assert.equal(getPersonalAssistantChatCopy('en').avatarLabel, 'Personal assistant avatar');
  assert.equal(getPersonalAssistantChatCopy('en').typingLabel, 'Typing');
  assert.equal(getPersonalAssistantChatCopy('zh-TW').avatarLabel, '個人助理頭像');
  assert.equal(getPersonalAssistantChatCopy('zh-TW').typingLabel, '正在輸入');
  assert.equal(getPersonalAssistantChatCopy('zh-TW').placeholder, '聊點什麼…');
});

test('identical disconnect polls preserve state but a different Host or custom identity is cleared', () => {
  const fallback = { emoji: '🤖', background: '#E5EDFF' };
  const initial = { scope: 'A', avatar: fallback };
  assert.equal(disconnectedAvatarState(initial, 'A', fallback), initial);
  const switched = disconnectedAvatarState(initial, 'B', fallback);
  assert.notEqual(switched, initial);
  assert.equal(disconnectedAvatarState(switched, 'B', fallback), switched);
  const custom = { scope: 'A', avatar: { emoji: '🐈', background: '#FFFFFF' } };
  assert.deepEqual(disconnectedAvatarState(custom, 'A', fallback), initial);
});

test('typing is restricted to unanswered conversation messages, not background Bot work', () => {
  assert.equal(hasPendingAssistantReply([]), false);
  assert.equal(hasPendingAssistantReply([{ type: 'user', origin: { kind: 'scheduled_task' } }]), false);
  assert.equal(hasPendingAssistantReply([{ type: 'assistant' }]), false);
  assert.equal(hasPendingAssistantReply([{ type: 'user' }, { type: 'assistant' }]), false);
  assert.equal(hasPendingAssistantReply([{ type: 'user' }, { type: 'turn_state' }]), true);
  assert.equal(hasPendingAssistantReply([{ type: 'assistant' }, { type: 'user' }]), true);
});

test('compact composer dismisses on Escape and outside pointerdown, not inside interactions', () => {
  let focused = false;
  const details = { open: true, querySelector: () => ({ focus: () => { focused = true; } }) };
  const root = { querySelector: () => details } as unknown as HTMLElement;
  const pointer = (path: unknown[]) => ({ type: 'pointerdown', composedPath: () => path }) as unknown as Event;
  dismissComposerConfiguration(root, pointer([details]));
  assert.equal(details.open, true);
  dismissComposerConfiguration(root, pointer([]));
  assert.equal(details.open, false);
  assert.equal(focused, false);
  details.open = true;
  const other = new Event('keydown', { cancelable: true });
  Object.defineProperty(other, 'key', { value: 'Enter' });
  dismissComposerConfiguration(root, other);
  assert.equal(details.open, true);
  const escape = new Event('keydown', { cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  escape.preventDefault();
  dismissComposerConfiguration(root, escape);
  assert.equal(details.open, true);
  const dismiss = new Event('keydown', { cancelable: true });
  Object.defineProperty(dismiss, 'key', { value: 'Escape' });
  dismissComposerConfiguration(root, dismiss);
  assert.equal(details.open, false);
  assert.equal(focused, true);
  assert.equal(dismiss.defaultPrevented, true);
});
