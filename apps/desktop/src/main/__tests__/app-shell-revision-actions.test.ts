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

const SESSION_1 = JSON.stringify(['host-1', 'session-1']);
const SESSION_2 = JSON.stringify(['host-1', 'session-2']);

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

function createActions(input: { messages: StoredMessage[]; failRefresh?: boolean }) {
  const drafts: unknown[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  let composerText = '';
  let selectionRevision = 0;
  const activeIdRef: { current: string | undefined } = { current: SESSION_1 };
  const revisionDraftRef: { current: unknown } = { current: null };
  const actions = createAppShellRevisionActions({
    uiLocale: 'en' as never,
    activeIdRef,
    captureSelection: () => {
      const revision = selectionRevision;
      return () => selectionRevision === revision;
    },
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
    openSessionInChat: (sessionId: string) => {
      selectionRevision += 1;
      activeIdRef.current = sessionId;
    },
    refreshSessions: async () => {
      if (input.failRefresh) throw new Error('Host lost the Session');
      return [];
    },
    commitRevisionDraft: (draft: unknown) => {
      revisionDraftRef.current = draft;
      drafts.push(draft);
    },
    revisionDraftRef,
    toastApi: {
      info: (title: string) => infos.push(title),
      error: (title: string) => errors.push(title),
    },
  } as never);
  return Object.assign(actions, {
    drafts,
    errors,
    infos,
    activeIdRef,
    composerState: { get text(): string { return composerText; } },
  });
}

async function withWindowMaka(maka: unknown, run: () => Promise<void>): Promise<void> {
  const target = globalThis as { window?: unknown };
  const previous = target.window;
  target.window = { maka };
  try {
    await run();
  } finally {
    target.window = previous;
  }
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
});

describe('prepareRevisionSend transcript settlement', () => {
  it('prepares the revision without opening another transcript consumer', async () => {
    let abandoned = 0;
    let opened = 0;
    await withWindowMaka(
      {
        sessions: {
          reviseBeforeTurn: async () => ({ id: SESSION_2 }),
          abandonSessionCopy: async () => {
            abandoned += 1;
          },
        },
        transcripts: {
          open: async () => {
            opened += 1;
            return new Promise<never>(() => {});
          },
          readTurn: async () => [],
        },
      },
      async () => {
        const h = createActions({ messages: [userMessage('turn-1', 'original')] });
        h.beginEditUserMessage('turn-1');
        assert.equal(await h.prepareRevisionSend('edited'), true);
        assert.equal(opened, 0, 'the send must not wait on a second transcript open');
        assert.equal(abandoned, 0);
        assert.equal(h.activeIdRef.current, SESSION_2);
        assert.deepEqual(h.errors, []);
        assert.equal(
          (h.drafts.at(-1) as { draftSessionId?: string }).draftSessionId,
          SESSION_2,
        );
      },
    );
  });

  it('surfaces a failed preparation instead of swallowing it behind rollback', async () => {
    let abandoned = 0;
    let opened = 0;
    await withWindowMaka(
      {
        sessions: {
          reviseBeforeTurn: async () => ({ id: SESSION_2 }),
          abandonSessionCopy: async () => {
            abandoned += 1;
          },
        },
        transcripts: {
          open: async () => {
            opened += 1;
            return new Promise<never>(() => {});
          },
          readTurn: async () => [],
        },
      },
      async () => {
        const h = createActions({
          messages: [userMessage('turn-1', 'original')],
          failRefresh: true,
        });
        h.beginEditUserMessage('turn-1');
        assert.equal(await h.prepareRevisionSend('edited'), false);
        assert.equal(opened, 0);
        assert.equal(h.errors.length, 1, 'the failure must reach the user before rollback navigates away');
        assert.equal(abandoned, 1);
        assert.equal(h.activeIdRef.current, SESSION_1);
        assert.equal(h.composerState.text, 'edited');
      },
    );
  });
});
