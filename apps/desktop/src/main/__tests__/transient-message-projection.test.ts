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
import type { StoredMessage } from '@maka/core/session';
import { reconcileTransientMessages } from '../../renderer/transient-message-projection.js';

const transient: StoredMessage = {
  type: 'user',
  id: 'message-1',
  turnId: 'turn-1',
  ts: 2,
  text: 'send now',
};

test('keeps a transient message through sparse transcript replacement', () => {
  const pending = new Map([[transient.id, transient]]);
  const projected = reconcileTransientMessages(pending, []);

  assert.deepEqual(projected, [transient]);
  assert.equal(pending.has(transient.id), true);
});

test('replaces a transient message by canonical message id exactly once', () => {
  const pending = new Map([[transient.id, transient]]);
  const canonical = { ...transient, ts: 3, text: 'canonical send' };
  const projected = reconcileTransientMessages(pending, [canonical]);

  assert.deepEqual(projected, [canonical]);
  assert.equal(pending.size, 0);
});
