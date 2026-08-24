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
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import {
  copyDesktopDiagnosticReport,
  createDesktopMainRendererDiagnosticInput,
  createDesktopPreviousMainProcessDiagnosticInput,
} from '../main-process-diagnostics.js';
import {
  showFatalStartupError,
  showMainRendererProcessGoneDialog,
  showMessageBoxWithDiagnostics,
  showPreviousMainProcessInterruptionDialog,
} from '../native-diagnostic-dialog.js';

const diagnosticEnvironment = () => ({
  appVersion: '0.1.8',
  buildMode: 'packaged' as const,
  buildCommit: null,
  electronVersion: '38.0.0',
  nodeVersion: '22.0.0',
  chromeVersion: '140.0.0',
  platform: 'linux' as const,
  arch: 'x64',
  osRelease: '6.6.0',
  locale: 'en-US',
  workspacePath: '/home/tester/.local/share/maka/workspaces/default',
  homePath: '/home/tester',
  processUptimeSeconds: 3,
});

test('copies diagnostics as an auxiliary native-dialog action', async () => {
  const shown: MessageBoxOptions[] = [];
  const responses = [2, 1];
  let copies = 0;

  const result = await showMessageBoxWithDiagnostics(
    {
      type: 'warning',
      message: 'Default Runtime Host is unavailable',
      detail: 'Could not connect',
      buttons: ['Retry', 'Keep Offline'],
      defaultId: 0,
      cancelId: 1,
    },
    {
      locale: 'en',
      showMessageBox: async (options): Promise<MessageBoxReturnValue> => {
        shown.push(options);
        return { response: responses.shift() ?? 1, checkboxChecked: false };
      },
      copyDiagnostics: () => {
        copies += 1;
      },
    },
  );

  assert.equal(result.response, 1);
  assert.equal(copies, 1);
  assert.deepEqual(shown[0]?.buttons, ['Retry', 'Keep Offline', 'Copy Diagnostics']);
  assert.deepEqual(shown[1]?.buttons, ['Retry', 'Keep Offline', 'Copy Again']);
  assert.match(shown[1]?.detail ?? '', /Diagnostics copied/);
});

test('fatal startup errors remain copyable without a renderer or BrowserWindow', async () => {
  const shown: MessageBoxOptions[] = [];
  const responses = [1, 0];
  let clipboard = '';

  await showFatalStartupError(new Error('Authorization: Bearer very-secret-token'), {
    locale: 'en',
    environment: diagnosticEnvironment,
    mainLogs: () => ['startup failed with Authorization: Bearer very-secret-token'],
    writeClipboard: (value) => {
      clipboard = value;
    },
    showMessageBox: async (options): Promise<MessageBoxReturnValue> => {
      shown.push(options);
      return { response: responses.shift() ?? 0, checkboxChecked: false };
    },
  });

  assert.deepEqual(shown[0]?.buttons, ['Exit', 'Copy Diagnostics']);
  assert.deepEqual(shown[1]?.buttons, ['Exit', 'Copy Again']);
  assert.match(shown[1]?.detail ?? '', /Diagnostics copied/);
  assert.match(clipboard, /Surface: startup/);
  assert.match(clipboard, /Recent main-process logs \(1\)/);
  assert.doesNotMatch(clipboard, /very-secret-token/);
});

test('main Renderer loss keeps Copy Diagnostics auxiliary to recovery', async () => {
  const shown: MessageBoxOptions[] = [];
  const responses = [2, 0];
  let clipboard = '';
  const diagnosticInput = createDesktopMainRendererDiagnosticInput({
    title: 'Maka main Renderer process exited unexpectedly',
    description: 'Reason: oom',
    details: 'Exit code: 137',
  });

  const decision = await showMainRendererProcessGoneDialog({
    locale: 'en',
    copyDiagnostics: () =>
      copyDesktopDiagnosticReport(
        {
          environment: diagnosticEnvironment,
          mainLogs: () => ['renderer stopped with api_key=very-secret-token'],
          resolveActiveRuntimeHost: () => {
            throw new Error('Renderer-loss diagnostics must remain Desktop-only');
          },
          resolveRuntimeHost: () => {
            throw new Error('Renderer-loss diagnostics must not resolve a task Host');
          },
          writeClipboard: (value) => {
            clipboard = value;
          },
        },
        diagnosticInput,
      ),
    showMessageBox: async (options): Promise<MessageBoxReturnValue> => {
      shown.push(options);
      return { response: responses.shift() ?? 1, checkboxChecked: false };
    },
  });

  assert.equal(decision, 'relaunch');
  assert.deepEqual(shown[0]?.buttons, ['Relaunch', 'Exit', 'Copy Diagnostics']);
  assert.deepEqual(shown[1]?.buttons, ['Relaunch', 'Exit', 'Copy Again']);
  assert.match(clipboard, /Surface: renderer_process_gone/);
  assert.match(clipboard, /Reason: oom/);
  assert.match(clipboard, /Exit code: 137/);
  assert.match(clipboard, /Recent main-process logs \(1\)/);
  assert.doesNotMatch(clipboard, /very-secret-token/);
});

test('previous main-process evidence remains copyable before a Renderer exists', async () => {
  const shown: MessageBoxOptions[] = [];
  const responses = [1, 0];
  let clipboard = '';
  const input = createDesktopPreviousMainProcessDiagnosticInput({
    run: {
      startedAt: '2026-08-20T00:00:00.000Z',
      appVersion: '0.1.10',
      buildMode: 'packaged',
      buildCommit: 'b'.repeat(40),
      electronVersion: '43.2.0',
      nodeVersion: '24.0.0',
      chromeVersion: '144.0.0',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.26100',
    },
    snapshotAt: '2026-08-20T00:10:00.000Z',
    logs: ['previous main log with api_key=very-secret-token'],
  });

  await showPreviousMainProcessInterruptionDialog({
    locale: 'en',
    copyDiagnostics: () =>
      copyDesktopDiagnosticReport(
        {
          environment: diagnosticEnvironment,
          mainLogs: () => ['current main log'],
          runtimeHostProcessLogs: () => ['current Runtime Host exit'],
          resolveActiveRuntimeHost: () => {
            throw new Error('Previous-run diagnostics must remain Desktop-only');
          },
          resolveRuntimeHost: () => {
            throw new Error('Previous-run diagnostics must not resolve a task Host');
          },
          writeClipboard: (value) => {
            clipboard = value;
          },
        },
        input,
      ),
    showMessageBox: async (options): Promise<MessageBoxReturnValue> => {
      shown.push(options);
      return { response: responses.shift() ?? 0, checkboxChecked: false };
    },
  });

  assert.deepEqual(shown[0]?.buttons, ['Continue', 'Copy Diagnostics']);
  assert.deepEqual(shown[1]?.buttons, ['Continue', 'Copy Again']);
  assert.match(clipboard, /Surface: previous_main_process_interruption/);
  assert.match(clipboard, /clean shutdown was not observed/);
  assert.match(clipboard, /Maka: 0\.1\.10/);
  assert.match(clipboard, /Recent previous main-process logs \(1\)/);
  assert.doesNotMatch(clipboard, /current main log|current Runtime Host exit|very-secret-token/);
});
