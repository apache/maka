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
import type { LlmConnection } from '@maka/core/llm-connections';
import type { StoredMessage } from '@maka/core/session';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
import { createAppShellSessionSettingsActions } from '../../renderer/app-shell-session-settings-actions.js';
import type { SessionPendingClaim } from '../../renderer/app-shell-session-ui-state.js';

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
    llmConnectionId: 'connection-1',
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

/** The store's claim semantics over a plain map the assertions can read. */
function pendingClaimOver(state: Record<string, boolean>): SessionPendingClaim {
  return {
    claim(key) {
      if (state[key] === true) return false;
      state[key] = true;
      return true;
    },
    release(key) {
      delete state[key];
    },
  };
}

function createHarness(options: {
  confirm?: () => Promise<boolean>;
  connections?: LlmConnection[];
  messages?: StoredMessage[];
  permissionModeResult?: 'ask' | 'bypass';
} = {}) {
  const activeIdRef = { current: 'session-a' as string | undefined };
  const sessions = [session('session-a'), session('session-b')];
  const sessionsRef = { current: sessions };
  const permissionModePending: Record<string, boolean> = {};
  const sessionModelPending: Record<string, boolean> = {};
  const modelCalls: string[] = [];
  const permissionCalls: string[] = [];
  const thinkingCalls: string[] = [];
  const errors: string[] = [];
  const errorDescriptions: Array<string | undefined> = [];
  const errorTargets: Array<{ sessionId: string } | undefined> = [];
  const successes: Array<{ title: string; description?: string }> = [];
  const newTaskPermissionModes: string[] = [];
  const modelResult = deferred<DesktopSessionSummary>();
  const thinkingResult = deferred<DesktopSessionSummary>();

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
    connections: options.connections ?? ([{ slug: 'e2e', name: 'E2E' }] as LlmConnection[]),
    messages: options.messages ?? [],
    permissionModePending: pendingClaimOver(permissionModePending),
    sessionModelPending: pendingClaimOver(sessionModelPending),
    refreshSessions: async () => sessions,
    saveComposerDefaults: () => undefined,
    sessionsRef,
    setNewTaskPermissionMode: (mode) => void newTaskPermissionModes.push(mode),
    toastApi: {
      success: (title, description) => successes.push({ title, description }),
      error: (title, description, _details, target) => {
        errors.push(title);
        errorDescriptions.push(description);
        errorTargets.push(target);
      },
      confirm: options.confirm ?? (async () => true),
    },
  });

  return {
    actions,
    activeIdRef,
    errors,
    errorDescriptions,
    errorTargets,
    modelCalls,
    modelResult,
    newTaskPermissionModes,
    permissionModePending,
    sessionModelPending,
    permissionCalls,
    sessionsRef,
    thinkingCalls,
    thinkingResult,
    successes,
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
  });

  it('reports a confirmed bypass switch as successful', async () => {
    const harness = createHarness();

    const switched = await harness.actions.setPermissionMode('bypass');

    assert.equal(switched, true);
    assert.deepEqual(harness.permissionCalls, ['session-a:bypass']);
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

  it('blocks a thinking-level mutation while the same session model mutation is pending', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    await harness.actions.setSessionThinkingLevel('high');

    assert.deepEqual(harness.modelCalls, ['session-a']);
    assert.deepEqual(harness.thinkingCalls, []);
    assert.equal(harness.sessionModelPending['session-a'], true);

    harness.modelResult.resolve(session('session-a'));
    await modelChange;
  });

  it('confirms both sides of a successful model change', async () => {
    const harness = createHarness({
      messages: [{
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'done',
        modelId: 'claude-haiku',
      }],
    });

    const modelChange = harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    harness.modelResult.resolve({ ...session('session-a'), model: 'claude-opus' });
    await modelChange;

    assert.deepEqual(harness.successes, [
      {
        title: '已切换当前任务模型',
        description: 'claude-haiku → claude-opus',
      },
    ]);
  });

  it('falls back to the configured model for a fresh conversation', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    harness.modelResult.resolve({ ...session('session-a'), model: 'claude-opus' });
    await modelChange;

    assert.equal(harness.successes[0]?.description, 'claude-sonnet → claude-opus');
  });

  it('includes connection names when a switch rebinds the connection', async () => {
    const harness = createHarness({
      connections: [
        { slug: 'e2e', name: 'Primary' },
        { slug: 'relay', name: 'Relay' },
      ] as LlmConnection[],
    });

    const modelChange = harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'relay',
      model: 'claude-sonnet',
    });
    harness.modelResult.resolve({
      ...session('session-a'),
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'relay',
    });
    await modelChange;

    assert.equal(
      harness.successes[0]?.description,
      'claude-sonnet (Primary) → claude-sonnet (Relay)',
    );
  });

  it('keeps another session available while the first session mutation is pending', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    harness.activeIdRef.current = 'session-b';
    const thinkingChange = harness.actions.setSessionThinkingLevel('high');

    assert.deepEqual(harness.modelCalls, ['session-a']);
    assert.deepEqual(harness.thinkingCalls, ['session-b']);
    assert.deepEqual(Object.keys(harness.sessionModelPending), ['session-a', 'session-b']);

    harness.thinkingResult.resolve(session('session-b'));
    await thinkingChange;
    harness.modelResult.resolve(session('session-a'));
    await modelChange;
  });

  it('blocks a model mutation while the same session thinking mutation is pending', async () => {
    const harness = createHarness();

    const thinkingChange = harness.actions.setSessionThinkingLevel('high');
    await harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });

    assert.deepEqual(harness.thinkingCalls, ['session-a']);
    assert.deepEqual(harness.modelCalls, []);
    assert.equal(harness.sessionModelPending['session-a'], true);

    harness.thinkingResult.resolve(session('session-a'));
    await thinkingChange;
    assert.equal(harness.sessionModelPending['session-a'], undefined);
  });

  it('releases the session owner after a failed mutation so the next action can run', async () => {
    const harness = createHarness();

    const thinkingChange = harness.actions.setSessionThinkingLevel('high');
    harness.thinkingResult.reject(new Error('fixture failure'));
    await thinkingChange;

    assert.equal(harness.sessionModelPending['session-a'], undefined);
    assert.equal(harness.errors.length, 1);
    assert.deepEqual(harness.errorTargets, [{ sessionId: 'session-a' }]);

    const modelChange = harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    assert.deepEqual(harness.modelCalls, ['session-a']);
    harness.modelResult.resolve(session('session-a'));
    await modelChange;
  });

  it('points a failed account-and-model switch at credential recovery', async () => {
    const harness = createHarness();

    const modelChange = harness.actions.setSessionModel({
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    harness.modelResult.reject(new Error('fixture failure'));
    await modelChange;

    assert.match(harness.errorDescriptions[0] ?? '', /设置 · 模型/);
    assert.match(harness.errorDescriptions[0] ?? '', /登录或 API Key/);
  });
});
