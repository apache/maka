import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createAppShellQuickChatActions } from '../../renderer/app-shell-quick-chat-actions.js';

type ToastCall = readonly [title: string, description?: string];

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

function createActions(toasts: ToastCall[]) {
  return createAppShellQuickChatActions({
    uiLocale: 'en',
    activeIdRef: { current: undefined },
    captureComposerImportOwner: () => ({
      sessionId: undefined,
      navSection: 'sessions',
    }),
    composerRef: { current: null },
    isShellSurfaceOwnerActive: () => true,
    openSessionInChat: () => undefined,
    quickChatPendingRef: { current: false },
    refreshOnboarding: () => undefined,
    refreshSessions: async () => undefined,
    setQuickChatPending: () => undefined,
    toastApi: {
      error: (title, description) => toasts.push([title, description]),
      info: (title, description) => toasts.push([title, description]),
    },
  });
}

describe('AppShell quick-entry failure copy', () => {
  it('sends only the mode — text and Skills belong to the Composer', async () => {
    let receivedInput: unknown;
    const restoreWindow = installWindow({
      quickChat: {
        start: async (input: unknown) => {
          receivedInput = input;
          return { ok: true, sessionId: 'session-1' };
        },
      },
      onboarding: { setMilestone: async () => undefined },
      expertTeam: { start: async () => ({ ok: false, reason: 'unknown_team', teamId: 'x' }) },
    });
    const toasts: ToastCall[] = [];

    try {
      const actions = createActions(toasts);
      assert.equal(await actions.handleQuickChatSubmit('deep_research'), true);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(receivedInput, { mode: 'deep_research' });
    assert.deepEqual(toasts, []);
  });

  it('does not surface Chinese main-process messages in the English UI', async () => {
    const restoreWindow = installWindow({
      quickChat: {
        start: async () => ({
          ok: false,
          reason: 'create_failed',
          message: '无法创建会话，请稍后再试。',
        }),
      },
      expertTeam: {
        start: async () => ({
          ok: false,
          reason: 'unknown_team',
          teamId: 'missing',
        }),
      },
    });
    const toasts: ToastCall[] = [];

    try {
      const actions = createActions(toasts);
      assert.equal(await actions.handleQuickChatSubmit(), false);
      assert.equal(await actions.handleExpertTeamStart('missing'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(toasts, [
      ['Could not start conversation', 'The conversation could not be started. Try again later.'],
      ['Could not start expert team', 'That expert team could not be found.'],
    ]);
    assert.doesNotMatch(JSON.stringify(toasts), /[\u3400-\u9fff]/u);
  });

  it('uses localized fallbacks for thrown quick-entry failures', async () => {
    const restoreWindow = installWindow({
      quickChat: { start: async () => Promise.reject({ code: 'unexpected' }) },
      expertTeam: { start: async () => Promise.reject({ code: 'unexpected' }) },
    });
    const toasts: ToastCall[] = [];

    try {
      const actions = createActions(toasts);
      assert.equal(await actions.handleQuickChatSubmit(), false);
      assert.equal(await actions.handleExpertTeamStart('team'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(toasts, [
      ['Could not start conversation', 'The conversation could not be started. Try again later.'],
      ['Could not start expert team', 'The expert team could not be started. Try again later.'],
    ]);
  });
});
