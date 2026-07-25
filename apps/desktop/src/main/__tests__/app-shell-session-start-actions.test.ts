import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createAppShellSessionStartActions } from '../../renderer/app-shell-session-start-actions.js';

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

function createActions(toasts: ToastCall[], onRefreshOnboarding?: () => void) {
  return createAppShellSessionStartActions({
    uiLocale: 'en',
    activeIdRef: { current: undefined },
    captureComposerImportOwner: () => ({
      sessionId: undefined,
      navSection: 'sessions',
    }),
    composerRef: { current: null },
    isShellSurfaceOwnerActive: () => true,
    openSessionInChat: () => undefined,
    sessionStartPendingRef: { current: false },
    refreshOnboarding: onRefreshOnboarding ?? (() => undefined),
    refreshSessions: async () => undefined,
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
      sessions: {
        create: async (input: unknown) => {
          receivedInput = input;
          return { id: 'session-1' };
        },
      },
      onboarding: { setMilestone: async () => undefined },
      expertTeam: { start: async () => ({ ok: false, reason: 'unknown_team', teamId: 'x' }) },
    });
    const toasts: ToastCall[] = [];

    try {
      const actions = createActions(toasts);
      assert.equal(await actions.startModeSession('deep_research'), true);
    } finally {
      restoreWindow();
    }

    // #1433: the renderer names the intent and nothing else. It must not
    // reach a permission boundary, name or label by sending them directly.
    assert.deepEqual(receivedInput, { mode: 'deep_research' });
    assert.deepEqual(toasts, []);
  });

  it('does not surface Chinese main-process messages in the English UI', async () => {
    const restoreWindow = installWindow({
      sessions: {
        create: async () => Promise.reject(new Error('无法创建会话，请稍后再试。')),
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
      assert.equal(await actions.startModeSession('deep_research'), false);
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
      sessions: { create: async () => Promise.reject({ code: 'unexpected' }) },
      expertTeam: { start: async () => Promise.reject({ code: 'unexpected' }) },
    });
    const toasts: ToastCall[] = [];

    try {
      const actions = createActions(toasts);
      assert.equal(await actions.startModeSession('deep_research'), false);
      assert.equal(await actions.handleExpertTeamStart('team'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(toasts, [
      ['Could not start conversation', 'The conversation could not be started. Try again later.'],
      ['Could not start expert team', 'The expert team could not be started. Try again later.'],
    ]);
  });

  /**
   * #1433: `quickChat:start` returned `{ ok: false, reason: 'setup_required' }`
   * and the renderer re-pulled the onboarding snapshot. `sessions:create`
   * rejects instead, so that recovery has to survive on the throw path — or a
   * user whose credentials went stale would get a toast and a hero still
   * claiming everything is fine.
   */
  it('re-pulls onboarding when session creation fails for a readiness reason', async () => {
    let refreshed = 0;
    const restoreWindow = installWindow({
      sessions: { create: async () => Promise.reject(new Error('no ready connection')) },
      expertTeam: { start: async () => ({ ok: false, reason: 'unknown_team', teamId: 'x' }) },
    });

    try {
      const actions = createActions([], () => {
        refreshed += 1;
      });
      assert.equal(await actions.startModeSession('deep_research'), false);
    } finally {
      restoreWindow();
    }

    assert.equal(refreshed, 1);
  });

  /**
   * An unusable workspace gets its own toast and must NOT be mistaken for a
   * readiness problem — re-deriving onboarding there would be noise, and the
   * user needs the workspace message, not the generic one.
   */
  it('routes an unavailable workspace to its own toast without touching onboarding', async () => {
    let refreshed = 0;
    const restoreWindow = installWindow({
      sessions: {
        create: async () =>
          Promise.reject(new Error('SESSION_WORKSPACE_UNAVAILABLE: /gone')),
      },
      expertTeam: { start: async () => ({ ok: false, reason: 'unknown_team', teamId: 'x' }) },
    });
    const toasts: ToastCall[] = [];

    try {
      const actions = createActions(toasts, () => {
        refreshed += 1;
      });
      assert.equal(await actions.startModeSession('deep_research'), false);
    } finally {
      restoreWindow();
    }

    assert.equal(refreshed, 0);
    assert.equal(toasts.length, 1);
    assert.notEqual(toasts[0]?.[0], 'Could not start conversation');
  });
});
