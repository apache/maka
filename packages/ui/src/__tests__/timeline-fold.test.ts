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
import { finalAssistantReplyText, type TurnViewModel } from '../materialize.js';

const commentary: TurnTimelineItem = { kind: 'text', messageId: 'c', text: 'Checking files' };
const thinking: TurnTimelineItem = { kind: 'thinking', messageId: 'r', text: 'Reasoning' };
const tools: TurnTimelineItem = { kind: 'tools', items: [{ toolUseId: 'read', toolName: 'read', args: {}, status: 'completed' }] };
const answer: TurnTimelineItem = { kind: 'text', messageId: 'a', text: 'Fixed' };

test('display and copy share reply identity across process, steering and interrupted boundaries', () => {
  const steering: TurnTimelineItem = { kind: 'user', messageId: 'steer', message: { id: 'steer', role: 'user', text: 'Continue', ts: 2 } };
  const partial: TurnTimelineItem = { ...answer, messageId: 'partial', interrupted: true, text: 'Partial' };
  const cases: Array<[TurnTimelineItem[], Extract<TurnTimelineItem, { kind: 'text' }> | undefined]> = [
    [[commentary, tools], undefined],
    [[commentary, tools, answer, thinking], answer],
    [[answer, steering], undefined],
    [[answer, steering, commentary, tools], undefined],
    [[partial], partial],
    [[partial, tools], undefined],
    [[partial, tools, answer], answer],
    [[], undefined],
  ];
  for (const [timeline, expected] of cases) {
    const projection = foldTimeline(timeline);
    assert.equal(projection.finalReply, expected, 'preserves the source message identity');
    if (expected) assert.ok(projection.entries.includes(expected));
    const turn = { timeline, assistant: { text: 'obsolete aggregate' } } as TurnViewModel;
    assert.equal(finalAssistantReplyText(turn), expected?.kind === 'text' ? expected.text : '');
  }
});

test('folds interleaved commentary and tools together without changing their order', () => {
  const input = [commentary, thinking, tools, { ...commentary, messageId: 'c2' }, tools, answer];
  const result = foldTimeline(input).entries;
  assert.deepEqual(result, [{ kind: 'processing', id: 'start', children: input.slice(0, -1) }, answer]);
  assert.equal(input.length, 6, 'does not mutate the source projection');
});

test('keeps inserted user instructions and each segment reply outside disclosures', () => {
  const steering: TurnTimelineItem = { kind: 'user', messageId: 'steer', message: { id: 'steer', role: 'user', text: 'Also add tests', ts: 2 } };
  assert.deepEqual(foldTimeline([commentary, tools, answer, steering, thinking, tools, answer]).entries, [
    { kind: 'processing', id: 'start', children: [commentary, tools] }, answer, steering,
    { kind: 'processing', id: 'steer', children: [thinking, tools] }, answer,
  ]);
});

test('does not promote text followed by tools to the final answer', () => {
  assert.deepEqual(foldTimeline([commentary, tools]).entries, [{ kind: 'processing', id: 'start', children: [commentary, tools] }]);
});

test('leaves plain replies alone and includes reasoning in the process', () => {
  assert.deepEqual(foldTimeline([answer]).entries, [answer]);
  assert.deepEqual(foldTimeline([thinking, answer]).entries, [{ kind: 'processing', id: 'start', children: [thinking] }, answer]);
  assert.deepEqual(foldTimeline([]).entries, []);
});

test('process identity survives tool projection and a new commentary step', () => {
  const before = foldTimeline([commentary, tools]).entries;
  const after = foldTimeline([commentary, thinking, answer]).entries;
  assert.equal(before[0]?.kind === 'processing' && before[0].id, 'start');
  assert.equal(after[0]?.kind === 'processing' && after[0].id, 'start');
});


test('keeps a reply visible when only reasoning follows it', () => {
  assert.deepEqual(foldTimeline([commentary, tools, answer, thinking]).entries, [
    { kind: 'processing', id: 'start', children: [commentary, tools, thinking] }, answer,
  ]);
  assert.deepEqual(foldTimeline([commentary, tools, thinking]).entries, [
    { kind: 'processing', id: 'start', children: [commentary, tools, thinking] },
  ]);
});
