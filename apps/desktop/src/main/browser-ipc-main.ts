import { ipcMain } from 'electron';
import { createBrowserViewHost } from './browser/automation-host.js';
import { provideBrowserViewHost } from './browser/browser-host.js';
import { releaseBrowserSession, revokeHiddenBrowserActions } from './browser/session.js';
import type { BrowserViewRect } from './browser/logic.js';
import type { createMainWindowController } from './main-window.js';
import {
  desktopSessionResourceKey,
  parseDesktopSessionResourceKey,
  requireDesktopHostRef,
  type DesktopHostRef,
} from '../preload/runtime-host-identity.js';

interface BrowserIpcDeps {
  mainWindowController: ReturnType<typeof createMainWindowController>;
  getActiveHostRef(): DesktopHostRef | undefined;
}

export interface BrowserIpcController {
  retireTarget(scope: DesktopHostRef): Promise<void>;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): BrowserIpcController {
  let shownBrowserSessionId: string | null = null;
  provideBrowserViewHost(createBrowserViewHost(deps.mainWindowController.getBrowserViews(), () => shownBrowserSessionId));

  const requireBrowserTarget = (scope: unknown, target: unknown): string | undefined => {
    const activeHost = deps.getActiveHostRef();
    if (!activeHost) throw new Error('Desktop Runtime Host identity is unavailable');
    const host = requireDesktopHostRef(scope, activeHost);
    return typeof target === 'string' && target.length > 0
      ? desktopSessionResourceKey({ ...host, sessionId: target })
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

  return {
    async retireTarget(scope) {
      shownBrowserSessionId = null;
      const views = deps.mainWindowController.getBrowserViews();
      views.hideAllExcept(null);
      revokeHiddenBrowserActions(null);
      const retired = views.sessionIds().filter((sessionId) => {
        const ref = parseDesktopSessionResourceKey(sessionId);
        return ref.hostId === scope.hostId && ref.targetEpoch === scope.targetEpoch;
      });
      await Promise.all(retired.map((sessionId) => releaseBrowserSession(sessionId)));
    },
  };
}
