import { createRequire } from 'node:module';
import type { Menu as ElectronMenu, MenuItemConstructorOptions } from 'electron';

// Electron is CommonJS, and named imports from it fail outside a main process.
// Deferring the require keeps this module loadable under plain `node --test`,
// where every Electron touchpoint is injected instead (status-item.ts pattern).
const electron = (): typeof import('electron') =>
  createRequire(import.meta.url)('electron') as typeof import('electron');

/**
 * Commands the native menu routes to the renderer. The renderer owns the
 * implementations (`createSession` / `openSettings` / keyboard help in
 * app-shell-effects.ts); the menu is only the macOS entry surface for them —
 * one typed channel (`window:command`), one dispatch.
 */
export type ApplicationMenuCommand = 'newTask' | 'openSettings' | 'openHelp';

export interface ApplicationMenuLabels {
  newTask: string;
  openSettings: string;
  openHelp: string;
}

export interface ApplicationMenuDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  dispatch: (command: ApplicationMenuCommand) => void;
  /** English by default: Electron renders role menus (Edit, Window, …) in
   * English too, so localizing only the custom items would split the menu
   * bar's language mid-column. */
  labels?: ApplicationMenuLabels;
}

const DEFAULT_LABELS: ApplicationMenuLabels = {
  newTask: 'New Task',
  openSettings: 'Settings…',
  openHelp: 'Keyboard Shortcuts',
};

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
 */
export function buildApplicationMenuTemplate(
  deps: ApplicationMenuDeps,
): MenuItemConstructorOptions[] | null {
  const { platform, isPackaged, dispatch } = deps;
  if (platform !== 'darwin') return null;
  const labels = deps.labels ?? DEFAULT_LABELS;
  return [
    {
      label: 'Maka',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: labels.openSettings, accelerator: 'Command+,', click: () => dispatch('openSettings') },
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
        { label: labels.newTask, accelerator: 'CmdOrCtrl+N', click: () => dispatch('newTask') },
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
      submenu: [{ label: labels.openHelp, click: () => dispatch('openHelp') }],
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
