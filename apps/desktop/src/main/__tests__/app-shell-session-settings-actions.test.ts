import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionSummary } from '@maka/core/session';
import { createAppShellSessionSettingsActions } from '../../renderer/app-shell-session-settings-actions.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
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
    llmConnectionSlug: 'e2e',
    connectionLocked: true,
    model: 'claude-sonnet',
    permissionMode: 'ask',
  };
}

function createHarness(options: { confirm?: () => Promise<boolean> } = {}) {
  const activeIdRef = { current: 'session-a' as string | undefined };
  const sessions = [session('session-a'), session('session-b')];
  const sessionsRef = { current: sessions };
  const pending = new Set<string>();
  const pendingBySession: Record<string, boolean> = {};
  const modelCalls: string[] = [];
  const permissionCalls: string[] = [];
  const thinkingCalls: string[] = [];
  const errors: string[] = [];
  const modelResult = deferred<SessionSummary>();
  const thinkingResult = deferred<SessionSummary>();

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      maka: {
        sessions: {
          setPermissionMode: async (sessionId: string, mode: 'ask' | 'bypass') => {
            permissionCalls.push(`${sessionId}:${mode}`);
            return { ...session(sessionId), permissionMode: mode };
          },
          setModel: async (sessionId: string) => {
            modelCalls.push(sessionId);
            return modelResult.promise;
          },
          setThinkingLevel: async (sessionId: string) => {
            thinkingCalls.push(sessionId);
            return thinkingResult.promise;
          },
        },
      },
    },
  });

  const actions = createAppShellSessionSettingsActions({
    uiLocale: 'zh',
    activeIdRef,
    connections: [{ slug: 'e2e', name: 'E2E' }] as LlmConnection[],
    pendingPermissionModeChangesRef: { current: new Set() },
    pendingSessionModelChangesRef: { current: pending },
    refreshSessions: async () => sessions,
    saveComposerDefaults: () => undefined,
    sessionsRef,
    setDefaultPermissionMode: () => undefined,
    setPendingPermissionModeBySession: () => undefined,
    setPendingSessionModelBySession: (update) => {
      const next = update(pendingBySession);
      for (const key of Object.keys(pendingBySession)) delete pendingBySession[key];
      Object.assign(pendingBySession, next);
    },
    setSessions: (update) => {
      sessionsRef.current = update(sessionsRef.current);
    },
    toastApi: {
      success: () => undefined,
      error: (title) => errors.push(title),
      confirm: options.confirm ?? (async () => true),
    },
  });

  return {
    actions,
    activeIdRef,
    errors,
    modelCalls,
    modelResult,
    pending,
    pendingBySession,
    permissionCalls,
    thinkingCalls,
    thinkingResult,
  };
}

describe('AppShell session settings actions', () => {
  it('does not grant full access when its confirmation is cancelled', async () => {
    let confirmations = 0;
    const harness = createHarness({
      confirm: async () => {
        confirmations += 1;
        return false;
      },
    });

    await harness.actions.setPermissionMode('bypass');

    assert.equal(confirmations, 1);
    assert.deepEqual(harness.permissionCalls, []);
  });

  it('blocks a thinking-level mutation while the same session model mutation is pending', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    await harness.actions.setSessionThinkingLevel('high');

    assert.deepEqual(harness.modelCalls, ['session-a']);
    assert.deepEqual(harness.thinkingCalls, []);
    assert.equal(harness.pendingBySession['session-a'], true);

    harness.modelResult.resolve(session('session-a'));
    await modelChange;
  });

  it('keeps another session available while the first session mutation is pending', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    harness.activeIdRef.current = 'session-b';
    const thinkingChange = harness.actions.setSessionThinkingLevel('high');

    assert.deepEqual(harness.modelCalls, ['session-a']);
    assert.deepEqual(harness.thinkingCalls, ['session-b']);
    assert.deepEqual(harness.pending, new Set(['session-a', 'session-b']));

    harness.thinkingResult.resolve(session('session-b'));
    await thinkingChange;
    harness.modelResult.resolve(session('session-a'));
    await modelChange;
  });

  it('blocks a model mutation while the same session thinking mutation is pending', async () => {
    const harness = createHarness();

    const thinkingChange = harness.actions.setSessionThinkingLevel('high');
    await harness.actions.setSessionModel({
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });

    assert.deepEqual(harness.thinkingCalls, ['session-a']);
    assert.deepEqual(harness.modelCalls, []);
    assert.equal(harness.pendingBySession['session-a'], true);

    harness.thinkingResult.resolve(session('session-a'));
    await thinkingChange;
    assert.equal(harness.pendingBySession['session-a'], undefined);
  });

  it('releases the session owner after a failed mutation so the next action can run', async () => {
    const harness = createHarness();

    const thinkingChange = harness.actions.setSessionThinkingLevel('high');
    harness.thinkingResult.reject(new Error('fixture failure'));
    await thinkingChange;

    assert.equal(harness.pending.has('session-a'), false);
    assert.equal(harness.pendingBySession['session-a'], undefined);
    assert.equal(harness.errors.length, 1);

    const modelChange = harness.actions.setSessionModel({
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    assert.deepEqual(harness.modelCalls, ['session-a']);
    harness.modelResult.resolve(session('session-a'));
    await modelChange;
  });
});
