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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { StoredMessage } from '@maka/core/session';
import type { QuoteRef } from '@maka/core/events';
import {
  createAppShellRevisionActions,
  revisionContentUnchanged,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';

function userMessage(turnId: string, text: string, extra: Record<string, unknown> = {}): StoredMessage {
  return {
    id: `msg-${turnId}`,
    type: 'user',
    turnId,
    ts: 1,
    text,
    ...extra,
  } as StoredMessage;
}

function createActions(input: {
  messages: StoredMessage[];
  staged?: QuoteRef[];
}) {
  const stagedNow = [...(input.staged ?? [])];
  const replacedWith: QuoteRef[][] = [];
  const drafts: (TurnRevisionDraft | null)[] = [];
  const composerState = { text: '' };
  const revisionDraftRef = { current: null as TurnRevisionDraft | null };
  const actions = createAppShellRevisionActions({
    uiLocale: 'en' as never,
    activeIdRef: { current: 'session-1' },
    composerRef: {
      current: {
        getText: () => composerState.text,
        setText: (text: string) => {
          composerState.text = text;
        },
        focus: () => {},
        setDraft: (_sessionId: string, text: string) => {
          composerState.text = text;
        },
        clearDraft: () => {},
      } as never,
    },
    messages: input.messages,
    hasPendingAttachments: () => false,
    openSessionInChat: () => {},
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setMessages: () => {},
    commitRevisionDraft: (draft: TurnRevisionDraft | null) => {
      revisionDraftRef.current = draft;
      drafts.push(draft);
    },
    revisionDraftRef,
    toastApi: {
      info: () => {},
      error: () => {},
    },
    stagedQuotes: () => [...stagedNow],
    replaceStagedQuotes: (quotes: readonly QuoteRef[]) => {
      replacedWith.push([...quotes]);
      stagedNow.splice(0, stagedNow.length, ...quotes.map((quote) => ({ ...quote })));
    },
  } as never);
  return Object.assign(actions, {
    drafts,
    stagedNow,
    replacedWith,
    composerState,
  });
}

describe('app-shell revision actions with structured context (#5109)', () => {
  it('opens a draft on a quote-bearing message and stages its quotes', () => {
    const quotes = [{ text: 'a large pasted excerpt' }];
    const h = createActions({
      messages: [userMessage('turn-1', 'explain this', { quotes })],
    });

    h.beginEditUserMessage('turn-1');

    assert.ok(h.drafts.at(-1), 'the draft opens instead of rejecting the quote');
    assert.deepEqual(h.drafts.at(-1)?.originalQuotes, quotes);
    assert.deepEqual(h.replacedWith.at(-1), quotes, 'the source quotes are staged for editing');
    assert.equal(h.composerState.text, 'explain this');
  });

  it('keeps editing allowed when only earlier turns carry attachments', () => {
    const h = createActions({
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
        userMessage('turn-2', 'plain follow-up'),
      ],
    });

    h.beginEditUserMessage('turn-2');

    assert.ok(h.drafts.at(-1), 'a retained historical attachment must not block the edit');
  });

  it('rejects a source message that itself carries attachments', () => {
    const h = createActions({
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
    });

    h.beginEditUserMessage('turn-1');

    assert.equal(h.drafts.at(-1), undefined, 'attachment-bearing sources stay explicitly rejected');
  });

  it('cancels back to the pre-edit composer text and staged quotes', async () => {
    const preExisting = [{ text: 'staged before editing' }];
    const h = createActions({
      messages: [userMessage('turn-1', 'explain this', { quotes: [{ text: 'excerpt' }] })],
      staged: preExisting,
    });

    h.beginEditUserMessage('turn-1');
    assert.deepEqual(h.stagedNow, [{ text: 'excerpt' }]);
    await h.cancelRevisionDraft();

    assert.equal(h.composerState.text, '');
    assert.deepEqual(h.stagedNow, preExisting, 'cancel restores the pre-edit staged quotes');
    assert.equal(h.drafts.at(-1), null);
  });
});

describe('revisionContentUnchanged (#5109)', () => {
  const draft = (originalQuotes: readonly QuoteRef[]): TurnRevisionDraft =>
    ({
      sourceSessionId: 'session-1',
      sourceTurnId: 'turn-1',
      copyId: 'copy-1',
      copyPhase: 'reserved',
      draftSessionId: 'session-1',
      originalText: 'explain this',
      previousComposerText: '',
      originalQuotes,
    }) as TurnRevisionDraft;

  it('ignores a text-only match when the staged quotes differ from the source', () => {
    const unchanged = revisionContentUnchanged(
      'explain this',
      draft([{ text: 'a large pasted excerpt' }]),
      [],
    );
    assert.equal(
      unchanged,
      false,
      'removing the restored quote is an explicit edit, not an unchanged resend',
    );
  });

  it('is unchanged when the text and the staged quotes both match the source', () => {
    const quotes = [{ text: 'a large pasted excerpt' }];
    assert.equal(revisionContentUnchanged('explain this', draft(quotes), quotes), true);
  });

  it('a text change alone is a real edit', () => {
    const quotes = [{ text: 'excerpt' }];
    assert.equal(revisionContentUnchanged('rewritten', draft(quotes), quotes), false);
  });
});
