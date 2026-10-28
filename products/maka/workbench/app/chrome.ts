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
import { effect, signal } from 'nsh';
import { platform } from 'nsh';
import { isAvailable, Menu, titleBar, Window } from 'nsh/desktop';
import { tr } from './locale';

export const ownTitleBar = isAvailable && platform.idiom === 'desktop' && !platform.isTerminal;
/** The headers' height, which the system's window controls are centered in. */
export const TITLE_BAR_HEIGHT = 48;

// The window's colors follow the system until Settings › General chooses
// (`appearance.ts`); the system's menus and controls follow them too.
if (ownTitleBar) Window.setTitleBar('hidden', TITLE_BAR_HEIGHT);

/** Titles the window (Mission Control, the Dock's and the Window menu's
 * lists) with `title`, else the app's name. */
export function windowTitle(title: () => string | null) {
  if (ownTitleBar) effect(() => Window.setTitle(title() ?? 'Maka'));
}

/** Whether the session browser and the preview are docked at the window's edges. */
export const docked = { browser: signal(false), preview: signal(false) };

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
  commands(): void;
  models(): void;
  latest(): void;
  settings(): void;
  sidebarShown(): boolean;
  toggleSidebar(): void;
  /** One text size up (1), down (-1), or the default (0). */
  textSize(step: number): void;
}

/** The application menu (the macOS menu bar; the shortcuts elsewhere). */
export function applicationMenu(actions: MenuActions) {
  if (!ownTitleBar) return;
  const mac = platform.os === 'macos';
  effect(() => {
    const settings = {
      label: `${tr('Settings')}…`,
      shortcut: 'mod+,',
      onSelect: actions.settings,
    };
    Menu.setApplicationMenu([
      mac && {
        label: 'Maka',
        submenu: [
          { role: 'about' },
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
          !mac && { type: 'separator' },
          !mac && { role: 'quit' },
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
          { label: `${tr('Search conversations')}…`, shortcut: 'mod+f', onSelect: actions.search },
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
          { type: 'separator' },
          { role: 'toggleFullScreen' },
        ],
      },
      {
        label: tr('Window'),
        submenu: [{ role: 'minimize' }, { role: 'zoom' }],
      },
    ]);
  });
}
