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
import { calculate } from '../../../../plugins/application/calculator/calculate.ts';

test('evaluates arithmetic with the usual precedence', () => {
  for (const [input, expected] of [
    ['1 + 2 * 3', '7'],
    ['(1 + 2) * 3', '9'],
    ['2 ^ 3 ^ 2', '512'],
    ['-2 ^ 2', '-4'],
    ['2 - -3', '5'],
    ['200 * 50%', '100'],
    ['0.1 + 0.2', '0.3'],
    ['6 × 7', '42'],
    ['（1 + 1） ÷ 4', '0.5'],
  ]) {
    assert.equal(calculate(input), expected, input);
  }
});

test('converts between units of one dimension', () => {
  assert.equal(calculate('1 km to m'), '1000 m');
  assert.equal(calculate('2 * 3 kg in g'), '6000 g');
  assert.equal(calculate('1 GiB to MiB'), '1024 mib');
  assert.equal(calculate('10km 转 m'), '10000 m');
});

test('leaves everything that is not a calculation to the Bot', () => {
  for (const input of [
    '',
    '2024',
    '-5',
    'hello',
    'what is 1 + 1',
    '1 km to kg',
    '1 foo to bar',
    '1 / 0',
    '1 +',
    '(1 + 2',
    '1 2 + 3',
    '.+1',
    `1${'+1'.repeat(200)}`,
  ]) {
    assert.equal(calculate(input), null, input);
  }
});
