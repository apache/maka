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
import type { MessageQueueEntryProjection } from '@maka/core/events';
import { LocaleProvider, type TransientUserMessageProjection } from '@maka/ui';
import { ConversationServicesProvider, SessionLocalMessages, type ConversationServices } from '../../renderer/features/conversation/index.js';
import type { DesktopLocalMessage } from '../../shared/session-local-contract.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import { createAppShellSessionUiStateController } from '../../renderer/app-shell-session-ui-state.js';

afterEach(cleanupFakeDom);

function localDeliveryHarness(initial: readonly DesktopLocalMessage[]) {
  const { root } = installReactRenderer();
  const snapshots = new Map<string, readonly DesktopLocalMessage[]>([['session-1', initial]]);
  const transient = new Map<string, TransientUserMessageProjection>();
  const published: string[] = [];
  const retired: string[] = [];
  let changed: (sessionId: string) => void = () => {};
  const services: ConversationServices = {
    listMessages: async (sessionId) => snapshots.get(sessionId) ?? [],
    readFailedMessage: async () => { throw new Error('Failed-message drafts are not used in this test'); },
    subscribeChanges: (handler) => { changed = handler; return () => {}; },
    cancelMessage: async () => {}, reconcileMessage: async () => {},
    sessions: {
      readSnapshot: async () => { throw new Error('unexpected snapshot read'); },
      readExecutionBoundary: async () => { throw new Error('unexpected boundary read'); },
    },
    runtimeHosts: { subscribeChanges: () => () => {} },
    skills: { listInvocable: async () => [] },
    workspace: { searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    newTasks: { subscribeChanges: () => () => {}, listInvocableSkills: async () => [], searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    mcp: { subscribeChanges: () => () => {} },
  };
  const publish = (sessionId: string, message: TransientUserMessageProjection) => {
    const key = `${sessionId}:${message.id}`;
    published.push(key);
    transient.set(key, message);
  };
  const update = (sessionId: string, message: TransientUserMessageProjection) => {
    const key = `${sessionId}:${message.id}`;
    if (transient.has(key)) transient.set(key, message);
  };
  const retire = (sessionId: string, messageId: string) => {
    const key = `${sessionId}:${messageId}`;
    retired.push(key);
    transient.delete(key);
  };
  return {
    snapshots, transient, published, retired, services, retire,
    refresh: async (sessionId: string) => act(async () => changed(sessionId)),
    render: async (sessionId: string, queue: readonly MessageQueueEntryProjection[] = [], runningTurnIds: readonly string[] = []) => {
      await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
        createElement(ConversationServicesProvider, { services, children: createElement(SessionLocalMessages, {
          sessionId, queue, session: { runningTurnIds }, publish, update, retire,
          canRestoreDraft: () => true,
          restoreDraft: () => { throw new Error('Failed-message drafts are not used in this test'); },
        }) }),
      })));
    },
  };
}

test('a durable cancellation without a Turn retires its local row on the next snapshot', async () => {
  const message: DesktopLocalMessage = {
    sessionId: 'session-1', messageId: 'cancelled-without-turn', createdAt: 1,
    state: 'saved', canCancel: true, placement: 'next_turn',
    text: 'cancel this saved message', attachments: [], inlineReferences: [],
  };
  const harness = localDeliveryHarness([message]);
  await harness.render('session-1');
  assert.equal(harness.transient.size, 1);
  // Stop can remove the durable row without a rootTurnId, and therefore
  // without any queue, transcript, or message_admission retirement event.
  harness.snapshots.set('session-1', []);
  await harness.refresh('session-1');
  assert.equal(harness.transient.size, 0, 'an empty durable snapshot retires the local placeholder');
  assert.deepEqual(harness.retired, ['session-1:cancelled-without-turn']);
  await harness.refresh('session-1');
  assert.deepEqual(harness.retired, ['session-1:cancelled-without-turn'], 'unchanged empty snapshots do not repeat retirement');
  harness.snapshots.set('session-1', [message]);
  await harness.refresh('session-1');
  assert.equal(harness.transient.size, 0, 'a later stale row cannot recreate a retired message');
  harness.snapshots.set('session-1', [{ ...message, state: 'failed' }]);
  await harness.refresh('session-1');
  assert.equal(harness.transient.size, 0, 'a stale failure is not a new recovery transition after durable deletion');
  assert.deepEqual(harness.published, ['session-1:cancelled-without-turn']);
});

