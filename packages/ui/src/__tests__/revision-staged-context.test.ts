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

import { strict as assert } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QuoteRef } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  clearRevisionStagedContext,
  createRevisionActions,
  revisionSendGate,
  revisionStagedContextUnchanged,
  stageRevisionSourceContext,
  type RevisionActionsEnv,
  type RevisionEditCopy,
  type RevisionStagedContext,
  type RevisionStagedSource,
  type TurnRevisionDraftBase,
} from '../revision-staged-context.js';

const copy: RevisionEditCopy = {
  revisionUnavailableTitle: 'unavailable',
  revisionAlreadyActive: 'already-active',
  revisionDraftAttachmentConflict: 'draft-attachment-conflict',
  revisionDraftQuoteConflict: 'draft-quote-conflict',
  revisionAttachmentsUnsupported: 'source-attachments-unsupported',
  revisionMixedContextUnsupported: 'mixed-context-unsupported',
  revisionTransformedTextUnsupported: 'transformed-text-unsupported',
  revisionStartedTitle: 'started',
  revisionStartedDescription: 'started-description',
  revisionReadyTitle: 'ready',
  revisionReadyDescription: 'ready-description',
  revisionUnchanged: 'unchanged',
  operationFailedTitle: 'failed',
  operationFailedFallback: 'failed-fallback',
};

function userMessage(turnId: string, text: string, extra: Record<string, unknown> = {}): StoredMessage {
  return { id: `msg-${turnId}`, type: 'user', turnId, ts: 1, text, ...extra } as StoredMessage;
}

type StagedLog = {
  restored: Array<{ ownerKey: string; quotes: QuoteRef[] }>;
  cleared: string[];
  quotes: QuoteRef[];
};

function emptyStagedLog(): StagedLog {
  return { restored: [], cleared: [], quotes: [] };
}

function fakeStaged(log: StagedLog): RevisionStagedContext {
  return {
    quotes: log.quotes,
    attachments: [],
    restoreQuotes: (ownerKey, quotes) => {
      log.restored.push({ ownerKey, quotes: [...quotes] });
      log.quotes.push(...quotes);
    },
    clearQuotes: (ownerKey) => {
      log.cleared.push(ownerKey);
      log.quotes.length = 0;
    },
  };
}

function createEnv(input: {
  messages: StoredMessage[];
  staged: StagedLog;
  preparedMessages?: StoredMessage[];
}) {
  const activeIdRef = { current: 'session-1' };
  const revisionDraftRef: { current: TurnRevisionDraftBase<string> | null } = { current: null };
  const toasts: Array<{ kind: 'info' | 'error'; title: string; description?: string }> = [];
  const readSettledCalls: string[] = [];
  const composer = { text: '' };
  let attempts = 0;
  const env: RevisionActionsEnv<string, TurnRevisionDraftBase<string>> = {
    uiLocale: 'en' as never,
    activeIdRef,
    captureSelection: () => () => true,
    composerRef: {
      current: {
        getText: () => composer.text,
        setText: (text: string) => {
          composer.text = text;
        },
        focus: () => {},
        clearDraft: () => {},
        setDraft: (_sessionId: string, text: string) => {
          composer.text = text;
        },
      } as never,
    },
    messages: input.messages,
    hasPendingAttachments: () => false,
    stagedContext: () => fakeStaged(input.staged),
    openSessionInChat: (sessionId) => {
      activeIdRef.current = sessionId;
    },
    refreshSessions: async () => [],
    setMessages: () => {},
    commitRevisionDraft: (draft) => {
      revisionDraftRef.current = draft;
    },
    revisionDraftRef,
    toastApi: {
      info: (title, description) => toasts.push({ kind: 'info', title, description }),
      error: (title, description) => toasts.push({ kind: 'error', title, description }),
    },
    copy,
    reviseBeforeTurn: async () => ({ id: 'session-2' }),
    abandonSessionCopy: async () => {},
    readSettledMessages: async (sessionId) => {
      readSettledCalls.push(sessionId);
      return { messages: input.preparedMessages ?? [], settled: true };
    },
    localizedShellErrorMessage: (_error, fallback) => fallback,
    reportSessionWorkspaceUnavailable: () => false,
    acquireCopyAttempt: (_key, turnId) => ({
      sourceTurnId: turnId,
      copyId: `copy-${++attempts}`,
      phase: 'reserved',
    }),
    startCopyAttempt: () => true,
    abandonCopyAttempt: () => true,
    completeCopyAttempt: () => {},
  };
  return { env, activeIdRef, revisionDraftRef, toasts, readSettledCalls };
}

const quotedQuote: QuoteRef = { text: 'a large pasted excerpt', sourceTurnId: 'turn-0' };

