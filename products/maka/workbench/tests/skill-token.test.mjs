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
import { hasSkillToken, skillTextGroups } from '../app/skillTokenText.ts';

test('skill messages join adjacent Unicode chunks and preserve gaps and source addresses', () => {
  const groups = skillTextGroups([
    { offset: 0, text: '前😀 /ski' },
    { offset: 12, text: 'll:review 后' },
    { offset: 100, text: 'suffix /skill:fix' },
  ]);
  assert.deepEqual(groups, [
    { offset: 0, text: '前😀 /skill:review 后' },
    { offset: 100, text: 'suffix /skill:fix' },
  ]);
  assert.equal(groups.every(hasSkillToken), true);
});

test('skill messages require a known invocation boundary', () => {
  for (const group of [
    { offset: 0, text: 'x/skill:no' },
    { offset: 0, text: '/skill:' },
    { offset: 80, text: '/skill:unknown-boundary' },
  ])
    assert.equal(hasSkillToken(group), false, JSON.stringify(group));
  for (const group of [
    { offset: 0, text: '/skill:yes-2.0_' },
    { offset: 80, text: ' /skill:known-boundary' },
    { offset: 0, text: '前\u3000/skill:one\n/skill:two' },
  ])
    assert.equal(hasSkillToken(group), true, JSON.stringify(group));
  const groups = skillTextGroups([
    { offset: 0, text: '/ski' },
    { offset: 80, text: 'll:no' },
  ]);
  assert.equal(groups.some(hasSkillToken), false);
});
