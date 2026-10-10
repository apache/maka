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
import { completedWorkHubDraft } from '../../renderer/features/workhub/testing.js';

const messages: StoredMessage[] = [
  { type: 'user', id: 'u', turnId: 't', ts: 1, text: ' WN ' },
  { type: 'tool_call', id: 'q', turnId: 't', ts: 2, toolName: 'AskUserQuestion', args: {} },
  { type: 'tool_result', id: 'r', turnId: 't', ts: 3, toolUseId: 'q', isError: false, content: { kind: 'json', value: { answers: [{ question: 'Which?', answer: 'SQL' }] } } },
  { type: 'assistant', id: 'a', turnId: 't', ts: 4, modelId: 'test', text: '```text\nContinue SQL, one question at a time.\n```' },
  { type: 'turn_state', id: 's', turnId: 't', ts: 5, status: 'completed' },
];
test('only completed newly requested and selected wn drafts enter the composer', () => {
  assert.equal(completedWorkHubDraft(messages, new Set()), 'Continue SQL, one question at a time.');
  assert.equal(completedWorkHubDraft(messages.map(m => m.type === 'assistant' ? { ...m, text: m.text.replace('```text', '```') } : m), new Set()), 'Continue SQL, one question at a time.');
  assert.equal(completedWorkHubDraft(messages, new Set(['u'])), undefined);
  assert.equal(completedWorkHubDraft(messages, new Set(), 2), undefined);
  assert.equal(completedWorkHubDraft(messages.slice(0, -1), new Set()), undefined);
  assert.equal(completedWorkHubDraft(messages.filter(m => m.id !== 'r'), new Set()), undefined);
  assert.equal(completedWorkHubDraft([...messages, { type: 'turn_state', id: 'f', turnId: 't', ts: 6, status: 'failed' }], new Set()), undefined);
});
test('unrelated replies and ambiguous code blocks are not draft content', () => {
  assert.equal(completedWorkHubDraft(messages.map(m => m.type === 'assistant' ? { ...m, turnId: 'other' } : m), new Set()), undefined);
  assert.equal(completedWorkHubDraft(messages.map(m => m.type === 'assistant' ? { ...m, text: m.text + '\n```text\nother\n```' } : m), new Set()), undefined);
});
