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
  for (const label of ['1. 项目', '2. 范围', '3. 测试', '#abcd1234', 'C/3. 丙']) assert.ok(text.includes(label));
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
