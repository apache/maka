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
 * #1433: the composer is now the only path that starts a conversation, and it
 * creates the session BEFORE it sends. Every way that first send can fail has
 * to take the session with it, or the sidebar collects nameless empty rows the
 * user never asked for.
 *
 * `sessions:send` fails two different ways — it returns `{ ok: false }` for a
 * blocked Skill invocation, and it REJECTS when Skill discovery or
 * project-context resolution fails (`prepareSkillInvocation`,
 * `ensureSessionCanSend`). The deleted `quick-chat.ts` carried unit tests for
 * both halves; when it went away, only the `ok: false` half kept coverage (in
 * composer-skill-invocation.spec.ts). This file covers the throw half, which
 * no E2E can reach deterministically.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { SessionSummary } from '@maka/core/session';
import type { LiveTurnProjection } from '@maka/ui';
import type { DesktopTranscriptRangeController } from '../../renderer/desktop-transcript-range-store.js';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';
import { createAppShellSessionUiStateController } from '../../renderer/app-shell-session-ui-state.js';
import { settledSessionTransientIds } from '../../renderer/settled-session-transients.js';

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

/**
 * The live-turn arm as a real map rather than a black-hole stub: a send that
 * never lands must leave nothing behind, and that cannot be asserted against a
 * no-op setter.
 */
