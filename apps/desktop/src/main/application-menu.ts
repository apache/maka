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

import { createRequire } from 'node:module';
import type { Menu as ElectronMenu, MenuItemConstructorOptions } from 'electron';
import type { WindowCommand } from '../preload/bridge-contract.js';

// Electron is CommonJS, and named imports from it fail outside a main process.
// Deferring the require keeps this module loadable under plain `node --test`,
// where every Electron touchpoint is injected instead (status-item.ts pattern).
const electron = (): typeof import('electron') =>
  createRequire(import.meta.url)('electron') as typeof import('electron');

/**
 * Commands the native menu routes to the renderer. The renderer owns the
 * implementations (`createSession` / `openSettings` / keyboard help in
 * app-shell-effects.ts); the menu is only the macOS entry surface for them.
 * Derived from the preload contract so the two sides of the `window:command`
 * channel cannot drift apart.
 */
export type ApplicationMenuCommand = WindowCommand['id'];

export interface ApplicationMenuDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  dispatch: (command: ApplicationMenuCommand) => void;
}

const MENU_LABELS = {
  newTask: 'New Task',
  openSettings: 'Settings…',
  openHelp: 'Keyboard Shortcuts',
} as const;

/**
 * Platform-appropriate application menu, or `null` when the platform must
 * keep the menu suppressed. Windows/Linux keep `setApplicationMenu(null)`:
 * the renderer owns its shell chrome and the `Ctrl+N` / `Ctrl+,` shortcuts
 * (`app-shell-effects.ts`), and a visible Electron menu bar would sit above
 * the custom titlebar.
 *
 * macOS details:
 * - The App submenu is spelled out instead of `role: 'appMenu'` so Settings
 *   (`Cmd+,`) can sit between About and Services — where macOS users expect
 *   it — with the standard roles around it. `role: 'quit'` exits through the
 *   same before-quit cleanup path as any other quit request.
 * - New Task (`Cmd+N`) lives in File next to `role: 'close'`.
 * - `role: 'editMenu'` keeps the native editing roles and macOS's
 *   auto-appended Dictation and Emoji & Symbols entries, so the menu must not
 *   relabel it.
 * - View spells out zoom/fullscreen and adds Reload/DevTools only in
 *   development.
 * - A menu accelerator is the single active owner of `Cmd+N` / `Cmd+,` on
 *   macOS: AppKit resolves menu key equivalents before the web contents sees
 *   the keydown, so the renderer's `useHotkeys` entry never also fires.
 *
 * Labels are English on purpose: Electron renders role menus (Edit, Window,
 * …) in English too, so localizing only the custom items would split the menu
 * bar's language mid-column.
 */
export function buildApplicationMenuTemplate(
  deps: ApplicationMenuDeps,
): MenuItemConstructorOptions[] | null {
  const { platform, isPackaged, dispatch } = deps;
  if (platform !== 'darwin') return null;
  return [
    {
      label: 'Maka',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: MENU_LABELS.openSettings, accelerator: 'Command+,', click: () => dispatch('openSettings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: MENU_LABELS.newTask, accelerator: 'CmdOrCtrl+N', click: () => dispatch('newTask') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(isPackaged
          ? []
          : ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
            ] as MenuItemConstructorOptions[])),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: MENU_LABELS.openHelp, click: () => dispatch('openHelp') }],
    },
  ];
}

export function installApplicationMenu(deps: ApplicationMenuDeps): void {
  const template = buildApplicationMenuTemplate(deps);
  if (!template) {
    electron().Menu.setApplicationMenu(null);
    return;
  }
  const menu: ElectronMenu = electron().Menu.buildFromTemplate(template);
  electron().Menu.setApplicationMenu(menu);
}
