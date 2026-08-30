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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { PermissionMode } from '@maka/core/permission';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
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

function session(id: string): DesktopSessionSummary {
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
    runtimeHostId: 'host-local',
    profileId: 'local',
    profileName: 'Local',
    profileKind: 'local',
  };
}

type ModelValue = { llmConnectionSlug: string; model: string };

function createHarness(options: {
  confirm?: () => Promise<boolean>;
  permissionModeResult?: 'ask' | 'bypass';
} = {}) {
  const activeIdRef = { current: 'session-a' as string | undefined };
  const sessions = [session('session-a'), session('session-b')];
  const sessionsRef = { current: sessions };
  const optimisticState = {
    optimisticPermissionModeBySession: {} as Record<string, PermissionMode>,
    optimisticSessionModelBySession: {} as Record<string, ModelValue>,
    optimisticSessionThinkingLevelBySession: {} as Record<string, ThinkingLevel | undefined>,
  };
  const modelCalls: string[] = [];
  const modelDeferreds: Array<ReturnType<typeof deferred<DesktopSessionSummary>>> = [];
  const thinkingCalls: string[] = [];
  const thinkingDeferreds: Array<ReturnType<typeof deferred<DesktopSessionSummary>>> = [];
  const permissionCalls: string[] = [];
  const errors: string[] = [];
  const errorTargets: Array<{ sessionId: string } | undefined> = [];
  const newTaskPermissionModes: string[] = [];
  const composerDefaults: ModelValue[] = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      maka: {
        sessions: {
          setPermissionMode: async (sessionId: string, mode: 'ask' | 'bypass') => {
            permissionCalls.push(`${sessionId}:${mode}`);
            return {
              ...session(sessionId),
              permissionMode: options.permissionModeResult ?? mode,
            };
          },
          setModel: async (sessionId: string) => {
            modelCalls.push(sessionId);
            const d = deferred<DesktopSessionSummary>();
            modelDeferreds.push(d);
            return d.promise;
          },
          setThinkingLevel: async (sessionId: string) => {
            thinkingCalls.push(sessionId);
            const d = deferred<DesktopSessionSummary>();
            thinkingDeferreds.push(d);
            return d.promise;
          },
        },
      },
    },
  });

  const actions = createAppShellSessionSettingsActions({
    uiLocale: 'zh',
    activeIdRef,
    getOptimisticState: () => optimisticState,
    refreshSessions: async () => sessions,
    saveComposerDefaults: (patch) => composerDefaults.push(patch.model),
    sessionsRef,
    setNewTaskPermissionMode: (mode) => void newTaskPermissionModes.push(mode),
    setOptimisticPermissionModeBySession: (update) => {
      optimisticState.optimisticPermissionModeBySession = update(optimisticState.optimisticPermissionModeBySession);
    },
    setOptimisticSessionModelBySession: (update) => {
      optimisticState.optimisticSessionModelBySession = update(optimisticState.optimisticSessionModelBySession);
    },
    setOptimisticSessionThinkingLevelBySession: (update) => {
      optimisticState.optimisticSessionThinkingLevelBySession = update(
        optimisticState.optimisticSessionThinkingLevelBySession,
      );
    },
    setSessions: (update) => {
      sessionsRef.current = update(sessionsRef.current);
    },
    toastApi: {
      error: (title, _description, _details, target) => {
        errors.push(title);
        errorTargets.push(target);
      },
      confirm: options.confirm ?? (async () => true),
    },
  });

  return {
    actions,
    activeIdRef,
    composerDefaults,
    errors,
    errorTargets,
    modelCalls,
    modelDeferreds,
    newTaskPermissionModes,
    optimisticState,
    permissionCalls,
    sessionsRef,
    thinkingCalls,
    thinkingDeferreds,
  };
}

