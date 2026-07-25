import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createAppShellSessionStartActions } from '../../renderer/app-shell-session-start-actions.js';

type ToastCall = readonly [title: string, description?: string];
/** `showModelSetupToast(description, reason)` — the shell's shared
 *  "configure a model" toast, which carries the 打开模型设置 action. */
type SetupToastCall = readonly [description: string, reason?: string];

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

function createActions(
  toasts: ToastCall[],
  onRefreshOnboarding?: () => void,
  setupToasts: SetupToastCall[] = [],
  // Injectable rather than pinned to `true`: every interrupting branch in this
  // factory is supposed to check it, and a stub frozen on the happy value
  // cannot fail on that axis. Pinning it is how a missing gate shipped.
  isShellSurfaceOwnerActive: () => boolean = () => true,
) {
  return createAppShellSessionStartActions({
    uiLocale: 'en',
    activeIdRef: { current: undefined },
    captureComposerImportOwner: () => ({
      sessionId: undefined,
      navSection: 'sessions',
    }),
    composerRef: { current: null },
    isShellSurfaceOwnerActive,
    openSessionInChat: () => undefined,
    sessionStartPendingRef: { current: false },
    refreshOnboarding: onRefreshOnboarding ?? (() => undefined),
    refreshSessions: async () => undefined,
    showModelSetupToast: (description, reason) => setupToasts.push([description, reason]),
    toastApi: {
      error: (title, description) => toasts.push([title, description]),
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
   * and the renderer only re-pulled the onboarding snapshot. `sessions:create`
   * rejects instead, so that recovery has to survive on the throw path, and it
   * has to survive as a real DISCRIMINANT: the error main throws for an
   * unusable setup is `NO_REAL_CONNECTION:<reason>:` (chat-readiness.ts).
   * Asserting with a plain `new Error(...)` here would pass even if the
   * implementation treated every failure as a readiness failure.
   *
   * The snapshot refresh alone was not an answer. The hero it reveals only
   * takes the chat surface over while `sessions.length === 0 &&
   * !onboardingSettled` (app-shell.tsx), and onboarding-service backfills that
   * milestone for anyone who already has a session — so for every existing
   * user the command silently did nothing. The reason must reach the toast
   * intact, hence the specific description rather than the generic fallback.
   */
  it('re-pulls onboarding AND shows the model-setup toast for a readiness failure', async () => {
    let refreshed = 0;
    const restoreWindow = installWindow({
      sessions: {
        create: async () =>
          Promise.reject(new Error('NO_REAL_CONNECTION:missing_api_key: no ready connection')),
      },
      expertTeam: { start: async () => ({ ok: false, reason: 'unknown_team', teamId: 'x' }) },
    });
    const toasts: ToastCall[] = [];
    const setupToasts: SetupToastCall[] = [];

    try {
      const actions = createActions(
        toasts,
        () => {
          refreshed += 1;
        },
        setupToasts,
      );
      assert.equal(await actions.startModeSession('deep_research'), false);
    } finally {
      restoreWindow();
    }

    assert.equal(refreshed, 1);
    assert.deepEqual(setupToasts, [
      [
        'The current model connection has no usable credentials. Add an API key or sign in again under Settings · Models.',
        'missing_api_key',
      ],
    ]);
    // The generic failure toast must stay out of the way: this state has one
    // answer, and it is the actionable one.
    assert.deepEqual(toasts, []);
  });

  /**
   * `showModelSetupToast` ends in `openSettingsSection('models')`, so it
   * navigates. A create that rejects after the user moved on must not pull
   * them back: they are somewhere else on purpose, and the readiness problem
   * will still be there when they return.
   *
   * The sibling branches have always gated on the owner; the readiness branch
   * did not, and no test could see that while the stub was pinned to `true`.
   * Both entry points are covered because both had the same gap.
   */
  it('does not interrupt a surface the user has already left', async () => {
    let refreshed = 0;
    const restoreWindow = installWindow({
      sessions: {
        create: async () =>
          Promise.reject(new Error('NO_REAL_CONNECTION:missing_api_key: no ready connection')),
      },
      expertTeam: { start: async () => ({ ok: false, reason: 'setup_required' }) },
    });
    const toasts: ToastCall[] = [];
    const setupToasts: SetupToastCall[] = [];

    try {
      const actions = createActions(
        toasts,
        () => {
          refreshed += 1;
        },
        setupToasts,
        () => false,
      );
      assert.equal(await actions.startModeSession('deep_research'), false);
      assert.equal(await actions.handleExpertTeamStart('team'), false);
    } finally {
      restoreWindow();
    }

    assert.deepEqual(setupToasts, [], 'a stale surface must not be navigated away from');
    assert.deepEqual(toasts, []);
    // The snapshot refresh is global and silent, so it still runs — it keeps
    // the first-run hero accurate for whoever looks at it next.
    assert.equal(refreshed, 2);
  });

  /**
   * Every other interrupting branch, same stale surface. Written out because
   * the previous version of this file covered the readiness branch alone, and
   * "the gate the one covered branch has" is not the invariant — "no branch
   * speaks to a surface the user left" is. Deleting either owner check in the
   * workspace or fallback branches must turn this red.
   */
  it('holds that gate on every failure branch, not just readiness', async () => {
    const cases: Array<[label: string, error: Error]> = [
      ['workspace', new Error('SESSION_WORKSPACE_UNAVAILABLE: /gone')],
      ['unclassified', new Error('EIO: i/o error, write')],
    ];

    for (const [label, error] of cases) {
      const restoreWindow = installWindow({
        sessions: { create: async () => Promise.reject(error) },
        expertTeam: { start: async () => ({ ok: false, reason: 'workspace_unavailable' }) },
      });
      const toasts: ToastCall[] = [];
      const setupToasts: SetupToastCall[] = [];

      try {
        const actions = createActions(toasts, undefined, setupToasts, () => false);
        assert.equal(await actions.startModeSession('deep_research'), false);
        assert.equal(await actions.handleExpertTeamStart('team'), false);
      } finally {
        restoreWindow();
      }

      assert.deepEqual(toasts, [], `${label}: a stale surface must not be toasted`);
      assert.deepEqual(setupToasts, []);
    }
  });

  /**
   * `expertTeam:start` reports the same state through its own `setup_required`
   * reason code and carries no sub-reason, so the toast falls back to the
   * generic setup copy. Both entry points must answer, or the one that does
   * not is a silent dead end.
   */
  it('shows the model-setup toast when an expert team cannot start for setup', async () => {
    let refreshed = 0;
    const restoreWindow = installWindow({
      sessions: { create: async () => ({ id: 'session-1' }) },
      expertTeam: { start: async () => ({ ok: false, reason: 'setup_required' }) },
    });
    const toasts: ToastCall[] = [];
    const setupToasts: SetupToastCall[] = [];

    try {
      const actions = createActions(
        toasts,
        () => {
          refreshed += 1;
        },
        setupToasts,
      );
      assert.equal(await actions.handleExpertTeamStart('team'), false);
    } finally {
      restoreWindow();
    }

    assert.equal(refreshed, 1);
    assert.deepEqual(setupToasts, [
      ['This model connection cannot send right now. Check it in Settings · Models and try again.', undefined],
    ]);
    assert.deepEqual(toasts, []);
  });

  /**
   * The other half of that discriminant: a storage/disk/bug failure is NOT a
   * readiness failure. Re-deriving onboarding for it would tell the user their
   * setup is incomplete when it is fine, and swallowing the toast would leave
   * them with no feedback at all.
   */
  it('toasts an unclassified failure instead of blaming the setup', async () => {
    let refreshed = 0;
    const restoreWindow = installWindow({
      sessions: { create: async () => Promise.reject(new Error('EIO: i/o error, write')) },
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
    assert.equal(toasts[0]?.[0], 'Could not start conversation');
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
    assert.deepEqual(toasts, [
      [
        'Working directory unavailable',
        'The working directory does not exist or cannot be accessed. Select a valid folder for a new task.',
      ],
    ]);
  });
});
