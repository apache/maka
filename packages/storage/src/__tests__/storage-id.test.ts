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
import { assertSafeStorageId, isSafeStorageId } from '../storage-id.js';

test('accepts the complete safe storage identifier boundary', () => {
  assert.equal(isSafeStorageId('a'), true);
  assert.equal(isSafeStorageId('A0_-'), true);
  assert.equal(isSafeStorageId('x'.repeat(128)), true);
});

test('rejects unsafe storage identifier values', () => {
  for (const value of [
    '',
    'x'.repeat(129),
    ' leading',
    'trailing ',
    'nested/path',
    'punctuation.',
    undefined,
    null,
    42,
    {},
  ]) {
    assert.equal(isSafeStorageId(value), false, `expected rejection for ${String(value)}`);
  }
  assert.throws(() => assertSafeStorageId('bad/id', 'custom storage id error'), {
    name: 'TypeError',
    message: 'custom storage id error',
  });
});