for (const initiallyQueued of [false, true]) {
  test(`a queue handoff can recover a definite failure without duplicate rows (initially queued: ${initiallyQueued})`, async () => {
    const message: DesktopLocalMessage = {
      sessionId: 'session-1', messageId: 'not-admitted', createdAt: 1,
      state: 'accepted', canCancel: false, placement: 'next_turn',
      text: 'recover this message', attachments: [], inlineReferences: [],
    };
    const queue: MessageQueueEntryProjection[] = [{
      entryId: 'entry-not-admitted', messageId: message.messageId,
      content: { text: message.text }, placement: 'next_turn', state: 'queued',
    }];
    const harness = localDeliveryHarness([message]);
    await harness.render('session-1', initiallyQueued ? queue : []);
    await harness.render('session-1', queue);
    assert.equal(harness.transient.size, 0, 'Host queue ownership retires the local placeholder');
    await harness.render('session-1');
    assert.equal(harness.transient.size, 0, 'queue removal alone does not recreate the local row');
    if (initiallyQueued) await harness.render('session-2');
    const failed: DesktopLocalMessage = { ...message, state: 'failed', canCancel: true };
    harness.snapshots.set('session-1', [failed]);
    if (initiallyQueued) await harness.render('session-1');
    else await harness.refresh('session-1');
    const recovered = harness.transient.get('session-1:not-admitted');
    assert.equal(recovered?.deliveryStatus, 'Message not sent');
    assert.deepEqual(recovered?.deliveryActions?.map((action) => action.label), ['Edit and resend', 'Delete failed message']);
    assert.deepEqual([...harness.transient.keys()], ['session-1:not-admitted'], 'recovery owns exactly one row for this message identity');
    await harness.refresh('session-1');
    await harness.render('session-2');
    await harness.render('session-1');
    assert.deepEqual([...harness.transient.keys()], ['session-1:not-admitted'], 'refreshes and Session switching cannot duplicate the failure');
    harness.services.cancelMessage = async () => { harness.snapshots.set('session-1', []); };
    const remove = harness.transient.get('session-1:not-admitted')?.deliveryActions?.find((action) => action.label === 'Delete failed message');
    assert.ok(remove);
    await act(async () => remove.onClick());
    assert.equal(harness.transient.size, 0, 'explicit deletion retires the recovered failure');
    const publishedBeforeStaleSnapshot = harness.published.length;
    harness.snapshots.set('session-1', [failed]);
    await harness.refresh('session-1');
    await harness.render('session-2');
    await harness.render('session-1');
    assert.equal(harness.transient.size, 0, 'a stale failure cannot undo deletion, including across Session switching');
    assert.equal(harness.published.length, publishedBeforeStaleSnapshot, 'deleted failures never publish again');
  });
}

test('a late Host retraction cannot hide a failed draft already settled by the local delivery worker', async () => {
  const failed: DesktopLocalMessage = {
    sessionId: 'session-1', messageId: 'already-not-admitted', createdAt: 1,
    state: 'failed', canCancel: true, placement: 'next_turn',
    text: 'keep this failed draft recoverable', attachments: [], inlineReferences: [],
  };
  const harness = localDeliveryHarness([failed]);
  const controller = createAppShellSessionUiStateController();
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'en', activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true, refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    removeTransientMessage: harness.retire,
    showModelSetupToast() {}, toastApi: { error() {} },
  });
  // Cross-epoch recovery can settle the durable row before the independent
  // observer resolves a removed queue entry for the same message identity.
  await harness.render('session-1');
  assert.equal(harness.transient.get('session-1:already-not-admitted')?.deliveryStatus, 'Message not sent');
  handlers.handleEvent('session-1', {
    type: 'message_admission', outcome: 'retracted', id: 'late-not-admitted',
    messageId: failed.messageId, turnId: 'previous-turn', ts: 2,
  });
  await harness.refresh('session-1');
  assert.equal(harness.transient.get('session-1:already-not-admitted')?.deliveryStatus, 'Message not sent',
    'a current failed snapshot must still expose the recovery actions after a late retraction');
});

