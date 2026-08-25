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
    addTransientMessage: () => undefined,
    removeTransientMessage: () => undefined,
    transcriptRangeRef: { current: undefined },
    setNavSelection: () => undefined,
    setLiveTurnBySession: () => undefined,
    setInteractionBySession: () => undefined,
    showModelSetupToast: () => undefined,
    toastApi: { error: () => undefined, info: () => undefined },
    newChatModel: null,
    pendingNewChatThinkingLevel: null,
    newChatPermissionChoice: undefined,
    clearNewChatPermissionChoice: () => {},
    newChatCollaborationMode: 'agent' as const,
    newChatOrchestrationMode: 'default' as const,
    newTaskTarget: { profileId: 'local', hostId: 'host-local', projectId: null },
  };
}

const EMPTY_SKILL_INVOCATION = { loaded: [], failed: [], receipts: [] };

describe('busy-raced send settlement', () => {
  it('shows a Follow Up immediately and keeps its caller-owned identity', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const transient = new Map<string, StoredMessage>();
    let submittedMessageId: string | undefined;
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let observeSubmit!: () => void;
    const submitted = new Promise<void>((resolve) => {
      observeSubmit = resolve;
    });
    const restoreWindow = installWindow({
      sessions: {
        enqueue: async (_sessionId: string, _placement: string, command: { messageId: string }) => {
          submittedMessageId = command.messageId;
          observeSubmit();
          await admission;
          return {
            kind: 'queued',
            messageId: command.messageId,
            attachments: [],
            inlineReferences: [],
          };
        },
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });
      const sending = actions.enqueueMessage(
        'session-a',
        'do this next',
        'next_turn',
      );
      await submitted;

      assert.ok(submittedMessageId);
      assert.equal(transient.get(submittedMessageId)?.id, submittedMessageId);
      releaseAdmission();
      await sending;
      assert.deepEqual([...transient.keys()], [submittedMessageId]);
    } finally {
      restoreWindow();
    }
  });

  it('keeps a Follow Up visible when Host admission outcome is unknown', async () => {
    const transient = new Map<string, StoredMessage>();
    const restoreWindow = installWindow({
      sessions: {
        enqueue: async (_sessionId: string, _placement: string, command: { messageId: string }) => ({
          kind: 'outcome_unknown' as const,
          messageId: command.messageId,
        }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });

      await actions.enqueueMessage('session-a', 'do this next', 'next_turn');

      assert.equal(transient.size, 1);
      assert.equal([...transient.values()][0]?.type, 'user');
    } finally {
      restoreWindow();
    }
  });

  it('shows one stable local message before Host admission settles', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const transient = new Map<string, StoredMessage>();
    let submittedMessageId: string | undefined;
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let observeSubmit!: () => void;
    const submitted = new Promise<void>((resolve) => {
      observeSubmit = resolve;
    });
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async (_sessionId: string, command: { messageId: string }) => {
          submittedMessageId = command.messageId;
          observeSubmit();
          await admission;
          return {
            ok: true,
            disposition: 'turn_started',
            messageId: command.messageId,
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
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });
      const sending = actions.send('also check the tests');
      await submitted;

      assert.ok(submittedMessageId);
      const localMessage = transient.get(submittedMessageId);
      assert.equal(localMessage?.type, 'user');
      assert.equal(localMessage?.type === 'user' ? localMessage.text : undefined, 'also check the tests');

      releaseAdmission();
      assert.equal(await sending, true);
      assert.equal(transient.size, 1);
      assert.equal(transient.has(submittedMessageId), true);
      assert.equal(transient.has('host-turn'), false);
    } finally {
      restoreWindow();
    }
  });

  it('keeps one local row when Host admits the message as steering', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async (_sessionId: string, command: { messageId: string }) => ({
          ok: true,
          disposition: 'steering',
          messageId: command.messageId,
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
        addTransientMessage: (_sessionId, message) =>
          messageState.setMessages((current) => [...current.filter((item) => item.id !== message.id), message]),
        removeTransientMessage: (_sessionId, messageId) =>
          messageState.setMessages((current) => current.filter((message) => message.id !== messageId)),
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-a'], undefined);
      const local = messageState.messages.filter((message) => message.type === 'user');
      assert.equal(local.length, 1);
      assert.equal(local[0]?.id, local[0]?.turnId);
    } finally {
      restoreWindow();
    }
  });

  it('does not turn a Host-started admission into a renderer-owned LiveTurn', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async (_sessionId: string, command: { messageId: string }) => ({
          ok: true,
          disposition: 'turn_started',
          messageId: command.messageId,
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
        addTransientMessage: (_sessionId, message) =>
          messageState.setMessages((current) => [...current.filter((item) => item.id !== message.id), message]),
        removeTransientMessage: (_sessionId, messageId) =>
          messageState.setMessages((current) => current.filter((message) => message.id !== messageId)),
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-a'], undefined);
      const optimistic = messageState.messages.filter((message) => message.type === 'user');
      assert.equal(optimistic.length, 1);
      assert.notEqual(optimistic[0]?.id, 'host-turn');
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
        submitMessage: async (_sessionId: string, command: { messageId: string }) => {
          // The Host streamed under its own turn id before the IPC response.
          turnState.setLiveTurnBySession((current) => ({
            ...current,
            'session-a': { turnId: 'host-turn', phase: 'streamed', steps: [] } as LiveTurnProjection,
          }));
          return {
            ok: true,
            disposition: 'turn_started',
            messageId: command.messageId,
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
        addTransientMessage: (_sessionId, message) =>
          messageState.setMessages((current) => [...current.filter((item) => item.id !== message.id), message]),
        removeTransientMessage: (_sessionId, messageId) =>
          messageState.setMessages((current) => current.filter((message) => message.id !== messageId)),
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

  it('keeps the new-chat message through navigation when Host admits it as steering', async () => {
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
        submitMessage: async (_sessionId: string, command: { messageId: string }) => ({
          ok: true,
          disposition: 'steering',
          messageId: command.messageId,
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
        addTransientMessage: (_sessionId, message) =>
          messageState.setMessages((current) => [...current.filter((item) => item.id !== message.id), message]),
        removeTransientMessage: (_sessionId, messageId) =>
          messageState.setMessages((current) => current.filter((message) => message.id !== messageId)),
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.deepEqual(activated, ['session-new']);
      assert.equal(turnState.liveTurnBySession['session-new'], undefined);
      assert.equal(messageState.messages.filter((message) => message.type === 'user').length, 1);
      assert.deepEqual(removed, []);
    } finally {
      restoreWindow();
    }
  });

  it('keeps the new-chat messageId when Host chooses another turnId', async () => {
    const activeIdRef = { current: undefined as string | undefined };
    const turnState = createTurnState();
    const messageState = createMessageState();
    const restoreWindow = installWindow({
      newTasks: {
        create: async () => ({ id: 'session-new' }),
      },
      sessions: {
        submitMessage: async (_sessionId: string, command: { messageId: string }) => ({
          ok: true,
          disposition: 'turn_started',
          messageId: command.messageId,
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
        addTransientMessage: (_sessionId, message) =>
          messageState.setMessages((current) => [...current.filter((item) => item.id !== message.id), message]),
        removeTransientMessage: (_sessionId, messageId) =>
          messageState.setMessages((current) => current.filter((message) => message.id !== messageId)),
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-new'], undefined);
      const optimistic = messageState.messages.filter((message) => message.type === 'user');
      assert.equal(optimistic.length, 1);
      assert.notEqual(optimistic[0]?.id, 'host-turn');
    } finally {
      restoreWindow();
    }
  });
});
