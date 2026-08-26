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

import { resolveSystemUiLocale } from '@maka/core/ui-locale';
import {
  DEV_LOSER_EXIT_CODE,
  developmentLaunchResultFile,
  shouldShowLoserDialog,
} from '@maka/core/dev-single-instance';
import { app, clipboard, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { resolveBuildInfo } from './build-info.js';
import {
  captureDesktopDiagnosticEnvironment,
  copyDesktopDiagnosticReport,
  createDesktopPreviousMainProcessDiagnosticInput,
  installMainProcessLogCapture,
  mainProcessLogBuffer,
} from './main-process-diagnostics.js';
import {
  appendUncaughtMainProcessError,
  createMainProcessRecoveryJournal,
  type MainProcessRecoveryJournal,
} from './main-process-recovery-journal.js';
import { showFatalStartupError } from './native-diagnostic-dialog.js';
import { isIsolatedE2e } from './startup-context.js';
import { reportDevelopmentLaunchResult } from './dev-single-instance-result.js';
import { registerPreviousMainProcessDiagnosticsIpc } from './desktop-diagnostics-ipc-main.js';

let recoveryJournal: MainProcessRecoveryJournal | undefined;
installMainProcessLogCapture(mainProcessLogBuffer, () => recoveryJournal?.markDirty());

// The macOS app menu title and app.getName() consumers read this name. Set it
// before ready, unchanged from its historical pre-ready position.
//
// Safe-by-default isolation: a dev build must not share the released app's
// userData root. Electron derives userData from the app name, so a distinct
// dev name yields a distinct root (and thus a distinct runtime-host rootId,
// socket/pipe namespace, and single-instance lock) without touching any
// path logic. See https://github.com/maka-agent/maka-agent/issues/2252.
app.setName(app.isPackaged ? 'Maka' : 'Maka Dev');

// E2E isolation: redirect userData BEFORE the single-instance lock so the
// lock judges the throwaway dir, not the real user data — otherwise a
// developer with Maka open makes the E2E process exit as a "second instance".
// Gated by isIsolatedE2e (not just the dir env) so a packaged build ignores
// it. Also before ready: userData must be pinned before any store opens.
if (isIsolatedE2e && process.env.MAKA_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.MAKA_E2E_USER_DATA_DIR);
}

// Electron does not enforce single-instance by default. Must run before any
// workspace/store setup below -- a losing second process exits immediately,
// before touching shared state. See the 'second-instance' listener in
// runtime-host-boot.ts for what the surviving process does about it.
if (!app.requestSingleInstanceLock()) {
  if (!app.isPackaged) {
    // Dev: losing the lock must NOT pretend to have started (exit 0 would be
    // read as a clean launch while the app was absorbed). A direct launcher
    // reads the child exit code; a detached TCC launcher reads its private,
    // one-shot result file. A direct launcher explicitly promises to consume
    // the exit code; a TCC launcher proves it has a consumer only when the
    // result write succeeds. Any other entry (Dock, Spotlight, Quit & Reopen)
    // gets a native box — fail toward the dialog. Linux pre-ready showErrorBox
    // degrades to stderr (no GUI); documented in electron.d.ts. Packaged builds
    // keep the existing UX (double-click focuses the first window) — the gate
    // is a semantic boundary.
    const resultReported = reportDevelopmentLaunchResult(process.argv, { status: 'loser' });
    if (!resultReported && shouldShowLoserDialog(process.argv)) {
      dialog.showErrorBox(
        'Maka Dev',
        `Another instance holds the Maka Dev profile (${app.getPath('userData')}). Quit it and retry.`,
      );
    }
    app.exit(DEV_LOSER_EXIT_CODE);
  } else {
    app.exit(0);
  }
} else {
  if (!app.isPackaged) {
    const resultReported = reportDevelopmentLaunchResult(process.argv, {
      status: 'winner',
    });
    if (developmentLaunchResultFile(process.argv) && !resultReported) {
      console.error('[dev] could not publish the single-instance launch result');
    }
  }
  const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());
  try {
    recoveryJournal = createMainProcessRecoveryJournal({
      root: join(app.getPath('userData'), 'main-process-recovery'),
      appVersion: app.getVersion(),
      buildMode: buildInfo.mode,
      buildCommit: buildInfo.commit,
      logs: () => mainProcessLogBuffer.snapshot(),
      onError: (error) => console.error('[diagnostics] main-process recovery failed:', error),
    });
    const journal = recoveryJournal;
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      appendUncaughtMainProcessError(mainProcessLogBuffer, journal, error, origin);
    });
    app.on('quit', () => journal.markClean());
    app.on('browser-window-created', (_event, window) => {
      window.on('session-end', () => journal.markClean());
    });
  } catch (error) {
    console.error('[diagnostics] main-process recovery unavailable:', error);
  }
  if (isIsolatedE2e) recoveryJournal?.discardPending();
  registerPreviousMainProcessDiagnosticsIpc({
    ipcMain,
    evidence: isIsolatedE2e ? undefined : recoveryJournal?.pending,
    acknowledge: () => recoveryJournal?.discardPending(),
    environment: () =>
      captureDesktopDiagnosticEnvironment({
        appVersion: app.getVersion(),
        buildMode: buildInfo.mode,
        buildCommit: buildInfo.commit,
        locale: app.getLocale(),
        workspacePath: join(app.getPath('userData'), 'workspaces', 'default'),
      }),
    mainLogs: () => mainProcessLogBuffer.snapshot(),
    resolveActiveRuntimeHost: () => undefined,
    resolveRuntimeHost: () => undefined,
    writeClipboard: (report) => clipboard.writeText(report),
  });
  // The full boot must not run in the top-level module-evaluation chain:
  // Electron ESM emits `ready` only after the entry module finishes
  // evaluating, so a top-level `await app.whenReady()` (which the
  // storage-root repair dialog needs) would deadlock. Boot therefore runs
  // after ready via a dynamic import, keeping the startup chain out of
  // module evaluation and preserving "root-identity check before any
  // store/db write".
  app
    .whenReady()
    .then(() => {
      console.log('[startup] app ready');
      return import('./runtime-host-boot.js');
    })
    .catch(async (error: unknown) => {
      console.error('[startup] fatal:', error);
      try {
        // E2E runs must not hang on a modal error box (same reasoning as the
        // fixture-fatal path in runtime-host-boot.ts: print a parseable line and exit fast).
        if (!isIsolatedE2e) {
          const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());
          await showFatalStartupError(error, {
            locale: resolveSystemUiLocale(app.getPreferredSystemLanguages()),
            environment: () =>
              captureDesktopDiagnosticEnvironment({
                appVersion: app.getVersion(),
                buildMode: buildInfo.mode,
                buildCommit: buildInfo.commit,
                locale: app.getLocale(),
                workspacePath: join(app.getPath('userData'), 'workspaces', 'default'),
              }),
            mainLogs: () => mainProcessLogBuffer.snapshot(),
            writeClipboard: (report) => clipboard.writeText(report),
            showMessageBox: (options) => dialog.showMessageBox(options),
          });
        }
      } finally {
        recoveryJournal?.markClean();
        app.exit(1);
      }
    });
}