function createTurnState() {
  const liveTurnBySession: Record<string, LiveTurnProjection> = {};
  return {
    liveTurnBySession,
    setLiveTurnBySession(updater: (c: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) {
      const next = updater({ ...liveTurnBySession });
      for (const key of Object.keys(liveTurnBySession)) delete liveTurnBySession[key];
      Object.assign(liveTurnBySession, next);
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
    newChatPermissionMode: 'ask' as const,
    pendingNewChatThinkingLevel: null,
    newChatCollaborationMode: 'agent' as const,
    newChatOrchestrationMode: 'default' as const,
    newTaskTarget: { profileId: 'local', hostId: 'host-local', projectId: null },
  };
}

describe('composer first-send cleanup', () => {
  it('cancels when the composer owner changes during the readiness check', async () => {
    const readiness = deferred<boolean>();
    const activeIdRef = { current: 'session-a' as string | undefined };
    let sends = 0;
    const restoreWindow = installWindow({
      sessions: {
        send: async () => {
          sends += 1;
          return { ok: true, attachments: [], skillInvocation: { loaded: [], failed: [] } };
        },
      },
    });

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        captureComposerImportOwner: () => ({
          sessionId: activeIdRef.current,
          navSection: 'sessions',
        }),
        checkTaskSubmissionReadiness: () => readiness.promise,
        isShellSurfaceOwnerActive: (owner) => owner.sessionId === activeIdRef.current,
      });
      const sending = actions.send('hello');
      activeIdRef.current = 'session-b';
      readiness.resolve(true);

      assert.equal(await sending, false);
      assert.equal(sends, 0, 'readiness for session A must never authorize a send to session B');
    } finally {
      restoreWindow();
    }
  });

  it('passes the effective offered model when creating the first session', async () => {
    let createInput: unknown;
    const restoreWindow = installWindow({
      newTasks: {
        create: async (_target: unknown, input: unknown) => {
          createInput = input;
          return { id: 'session-1' };
        },
      },
      sessions: {
        send: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
      },
    });

    try {
      const deps = {
        ...createActionsDeps(),
        newChatPermissionMode: 'bypass' as const,
        newChatModel: {
          llmConnectionSlug: 'opencode-free',
          model: 'mimo-v2.5-free',
        },
      };
      assert.equal(await createAppShellChatActions(deps).send('hello'), true);
    } finally {
      restoreWindow();
    }

    assert.equal(
      (createInput as { llmConnectionSlug?: unknown }).llmConnectionSlug,
      'opencode-free',
    );
    assert.equal((createInput as { model?: unknown }).model, 'mimo-v2.5-free');
    assert.equal((createInput as { permissionMode?: unknown }).permissionMode, 'bypass');
  });

  it('creates the first session on the selected Runtime Host and project', async () => {
    let createTarget: unknown;
    let createInput: unknown;
    const restoreWindow = installWindow({
      newTasks: {
        create: async (target: unknown, input: unknown) => {
          createTarget = target;
          createInput = input;
          return { id: 'session-1' };
        },
      },
      sessions: {
        send: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
      },
    });

    try {
      const deps = {
        ...createActionsDeps(),
        newTaskTarget: {
          profileId: 'office',
          hostId: 'host-office',
          projectId: 'project-docs',
        },
      };
      assert.equal(await createAppShellChatActions(deps).send('hello'), true);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(createTarget, {
      profileId: 'office',
      hostId: 'host-office',
      projectId: 'project-docs',
    });
    assert.equal((createInput as { projectId?: unknown }).projectId, undefined);
  });

  it('removes the just-created session when the first send REJECTS', async () => {
    const removed: string[] = [];
    const restoreWindow = installWindow({
      newTasks: { create: async () => ({ id: 'session-1' }) },
      sessions: {
        // What `prepareSkillInvocation` does when Skill discovery fails.
        send: async () => Promise.reject(new Error('Skill discovery failed')),
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
      },
    });

    try {
      assert.equal(await createAppShellChatActions(createActionsDeps()).send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(removed, ['session-1']);
  });

  it('keeps the session once the first send lands', async () => {
    const removed: string[] = [];
    const restoreWindow = installWindow({
      newTasks: { create: async () => ({ id: 'session-1' }) },
      sessions: {
        send: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
        // A successful send must never reach this — refreshMessagesUntilTurn
        // and the rest of the happy path run after the cleanup window closes.
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
      },
    });

    try {
      assert.equal(await createAppShellChatActions(createActionsDeps()).send('hello'), true);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(removed, []);
  });

  it('leaves an EXISTING session alone when its send rejects', async () => {
    // Only the session this send created is disposable. A send that fails in
    // an open conversation must not delete the conversation.
    const removed: string[] = [];
    const restoreWindow = installWindow({
      sessions: {
        send: async () => Promise.reject(new Error('Skill discovery failed')),
        remove: async (sessionId: string) => {
          removed.push(sessionId);
        },
      },
    });

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'existing-session' },
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(removed, []);
  });

  it('returns a sparse existing session to latest before sending', async () => {
    const latest = deferred<void>();
    const order: string[] = [];
    const activeIdRef = { current: 'existing-session' as string | undefined };
    const transcript = {
      store: {
        range: () => ({ sessionId: 'existing-session', hasNewer: true }),
        snapshot: () => ({ messages: [] }),
      },
      async loadLatest() {
        order.push('latest');
        await latest.promise;
      },
    } as unknown as DesktopTranscriptRangeController;
    const transcriptRangeRef = { current: transcript as DesktopTranscriptRangeController | undefined };
    const restoreWindow = installWindow({
      sessions: {
        send: async () => {
          order.push('send');
          return { ok: true, attachments: [], skillInvocation: { loaded: [], failed: [] } };
        },
      },
    });

    try {
      const sending = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef,
        transcriptRangeRef,
      }).send('hello');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, ['latest']);
      latest.resolve();
      assert.equal(await sending, true);
      assert.deepEqual(order, ['latest', 'send']);
    } finally {
      restoreWindow();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * #1433 round 5: the failure feedback for a send is addressed to the surface
 * that sent, and `showModelSetupToast` is not just a toast — it ends in
 * `openSettingsSection('models')` (app-shell.tsx), so it navigates.
 *
 * This branch used to decide "am I still that surface" by comparing the
 * session id alone. `selectNavigation` never clears `activeId`
 * (nav-selection.ts), so a user who left the chat for 扩展 → 技能 while the
 * send was in flight still matched, and a readiness rejection yanked them into
 * 设置 · 模型. It now asks the shell's one owner predicate, which compares the
 * nav section too.
 */
describe('composer send failure feedback', () => {
  const readinessFailure = () => ({
    sessions: {
      send: async () =>
        Promise.reject(new Error('NO_REAL_CONNECTION:missing_api_key: no ready connection')),
      remove: async () => undefined,
    },
  });

  it('does not navigate a surface the user left mid-flight', async () => {
    const setupToasts: string[] = [];
    const restoreWindow = installWindow(readinessFailure());

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        // The user is on 技能 now. `activeId` is still 'session-a' — that is
        // the whole point: the id alone cannot answer this question.
        isShellSurfaceOwnerActive: () => false,
        isNewChatSendSurfaceActive: () => false,
        showModelSetupToast: (description: string) => setupToasts.push(description),
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(setupToasts, [], 'a stale surface must not be navigated to 设置 · 模型');
  });

  // A send that never reaches the runtime must take its arm with it. A leftover
  // arm still carries its `unconfirmed` claim, which would make
  // `settledSessionTransientIds` protect a turn that does not exist — leaving a
  // Stop button nothing can clear.
  it('leaves no arm behind when the send never lands', async () => {
    const turnState = createTurnState();
    const restoreWindow = installWindow(readinessFailure());

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        setLiveTurnBySession: turnState.setLiveTurnBySession,
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(turnState.liveTurnBySession, {}, 'the arm must be disarmed');
  });

  it('still answers the surface that is actually waiting', async () => {
    const setupToasts: string[] = [];
    const restoreWindow = installWindow(readinessFailure());

    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: 'session-a' },
        isShellSurfaceOwnerActive: () => true,
        showModelSetupToast: (description: string) => setupToasts.push(description),
      });
      assert.equal(await actions.send('hello'), false);
    } finally {
      restoreWindow();
    }

    assert.equal(setupToasts.length, 1, 'the user who is still looking must get the answer');
  });
});

