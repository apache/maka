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
 * #1954 busy-race settlement: a submitted Message that raced a root turn
 * another client opened can come back `steered` (the send owns no turn) or
 * under a Host-chosen turnId. Both results must be interpreted identically by the
 * new-chat and existing-session branches, and a rebind must never overwrite
 * an authoritative live projection that beat the IPC response.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LiveTurnProjection, TransientUserMessageProjection } from '@maka/ui';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';

import {
  createActionsDeps,
  createTransientState,
  createTurnState,
  EMPTY_SKILL_INVOCATION,
  installWindow,
} from './app-shell-chat-actions-fixture.js';

describe('busy-raced send settlement', () => {
  it('shows a Follow Up immediately and keeps its caller-owned identity', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const transient = new Map<string, TransientUserMessageProjection>();
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
        submitMessage: async (
          _sessionId: string,
          _placement: string,
          command: { messageId: string },
        ) => {
          submittedMessageId = command.messageId;
          observeSubmit();
          await admission;
          return {
            ok: true,
            disposition: 'followup',
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
        updateTransientMessage: (_sessionId, message) => transient.set(message.id, message),
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
    const transient = new Map<string, TransientUserMessageProjection>();
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => ({ ok: false, reason: 'outcome_unknown' as const }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        updateTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });

      await actions.enqueueMessage('session-a', 'do this next', 'next_turn');

      assert.equal(transient.size, 1);
      assert.equal([...transient.values()][0]?.text, 'do this next');
    } finally {
      restoreWindow();
    }
  });

  it('retires a Follow Up the Host refused outright', async () => {
    const transient = new Map<string, TransientUserMessageProjection>();
    // A Follow Up submitted just as the running Turn settles is admitted as a
    // fresh Turn, so an unresolvable Skill token in it is refused outright.
    // No Turn opened and no canonical message will ever replace the row, so
    // leaving it visible would strand it there for the life of the Session.
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => ({
          ok: false,
          reason: 'skill_invocation_failed' as const,
          skillInvocation: {
            loaded: [],
            failed: [{ request: 'typo', reason: 'not_found' as const }],
            receipts: [],
          },
        }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        updateTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });

      await actions.enqueueMessage('session-a', '/skill:typo do this next', 'next_turn');

      assert.deepEqual([...transient.keys()], []);
    } finally {
      restoreWindow();
    }
  });

  it('reports a refused Follow Up as not sent', async () => {
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => ({
          ok: false as const,
          reason: 'skill_invocation_failed' as const,
          skillInvocation: {
            loaded: [],
            failed: [{ request: 'typo', reason: 'not_found' }],
            receipts: [],
          },
        }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
      });

      // Refusal is not an exception, so a caller that only watches for a throw
      // reads it as sent and clears the draft the user still needs.
      assert.equal(
        await actions.enqueueMessage('session-a', '/skill:typo do this next', 'next_turn'),
        false,
      );
    } finally {
      restoreWindow();
    }
  });

  it('reports an unproven Follow Up as sent so its text is not offered twice', async () => {
    const restoreWindow = installWindow({
      sessions: {
        submitMessage: async () => ({ ok: false as const, reason: 'outcome_unknown' as const }),
      },
    });
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
      });

      assert.equal(
        await actions.enqueueMessage('session-a', 'do this next', 'next_turn'),
        true,
      );
    } finally {
      restoreWindow();
    }
  });

  it('does not resurrect a Follow Up retracted before its IPC reply settles', async () => {
    const transient = new Map<string, TransientUserMessageProjection>();
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
        submitMessage: async (
          _sessionId: string,
          _placement: string,
          command: { messageId: string },
        ) => {
          submittedMessageId = command.messageId;
          observeSubmit();
          await admission;
          return {
            ok: true as const,
            disposition: 'followup' as const,
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
        activeIdRef: { current: 'session-a' },
        addTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        updateTransientMessage: (_sessionId, message) => {
          if (transient.has(message.id)) transient.set(message.id, message);
        },
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });
      const sending = actions.enqueueMessage('session-a', 'do this next', 'next_turn');
      await submitted;

      assert.ok(submittedMessageId);
      transient.delete(submittedMessageId);
      releaseAdmission();
      await sending;

      assert.deepEqual([...transient.keys()], []);
    } finally {
      restoreWindow();
    }
  });

  it('shows one stable local message before Host admission settles', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const transient = new Map<string, TransientUserMessageProjection>();
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
        submitMessage: async (
          _sessionId: string,
          _placement: string,
          command: { messageId: string },
        ) => {
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
        updateTransientMessage: (_sessionId, message) => transient.set(message.id, message),
        removeTransientMessage: (_sessionId, messageId) => transient.delete(messageId),
      });
      const sending = actions.send('also check the tests');
      await submitted;

      assert.ok(submittedMessageId);
      assert.equal(transient.get(submittedMessageId)?.text, 'also check the tests');

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
    const transientState = createTransientState();
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
        ...transientState.deps,
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-a'], undefined);
      // One row for one Message, still under the identity the client sent it
      // with: steering admission names no Turn to re-key it to.
      assert.equal(transientState.rows.size, 1);
    } finally {
      restoreWindow();
    }
  });

  it('does not turn a Host-started admission into a renderer-owned LiveTurn', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const turnState = createTurnState();
    const transientState = createTransientState();
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
        ...transientState.deps,
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-a'], undefined);
      assert.equal(transientState.rows.size, 1);
      assert.equal(transientState.rows.has('host-turn'), false);
      assert.equal([...transientState.rows.values()][0]?.hostTurnId, 'host-turn');
    } finally {
      restoreWindow();
    }
  });

  it('keeps an authoritative projection that arrived before the send response', async () => {
    const activeIdRef = { current: 'session-a' as string | undefined };
    const turnState = createTurnState();
    const transientState = createTransientState();
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
        ...transientState.deps,
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
    const transientState = createTransientState();
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
        activateSessionForFirstSend: async (sessionId) => {
          activated.push(sessionId);
          activeIdRef.current = sessionId;
        },
        setActiveId: (sessionId: string | undefined) => {
          activeIdRef.current = sessionId;
        },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        ...transientState.deps,
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.deepEqual(activated, ['session-new']);
      assert.equal(turnState.liveTurnBySession['session-new'], undefined);
      assert.equal(transientState.rows.size, 1);
      assert.deepEqual(removed, []);
    } finally {
      restoreWindow();
    }
  });

  it('keeps the new-chat messageId when Host chooses another turnId', async () => {
    const activeIdRef = { current: undefined as string | undefined };
    const turnState = createTurnState();
    const transientState = createTransientState();
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
        activateSessionForFirstSend: async (sessionId) => {
          activeIdRef.current = sessionId;
        },
        setActiveId: (sessionId: string | undefined) => {
          activeIdRef.current = sessionId;
        },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
        ...transientState.deps,
      });
      assert.equal(await actions.send('also check the tests'), true);
      assert.equal(turnState.liveTurnBySession['session-new'], undefined);
      assert.equal(transientState.rows.size, 1);
      assert.equal(transientState.rows.has('host-turn'), false);
    } finally {
      restoreWindow();
    }
  });
});
