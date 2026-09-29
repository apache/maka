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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { DesktopSessionLocalStore } from '../session-local-store.js';
import { DesktopSessionLocalService, registerDesktopSessionLocalIpc, type DesktopSessionLocalTarget } from '../session-local-service.js';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import type { MessageQueueEntryProjection } from '@maka/core/events';
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
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import { createAppShellSessionUiStateController } from '../../renderer/app-shell-session-ui-state.js';

afterEach(cleanupFakeDom);

function localDeliveryHarness(initial: readonly DesktopLocalMessage[]) {
  const { root } = installReactRenderer();
  const snapshots = new Map<string, readonly DesktopLocalMessage[]>([['session-1', initial]]);
  const transient = new Map<string, TransientUserMessageProjection>();
  const published: string[] = [];
  const retired: string[] = [];
  const restored: Array<[string, RestoredDraftContent]> = [];
  const draftState = { empty: true, available: true };
  const released: string[] = [];
  let changed: (sessionId: string) => void = () => {};
  const services = stubConversationServices({
    listMessages: async (sessionId) => snapshots.get(sessionId) ?? [],
    readFailedMessage: async () => { throw new Error('Failed-message drafts are not used in this test'); },
    releaseRecoveryAttachments: async (ids) => { released.push(...ids); },
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
  });
  const publish = (sessionId: string, message: TransientUserMessageProjection) => {
    const key = `${sessionId}:${message.id}`;
    published.push(key);
    const current = transient.get(key);
    transient.set(key, current ? mergeTransientMessageProjection(current, message) : message);
  };
  const update = (sessionId: string, message: TransientUserMessageProjection) => {
    const key = `${sessionId}:${message.id}`;
    const current = transient.get(key);
    if (current) transient.set(key, mergeTransientMessageProjection(current, message));
  };
  const retire = (sessionId: string, messageId: string) => {
    const key = `${sessionId}:${messageId}`;
    retired.push(key);
    transient.delete(key);
  };
  return {
    snapshots, transient, published, retired, restored, services, retire, draftState, released,
    refresh: async (sessionId: string) => act(async () => changed(sessionId)),
    render: async (sessionId: string, queue: readonly MessageQueueEntryProjection[] = [], runningTurnIds: readonly string[] = []) => {
      await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children:
        createElement(ConversationServicesProvider, { services, children: createElement(SessionLocalMessages, {
          sessionId, queue, session: { runningTurnIds }, publish, update, retire,
          canRestoreDraft: () => draftState.empty,
          restoreUnsentDraft: (id, draft) => {
            if (!draftState.available) return false;
            restored.push([id, draft]); return true;
          },
          restoreDraft: () => { throw new Error('Failed-message drafts are not used in this test'); },
        }) }),
      })));
    },
  };
}

test('navigation during unsent editing releases the unused approval without deleting the original', async () => {
  const message: DesktopLocalMessage = {
    sessionId: 'session-1', messageId: 'unsent', createdAt: 1, state: 'saved', canCancel: true,
    placement: 'next_turn', text: 'display summary', attachments: [], inlineReferences: [],
  };
  const harness = localDeliveryHarness([message]);
  let complete!: (draft: import('../../shared/session-local-contract.js').DesktopLocalMessageDraft) => void;
  let calls = 0;
  harness.services.cancelMessage = async (id, messageId, options) => {
    assert.equal(id, 'session-1'); assert.equal(messageId, 'unsent');
    assert.deepEqual(options, { restoreDraft: true }); calls++;
    return new Promise((resolve) => { complete = resolve; });
  };
  await harness.render('session-1');
  const edit = harness.transient.get('session-1:unsent')!.deliveryActions![0]!;
  let pending: void | Promise<void>;
  await act(async () => { pending = edit.onClick(); edit.onClick(); });
  assert.equal(calls, 1, 'same-tick activation is guarded before React renders');
  assert.deepEqual(harness.restored, [], 'nothing is restored until cancellation succeeds');
  await harness.render('session-2');
  const draft = {
    messageId: 'unsent', text: 'full original input', attachments: [],
    stagedAttachments: [{ approvalId: 'local-recovery:unsent', name: 'note.txt', size: 14 }],
    directoryReferences: [], quotes: [], inlineReferences: [],
  };
  await act(async () => { complete(draft); await pending; });
  assert.deepEqual(harness.restored, []);
  assert.deepEqual(harness.released, ['local-recovery:unsent']);
  assert.equal(harness.transient.has('session-1:unsent'), true);
  harness.snapshots.set('session-1', [{ ...message, state: 'paused' }]);
  await harness.render('session-1');
  assert.equal(harness.transient.get('session-1:unsent')?.deliveryStatus, 'Sending paused');
});

