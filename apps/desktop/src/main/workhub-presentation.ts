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

import { BrowserWindow, WebContentsView, globalShortcut, ipcMain, screen, systemPreferences } from 'electron';
import type { WorkHubHost, WorkHubMainNavigation, WorkHubPresentationSnapshot } from '../shared/workhub-presentation.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import { loadMainRenderer, resolveMainRendererEntry } from './main-renderer-loader.js';
import { installMainWindowPermissionPolicy } from './main-window-permission-policy.js';

const COMMAND = 'workhub-presentation:command';
const SHORTCUT = 'CommandOrControl+Shift+K';

export interface WorkHubPresentationDeps {
  mainWindow(): BrowserWindow | undefined;
  ensureMainWindow(): Promise<BrowserWindow>;
  mainModuleDirectory: string;
  viteDevServerUrl?: string;
  preloadPath: string;
  onError?: (error: unknown) => void;
  onViewCreated?: (contents: Electron.WebContents) => (() => void) | void;
}

/** One renderer owns the conversation, draft and model selection for its entire lifetime. */
export function createWorkHubPresentation(deps: WorkHubPresentationDeps) {
  let view: WebContentsView | undefined;
  let floating: BrowserWindow | undefined;
  let parent: BrowserWindow | undefined;
  let host: WorkHubHost = { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } };
  let placement: 'docked' | 'floating' = 'docked';
  let shortcutRegistered = false;
  let disposed = false;
  let ipcRegistered = false;
  let rendererReady = false;
  let rendererCrashed = false;
  let releaseView: (() => void) | undefined;
  let focusPending = false;
  let conversationExpanded = false;
  let compactHeight = 96;
  let expandedHeight = 720;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTarget: Electron.Rectangle | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const mainReady = new WeakSet<Electron.WebContents>();
  const pendingNavigation = new WeakMap<Electron.WebContents, WorkHubMainNavigation>();
  const mainListeners = new Map<BrowserWindow, () => void>();
  const entry = resolveMainRendererEntry(deps.mainModuleDirectory, deps.viteDevServerUrl);
  const reportError = deps.onError ?? ((error: unknown) => console.error('[workhub-presentation]', error));

  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = queue.then(() => {
      if (disposed) throw new Error('WorkHub presentation is disposed');
      return operation();
    });
    queue = next.catch(() => undefined);
    return next;
  }

  function getSnapshot(): WorkHubPresentationSnapshot {
    return { placement, floatingVisible: !!floating && !floating.isDestroyed() && floating.isVisible(), shortcutRegistered, rendererCrashed };
  }

  function send(channel: string, ...args: unknown[]): void {
    const main = deps.mainWindow();
    const contents = [main && !main.isDestroyed() ? main.webContents : undefined, view?.webContents];
    for (const wc of contents) if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
  }

  function changed(): void { send('workhub-presentation:changed', getSnapshot()); }

  function focusComposer(): void {
    focusPending = true;
    if (!view || view.webContents.isDestroyed() || !rendererReady || !parent || parent.isDestroyed() || !parent.isVisible()) return;
    if (placement === 'docked' && (!host.visible || host.occluded)) return;
    view.webContents.focus();
    view.webContents.send('workhub-presentation:focus-composer');
    focusPending = false;
  }

  function attach(next: BrowserWindow): void {
    if (!view || parent === next) return;
    if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view);
    next.contentView.addChildView(view);
    parent = next;
  }

  function ensureView(): WebContentsView {
    if (view) return view;
    view = new WebContentsView({ webPreferences: {
      preload: deps.preloadPath, contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    } });
    rendererCrashed = false;
    view.setVisible(false);
    view.setBackgroundColor('#00000000');
    const release = deps.onViewCreated?.(view.webContents);
    releaseView = typeof release === 'function' ? release : undefined;
    view.webContents.once('destroyed', releaseViewRegistration);
    installMainWindowPermissionPolicy(view.webContents, entry.url);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    const contents = view.webContents;
    contents.once('render-process-gone', (_event, details) => {
      if (!ownsWebContents(contents)) return;
      disposeView();
      rendererCrashed = true;
      changed();
      reportError(new Error(`WorkHub renderer exited: ${details.reason}`));
    });
    void loadMainRenderer(view.webContents, entry, 'workhub').catch(reportError);
    changed();
    return view;
  }

  function cancelFloatingAnimation(): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = undefined;
    resizeTarget = undefined;
  }

  function resizeFloating(bounds: Electron.Rectangle, animate: boolean): void {
    const window = floating!;
    const initial = window.getBounds();
    cancelFloatingAnimation();
    if (!animate || !window.isVisible() || systemPreferences.getAnimationSettings().prefersReducedMotion) {
      window.setBounds(bounds);
      fitFloating();
      return;
    }
    resizeTarget = bounds;
    const started = Date.now();
    const tick = () => {
      if (disposed || window.isDestroyed() || floating !== window || placement !== 'floating') {
        cancelFloatingAnimation();
        return;
      }
      const progress = Math.min(1, (Date.now() - started) / 240);
      const eased = 1 - (1 - progress) ** 3;
      const height = Math.round(initial.height + (bounds.height - initial.height) * eased);
      const bottom = Math.round(initial.y + initial.height + (bounds.y + bounds.height - initial.y - initial.height) * eased);
      window.setBounds({ ...bounds, height, y: bottom - height });
      fitFloating();
      if (progress < 1) resizeTimer = setTimeout(tick, 16);
      else cancelFloatingAnimation();
    };
    tick();
  }

  function fitFloating(): void {
    if (!floating || floating.isDestroyed() || parent !== floating || !view) return;
    const { width, height } = floating.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
    if (conversationExpanded && !resizeTarget) expandedHeight = height;
  }

  function ensureFloating(): BrowserWindow {
    if (floating && !floating.isDestroyed()) return floating;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(520, area.width);
    const height = Math.min(conversationExpanded ? expandedHeight : compactHeight, area.height);
    floating = new BrowserWindow({
      title: 'WorkHub', show: false, width, height,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      x: area.x + Math.round((area.width - width) / 2), y: Math.max(area.y, area.y + area.height - height - 96),
      minWidth: Math.min(360, width), minHeight: Math.min(80, height),
      alwaysOnTop: true, autoHideMenuBar: true, maximizable: false, fullscreenable: false,
      frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: true, roundedCorners: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // A macOS panel can accompany fullscreen apps without turning Maka into
    // a Dock-less accessory application.
    if (process.platform === 'darwin') floating.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    floating.on('resize', fitFloating);
    floating.on('close', (event) => {
      if (disposed) return;
      event.preventDefault();
      cancelFloatingAnimation();
      floating?.hide();
      changed();
    });
    return floating;
  }

  function updateDockedBounds(): void {
    const main = deps.mainWindow();
    if (!view || placement !== 'docked' || !main || main.isDestroyed()) return;
    attach(main);
    const zoom = main.webContents.getZoomFactor();
    const size = main.getContentBounds();
    const x = Math.max(0, Math.min(size.width, Math.round(host.rect.x * zoom)));
    const y = Math.max(0, Math.min(size.height, Math.round(host.rect.y * zoom)));
    const width = Math.max(0, Math.min(size.width - x, Math.round(host.rect.width * zoom)));
    const height = Math.max(0, Math.min(size.height - y, Math.round(host.rect.height * zoom)));
    view.setBounds({ x, y, width, height });
    view.setVisible(host.visible && !host.occluded && width > 0 && height > 0);
    if (host.visible && width > 0 && height > 0 && focusPending) focusComposer();
  }

  function detach(positionAtDefault = false): void {
    cancelFloatingAnimation();
    ensureView();
    const target = ensureFloating();
    placement = 'floating';
    attach(target);
    view!.setVisible(true);
    // Summoning follows the pointer's display, including an existing window
    // that was last used on another monitor.
    const old = target.getBounds();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(old.width, area.width);
    const height = Math.min(conversationExpanded ? expandedHeight : compactHeight, area.height);
    target.setBounds({
      width, height,
      x: positionAtDefault ? area.x + Math.round((area.width - width) / 2) : Math.max(area.x, Math.min(old.x, area.x + area.width - width)),
      y: positionAtDefault ? Math.max(area.y, area.y + area.height - height - 96) : Math.max(area.y, Math.min(old.y, area.y + area.height - height)),
    });
    fitFloating();
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    target.setMaximizable(false);
    focusComposer();
    changed();
  }

  async function prepareControl(): Promise<void> {
    const main = await deps.ensureMainWindow();
    if (disposed) throw new Error('WorkHub presentation is disposed');
    attachMainWindow(main);
    if (placement !== 'floating' || !floating?.isVisible()) detach();
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }

  async function navigateMain(navigation: WorkHubMainNavigation): Promise<BrowserWindow> {
    const main = await deps.ensureMainWindow();
    if (disposed) throw new Error('WorkHub presentation is disposed');
    attachMainWindow(main);
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    if (mainReady.has(main.webContents)) main.webContents.send('workhub-presentation:open-main', navigation);
    else pendingNavigation.set(main.webContents, navigation);
    return main;
  }

  async function dock(): Promise<void> {
    cancelFloatingAnimation();
    await navigateMain({ kind: 'workhub' });
    ensureView();
    floating?.hide();
    placement = 'docked';
    updateDockedBounds();
    focusComposer();
    changed();
  }

  function attachMainWindow(main: BrowserWindow): void {
    if (mainListeners.has(main)) return;
    const contents = main.webContents;
    const onClose = () => {
      if (disposed || parent !== main || !view) return;
      cancelFloatingAnimation();
      // BrowserWindow disposal must never own the conversation's lifetime.
      attach(ensureFloating());
      floating!.hide();
      placement = 'floating';
      host = { ...host, visible: false };
      changed();
    };
    const onLoading = () => mainReady.delete(contents);
    contents.on('did-start-loading', onLoading);
    main.on('close', onClose);
    main.on('resize', updateDockedBounds);
    const cleanup = () => {
      if (!contents.isDestroyed()) contents.removeListener('did-start-loading', onLoading);
      main.removeListener('close', onClose);
      main.removeListener('resize', updateDockedBounds);
      mainListeners.delete(main);
    };
    main.once('closed', cleanup);
    mainListeners.set(main, () => { cleanup(); main.removeListener('closed', cleanup); });
  }

  function ownsWebContents(contents: Electron.WebContents): boolean {
    return !!view && !view.webContents.isDestroyed() && view.webContents === contents;
  }

  function registerIpc(): void {
    if (ipcRegistered) return;
    ipcMain.handle(COMMAND, (event, command: unknown, payload: unknown) => {
      return enqueue(async () => {
        const main = deps.mainWindow();
        const isMain = !!main && !main.isDestroyed() && main.webContents === event.sender;
        if ((!isMain && !ownsWebContents(event.sender)) || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('WorkHub presentation IPC requires an owned main frame');
        }
        switch (command) {
          case 'snapshot': return getSnapshot();
          case 'ready':
            if (!isMain) { rendererReady = true; if (focusPending) focusComposer(); }
            else {
              mainReady.add(event.sender);
              const navigation = pendingNavigation.get(event.sender);
              if (navigation) {
                pendingNavigation.delete(event.sender);
                event.sender.send('workhub-presentation:open-main', navigation);
              }
            }
            return;
          case 'host': {
            if (!isMain) throw new Error('Only the main window can place WorkHub');
            if (!payload || typeof payload !== 'object') throw new Error('Invalid WorkHub host');
            const value = payload as WorkHubHost;
            if (typeof value.visible !== 'boolean' || (value.occluded !== undefined && typeof value.occluded !== 'boolean') || !value.rect ||
              ![value.rect.x, value.rect.y, value.rect.width, value.rect.height].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
              value.rect.width < 0 || value.rect.height < 0) throw new Error('Invalid WorkHub host');
            // Native child views sit above the main renderer's top layer. Keep
            // a still frame behind its menus/dialogs while yielding native input.
            let backdrop: string | undefined;
            if (placement === 'docked' && value.visible && value.occluded && !host.occluded && view?.getVisible() &&
              rendererReady && main?.isVisible() && !main.isMinimized()) {
              try { backdrop = (await view.webContents.capturePage()).toDataURL(); }
              catch (error) {
                // Reparenting or hiding can retire the compositor surface before
                // capture completes. Menus still work without this optional frame.
                if (!(error instanceof Error && error.message === 'UnknownVizError')) reportError(error);
              }
            }
            if (disposed) return;
            host = value;
            if (host.visible && placement === 'docked') {
              attachMainWindow(main!);
              // Layout notifications must not turn a crash into a reload loop.
              if (!rendererCrashed) ensureView();
            }
            updateDockedBounds();
            return backdrop;
          }
          case 'detach': detach(); return;
          case 'conversation-layout': {
            if (isMain) throw new Error('Only the WorkHub view can size its conversation');
            const value = payload as { expanded?: unknown; compactHeight?: unknown } | null;
            if (!value || typeof value.expanded !== 'boolean' || typeof value.compactHeight !== 'number' || !Number.isFinite(value.compactHeight) || value.compactHeight <= 0) throw new Error('Invalid WorkHub conversation layout');
            compactHeight = Math.max(80, Math.ceil(value.compactHeight));
            if (placement !== 'floating' || !floating || floating.isDestroyed()) {
              conversationExpanded = value.expanded;
              return;
            }
            const bounds = resizeTarget ?? floating.getBounds();
            const area = screen.getDisplayMatching(bounds).workArea;
            const height = Math.min(area.height, value.expanded ? expandedHeight : compactHeight);
            const animate = conversationExpanded !== value.expanded || !!resizeTarget;
            conversationExpanded = value.expanded;
            if (bounds.height !== height) {
              resizeFloating({ ...bounds, height, y: Math.max(area.y, Math.min(bounds.y + bounds.height - height, area.y + area.height - height)) }, animate);
            }
            return;
          }
          case 'dock': await dock(); return;
          case 'hide': cancelFloatingAnimation(); floating?.hide(); changed(); return;
          case 'session':
            if (typeof payload !== 'string' || payload.length > 4096) throw new Error('Invalid session key');
            parseDesktopSessionKey(payload);
            await navigateMain({ kind: 'session', sessionKey: payload });
            return;
          default: throw new Error('Unknown WorkHub presentation command');
        }
      });
    });
    ipcRegistered = true;
  }

  function toggle(positionAtDefault = false): Promise<void> {
    return enqueue(async () => {
      if (placement === 'floating' && floating?.isVisible()) {
        cancelFloatingAnimation();
        floating.hide();
        changed();
      } else detach(positionAtDefault);
    });
  }

  function registerShortcut(): boolean {
    if (!shortcutRegistered) shortcutRegistered = globalShortcut.register(SHORTCUT, () => { void toggle(true).catch(reportError); });
    changed();
    return shortcutRegistered;
  }

  function releaseViewRegistration(): void {
    const release = releaseView;
    releaseView = undefined;
    release?.();
  }

  function disposeView(): void {
    cancelFloatingAnimation();
    const previous = view;
    view = undefined;
    rendererReady = false;
    // Release this renderer's subscriptions and broadcasts before another view
    // can register. A delayed destroyed event must not release its replacement.
    previous?.webContents.removeListener('destroyed', releaseViewRegistration);
    releaseViewRegistration();
    if (previous && parent && !parent.isDestroyed()) parent.contentView.removeChildView(previous);
    parent = undefined;
    if (previous && !previous.webContents.isDestroyed()) previous.webContents.close({ waitForBeforeUnload: false });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (shortcutRegistered) globalShortcut.unregister(SHORTCUT);
    if (ipcRegistered) ipcMain.removeHandler(COMMAND);
    for (const cleanup of mainListeners.values()) cleanup();
    disposeView();
    if (floating && !floating.isDestroyed()) floating.destroy();
    floating = undefined;
  }

  return { registerIpc, registerShortcut, attachMainWindow, getSnapshot, ownsWebContents, send, prepareControl: () => enqueue(prepareControl), show: () => enqueue(detach), toggle, dispose };
}