describe('AppShell session settings actions', () => {
  it('keeps a new-task permission choice in the draft instead of mutating a Host default', async () => {
    const harness = createHarness();
    harness.activeIdRef.current = undefined;

    const switched = await harness.actions.setPermissionMode('bypass');

    assert.equal(switched, true);
    assert.deepEqual(harness.newTaskPermissionModes, ['bypass']);
    assert.deepEqual(harness.permissionCalls, []);
  });

  it('does not grant full access when its confirmation is cancelled', async () => {
    let confirmations = 0;
    const harness = createHarness({
      confirm: async () => {
        confirmations += 1;
        return false;
      },
    });

    const switched = await harness.actions.setPermissionMode('bypass');

    assert.equal(switched, false);
    assert.equal(confirmations, 1);
    assert.deepEqual(harness.permissionCalls, []);
    assert.equal(harness.optimisticState.optimisticPermissionModeBySession['session-a'], undefined);
  });

  it('commits a confirmed bypass switch and clears its overlay afterward', async () => {
    const harness = createHarness();

    const switched = await harness.actions.setPermissionMode('bypass');

    assert.equal(switched, true);
    assert.deepEqual(harness.permissionCalls, ['session-a:bypass']);
    assert.equal(harness.optimisticState.optimisticPermissionModeBySession['session-a'], undefined);
    assert.equal(harness.sessionsRef.current.find((s) => s.id === 'session-a')?.permissionMode, 'bypass');
  });

  it('does not report success when the Host returns another permission mode', async () => {
    const harness = createHarness({ permissionModeResult: 'ask' });

    const switched = await harness.actions.setPermissionMode('bypass');

    assert.equal(switched, false);
    assert.deepEqual(harness.permissionCalls, ['session-a:bypass']);
  });

  it('treats an already-active permission mode as successful without prompting', async () => {
    let confirmations = 0;
    const harness = createHarness({
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    harness.sessionsRef.current = [{
      ...session('session-a'),
      permissionMode: 'bypass',
    }];

    const switched = await harness.actions.setPermissionMode('bypass');

    assert.equal(switched, true);
    assert.equal(confirmations, 0);
    assert.deepEqual(harness.permissionCalls, []);
  });

  it('applies a model change optimistically and clears the overlay once committed', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-opus' });
    assert.deepEqual(harness.optimisticState.optimisticSessionModelBySession['session-a'], {
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });

    harness.modelDeferreds[0].resolve({ ...session('session-a'), model: 'claude-opus' });
    await modelChange;

    assert.equal(harness.optimisticState.optimisticSessionModelBySession['session-a'], undefined);
    assert.equal(harness.sessionsRef.current.find((s) => s.id === 'session-a')?.model, 'claude-opus');
    assert.deepEqual(harness.composerDefaults, [{ llmConnectionSlug: 'e2e', model: 'claude-opus' }]);
  });

  it('rolls back the overlay and shows one error on a terminal failure', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-opus' });
    harness.modelDeferreds[0].reject(new Error('fixture failure'));
    await modelChange;

    assert.equal(harness.optimisticState.optimisticSessionModelBySession['session-a'], undefined);
    assert.equal(harness.errors.length, 1);
    assert.deepEqual(harness.errorTargets, [{ sessionId: 'session-a' }]);
    assert.deepEqual(harness.composerDefaults, []);
    assert.equal(harness.sessionsRef.current.find((s) => s.id === 'session-a')?.model, 'claude-sonnet');
  });

  it('lets a newer model selection win over a slower in-flight one (latest wins)', async () => {
    const harness = createHarness();

    const firstChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-opus' });
    const secondChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-haiku' });
    assert.deepEqual(harness.modelCalls, ['session-a', 'session-a']);
    assert.deepEqual(harness.optimisticState.optimisticSessionModelBySession['session-a'], {
      llmConnectionSlug: 'e2e',
      model: 'claude-haiku',
    });

    harness.modelDeferreds[0].resolve({ ...session('session-a'), model: 'claude-opus' });
    await firstChange;

    assert.equal(harness.sessionsRef.current.find((s) => s.id === 'session-a')?.model, 'claude-sonnet');
    assert.equal(harness.errors.length, 0);
    assert.deepEqual(harness.optimisticState.optimisticSessionModelBySession['session-a'], {
      llmConnectionSlug: 'e2e',
      model: 'claude-haiku',
    });

    harness.modelDeferreds[1].resolve({ ...session('session-a'), model: 'claude-haiku' });
    await secondChange;

    assert.equal(harness.sessionsRef.current.find((s) => s.id === 'session-a')?.model, 'claude-haiku');
    assert.equal(harness.optimisticState.optimisticSessionModelBySession['session-a'], undefined);
  });

  it('does not roll back a newer selection when a superseded call fails', async () => {
    const harness = createHarness();

    const firstChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-opus' });
    const secondChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-haiku' });

    harness.modelDeferreds[0].reject(new Error('stale failure'));
    await firstChange;

    assert.deepEqual(harness.optimisticState.optimisticSessionModelBySession['session-a'], {
      llmConnectionSlug: 'e2e',
      model: 'claude-haiku',
    });
    assert.equal(harness.errors.length, 0);

    harness.modelDeferreds[1].resolve({ ...session('session-a'), model: 'claude-haiku' });
    await secondChange;
    assert.equal(harness.sessionsRef.current.find((s) => s.id === 'session-a')?.model, 'claude-haiku');
  });

  it('model and thinking-level writes for the same session do not block each other', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-opus' });
    const thinkingChange = harness.actions.setSessionThinkingLevel('high');

    assert.deepEqual(harness.modelCalls, ['session-a']);
    assert.deepEqual(harness.thinkingCalls, ['session-a']);

    harness.modelDeferreds[0].resolve({ ...session('session-a'), model: 'claude-opus' });
    harness.thinkingDeferreds[0].resolve({ ...session('session-a'), thinkingLevel: 'high' });
    await Promise.all([modelChange, thinkingChange]);
  });

  it('records an explicit "use model default" thinking-level choice distinctly from no override', async () => {
    const harness = createHarness();
    // Must start on a concrete level, or the "already at this value" guard skips.
    harness.sessionsRef.current = harness.sessionsRef.current.map((s) => (
      s.id === 'session-a' ? { ...s, thinkingLevel: 'high' } : s
    )) as typeof harness.sessionsRef.current;

    const thinkingChange = harness.actions.setSessionThinkingLevel(undefined);
    assert.equal('session-a' in harness.optimisticState.optimisticSessionThinkingLevelBySession, true);
    assert.equal(harness.optimisticState.optimisticSessionThinkingLevelBySession['session-a'], undefined);

    harness.thinkingDeferreds[0].resolve({ ...session('session-a'), thinkingLevel: undefined });
    await thinkingChange;
    assert.equal('session-a' in harness.optimisticState.optimisticSessionThinkingLevelBySession, false);
  });

  it('keeps two sessions fully independent', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({ llmConnectionSlug: 'e2e', model: 'claude-opus' });
    harness.activeIdRef.current = 'session-b';
    const thinkingChange = harness.actions.setSessionThinkingLevel('high');

    assert.deepEqual(harness.modelCalls, ['session-a']);
    assert.deepEqual(harness.thinkingCalls, ['session-b']);
    assert.deepEqual(harness.optimisticState.optimisticSessionModelBySession['session-a'], {
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    assert.equal(harness.optimisticState.optimisticSessionThinkingLevelBySession['session-b'], 'high');

    harness.thinkingDeferreds[0].resolve(session('session-b'));
    await thinkingChange;
    harness.modelDeferreds[0].resolve(session('session-a'));
    await modelChange;
  });
});
