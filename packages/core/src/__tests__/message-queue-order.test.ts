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
import { exactQueueReorder, moveQueueEntryId } from '../message-queue-order.js';

const entries = [{ entryId: 'a' }, { entryId: 'b' }, { entryId: 'c' }] as const;

test('exact reorder accepts one permutation of every current entry', () => {
  const reordered = exactQueueReorder(entries, ['b', 'a', 'c']);
  assert.deepEqual(
    reordered?.entries.map((entry) => entry.entryId),
    ['b', 'a', 'c'],
  );
  assert.equal(reordered?.changed, true);
  assert.equal(exactQueueReorder(entries, ['a', 'b', 'c'])?.changed, false);
});

test('exact reorder rejects missing, extra, duplicate, and unknown ids', () => {
  assert.equal(exactQueueReorder(entries, ['a', 'b']), undefined);
  assert.equal(exactQueueReorder(entries, ['a', 'b', 'c', 'd']), undefined);
  assert.equal(exactQueueReorder(entries, ['a', 'a', 'c']), undefined);
  assert.equal(exactQueueReorder(entries, ['a', 'b', 'd']), undefined);
});

test('drag movement preserves the existing target-index behavior', () => {
  assert.deepEqual(moveQueueEntryId(['a', 'b', 'c'], 'b', 'a'), ['b', 'a', 'c']);
  assert.deepEqual(moveQueueEntryId(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.equal(moveQueueEntryId(['a', 'b'], 'a', 'missing'), undefined);
});
