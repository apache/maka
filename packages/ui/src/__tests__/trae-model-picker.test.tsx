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
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import { modelMenuGroups, modelMenuRows, exactModelChoiceValue } from '../chat-model-helpers.js';

const choices: ChatModelChoice[] = (['standard', 'max'] as const).map((mode) => ({
  connectionId: 'employee-account', connectionSlug: 'trae', providerType: 'trae', providerLabel: 'Trae',
  model: `sol:${mode}`, label: `Sol · ${mode === 'max' ? 'Max' : 'Standard'}`, isDefault: mode === 'standard',
  thinkingLevels: ['high', 'xhigh'], contextWindow: mode === 'max' ? 800000 : 272000,
  trae: { configName: 'sol', mode, loadPercent: 174, loadUpdatedAt: 1789723255000 },
}));

test('Trae menu groups are headed by account variant and number only repeated variants', () => {
  const account = (slug: string, traeAccount: ChatModelChoice['traeAccount']): ChatModelChoice => ({
    ...choices[0]!, connectionId: slug, connectionSlug: slug, ...(traeAccount ? { traeAccount } : {}),
  });
  const headings = (list: ChatModelChoice[], locale: 'zh-CN' | 'en' = 'en') =>
    modelMenuGroups(list, locale).map((group) => group.heading);
  assert.deepEqual(headings([account('trae', 'cn'), account('trae-2', 'sg')]), ['Trae · CN', 'Trae · SG']);
  assert.deepEqual(
    headings([account('trae', 'sg'), account('trae-2', 'sg'), account('trae-3', 'sg-solo')]),
    ['Trae · SG', 'Trae · SG · 2', 'Trae · SG SOLO'],
  );
  assert.deepEqual(headings([account('trae', 'employee')]), ['Trae · ByteDance SSO']);
  assert.deepEqual(headings([account('trae', 'employee')], 'zh-CN'), ['Trae · 字节员工 SSO']);
  // A legacy connection without the variant keeps the slug fallback; its sibling still gets the variant.
  assert.deepEqual(headings([account('trae', undefined), account('trae-2', 'cn')]), ['Trae · trae', 'Trae · CN']);
});

test('Trae rows merge variants within one account and retain the active exact route', () => {
  const rows = modelMenuRows(choices, exactModelChoiceValue('employee-account', 'trae', 'sol:max'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.label, 'Sol');
  assert.equal(rows[0]?.choice.model, 'sol:max');
  assert.equal(rows[0]?.key, modelMenuRows(choices)[0]?.key, 'switching context preserves row identity');
  const otherAccount = choices.map((choice) => ({ ...choice, connectionId: 'other-account' }));
  assert.equal(modelMenuRows([...choices, ...otherAccount]).length, 2);
  assert.equal(modelMenuRows(choices.slice(1))[0]?.standard, undefined);
});
