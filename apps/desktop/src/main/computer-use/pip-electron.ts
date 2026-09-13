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

// apps/desktop/src/main/computer-use/pip-electron.ts
//
// Where the picture-in-picture mirror meets Electron: the window options it is
// created with, where its assets live, how a display's work area becomes the
// tile's bounds, and the adapter around a real BrowserWindow.
//
// `ParentWindowLike` and `PipWindowLike` come with it rather than staying
// behind. They describe what this layer needs of a window, and leaving them in
// pip-window.ts would have made the dependency circular — the controller would
// import the Electron layer and the Electron layer would import the controller
// back for its own parameter types.

/**
 * The subset of a BrowserWindow needed to parent the mirror.
 *
 * Structural rather than `BrowserWindow` so the controller stays testable
 * without Electron; the one place that needs the real thing is the `parent`
 * constructor option, which is cast at that boundary.
 */
import { createRequire } from 'node:module';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import { resolveOverlayAssetDir } from '../overlay-assets.js';
import {
  PIP_DEFAULT_EDGE,
  PIP_MARGIN,
  PIP_MAX_EDGE,
  PIP_MIN_EDGE,
} from './pip-motion.js';

export interface ParentWindowLike {
  isDestroyed(): boolean;
}

export interface PipWindowLike {
  send(channel: string, payload: unknown): void;
  onReady(cb: () => void): void;
  onGone(cb: () => void): void;
  /**
   * The page could not be loaded, so `onReady` will never fire.
   *
   * Without this the two states are indistinguishable from the controller's
   * side: `onReady` gates showing the window and starting the hover watch, so
   * a failed load leaves a window that is never shown, never made
   * interactive, never torn down, and silently accumulating queued frames —
   * one leaked per session, looking exactly like a mirror that is working.
   * A missing `dist/overlay/pip.html` (the overlay build not re-run) is
   * enough to produce it.
   */
  onLoadFailure(cb: (reason: string) => void): void;
  /**
   * Messages from this window's renderer only.
   *
   * Scoped to the WebContents rather than global `ipcMain`, so the drag and
   * the controls cannot be driven by any other renderer in the app.
   */
  onMessage(cb: (channel: string, payload: unknown) => void): void;
  setBounds(bounds: Rectangle): void;
  getBounds(): Rectangle;
  showInactive(): void;
  /** Click-through, with mouse moves still forwarded to the page. */
  setIgnoreMouseEvents(ignore: boolean): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export function defaultDistDir(): string {
  return resolveOverlayAssetDir(import.meta.url);
}

/**
 * Bottom-right of the primary display, sized to the target's aspect ratio.
 *
 * Deliberately not centred and not on top of the user's likely work area: the
 * mirror is peripheral information, and a window that lands in the middle of
 * the screen to tell you about background work has defeated its own purpose.
 */
export function pipDisplaySize(
  aspect: number,
  maxEdge: number = PIP_DEFAULT_EDGE,
): { width: number; height: number } {
  // Aspect-preserving fit into a square box, exactly as Codex does it: scale by
  // min(edge/w, edge/h) so the longest edge lands on `edge` and never above.
  // Non-finite input falls back to the default rather than producing NaN
  // bounds, which is what Codex's own clamp does.
  const edge = Number.isFinite(maxEdge)
    ? Math.min(PIP_MAX_EDGE, Math.max(PIP_MIN_EDGE, Math.round(maxEdge)))
    : PIP_DEFAULT_EDGE;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return {
    width: ratio >= 1 ? edge : Math.max(1, Math.round(edge * ratio)),
    height: ratio >= 1 ? Math.max(1, Math.round(edge / ratio)) : edge,
  };
}

/**
 * Place the mirror against the app window's bottom-right, inset by the same
 * 24pt Codex uses, and clamp it onto whichever display actually contains it.
 *
 * The clamp matters more than the anchor: an app window near a screen edge
 * would otherwise push the mirror off-screen or onto a neighbouring display,
 * which is exactly the "why is there something on my second monitor" failure.
 */
export function pipBoundsForAnchor(
  aspect: number,
  anchor: Rectangle | undefined,
  workArea: Rectangle,
): Rectangle {
  const { width, height } = pipDisplaySize(aspect);
  const base = anchor ?? workArea;
  const x = base.x + base.width - width - PIP_MARGIN;
  const y = base.y + base.height - height - PIP_MARGIN;
  return {
    width,
    height,
    x: Math.min(Math.max(x, workArea.x + PIP_MARGIN), workArea.x + workArea.width - width - PIP_MARGIN),
    y: Math.min(Math.max(y, workArea.y + PIP_MARGIN), workArea.y + workArea.height - height - PIP_MARGIN),
  };
}

export function defaultResolveBounds(aspect: number, anchor?: Rectangle): Rectangle {
  const require = createRequire(import.meta.url);
  const { screen } = require('electron') as typeof import('electron');
  const display = anchor
    ? screen.getDisplayMatching(anchor)
    : screen.getPrimaryDisplay();
  return pipBoundsForAnchor(aspect, anchor, display.workArea);
}

/**
 * Recovered from Codex's `RemoteHostedPIPContentCreateStackPanel`, which builds
 * the panel as:
 *
 *   NSPanel styleMask: 0x80  (NSWindowStyleMaskNonactivatingPanel)
 *   setLevel: 0              (NSNormalWindowLevel — deliberately not floating)
 *   setOpaque: NO, backgroundColor: clearColor
 *   setHasShadow: NO         (the content draws its own)
 *   setHidesOnDeactivate: NO
 *   setMovableByWindowBackground: NO
 *
 * and then attaches it to the owner window with `addChildWindow:ordered:`.
 * Every option below that has an Electron equivalent follows it.
 */
export function pipWindowOptions(
  bounds: Rectangle,
  preloadPath: string,
  parent?: ParentWindowLike,
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    // Same focus contract as the cursor overlay: this reports on work happening
    // elsewhere, so taking focus would interrupt the very thing it describes.
    // Electron's `focusable: false` is what a nonactivating panel buys Codex.
    focusable: false,
    frame: false,
    transparent: true,
    // Codex's `setHasShadow: NO`. pip.html already draws its own shadow, so the
    // native one is a second shadow on top of it — and on a transparent window
    // the window server recomputes that shadow from the content's alpha every
    // time a frame lands, which is the one thing this window does constantly.
    hasShadow: false,
    // A child window is ordered against its parent, so it sits above the app it
    // belongs to and below everything it does not. Only when there is no app
    // window to attach to does the mirror have to claim a level of its own —
    // otherwise it would be buried with nothing to sit above.
    ...(parent ? { parent: parent as import('electron').BrowserWindow } : { alwaysOnTop: true }),
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export function defaultCreateWindow(
  options: BrowserWindowConstructorOptions,
  htmlPath: string,
): PipWindowLike {
  const require = createRequire(import.meta.url);
  const { BrowserWindow } = require('electron') as typeof import('electron');
  const w = new BrowserWindow(options);
  // Click-through with moves forwarded: the page still sees the pointer cross
  // it, which is how it knows to ask for the clicks back.
  w.setIgnoreMouseEvents(true, { forward: true });
  // A load failure has to be both audible and terminal. `did-finish-load` is
  // what tells the controller the window is usable; a failed load emits
  // `did-fail-load` instead, so nothing would ever fire and the window would
  // sit there invisible and undestroyed for the rest of the process's life.
  // Report it once, from whichever of the two signals arrives first.
  let reportLoadFailure: ((reason: string) => void) | undefined;
  let failure: string | undefined;
  const fail = (reason: string): void => {
    if (failure !== undefined) return;
    failure = reason;
    console.error(`[computer-use] picture-in-picture failed to load ${htmlPath}: ${reason}`);
    reportLoadFailure?.(reason);
  };
  w.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // A subframe failing is not this window failing to exist.
      if (!isMainFrame) return;
      fail(`${errorDescription || 'load failed'} (${errorCode}) ${validatedURL}`);
    },
  );
  void w.loadFile(htmlPath).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
  const PIP_CHANNELS = [
    'pip:pointer-down',
    'pip:pointer-move',
    'pip:pointer-up',
    'pip:control',
    'pip:resize-begin',
    'pip:resize-move',
    'pip:resize-end',
  ] as const;
  return {
    send: (channel, payload) => w.webContents.send(channel, payload),
    onReady: (cb) => w.webContents.once('did-finish-load', cb),
    onGone: (cb) => w.once('closed', cb),
    onLoadFailure: (cb) => {
      reportLoadFailure = cb;
      // The failure can beat the subscription: `loadFile` is started in this
      // function and the controller subscribes after it returns. Replaying it
      // is what keeps a fast failure from being lost.
      if (failure !== undefined) cb(failure);
    },
    onMessage: (cb) => {
      // `webContents.ipc` is scoped to this window, so nothing else in the app
      // can drive the mirror by sending on the same channel names.
      for (const channel of PIP_CHANNELS) {
        w.webContents.ipc.on(channel, (_event, payload) => cb(channel, payload));
      }
    },
    setBounds: (bounds) => w.setBounds(bounds),
    getBounds: () => w.getBounds(),
    showInactive: () => w.showInactive(),
    setIgnoreMouseEvents: (ignore) => w.setIgnoreMouseEvents(ignore, { forward: true }),
    isDestroyed: () => w.isDestroyed(),
    destroy: () => w.destroy(),
  };
}
