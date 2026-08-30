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
import { compactNumberFormatter } from '../../renderer/features/workbar/testing.js';

test('formats context-window capacity with stable K/M units in every UI locale', () => {
  for (const locale of ['en', 'zh'] as const) {
    const format = compactNumberFormatter(locale);

    assert.equal(format(256_000), '256K');
    assert.equal(format(1_000_000), '1M');
  }
});

test('formats context-window capacity with at most one decimal and promotes rounded K values to M', () => {
  const format = compactNumberFormatter('en');

  assert.equal(format(999), '999');
  assert.equal(format(1_000), '1K');
  assert.equal(format(8_192), '8.2K');
  assert.equal(format(69_000), '69K');
  assert.equal(format(69_194), '69.2K');
  assert.equal(format(990_000), '990K');
  assert.equal(format(999_950), '1M');
  assert.equal(format(1_250_000), '1.3M');
});
