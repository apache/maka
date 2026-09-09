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
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import { createAppShellSessionUiStateController } from '../../renderer/app-shell-session-ui-state.js';

test('queue_update events drive the independent desktop queue projection', () => {
  const controller = createAppShellSessionUiStateController();
  const transientMessages: unknown[] = [];
  const removedTransientMessageIds: string[] = [];
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'zh-CN',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    projectQueuedTransientMessages: (_sessionId, messages) => transientMessages.push(...messages),
    removeTransientMessage: (_sessionId, messageId) =>
      removedTransientMessageIds.push(messageId),
    showModelSetupToast() {},
    toastApi: { error() {} },
  });
  const steeringEntry = {
    entryId: 'entry-steer',
    messageId: 'message-steer',
    content: { text: 'adjust this run' },
    placement: 'current_turn' as const,
    state: 'queued' as const,
  };
  const inFlightEntry = {
    ...steeringEntry,
    state: 'in_flight' as const,
  };

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-1',
    turnId: 'turn-1',
    ts: 1,
    queueRevision: 3,
    steering: ['adjust this run'],
    followup: ['do this next'],
    steeringEntries: [steeringEntry],
    followupEntries: [{
      entryId: 'entry-next',
      messageId: 'message-next',
      content: { text: 'do this next' },
      placement: 'next_turn',
      state: 'queued',
    }],
  });

  assert.deepEqual(controller.getState().messageQueueBySession['session-1'], {
    queueRevision: 3,
    entries: [
      steeringEntry,
      {
        entryId: 'entry-next',
        messageId: 'message-next',
        content: { text: 'do this next' },
        placement: 'next_turn',
        state: 'queued',
      },
    ],
  });
  assert.deepEqual(transientMessages, [
    {
      id: 'message-steer',
      transientPlacement: 'current_turn',
      hostTurnId: 'turn-1',
      ts: 1,
      text: 'adjust this run',
    },
    {
      id: 'message-next',
      transientPlacement: 'next_turn',
      ts: 1,
      text: 'do this next',
    },
  ]);

  handlers.handleEvent('session-1', {
    type: 'steering_message',
    id: 'steering-message-steer',
    turnId: 'turn-1',
    messageId: 'message-steer',
    ts: 2,
    content: { text: 'adjust this run' },
  });
  assert.deepEqual(removedTransientMessageIds, ['message-steer']);
  assert.deepEqual(controller.getState().messageQueueBySession['session-1'], {
    queueRevision: 3,
    entries: [{
      entryId: 'entry-next',
      messageId: 'message-next',
      content: { text: 'do this next' },
      placement: 'next_turn',
      state: 'queued',
    }],
  });

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-2',
    turnId: 'turn-1',
    ts: 3,
    queueRevision: 4,
    steering: ['adjust this run'],
    followup: ['do this next'],
    steeringEntries: [inFlightEntry],
    followupEntries: [{
      entryId: 'entry-next',
      messageId: 'message-next',
      content: { text: 'do this next' },
      placement: 'next_turn',
      state: 'queued',
    }],
  });
  assert.deepEqual(controller.getState().messageQueueBySession['session-1']?.entries, [{
    entryId: 'entry-next',
    messageId: 'message-next',
    content: { text: 'do this next' },
    placement: 'next_turn',
    state: 'queued',
  }]);
  assert.deepEqual(removedTransientMessageIds, ['message-steer']);
  assert.equal(transientMessages.length, 3, 'in-flight queue projection must not re-add the row');

  handlers.handleEvent('session-1', {
    type: 'message_admission',
    id: 'retracted-message-next',
    turnId: 'turn-1',
    ts: 4,
    messageId: 'message-next',
    outcome: 'retracted',
  });
  assert.deepEqual(removedTransientMessageIds, ['message-steer', 'message-next']);
});

test('steering delivery clears a promoted follow-up from the desktop queue', () => {
  const controller = createAppShellSessionUiStateController();
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'en',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    showModelSetupToast() {},
    toastApi: { error() {} },
  });

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-followup',
    turnId: 'turn-1',
    ts: 1,
    queueRevision: 1,
    steering: [],
    followup: ['adjust this run'],
    steeringEntries: [],
    followupEntries: [{
      entryId: 'entry-followup',
      messageId: 'message-followup',
      content: { text: 'adjust this run' },
      placement: 'next_turn',
      state: 'queued',
    }],
  });
  assert.equal(controller.getState().messageQueueBySession['session-1']?.entries.length, 1);

  handlers.handleEvent('session-1', {
    type: 'steering_message',
    id: 'steering-message-followup',
    turnId: 'turn-1',
    messageId: 'message-followup',
    ts: 2,
    content: { text: 'adjust this run' },
  });

  assert.equal(controller.getState().messageQueueBySession['session-1'], undefined);
});

test('complete events deliver the durable context compaction outcome to Desktop', () => {
  const controller = createAppShellSessionUiStateController();
  const outcomes: unknown[] = [];
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'en',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    showModelSetupToast() {},
    toastApi: { error() {} },
    onContextCompactionOutcome(sessionId, turnId, outcome) {
      outcomes.push({ sessionId, turnId, outcome });
    },
  });

  handlers.handleEvent('session-1', {
    type: 'complete',
    id: 'complete-1',
    turnId: 'compact-turn-1',
    ts: 1,
    stopReason: 'end_turn',
    contextCompactionOutcome: { kind: 'compacted', checkpointId: 'checkpoint-1' },
  });

  assert.deepEqual(outcomes, [
    {
      sessionId: 'session-1',
      turnId: 'compact-turn-1',
      outcome: { kind: 'compacted', checkpointId: 'checkpoint-1' },
    },
  ]);
});
