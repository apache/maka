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
import { buildRuntimeHostActiveQuitDialog } from '../runtime-host-quit-copy.js';

test('quit dialog defaults to preserving background work', () => {
  const active = buildRuntimeHostActiveQuitDialog('en');

  assert.equal(active.decisions[active.options.defaultId ?? -1], 'cancel');
  assert.deepEqual(active.decisions, ['quit', 'cancel']);
});

test('quit dialog copy promises durable recovery in every locale', () => {
  const english = buildRuntimeHostActiveQuitDialog('en').options.detail ?? '';
  const chinese = buildRuntimeHostActiveQuitDialog('zh-CN').options.detail ?? '';
  const traditional = buildRuntimeHostActiveQuitDialog('zh-TW').options.detail ?? '';

  assert.match(english, /durable state/);
  assert.match(chinese, /持久状态/);
  assert.match(traditional, /持久狀態/);
});
