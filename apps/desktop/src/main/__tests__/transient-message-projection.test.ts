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
import type { TransientUserMessageProjection } from '@maka/ui';
import {
  mergeTransientMessageProjection,
  projectQueuedTransientMessages,
  reconcileTransientMessages,
} from '../../renderer/transient-message-projection.js';

/** The durable Message that replaces the transient row above. */
function canonicalSend(): StoredMessage {
  return { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 3, text: 'canonical send' };
}

const transient: TransientUserMessageProjection = {
  id: 'message-1',
  ts: 2,
  text: 'send now',
  transientPlacement: 'current_turn',
};

test('keeps a transient message through sparse transcript replacement', () => {
  const pending = new Map([[transient.id, transient]]);
  const projected = reconcileTransientMessages(pending, []);

  assert.deepEqual(projected, [transient]);
  assert.equal(pending.has(transient.id), true);
});

test('updates a transient message without treating its previous render as canonical', () => {
  const pending = new Map([[transient.id, transient]]);
  const firstProjection = reconcileTransientMessages(pending, []);
  const updated = {
    ...transient,
    quotes: [{ text: 'quoted context' }],
  };
  pending.set(updated.id, updated);

  const secondProjection = reconcileTransientMessages(pending, []);

  assert.deepEqual(firstProjection, [transient]);
  assert.deepEqual(secondProjection, [updated]);
  assert.equal(pending.has(updated.id), true);
});

test('replaces a transient message by canonical message id exactly once', () => {
  const pending = new Map([[transient.id, transient]]);
  const projected = reconcileTransientMessages(pending, [canonicalSend()]);

  assert.deepEqual(projected, []);
  assert.equal(pending.size, 0);
});

test('canonicalizing one send does not hide a later transient send', () => {
  const second = { ...transient, id: 'message-2', ts: 4, text: 'send next' };
  const pending = new Map([
    [transient.id, transient],
    [second.id, second],
  ]);
  const projected = reconcileTransientMessages(pending, [canonicalSend()]);

  assert.deepEqual(projected, [second]);
  assert.deepEqual([...pending.keys()], ['message-2']);
});

test('keeps transient messages ordered independently from a sparse durable tail', () => {
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

  assert.deepEqual(projected.map((message) => message.id), ['message-1']);
});

test('keeps a transient message out of a sparse historical range', () => {
  const live = { ...transient, id: 'message-live', text: 'latest prompt' };
  const pending = new Map([[live.id, live]]);
  const historical: StoredMessage[] = [
    { type: 'user', id: 'message-old', turnId: 'turn-old', ts: 1, text: 'old prompt' },
  ];

  const projected = reconcileTransientMessages(pending, historical, {
    includeTransient: false,
  });

  assert.deepEqual(projected, []);
  assert.equal(pending.has('message-live'), true);
});

test('uses the Host queue snapshot order for already-present transient messages', () => {
  const localSecond = {
    ...transient,
    id: 'message-2',
    turnId: 'message-2',
    text: 'second',
  };
  const remoteFirst = {
    ...transient,
    id: 'message-1',
    turnId: 'message-1',
    text: 'first',
  };
  const pending = new Map([[localSecond.id, localSecond]]);

  projectQueuedTransientMessages(pending, [remoteFirst, localSecond]);

  assert.deepEqual(
    reconcileTransientMessages(pending, []).map((message) => message.id),
    ['message-1', 'message-2'],
  );
});

test('keeps a Host-bound current Turn when a later IPC result has no Turn identity', () => {
  const hostBound = { ...transient, id: 'message-current', hostTurnId: 'host-turn' };
  const lateIpcUpdate = { ...transient, id: 'message-current', text: 'uploaded content' };

  assert.deepEqual(mergeTransientMessageProjection(hostBound, lateIpcUpdate), {
    ...lateIpcUpdate,
    hostTurnId: 'host-turn',
  });
});
