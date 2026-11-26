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

// The window around the workbench on a graphical desktop: the headers along
// the top edge are its title bar, and the application menu holds the
// workbench's commands. Terminals keep their own title and menus.
import { computed, effect, host, platform } from 'nsh';
import { currentWindow, isAvailable, Menu, type MenuItem, titleBar } from 'nsh/desktop';
import { appUpdater } from './appUpdater';
import { tr } from './locale';

export const ownTitleBar = isAvailable && platform.desktop && platform.idiom !== 'terminal';
/** The headers' height, which the system's window controls are centered in. */
export const TITLE_BAR_HEIGHT = 48;
/** Minimum content size matching desktop-shell's `MIN_SIZE` (narrowest layout the sidebar folds for). */
export const WINDOW_MIN_SIZE = { width: 640, height: 480 } as const;
/** How far the desktop's content panel sits from the window's top, right and bottom edges. */
export const PANEL_INSET = 8;

/** Titles the window (Mission Control, the Dock's and the Window menu's
 * lists) with `title`, else the app's name. */
export function windowTitle(title: () => string | null) {
  if (!ownTitleBar) return;
  const win = currentWindow();
  effect(() => win.set({ title: title() ?? 'Maka' }));
}

/** Room for the window controls at the left end of a header along the top edge. */
export const controlsLeft = (atLeftEdge: boolean) =>
  ownTitleBar && atLeftEdge ? titleBar().left : 0;
/** Room for the window controls at the right end (Windows and Linux). */
export const controlsRight = (atRightEdge: boolean) =>
  ownTitleBar && atRightEdge ? titleBar().right : 0;
/** A dialog's top padding, kept clear of the window controls. */
export const dialogTop = (padding: number) =>
  ownTitleBar ? Math.max(padding, TITLE_BAR_HEIGHT) : padding;
/** Makes a header move the window, as the system's title bar does. */
export const windowDrag = ownTitleBar ? { windowDrag: true } : undefined;

export interface MenuActions {
  newConversation(): void;
  chooseWorkspace(): void;
  sessions(): void;
  search(): void;
  find(): void;
  commands(): void;
  models(): void;
  latest(): void;
  nextSession(): void;
  previousSession(): void;
  settings(): void;
  openUpdates?(): void;
  checkForUpdates?(): void;
  sidebarShown(): boolean;
  toggleSidebar(): void;
  /** One text size up (1), down (-1), or the default (0). */
  textSize(step: number): void;
  /** Back to the default theme, from a menu a theme cannot make unreadable. */
  resetTheme(): void;
}

/** The application menu (the macOS menu bar; the shortcuts elsewhere). */
export function applicationMenu(actions: MenuActions) {
  if (!ownTitleBar) return;
  if (actions.checkForUpdates) appUpdater.init();
  const mac = platform.os === 'macos';
  // Memoize only the menu-relevant status so 250ms download progress ticks do not rebuild NSMenu.
  const updateMenuState = computed(
    (): 'hidden' | 'check' | 'checking' | 'downloading' | 'ready' | 'installing' => {
      if (!actions.checkForUpdates || !appUpdater.supported) return 'hidden';
      const state = appUpdater.snapshot();
      if (!state || state.channel === 'dev') return 'hidden';
      switch (state.status) {
        case 'ready':
          return 'ready';
        case 'installing':
          return 'installing';
        case 'checking':
          return 'checking';
        case 'downloading':
          return 'downloading';
        default:
          return 'check';
      }
    },
  );
  effect(() => {
    const settings = {
      label: `${tr('Settings')}…`,
      shortcut: 'mod+,',
      onSelect: actions.settings,
    };
    const quit = {
      label: tr('Quit Maka'),
      shortcut: 'mod+q',
      onSelect: () => host.post('terminal.exit'),
    };
    const updateItem = (): MenuItem | false => {
      switch (updateMenuState()) {
        case 'hidden':
          return false;
        case 'ready':
          return {
            label: tr('Restart to update…'),
            onSelect: () => void appUpdater.installAndRestart(),
          };
        case 'installing':
          return { label: tr('Installing update…'), disabled: true };
        case 'checking':
          return {
            label: tr('Checking for updates…'),
            onSelect: actions.openUpdates ?? actions.checkForUpdates,
          };
        case 'downloading':
          return {
            label: tr('Downloading update…'),
            onSelect: actions.openUpdates ?? actions.checkForUpdates,
          };
        case 'check':
          return {
            label: tr('Check for updates…'),
            onSelect: actions.checkForUpdates,
          };
      }
    };
    const update = updateItem();
    Menu.setApplicationMenu([
      mac && {
        label: 'Maka',
        submenu: [
          { role: 'about' },
          update,
          { type: 'separator' },
          settings,
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'showAll' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: tr('File'),
        submenu: [
          { label: tr('New conversation'), shortcut: 'mod+n', onSelect: actions.newConversation },
          { label: `${tr('Choose workspace')}…`, onSelect: actions.chooseWorkspace },
          { label: tr('Browse sessions'), onSelect: actions.sessions },
          { type: 'separator' },
          { role: 'close' },
          !mac && settings,
          !mac && update,
          !mac && { type: 'separator' },
          !mac && quit,
        ],
      },
      {
        label: tr('Edit'),
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          { label: `${tr('Find in conversation')}…`, shortcut: 'mod+f', onSelect: actions.find },
          { label: `${tr('Search conversations')}…`, shortcut: 'mod+o', onSelect: actions.search },
        ],
      },
      {
        label: tr('View'),
        submenu: [
          { label: tr('Commands'), shortcut: 'mod+p', onSelect: actions.commands },
          { label: tr('Models'), shortcut: 'mod+g', onSelect: actions.models },
          { label: tr('Jump to latest'), shortcut: 'mod+l', onSelect: actions.latest },
          { type: 'separator' },
          {
            label: actions.sidebarShown()
              ? tr('Collapse session browser')
              : tr('Expand session browser'),
            // macOS's Show Sidebar key (Finder, Mail, Notes).
            shortcut: mac ? 'ctrl+cmd+s' : undefined,
            onSelect: actions.toggleSidebar,
          },
          { type: 'separator' },
          { label: tr('Larger text'), shortcut: 'mod+plus', onSelect: () => actions.textSize(1) },
          {
            label: tr('Smaller text'),
            shortcut: 'mod+minus',
            onSelect: () => actions.textSize(-1),
          },
          {
            label: tr('Default text size'),
            shortcut: 'mod+0',
            onSelect: () => actions.textSize(0),
          },
          { label: tr('Reset theme'), shortcut: 'mod+shift+0', onSelect: actions.resetTheme },
          { type: 'separator' },
          { role: 'toggleFullScreen' },
        ],
      },
      {
        label: tr('Window'),
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          {
            label: tr('Previous conversation'),
            shortcut: 'mod+shift+[',
            onSelect: actions.previousSession,
          },
          {
            label: tr('Next conversation'),
            shortcut: 'mod+shift+]',
            onSelect: actions.nextSession,
          },
        ],
      },
    ]);
  });
}
