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

import { type BrowserWindow, type Session, shell, WebContentsView } from 'electron';
import { CdpBridge, type AutomationEndpoint } from './cdp-bridge.js';
import { browserViewWebPreferences } from './options.js';
import {
  type BrowserState,
  type BrowserViewRect,
  deriveBrowserState,
  parseNavigable,
  safeExternalUrl,
  viewportBounds,
} from './logic.js';

// The security backstop is PARTITION-level: every conversation's view shares
// `persist:maka-browser`, so the handlers + will-download guard belong to that
// one session, not to each view. Install once per session — `will-download` is
// an ADDITIVE listener, so re-adding it per view would pile up listeners (Node
// MaxListeners warning) and never detach on dispose.
const backstopInstalledFor = new WeakSet<Session>();

// Poll interval for waitForLiveViewport — roughly one animation frame, the
// cadence at which the renderer re-reports the strip rect after a modal closes.
const VIEWPORT_RESTORE_POLL_MS = 16;

/**
 * Owns ONE embedded browser per conversation: a native WebContentsView attached
 * to the single app window, floating above the renderer DOM. The renderer
 * reserves a strip and mirrors its on-screen rect via setViewport; the view
 * starts hidden + zero-bounds so an ordinary chat reserves nothing. Page,
 * history, and the CDP automation live and die with the conversation.
 *
 * The window is shared, but each conversation gets its own controller/view, so
 * switching conversations never shows another conversation's page (the view
 * manager hides the ones not in front).
 */
