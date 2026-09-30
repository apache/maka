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
  reconcileTransientMessages,
  withQueuedSteeringTransients,
} from '../../renderer/application/contracts/transient-message-projection.js';

/** The durable Message that replaces the transient row above. */
function canonicalSend(): StoredMessage {
  return { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 3, text: 'canonical send' };
}

const transient: TransientUserMessageProjection = {
  id: 'message-1',
  ts: 2,
  text: 'send now',
  transientPlacement: 'transcript',
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

test('queued steering derives a transcript bubble that lives and dies with the snapshot', async () => {
  const queueEntry = {
    entryId: 'steer',
    messageId: 'message-steer',
    content: { text: 'raw', displayText: 'steer', quotes: [{ text: 'context' }] },
    placement: 'current_turn' as const,
    state: 'queued' as const,
  };
  const followupEntry = {
    entryId: 'next',
    messageId: 'message-next',
    content: { text: 'follow up' },
    placement: 'next_turn' as const,
    state: 'queued' as const,
  };
  const queue = { ts: 7, entries: [queueEntry, followupEntry] };
  const retracted: string[] = [];
  const restored: string[] = [];
  let failRetract = false;
  const actions = {
    locale: 'en' as const,
    retract: async (entryId: string) => {
      if (failRetract) throw new Error('retract failed');
      retracted.push(entryId);
    },
    restoreDraft: (draft: { text: string }) => { restored.push(draft.text); },
  };
  const localCopy = { ...transient, id: 'message-steer', text: 'local copy' };

  const derived = withQueuedSteeringTransients([transient, localCopy], queue, actions);

  assert.deepEqual(derived.map((message) => message.id), ['message-1', 'message-steer'],
    'the queue-owned bubble replaces its stored local copy, and a queued follow-up stays out of the transcript');
  const bubble = derived.at(-1);
  assert.equal(bubble?.text, 'steer');
  assert.deepEqual(bubble?.quotes, [{ text: 'context' }]);
  assert.deepEqual(bubble?.deliveryActions?.map((action) => action.label), ['Edit', 'Delete']);
  failRetract = true;
  await bubble?.deliveryActions?.[0]?.onClick();
  assert.deepEqual(restored, [], 'a failed retract restores nothing');
  failRetract = false;
  await bubble?.deliveryActions?.[0]?.onClick();
  assert.deepEqual([retracted, restored], [['steer'], ['steer']], 'edit retracts, then hands the text back');
  await bubble?.deliveryActions?.[1]?.onClick();
  assert.deepEqual([retracted, restored], [['steer', 'steer'], ['steer']], 'delete retracts without a draft');

  assert.equal(
    withQueuedSteeringTransients([transient], { ...queue, entries: [] }, actions).length,
    1,
    'an entry gone from the snapshot leaves no bubble behind',
  );
  assert.equal(
    withQueuedSteeringTransients([transient], undefined, actions).length,
    1,
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

test('keeps a transient message send time when a later update carries a new timestamp', () => {
  const first = { ...transient, ts: 2 };
  const later = { ...transient, ts: 9, text: 'edited text' };

  assert.deepEqual(mergeTransientMessageProjection(first, later), { ...later, ts: 2 });
});