for (const refusal of ['unmounted', 'new-draft'] as const) {
  test(`unsent restoration refused by ${refusal} retains paused recovery actions`, async () => {
    const harness = localDeliveryHarness([{
      sessionId: 'session-1', messageId: 'unsent', createdAt: 1, state: 'saved', canCancel: true,
      placement: 'next_turn', text: 'original', attachments: [], inlineReferences: [],
    }]);
    harness.services.cancelMessage = async () => {
      if (refusal === 'unmounted') harness.draftState.available = false;
      else harness.draftState.empty = false;
      return { messageId: 'unsent', text: 'original', attachments: [], directoryReferences: [], quotes: [], inlineReferences: [],
        stagedAttachments: [{ approvalId: 'local-recovery:unused', name: 'note.txt', size: 1 }] };
    };
    let resumes = 0;
    harness.services.resumeMessage = async () => { resumes++; };
    await harness.render('session-1');
    await act(async () => { await harness.transient.get('session-1:unsent')!.deliveryActions![0]!.onClick(); });
    const row = () => harness.transient.get('session-1:unsent')!;
    assert.deepEqual(harness.restored, []);
    assert.deepEqual(harness.released, ['local-recovery:unused']);
    assert.equal(row().deliveryStatus, 'Sending paused');
    assert.match(row().deliveryDetail!, refusal === 'unmounted' ? /Unable to restore/ : /current draft/);
    assert.deepEqual(row().deliveryActions!.map((action) => action.label), ['Edit', 'Continue sending', 'Delete unsent message']);
    assert.equal(resumes, 0, 'a refused restore never resumes automatically');
    harness.draftState.empty = false;
    await act(async () => { await row().deliveryActions![1]!.onClick(); });
    assert.equal(resumes, 0, 'an edited draft must be discarded before sending the original');
    harness.draftState.empty = true;
    assert.equal(resumes, 0, 'discarding edits alone keeps sending paused');
    await act(async () => { await row().deliveryActions![1]!.onClick(); });
    assert.equal(resumes, 1);
  });
}

