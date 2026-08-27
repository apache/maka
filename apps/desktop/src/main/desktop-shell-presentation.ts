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
import { app, nativeTheme } from 'electron';
import { startupAppIcon } from '@maka/core/settings';
import { applyAppIcon } from './app-icon-surface.js';
import { installApplicationMenu } from './application-menu.js';
import { resolveDockPresentation } from './dock-presentation.js';
import type { createMainWindowController } from './main-window.js';

interface DesktopShellPresentationDeps {
  readonly startHidden: boolean;
  readonly mainWindowController: ReturnType<typeof createMainWindowController>;
  readonly focusOrCreateWindow: () => void;
  readonly onIconError: (error: unknown) => void;
}

/** Install the process-scoped Desktop presentation shared by both Runtime owners. */
export function installDesktopShellPresentation(
  deps: DesktopShellPresentationDeps,
): void {
  const dockPresentation = resolveDockPresentation(
    process.platform,
    deps.startHidden,
  );
  if (app.dock) {
    if (dockPresentation === 'hide') {
      app.dock.hide();
    } else if (dockPresentation === 'icon') {
      // A DEFAULT, synchronously, even when the user picked another one:
      // reading the persisted choice means awaiting the settings store, and a
      // dock that shows the generic Electron rocket until that resolves is the
      // exact regression PR-GRAY-CARD-LIFT-0 fixed. The persisted choice lands
      // a tick later, from the same client-settings effect that applies it
      // when the user switches (see client-settings-effects.ts).
      //
      // Which default depends on the appearance, and only the OS half of that
      // is readable synchronously — the stored `theme` preference is not. So a
      // user whose in-app theme disagrees with the OS still sees one swap, the
      // same as before; what this avoids is every default install swapping.
      applyAppIcon(startupAppIcon(nativeTheme.shouldUseDarkColors), deps.onIconError);
    }
  }

  installApplicationMenu({
    platform: process.platform,
    isPackaged: app.isPackaged,
    dispatch: (command) => {
      if (deps.mainWindowController.hasOpenWindows()) {
        deps.mainWindowController.send('window:command', { id: command });
      } else {
        deps.focusOrCreateWindow();
      }
    },
  });
}
