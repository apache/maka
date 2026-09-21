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

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { desktopSessionResourceKey, type DesktopTargetScope } from '../../shared/runtime-host-identity.js';
import type { BrowserViewRect } from '../browser/logic.js';
import { browserViewHost, provideBrowserViewHost } from '../browser/browser-host.js';
import { BrowserActionRevokedError, setBridgeFactoryForTest, withBrowserPage } from '../browser/session.js';

type IpcListener = (event: Electron.IpcMainEvent, ...args: unknown[]) => void;
type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;

class FakeController {
  readonly viewports: Array<BrowserViewRect | null> = [];
  readonly navigations: string[] = [];
  disposed = false;

  private owner: Electron.View;
  constructor(public parent: Electron.View, private readonly url: string) { this.owner = parent; }
  hasOwner(parent: Electron.View): boolean { return this.owner === parent; }
  setOwner(parent: Electron.View): void { this.owner = parent; }
  park(): void { this.setViewport(null); this.setParent(this.owner); }

  hasParent(parent: Electron.View): boolean { return this.parent === parent; }
  setParent(parent: Electron.View): void { this.parent = parent; }
  refreshRendering(): void {}
  beginBackgroundAction() { return { ready: Promise.resolve(), release: async () => {} }; }
  setViewport(rect: BrowserViewRect | null): void { this.viewports.push(rect); }
  navigate(url: string): Promise<void> { this.navigations.push(url); return Promise.resolve(); }
  capturePage(): Promise<string> { return Promise.resolve('data:image/png;base64,page'); }
  goBack(): void {}
  goForward(): void {}
  reload(): void {}
  stop(): void {}
  state(): { hasPage: boolean; url: string } { return { hasPage: true, url: this.url }; }
  hasLiveViewport(): boolean { return this.viewports.at(-1) !== null; }
  waitForLiveViewport(): Promise<boolean> { return Promise.resolve(this.hasLiveViewport()); }
  openOriginLease(): never { throw new Error('unused'); }
  attachAutomation(): Promise<{ cdpEndpoint: string }> { return Promise.resolve({ cdpEndpoint: 'ws://test' }); }
  detachAutomation(): Promise<void> { return Promise.resolve(); }
  dispose(): Promise<void> { this.disposed = true; return Promise.resolve(); }
}

class FakeRenderer extends EventEmitter {
  destroyed = false;
  readonly mainFrame: { frameToken: string };

  constructor(token: string, public zoomFactor = 1) {
    super();
    this.mainFrame = { frameToken: token };
  }

