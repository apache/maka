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

import { app, nativeImage } from 'electron';
import { join } from 'node:path';
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
      try {
        const iconPath = join(
          import.meta.dirname,
          '..',
          '..',
          'assets',
          'icon.png',
        );
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
      } catch (error) {
        deps.onIconError(error);
      }
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
