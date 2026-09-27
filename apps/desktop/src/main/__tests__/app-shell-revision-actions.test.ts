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
import {
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';
import { installWindow } from './app-shell-chat-actions-fixture.js';

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

describe('revision draft lifecycle over a prepared send', () => {
  // The revision child can land in the catalog before reviseBeforeTurn
  // resolves; the world below models the deferred handoff by letting
  // openSessionInChat settle the active Session.
  function createRevisionWorld(options: { composerText?: string } = {}) {
    const activeIdRef: { current: string | undefined } = { current: SESSION_1 };
    let selectionRevision = 0;
    let reviseCalls = 0;
    const abandonedCopies: string[] = [];
    const sessionDrafts = new Map<string, string>();
    const clearedDrafts: string[] = [];
    let composerText = options.composerText ?? '';
    const revisionDraftRef: { current: TurnRevisionDraft | null } = { current: null };
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
          setText: (text: string) => { composerText = text; },
          focus: () => {},
          setDraft: (sessionId: string, text: string) => { sessionDrafts.set(sessionId, text); },
          clearDraft: (sessionId: string) => {
            clearedDrafts.push(sessionId);
            sessionDrafts.delete(sessionId);
          },
        },
      },
      messages: [userMessage('turn-1', 'original message')],
      hasPendingAttachments: () => false,
      openSessionInChat: (sessionId: string) => {
        selectionRevision += 1;
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
        reviseBeforeTurn: async () => {
          reviseCalls += 1;
          return { id: SESSION_2 };
        },
        abandonSessionCopy: async (_sessionId: string, copyId: string) => {
          abandonedCopies.push(copyId);
        },
      },
    });
    return {
      actions,
      activeIdRef,
      abandonedCopies,
      sessionDrafts,
      clearedDrafts,
      revisionDraftRef,
      restoreWindow,
      get reviseCalls() { return reviseCalls; },
      get composerText() { return composerText; },
    };
  }

  it('retries a refused send inside the prepared child instead of opening another revision', async () => {
    const world = createRevisionWorld();
    try {
      world.actions.beginEditUserMessage('turn-1');
      assert.equal(await world.actions.prepareRevisionSend('edited text'), true);
      // The refused send never reaches these actions: the draft keeps the
      // child it already prepared, so the next send only has to not fork again.
      assert.equal(await world.actions.prepareRevisionSend('edited text'), true);
      assert.equal(world.reviseCalls, 1);
      assert.equal(world.revisionDraftRef.current?.draftSessionId, SESSION_2);
      assert.equal(world.sessionDrafts.get(SESSION_2), 'edited text');
    } finally {
      world.restoreWindow();
    }
  });

  it('restores the complete pre-edit draft when a refused revision is cancelled', async () => {
    const world = createRevisionWorld({
      composerText: 'previous unsent draft /skill:project-only',
    });
    try {
      world.actions.beginEditUserMessage('turn-1');
      assert.equal(await world.actions.prepareRevisionSend('edited with skill /skill:workspace-only'), true);
      await world.actions.cancelRevisionDraft();
      assert.equal(world.revisionDraftRef.current, null);
      assert.equal(
        world.sessionDrafts.get(SESSION_1),
        'previous unsent draft /skill:project-only',
        'the pre-edit draft returns to its source Session, Skill token included',
      );
      assert.deepEqual(world.clearedDrafts, [SESSION_2]);
      assert.equal(world.abandonedCopies.length, 1);
      assert.equal(world.activeIdRef.current, SESSION_1);
      assert.equal(world.composerText, 'previous unsent draft /skill:project-only');
    } finally {
      world.restoreWindow();
    }
  });
});