describe('revision lifecycle (#5109)', () => {
  it('re-keys the restored quotes onto the branch child across the commit', async () => {
    const staged = emptyStagedLog();
    // The branch child transcript a revision copy really produces: the
    // revised turn is excluded, so turn-1's message is absent and nothing in
    // the copy rewrites it. The re-key must read the draft snapshot, not the
    // transcript (#5109 review).
    const h = createEnv({
      messages: [userMessage('turn-1', 'explain this', { quotes: [quotedQuote] })],
      staged,
      preparedMessages: [userMessage('turn-0', 'earlier question')],
    });
    const actions = createRevisionActions(h.env);

    actions.beginEditUserMessage('turn-1');
    assert.deepEqual(staged.restored, [{ ownerKey: 'session-1', quotes: [quotedQuote] }]);

    assert.equal(await actions.prepareRevisionSend('edited text'), true);
    assert.deepEqual(h.readSettledCalls, ['session-2']);
    assert.deepEqual(
      staged.restored.at(-1),
      { ownerKey: 'session-2', quotes: [quotedQuote] },
      'the restored quotes re-key onto the branch child',
    );
    assert.ok(staged.cleared.includes('session-1'), 'the source-key plate empties');
  });

  it('refuses to edit a message that carries attachments', () => {
    const h = createEnv({
      messages: [
        userMessage('turn-1', 'with image', {
          attachments: [
            {
              kind: 'image',
              name: 'chart.png',
              mimeType: 'image/png',
              bytes: 10,
              ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'a.png' },
            },
          ],
        }),
      ],
      staged: emptyStagedLog(),
    });
    const actions = createRevisionActions(h.env);

    actions.beginEditUserMessage('turn-1');

    assert.equal(h.revisionDraftRef.current, null, 'no draft is committed');
    assert.deepEqual(h.toasts.at(-1), {
      kind: 'info',
      title: 'unavailable',
      description: 'source-attachments-unsupported',
    });
  });

  it('blocks a no-op replacement as unchanged', async () => {
    const h = createEnv({
      messages: [userMessage('turn-1', 'explain this')],
      staged: emptyStagedLog(),
    });
    const actions = createRevisionActions(h.env);

    actions.beginEditUserMessage('turn-1');
    assert.equal(await actions.prepareRevisionSend('explain this'), false);
    assert.deepEqual(h.toasts.at(-1), { kind: 'info', title: 'ready', description: 'unchanged' });
  });

  it('blocks a replacement that mixes newly staged quotes into the edit', async () => {
    const staged = emptyStagedLog();
    const h = createEnv({
      messages: [userMessage('turn-1', 'explain this')],
      staged,
    });
    const actions = createRevisionActions(h.env);

    actions.beginEditUserMessage('turn-1');
    staged.quotes.push({ text: 'my own excerpt' });
    assert.equal(await actions.prepareRevisionSend('edited text'), false);
    assert.deepEqual(h.toasts.at(-1), {
      kind: 'info',
      title: 'ready',
      description: 'mixed-context-unsupported',
    });
  });

  it('cancels a prepared edit and clears both draft keys', async () => {
    const staged = emptyStagedLog();
    const h = createEnv({
      messages: [userMessage('turn-1', 'explain this', { quotes: [quotedQuote] })],
      staged,
      preparedMessages: [],
    });
    const actions = createRevisionActions(h.env);

    actions.beginEditUserMessage('turn-1');
    await actions.prepareRevisionSend('edited text');
    await actions.cancelRevisionDraft();

    assert.deepEqual([...new Set(staged.cleared)].sort(), ['session-1', 'session-2']);
    assert.equal(staged.quotes.length, 0, 'nothing stays staged after the cancel');
    assert.equal(h.revisionDraftRef.current, null);
  });
});

describe('revision send gate', () => {
  const source: RevisionStagedSource = {
    originalQuotes: [{ text: 'q' }],
    originalAttachments: [],
  };
  const originalText = 'explain this';
  const restored = { quotes: [{ text: 'q' }] as readonly QuoteRef[], attachments: [] };

  it('passes a genuine replacement', () => {
    assert.equal(
      revisionSendGate(source, originalText, 'edited', restored, false),
      'pass',
    );
  });

  it('blocks a no-op retry as unchanged', () => {
    assert.equal(
      revisionSendGate(source, originalText, '  explain this  ', restored, false),
      'unchanged',
    );
  });

  it('blocks newly staged quotes as a conflict', () => {
    assert.equal(
      revisionSendGate(
        source,
        originalText,
        'edited',
        { quotes: [{ text: 'q' }, { text: 'own' }], attachments: [] },
        false,
      ),
      'conflict',
    );
  });

  it('blocks pending directories with an empty attachment plate as a conflict', () => {
    assert.equal(revisionSendGate(source, originalText, 'edited', restored, true), 'conflict');
  });
});

describe('revision staged-context helpers', () => {
  it('stages the source quotes under the owner key and records them', () => {
    const restored: Array<{ ownerKey: string; quotes: readonly QuoteRef[] }> = [];
    const snapshot = stageRevisionSourceContext(
      { restoreQuotes: (ownerKey, quotes) => restored.push({ ownerKey, quotes }) },
      'session-1',
      { quotes: [quotedQuote] },
    );
    assert.deepEqual(restored, [{ ownerKey: 'session-1', quotes: [quotedQuote] }]);
    assert.deepEqual(snapshot.originalQuotes, [quotedQuote]);
    assert.deepEqual(
      snapshot.originalAttachments,
      [],
      'attachments fail closed: no target-owned refs exist to stage (#5109 review)',
    );
  });

  it('clears the staged quotes under every owner key once', () => {
    const cleared: string[] = [];
    clearRevisionStagedContext(
      { clearQuotes: (ownerKey) => cleared.push(ownerKey) },
      ['session-1', 'session-2', 'session-1'],
    );
    assert.deepEqual(cleared, ['session-1', 'session-2']);
  });

  it('compares text and quotes for the unchanged retry', () => {
    const source: RevisionStagedSource = { originalQuotes: [quotedQuote], originalAttachments: [] };
    assert.equal(
      revisionStagedContextUnchanged(source, 'explain', 'explain', [quotedQuote], []),
      true,
    );
    assert.equal(
      revisionStagedContextUnchanged(source, 'explain', 'edited', [quotedQuote], []),
      false,
      'a text change is a genuine replacement',
    );
    assert.equal(
      revisionStagedContextUnchanged(source, 'explain', 'explain', [], []),
      false,
      'a removed quote is a genuine replacement',
    );
  });
});
