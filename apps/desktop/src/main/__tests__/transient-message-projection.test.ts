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

test('canonicalizing one send does not hide a later transient send', () => {
  const second = {
    ...transient,
    id: 'message-2',
    turnId: 'message-2',
    ts: 4,
    text: 'send next',
  };
  const pending = new Map([
    [transient.id, transient],
    [second.id, second],
  ]);
  const canonical = { ...transient, ts: 3, text: 'canonical send' };

  const projected = reconcileTransientMessages(pending, [canonical]);

  assert.deepEqual(projected, [canonical, second]);
  assert.deepEqual([...pending.keys()], ['message-2']);
});

test('keeps a transient message in submission order inside a sparse durable tail', () => {
  const pending = new Map([[transient.id, transient]]);
  const durable: StoredMessage[] = [
    { type: 'user', id: 'old-user', turnId: 'old-turn', ts: 1, text: 'before' },
    {
      type: 'assistant',
      id: 'later-assistant',
      turnId: 'turn-1',
      ts: 3,
      text: 'after',
      modelId: 'model-1',
    },
  ];

  const projected = reconcileTransientMessages(pending, durable);

  assert.deepEqual(projected.map((message) => message.id), [
    'old-user',
    'message-1',
    'later-assistant',
  ]);
});

test('keeps a transient message out of a sparse historical range', () => {
  const live = { ...transient, id: 'message-live', turnId: 'message-live', text: 'latest prompt' };
  const old = { ...transient, id: 'message-old', turnId: 'turn-old', ts: 1, text: 'old prompt' };
  const pending = new Map([[live.id, live]]);
  const historical = [old];

  const projected = reconcileTransientMessages(pending, historical, {
    includeTransient: false,
  });

  assert.deepEqual(projected.map((message) => message.id), ['message-old']);
  assert.equal(pending.has('message-live'), true);
});