test('durable snapshot retirement preserves Host queue and live Turn handoffs', async () => {
  const messages: DesktopLocalMessage[] = ['queued', 'started'].map((messageId) => ({
    sessionId: 'session-1', messageId, createdAt: 1, state: 'accepted', canCancel: false,
    text: messageId, attachments: [], inlineReferences: [], placement: 'next_turn',
    ...(messageId === 'started' ? { turnId: 'turn-1', admission: 'steering' as const } : {}),
  }));
  const harness = localDeliveryHarness(messages);
  const controller = createAppShellSessionUiStateController();
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'en', activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true, refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    removeTransientMessage: harness.retire,
    showModelSetupToast() {}, toastApi: { error() {} },
  });
  await harness.render('session-1');
  const queue: MessageQueueEntryProjection[] = [{
    entryId: 'entry-queued', messageId: 'queued', content: { text: 'queued' }, placement: 'next_turn', state: 'queued',
  }];
  handlers.handleEvent('session-1', {
    type: 'queue_update', id: 'queue-update', turnId: 'turn-1', ts: 2,
    steering: [], followup: ['queued'], steeringEntries: [], followupEntries: queue,
  });
  await harness.render('session-1', controller.getState().messageQueueBySession['session-1']?.entries, ['turn-1']);
  assert.deepEqual([...harness.transient.keys()], ['session-1:started']);
  handlers.handleEvent('session-1', {
    type: 'steering_message', id: 'steering-started', messageId: 'started',
    turnId: 'turn-1', ts: 3, content: { text: 'started' },
  });
  const liveTurn = controller.getState().liveTurnBySession['session-1'];
  assert.equal(liveTurn?.[0]?.steps[0]?.steering?.id, 'started');
  harness.snapshots.set('session-1', []);
  await harness.refresh('session-1');
  assert.equal(harness.transient.size, 0);
  assert.deepEqual(controller.getState().messageQueueBySession['session-1']?.entries, queue, 'durable cleanup does not remove a live Host queue entry');
  assert.equal(controller.getState().liveTurnBySession['session-1'], liveTurn, 'retirement only affects the transient layer');
  harness.snapshots.set('session-1', messages);
  await harness.refresh('session-1');
  await harness.render('session-1', [], ['turn-1']);
  assert.equal(harness.transient.size, 0, 'queue disappearance cannot recreate either handed-off row');
  assert.deepEqual(harness.published, ['session-1:queued', 'session-1:started']);
});

