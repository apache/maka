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
import { foldTimeline } from '../timeline-fold.js';
import type { TurnTimelineItem } from '../materialize.js';

const commentary: TurnTimelineItem = { kind: 'text', messageId: 'c', text: 'Checking files' };
const thinking: TurnTimelineItem = { kind: 'thinking', messageId: 'r', text: 'Reasoning' };
const tools: TurnTimelineItem = { kind: 'tools', items: [{ toolUseId: 'read', toolName: 'read', args: {}, status: 'completed' }] };
const answer: TurnTimelineItem = { kind: 'text', messageId: 'a', text: 'Fixed' };

test('folds interleaved commentary and tools together without changing their order', () => {
  const input = [commentary, thinking, tools, { ...commentary, messageId: 'c2' }, tools, answer];
  const result = foldTimeline(input);
  assert.deepEqual(result, [{ kind: 'processing', id: 'start', children: input.slice(0, -1) }, answer]);
  assert.equal(input.length, 6, 'does not mutate the source projection');
});

test('keeps inserted user instructions and each segment reply outside disclosures', () => {
  const steering: TurnTimelineItem = { kind: 'user', messageId: 'steer', message: { id: 'steer', role: 'user', text: 'Also add tests', ts: 2 } };
  assert.deepEqual(foldTimeline([commentary, tools, answer, steering, thinking, tools, answer]), [
    { kind: 'processing', id: 'start', children: [commentary, tools] }, answer, steering,
    { kind: 'processing', id: 'steer', children: [thinking, tools] }, answer,
  ]);
});

test('does not promote text followed by tools to the final answer', () => {
  assert.deepEqual(foldTimeline([commentary, tools]), [{ kind: 'processing', id: 'start', children: [commentary, tools] }]);
});

test('leaves plain replies alone and includes reasoning in the process', () => {
  assert.deepEqual(foldTimeline([answer]), [answer]);
  assert.deepEqual(foldTimeline([thinking, answer]), [{ kind: 'processing', id: 'start', children: [thinking] }, answer]);
  assert.deepEqual(foldTimeline([]), []);
});

test('process identity survives tool projection and a new commentary step', () => {
  const before = foldTimeline([commentary, tools]);
  const after = foldTimeline([commentary, thinking, answer]);
  assert.equal(before[0]?.kind === 'processing' && before[0].id, 'start');
  assert.equal(after[0]?.kind === 'processing' && after[0].id, 'start');
});


test('keeps a reply visible when only reasoning follows it', () => {
  assert.deepEqual(foldTimeline([commentary, tools, answer, thinking]), [
    { kind: 'processing', id: 'start', children: [commentary, tools, thinking] }, answer,
  ]);
  assert.deepEqual(foldTimeline([commentary, tools, thinking]), [
    { kind: 'processing', id: 'start', children: [commentary, tools, thinking] },
  ]);
});
