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
  const cancelled: string[][] = [];
  const reconciled: string[][] = [];
  const restored: string[][] = [];
  let messages: DesktopLocalMessage[] = [
    { sessionId: 'session-1', messageId: 'steering', createdAt: 1, state: 'unknown', canCancel: false,
      text: 'steering', attachments: [], inlineReferences: [], placement: 'current_turn' },
    { sessionId: 'session-1', messageId: 'followup', createdAt: 2, state: 'saved', canCancel: true,
      text: 'followup', attachments: [], inlineReferences: [], placement: 'next_turn' },
    { sessionId: 'session-1', messageId: 'root', createdAt: 3, state: 'unknown', canCancel: false,
      text: 'root', attachments: [], inlineReferences: [], placement: 'next_turn' },
  ];
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ConversationServicesProvider, { services: {
      listMessages: async () => messages,
      subscribeChanges: (handler) => { changed = handler; return () => {}; },
      cancelMessage: async (sessionId, messageId) => { cancelled.push([sessionId, messageId]); },
      reconcileMessage: async (sessionId, messageId) => { reconciled.push([sessionId, messageId]); },
      sessions: { list: async () => [], subscribeChanges: () => () => {}, readSnapshot: async () => { throw new Error('unexpected snapshot read'); } },
      skills: { listInvocable: async () => [] },
      workspace: { searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }) },
      newTasks: { subscribeChanges: () => () => {}, listInvocableSkills: async () => [], searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }) },
      mcp: { subscribeChanges: () => () => {} },
    }, children: createElement(SessionLocalMessages, {
      sessionId: 'session-1',
      publish: (_id, message) => { transient.set(message.id, message); },
      retire: (_id, messageId) => { transient.delete(messageId); },
      reportError: (message) => { throw new Error(message); },
      restoreDraft: (sessionId, text) => { restored.push([sessionId, text]); },
    }) }),
  })));
  const steering = transient.get('steering');
  assert.equal(steering?.deliveryStatus, 'Delivery unconfirmed. Do not send again.');
  assert.deepEqual(steering?.deliveryActions?.map((action) => action.label), ['Check delivery'],
    'an unconfirmed send offers only its receipt check, never cancellation');
  const followup = transient.get('followup');
  assert.equal(followup?.deliveryStatus, 'Waiting to send');
  assert.deepEqual(followup?.deliveryActions?.map((action) => action.label), ['Edit', 'Cancel sending']);
  await act(async () => { await steering?.deliveryActions?.[0]?.onClick(); });
  assert.deepEqual(reconciled, [['session-1', 'steering']]);
  assert.equal(transient.has('steering'), true, 'checking delivery does not retire the row');
  await act(async () => { await followup?.deliveryActions?.[0]?.onClick(); });
  assert.deepEqual(cancelled, [['session-1', 'followup']]);
  assert.deepEqual(restored, [['session-1', 'followup']],
    'editing a never-dispatched message returns its text to the composer');
  assert.equal(transient.has('followup'), false, 'edit retires the local row');
  messages = [
    { ...messages[0]!, state: 'failed', canCancel: true },
    { sessionId: 'session-1', messageId: 'settled', createdAt: 4, state: 'accepted', canCancel: false,
      text: 'settled', attachments: [], inlineReferences: [], placement: 'next_turn' },
    { ...messages[2]!, state: 'accepted', turnId: 'started-turn' },
    { sessionId: 'session-1', messageId: 'later', createdAt: 5, state: 'saved', canCancel: true,
      text: 'later', attachments: [], inlineReferences: [], placement: 'next_turn' },
  ];
  await act(async () => changed('session-1'));
  const failed = transient.get('steering');
  assert.equal(failed?.deliveryStatus, 'Could not send · message kept');
  assert.deepEqual(failed?.deliveryActions?.map((action) => action.label), ['Edit', 'Delete unsent message']);
  assert.deepEqual([...transient.keys()], ['steering', 'root', 'later']);
  assert.equal(transient.get('root')?.transientPlacement, 'current_turn');
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['steering', 'root', 'later'],
    'a retained local copy cannot resurrect a withdrawn queue entry');
});

test('queue_update stores the snapshot and retires every listed local placeholder', async () => {
  const controller = createAppShellSessionUiStateController();
  const transientMessages = new Map<string, TransientUserMessageProjection>();
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'zh-CN',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    removeTransientMessage: (_sessionId, messageId) => {
      transientMessages.delete(messageId);
    },
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
  const followupEntry = {
    entryId: 'entry-next',
    messageId: 'message-next',
    content: { text: 'do this next' },
    placement: 'next_turn' as const,
    state: 'queued' as const,
  };
  const queueUpdate = (steering: import('@maka/core/events').MessageQueueEntryProjection[]) => ({
    type: 'queue_update' as const,
    id: 'queue-1',
    turnId: 'turn-1',
    ts: 1,
    queueRevision: 3,
    steering: ['adjust this run'],
    followup: ['do this next'],
    steeringEntries: steering,
    followupEntries: [followupEntry],
  });
  transientMessages.set('message-next', {
    id: 'message-next', text: 'do this next', ts: 1, transientPlacement: 'next_turn',
  });
  transientMessages.set('message-steer', {
    id: 'message-steer', text: 'adjust this run', ts: 1, transientPlacement: 'current_turn',
    pendingSteering: true,
  });

  handlers.handleEvent('session-1', queueUpdate([steeringEntry]));

  assert.deepEqual(controller.getState().messageQueueBySession['session-1'], {
    turnId: 'turn-1',
    ts: 1,
    queueRevision: 3,
    entries: [steeringEntry, followupEntry],
  });
  assert.equal(transientMessages.size, 0,
    'the store keeps no copy of entries the Host snapshot now owns — queued steering derives from it at render');

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
