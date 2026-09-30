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
import {
  LocaleProvider,
  ToastProvider,
  type ComposerHandle,
  type TransientUserMessageProjection,
} from '@maka/ui';
import { ConversationServicesProvider, SessionLocalMessages } from '../../renderer/features/conversation/index.js';
import { stubConversationServices, useSessionMessageQueue } from '../../renderer/features/conversation/testing.js';
import type { RestoredDraftContent } from '../../renderer/application/contracts/transient-message-projection.js';
import type { DesktopLocalMessage } from '../../shared/session-local-contract.js';
import { mergeTransientMessageProjection } from '../../renderer/application/contracts/transient-message-projection.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { createAppShellSessionEventHandlers } from '../../renderer/features/conversation/testing.js';
import { createAppShellSessionUiStateController } from '../../renderer/features/conversation/testing.js';

afterEach(cleanupFakeDom);

test('local delivery recovery cannot republish accepted Host queue rows', async () => {
  const { root } = installReactRenderer();
  const transient = new Map<string, TransientUserMessageProjection>();
  let changed!: (sessionId: string) => void;
  const cancelled: string[][] = [];
  const reconciled: string[][] = [];
  const restored: string[][] = [];
  let messages: DesktopLocalMessage[] = ['steering', 'followup', 'root'].map((messageId) => ({
    sessionId: 'session-1', messageId, createdAt: 1, state: 'unknown', canCancel: false,
    text: messageId, attachments: [], inlineReferences: [],
    placement: messageId === 'steering' ? 'current_turn' : 'next_turn',
    ...(messageId === 'root' ? { localDisplayPlacement: 'current_turn' as const } : {}),
  }));
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ConversationServicesProvider, { services: stubConversationServices({
      listMessages: async () => messages,
      subscribeChanges: (handler) => { changed = handler; return () => {}; },
      cancelMessage: async (sessionId, messageId) => { cancelled.push([sessionId, messageId]); },
      reconcileMessage: async (sessionId, messageId) => { reconciled.push([sessionId, messageId]); },
    }), children: createElement(SessionLocalMessages, {
      sessionId: 'session-1',
      publish: (_id, message) => {
        const current = transient.get(message.id);
        transient.set(message.id, current ? mergeTransientMessageProjection(current, message) : message);
      },
      retire: (_id, messageId) => { transient.delete(messageId); },
      reportError: (message) => { throw new Error(message); },
      restoreDraft: (sessionId, draft) => { restored.push([sessionId, draft.text]); },
    }) }),
  })));
  const steering = transient.get('steering');
  assert.equal(steering?.deliveryStatus, 'Delivery unconfirmed. Do not send again.');
  assert.deepEqual(steering?.deliveryActions?.map((action) => action.label), ['Check delivery'],
    'an unconfirmed send offers only its receipt check, never cancellation');
  const placements = () => Object.fromEntries([...transient].map(([id, message]) => [id, message.transientPlacement]));
  assert.deepEqual(placements(), { steering: 'transcript', followup: 'follow_up', root: 'transcript' });
  await act(async () => { await steering?.deliveryActions?.[0]?.onClick(); });
  assert.deepEqual(reconciled, [['session-1', 'steering']]);
  assert.equal(transient.has('steering'), true, 'checking delivery does not retire the row');
  messages = messages.map((message) => ({ ...message, state: 'saved', canCancel: true }));
  await act(async () => changed('session-1'));
  const followup = transient.get('followup');
  assert.equal(followup?.deliveryStatus, 'Waiting to send');
  assert.deepEqual(followup?.deliveryActions?.map((action) => action.label), ['Edit', 'Delete unsent message']);
  await act(async () => { await followup?.deliveryActions?.[0]?.onClick(); });
  assert.deepEqual(cancelled, [['session-1', 'followup']]);
  assert.deepEqual(restored, [['session-1', 'followup']],
    'editing a never-dispatched message returns its text to the composer');
  assert.equal(transient.has('followup'), false, 'edit retires the local row');
  messages = messages.filter((message) => message.messageId !== 'followup')
    .map((message) => ({ ...message, delivering: true }));
  await act(async () => changed('session-1'));
  assert.equal(transient.get('root')?.deliveryStatus, undefined, 'a message Main will deliver shows nothing');
  assert.deepEqual(transient.get('root')?.deliveryActions, []);
  messages = messages.map((message) => ({ ...message, error: 'Saved locally. Waiting for the Host to become available.' }));
  await act(async () => changed('session-1'));
  assert.equal(transient.get('root')?.deliveryStatus, 'Waiting to send');
  assert.equal(transient.get('root')?.deliveryActions?.length, 2, 'a Host outage keeps the copy editable and removable');
  messages = messages.map((message) => ({ ...message, state: 'failed' }));
  await act(async () => changed('session-1'));
  assert.deepEqual(placements(), { steering: 'transcript', root: 'transcript' }, 'failed delivery moves nothing');
  messages = messages.map((message) => ({ ...message, state: 'accepted', ...(message.messageId === 'root' ? { turnId: 'started-turn' } : {}) }));
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root']);
  assert.equal(transient.get('root')?.transientPlacement, 'transcript');
  assert.equal(transient.get('root')?.deliveryStatus, undefined, 'an accepted send shows only its time');
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root'], 'a retained local copy cannot resurrect a withdrawn queue entry');
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
  const inFlightEntry = {
    ...steeringEntry,
    state: 'in_flight' as const,
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
    id: 'message-next', text: 'do this next', ts: 1, transientPlacement: 'follow_up',
  });
  transientMessages.set('message-steer', {
    id: 'message-steer', text: 'adjust this run', ts: 1, transientPlacement: 'transcript',
  });

  handlers.handleEvent('session-1', queueUpdate([steeringEntry]));

  assert.deepEqual(controller.getState().messageQueueBySession['session-1'], {
    ts: 1,
    queueRevision: 3,
    entries: [steeringEntry, followupEntry],
  });
  assert.equal(transientMessages.size, 0,
    'the store keeps no copy of entries the Host snapshot now owns — queued steering derives from it at render');

  const nextEntry = {
    entryId: 'entry-next',
    messageId: 'message-next',
    content: { text: 'do this next' },
    placement: 'next_turn' as const,
    state: 'queued' as const,
  };
  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-2',
    turnId: 'turn-1',
    ts: 3,
    queueRevision: 4,
    steering: ['adjust this run'],
    followup: ['do this next'],
    steeringEntries: [inFlightEntry],
    followupEntries: [nextEntry],
  });
  assert.deepEqual(
    controller.getState().messageQueueBySession['session-1']?.entries,
    [inFlightEntry, nextEntry],
    'a pulled message stays pending until the runtime places it',
  );
  assert.equal(transientMessages.size, 0, 'in-flight queue projection must not re-add a local row');

  handlers.handleEvent('session-1', {
    type: 'steering_message',
    id: 'steering-message-steer',
    turnId: 'turn-1',
    messageId: 'message-steer',
    ts: 4,
    content: { text: 'adjust this run' },
  });
  assert.equal(transientMessages.size, 0);
  assert.deepEqual(controller.getState().messageQueueBySession['session-1'], {
    ts: 3,
    queueRevision: 4,
    entries: [nextEntry],
  });

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

