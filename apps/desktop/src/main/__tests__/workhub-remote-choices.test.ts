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
import type { InteractionRequest } from '@maka/core/interaction';
import { formatRemoteChoices, parseRemoteChoices } from '../workhub-remote-choices.js';

const request: InteractionRequest = { kind: 'question', toolUseId: 'ask', questions: ['项目', '范围', '测试'].map((question) => ({ question, options: ['甲', '乙', '丙'].map((label) => ({ label })) })) };
test('three questions travel in one message; ACC and 133 produce the same exact answers', () => {
  const text = formatRemoteChoices(request, 'abcd1234')!;
  for (const label of ['1. 项目\n\nA. 甲', '2. 范围', '3. 测试', '#abcd1234', 'C. 丙']) assert.ok(text.includes(label));
  assert.ok(!text.includes('A/1'));
  assert.ok(text.endsWith('按题顺序回复，如 AAA。'));
  const expected = { kind: 'answer', answer: { kind: 'question', answers: ['甲', '丙', '丙'] } };
  assert.deepEqual(parseRemoteChoices(request, 'ACC'), expected);
  assert.deepEqual(parseRemoteChoices(request, '133'), expected);
  assert.deepEqual(parseRemoteChoices(request, 'a / c / c'), expected);
});
test('bad count and out-of-range answers stay invalid; prose stays text', () => {
  for (const text of ['AC', '144', 'AZC', 'A / / C']) assert.equal(parseRemoteChoices(request, text).kind, 'invalid');
  assert.equal(parseRemoteChoices(request, '先修改 Maka，测试稍后再说').kind, 'text');
  assert.equal(parseRemoteChoices(request, 'please explain the choices').kind, 'text');
});
test('task chooser sends opaque option values, and multi-select preserves all selections', () => {
  const form: InteractionRequest = { kind: 'form', toolUseId: 'choose', message: '选择任务', requester: { name: 'WorkHub' }, fields: [
    { kind: 'single_select', name: 'target', label: '任务', required: true, options: [{ label: 'Maka', value: 'opaque-ref' }, { label: '新任务', value: 'create_new' }] },
    { kind: 'multi_select', name: 'scope', label: '范围', required: true, minItems: 1, maxItems: 2, options: [{ label: 'UI', value: 'ui' }, { label: 'Host', value: 'host' }, { label: 'Runtime', value: 'runtime' }] },
  ] };
  assert.deepEqual(parseRemoteChoices(form, 'B / AC'), { kind: 'answer', answer: { kind: 'form', action: 'accept', values: { target: 'create_new', scope: ['ui', 'runtime'] } } });
  assert.equal(parseRemoteChoices(form, 'A / ABC').kind, 'invalid');
  assert.equal(parseRemoteChoices(form, 'A / AA').kind, 'invalid');
});
test('recent work picker separates progress and next step and accepts nxt without selecting work', () => {
  const recent: InteractionRequest = { kind: 'question', toolUseId: 'ask', questions: [{
    question: '最近的工作:', options: [
      { label: 'SQL 入门', description: '进度：第 1 题待回答 → 下一步：写查询并检查' },
      { label: '取消', description: '不生成任何草稿，也不开始任何工作' },
    ],
  }] };
  assert.equal(formatRemoteChoices(recent, '7bbc30d2'), [
    '待回答 #7bbc30d2', '', '最近的工作:', 'A. SQL 入门',
    '进度：第 1 题待回答', '下一步：写查询并检查', '', 'B. 取消', '',
    '回复选项生成下一步 prompt, 回复 nxt 查看更多工作',
  ].join('\n'));
  for (const text of ['nxt', ' NXT ']) assert.deepEqual(parseRemoteChoices(recent, text), {
    kind: 'answer', answer: { kind: 'question', answers: ['nxt'] },
  });
  assert.deepEqual(parseRemoteChoices(recent, 'a'), {
    kind: 'answer', answer: { kind: 'question', answers: ['SQL 入门'] },
  });
  assert.equal(parseRemoteChoices(request, 'nxt').kind, 'invalid');
});
