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

import { AttachmentIngestBlockedError, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import type { PendingAttachment } from '@maka/ui/composer-attachments';
import { ATTACHMENT_APPROVAL_TTL_MS, createAttachmentApprovalRegistry } from '../attachment-approval.js';
import { DesktopSessionLocalStore } from '../session-local-store.js';
import { DesktopSessionLocalService, registerDesktopSessionLocalIpc, type DesktopSessionLocalTarget } from '../session-local-service.js';
import { projectLocalMessageDraft } from '../../preload/session-local-draft.js';
import { createChatActions } from '../../renderer/features/conversation/testing.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import { getSessionLocalCopy } from '../../renderer/locales/session-local-copy.js';
import {
  createActionsDeps,
  createTransientState,
  installWindow,
} from './app-shell-chat-actions-fixture.js';

function fileAttachment(size: number, index: number): PendingAttachment {
  return {
    stagingKey: `staged-file-${index}`,
    displayName: 'report.txt',
    kind: 'other',
    size,
    source: { type: 'file', file: { size } },
  } as PendingAttachment;
}

test('a nine-attachment new-task send shows the count reason, creates no session, and logs no unexpected diagnostic', async (context) => {
  const errorLog = context.mock.method(console, 'error', () => undefined);
  const created: unknown[] = [];
  const toasts: Array<{ title: string; description?: string }> = [];
  const restoreWindow = installWindow({
    newTasks: {
      create: async () => {
        created.push(true);
        return { id: 'session-created-anyway' };
      },
    },
  });

  try {
    for (const locale of ['zh-CN', 'en'] as const) {
      toasts.length = 0;
      const actions = createChatActions({
        ...createActionsDeps(),
        uiLocale: locale,
        toastApi: {
          error: (title, description) => {
            toasts.push({ title, description });
          },
          info: () => undefined,
        },
      });
      const pending = Array.from(
        { length: MAX_ATTACHMENT_COUNT + 1 },
        (_, index) => fileAttachment(10, index),
      );
      const accepted = await actions.send('hello', pending);
      assert.equal(accepted, false, `${locale}: the send must be rejected`);
      assert.equal(created.length, 0, `${locale}: preflight runs before the session exists`);
      assert.equal(toasts.length, 1, `${locale}: exactly one rejection toast`);
      assert.equal(
        toasts[0].description,
        getShellCopy(locale).sessionSettingsActions.attachmentIngestBlocked.count_limit,
        `${locale}: the toast carries the count reason, not the generic fallback`,
      );
    }
  } finally {
    restoreWindow();
  }
  assert.equal(
    errorLog.mock.callCount(),
    0,
    'an expected preflight rejection must not land the unexpected-error diagnostic',
  );
});

test('a main-side attachment rejection refuses the send instead of leaving it unreconciled', async (context) => {
  const errorLog = context.mock.method(console, 'error', () => undefined);
  const created: string[] = [];
  const toasts: Array<{ title: string; description?: string }> = [];
  const restoreWindow = installWindow({
    newTasks: {
      create: async () => {
        created.push('session-1');
        return { id: 'session-1' };
      },
    },
    sessions: {
      submitMessage: async () => ({ ok: false, reason: 'attachment_blocked', code: 'item_too_large' }),
    },
  });
  try {
    const actions = createChatActions({
      ...createActionsDeps(),
      uiLocale: 'zh-CN',
      toastApi: {
        error: (title, description) => {
          toasts.push({ title, description });
        },
        info: () => undefined,
      },
    });
    const accepted = await actions.send('hello', [fileAttachment(10, 0)]);
    assert.equal(accepted, false, 'a blocked attachment is a definitive refusal, not an unknown outcome');
    assert.deepEqual(toasts, [{
      title: getShellCopy('zh-CN').chatActions.sendFailedTitle,
      description: getShellCopy('zh-CN').sessionSettingsActions.attachmentIngestBlocked.item_too_large,
    }]);
  } finally {
    restoreWindow();
  }
  assert.equal(errorLog.mock.callCount(), 0, 'an expected attachment rejection logs no diagnostic');
});

for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
  for (const placement of ['send', 'current_turn', 'next_turn'] as const) {
    test(`${locale}: ${placement} explains how to restore unavailable recovery attachments without accepting the draft`, async () => {
      for (const [approvalId, code] of [
        ['local-recovery:expired', 'source_expired'],
        ['picked-file:expired', 'source_expired'],
        ['local-recovery:large', 'item_too_large'],
      ] as const) {
        const restoreWindow = installWindow({ sessions: {
          submitMessage: async () => ({ ok: false, reason: 'attachment_blocked', code }),
        } });
        const toasts: Array<{ title: string; description?: string }> = [];
        const transient = createTransientState();
        const pending: PendingAttachment[] = [{
          stagingKey: 'recovered', displayName: 'notes.txt', kind: 'other', size: 10,
          source: { type: 'approval', approvalId, name: 'notes.txt' },
        }];
        const before = structuredClone(pending);
        try {
          const deps = createActionsDeps();
          deps.activeIdRef.current = 'session-1';
          const actions = createChatActions({
            ...deps, ...transient.deps, uiLocale: locale,
            captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
            toastApi: {
              error: (title, description) => { toasts.push({ title, description }); },
              info() {},
            },
          });
          const options = { replacesLocalMessageId: 'original' };
          const accepted = placement === 'send'
            ? await actions.send('keep my edits', pending, options)
            : await actions.enqueueMessage('session-1', 'keep my edits', placement, pending, options);
          assert.equal(accepted, false, 'refusing the send tells the Composer to retain its draft');
          assert.deepEqual(pending, before, 'the recovery advice must not clear or renew attachments');
          assert.equal(transient.rows.size, 0, 'a definitive refusal leaves no optimistic duplicate');
          assert.deepEqual(toasts, [{
            title: getShellCopy(locale).chatActions.sendFailedTitle,
            description: approvalId === 'local-recovery:expired'
              ? getSessionLocalCopy(locale).recoverySourceExpired
              : getShellCopy(locale).sessionSettingsActions.attachmentIngestBlocked[code],
          }], 'ordinary sources and other rejection reasons retain their own advice');
        } finally {
          restoreWindow();
        }
      }
    });

    for (const expired of ['picked', 'recovery', 'both'] as const) {
      test(`${locale}: ${placement} gives mixed-source advice when ${expired} approvals expire in Main`, async (t) => {
        let now = Date.now();
        t.mock.method(Date, 'now', () => now);
        const directory = await mkdtemp(join(tmpdir(), 'maka-mixed-attachment-expiry-'));
        const store = new DesktopSessionLocalStore(join(directory, 'client.sqlite'));
        const target: DesktopSessionLocalTarget = {
          partition: 'authority', profileId: 'profile', scope: { hostId: 'root', targetEpoch: 'target' },
        };
        const service = new DesktopSessionLocalService(store, { targets: () => [target], changed() {}, onError: assert.fail });
        t.after(async () => { service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
        store.enqueue(target.partition, {
          command: { sessionId: 'session-1', messageId: 'original', placement: 'next_turn', content: { text: 'original text' } },
          staged: [{ name: 'original.txt', mimeType: 'text/plain', base64: Buffer.from('original bytes').toString('base64') }],
        });
        const file = join(directory, 'picked.txt');
        await writeFile(file, 'picked bytes');
        const approvals = createAttachmentApprovalRegistry();
        const pick = () => approvals.issueApprovals(7, [{ path: file, name: 'picked.txt', size: 12 }])[0]!;
        type Ipc = Parameters<typeof registerDesktopSessionLocalIpc>[0]['ipcMain'];
        const handlers = new Map<string, Parameters<Ipc['handle']>[1]>();
        registerDesktopSessionLocalIpc({
          ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
          service, approvals, resizeImage: async (bytes) => bytes,
          resolveWorkspace: async () => { throw new Error('Unexpected workspace request'); }, changed() {},
        });
        const event = { sender: { id: 7 } } as IpcMainInvokeEvent;
        const edit = async () => projectLocalMessageDraft(await handlers.get('session-local:cancel')!(
          event, target.scope, 'session-1', 'original', { restoreDraft: true },
        ));
        let draft = await edit();
        let picked = pick();
        now += ATTACHMENT_APPROVAL_TTL_MS + 1;
        if (expired === 'picked') draft = await edit();
        if (expired === 'recovery') picked = pick();
        const owner = { senderId: 7, partition: target.partition, scope: target.scope, sessionId: 'session-1' };
        const assertApprovalState = () => {
          const prepare = () => service.attachmentRecovery.prepare(owner, draft.stagedAttachments);
          if (expired === 'picked') prepare().dispose();
          else assert.throws(prepare, AttachmentIngestBlockedError);
          assert.equal(approvals.peekApproval(7, picked.approvalId) !== null, expired === 'recovery');
        };
        assertApprovalState();
        const pendingItems = (): PendingAttachment[] => [draft.stagedAttachments[0]!, picked].map((item) => ({
          stagingKey: item.approvalId, displayName: item.name, kind: 'other', size: item.size,
          source: { type: 'approval', approvalId: item.approvalId, name: item.name },
        }));
        const pending = pendingItems();
        if (expired === 'recovery') pending.reverse();
        const before = structuredClone(pending);
        const original = store.get(target.partition, 'original');
        const bytes = store.stagedAttachments(target.partition, 'original');
        const outcomes: unknown[] = [];
        const submittedIds: string[] = [];
        const restoreWindow = installWindow({ sessions: {
          submitMessage: async (sessionId: string, lane: string, command: { messageId: string }) => {
            submittedIds.push(command.messageId);
            const result = await handlers.get('session-local:submit')!(event, target.scope, sessionId, lane, command);
            outcomes.push(result);
            return result;
          },
        } });
        try {
          const deps = createActionsDeps();
          deps.activeIdRef.current = 'session-1';
          const transient = createTransientState();
          const descriptions: Array<string | undefined> = [];
          const actions = createChatActions({
            ...deps, ...transient.deps, uiLocale: locale,
            captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
            toastApi: { error: (_title, description) => { descriptions.push(description); }, info() {} },
          });
          const send = (items: PendingAttachment[]) => placement === 'send'
            ? actions.send('keep my edits', items, { replacesLocalMessageId: draft.replacesLocalMessageId })
            : actions.enqueueMessage('session-1', 'keep my edits', placement, items, { replacesLocalMessageId: draft.replacesLocalMessageId });
          assert.equal(await send(pending), false, 'the refused send retains the Composer draft');
          assert.deepEqual(outcomes, [{ ok: false, reason: 'attachment_blocked', code: 'source_expired' }]);
          assert.equal(store.get(target.partition, submittedIds[0]!), undefined);
          assert.deepEqual(store.get(target.partition, 'original'), original);
          assert.deepEqual(store.stagedAttachments(target.partition, 'original'), bytes);
          assert.deepEqual(pending, before);
          assert.equal(transient.rows.size, 0);
          assertApprovalState();
          assert.deepEqual(descriptions, [getSessionLocalCopy(locale).mixedSourcesExpired]);

          // Refresh only the expired source(s). The valid source must survive
          // the refusal, and the retry must preserve both files and the edit.
          if (expired !== 'picked') draft = await edit();
          if (expired !== 'recovery') picked = pick();
          assert.equal(await send(pendingItems()), true);
          assert.equal(store.get(target.partition, 'original'), undefined);
          assert.equal(store.get(target.partition, submittedIds[1]!)?.intent.command.content.text, 'keep my edits');
          assert.deepEqual(store.stagedAttachments(target.partition, submittedIds[1]!)
            .map(({ content }) => Buffer.from(content).toString()).sort(), ['original bytes', 'picked bytes']);
          assert.equal(descriptions.length, 1, 'a successful retry shows no further failure advice');
        } finally {
          restoreWindow();
        }
      });
    }
  }
}


test('unsupported executor attachments preserve the pending draft before any Session is created', async () => {
  const restore = installWindow({ newTasks: { create: async () => assert.fail('must reject before creation') } });
  const pending = [fileAttachment(10, 0)];
  const errors: string[] = [];
  try {
    const actions = createChatActions({
      ...createActionsDeps(),
      executorSelection: { executorId: 'external', configuration: { model: 'chosen' } },
      executorEntry: { readiness: 'ready', supportsAttachments: false },
      toastApi: { error: (message) => { errors.push(message); }, info() {} },
    });
    assert.equal(await actions.send('keep my instructions', pending), false);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].stagingKey, 'staged-file-0');
    assert.match(errors[0], /Remove unsupported attachments/);
  } finally { restore(); }
});