for (const text of ['original text', '']) {
  test(`deleting an edited paused original is blocked and its ${text ? 'text and attachment' : 'attachment-only'} replacement remains sendable`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-paused-delete-'));
    const store = new DesktopSessionLocalStore(join(directory, 'client.sqlite'));
    const target: DesktopSessionLocalTarget = {
      partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
    };
    const service = new DesktopSessionLocalService(store, { targets: () => [target], changed() {}, onError: assert.fail });
    t.after(async () => { service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
    const staged = [{ name: 'note.txt', mimeType: 'text/plain', base64: Buffer.from('retained bytes').toString('base64') }];
    store.enqueue(target.partition, {
      command: { sessionId: 'session-1', messageId: 'original', placement: 'next_turn', content: { text } }, staged,
    });
    type Ipc = Parameters<typeof registerDesktopSessionLocalIpc>[0]['ipcMain'];
    const handlers = new Map<string, Parameters<Ipc['handle']>[1]>();
    registerDesktopSessionLocalIpc({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
      service, approvals: createAttachmentApprovalRegistry(), resizeImage: async (bytes) => bytes,
      resolveWorkspace: async () => { throw new Error('Unexpected workspace request'); }, changed() {},
    });
    const event = { sender: { id: 7 } } as IpcMainInvokeEvent;
    const harness = localDeliveryHarness(service.listMessages(target, 'session-1'));
    let deletes = 0;
    harness.services.cancelMessage = async (sessionId, messageId, options) => {
      if (!options?.restoreDraft) deletes++;
      return handlers.get('session-local:cancel')!(event, target.scope, sessionId, messageId, options);
    };
    await harness.render('session-1');
    const action = (label: string) => harness.transient.get('session-1:original')!.deliveryActions!.find((item) => item.label === label)!;
    await act(async () => { await action('Edit').onClick(); });
    // The live context changes without a render, including a bodyless attachment edit.
    harness.draftState.empty = false;
    await act(async () => { await action('Delete unsent message').onClick(); });
    assert.equal(deletes, 0);
    assert.equal(store.get(target.partition, 'original')?.state, 'paused');
    const storedBytes = (messageId: string) => store.stagedAttachments(target.partition, messageId)
      .map(({ content, ...metadata }) => ({ ...metadata, base64: Buffer.from(content).toString('base64') }));
    assert.deepEqual(storedBytes('original'), staged);
    const blockedDetail = harness.transient.get('session-1:original')!.deliveryDetail!;
    assert.match(blockedDetail, /Unable to delete this paused message/);
    assert.match(blockedDetail, /composer is available and has no draft, attachments or references/);
    const draft = harness.restored[0]![1];
    const sent = await handlers.get('session-local:submit')!(event, target.scope, 'session-1', 'next_turn', {
      messageId: 'edited', text, replacesLocalMessageId: draft.replacesLocalMessageId,
      attachmentItems: draft.stagedAttachments,
    });
    assert.equal(sent.ok, true);
    assert.equal(store.get(target.partition, 'original'), undefined);
    assert.equal(store.get(target.partition, 'edited')?.state, 'saved');
    assert.deepEqual(storedBytes('edited'), staged);
  });
}

test('a paused original can be deleted after the draft and context are cleared', async () => {
  const harness = localDeliveryHarness([{
    sessionId: 'session-1', messageId: 'paused', createdAt: 1, state: 'paused', canCancel: true,
    placement: 'next_turn', text: 'original', attachments: [], inlineReferences: [],
  }]);
  let deletes = 0;
  harness.services.cancelMessage = async () => { deletes++; };
  await harness.render('session-1');
  const remove = () => harness.transient.get('session-1:paused')!.deliveryActions!.find((item) => item.label === 'Delete unsent message')!;
  harness.draftState.empty = false;
  await act(async () => { await remove().onClick(); });
  assert.equal(deletes, 0);
  harness.draftState.empty = true;
  await act(async () => { await remove().onClick(); });
  assert.equal(deletes, 1);
  assert.equal(harness.transient.has('session-1:paused'), false);
});

test('a failed unsent withdrawal leaves the row and draft untouched', async () => {
  const harness = localDeliveryHarness([{
    sessionId: 'session-1', messageId: 'unsent', createdAt: 1, state: 'saved', canCancel: true,
    placement: 'next_turn', text: 'keep', attachments: [], inlineReferences: [],
  }]);
  harness.services.cancelMessage = async () => { throw new Error('Host claimed the message'); };
  await harness.render('session-1');
  await act(async () => { await harness.transient.get('session-1:unsent')!.deliveryActions![0]!.onClick(); });
  assert.deepEqual(harness.restored, []);
  assert.equal(harness.transient.has('session-1:unsent'), true);
  assert.match(harness.transient.get('session-1:unsent')!.deliveryDetail!, /Unable to update/);
});

for (const admission of ['followup', 'steering'] as const) {
  test(`an accepted ${admission} first seen without its Host queue stays retired until a definite failure`, async () => {
    const accepted: DesktopLocalMessage = {
      sessionId: 'session-1', messageId: 'accepted', createdAt: 1,
      state: 'accepted', admission, canCancel: false,
      placement: admission === 'steering' ? 'current_turn' : 'next_turn',
      text: 'Host owns this queued message', attachments: [], inlineReferences: [],
    };
    const root: DesktopLocalMessage = {
      ...accepted, messageId: 'root', text: 'keep the started prompt',
      turnId: 'root-turn', admission: 'turn_started', localDisplayPlacement: 'current_turn',
    };
    const harness = localDeliveryHarness([accepted, root]);
    await harness.render('session-1', []);
    assert.deepEqual([...harness.transient.keys()], ['session-1:root'], 'a durable queue receipt is not an actionable local queue row');
    assert.deepEqual(harness.published, ['session-1:root'], 'never publish the orphan even on the first snapshot');
    assert.equal(harness.transient.get('session-1:root')?.hostTurnId, 'root-turn');
    assert.equal(harness.transient.get('session-1:root')?.transientPlacement, 'transcript');
    await harness.refresh('session-1');
    assert.deepEqual([...harness.transient.keys()], ['session-1:root']);
    harness.snapshots.set('session-1', [{ ...accepted, state: 'failed', canCancel: true }, root]);
    await harness.refresh('session-1');
    const recovered = harness.transient.get('session-1:accepted');
    assert.equal(recovered?.deliveryStatus, 'Message not sent');
    assert.deepEqual(recovered?.deliveryActions?.map((action) => action.label), ['Edit and resend', 'Delete failed message']);
    assert.equal(harness.transient.size, 2, 'handoff is not a durable deletion tombstone');
  });
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
    sessionId: 'session-1', messageId, createdAt: 1,
    state: messageId === 'queued' ? 'unknown' : 'accepted', canCancel: false,
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
      readFailedMessage: async () => { throw new Error('Failed-message drafts are not used in this test'); },
      releaseRecoveryAttachments: async () => {},
      subscribeChanges: (handler) => { changed = handler; return () => {}; },
      cancelMessage: async (sessionId, messageId, options) => {
        cancelled.push([sessionId, messageId]);
        if (options?.restoreDraft) return {
          messageId, text: messageId, attachments: [], stagedAttachments: [],
          directoryReferences: [], quotes: [], inlineReferences: [],
        };
      },
      reconcileMessage: async (sessionId, messageId) => { reconciled.push([sessionId, messageId]); },
    }), children: createElement(SessionLocalMessages, {
      sessionId: 'session-1',
      publish: (_id, message) => {
        const current = transient.get(message.id);
        transient.set(message.id, current ? mergeTransientMessageProjection(current, message) : message);
      },
      update: (_id, message) => {
        const current = transient.get(message.id);
        if (current) transient.set(message.id, mergeTransientMessageProjection(current, message));
      },
      retire: (_id, messageId) => { transient.delete(messageId); },
      canRestoreDraft: () => true,
      restoreDraft: () => { throw new Error('unexpected failed recovery'); },
      restoreUnsentDraft: (sessionId, draft) => { restored.push([sessionId, draft.text]); },
    }) }),
  })));
  const steering = transient.get('steering');
  assert.equal(steering?.deliveryStatus, 'Delivery not confirmed');
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
  assert.equal(transient.get('followup')?.deliveryStatus, 'Sending paused', 'edit keeps the original recoverable');
  messages = messages.filter((message) => message.messageId !== 'followup')
    .map((message) => ({ ...message, delivering: true }));
  await act(async () => changed('session-1'));
  assert.equal(transient.get('root')?.deliveryStatus, undefined, 'a healthy send clears its previous delivery warning');
  assert.equal(transient.get('root')?.deliveryDetail, undefined);
  assert.deepEqual(transient.get('root')?.deliveryActions, []);
  messages = messages.map((message) => ({ ...message, error: 'Saved locally. Waiting for the Host to become available.' }));
  await act(async () => changed('session-1'));
  assert.equal(transient.get('root')?.deliveryStatus, 'Waiting to send');
  assert.equal(transient.get('root')?.deliveryActions?.length, 2, 'a Host outage keeps the copy editable and removable');
  assert.equal(transient.get('root')?.deliveryDiagnostic, messages[0]?.error);
  messages = messages.map((message) => ({ ...message, state: 'sending' }));
  await act(async () => changed('session-1'));
  assert.equal(transient.get('root')?.deliveryStatus, undefined);
  assert.equal(transient.get('root')?.deliveryDiagnostic, undefined);
  assert.deepEqual(transient.get('root')?.deliveryActions, []);
  messages = messages.map((message) => ({ ...message, state: 'failed' }));
  await act(async () => changed('session-1'));
  assert.deepEqual(placements(), { steering: 'transcript', root: 'transcript' }, 'failed delivery moves nothing');
  messages = messages.map((message) => ({ ...message, state: 'accepted', ...(message.messageId === 'root' ? { turnId: 'started-turn' } : {}) }));
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root']);
  assert.equal(transient.get('root')?.transientPlacement, 'transcript');
  assert.equal(transient.get('root')?.hostTurnId, 'started-turn');
  assert.equal(transient.get('root')?.deliveryStatus, undefined, 'a cached receipt does not claim the Turn is still running');
  assert.deepEqual(transient.get('root')?.deliveryActions, []);
  await act(async () => changed('session-1'));
  assert.deepEqual([...transient.keys()], ['root'], 'a retained local copy cannot resurrect a withdrawn queue entry');
});

