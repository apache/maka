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

import { app, BrowserWindow, clipboard, nativeTheme } from 'electron';
import { resolveSystemUiLocale, type UiLocale } from '@maka/core/ui-locale';
import type { HostHandoffView, OpenHostHandoffSurface } from '@maka/runtime-host/client';
import { readableAppIconPath } from './app-icon-surface.js';
import { installApplicationMenu } from './application-menu.js';
import { installDesktopStartupBranding } from './desktop-shell-presentation.js';
import { isIsolatedE2e } from './startup-context.js';
import { resolveWindowRevealMode, type WindowRevealMode } from './window-reveal.js';
import {
  createStartupProgressWindow,
  type StartupPhase,
  type StartupProgressWindow,
} from './startup-progress-window.js';

let progress: StartupProgressWindow | undefined;
let handoffUsesStartup = false;

const focus = () => progress?.focus();

/**
 * The run's reveal mode as it reads before the Runtime Host boot resolves its
 * own copy. Every input is available pre-ready (`app.isPackaged` included), so
 * a dialog raised during startup can consult the same answer the windows do.
 */
export function startupRevealMode(): WindowRevealMode {
  return resolveWindowRevealMode(
    isIsolatedE2e || Boolean(process.env.MAKA_E2E_FIXTURE),
    process.env.MAKA_E2E_SHOW_WINDOW === '1',
    app.isPackaged,
  );
}

/** Called after ready, before importing the asynchronous Runtime Host boot. */
export function showDesktopStartupProgress(
  copyDiagnostics: (phase: StartupPhase) => void | Promise<void>,
): void {
  const revealMode = startupRevealMode();
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
      revealMode,
      createWindow: (options) => new BrowserWindow(options),
      copyDiagnostics: (phase, handoff) => handoff
        ? clipboard.writeText(JSON.stringify(handoff, null, 2)) : copyDiagnostics(phase),
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

/** One presentation lifetime per attempt; startup reuses its already visible window. */
export function createDesktopHostHandoffSurface(resolveLocale: () => Promise<UiLocale>): OpenHostHandoffSurface {
  return (submit) => {
    let latest: HostHandoffView | undefined;
    let window: StartupProgressWindow | undefined;
    let locale: UiLocale | undefined;
    let ownWindow = false;
    let closed = false;
    void resolveLocale().then((resolved) => {
      if (closed) return;
      locale = resolved;
      if (progress?.window() && !handoffUsesStartup) {
        window = progress;
        handoffUsesStartup = true;
      } else {
        ownWindow = true;
        window = createStartupProgressWindow({
          locale, dark: nativeTheme.shouldUseDarkColors, icon: readableAppIconPath('default'),
          revealMode: startupRevealMode(),
          createWindow: (options) => new BrowserWindow(options),
          copyDiagnostics: () => clipboard.writeText(JSON.stringify(latest, null, 2)),
          onError: (error) => console.error('[runtime-host] handoff presentation failed:', error),
        });
      }
      if (latest) window.handoff(latest, submit, locale);
      window.focus();
    }).catch((error) => {
      console.error('[runtime-host] handoff presentation failed:', error);
      if (latest) submit(latest.revision, 'cancel');
    });
    return {
      update(view) {
        latest = view;
        if (window && locale) window.handoff(view, submit, locale);
      },
      close() {
        closed = true;
        if (ownWindow) window?.close();
        else if (window) {
          window.clearHandoff();
          handoffUsesStartup = false;
        }
      },
    };
  };
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
