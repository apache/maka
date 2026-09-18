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
import { createAppShellRevisionActions } from '../../renderer/app-shell-revision-actions.js';

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

function createActions(input: { messages: StoredMessage[] }) {
  const drafts: unknown[] = [];
  let composerText = '';
  const staged: {
    quotes: unknown[];
    restoredQuotes: unknown[][];
    clearedKeys: string[];
  } = { quotes: [], restoredQuotes: [], clearedKeys: [] };
  const revisionDraftRef: { current: unknown } = { current: null };
  const actions = createAppShellRevisionActions({
    uiLocale: 'en' as never,
    activeIdRef: { current: 'session-1' },
    composerRef: {
      current: {
        getText: () => composerText,
        setText: (text: string) => {
          composerText = text;
        },
        focus: () => {},
        setDraft: (_sessionId: string, text: string) => {
          composerText = text;
        },
        clearDraft: () => {},
      } as never,
    },
    messages: input.messages,
    hasPendingAttachments: () => false,
    stagedContext: () => ({
      quotes: staged.quotes,
      attachments: [],
      restoreQuotes: (_ownerKey: string, quotes: unknown[]) => {
        staged.restoredQuotes.push(quotes);
        staged.quotes.push(...quotes);
      },
      clearQuotes: (ownerKey: string) => {
        staged.clearedKeys.push(ownerKey);
        staged.quotes.length = 0;
      },
    }),
    openSessionInChat: () => {},
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setMessages: () => {},
    commitRevisionDraft: (draft: unknown) => {
      revisionDraftRef.current = draft;
      drafts.push(draft);
    },
    revisionDraftRef,
    toastApi: {
      info: () => {},
      error: () => {},
    },
  } as never);
  return Object.assign(actions, {
    drafts,
    staged,
    composerState: { get text(): string { return composerText; } },
  });
}

describe('app-shell revision actions with structured context (#5109)', () => {
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
    assert.equal(h.composerState.text, 'plain follow-up');
  });

  it('refuses editing a message that carries attachments (#5109 review)', () => {
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

    assert.equal(
      h.drafts.at(-1),
      undefined,
      'a revision copy excludes the revised turn, so no target-owned attachment rewrite exists to restage',
    );
    assert.equal(h.composerState.text, '', 'the composer stays untouched');
  });

  it('stages a source message quotes into the composer', () => {
    const quote = { text: 'a large pasted excerpt', sourceTurnId: 'turn-0' };
    const h = createActions({
      messages: [userMessage('turn-1', 'explain this', { quotes: [quote] })],
    });

    h.beginEditUserMessage('turn-1');

    const draft = h.drafts.at(-1) as { originalQuotes?: unknown[] } | undefined;
    assert.ok(draft, 'a quote-carrying source message is editable now');
    assert.deepEqual(draft?.originalQuotes, [quote]);
    assert.deepEqual(
      h.staged.restoredQuotes.at(-1),
      [quote],
      'the source quotes stage into the composer verbatim',
    );
  });
});
