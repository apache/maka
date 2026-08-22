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
import { app, clipboard, dialog } from 'electron';
import { join } from 'node:path';
import { resolveBuildInfo } from './build-info.js';
import {
  captureDesktopDiagnosticEnvironment,
  installMainProcessLogCapture,
  mainProcessLogBuffer,
} from './main-process-diagnostics.js';
import { showFatalStartupError } from './native-diagnostic-dialog.js';
import { isIsolatedE2e } from './startup-context.js';

installMainProcessLogCapture();

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
  app.exit(0);
} else {
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
        app.exit(1);
      }
    });
}