test('durable snapshot retirement is isolated from another Session and stale requests', async () => {
  const message: DesktopLocalMessage = {
    sessionId: 'session-1', messageId: 'same-id', createdAt: 1,
    state: 'saved', canCancel: true, placement: 'next_turn',
    text: 'first Session', attachments: [], inlineReferences: [],
  };
  const harness = localDeliveryHarness([message]);
  await harness.render('session-1');
  const listMessages = harness.services.listMessages;
  let completeOldSnapshot!: (messages: readonly DesktopLocalMessage[]) => void;
  harness.services.listMessages = async () => new Promise((resolve) => { completeOldSnapshot = resolve; });
  await harness.refresh('session-1');
  harness.services.listMessages = listMessages;
  harness.snapshots.set('session-2', [{ ...message, sessionId: 'session-2', text: 'second Session' }]);
  await harness.render('session-2');
  await act(async () => completeOldSnapshot([]));
  assert.equal(harness.transient.get('session-2:same-id')?.text, 'second Session');
  assert.deepEqual(harness.retired, [], 'a late snapshot from the old Session cannot retire either Session');
  harness.snapshots.set('session-2', []);
  await harness.refresh('session-2');
  assert.deepEqual([...harness.transient.keys()], ['session-1:same-id']);
  assert.deepEqual(harness.retired, ['session-2:same-id']);
  harness.snapshots.set('session-1', []);
  await harness.render('session-1');
  assert.equal(harness.transient.size, 0, 'returning to a Session reconciles rows deleted while it was inactive');
  assert.deepEqual(harness.retired, ['session-2:same-id', 'session-1:same-id']);
  harness.snapshots.set('session-2', [{ ...message, sessionId: 'session-2' }]);
  await harness.render('session-2');
  assert.equal(harness.transient.size, 0, 'switching Sessions cannot recreate a retired row from a stale snapshot');
  assert.deepEqual(harness.published, ['session-1:same-id', 'session-2:same-id']);
});

test('local delivery recovery respects started Turns without republishing accepted Host queue rows', async () => {
  const { root } = installReactRenderer();
  const transient = new Map<string, TransientUserMessageProjection>();
  let changed!: (sessionId: string) => void;
  let messages: DesktopLocalMessage[] = ['steering', 'followup', 'root'].map((messageId) => ({
    sessionId: 'session-1', messageId, createdAt: 1, state: 'unknown', canCancel: false,
    text: messageId, attachments: [], inlineReferences: [],
    placement: messageId === 'steering' ? 'current_turn' : 'next_turn',
    ...(messageId === 'root' ? { localDisplayPlacement: 'current_turn' as const } : {}),
  }));
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ConversationServicesProvider, { services: {
      listMessages: async () => messages,
      readFailedMessage: async () => { throw new Error('Failed-message drafts are not used in this test'); },
      subscribeChanges: (handler) => { changed = handler; return () => {}; },
      cancelMessage: async () => {}, reconcileMessage: async () => {},
      sessions: {
        readSnapshot: async () => { throw new Error('unexpected snapshot read'); },
        readExecutionBoundary: async () => { throw new Error('unexpected boundary read'); },
      },
      runtimeHosts: { subscribeChanges: () => () => {} },
      skills: { listInvocable: async () => [] },
      workspace: { searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }) },
      newTasks: { subscribeChanges: () => () => {}, listInvocableSkills: async () => [], searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }) },
      mcp: { subscribeChanges: () => () => {} },
    }, children: createElement(SessionLocalMessages, {
      sessionId: 'session-1', session: { localState: 'cached' }, queue: [],
      publish: (_id, message) => { transient.set(message.id, message); },
      update: (_id, message) => { if (transient.has(message.id)) transient.set(message.id, message); },
      retire: (_id, messageId) => { transient.delete(messageId); },
      canRestoreDraft: () => true,
      restoreDraft: () => { throw new Error('Failed-message drafts are not used in this test'); },
    }) }),
  })));
  assert.equal(transient.get('steering')?.deliveryActions?.length, 1, 'unconfirmed sends retain their receipt check');
  assert.equal(transient.get('steering')?.transientPlacement, 'current_turn');
  assert.equal(transient.get('root')?.transientPlacement, 'current_turn', 'a restored ordinary send stays in the transcript');
  assert.equal(transient.get('followup')?.transientPlacement, 'next_turn', 'an explicit follow-up stays queued');
  transient.delete('steering');
  transient.delete('followup');
  messages = messages.map((message) => ({ ...message, state: 'accepted', ...(message.messageId === 'root' ? { turnId: 'started-turn', admission: 'turn_started' as const } : {}) }));
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root']);
  assert.equal(transient.get('root')?.transientPlacement, 'current_turn');
  assert.equal(transient.get('root')?.hostTurnId, 'started-turn');
  assert.equal(transient.get('root')?.deliveryStatus, 'Reply started · waiting for an update', 'a cached receipt does not claim the Turn is still running');
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root'], 'a retained local copy cannot resurrect a withdrawn queue entry');
});

