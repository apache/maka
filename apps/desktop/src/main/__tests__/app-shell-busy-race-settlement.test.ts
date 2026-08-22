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

/**
 * #1954 busy-race settlement: a sessions:send that raced a root turn another
 * client opened can come back `steered` (the send owns no turn) or under a
 * Host-chosen turnId. Both results must be interpreted identically by the
 * new-chat and existing-session branches, and a rebind must never overwrite
 * an authoritative live projection that beat the IPC response.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { StoredMessage } from '@maka/core/session';
import type { LiveTurnProjection } from '@maka/ui';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';

function installWindow(maka: unknown): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: { maka },
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

function createTurnState() {
  const liveTurnBySession: Record<string, LiveTurnProjection> = {};
  return {
    liveTurnBySession,
    setLiveTurnBySession(
      updater: (c: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>,
    ) {
      const next = updater({ ...liveTurnBySession });
      for (const key of Object.keys(liveTurnBySession)) delete liveTurnBySession[key];
      Object.assign(liveTurnBySession, next);
    },
  };
}

function createMessageState() {
  const messages: StoredMessage[] = [];
  return {
    messages,
    setMessages(updater: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[])) {
      const next = typeof updater === 'function' ? updater([...messages]) : updater;
      messages.length = 0;
      messages.push(...next);
    },
  };
}

function createActionsDeps() {
  return {
    uiLocale: 'en' as const,
    activeIdRef: { current: undefined as string | undefined },
    addPendingSessionAction: () => true,
    captureComposerImportOwner: () => ({
      sessionId: undefined,
      navSection: 'sessions' as const,
    }),
    checkTaskSubmissionReadiness: async () => true,
    clearPendingSessionAction: () => undefined,
    isNewChatSendSurfaceActive: () => true,
    isShellSurfaceOwnerActive: () => true,
    markSessionReadLocally: () => undefined,
    messageRetryPendingRef: { current: new Set<string>() },
    refreshSessions: async () => [],
    setActiveId: () => undefined,
    setMessageLoadErrorBySession: () => undefined,
    setMessageRetryPendingBySession: () => undefined,
    setMessages: () => undefined,
    transcriptRangeRef: { current: undefined },
    setNavSelection: () => undefined,
    setLiveTurnBySession: () => undefined,
    setInteractionBySession: () => undefined,
    showModelSetupToast: () => undefined,
    toastApi: { error: () => undefined, info: () => undefined },
    upsertSessionSummary: () => undefined,
    newChatModel: null,
    pendingNewChatThinkingLevel: null,
    newChatPermissionMode: 'ask' as const,
    newChatCollaborationMode: 'agent' as const,
    newChatOrchestrationMode: 'default' as const,
    newTaskTarget: { profileId: 'local', hostId: 'host-local', projectId: null },
  };
}

const EMPTY_SKILL_INVOCATION = { loaded: [], failed: [], receipts: [] };

describe('busy-raced send settlement', () => {
  it('a steered send on an existing session disarms its turn and shows no optimistic message', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const restoreWindow = installWindow({
      sessions: {
        send: async (_sessionId: string, command: { turnId: string }) => ({
          ok: true,
          steered: true,
          turnId: command.turnId,
          attachments: [],
          inlineReferences: [],
          skillInvocation: EMPTY_SKILL_INVOCATION,
        }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        setMessages: messageState.setMessages,
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-a'], undefined);
      assert.deepEqual(messageState.messages, []);
    } finally {
      restoreWindow();
    }
  });

  it('rebinds the unconfirmed arm onto a Host-chosen turn id', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const restoreWindow = installWindow({
      sessions: {
        send: async () => ({
          ok: true,
          turnId: 'host-turn',
          attachments: [],
          inlineReferences: [],
          skillInvocation: EMPTY_SKILL_INVOCATION,
        }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        setMessages: messageState.setMessages,
      });
      assert.equal(await actions.send('also check the tests'), true);
      const live = turnState.liveTurnBySession['session-a'];
      assert.equal(live?.turnId, 'host-turn');
      assert.equal(live?.unconfirmed, true);
      const optimistic = messageState.messages.filter((message) => message.type === 'user');
      assert.equal(optimistic.length, 1);
      assert.equal(optimistic[0]?.turnId, 'host-turn');
    } finally {
      restoreWindow();
    }
  });

  it('keeps an authoritative projection that arrived before the send response', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const restoreWindow = installWindow({
      sessions: {
        send: async () => {
          // The Host streamed under its own turn id before the IPC response.
          turnState.setLiveTurnBySession((current) => ({
            ...current,
            'session-a': { turnId: 'host-turn', phase: 'streamed', steps: [] } as LiveTurnProjection,
          }));
          return {
            ok: true,
            turnId: 'host-turn',
            attachments: [],
            inlineReferences: [],
            skillInvocation: EMPTY_SKILL_INVOCATION,
          };
        },
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        setMessages: messageState.setMessages,
      });
      assert.equal(await actions.send('also check the tests'), true);
      const live = turnState.liveTurnBySession['session-a'];
      assert.equal(live?.turnId, 'host-turn');
      assert.equal(live?.phase, 'streamed');
      assert.equal(live?.unconfirmed, undefined);
    } finally {
      restoreWindow();
    }
  });

  it('a steered send on the new-chat path navigates without a ghost optimistic turn', async () => {
    const activeIdRef = { current: undefined as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const activated: string[] = [];
    const removed: string[] = [];
    const restoreWindow = installWindow({
      newTasks: {
        create: async () => ({ id: 'session-new' }),
      },
      sessions: {
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
        send: async (_sessionId: string, command: { turnId: string }) => ({
          ok: true,
          steered: true,
          turnId: command.turnId,
          attachments: [],
          inlineReferences: [],
          skillInvocation: EMPTY_SKILL_INVOCATION,
        }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        setActiveId: (sessionId: string | undefined) => {
          if (sessionId !== undefined) activated.push(sessionId);
          activeIdRef.current = sessionId;
        },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        setMessages: messageState.setMessages,
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.deepEqual(activated, ['session-new']);
      assert.equal(turnState.liveTurnBySession['session-new'], undefined);
      assert.deepEqual(messageState.messages, []);
      assert.deepEqual(removed, []);
    } finally {
      restoreWindow();
    }
  });

  it('a Host-chosen turn id on the new-chat path keys the optimistic state to it', async () => {
    const activeIdRef = { current: undefined as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const restoreWindow = installWindow({
      newTasks: {
        create: async () => ({ id: 'session-new' }),
      },
      sessions: {
        send: async () => ({
          ok: true,
          turnId: 'host-turn',
          attachments: [],
          inlineReferences: [],
          skillInvocation: EMPTY_SKILL_INVOCATION,
        }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        setActiveId: (sessionId: string | undefined) => {
          activeIdRef.current = sessionId;
        },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        setMessages: messageState.setMessages,
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-new']?.turnId, 'host-turn');
      const optimistic = messageState.messages.filter((message) => message.type === 'user');
      assert.equal(optimistic.length, 1);
      assert.equal(optimistic[0]?.turnId, 'host-turn');
    } finally {
      restoreWindow();
    }
  });
});
