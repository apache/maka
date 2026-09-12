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
import { focusWindow, showWindowInactive, type WindowRevealMode } from './window-reveal.js';

const COMMAND = 'workhub-presentation:command';
const SHORTCUT = 'CommandOrControl+Shift+K';
const RESIZE_DURATION = 420;

export interface WorkHubPresentationDeps {
  mainWindow(): BrowserWindow | undefined;
  ensureMainWindow(): Promise<BrowserWindow>;
  /** Applied client settings; showing the window must not wait for storage. */
  isEnabled(): boolean;
  /** How far this run may go when a WorkHub command reveals a window. */
  revealMode: WindowRevealMode;
  mainModuleDirectory: string;
  viteDevServerUrl?: string;
  preloadPath: string;
  onError?: (error: unknown) => void;
  onViewCreated?: (contents: Electron.WebContents) => (() => void) | void;
}

/** One renderer owns the conversation, draft and model selection for its entire lifetime. */
export function createWorkHubPresentation(deps: WorkHubPresentationDeps) {
  let view: WebContentsView | undefined;
  let viewBounds: Electron.Rectangle | undefined;
  let floating: BrowserWindow | undefined;
  let parent: BrowserWindow | undefined;
  let host: WorkHubHost = { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } };
  let presentationRevision = 0;
  let progressRequest: number | undefined;
  let conversationBounds: Electron.Rectangle | undefined;
  let controlTurnId: string | undefined;
  let dismissedTurnId: string | undefined;
  let expandOnFocus = false;
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
  let resizeViewportHeight: number | undefined;
  let viewportInset = 0;
  let floatingRadius: number | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const mainReady = new WeakSet<Electron.WebContents>();
  const pendingNavigation = new WeakMap<Electron.WebContents, { navigation: WorkHubMainNavigation; revision: number }>();
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
    return { placement, floatingVisible: !!floating && !floating.isDestroyed() && floating.isVisible(), shortcutRegistered, rendererCrashed, ...(progressRequest !== undefined ? { progressRequest } : {}) };
  }

  function send(channel: string, ...args: unknown[]): void {
    const main = deps.mainWindow();
    const contents = [main && !main.isDestroyed() ? main.webContents : undefined, view?.webContents];
    for (const wc of contents) if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
  }

  function changed(): void { send('workhub-presentation:changed', getSnapshot()); }

  function focusComposer(): void {
    focusPending = true;
    if (!view || view.webContents.isDestroyed() || !rendererReady || !parent || parent.isDestroyed()) return;
    // A cold summon stays hidden until the renderer has mounted its composer.
    // Reuse focusPending so hide/disable can cancel it before ready arrives.
    if (placement === 'floating' && progressRequest === undefined) focusWindow(parent, deps.revealMode);
    if (!parent.isVisible()) return;
    if (placement === 'docked' && (!host.visible || host.occluded)) return;
    view.webContents.focus();
    view.webContents.send('workhub-presentation:focus-composer', expandOnFocus);
    expandOnFocus = false;
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

  function cancelFloatingAnimation(preserveViewport = false): void {
    const restoreViewport = resizeViewportHeight !== undefined;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = undefined;
    resizeTarget = undefined;
    resizeViewportHeight = undefined;
    if (preserveViewport) return;
    setViewportInset(0);
    // Cancellation can precede an asynchronous dock. Restore native coordinates
    // immediately without remembering an intermediate height as the expanded size.
    if (restoreViewport && floating && !floating.isDestroyed() && parent === floating) {
      const { width, height } = floating.getContentBounds();
      setViewBounds({ x: 0, y: 0, width, height });
    }
  }

  function resizeFloating(bounds: Electron.Rectangle, animate: boolean): void {
    const window = floating!;
    if (resizeTarget && bounds.x === resizeTarget.x && bounds.y === resizeTarget.y &&
      bounds.width === resizeTarget.width && bounds.height === resizeTarget.height) return;
    const initial = window.getBounds();
    const previousViewportHeight = resizeViewportHeight;
    cancelFloatingAnimation(true);
    if (!animate || !window.isVisible() || systemPreferences.getAnimationSettings().prefersReducedMotion) {
      window.setBounds(bounds);
      fitFloating();
      return;
    }
    resizeTarget = bounds;
    // Move a stable canvas through the native window instead of relaying every
    // height sample through Blink layout. The native bounds still own hit testing.
    resizeViewportHeight = Math.max(initial.height, bounds.height, previousViewportHeight ?? 0);
    fitFloating();
    const started = performance.now();
    const frequency = screen.getDisplayMatching(bounds).displayFrequency;
    const frameDuration = 1000 / (Number.isFinite(frequency) && frequency > 0 ? frequency : 60);
    let frame = 0;
    let previous = initial;
    const tick = () => {
      if (disposed || window.isDestroyed() || floating !== window || placement !== 'floating') {
        cancelFloatingAnimation();
        return;
      }
      const progress = Math.min(1, (performance.now() - started) / RESIZE_DURATION);
      // A critically damped response gives the glass a soft start and a long
      // landing without overshooting the screen or scaling the live editor.
      const eased = (1 - (1 + 7 * progress) * Math.exp(-7 * progress)) / (1 - 8 * Math.exp(-7));
      const height = Math.round(initial.height + (bounds.height - initial.height) * eased);
      const width = Math.round(initial.width + (bounds.width - initial.width) * eased);
      const center = initial.x + initial.width / 2 + (bounds.x + bounds.width / 2 - initial.x - initial.width / 2) * eased;
      const bottom = Math.round(initial.y + initial.height + (bounds.y + bounds.height - initial.y - initial.height) * eased);
      const next = { width, height, x: Math.round(center - width / 2), y: bottom - height };
      if (next.x !== previous.x || next.y !== previous.y || next.width !== previous.width || next.height !== previous.height) {
        window.setBounds(next);
        fitFloating();
        previous = next;
      }
      if (progress < 1) {
        // Keep frame deadlines independent of native resize work; do not add
        // another full frame's delay after every setBounds/resize callback.
        const elapsed = performance.now() - started;
        // Timers can fire just before their deadline. Always advance the frame
        // index so an early callback cannot submit two native resizes per frame.
        frame = Math.max(frame + 1, Math.floor(elapsed / frameDuration) + 1);
        const nextFrame = Math.min(RESIZE_DURATION, frame * frameDuration);
        resizeTimer = setTimeout(tick, Math.max(1, nextFrame - elapsed));
      }
      else { cancelFloatingAnimation(); fitFloating(); }
    };
    tick();
  }

  function setViewBounds(bounds: Electron.Rectangle): void {
    if (!view || (viewBounds && bounds.x === viewBounds.x && bounds.y === viewBounds.y &&
      bounds.width === viewBounds.width && bounds.height === viewBounds.height)) return;
    view.setBounds(bounds);
    viewBounds = bounds;
  }

  function setViewportInset(inset: number): void {
    if (viewportInset === inset) return;
    viewportInset = inset;
    if (view && !view.webContents.isDestroyed()) view.webContents.send('workhub-presentation:viewport-inset', inset / view.webContents.getZoomFactor());
  }

  function fitFloating(): void {
    if (!floating || floating.isDestroyed() || parent !== floating || !view) return;
    const { width, height } = floating.getContentBounds();
    // Clip in the native parent so resizing does not rebuild a renderer mask.
    // CSS supplies the larger resting radius; this is its minimum moving edge.
    const radius = Math.floor((progressRequest === undefined ? 20 : 18) * view.webContents.getZoomFactor());
    if (radius !== floatingRadius) {
      floating.contentView.setBorderRadius(radius);
      floatingRadius = radius;
    }
    const canvasHeight = resizeViewportHeight ?? height;
    setViewportInset(canvasHeight - height);
    setViewBounds({ x: 0, y: height - canvasHeight, width, height: canvasHeight });
    if (progressRequest === undefined && conversationExpanded && !resizeTarget) expandedHeight = height;
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
      resizable: conversationExpanded,
      alwaysOnTop: true, autoHideMenuBar: true, maximizable: false, fullscreenable: false,
      frame: false, transparent: true, backgroundColor: '#00000000',
      hasShadow: true, roundedCorners: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    floatingRadius = undefined;
    // A macOS panel can accompany fullscreen apps without turning Maka into
    // a Dock-less accessory application.
    if (process.platform === 'darwin') floating.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    floating.on('resize', fitFloating);
    floating.on('close', (event) => {
      if (disposed) return;
      event.preventDefault();
      ++presentationRevision;
      hideFloating();
    });
    return floating;
  }

  function updateDockedBounds(): void {
    const main = deps.mainWindow();
    if (!view || placement !== 'docked' || !main || main.isDestroyed()) return;
    // A hidden Desktop cannot display the conversation. Keep its native view
    // parked for the next shortcut, and attach synchronously when Desktop shows.
    if (floating && parent === floating && !main.isVisible()) return;
    attach(main);
    const zoom = main.webContents.getZoomFactor();
    const size = main.getContentBounds();
    const x = Math.max(0, Math.min(size.width, Math.round(host.rect.x * zoom)));
    const y = Math.max(0, Math.min(size.height, Math.round(host.rect.y * zoom)));
    const width = Math.max(0, Math.min(size.width - x, Math.round(host.rect.width * zoom)));
    const height = Math.max(0, Math.min(size.height - y, Math.round(host.rect.height * zoom)));
    setViewBounds({ x, y, width, height });
    view.setVisible(host.visible && !host.occluded && width > 0 && height > 0);
    if (host.visible && width > 0 && height > 0 && focusPending) focusComposer();
  }

  function clearProgressRequest(): void {
    if (progressRequest !== undefined && view && !view.webContents.isDestroyed()) view.webContents.setBackgroundThrottling(true);
    progressRequest = undefined;
  }

  function hideFloating(): void {
    cancelFloatingAnimation();
    floating?.hide();
    if (controlTurnId) dismissedTurnId = controlTurnId;
    clearProgressRequest();
    expandOnFocus = false;
    focusPending = false;
    placement = 'docked';
    // Reparent the live view to an existing Desktop without opening/focusing it.
    // If Desktop is closed, the hidden floating container keeps the view alive.
    updateDockedBounds();
    changed();
  }

  function detach(positionAtDefault = false): void {
    if (!deps.isEnabled() || disposed) return;
    cancelFloatingAnimation();
    ensureView();
    const target = ensureFloating();
    clearProgressRequest();
    placement = 'floating';
    attach(target);
    view!.setVisible(true);
    // Summoning follows the pointer's display, including an existing window
    // that was last used on another monitor.
    const old = conversationBounds ?? target.getBounds();
    target.setResizable(conversationExpanded);
    conversationBounds = undefined;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(old.width, area.width);
    const height = Math.min(conversationExpanded ? expandedHeight : compactHeight, area.height);
    const bounds = {
      width, height,
      x: positionAtDefault ? area.x + Math.round((area.width - width) / 2) : Math.max(area.x, Math.min(old.x, area.x + area.width - width)),
      y: positionAtDefault ? Math.max(area.y, area.y + area.height - height - 96) : Math.max(area.y, Math.min(old.y, area.y + area.height - height)),
    };
    const current = target.getBounds();
    if (bounds.x !== current.x || bounds.y !== current.y || bounds.width !== current.width || bounds.height !== current.height) target.setBounds(bounds);
    fitFloating();
    focusComposer();
    changed();
  }

  function requestProgress(): void {
    const main = deps.mainWindow();
    const dockVisible = placement === 'docked' && parent === main && main?.isVisible() && !main.isMinimized()
      && host.visible && !host.occluded && view?.getVisible();
    if (!controlTurnId || dismissedTurnId === controlTurnId || progressRequest !== undefined || dockVisible
      || (placement === 'floating' && (floating?.isVisible() || focusPending)) || !deps.isEnabled() || disposed) return;
    ensureView();
    const target = ensureFloating();
    cancelFloatingAnimation();
    conversationBounds ??= target.getBounds();
    target.setResizable(false);
    progressRequest = ++presentationRevision;
    // The card must paint while its native window is hidden. Hidden pages
    // suspend RAF by default, which would deadlock the renderer-ready handshake.
    view!.webContents.setBackgroundThrottling(false);
    placement = 'floating';
    attach(target);
    view!.setVisible(true);
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(360, area.width), height = Math.min(112, area.height);
    target.setBounds({ width, height, x: area.x + Math.round((area.width - width) / 2), y: Math.max(area.y, area.y + area.height - height - 96) });
    fitFloating();
    // The renderer acknowledges its painted card before showInactive, avoiding
    // one frame of the old full conversation in the compact native window.
    changed();
  }

  async function prepareControl(turnId?: string): Promise<void> {
    if (!deps.isEnabled()) throw new Error('WorkHub is disabled');
    if (disposed) throw new Error('WorkHub presentation is disposed');
    controlTurnId = turnId;
    // The creation fallback activates Desktop. An existing window must retain
    // its visibility, stacking order and focus while WorkHub operates it.
    const existing = deps.mainWindow();
    const main = existing && !existing.isDestroyed() ? existing : await deps.ensureMainWindow();
    if (!deps.isEnabled()) throw new Error('WorkHub is disabled');
    if (disposed) throw new Error('WorkHub presentation is disposed');
    attachMainWindow(main);
    requestProgress();
  }

  async function navigateMain(navigation: WorkHubMainNavigation, revision = presentationRevision): Promise<BrowserWindow | undefined> {
    if (navigation.kind === 'workhub' && !deps.isEnabled()) return;
    const main = await deps.ensureMainWindow();
    if (disposed) throw new Error('WorkHub presentation is disposed');
    if (revision !== presentationRevision || (navigation.kind === 'workhub' && !deps.isEnabled())) return;
    attachMainWindow(main);
    focusWindow(main, deps.revealMode);
    if (mainReady.has(main.webContents)) main.webContents.send('workhub-presentation:open-main', navigation);
    else pendingNavigation.set(main.webContents, { navigation, revision });
    return main;
  }

  async function dock(revision: number): Promise<void> {
    cancelFloatingAnimation();
    if (!await navigateMain({ kind: 'workhub' }, revision) || revision !== presentationRevision || !deps.isEnabled() || disposed) return;
    ensureView();
    floating?.hide();
    clearProgressRequest();
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
      placement = 'docked';
      host = { ...host, visible: false };
      changed();
    };
    const onLoading = () => mainReady.delete(contents);
    contents.on('did-start-loading', onLoading);
    main.on('close', onClose);
    main.on('resize', updateDockedBounds);
    main.on('show', updateDockedBounds);
    const cleanup = () => {
      if (!contents.isDestroyed()) contents.removeListener('did-start-loading', onLoading);
      main.removeListener('close', onClose);
      main.removeListener('resize', updateDockedBounds);
      main.removeListener('show', updateDockedBounds);
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
    ipcMain.handle(COMMAND, async (event, command: unknown, payload: unknown) => {
      const authorize = () => {
        const main = deps.mainWindow();
        const isMain = !!main && !main.isDestroyed() && main.webContents === event.sender;
        if ((!isMain && !ownsWebContents(event.sender)) || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('WorkHub presentation IPC requires an owned main frame');
        }
        return { main, isMain };
      };
      authorize();
      if (command === 'show-conversation' && payload !== undefined) {
        if (typeof payload !== 'number' || !Number.isSafeInteger(payload)) throw new Error('Invalid progress request');
        if (payload !== progressRequest) return;
      }
      const changesPresentation = command === 'detach' || command === 'show-conversation' || command === 'dock' || command === 'hide' || command === 'session';
      const revision = changesPresentation ? ++presentationRevision : presentationRevision;
      return enqueue(async () => {
        const { main, isMain } = authorize();
        // A newer shortcut takes effect immediately, including during a pending dock.
        if (changesPresentation && revision !== presentationRevision) return;
        switch (command) {
          case 'snapshot': return getSnapshot();
          case 'ready':
            if (!isMain) { rendererReady = true; if (focusPending) { focusComposer(); changed(); } }
            else {
              mainReady.add(event.sender);
              const pending = pendingNavigation.get(event.sender);
              pendingNavigation.delete(event.sender);
              const navigation = pending?.revision === presentationRevision ? pending.navigation : undefined;
              if (navigation && (navigation.kind !== 'workhub' || deps.isEnabled())) {
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
            // Layout cannot reopen a disabled dock.
            host = value.visible && !host.visible && !deps.isEnabled() ? { ...value, visible: false } : value;
            if (disposed) return;
            if (host.visible && placement === 'docked') {
              attachMainWindow(main!);
              // Layout notifications must not turn a crash into a reload loop.
              if (!rendererCrashed) ensureView();
            }
            if (!host.visible) requestProgress();
            updateDockedBounds();
            return backdrop;
          }
          case 'progress-ready':
            if (isMain) throw new Error('Only the WorkHub view can present its progress');
            if (typeof payload !== 'number' || !Number.isSafeInteger(payload)) throw new Error('Invalid progress request');
            if (payload === progressRequest && payload === presentationRevision && deps.isEnabled()) {
              showWindowInactive(floating ?? null, deps.revealMode);
              view?.webContents.setBackgroundThrottling(true);
              changed();
            }
            return;
          case 'progress-layout': {
            if (isMain) throw new Error('Only the WorkHub view can size its progress card');
            const value = payload as { request?: unknown; height?: unknown } | null;
            if (!value || typeof value.request !== 'number' || !Number.isSafeInteger(value.request) ||
              typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height <= 0) throw new Error('Invalid WorkHub progress layout');
            if (value.request !== progressRequest || !floating || !deps.isEnabled()) return;
            const bounds = resizeTarget ?? floating.getBounds();
            const area = screen.getDisplayMatching(bounds).workArea;
            const height = Math.min(Math.max(112, Math.ceil(value.height)), area.height);
            if (height !== bounds.height) resizeFloating({ ...bounds, height, y: Math.max(area.y, bounds.y + bounds.height - height) }, true);
            return;
          }
          case 'show-conversation': {
            if (payload !== undefined && payload !== progressRequest) return;
            conversationExpanded = true;
            expandOnFocus = true;
            if (progressRequest !== undefined && floating) {
              const current = floating.getBounds();
              const area = screen.getDisplayMatching(current).workArea;
              const width = Math.min(conversationBounds?.width ?? 520, area.width);
              const height = Math.min(expandedHeight, area.height);
              clearProgressRequest();
              conversationBounds = undefined;
              floating.setResizable(true);
              changed();
              resizeFloating({
                width, height,
                x: Math.max(area.x, Math.min(current.x + Math.round((current.width - width) / 2), area.x + area.width - width)),
                y: Math.max(area.y, Math.min(current.y + current.height - height, area.y + area.height - height)),
              }, true);
              // A send acknowledgement can arrive after the user has switched
              // apps. Growing the conversation must not steal focus back.
              if (floating.isFocused()) focusComposer();
              return;
            }
            detach(true);
            return;
          }
          case 'detach': detach(); return;
          case 'conversation-layout': {
            if (isMain) throw new Error('Only the WorkHub view can size its conversation');
            const value = payload as { expanded?: unknown; compactHeight?: unknown } | null;
            if (!value || typeof value.expanded !== 'boolean' || typeof value.compactHeight !== 'number' || !Number.isFinite(value.compactHeight) || value.compactHeight <= 0) throw new Error('Invalid WorkHub conversation layout');
            if (progressRequest !== undefined) return;
            // Desktop's wider composer must not overwrite the remembered floating
            // height and force a second resize on the next shortcut summon.
            if (!floating || placement === 'floating') compactHeight = Math.max(80, Math.ceil(value.compactHeight));
            if (placement !== 'floating' || !floating || floating.isDestroyed()) {
              conversationExpanded = value.expanded;
              return;
            }
            const bounds = resizeTarget ?? floating.getBounds();
            const area = screen.getDisplayMatching(bounds).workArea;
            const height = Math.min(area.height, value.expanded ? expandedHeight : compactHeight);
            const animate = conversationExpanded !== value.expanded || !!resizeTarget;
            if (conversationExpanded !== value.expanded) floating.setResizable(value.expanded);
            conversationExpanded = value.expanded;
            if (bounds.height !== height) {
              resizeFloating({ ...bounds, height, y: Math.max(area.y, Math.min(bounds.y + bounds.height - height, area.y + area.height - height)) }, animate);
            }
            return;
          }
          case 'dock': await dock(revision); return;
          case 'hide': hideFloating(); return;
          case 'session':
            if (typeof payload !== 'string' || payload.length > 4096) throw new Error('Invalid session key');
            parseDesktopSessionKey(payload);
            await navigateMain({ kind: 'session', sessionKey: payload }, revision);
            return;
          default: throw new Error('Unknown WorkHub presentation command');
        }
      });
    });
    ipcRegistered = true;
  }

  async function toggle(positionAtDefault = false): Promise<void> {
    if (disposed) throw new Error('WorkHub presentation is disposed');
    ++presentationRevision;
    if (progressRequest === undefined && placement === 'floating' && (floating?.isVisible() || focusPending)) {
      hideFloating();
    } else detach(positionAtDefault);
  }

  async function refreshSettings(): Promise<void> {
    const enabled = deps.isEnabled();
    if (disposed) return;
    if (enabled) {
      // Enabling only registers the shortcut. The dock, shortcut or control
      // request creates the renderer on first use; settings alone must not
      // load a second application in the background.
      if (!shortcutRegistered) shortcutRegistered = globalShortcut.register(SHORTCUT, () => { void toggle(true).catch(reportError); });
    } else {
      if (shortcutRegistered) globalShortcut.unregister(SHORTCUT);
      shortcutRegistered = false;
      ++presentationRevision;
      cancelFloatingAnimation();
      focusPending = false;
      host = { ...host, visible: false };
      view?.setVisible(false);
      hideFloating();
      return;
    }
    changed();
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
    viewBounds = undefined;
    rendererReady = false;
    focusPending = false;
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

  return { registerIpc, refreshSettings, attachMainWindow, getSnapshot, ownsWebContents, send, prepareControl: (turnId?: string) => enqueue(() => prepareControl(turnId)), finishControl: () => { controlTurnId = undefined; }, show: async () => { if (disposed) throw new Error('WorkHub presentation is disposed'); ++presentationRevision; detach(); }, toggle, dispose };
}