test('a rootless resubscription seed retires a stale queued card', () => {
  // Switch away → the queue drains rootless → navigate back. The projector's
  // rootless seed now carries the authoritative queue (apache/maka#5520
  // review), so the card the client kept from before it left must go.
  const controller = createAppShellSessionUiStateController();
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'zh-CN',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    removeTransientMessage: () => {},
    showModelSetupToast() {},
    toastApi: { error() {} },
  });

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-1',
    turnId: 'turn-1',
    ts: 1,
    queueRevision: 3,
    steering: ['adjust this run'],
    followup: [],
    steeringEntries: [
      {
        entryId: 'entry-steer',
        messageId: 'message-steer',
        content: { text: 'adjust this run' },
        placement: 'current_turn' as const,
        state: 'queued' as const,
      },
    ],
    followupEntries: [],
  });
  assert.ok(
    controller.getState().messageQueueBySession['session-1'],
    'the card is visible before the client leaves',
  );

  // The resubscription seed's authoritative empty queue: the drain landed
  // while the Session was inactive, and the root Turn is gone.
  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'host-queue:host-1:4',
    turnId: '',
    ts: 2,
    queueRevision: 4,
    steering: [],
    followup: [],
    steeringEntries: [],
    followupEntries: [],
  });
  assert.equal(
    controller.getState().messageQueueBySession['session-1'],
    undefined,
    'the stale card does not survive the resubscription',
  );
});

