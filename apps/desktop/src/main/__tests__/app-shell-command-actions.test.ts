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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAppShellCommandList,
  resolveManualDiagnosticTarget,
  type AppShellCommandListOptions,
} from '../../renderer/app-shell-command-actions.js';
import {
  contextCompactionNotice,
  createContextCompactionPresentation,
  presentContextCompactionResult,
} from '../../renderer/features/conversation/testing.js';

test('targets manual diagnostics to the current task or new-task Host profile', () => {
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["remote-host","session-1"]' },
      'new-task-profile',
    ),
    { sessionId: '["remote-host","session-1"]' },
  );
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: undefined },
      'new-task-profile',
    ),
    { profileId: 'new-task-profile' },
  );
  assert.equal(
    resolveManualDiagnosticTarget(
      { navSection: 'extensions', sessionId: undefined },
      'new-task-profile',
    ),
    undefined,
  );
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["hidden-host","hidden-session"]' },
      'hidden-new-task-profile',
      true,
      'settings-profile',
    ),
    { profileId: 'settings-profile' },
  );
  assert.equal(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["hidden-host","hidden-session"]' },
      'hidden-new-task-profile',
      true,
    ),
    undefined,
  );
});

test('conversation copy and save wait for the complete transcript', async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let clipboard = '';
  let clipboardFailure = false;
  let saved = '';
  const errors: Array<[string, string]> = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (value: string) => {
      if (clipboardFailure) throw new Error('clipboard denied');
      clipboard = value;
    } } },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      maka: {
        sessions: {
          saveConversationToFile: async ({ markdown }: { markdown: string }) => {
            saved = markdown;
            return { ok: true };
          },
        },
      },
    },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const requested: string[] = [];
  const options = {
    uiLocale: 'en',
    activeId: 'session-1',
    activePermissionMode: undefined,
    canSetPermissionMode: true,
    clientPathsAccessible: false,
    connections: [],
    defaultConnection: null,
    renderCompleteConversation: async (sessionId: string) => {
      requested.push(sessionId);
      return 'oldest question\nnewest answer';
    },
    paletteActions: {
      saveConversationToFile: async ({ markdown }: { markdown: string }) => {
        saved = markdown;
        return { ok: true };
      },
    },
    newTaskProfileId: undefined,
    settingsOpen: false,
    settingsProfileId: undefined,
    sessionCatalog: {
      getState: () => ({ sessions: [{ id: 'session-1', name: 'Long task' }] }),
    },
    themePref: 'auto',
    hiddenSessionIds: new Set<string>(),
    captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
    createSession() {},
    openSideConversation() {},
    openHelp() {},
    openScheduledTaskCreate() {},
    openProjectFolder: async () => {},
    openSessionInChat() {},
    openSettings() {},
    openSettingsSection() {},
    openWorkspaceFolder: async () => {},
    refreshConnections: async () => {},
    copyTodayDailyReview: async () => {},
    pasteTodayDailyReview: async () => {},
    saveTodayDailyReview: async () => {},
    setNavSelection() {},
    setPermissionMode: async () => true,
    setThemePref() {},
    toastApi: { success() {}, info() {}, error(title: string, description: string) { errors.push([title, description]); } },
  } as unknown as AppShellCommandListOptions;
  const commands = buildAppShellCommandList({ current: options });

  await commands.find(({ id }) => id === 'diag:export-conversation')?.run();
  await commands.find(({ id }) => id === 'diag:save-conversation-file')?.run();

  assert.deepEqual(requested, ['session-1', 'session-1']);
  assert.match(clipboard, /oldest question/);
  assert.match(clipboard, /newest answer/);
  assert.match(saved, /oldest question/);
  assert.match(saved, /newest answer/);

  clipboardFailure = true;
  await commands.find(({ id }) => id === 'diag:export-conversation')?.run();
  assert.deepEqual(errors, [['Copy failed', 'Clipboard unavailable']]);
});

test('presents every successful-frame context compaction outcome', () => {
  assert.deepEqual(contextCompactionNotice({ kind: 'compacted', checkpointId: 'checkpoint-1' }, 'en'), {
    level: 'success',
    title: 'Context compacted',
    description: 'Older context was replaced with a checkpoint summary.',
  });
  assert.deepEqual(contextCompactionNotice({ kind: 'unchanged', reason: 'already_compacted' }, 'en'), {
    level: 'info',
    title: 'Nothing to compact',
    description: 'The task already uses the latest checkpoint.',
  });
  assert.deepEqual(contextCompactionNotice({ kind: 'failed', reason: 'write_failed' }, 'en'), {
    level: 'error',
    title: 'Compaction failed',
    description: 'The task could not be compacted. Try again later.',
  });
});

test('keeps async context compaction visible until its terminal outcome', () => {
  const shown: Array<{ title: string; duration?: number }> = [];
  const dismissed: string[] = [];
  const terminal: string[] = [];
  const presentation = createContextCompactionPresentation({
    toastApi: {
      toast(input) {
        shown.push({ title: input.title, duration: input.duration });
        return 'toast-running';
      },
      dismiss(id) {
        dismissed.push(id);
      },
    },
    presentTerminal(_sessionId, notice) {
      terminal.push(`${notice.level}:${notice.title}`);
    },
  });

  const accepted = presentContextCompactionResult(
    presentation,
    'session-1',
    {
      kind: 'started',
      turn: { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1', status: 'running' },
    },
    'en',
  );
  presentation.finished('session-1', 'turn-1', { kind: 'compacted', checkpointId: 'checkpoint-1' }, 'en');

  assert.equal(accepted, true);
  assert.deepEqual(shown, [{ title: 'Compacting context', duration: 0 }]);
  assert.deepEqual(dismissed, ['toast-running']);
  assert.deepEqual(terminal, ['success:Context compacted']);
});

test('does not revive or repeat a context compaction presentation after terminal delivery', () => {
  const shown: string[] = [];
  const terminal: string[] = [];
  const presentation = createContextCompactionPresentation({
    toastApi: {
      toast(input) {
        shown.push(input.title);
        return 'toast-running';
      },
      dismiss() {},
    },
    presentTerminal(_sessionId, notice) {
      terminal.push(notice.title);
    },
  });

  presentation.finished('session-1', 'turn-1', { kind: 'unchanged', reason: 'already_compacted' }, 'en');
  presentation.started('session-1', 'turn-1', 'en');
  presentation.finished('session-1', 'turn-1', { kind: 'unchanged', reason: 'already_compacted' }, 'en');

  assert.deepEqual(shown, []);
  assert.deepEqual(terminal, ['Nothing to compact']);
});
