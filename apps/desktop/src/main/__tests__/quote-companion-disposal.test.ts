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

import { deferred } from '@maka/core/test-only/async-primitives';
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type {
  SessionSummary,
  TurnRecord,
} from '@maka/core/session';
import {
  abandonPendingCompanionCopy,
  createFakeWorkbarServices,
  ensureCompanionFork,
  performCompanionTurn,
  type PerformCompanionTurnDeps,
  type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';
function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test-model',
    permissionMode: 'ask',
  };
}

function settledTurn(turnId: string): TurnRecord {
  return { turnId, status: 'completed', partialOutputRetained: false };
}

const sourceSession = session('side-chat-disposal-source');
const panelId = 'side-chat-disposal-panel';

function turnDeps(
  sideChat: WorkbarServices['sideChat'],
  overrides: Partial<PerformCompanionTurnDeps> = {},
): PerformCompanionTurnDeps {
  return {
    api: sideChat,
    sourceSession,
    panelId,
    name: 'Side chat',
    isDisposed: () => false,
    existingForkId: 'side-chat-existing-fork',
    turnId: 'side-chat-turn',
    text: 'Follow up',
    quotes: undefined,
    onForkCommitted: () => undefined,
    onBeforeSend: () => undefined,
    ...overrides,
  };
}

afterEach(async () => {
  await abandonPendingCompanionCopy(
    createFakeWorkbarServices().sideChat,
    sourceSession.id,
    panelId,
  );
});

describe('quote companion disposal fencing', () => {
  it('preserves a retryable busy reason from Side Conversation creation', async () => {
    const defaults = createFakeWorkbarServices();
    const sideChat = {
      ...defaults.sideChat,
      listTurns: async () => [settledTurn('source-turn')],
      branchFromTurn: async () => ({ ok: false as const, reason: 'session_busy' as const }),
    };

    assert.deepEqual(
      await ensureCompanionFork({
        api: sideChat,
        sourceSession,
        panelId,
        name: 'Side chat',
        isDisposed: () => false,
      }),
      { status: 'error', code: 'fork_source_busy' },
    );
  });

  it('does not start a send when the panel was disposed after fork setup', async () => {
    let sends = 0;
    let armed = 0;
    const defaults = createFakeWorkbarServices();
    const sideChat = {
      ...defaults.sideChat,
      send: async () => {
        sends += 1;
        return { ok: true as const, turnId: 'side-chat-turn' };
      },
    };

    const result = await performCompanionTurn(
      turnDeps(sideChat, {
        isDisposed: () => true,
        onBeforeSend: () => {
          armed += 1;
        },
      }),
    );

    assert.deepEqual(result, { status: 'disposed' });
    assert.equal(armed, 0);
    assert.equal(sends, 0);
  });

  it('does not report success when disposal wins the send race', async () => {
    const pendingSend = deferred<{ ok: true; turnId: string }>();
    let disposed = false;
    const defaults = createFakeWorkbarServices();
    const sideChat = {
      ...defaults.sideChat,
      send: () => pendingSend.promise,
    };
    const turn = performCompanionTurn(
      turnDeps(sideChat, {
        isDisposed: () => disposed,
      }),
    );

    disposed = true;
    pendingSend.resolve({ ok: true, turnId: 'side-chat-turn' });

    assert.deepEqual(await turn, { status: 'disposed' });
  });

  it('cleans a fork that resolves after its panel was disposed and never sends', async () => {
    const pendingFork = deferred<SessionSummary>();
    const cleaned: string[] = [];
    let disposed = false;
    let sends = 0;
    const defaults = createFakeWorkbarServices();
    const sideChat = {
      ...defaults.sideChat,
      listTurns: async () => [settledTurn('source-turn')],
      branchFromTurn: async () => ({ ok: true as const, session: await pendingFork.promise }),
      cleanupSessionCopy: async (sessionId: string) => {
        cleaned.push(sessionId);
      },
      send: async () => {
        sends += 1;
        return { ok: true as const, turnId: 'side-chat-turn' };
      },
    };
    const turn = performCompanionTurn(
      turnDeps(sideChat, {
        existingForkId: null,
        isDisposed: () => disposed,
      }),
    );

    await Promise.resolve();
    disposed = true;
    pendingFork.resolve(session('side-chat-late-fork'));

    assert.deepEqual(await turn, { status: 'disposed' });
    assert.deepEqual(cleaned, ['side-chat-late-fork']);
    assert.equal(sends, 0);
  });
});