test('an empty queue_update clears the last-seen snapshot after an unobserved drain', async () => {
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
    removeTransientMessage: () => {},
    showModelSetupToast() {},
    toastApi: { error() {} },
  });

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-drained-before',
    turnId: 'turn-1',
    ts: 1,
    queueRevision: 2,
    steering: [],
    followup: ['do this next'],
    steeringEntries: [],
    followupEntries: [{
      entryId: 'entry-next',
      messageId: 'message-next',
      content: { text: 'do this next' },
      placement: 'next_turn',
      state: 'queued',
    }],
  });
  assert.equal(controller.getState().messageQueueBySession['session-1']?.entries.length, 1);

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-drained-after',
    turnId: 'turn-1',
    ts: 2,
    queueRevision: 3,
    steering: [],
    followup: [],
    steeringEntries: [],
    followupEntries: [],
  });
  assert.equal(controller.getState().messageQueueBySession['session-1'], undefined);
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

test('editing a queued message retracts it and restores its content under the owning Session', async () => {
  const { root } = installReactRenderer();
  const entry = {
    entryId: 'entry-1', messageId: 'message-1',
    placement: 'current_turn' as const, state: 'queued' as const,
    content: {
      text: 'steer it',
      attachments: [{
        kind: 'other' as const, name: 'a.png', mimeType: 'image/png', bytes: 1,
        ref: { kind: 'external_file' as const, absolutePath: '/tmp/a.png' },
      }],
      quotes: [{ text: 'quoted' }],
    },
  };
  const followUp = {
    entryId: 'entry-2', messageId: 'message-2',
    placement: 'next_turn' as const, state: 'queued' as const,
    content: { text: 'model text', displayText: 'follow up', directoryReferences: [{ hostId: 'h', path: '/repo' }] },
  };
  const retracted: string[][] = [];
  const restoredDrafts: [string, string][] = [];
  const restoredContext: [string, RestoredDraftContent][] = [];
  // The user navigated to another Session before the retract resolves.
  const activeSessionId = { current: 'session-b' as string | undefined };
  let surface!: ReturnType<typeof useSessionMessageQueue>;
  function Probe() {
    surface = useSessionMessageQueue({
      sessionId: 'session-a',
      queue: { entries: [entry, followUp], ts: 1 },
      transientMessages: [],
      activeSessionId,
    });
    return null;
  }
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ToastProvider, { children:
      createElement(ConversationServicesProvider, { services: stubConversationServices({
        sessions: {
          retractQueueEntry: async (sessionId: string, entryId: string) => {
            retracted.push([sessionId, entryId]);
          },
        },
      }), children: createElement(Probe) }) })})));
  surface.composer.current = {
    setText() {}, appendText() {}, getText: () => '', clearDraft() {},
    setDraft: (key, text) => { restoredDrafts.push([key, text]); },
    getDraft: () => '',
    appendDraft: (key, text) => { restoredDrafts.push([key, text]); },
    focus() {}, openModelPicker() {},
  } as ComposerHandle;
  surface.draftContextRestorer.current = (sessionId, draft) => { restoredContext.push([sessionId, draft]); };
  const bubble = surface.transientMessages.find((message) => message.id === entry.messageId);
  assert.ok(bubble, 'a queued steering entry derives a transcript bubble');
  const edit = bubble.deliveryActions?.find((action) => action.label === 'Edit');
  assert.ok(edit, 'the bubble offers edit');
  await act(async () => { await edit.onClick(); });
  assert.deepEqual(retracted, [['session-a', 'entry-1']]);
  assert.equal(restoredContext.length, 1);
  assert.equal(restoredContext[0]![0], 'session-a');
  assert.equal(restoredContext[0]![1].attachments, entry.content.attachments,
    'attachments ride back into the draft');
  assert.equal(restoredContext[0]![1].quotes, entry.content.quotes,
    'quotes ride back into the draft');
  assert.deepEqual(restoredDrafts, [['session-a', 'steer it']],
    'the draft lands under the owning Session even while another is active');

  // A queued follow-up row edits the same way: out of the queue, back into the draft.
  activeSessionId.current = 'session-a';
  await act(async () => { await surface.editQueuedEntry(followUp); });
  assert.deepEqual(retracted.at(-1), ['session-a', 'entry-2']);
  assert.deepEqual(restoredDrafts.at(-1), ['session-a', 'follow up']);
  assert.equal(restoredContext.at(-1)![1].directoryReferences, followUp.content.directoryReferences);
});
