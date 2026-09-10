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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider, type TransientUserMessageProjection } from '@maka/ui';
import { ConversationServicesProvider, SessionLocalMessages } from '../../renderer/features/conversation/index.js';
import type { DesktopLocalMessage } from '../../shared/session-local-contract.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import { createAppShellSessionUiStateController } from '../../renderer/app-shell-session-ui-state.js';

afterEach(cleanupFakeDom);

test('local delivery recovery cannot republish accepted Host queue rows', async () => {
  const { root } = installReactRenderer();
  const transient = new Map<string, TransientUserMessageProjection>();
  let changed!: (sessionId: string) => void;
  let messages: DesktopLocalMessage[] = ['steering', 'followup', 'root'].map((messageId) => ({
    sessionId: 'session-1', messageId, createdAt: 1, state: 'unknown', canCancel: false,
    text: messageId, attachments: [], inlineReferences: [],
    placement: messageId === 'steering' ? 'current_turn' : 'next_turn',
  }));
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ConversationServicesProvider, { services: {
      listMessages: async () => messages,
      subscribeChanges: (handler) => { changed = handler; return () => {}; },
      cancelMessage: async () => {}, reconcileMessage: async () => {},
    }, children: createElement(SessionLocalMessages, {
      sessionId: 'session-1',
      publish: (_id, message) => { transient.set(message.id, message); },
      retire: (_id, messageId) => { transient.delete(messageId); },
      reportError: (message) => { throw new Error(message); },
    }) }),
  })));
  assert.equal(transient.get('steering')?.deliveryActions?.length, 1, 'unconfirmed sends retain their receipt check');
  messages = messages.map((message) => ({ ...message, state: 'accepted', ...(message.messageId === 'root' ? { turnId: 'started-turn' } : {}) }));
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root']);
  assert.equal(transient.get('root')?.transientPlacement, 'current_turn');
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root'], 'a retained local copy cannot resurrect a withdrawn queue entry');
});

test('queue_update events drive the independent desktop queue projection', () => {
  const controller = createAppShellSessionUiStateController();
  const transientMessages = new Set(['message-steer', 'message-next']);
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'zh-CN',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    removeTransientMessage: (_sessionId, messageId) =>
      transientMessages.delete(messageId),
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
  assert.equal(transientMessages.size, 0, 'Host evidence retires local placeholders');

  handlers.handleEvent('session-1', {
    type: 'steering_message',
    id: 'steering-message-steer',
    turnId: 'turn-1',
    messageId: 'message-steer',
    ts: 2,
    content: { text: 'adjust this run' },
  });
  assert.equal(transientMessages.size, 0);
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
  assert.equal(transientMessages.size, 0);
  assert.equal(transientMessages.size, 0, 'in-flight queue projection must not re-add a local row');

  handlers.handleEvent('session-1', {
    type: 'message_admission',
    id: 'retracted-message-next',
    turnId: 'turn-1',
    ts: 4,
    messageId: 'message-next',
    outcome: 'retracted',
  });
  assert.equal(transientMessages.size, 0);
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
