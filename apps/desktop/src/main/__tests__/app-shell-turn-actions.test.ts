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
import { test } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { createAppShellTurnActions } from '../../renderer/app-shell-turn-actions.js';
import { getDesktopConversationCopy } from '../../renderer/application/contracts/conversation-copy.js';
import { deriveTurnFooterActions } from '../../renderer/application/contracts/turn-footer-actions.js';

test('footer no longer exposes Regenerate', () => {
  assert.deepEqual(
    deriveTurnFooterActions({
      status: 'completed',
      hasContent: true,
      locale: 'en',
    }).map((action) => action.id),
    ['branch', 'copy'],
  );
  assert.deepEqual(
    deriveTurnFooterActions({
      status: 'running',
      hasContent: false,
      locale: 'en',
    }).map((action) => action.id),
    ['branch', 'copy'],
  );
});

test('preserves a Branch copy identity after an ambiguous failure and completes it on success', async () => {
  const calls: Array<{ sourceTurnId: string; copyId?: string }> = [];
  let loseFirstResponse = true;
  let selectionRevision = 0;
  let navigateDuringBranch = false;
  const restoreWindow = installWindow(async (_sessionId, input) => {
    calls.push(input);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error('Committed response was lost');
    }
    if (navigateDuringBranch) selectionRevision += 1;
    return { ok: true, session: session(input.copyId ?? 'missing-copy-id') };
  });
  const pending = new Set<string>();
  const opened: string[] = [];
  const actions = createAppShellTurnActions({
    uiLocale: 'en',
    activeIdRef: { current: 'branch-action-source' },
    captureSelection: () => {
      const revision = selectionRevision;
      return () => revision === selectionRevision;
    },
    turnActionRegistry: {
      addKey: (key) => {
        if (pending.has(key)) return false;
        pending.add(key);
        return true;
      },
      clearKey: (key) => {
        pending.delete(key);
      },
      keyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
    },
    openSessionInChat: (sessionId) => {
      opened.push(sessionId);
    },
    refreshSessions: async () => [],
    toastApi: { info() {}, success() {}, error() {} },
  });

  try {
    await actions.handleTurnFooterAction('branch-action-turn', 'branch');
    await actions.handleTurnFooterAction('branch-action-turn', 'branch');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.copyId, calls[1]?.copyId);
    assert.deepEqual(opened, [calls[0]?.copyId]);

    // The display may still be the source while a newer navigation is loading.
    navigateDuringBranch = true;
    await actions.handleTurnFooterAction('branch-action-turn', 'branch');
    assert.equal(calls.length, 3);
    assert.equal(opened.length, 1, 'late Branch must not replace the newer selection');
    assert.notEqual(calls[2]?.copyId, calls[1]?.copyId);
  } finally {
    restoreWindow();
  }
});

test('explains why the Host refused a Branch instead of a generic failure', async () => {
  const copy = getDesktopConversationCopy('en').actions;
  for (const reason of ['session_busy', 'operation_unavailable'] as const) {
    const infos: Array<{ title: string; description?: string }> = [];
    const restoreWindow = installWindow(async () => ({ ok: false, reason }));
    try {
      await createAppShellTurnActions({
        uiLocale: 'en',
        activeIdRef: { current: 'branch-refused-source' },
        captureSelection: () => () => true,
        turnActionRegistry: { addKey: () => true, clearKey() {}, keyOf: () => 'key' },
        openSessionInChat: () => assert.fail('A refused Branch must not open a Session'),
        refreshSessions: async () => [],
        toastApi: {
          info: (title, description) => infos.push({ title, description }),
          success() {},
          error: () => assert.fail('A refused Branch is not an unexpected error'),
        },
      }).handleTurnFooterAction('branch-refused-turn', 'branch');
    } finally {
      restoreWindow();
    }
    assert.deepEqual(infos, [
      { title: copy.branchUnavailableTitle, description: copy.copyFailures[reason] },
    ]);
  }
});

function installWindow(
  branchFromTurn: (
    sessionId: string,
    input: { sourceTurnId: string; copyId?: string },
  ) => Promise<
    | { ok: true; session: SessionSummary }
    | { ok: false; reason: 'session_busy' | 'operation_unavailable' }
  >,
): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: { maka: { sessions: { branchFromTurn } } },
    writable: true,
  });
  return () => {
    if (hadWindow) {
      Object.defineProperty(target, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    } else {
      delete target.window;
    }
  };
}

function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test',
    permissionMode: 'ask',
  };
}
