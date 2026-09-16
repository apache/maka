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

import { BrowserWindow, ipcMain } from 'electron';
import { isWorkHubCoordinationSessionId } from '@maka/core/session';
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
  refreshVisibility(): void;
  retireTarget(scope: DesktopTargetScope): Promise<void>;
}

export function registerBrowserIpc(deps: BrowserIpcDeps): BrowserIpcController {
  interface RendererSelection {
    documentId?: string;
    generation: number;
    sessionId: string | null;
  }

  const selections = new Map<Electron.WebContents, RendererSelection>();
  const observedRenderers = new WeakSet<Electron.WebContents>();
  const views = deps.mainWindowController.getBrowserViews();

  const isCoordination = (sessionId: string): boolean =>
    isWorkHubCoordinationSessionId(parseDesktopSessionResourceKey(sessionId).sessionId);

  // Coordination has one persistent conversation owner and may also be
  // presented by Main. Only its native page moves; automation keeps its owner.
  const ownerForSession = (sessionId: string): Electron.WebContents | undefined => {
    let owner: Electron.WebContents | undefined;
    for (const [contents, selection] of selections) {
      if (selection.sessionId !== sessionId || !deps.mainWindowController.ownsRenderer(contents)) continue;
      if (!deps.mainWindowController.isMainRenderer(contents)) return contents;
      owner = contents;
    }
    return owner;
  };

  const isSessionShown = (sessionId: string): boolean => {
    const owner = ownerForSession(sessionId);
    if (!owner) return false;
    const parent = deps.mainWindowController.browserParentForRenderer(owner);
    const window = BrowserWindow.fromWebContents(owner);
    return !!parent?.getVisible() && !!window && !window.isDestroyed() &&
      window.isVisible() && !window.isMinimized();
  };
  const canRunInBackground = (sessionId: string): boolean => {
    const owner = ownerForSession(sessionId);
    if (!owner || !deps.mainWindowController.browserParentForRenderer(owner)) return false;
    const ref = parseDesktopSessionResourceKey(sessionId);
    return isWorkHubCoordinationSessionId(ref.sessionId) && deps.isHostActive(ref);
  };
  const revokeHiddenActions = (): void => {
    for (const sessionId of views.sessionIds()) views.get(sessionId)?.refreshRendering();
    revokeHiddenBrowserActions((sessionId) => isSessionShown(sessionId) || canRunInBackground(sessionId));
  };

  const relinquishSession = (contents: Electron.WebContents): void => {
    const selection = selections.get(contents);
    const sessionId = selection?.sessionId;
    if (!selection || !sessionId) return;
    const view = views.get(sessionId);
    const parent = deps.mainWindowController.browserParentForRenderer(contents);
    selection.sessionId = null;
    if (view && parent && view.hasParent(parent)) {
      view.park();
    }
  };

  const clearRendererSelection = (contents: Electron.WebContents): void => {
    relinquishSession(contents);
    selections.delete(contents);
    revokeHiddenActions();
  };

  const observeRenderer = (contents: Electron.WebContents): void => {
    if (observedRenderers.has(contents)) return;
    observedRenderers.add(contents);
    const parent = deps.mainWindowController.browserParentForRenderer(contents);
    const window = BrowserWindow.fromWebContents(contents);
    const parkPresentedPages = () => {
      if (!parent) return;
      for (const sessionId of views.sessionIds()) {
        const view = views.get(sessionId);
        if (view?.hasParent(parent) && !view.hasOwner(parent)) view.park();
      }
    };
    window?.on('close', parkPresentedPages);
    window?.on('hide', revokeHiddenActions);
    window?.on('minimize', revokeHiddenActions);
    window?.on('show', revokeHiddenActions);
    window?.on('restore', revokeHiddenActions);
    contents.on('render-process-gone', () => clearRendererSelection(contents));
    contents.once('destroyed', () => {
      window?.removeListener('close', parkPresentedPages);
      window?.removeListener('hide', revokeHiddenActions);
      window?.removeListener('minimize', revokeHiddenActions);
      window?.removeListener('show', revokeHiddenActions);
      window?.removeListener('restore', revokeHiddenActions);
      const owned = views.sessionIds().filter((sessionId) =>
        parent && views.get(sessionId)?.hasOwner(parent),
      );
      clearRendererSelection(contents);
      void Promise.all(owned.map((sessionId) => releaseBrowserSession(sessionId)));
    });
  };

  const ownedRenderer = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ): Electron.WebContents | undefined => {
    const frame = event.senderFrame;
    if (
      !frame || frame.frameToken !== event.sender.mainFrame.frameToken ||
      !deps.mainWindowController.ownsRenderer(event.sender)
    ) return undefined;
    observeRenderer(event.sender);
    return event.sender;
  };

  deps.mainWindowController.setBrowserViewParentResolver((sessionId) => {
    const owner = ownerForSession(sessionId);
    return owner
      ? deps.mainWindowController.browserParentForRenderer(owner)
      : undefined;
  });
  provideBrowserViewHost(createBrowserViewHost(views, isSessionShown, canRunInBackground));

  const requireBrowserTarget = (scope: unknown, target: unknown): string | undefined => {
    const host = requireDesktopTargetScope(scope);
    if (!deps.isHostActive(host)) throw new Error('Desktop Runtime Host identity is unavailable');
    return typeof target === 'string' && target.length > 0
      ? desktopSessionResourceKey({ ...host, sessionId: target })
      : undefined;
  };

  const advanceSelection = (
    contents: Electron.WebContents,
    documentId: unknown,
    generation: unknown,
  ): RendererSelection | undefined => {
    if (
      typeof documentId !== 'string' || documentId.length === 0 ||
      typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0
    ) {
      return undefined;
    }
    const selection = selections.get(contents);
    // Only document-ready may rotate this identity. A delayed async resolution
    // from the previous document must not reclaim the renderer after reload.
    if (!selection || documentId !== selection.documentId) return undefined;
    if (generation <= selection.generation) return undefined;
    selection.generation = generation;
    return selection;
  };

  const isCurrentSelection = (
    contents: Electron.WebContents,
    documentId: unknown,
    generation: unknown,
  ): boolean => {
    const selection = selections.get(contents);
    return !!selection && documentId === selection.documentId && generation === selection.generation;
  };

  const claimSession = (
    contents: Electron.WebContents,
    selection: RendererSelection,
    sessionId: string | null,
  ): void => {
    const previousOwner = sessionId ? ownerForSession(sessionId) : undefined;
    if (previousOwner && previousOwner !== contents && (!isCoordination(sessionId!) ||
      deps.mainWindowController.isMainRenderer(previousOwner) === deps.mainWindowController.isMainRenderer(contents))) return;
    if (selection.sessionId && selection.sessionId !== sessionId) relinquishSession(contents);
    if (!sessionId) {
      selection.sessionId = null;
      revokeHiddenActions();
      return;
    }
    selection.sessionId = sessionId;
    if (isCoordination(sessionId) && !deps.mainWindowController.isMainRenderer(contents)) {
      const parent = deps.mainWindowController.browserParentForRenderer(contents);
      if (parent) views.get(sessionId)?.setOwner(parent);
    }
    revokeHiddenActions();
  };

  const selectedTarget = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
    scope: unknown,
    target: unknown,
  ): string | undefined => {
    const contents = ownedRenderer(event);
    if (!contents) return undefined;
    const sessionId = requireBrowserTarget(scope, target);
    return sessionId && deps.mainWindowController.browserParentForRenderer(contents) &&
      selections.get(contents)?.sessionId === sessionId
      ? sessionId
      : undefined;
  };

  ipcMain.on('browser:document-ready', (event, documentId: unknown) => {
    const contents = ownedRenderer(event);
    if (!contents || typeof documentId !== 'string' || documentId.length === 0) return;
    const selection = selections.get(contents);
    if (documentId === selection?.documentId) return;
    relinquishSession(contents);
    selections.set(contents, { documentId, generation: 0, sessionId: null });
    revokeHiddenActions();
  });

  ipcMain.on('browser:active-session', (event, scope: unknown, sessionId: unknown, documentId: unknown, generation: unknown) => {
    const contents = ownedRenderer(event);
    if (!contents) return;
    const selection = advanceSelection(contents, documentId, generation);
    if (!selection) return;
    try {
      claimSession(contents, selection, requireBrowserTarget(scope, sessionId) ?? null);
    } catch {
      claimSession(contents, selection, null);
    }
  });
  ipcMain.on('browser:hide-active-session', (event, documentId: unknown, generation: unknown) => {
    const contents = ownedRenderer(event);
    if (!contents) return;
    const selection = advanceSelection(contents, documentId, generation);
    if (selection) claimSession(contents, selection, null);
  });

  ipcMain.on('browser:setViewport', (event, scope: unknown, input: { sessionId?: unknown; rect?: BrowserViewRect | null }, documentId: unknown, generation: unknown) => {
    const contents = ownedRenderer(event);
    if (!contents || !isCurrentSelection(contents, documentId, generation)) return;
    let target: ReturnType<typeof selectedTarget>;
    try {
      target = selectedTarget(event, scope, input?.sessionId);
    } catch {
      return;
    }
    if (!target) return;
    const view = views.get(target);
    const parent = deps.mainWindowController.browserParentForRenderer(contents);
    if (!view || !parent) return;
    if (input.rect) {
      view.setParent(parent);
      view.setViewport(input.rect);
    } else if (view.hasParent(parent)) {
      view.park();
    }
  });

  ipcMain.handle('browser:capture-page', (event, scope: unknown, target: unknown) => {
    const selected = selectedTarget(event, scope, target);
    const parent = deps.mainWindowController.browserParentForRenderer(event.sender);
    const view = selected ? views.get(selected) : undefined;
    return parent && view?.hasParent(parent) ? view.capturePage() : undefined;
  });

  ipcMain.handle('browser:navigate', async (event, scope: unknown, target: unknown, url: unknown) => {
    const selected = selectedTarget(event, scope, target);
    if (!selected) return;
    await views.getOrCreate(selected).navigate(String(url ?? ''));
  });
  ipcMain.handle('browser:back', (event, scope: unknown, target: unknown) => {
    const selected = selectedTarget(event, scope, target);
    if (selected) views.get(selected)?.goBack();
  });
  ipcMain.handle('browser:forward', (event, scope: unknown, target: unknown) => {
    const selected = selectedTarget(event, scope, target);
    if (selected) views.get(selected)?.goForward();
  });
  ipcMain.handle('browser:reload', (event, scope: unknown, target: unknown) => {
    const selected = selectedTarget(event, scope, target);
    if (selected) views.get(selected)?.reload();
  });
  ipcMain.handle('browser:stop', (event, scope: unknown, target: unknown) => {
    const selected = selectedTarget(event, scope, target);
    if (selected) views.get(selected)?.stop();
  });
  ipcMain.handle('browser:get-state', (event, scope: unknown, target: unknown) => {
    if (!ownedRenderer(event)) return null;
    // A remounted panel reads its page before the workspace selects the session.
    const sessionId = requireBrowserTarget(scope, target);
    return sessionId ? views.get(sessionId)?.state() ?? null : null;
  });
  ipcMain.handle('browser:close-page', async (event, scope: unknown, target: unknown) => {
    const selected = selectedTarget(event, scope, target);
    if (selected) await releaseBrowserSession(selected);
  });

  return {
    refreshVisibility: revokeHiddenActions,
    async retireTarget(scope) {
      for (const selection of selections.values()) {
        const sessionId = selection.sessionId;
        if (!sessionId || !belongsToTarget(sessionId, scope)) continue;
        selection.sessionId = null;
        views.get(sessionId)?.setViewport(null);
      }
      revokeHiddenActions();
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
