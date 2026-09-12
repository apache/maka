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
import { parseContextWindowInput } from '../../renderer/features/connection-settings/index.js';

test('context windows preserve integers and parse decimal K/M without rounding', () => {
  const cases: Array<[string, number]> = [
    ['1', 1], ['128000', 128_000], ['000128000', 128_000],
    ['128k', 128_000], ['128K', 128_000], ['1000k', 1_000_000],
    ['1M', 1_000_000], ['1m', 1_000_000], ['1.5M', 1_500_000],
    [' \t1.5m\n', 1_500_000], ['0.001k', 1], ['1.001K', 1001],
    ['1.000001M', 1_000_001], ['128000.0', 128_000], ['1.0000k', 1000],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['9007199254.740991M', Number.MAX_SAFE_INTEGER],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseContextWindowInput(input), expected, input);
  }
});

test('context windows reject malformed, fractional, nonpositive and unsafe values', () => {
  for (const input of [
    '', ' ', '0', '0M', '-1', '-1M', 'NaN', 'Infinity',
    '1MB', '1MiB', '1e6', '1kk', '1 M', '1.5', '0.0001K', '1.0000001M',
    '1.', '.5M', '1.2.3M', '9007199254740992', '9007199254.740992M',
    '9007199254740991.1', '999999999999999999999M',
  ]) {
    assert.equal(parseContextWindowInput(input), null, input);
  }
});