  getZoomFactor(): number { return this.zoomFactor; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

test('browser IPC isolates owned renderer documents and their native parents', async () => {
  const listeners = new Map<string, IpcListener>();
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    on(channel: string, listener: IpcListener) { listeners.set(channel, listener); return this; },
    handle(channel: string, handler: IpcHandler) { handlers.set(channel, handler); },
  };
  class FakeWindow extends EventEmitter {
    visible = true;
    minimized = false;
    isVisible(): boolean { return this.visible; }
    isMinimized(): boolean { return this.minimized; }
    isDestroyed(): boolean { return false; }
  }
  const windows = new Map<unknown, FakeWindow>();
  const BrowserWindow = { fromWebContents: (contents: unknown) => windows.get(contents) ?? null };
  const testGlobal = globalThis as typeof globalThis & {
    __makaBrowserIpcMain?: typeof ipcMain;
    __makaBrowserWindow?: typeof BrowserWindow;
  };
  testGlobal.__makaBrowserIpcMain = ipcMain;
  testGlobal.__makaBrowserWindow = BrowserWindow;
  const electronUrl = `data:text/javascript,export const ipcMain=globalThis.__makaBrowserIpcMain;export const BrowserWindow=globalThis.__makaBrowserWindow`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'electron'
        ? { url: electronUrl, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });

  try {
    const { registerBrowserIpc } = await import('../browser-ipc-main.js');
    const main = new FakeRenderer('main-document-frame', 1.1);
    const workHub = new FakeRenderer('workhub-document-frame', 1.25);
    const mainWindow = new FakeWindow();
    const floatingWindow = new FakeWindow();
    windows.set(main, mainWindow);
    windows.set(workHub, mainWindow);
    let workHubVisible = true;
    const mainParent = { getVisible: () => true } as unknown as Electron.View;
    const workHubParent = { getVisible: () => workHubVisible } as unknown as Electron.View;
    const owned = new Map<Electron.WebContents, Electron.View>([
      [main as unknown as Electron.WebContents, mainParent],
      [workHub as unknown as Electron.WebContents, workHubParent],
    ]);
    let hostActive = true;
    const scope: DesktopTargetScope = { hostId: 'host', targetEpoch: 'epoch' };
    const mainKey = desktopSessionResourceKey({ ...scope, sessionId: 'main-session' });
    const workHubKey = desktopSessionResourceKey({ ...scope, sessionId: 'workhub-session' });
    let parentResolver: ((sessionId: string) => Electron.View | undefined) | undefined;
    const controllers = new Map<string, FakeController>([
      [mainKey, new FakeController(mainParent, 'https://preserved.example/')],
    ]);
    const manager = {
      get(sessionId: string) { return controllers.get(sessionId); },
      getOrCreate(sessionId: string) {
        let controller = controllers.get(sessionId);
        if (!controller) {
          const parent = parentResolver?.(sessionId);
          assert.ok(parent, 'lazy browser creation resolves the selected renderer parent');
          controller = new FakeController(parent, '');
          controllers.set(sessionId, controller);
        }
        return controller;
      },
      sessionIds() { return [...controllers.keys()]; },
      async dispose(sessionId: string) {
        const controller = controllers.get(sessionId);
        controllers.delete(sessionId);
        await controller?.dispose();
      },
    };
    const mainWindowController = {
      getBrowserViews: () => manager,
      isMainRenderer: (contents: Electron.WebContents) => contents === main as unknown as Electron.WebContents,
      ownsRenderer: (contents: Electron.WebContents) => !contents.isDestroyed() && owned.has(contents),
      browserParentForRenderer: (contents: Electron.WebContents) => owned.get(contents),
      setBrowserViewParentResolver: (resolve: typeof parentResolver) => { parentResolver = resolve; },
    };
    const browserIpc = registerBrowserIpc({
      mainWindowController: mainWindowController as never,
      isHostActive: (candidate) => hostActive && candidate.hostId === scope.hostId && candidate.targetEpoch === scope.targetEpoch,
    });

    const event = (renderer: FakeRenderer) => ({
      sender: renderer,
      senderFrame: renderer.mainFrame,
    }) as unknown as Electron.IpcMainEvent & Electron.IpcMainInvokeEvent;
    const emit = (channel: string, renderer: FakeRenderer, ...args: unknown[]) => {
      const listener = listeners.get(channel);
      assert.ok(listener, `missing ${channel} listener`);
      listener(event(renderer), ...args);
    };
    const invoke = async (channel: string, renderer: FakeRenderer, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing ${channel} handler`);
      return handler(event(renderer), ...args);
    };

    // State restoration is read-only and must work before the remounted parent
    // Workbar effect has announced its active selection.
    assert.deepEqual(await invoke('browser:get-state', main, scope, 'main-session'), {
      hasPage: true,
      url: 'https://preserved.example/',
    });

    emit('browser:document-ready', main, 'main-document');
    emit('browser:document-ready', workHub, 'workhub-document');
    emit('browser:active-session', main, scope, 'main-session', 'main-document', 1);
    emit('browser:active-session', workHub, scope, 'workhub-session', 'workhub-document', 1);

    const mainRect = { x: 10, y: 20, width: 300, height: 200 };
    const mainDipRect = { x: 11, y: 22, width: 330, height: 220 };
    const workHubRect = { x: 4, y: 8, width: 220, height: 160 };
    const workHubDipRect = { x: 5, y: 10, width: 275, height: 200 };
    emit('browser:setViewport', main, scope, { sessionId: 'main-session', rect: mainRect }, 'main-document', 1);
    await invoke('browser:navigate', main, scope, 'main-session', 'https://main.example/');
    assert.equal(await invoke('browser:capture-page', main, scope, 'main-session'), 'data:image/png;base64,page');
    assert.equal(await invoke('browser:capture-page', workHub, scope, 'main-session'), undefined);
    await invoke('browser:navigate', workHub, scope, 'workhub-session', 'https://workhub.example/');
    emit('browser:setViewport', workHub, scope, { sessionId: 'workhub-session', rect: workHubRect }, 'workhub-document', 1);

    const mainController = controllers.get(mainKey)!;
    const workHubController = controllers.get(workHubKey)!;
    assert.equal(mainController.parent, mainParent);
    assert.equal(workHubController.parent, workHubParent);
    assert.deepEqual(mainController.viewports, [mainDipRect]);
    assert.deepEqual(workHubController.viewports, [workHubDipRect]);
    assert.deepEqual(mainController.navigations, ['https://main.example/']);
    assert.deepEqual(workHubController.navigations, ['https://workhub.example/']);

    // An ordinary session remains foreground-only even in an auxiliary renderer.
    // Hiding also revokes a read already waiting on the page.
    setBridgeFactoryForTest(() => ({
      connect: async () => ({ getCurrentUrl: async () => 'https://workhub.example/' }) as never,
      close: async () => undefined,
      send: async () => undefined,
      waitForEvent: async () => undefined,
    }));
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const pendingRead = withBrowserPage(workHubKey, 'snapshot', async () => {
      reading();
      return new Promise<never>(() => {});
    });
    const revoked = assert.rejects(pendingRead, BrowserActionRevokedError);
    await started;
    workHubVisible = false;
    browserIpc.refreshVisibility();
    await revoked;
    for (const kind of ['observe', 'navigate', 'mutate'] as const) {
      assert.equal(await browserViewHost().canDrive(workHubKey, kind), false);
    }
    assert.equal(await browserViewHost().canDrive(mainKey, 'observe'), true);
    workHubVisible = true;
    assert.equal(await browserViewHost().canDrive(workHubKey, 'observe'), true);
    // Reparenting follows the current native window, not the initial dock.
    windows.set(workHub, floatingWindow);
    floatingWindow.visible = false;
    assert.equal(await browserViewHost().canDrive(workHubKey, 'navigate'), false);
    floatingWindow.visible = true;
    floatingWindow.minimized = true;
    assert.equal(await browserViewHost().canDrive(workHubKey, 'observe'), false);
    floatingWindow.minimized = false;
    assert.equal(await browserViewHost().canDrive(workHubKey, 'navigate'), true);

    // The reserved coordination identity alone gets background access, still
    // fenced by Host epoch, live selection, and renderer lifetime.
    const coordinationKey = desktopSessionResourceKey({ ...scope, sessionId: WORKHUB_COORDINATION_SESSION_ID });
    workHubVisible = false;
    assert.equal(await browserViewHost().canDrive(coordinationKey, 'observe'), false);
    emit('browser:active-session', workHub, scope, WORKHUB_COORDINATION_SESSION_ID, 'workhub-document', 2);
    for (const kind of ['observe', 'navigate', 'mutate'] as const) {
      assert.equal(await browserViewHost().canDrive(coordinationKey, kind), true);
      assert.equal(await browserViewHost().canDrive(workHubKey, kind), false);
    }
    hostActive = false;
    assert.equal(await browserViewHost().canDrive(coordinationKey, 'observe'), false);
    hostActive = true;
    let finishRead!: () => void;
    let backgroundStarted!: () => void;
    const backgroundReady = new Promise<void>((resolve) => { backgroundStarted = resolve; });
    const backgroundRead = withBrowserPage(coordinationKey, 'snapshot', () => {
      backgroundStarted();
      return new Promise<void>((resolve) => { finishRead = resolve; });
    });
    await backgroundReady;
    floatingWindow.visible = false;
    browserIpc.refreshVisibility();
    finishRead();
    await backgroundRead;
    let retiringStarted!: () => void;
    const retiringReady = new Promise<void>((resolve) => { retiringStarted = resolve; });
    const retiringRead = withBrowserPage(coordinationKey, 'snapshot', () => {
      retiringStarted();
      return new Promise<never>(() => {});
    });
    const retired = assert.rejects(retiringRead, BrowserActionRevokedError);
    await retiringReady;
    emit('browser:active-session', workHub, scope, 'workhub-session', 'workhub-document', 3);
    await retired;
    assert.equal(await browserViewHost().canDrive(coordinationKey, 'navigate'), false);
    workHubVisible = true;
    floatingWindow.visible = true;

    // Neither a stale document/generation nor another renderer's selected
    // session can move or navigate the current native view.
    emit('browser:setViewport', main, scope, { sessionId: 'main-session', rect: workHubRect }, 'old-document', 1);
    emit('browser:setViewport', main, scope, { sessionId: 'main-session', rect: workHubRect }, 'main-document', 0);
    emit('browser:setViewport', main, scope, { sessionId: 'workhub-session', rect: mainRect }, 'main-document', 1);
    await invoke('browser:navigate', main, scope, 'workhub-session', 'https://cross-owner.example/');
    assert.deepEqual(mainController.viewports, [mainDipRect]);
    assert.deepEqual(workHubController.viewports, [workHubDipRect, null]);
    assert.deepEqual(workHubController.navigations, ['https://workhub.example/']);

    emit('browser:active-session', workHub, scope, 'main-session', 'workhub-document', 4);
    await invoke('browser:navigate', workHub, scope, 'main-session', 'https://stolen.example/');
    assert.deepEqual(mainController.navigations, ['https://main.example/']);
    assert.equal(mainController.parent, mainParent);
    assert.deepEqual(mainController.viewports, [mainDipRect]);

    // Native bounds follow an application zoom change even when the renderer's
    // CSS rect itself does not change.
    main.zoomFactor = 1.25;
    main.emit('zoom-changed');
    assert.deepEqual(mainController.viewports, [
      mainDipRect,
      { x: 13, y: 25, width: 375, height: 250 },
    ]);

    // Main presents Coordination without taking its persistent conversation ownership.
    emit('browser:active-session', workHub, scope, WORKHUB_COORDINATION_SESSION_ID, 'workhub-document', 5);
    emit('browser:active-session', main, scope, WORKHUB_COORDINATION_SESSION_ID, 'main-document', 2);
    emit('browser:setViewport', main, scope, { sessionId: WORKHUB_COORDINATION_SESSION_ID, rect: mainRect }, 'main-document', 2);
    const coordinationController = controllers.get(coordinationKey)!;
    assert.equal(coordinationController.parent, mainParent);
    assert.equal(coordinationController.hasOwner(workHubParent), true);
    mainWindow.emit('close');
    assert.equal(coordinationController.parent, workHubParent, 'Main close parks rather than destroys the background page');
    assert.equal(coordinationController.viewports.at(-1), null);
    main.zoomFactor = 1.5;
    main.emit('zoom-changed');
    assert.equal(coordinationController.parent, workHubParent, 'a stale presenter zoom cannot reclaim a shared page');
    assert.equal(await browserViewHost().canDrive(coordinationKey, 'mutate'), true);
    emit('browser:setViewport', main, scope, { sessionId: WORKHUB_COORDINATION_SESSION_ID, rect: mainRect }, 'main-document', 2);
    emit('browser:active-session', main, scope, 'main-session', 'main-document', 3);
    assert.equal(coordinationController.parent, workHubParent, 'switching Main to a Session hides only the Coordination presenter');
    assert.equal(await browserViewHost().canDrive(coordinationKey, 'mutate'), true);
    emit('browser:active-session', main, scope, WORKHUB_COORDINATION_SESSION_ID, 'main-document', 4);
    emit('browser:setViewport', main, scope, { sessionId: WORKHUB_COORDINATION_SESSION_ID, rect: mainRect }, 'main-document', 4);

    // Renderer-process loss preserves the native page for reload. Even if the
    // replacement document reads it before selecting the Session, destroying
    // the owning WebContents must still release the page by its fixed parent.
    workHub.emit('render-process-gone');
    assert.deepEqual(await invoke('browser:get-state', workHub, scope, 'workhub-session'), {
      hasPage: true,
      url: '',
    });
    emit('browser:document-ready', workHub, 'workhub-reloaded-document');
    workHub.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(workHubController.disposed, true);
    assert.equal(coordinationController.disposed, true, 'destroying the owner releases its page even while Main presents it');
    assert.equal(controllers.get(mainKey), mainController, 'destroying WorkHub preserves the main browser session');
    assert.equal(mainController.disposed, false);
  } finally {
    hooks.deregister();
    setBridgeFactoryForTest(null);
    provideBrowserViewHost(null);
    delete testGlobal.__makaBrowserIpcMain;
    delete testGlobal.__makaBrowserWindow;
  }
});