test('a Host queue seeded before the first local snapshot owns accepted and uncertain messages', async () => {
  const { root } = installReactRenderer();
  const transient = new Map<string, TransientUserMessageProjection>();
  let changed!: (sessionId: string) => void;
  let resolveInitial!: (messages: readonly DesktopLocalMessage[]) => void;
  const initial = new Promise<readonly DesktopLocalMessage[]>((resolve) => { resolveInitial = resolve; });
  let messages: DesktopLocalMessage[] = ['accepted', 'unknown', 'followup', 'failed'].map((messageId) => ({
    sessionId: 'session-1', messageId, createdAt: 1,
    state: messageId === 'unknown' ? 'unknown' : messageId === 'failed' ? 'failed' : 'accepted',
    canCancel: messageId === 'failed', text: messageId, attachments: [], inlineReferences: [],
    placement: messageId === 'followup' ? 'next_turn' : 'current_turn',
  }));
  let first = true;
  const services = {
    listMessages: async () => {
      if (!first) return messages;
      first = false;
      return initial;
    },
    readFailedMessage: async () => { throw new Error('Failed-message drafts are not used in this test'); },
    subscribeChanges: (handler: (sessionId: string) => void) => { changed = handler; return () => {}; },
    cancelMessage: async () => {}, reconcileMessage: async () => {},
    sessions: {
      readSnapshot: async () => { throw new Error('unexpected snapshot read'); },
      readExecutionBoundary: async () => { throw new Error('unexpected boundary read'); },
    },
    runtimeHosts: { subscribeChanges: () => () => {} },
    skills: { listInvocable: async () => [] },
    workspace: { searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }) },
    newTasks: { subscribeChanges: () => () => {}, listInvocableSkills: async () => [], searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }) },
    mcp: { subscribeChanges: () => () => {} },
  };
  const queue = messages.filter((message) => message.state !== 'failed').map((message) => ({
    entryId: `entry-${message.messageId}`, messageId: message.messageId,
    content: { text: message.text }, placement: message.placement, state: 'queued' as const,
  }));
  const render = (entries: typeof queue) => createElement(LocaleProvider, { locale: 'en', children:
    createElement(ConversationServicesProvider, { services, children: createElement(SessionLocalMessages, {
      sessionId: 'session-1', queue: entries,
      publish: (_id, message) => { transient.set(message.id, message); },
      update: (_id, message) => { if (transient.has(message.id)) transient.set(message.id, message); },
      retire: (_id, messageId) => { transient.delete(messageId); },
      canRestoreDraft: () => true,
      restoreDraft: () => { throw new Error('Failed-message drafts are not used in this test'); },
    }) }),
  });
  await act(async () => root.render(render([])));
  await act(async () => root.render(render(queue)));
  await act(async () => resolveInitial(messages));
  assert.deepEqual([...transient.keys()], ['failed'], 'a late local snapshot cannot duplicate Host-owned queue entries');

  messages = messages.map((message) => message.state === 'unknown' ? { ...message, state: 'accepted' } : message);
  await act(async () => root.render(render([])));
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['failed'], 'queue disappearance cannot republish handed-off messages or remove a failed draft');
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

test('an interaction request notifies that the turn is waiting on the user', () => {
  const controller = createAppShellSessionUiStateController();
  const notified: unknown[] = [];
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
    notifyRunEnded(payload) {
      notified.push(payload);
    },
  });

  handlers.handleEvent('session-1', {
    type: 'user_question_request',
    id: 'question-1',
    turnId: 'turn-1',
    ts: 1,
    requestId: 'request-1',
    toolUseId: 'tool-1',
    questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }],
  });

  assert.deepEqual(notified, [{ kind: 'waiting', sessionId: 'session-1', body: 'Which branch?' }]);
});