/**
 * The bug this guards, as the sequence that actually produced it: send arms the
 * turn, a session list that was already in flight lands still carrying the
 * pre-send status, and the settle reconcile runs against it.
 *
 * Nothing in that list is wrong — the runtime writes `status: 'running'` only at
 * the end of `AgentRun.begin` and announces it to nobody until `onRunStarted`.
 * The list simply predates the answer. Reading it as a settle used to drop the
 * arm, so the first content event rebuilt the projection as `'streamed'` and the
 * prominent "正在处理…" silently became the calm "继续中…".
 *
 * Asserted through the real `send`, the real state controller, and the real
 * settle rule, because the defect lived in how those three compose — each one is
 * individually correct.
 */
describe('a send in flight versus a stale session list', () => {
  const sessionId = 'session-a';

  function sendingWindow() {
    return {
      sessions: {
        send: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [] },
        }),
      },
    };
  }

  // The list as it reads before the runtime's `running` write — identical to how
  // it reads after the turn is over, which is exactly why the status alone
  // cannot settle anything.
  const preSendList = [{ id: sessionId, status: 'active', statusUpdatedAt: 100 }] as SessionSummary[];

  async function armViaSend(controller: ReturnType<typeof createAppShellSessionUiStateController>) {
    const restoreWindow = installWindow(sendingWindow());
    try {
      const actions = createAppShellChatActions({
        ...createActionsDeps(),
        activeIdRef: { current: sessionId },
        setLiveTurnBySession: controller.setLiveTurnBySession,
      });
      assert.equal(await actions.send('hello'), true);
    } finally {
      restoreWindow();
    }
    const armed = controller.getState().liveTurnBySession[sessionId];
    assert.equal(armed?.unconfirmed, true, 'the send must arm an unconfirmed turn');
    return armed!.turnId;
  }

  function settle(controller: ReturnType<typeof createAppShellSessionUiStateController>) {
    return settledSessionTransientIds({
      activeId: sessionId,
      sessions: preSendList,
      liveTurnBySession: controller.getState().liveTurnBySession,
    });
  }

  it('keeps the armed turn, and settles it once the authority names that turn', async () => {
    const controller = createAppShellSessionUiStateController();
    const turnId = await armViaSend(controller);

    assert.deepEqual(settle(controller), [], 'a list older than the answer must not settle the turn');
    assert.equal(
      controller.getState().liveTurnBySession[sessionId]?.phase,
      'waiting',
      'the first-token wait must survive the stale refresh',
    );

    // `sessions:changed` naming this turn — what `onRunStarted` now emits once
    // the run has begun. This is the same controller entry point the shell
    // wires that subscription to.
    controller.confirmLiveTurn(sessionId, turnId);

    assert.deepEqual(settle(controller), [sessionId], 'an answered turn settles under the plain status rules');
  });

  it('ignores an answer about a turn other than the one in flight', async () => {
    const controller = createAppShellSessionUiStateController();
    await armViaSend(controller);

    controller.confirmLiveTurn(sessionId, 'turn-from-another-client');

    assert.deepEqual(settle(controller), [], 'only this send\'s own turn may release its claim');
  });
});
