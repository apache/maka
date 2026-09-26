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
import { LocaleProvider, type ComposerHandle, type TransientUserMessageProjection } from '@maka/ui';
import { useComposerAttachments } from '@maka/ui/use-composer-attachments';
import {
  ComposerMentionsProvider,
  ConversationServicesProvider,
  SessionLocalMessages,
  composerMessageRecovery,
  useComposerMentionsContext,
  useComposerQuotes,
  type ComposerMentions,
  type ConversationServices,
} from '../../renderer/features/conversation/index.js';
import {
  createSessionCatalogController,
  SessionCatalogContext,
} from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import type { DesktopLocalMessageDraft } from '../../shared/session-local-contract.js';
import { getSessionLocalCopy } from '../../renderer/locales/session-local-copy.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

const draft: DesktopLocalMessageDraft = {
  messageId: 'failed', text: 'Original failed prompt', attachments: [],
  stagedAttachments: [{ approvalId: 'local-recovery:old', name: 'old.txt', mimeType: 'text/plain', size: 1 }],
  directoryReferences: [], inlineReferences: [],
  quotes: [{ text: 'Original quote' }],
};

async function recoveryFixture() {
  const { root } = installReactRenderer();
  const catalog = createSessionCatalogController();
  catalog.commitSessions(['current', 'source'].map((id) => ({
    id, name: id, runtimeHostId: 'host', revision: 1, profileId: 'profile', profileName: 'Local', profileKind: 'local' as const,
    isFlagged: false, isArchived: false,
    labels: [], hasUnread: false, status: 'active' as const, backend: 'ai-sdk' as const,
    llmConnectionSlug: 'connection', connectionLocked: false, model: 'model', permissionMode: 'ask' as const,
  })));
  const messages = new Map<string, TransientUserMessageProjection>();
  let text = '';
  let reads = 0;
  let contextRestores = 0;
  let releaseRead!: (value: DesktopLocalMessageDraft) => void;
  let mentions!: ComposerMentions;
  let quotes!: ReturnType<typeof useComposerQuotes>;
  let attachments!: ReturnType<typeof useComposerAttachments>;
  const composerRef: { current: Pick<ComposerHandle, 'getText' | 'setText'> } = {
    current: { getText: () => text, setText(value) { text = value; } },
  };
  const services: ConversationServices = {
    listMessages: async () => [{
      sessionId: 'current', messageId: 'failed', createdAt: 1, state: 'failed',
      text: draft.text, attachments: [], inlineReferences: [], placement: 'next_turn', canCancel: true,
    }],
    readFailedMessage: () => {
      reads++;
      return new Promise<DesktopLocalMessageDraft>((resolve) => { releaseRead = resolve; });
    },
    cancelMessage: async () => {}, reconcileMessage: async () => {}, subscribeChanges: () => () => {},
    sessions: {
      readSnapshot: async () => { throw new Error('Recovery must not resolve newer Session references'); },
      readExecutionBoundary: async () => { throw new Error('unexpected boundary read'); },
    },
    runtimeHosts: { subscribeChanges: () => () => {} },
    skills: { listInvocable: async () => [] },
    workspace: { searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    newTasks: { subscribeChanges: () => () => {}, listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    mcp: { subscribeChanges: () => () => {} },
  };
  const publish = (_sessionId: string, message: TransientUserMessageProjection) => { messages.set(message.id, message); };
  const copy = getSessionLocalCopy('en');
  function Probe() {
    mentions = useComposerMentionsContext()!;
    return createElement(SessionLocalMessages, {
      sessionId: 'current', publish, update: publish, retire: () => {},
      ...composerMessageRecovery({
        sessionId: 'current', directoryHostId: 'host', composerRef, enabled: true,
        hasPendingContext: attachments.hasPendingContextNow, pendingQuotes: quotes.pendingQuotes,
        restoreMessageContext: (...args) => { contextRestores++; attachments.restoreMessageContext(...args); },
        restoreQuotes: (sessionId, recovered) => quotes.restoreQuotes(sessionId, recovered),
      }),
    });
  }
  function ComposerOwner() {
    quotes = useComposerQuotes({ draftKey: 'current' });
    attachments = useComposerAttachments({
      draftKey: 'current', directoryHostId: 'host',
      copy: { attachmentFailedTitle: 'Attachment failed', tryAgain: 'Try again',
        imageAttachmentNotDirectTitle: '', imageAttachmentNotDirectDescription: '' },
      formatError: (_error, fallback) => fallback,
      toastApi: { error: (title) => assert.fail(title) },
      service: {
        pickFiles: async () => ({ ok: true, files: [{ approvalId: 'new', name: 'new.txt', size: 1 }] }),
        previewApproval: async () => ({ ok: false, reason: 'unused' }),
        pickDirectory: async () => ({ ok: true, reference: { hostId: 'host', path: '/new' } }),
      },
    });
    return createElement(ComposerMentionsProvider, {
      sessionId: 'current', skillCatalogRevision: 0,
      onAddQuote: quotes.addQuote, pendingQuotes: quotes.pendingQuotes,
      children: createElement(Probe),
    });
  }
  await act(async () => root.render(createElement(LocaleProvider, {
    locale: 'en', children: createElement(ConversationServicesProvider, {
      services, children: createElement(SessionCatalogContext.Provider, {
        value: catalog, children: createElement(ComposerOwner),
      }),
    }),
  })));
  return {
    readCount: () => reads,
    pick: () => mentions.onPickSessionReference!({ id: 'source', name: 'source' }),
    edit: () => messages.get('failed')!.deliveryActions!.find((action) => action.label === copy.edit)!.onClick(),
    release: () => releaseRead(draft),
    assertComposerUntouched() {
      assert.equal(text, '', 'the read continuation must not overwrite a newly staged draft before React renders');
      assert.equal(contextRestores, 0);
    },
    stage: (kind: 'file' | 'drop' | 'directory') => kind === 'file'
      ? attachments.pickAttachments()
      : kind === 'drop'
        ? attachments.attachFilePaths([new File(['new'], 'new.txt', { type: 'text/plain' })])
        : attachments.directoryComposerProps.onPickDirectory!(),
    assertContextBlocked(kind: 'file' | 'drop' | 'directory') {
      assert.equal(text, '', 'new context must not be combined with the old failed prompt');
      assert.equal(contextRestores, 0);
      assert.deepEqual(quotes.pendingQuotes, []);
      assert.deepEqual(attachments.pendingAttachments.map((item) => item.displayName),
        kind === 'directory' ? [] : ['new.txt']);
      assert.deepEqual(attachments.pendingDirectories,
        kind === 'directory' ? [{ hostId: 'host', path: '/new' }] : []);
      assert.equal(messages.get('failed')!.deliveryDetail, copy.draftBlocked);
    },
    async recoverAfterContextRemoval(kind: 'file' | 'drop' | 'directory') {
      await act(() => kind === 'directory'
        ? attachments.directoryComposerProps.onRemoveDirectory(0) : attachments.removeAttachment(0));
      await act(() => this.edit());
      await act(async () => releaseRead(draft));
      assert.equal(text, draft.text);
      assert.equal(contextRestores, 1);
      assert.deepEqual(attachments.pendingAttachments.map((item) => item.displayName), ['old.txt']);
      assert.deepEqual(quotes.pendingQuotes, draft.quotes);
      assert.equal(messages.get('failed')!.deliveryDetail, copy.draftReady);
    },
    assertBlocked() {
      assert.equal(text, '', 'a newer Session reference must block replacing the blank draft');
      assert.equal(contextRestores, 0);
      assert.deepEqual(quotes.pendingQuotes, []);
      assert.deepEqual(mentions.pendingSessionReferences.map((reference) => reference.id), ['source']);
      assert.equal(messages.get('failed')!.deliveryDetail, copy.draftBlocked);
    },
    async assertRecoveryAfterRemoval() {
      await act(() => mentions.onRemovePendingSessionReference('source'));
      await act(() => this.edit());
      await act(async () => releaseRead(draft));
      assert.equal(text, draft.text);
      assert.equal(contextRestores, 1);
      assert.deepEqual(quotes.pendingQuotes, draft.quotes);
      assert.deepEqual(mentions.pendingSessionReferences, []);
      assert.equal(messages.get('failed')!.deliveryDetail, copy.draftReady);
    },
  };
}

test('a selected Session reference blocks failed-draft recovery before its pending state rerenders', async () => {
  const fixture = await recoveryFixture();
  await act(async () => {
    const pick = fixture.pick();
    fixture.edit();
    await pick;
  });
  assert.equal(fixture.readCount(), 0, 'do not even read a failed draft while a newer Session reference is staged');
  fixture.assertBlocked();
  await fixture.assertRecoveryAfterRemoval();
});

test('a Session reference selected during the failed-draft read prevents recovery after it resolves', async () => {
  const fixture = await recoveryFixture();
  await act(() => fixture.edit());
  assert.equal(fixture.readCount(), 1);
  await act(async () => {
    const pick = fixture.pick();
    fixture.release();
    await pick;
  });
  fixture.assertBlocked();
  await fixture.assertRecoveryAfterRemoval();
});

for (const kind of ['file', 'drop', 'directory'] as const) {
  for (const duringRead of [false, true]) {
    test(`a staged ${kind} blocks failed-draft recovery ${duringRead ? 'during' : 'before'} the read without a render`, async () => {
      const fixture = await recoveryFixture();
      if (duringRead) await act(() => fixture.edit());
      await act(async () => {
        await fixture.stage(kind);
        // Both continuations run in one React batch: the pending-state render
        // must not be required for either recovery guard to see new context.
        if (duringRead) {
          fixture.release();
          await Promise.resolve();
          fixture.assertComposerUntouched();
        } else fixture.edit();
      });
      assert.equal(fixture.readCount(), duringRead ? 1 : 0);
      fixture.assertContextBlocked(kind);
      await fixture.recoverAfterContextRemoval(kind);
    });
  }
}
