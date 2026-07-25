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

function createActionsDeps() {
  return {
    uiLocale: 'en' as const,
    activeIdRef: { current: undefined as string | undefined },
    addPendingSessionAction: () => true,
    captureComposerImportOwner: () => ({
      sessionId: undefined,
      navSection: 'sessions' as const,
    }),
    clearPendingSessionAction: () => undefined,
    isNewChatSendSurfaceActive: () => true,
    isShellSurfaceOwnerActive: () => true,
    markSessionReadLocally: () => undefined,
    markSessionRunningOptimistic: () => () => undefined,
    messageRetryPendingRef: { current: new Set<string>() },
    refreshSessions: async () => [],
    setActiveId: () => undefined,
    setMessageLoadErrorBySession: () => undefined,
    setMessageRetryPendingBySession: () => undefined,
    setMessages: () => undefined,
    setNavSelection: () => undefined,
    setLiveTurnBySession: () => undefined,
    setInteractionBySession: () => undefined,
    showModelSetupToast: () => undefined,
    toastApi: { error: () => undefined, info: () => undefined },
    upsertSessionSummary: () => undefined,
    validPendingNewChatModel: null,
    pendingNewChatThinkingLevel: null,
    newChatCollaborationMode: 'agent' as const,
    newChatOrchestrationMode: 'default' as const,
  };
}

describe('composer first-send cleanup', () => {
  it('removes the just-created session when the first send REJECTS', async () => {
    const removed: string[] = [];
    const restoreWindow = installWindow({
      sessions: {
        create: async () => ({ id: 'session-1' }),
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
      sessions: {
        create: async () => ({ id: 'session-1' }),
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
        readMessages: async () => [],
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
        create: async () => {
          throw new Error('must not create a session when one is already active');
        },
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
});

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
      create: async () => {
        throw new Error('must not create a session when one is already active');
      },
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
