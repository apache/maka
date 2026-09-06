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

import { app, BrowserWindow, nativeTheme } from 'electron';
import { resolveSystemUiLocale } from '@maka/core/ui-locale';
import { readableAppIconPath } from './app-icon-surface.js';
import { installApplicationMenu } from './application-menu.js';
import { installDesktopStartupBranding } from './desktop-shell-presentation.js';
import { isIsolatedE2e } from './startup-context.js';
import { resolveWindowRevealMode } from './window-reveal.js';
import {
  createStartupProgressWindow,
  type StartupPhase,
  type StartupProgressWindow,
} from './startup-progress-window.js';

let progress: StartupProgressWindow | undefined;

const focus = () => progress?.focus();

/** Called after ready, before importing the asynchronous Runtime Host boot. */
export function showDesktopStartupProgress(
  copyDiagnostics: (phase: StartupPhase) => void | Promise<void>,
): void {
  const revealMode = resolveWindowRevealMode(
    isIsolatedE2e || Boolean(process.env.MAKA_E2E_FIXTURE),
    process.env.MAKA_E2E_SHOW_WINDOW === '1',
    app.isPackaged,
  );
  installDesktopStartupBranding(revealMode);
  // Automated runs retain their one-main-window contract and never steal focus.
  if (revealMode !== 'active') return;
  try {
    installApplicationMenu({
      platform: process.platform, isPackaged: app.isPackaged, dispatch: focus,
    });
    progress = createStartupProgressWindow({
      locale: resolveSystemUiLocale(app.getPreferredSystemLanguages()),
      dark: nativeTheme.shouldUseDarkColors,
      icon: readableAppIconPath('default'),
      createWindow: (options) => new BrowserWindow(options),
      copyDiagnostics,
      onError: (error) => console.error('[startup] progress presentation failed:', error),
    });
    app.on('activate', focus);
    app.on('second-instance', focus);
    app.once('before-quit', closeDesktopStartupProgress);
  } catch (error) {
    console.error('[startup] progress presentation failed:', error);
    closeDesktopStartupProgress();
  }
}

export function updateDesktopStartupProgress(phase: StartupPhase): void {
  progress?.update(phase);
}

export function desktopStartupProgressWindow(): BrowserWindow | undefined {
  return progress?.window();
}

export function isDesktopStartupInProgress(): boolean {
  return progress !== undefined;
}

export function closeDesktopStartupProgress(): void {
  app.removeListener('activate', focus);
  app.removeListener('second-instance', focus);
  app.removeListener('before-quit', closeDesktopStartupProgress);
  // Destroy can synchronously emit window-all-closed before the main window
  // exists (quit or renderer failure). Keep the startup lifetime guard then.
  progress?.close();
  progress = undefined;
}