export class BrowserViewController {
  private readonly view: WebContentsView;
  private destroyed = false;
  /** True while the view holds real on-screen bounds (last setViewport painted it). */
  private shownWithBounds = false;
  private automation: CdpBridge | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly sessionId: string,
    private readonly onState: (sessionId: string, state: BrowserState) => void,
  ) {
    this.view = new WebContentsView({ webPreferences: browserViewWebPreferences() });
    this.window.contentView.addChildView(this.view);
    this.view.setVisible(false);
    this.applySecurityBackstop();
    this.wireEvents();
  }

  private get wc() {
    return this.view.webContents;
  }

  private wireEvents(): void {
    const wc = this.wc;
    wc.on('did-start-loading', () => this.emitState());
    wc.on('did-stop-loading', () => this.emitState());
    wc.on('did-navigate', () => this.emitState());
    wc.on('did-navigate-in-page', () => this.emitState());
    wc.on('page-title-updated', () => this.emitState());
    wc.on('did-fail-load', () => this.emitState());

    // Single-view browser: keep http(s) "open in new window" links in-place and
    // hand any other scheme to the system browser. Never spawn a child window.
    wc.setWindowOpenHandler(({ url }) => {
      const navigable = parseNavigable(url);
      if (navigable) void this.loadInternal(navigable);
      else this.openExternal(url);
      return { action: 'deny' };
    });

    // Block link navigations to non-web schemes (file://, etc.); route real
    // external schemes to the system browser instead of failing silently.
    wc.on('will-navigate', (event, url) => {
      if (parseNavigable(url)) return;
      event.preventDefault();
      this.openExternal(url);
    });
  }

  /**
   * Fail-closed backstop for what the PAGE could do on its own: deny popups,
   * device/privacy permissions (camera, mic, geolocation, …), and downloads
   * (no browser_download tool yet). Same-tab http(s) navigation flows freely so
   * logins and in-site links work; the agent re-gates effects per page.
   */
  private applySecurityBackstop(): void {
    const { session } = this.wc;
    // Once per shared partition session, not once per view (see backstopInstalledFor).
    if (backstopInstalledFor.has(session)) return;
    backstopInstalledFor.add(session);
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on('will-download', (event) => event.preventDefault());
  }

  private openExternal(url: string): void {
    const safe = safeExternalUrl(url);
    if (safe) void shell.openExternal(safe).catch(() => {});
  }

  private async loadInternal(url: string): Promise<void> {
    // loadURL rejects on aborted/failed loads (e.g. a superseding navigation);
    // the did-fail-load handler already surfaces errors, so swallow here.
    try {
      await this.wc.loadURL(url);
    } catch {
      /* surfaced via did-fail-load */
    }
  }

  state(): BrowserState {
    if (this.destroyed || this.wc.isDestroyed()) {
      return deriveBrowserState({ url: '', title: '', canGoBack: false, canGoForward: false, loading: false });
    }
    const wc = this.wc;
    return deriveBrowserState({
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
    });
  }

  private emitState(): void {
    if (this.destroyed) return;
    this.onState(this.sessionId, this.state());
  }

  async navigate(input: string): Promise<void> {
    const url = parseNavigable(input);
    if (!url) return;
    await this.loadInternal(url);
  }

  goBack(): void {
    if (this.wc.navigationHistory.canGoBack()) this.wc.navigationHistory.goBack();
  }

  goForward(): void {
    if (this.wc.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward();
  }

  reload(): void {
    this.wc.reload();
  }

  stop(): void {
    this.wc.stop();
  }

  /** Position + show the view over `rect`, or hide it when the rect is empty/null. */
  setViewport(rect: BrowserViewRect | null): void {
    if (this.destroyed) return;
    const bounds = viewportBounds(rect);
    const show = Boolean(bounds);
    // Background throttling tracks shown-ness, toggled only on the transition.
    // A HIDDEN conversation's cached page must throttle so a backgrounded one
    // can't burn CPU/battery (the visible lease forbids driving it anyway). A
    // SHOWN view keeps full speed: a native CDP click hit-tests a composited
    // frame, which the OS drops on a throttled view whenever the app isn't
    // focused — so "shown but app unfocused" still has to stay un-throttled to
    // let the approved click land. (hideAllExcept fires setViewport(null) on
    // every switch away, so this is where a conversation going off screen
    // restores its throttle.)
    if (show !== this.shownWithBounds && !this.wc.isDestroyed()) {
      this.wc.setBackgroundThrottling(!show);
    }
    if (!bounds) {
      this.shownWithBounds = false;
      this.view.setVisible(false);
      return;
    }
    this.shownWithBounds = true;
    this.view.setBounds(bounds);
    this.view.setVisible(true);
  }

  /** Visible-lease input: the view is on screen with non-empty bounds (see canDrive). */
  hasLiveViewport(): boolean {
    return !this.destroyed && this.shownWithBounds;
  }

  /** True when this view's renderer is background-throttled (hidden). Read-only. */
  isBackgroundThrottled(): boolean {
    return !this.wc.isDestroyed() && this.wc.getBackgroundThrottling();
  }

  /**
   * Resolve true once the view is composited on screen again (hasLiveViewport),
   * or false if it has not within `timeoutMs`. The mutate lease awaits this so
   * the FIRST click/type after a browser permission grant lands: the permission
   * modal hides the native view (the renderer sends setViewport(null) while it
   * is open) and only re-reports the strip a frame or two after the modal
   * closes — without this wait the lease would reject the just-approved action
   * before that restore arrives. Polls rather than subscribing: the restore is a
   * single sub-100ms event, so a short poll is simpler than waiter bookkeeping.
   */
  async waitForLiveViewport(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.hasLiveViewport()) {
      if (this.destroyed || signal?.aborted || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, VIEWPORT_RESTORE_POLL_MS));
    }
    return true;
  }

  /**
   * Bring up (or reuse) the CDP automation bridge over this view's WebContents
   * and return its sealed, main-process-only endpoint.
   */
  async attachAutomation(): Promise<AutomationEndpoint> {
    // A view that has never loaded a document has no renderer process, and
    // debugger commands stall forever instead of failing — the client's
    // connect-time Page.enable would eat its whole 30s CDP timeout. Commit
    // about:blank first so the CDP session always has a live target (the UI
    // treats about: as "no page", and the probe maps it to no URL).
    if (!this.wc.getURL() && !this.wc.isDestroyed()) {
      try {
        await this.wc.loadURL('about:blank');
      } catch {
        /* a racing real navigation provides a document too */
      }
    }
    if (!this.automation) this.automation = new CdpBridge(this.wc);
    // Background throttling is governed by setViewport (shown ⇒ un-throttled),
    // not here: the visible lease only drives a view while its conversation is
    // on screen, so by the time automation runs the view is already shown and
    // un-throttled, and a later switch away re-throttles it via setViewport(null).
    return this.automation.start();
  }

  async detachAutomation(): Promise<void> {
    await this.automation?.stop();
    this.automation = null;
  }

  async dispose(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // Final empty-state push: the renderer panel outlives the view, so without
    // this it would keep showing stale hasPage/url for a page that is gone.
    this.onState(
      this.sessionId,
      deriveBrowserState({ url: '', title: '', canGoBack: false, canGoForward: false, loading: false }),
    );
    // Tear down the ws bridge; the debugger detaches with the wc.close() below.
    // Each step guarded so a half-gone window (during quit) can't strand the rest.
    await this.automation?.stop().catch(() => {});
    this.automation = null;
    try {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
    } catch {
      /* window already torn down */
    }
    try {
      if (!this.wc.isDestroyed()) this.wc.close();
    } catch {
      /* webContents already destroyed */
    }
  }
}
