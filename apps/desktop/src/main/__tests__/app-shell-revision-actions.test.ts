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
import type { ComposerHandle } from '@maka/ui';
import { retireRevisionDraft } from '../../renderer/features/conversation/index.js';
import {
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

function preparedDraft(): TurnRevisionDraft {
  return {
    sourceSessionId: 'source',
    sourceTurnId: 'turn-1',
    copyId: 'revision-copy',
    copyPhase: 'started',
    draftSessionId: 'child',
    originalText: 'original message',
    previousComposerText: 'previous unsent draft /skill:project-only',
  };
}

test('a successful revision send clears the child and source draft owners', () => {
  const cleared: string[] = [];
  const committed: Array<TurnRevisionDraft | null> = [];
  let copyCompleted = 0;
  retireRevisionDraft(
    preparedDraft(),
    (key) => cleared.push(key),
    () => {
      copyCompleted += 1;
    },
    () => committed.push(null),
  );

  assert.equal(copyCompleted, 1);
  assert.deepEqual(cleared, ['child', 'source']);
  assert.deepEqual(committed, [null]);
});

test('cancelling a prepared revision restores the complete pre-edit draft', async () => {
  const draftRef = { current: preparedDraft() as TurnRevisionDraft | null };
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      maka: {
        sessions: {
          abandonSessionCopy: async (
            sourceSessionId: string,
            copyId: string,
          ) => {
            calls.push(`abandon:${sourceSessionId}:${copyId}`);
          },
        },
      },
    },
  });
  const composer = {
    setDraft: (key: string, text: string) => calls.push(`set:${key}:${text}`),
    clearDraft: (key: string) => calls.push(`clear:${key}`),
    setText: (text: string) => calls.push(`text:${text}`),
    getText: () => '',
    focus: () => calls.push('focus'),
  } as unknown as ComposerHandle;
  const actions = createAppShellRevisionActions({
    uiLocale: 'en',
    activeIdRef: { current: 'child' },
    composerRef: { current: composer },
    messages: [],
    hasPendingAttachments: () => false,
    openSessionInChat: (sessionId) => calls.push(`open:${sessionId}`),
    refreshMessages: async (sessionId) => {
      calls.push(`messages:${sessionId}`);
      return true;
    },
    refreshSessions: async () => {
      calls.push('sessions');
      return [];
    },
    setMessages: () => undefined,
    commitRevisionDraft: (draft) => {
      draftRef.current = draft;
    },
    revisionDraftRef: draftRef,
    toastApi: { info: () => undefined, error: () => undefined },
  });

  await actions.cancelRevisionDraft();

  assert.equal(draftRef.current, null);
  assert.deepEqual(calls, [
    'abandon:source:revision-copy',
    'set:source:previous unsent draft /skill:project-only',
    'clear:child',
    'open:source',
    'messages:source',
    'sessions',
  ]);
});
