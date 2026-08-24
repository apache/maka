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

import { ipcMain } from 'electron';
import { createBrowserViewHost } from './browser/automation-host.js';
import { provideBrowserViewHost } from './browser/browser-host.js';
import { releaseBrowserSession, revokeHiddenBrowserActions } from './browser/session.js';
import type { BrowserViewRect } from './browser/logic.js';
import type { createMainWindowController } from './main-window.js';
import {
  desktopSessionResourceKey,
  parseDesktopSessionResourceKey,
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from '../shared/runtime-host-identity.js';

interface BrowserIpcDeps {
  mainWindowController: ReturnType<typeof createMainWindowController>;
  isHostActive(scope: DesktopTargetScope): boolean;
}

export interface BrowserIpcController {
  retireTarget(scope: DesktopTargetScope): Promise<void>;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): BrowserIpcController {
  let shownBrowserSessionId: string | null = null;
  let selectionDocumentId: string | undefined;
  let selectionGeneration = 0;
  provideBrowserViewHost(createBrowserViewHost(deps.mainWindowController.getBrowserViews(), () => shownBrowserSessionId));

  const hideActiveSession = (): void => {
    shownBrowserSessionId = null;
    deps.mainWindowController.getBrowserViews().hideAllExcept(null);
    revokeHiddenBrowserActions(null);
  };

  const requireBrowserTarget = (scope: unknown, target: unknown): string | undefined => {
    const host = requireDesktopTargetScope(scope);
    if (!deps.isHostActive(host)) throw new Error('Desktop Runtime Host identity is unavailable');
    return typeof target === 'string' && target.length > 0
      ? desktopSessionResourceKey({ ...host, sessionId: target })
      : undefined;
  };

  const rendererFrame = (event: Electron.IpcMainEvent): string | undefined => {
    const frame = event.senderFrame;
    return frame?.frameToken === event.sender.mainFrame.frameToken
      ? frame.frameToken
      : undefined;
  };

  const advanceSelection = (documentId: unknown, generation: unknown): boolean => {
    if (
      typeof documentId !== 'string' || documentId.length === 0 ||
      typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0
    ) {
      return false;
    }
    if (documentId !== selectionDocumentId) {
      selectionDocumentId = documentId;
      selectionGeneration = 0;
      hideActiveSession();
    }
    if (generation <= selectionGeneration) return false;
    selectionGeneration = generation;
    return true;
  };

  const isCurrentSelection = (documentId: unknown, generation: unknown): boolean =>
    documentId === selectionDocumentId && generation === selectionGeneration;

  ipcMain.on('browser:document-ready', (event, documentId: unknown) => {
    if (!rendererFrame(event) || typeof documentId !== 'string' || documentId.length === 0) return;
    if (documentId === selectionDocumentId) return;
    selectionDocumentId = documentId;
    selectionGeneration = 0;
    hideActiveSession();
  });

  ipcMain.on('browser:active-session', (event, scope: unknown, sessionId: unknown, documentId: unknown, generation: unknown) => {
    const frame = rendererFrame(event);
    if (!frame || !advanceSelection(documentId, generation)) return;
    try {
      shownBrowserSessionId = requireBrowserTarget(scope, sessionId) ?? null;
    } catch {
      hideActiveSession();
      return;
    }
    deps.mainWindowController.getBrowserViews().hideAllExcept(shownBrowserSessionId);
    revokeHiddenBrowserActions(shownBrowserSessionId);
  });
  ipcMain.on('browser:hide-active-session', (event, documentId: unknown, generation: unknown) => {
    const frame = rendererFrame(event);
    if (frame && advanceSelection(documentId, generation)) hideActiveSession();
  });

  ipcMain.on('browser:setViewport', (event, scope: unknown, input: { sessionId?: unknown; rect?: BrowserViewRect | null }, documentId: unknown, generation: unknown) => {
    const frame = rendererFrame(event);
    if (!frame || !isCurrentSelection(documentId, generation)) return;
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
      const views = deps.mainWindowController.getBrowserViews();
      if (shownBrowserSessionId && belongsToTarget(shownBrowserSessionId, scope)) {
        hideActiveSession();
      }
      const retired = views.sessionIds().filter((sessionId) => {
        return belongsToTarget(sessionId, scope);
      });
      await Promise.all(retired.map((sessionId) => releaseBrowserSession(sessionId)));
    },
  };
}

function belongsToTarget(sessionId: string, scope: DesktopTargetScope): boolean {
  const ref = parseDesktopSessionResourceKey(sessionId);
  return ref.hostId === scope.hostId && ref.targetEpoch === scope.targetEpoch;
}
