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
