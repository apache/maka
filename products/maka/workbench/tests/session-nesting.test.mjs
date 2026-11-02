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
import { nestCreated } from '../app/sessionNesting.ts';

const session = (id, parentSessionId = null) => ({ id, parentSessionId });

test('conversations follow the conversation that created them, one level in', () => {
  const { order, nested } = nestCreated([
    session('child', 'parent'),
    session('other'),
    session('parent'),
    session('grandchild', 'child'),
  ]);
  assert.deepEqual(order, ['other', 'parent', 'child', 'grandchild']);
  assert.deepEqual([...nested].sort(), ['child', 'grandchild']);
});

test('a conversation whose creator is not in the group stays where it is', () => {
  const { order, nested } = nestCreated([session('a', 'elsewhere'), session('b')]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(nested.size, 0);
});

test('a creation cycle leaves every conversation listed once', () => {
  const { order } = nestCreated([session('a', 'b'), session('b', 'a'), session('c')]);
  assert.deepEqual([...order].sort(), ['a', 'b', 'c']);
  assert.equal(new Set(order).size, 3);
});
