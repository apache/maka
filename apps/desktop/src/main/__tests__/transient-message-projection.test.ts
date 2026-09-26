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
import { deriveMessageQueueProjection } from '../../renderer/application/contracts/message-queue-projection.js';
import {
  mergeTransientMessageProjection,
  projectQueuedTransientMessages,
  reconcileTransientMessages,
} from '../../renderer/application/contracts/transient-message-projection.js';

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

test('derives one queue projection for main and Side Conversation consumers', () => {
  const projection = deriveMessageQueueProjection({
    type: 'queue_update',
    id: 'queue-1',
    turnId: 'turn-1',
    ts: 7,
    steering: ['in flight', 'steer'],
    followup: ['next'],
    steeringEntries: [
      {
        entryId: 'in-flight',
        messageId: 'message-in-flight',
        content: { text: 'in flight' },
        placement: 'current_turn',
        state: 'in_flight',
      },
      {
        entryId: 'steer',
        messageId: 'message-steer',
        content: { text: 'raw', displayText: 'steer', quotes: [{ text: 'context' }] },
        placement: 'current_turn',
        state: 'queued',
      },
    ],
    followupEntries: [
      {
        entryId: 'next',
        messageId: 'message-next',
        content: { text: 'next' },
        placement: 'next_turn',
        state: 'queued',
      },
    ],
  });

  assert.deepEqual(projection.entries.map((entry) => entry.entryId), ['in-flight', 'steer', 'next']);
  assert.deepEqual(projection.transientMessages, [
    {
      id: 'message-in-flight',
      pendingSteering: true,
      transientPlacement: 'current_turn',
      hostTurnId: 'turn-1',
      ts: 7,
      text: 'in flight',
    },
    {
      id: 'message-steer',
      pendingSteering: true,
      transientPlacement: 'current_turn',
      hostTurnId: 'turn-1',
      ts: 7,
      text: 'steer',
      quotes: [{ text: 'context' }],
    },
    {
      id: 'message-next',
      transientPlacement: 'next_turn',
      ts: 7,
      text: 'next',
    },
  ]);
});

test('keeps a Host-bound current Turn when a later IPC result has no Turn identity', () => {
  const hostBound = { ...transient, id: 'message-current', hostTurnId: 'host-turn' };
  const lateIpcUpdate = { ...transient, id: 'message-current', text: 'uploaded content' };

  assert.deepEqual(mergeTransientMessageProjection(hostBound, lateIpcUpdate), {
    ...lateIpcUpdate,
    hostTurnId: 'host-turn',
  });
});

test('ordinary sends stay in the transcript through local delivery, including failed delivery', () => {
  const localOutbox = {
    ...transient, transientPlacement: 'next_turn' as const,
    deliveryStatus: 'Sending',
  };
  const pending = mergeTransientMessageProjection(transient, localOutbox);
  assert.equal(pending.transientPlacement, 'current_turn');
  assert.equal(pending.deliveryStatus, 'Sending');
  const failed = mergeTransientMessageProjection(pending, {
    ...localOutbox, deliveryStatus: 'Failed',
  });
  assert.equal(failed.transientPlacement, 'current_turn');
  assert.equal(failed.deliveryStatus, 'Failed');
  // The admission reply, unlike a local outbox update, can still move a
  // genuine follow-up above the composer.
  const queued = mergeTransientMessageProjection(pending, {
    ...transient, transientPlacement: 'next_turn', pendingSteering: false,
  });
  assert.equal(queued.transientPlacement, 'next_turn');
  assert.equal(queued.deliveryStatus, 'Sending');
  assert.equal(mergeTransientMessageProjection(queued, localOutbox).transientPlacement, 'next_turn');
});

test('an explicit follow-up stays in the pending plate during local delivery', () => {
  const localOutbox = {
    ...transient, transientPlacement: 'next_turn' as const,
    deliveryStatus: 'Sending',
  };
  const pending = mergeTransientMessageProjection({
    ...transient, transientPlacement: 'next_turn',
  }, localOutbox);
  assert.equal(pending.transientPlacement, 'next_turn');
  assert.equal(pending.deliveryStatus, 'Sending');
});

test('explicit steering stays in the composer queue during local outbox updates', () => {
  const steering = { ...transient, pendingSteering: true };
  const updated = mergeTransientMessageProjection(steering, {
    ...transient, transientPlacement: 'next_turn', deliveryStatus: 'Sending',
  });
  assert.equal(updated.transientPlacement, 'current_turn');
  assert.equal(updated.pendingSteering, true);
});

test('keeps a transient message send time when a later update carries a new timestamp', () => {
  const first = { ...transient, ts: 2 };
  const later = { ...transient, ts: 9, text: 'edited text' };

  assert.deepEqual(mergeTransientMessageProjection(first, later), { ...later, ts: 2 });
});

test('queue and late IPC projections preserve local delivery controls until canonical handoff', () => {
  const local = {
    ...transient, deliveryStatus: 'Checking delivery', deliveryTone: 'warning' as const,
    deliveryDiagnostic: 'lost acknowledgement', deliveryDiagnosticLabel: 'Delivery details',
    deliveryActions: [{ label: 'Check delivery', disabled: true, onClick() {} }],
  };
  const pending = new Map([[local.id, local]]);
  projectQueuedTransientMessages(pending, [{ ...transient, text: 'Host content' }]);
  const queued = pending.get(local.id)!;
  assert.equal(queued.text, 'Host content');
  assert.equal(queued.deliveryStatus, local.deliveryStatus);
  assert.equal(queued.deliveryTone, 'warning');
  assert.equal(queued.deliveryActions, local.deliveryActions);
  const accepted = mergeTransientMessageProjection(queued, {
    ...transient, deliveryTone: 'neutral', deliveryDiagnostic: undefined,
    deliveryActions: [], deliveryStatus: 'Delivered',
  });
  assert.equal(accepted.deliveryDiagnostic, undefined);
  assert.deepEqual(accepted.deliveryActions, []);
  assert.deepEqual(reconcileTransientMessages(pending, [canonicalSend()]), []);
});
