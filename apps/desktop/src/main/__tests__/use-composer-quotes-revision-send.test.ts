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
import type { QuoteRef } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
// The feature index stopped re-exporting controller hooks (#5868); the test
// support entry is the sanctioned channel for driving the quote bucket.
import { useComposerQuotes } from '../../renderer/features/conversation/testing.js';
import {
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';
import { installWindow } from './app-shell-chat-actions-fixture.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const SESSION_1 = JSON.stringify(['host-1', 'session-1']);
const SESSION_2 = JSON.stringify(['host-1', 'session-2']);

function userMessage(
  turnId: string,
  text: string,
  extra: Record<string, unknown> = {},
): StoredMessage {
  return {
    id: `msg-${turnId}`,
    type: 'user',
    turnId,
    ts: 1,
    text,
    ...extra,
  } as StoredMessage;
}

afterEach(cleanupFakeDom);

test('the in-flight revision send still reads the re-keyed plate (#5274 review)', async () => {
  // The AppShell send is an in-flight closure: it captures quotesForSend from
  // the render that started the send (draft key = the source Session), then
  // awaits prepareRevisionSend, which copies the plate onto the branch child
  // and empties the source bucket in place. The resumed send must therefore
  // read the plate through the re-keyed owner key, or the replacement goes
  // out without its quotes and their edited annotations.
  const quotedQuote: QuoteRef = { text: 'a large pasted excerpt', sourceTurnId: 'turn-0' };
  const { root } = installReactRenderer();
  const activeIdRef: { current: string | undefined } = { current: SESSION_1 };
  const revisionDraftRef: { current: TurnRevisionDraft | null } = { current: null };
  const composerText = { current: '' };

  let surface!: ReturnType<typeof useComposerQuotes>;
  function Probe() {
    surface = useComposerQuotes({ draftKey: activeIdRef.current ?? SESSION_1 });
    return null;
  }
  await act(async () => root.render(createElement(Probe)));

  const actions = createAppShellRevisionActions({
    uiLocale: 'en' as never,
    activeIdRef,
    captureSelection: () => () => true,
    composerRef: {
      current: {
        getText: () => composerText.current,
        setText: (text: string) => {
          composerText.current = text;
        },
        focus: () => {},
        setDraft: (_sessionId: string, text: string) => {
          composerText.current = text;
        },
        clearDraft: () => {},
      } as never,
    },
    readMessages: () => [userMessage('turn-1', 'explain this', { quotes: [quotedQuote] })],
    composerStaging: {
      captureSubmission: () => ({ hasPendingContext: false }),
      stagedContext: () => ({
        quotes: surface.pendingQuotes,
        attachments: [],
        restoreQuotes: surface.restoreQuotes,
        clearQuotes: surface.clearQuotes,
      }),
    },
    openSessionInChat: (sessionId: string) => {
      activeIdRef.current = sessionId;
    },
    refreshSessions: async () => [],
    commitRevisionDraft: (draft: TurnRevisionDraft | null) => {
      revisionDraftRef.current = draft;
    },
    revisionDraftRef,
    toastApi: { info: () => {}, error: () => {} },
  } as never);

  const restoreWindow = installWindow({
    sessions: {
      reviseBeforeTurn: async () => ({ id: SESSION_2 }),
      abandonSessionCopy: async () => {},
    },
  });
  try {
    // Edit click stages the source message's quote under the source key.
    await act(async () => actions.beginEditUserMessage('turn-1'));
    assert.deepEqual(surface.pendingQuotes, [quotedQuote]);

    // During the edit the user re-annotates the excerpt — the plate is the
    // truth the replacement must carry (#5274 review).
    await act(async () => surface.updateQuoteComment(0, 'the edited annotation'));

    // The send captures quotesForSend from this render, then awaits the
    // revision lifecycle — exactly the app-shell send's shape.
    const quotesForSendAtSendStart: (ownerKey?: string) => readonly QuoteRef[] | undefined =
      surface.quotesForSend;
    assert.deepEqual(quotesForSendAtSendStart(), [
      { text: 'a large pasted excerpt', sourceTurnId: 'turn-0', comment: 'the edited annotation' },
    ]);

    await act(async () => {
      assert.equal(await actions.prepareRevisionSend('edited text'), true);
    });
    const expectedRevisionDraft = revisionDraftRef.current;
    assert.equal(expectedRevisionDraft?.draftSessionId, SESSION_2);

    // The resumed send reads the plate through the re-keyed owner: the
    // render-time closure still points at the emptied source bucket.
    const quotes = quotesForSendAtSendStart(expectedRevisionDraft?.draftSessionId);
    assert.deepEqual(
      quotes,
      [
        {
          text: 'a large pasted excerpt',
          sourceTurnId: 'turn-0',
          comment: 'the edited annotation',
        },
      ],
      'the in-flight send must deliver the re-keyed plate, edits included',
    );
  } finally {
    restoreWindow();
  }
});