test('a Host-started follow-up moves to the transcript without inheriting stale local feedback', async () => {
  const message: DesktopLocalMessage = {
    sessionId: 'session-1', messageId: 'follow-up', createdAt: 1,
    state: 'unknown', canCancel: false, placement: 'next_turn',
    text: 'start this later', attachments: [], inlineReferences: [], error: 'Previous delivery was uncertain',
  };
  const harness = localDeliveryHarness([message]);
  await harness.render('session-1');
  assert.equal(harness.transient.get('session-1:follow-up')?.transientPlacement, 'follow_up');
  assert.equal(harness.transient.get('session-1:follow-up')?.deliveryStatus, 'Delivery not confirmed');
  harness.snapshots.set('session-1', [{ ...message, state: 'accepted', turnId: 'own-turn', admission: 'turn_started' }]);
  await harness.refresh('session-1');
  const admitted = harness.transient.get('session-1:follow-up');
  assert.equal(admitted?.transientPlacement, 'transcript');
  assert.equal(admitted?.hostTurnId, 'own-turn');
  assert.equal(admitted?.deliveryStatus, undefined);
  assert.equal(admitted?.deliveryDetail, undefined);
  assert.equal(admitted?.deliveryDiagnostic, undefined);
  assert.deepEqual(admitted?.deliveryActions, []);
  assert.equal(admitted?.ts, 1);
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
  const services = stubConversationServices({
    listMessages: async () => {
      if (!first) return messages;
      first = false;
      return initial;
    },
    readFailedMessage: async () => { throw new Error('Failed-message drafts are not used in this test'); },
    releaseRecoveryAttachments: async () => {},
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
  });
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
