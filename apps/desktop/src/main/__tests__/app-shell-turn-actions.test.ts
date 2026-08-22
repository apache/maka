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

test('preserves a Branch copy identity after an ambiguous failure and completes it on success', async () => {
  const calls: Array<{ sourceTurnId: string; copyId?: string }> = [];
  let loseFirstResponse = true;
  const restoreWindow = installWindow(async (_sessionId, input) => {
    calls.push(input);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error('Committed response was lost');
    }
    return session(input.copyId ?? 'missing-copy-id');
  });
  const pending = new Set<string>();
  const opened: string[] = [];
  const actions = createAppShellTurnActions({
    uiLocale: 'en',
    activeIdRef: { current: 'branch-action-source' },
    addPendingTurnAction: (key) => {
      if (pending.has(key)) return false;
      pending.add(key);
      return true;
    },
    clearPendingTurnAction: (key) => {
      pending.delete(key);
    },
    openSessionInChat: (sessionId) => {
      opened.push(sessionId);
    },
    pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setMessages: () => undefined,
    toastApi: { info() {}, success() {}, error() {} },
    upsertSessionSummary: () => undefined,
  });

  try {
    await actions.handleTurnFooterAction('branch-action-turn', 'branch');
    await actions.handleTurnFooterAction('branch-action-turn', 'branch');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.copyId, calls[1]?.copyId);
    assert.deepEqual(opened, [calls[0]?.copyId]);

    await actions.handleTurnFooterAction('branch-action-turn', 'branch');
    assert.equal(calls.length, 3);
    assert.notEqual(calls[2]?.copyId, calls[1]?.copyId);
  } finally {
    restoreWindow();
  }
});

function installWindow(
  branchFromTurn: (
    sessionId: string,
    input: { sourceTurnId: string; copyId?: string },
  ) => Promise<SessionSummary>,
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
