import { ipcMain } from 'electron';
import { createBrowserViewHost } from './browser/automation-host.js';
import { provideBrowserViewHost } from './browser/browser-host.js';
import { releaseBrowserSession, revokeHiddenBrowserActions } from './browser/session.js';
import type { BrowserViewRect } from './browser/logic.js';
import type { createMainWindowController } from './main-window.js';
import {
  desktopSessionResourceKey,
  requireDesktopHostRef,
} from '../preload/runtime-host-identity.js';

interface BrowserIpcDeps {
  mainWindowController: ReturnType<typeof createMainWindowController>;
  getActiveHostId(): string | undefined;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): void {
  let shownBrowserSessionId: string | null = null;
  provideBrowserViewHost(createBrowserViewHost(deps.mainWindowController.getBrowserViews(), () => shownBrowserSessionId));

  const requireBrowserTarget = (scope: unknown, target: unknown): string | undefined => {
    const hostId = deps.getActiveHostId();
    if (!hostId) throw new Error('Desktop Runtime Host identity is unavailable');
    const host = requireDesktopHostRef(scope, hostId);
    return typeof target === 'string' && target.length > 0
      ? desktopSessionResourceKey({ hostId: host.hostId, sessionId: target })
      : undefined;
  };

  ipcMain.on('browser:active-session', (_event, scope: unknown, sessionId: unknown) => {
    try {
      shownBrowserSessionId = requireBrowserTarget(scope, sessionId) ?? null;
    } catch {
      return;
    }
    deps.mainWindowController.getBrowserViews().hideAllExcept(shownBrowserSessionId);
    revokeHiddenBrowserActions(shownBrowserSessionId);
  });

  ipcMain.on('browser:setViewport', (_event, scope: unknown, input: { sessionId?: unknown; rect?: BrowserViewRect | null }) => {
    let target: string | undefined;
    try {
      target = requireBrowserTarget(scope, input?.sessionId);
    } catch {
      return;
    }
    if (!target || target !== shownBrowserSessionId) return;
    deps.mainWindowController.getBrowserViews().setViewport(target, input.rect ?? null);
  });

  ipcMain.handle('browser:navigate', async (_event, scope: unknown, target: unknown, url: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    if (!resourceKey || resourceKey !== shownBrowserSessionId) return;
    await deps.mainWindowController.getBrowserViews().getOrCreate(resourceKey).navigate(String(url ?? ''));
  });
  ipcMain.handle('browser:back', (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    if (resourceKey === shownBrowserSessionId) deps.mainWindowController.getBrowserViews().get(resourceKey)?.goBack();
  });
  ipcMain.handle('browser:forward', (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    if (resourceKey === shownBrowserSessionId) deps.mainWindowController.getBrowserViews().get(resourceKey)?.goForward();
  });
  ipcMain.handle('browser:reload', (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    if (resourceKey === shownBrowserSessionId) deps.mainWindowController.getBrowserViews().get(resourceKey)?.reload();
  });
  ipcMain.handle('browser:stop', (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    if (resourceKey === shownBrowserSessionId) deps.mainWindowController.getBrowserViews().get(resourceKey)?.stop();
  });
  ipcMain.handle('browser:get-state', (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    return resourceKey
      ? deps.mainWindowController.getBrowserViews().get(resourceKey)?.state() ?? null
      : null;
  });
  ipcMain.handle('browser:close-page', async (_event, scope: unknown, target: unknown) => {
    const resourceKey = requireBrowserTarget(scope, target);
    if (resourceKey === shownBrowserSessionId) await releaseBrowserSession(resourceKey);
  });
}
