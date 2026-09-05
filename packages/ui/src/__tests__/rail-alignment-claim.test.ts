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
import { resolveRailAlignedTarget } from '../chat-view.js';

test('a rail claim aims its own navigation and nothing after it', () => {
  // The click, before the shell has published anything.
  let claim = resolveRailAlignedTarget({ turnId: 'a' }, undefined).claim;
  assert.deepEqual(claim, { turnId: 'a' });

  // The load the click asked for. The reveal has to agree with the rail.
  let resolved = resolveRailAlignedTarget(claim, { turnId: 'a', nonce: 1 });
  assert.equal(resolved.target?.align, 'start');
  claim = resolved.claim;

  // Still the same command, re-rendered while the loaded range settles.
  resolved = resolveRailAlignedTarget(claim, { turnId: 'a', nonce: 1 });
  assert.equal(resolved.target?.align, 'start');
  claim = resolved.claim;

  // A later search for the same Turn is a different command, and wants the
  // search contract back.
  resolved = resolveRailAlignedTarget(claim, { turnId: 'a', nonce: 2 });
  assert.equal(resolved.target?.align, 'center');
  assert.equal(resolved.claim, undefined);
});

test('a search for another Turn spends an unconsumed rail claim', () => {
  const resolved = resolveRailAlignedTarget({ turnId: 'a' }, { turnId: 'b', nonce: 1 });
  assert.equal(resolved.target?.align, 'center');
  assert.equal(resolved.claim, undefined);
});

test('a search with no rail claim behind it is centred', () => {
  const resolved = resolveRailAlignedTarget(undefined, { turnId: 'a', nonce: 1 });
  assert.equal(resolved.target?.align, 'center');
  assert.deepEqual(resolved.target, { turnId: 'a', nonce: 1, align: 'center' });
});
