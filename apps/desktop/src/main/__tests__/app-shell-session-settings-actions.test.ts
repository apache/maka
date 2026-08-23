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

function createHarness(options: {
  confirm?: () => Promise<boolean>;
  connections?: LlmConnection[];
  messages?: StoredMessage[];
} = {}) {
  const activeIdRef = { current: 'session-a' as string | undefined };
  const sessions = [session('session-a'), session('session-b')];
  const sessionsRef = { current: sessions };
  const pending = new Set<string>();
  const pendingBySession: Record<string, boolean> = {};
  const modelCalls: string[] = [];
  const permissionCalls: string[] = [];
  const thinkingCalls: string[] = [];
  const errors: string[] = [];
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
    connections: options.connections ?? ([{ slug: 'e2e', name: 'E2E' }] as LlmConnection[]),
    messages: options.messages ?? [],
    pendingPermissionModeChangesRef: { current: new Set() },
    pendingSessionModelChangesRef: { current: pending },
    refreshSessions: async () => sessions,
    saveComposerDefaults: () => undefined,
    sessionsRef,
    setNewTaskPermissionMode: (mode) => void newTaskPermissionModes.push(mode),
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
      success: (title, description) => successes.push({ title, description }),
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
    errors,
    errorTargets,
    modelCalls,
    modelResult,
    newTaskPermissionModes,
    pending,
    pendingBySession,
    permissionCalls,
    thinkingCalls,
    thinkingResult,
    successes,
  };
}

describe('AppShell session settings actions', () => {
  it('keeps a new-task permission choice in the draft instead of mutating a Host default', async () => {
    const harness = createHarness();
    harness.activeIdRef.current = undefined;

    await harness.actions.setPermissionMode('bypass');

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
      llmConnectionSlug: 'relay',
      model: 'claude-sonnet',
    });
    harness.modelResult.resolve({
      ...session('session-a'),
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
    assert.deepEqual(harness.errorTargets, [{ sessionId: 'session-a' }]);

    const modelChange = harness.actions.setSessionModel({
      llmConnectionSlug: 'e2e',
      model: 'claude-opus',
    });
    assert.deepEqual(harness.modelCalls, ['session-a']);
    harness.modelResult.resolve(session('session-a'));
    await modelChange;
  });
});
