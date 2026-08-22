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

/**
 * Cursor overlay window (main-process half) — the Maka-owned, Codex-style agent
 * cursor. A transparent, always-on-top, click-through BrowserWindow that hosts a
 * Canvas running the ported CursorEngine (Dubins glide + spring). MAIN drives it
 * with per-action coordinates; the window persists across actions and repositions
 * the cursor live over a one-way `overlay:move` channel (no teardown-per-move).
 *
 * Path 18 gates:
 *  - S13: action/session-scoped lifecycle; teardown is synchronous + event-driven,
 *    no timer keeps it alive.
 *  - S14 (load-bearing): `focusable:false` + `setIgnoreMouseEvents(true,{forward:true})`
 *    armed BEFORE show + `showInactive()` (never `.focus()`). The preload is
 *    RECEIVE-ONLY (main→renderer), so the overlay can never call back / inject.
 *  - S15: MAIN owns coordinates; the renderer only paints what MAIN sends.
 *  - S18: teardown is a single synchronous `destroy()`.
 *
 * Electron is required lazily so the module loads under `node --test`; tests
 * inject a fake window factory + bounds resolver.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import type { CuPresentationFence } from '@maka/runtime/computer-use-types';
import { resolveOverlayAssetDir } from '../overlay-assets.js';
import { cursorPresentationReadyDeadlineMs } from '../../renderer/computer-use-overlay/engine/cursor-engine.js';

const requireElectron = createRequire(import.meta.url);

// Shared cursor-move contract lives in @maka/computer-use so the CLI can drive the
// same hook against a headless sink. This controller is the Electron implementation
// of that sink (it also satisfies OverlayCursorSink structurally via ensure/move).
export type { CursorMoveInput } from '@maka/computer-use';
import type {
  CursorCancelInput,
  CursorCompleteInput,
  CursorMoveInput,
} from '@maka/computer-use';

/** Minimal window surface the controller drives (fake-able in node --test). */
export interface CursorOverlayWindowLike {
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  setAlwaysOnTop(flag: boolean, level?: string, relativeLevel?: number): void;
  /** `orderWindow(.above, relativeTo:)`, by media source id (`window:<id>:0`). */
  moveAbove(mediaSourceId: string): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  loadFile(path: string): Promise<void>;
  showInactive(): void;
  isDestroyed(): boolean;
  destroy(): void;
  /** webContents.send — the one-way main→renderer push. */
  send(channel: string, payload: unknown): void;
  /** Fire cb once the page has loaded (webContents 'did-finish-load'). */
  onReady(cb: () => void): void;
  onGone(cb: () => void): void;
  onPresentationPhase(
    cb: (payload: {
      sessionId: string;
      generation: number;
      actionId: string;
      phase: 'readyForInteraction' | 'finished';
    }) => void,
  ): void;
}

export interface CreateCursorOverlayControllerDeps {
  createOverlayWindow?: (options: BrowserWindowConstructorOptions) => CursorOverlayWindowLike;
  resolveOverlayBounds?: () => Rectangle;
  /** Absolute path to the built overlay preload (dist/overlay/cursor-overlay-preload.cjs). */
  preloadPath?: string;
  /** Absolute path to the built overlay html (dist/overlay/cursor-overlay.html). */
  htmlPath?: string;
  onDisplayFrame?: (input: { actionId: string; completedAt: number; displayedAt: number }) => void;
  subscribeDisplayChanges?: (cb: () => void) => () => void;
}

export interface CursorOverlayController {
  /** Lazily create/refresh the overlay for a session (palette from sessionId). */
  ensure(sessionId: string): void;
  /** Move the cursor to a per-action screen coordinate (creates the window if needed). */
  move(input: CursorMoveInput): CuPresentationFence;
  /** Reconcile the display with the coordinate where backend execution completed. */
  complete(input: CursorCompleteInput): void;
  /** Finish a failed presentation without inventing a completion coordinate. */
  cancel(input: CursorCancelInput): void;
  /** Per-session teardown (the clearComputerUseOverlay(sessionId) bag). */
  clearForSession(sessionId: string): void;
  /** User abort (Esc) — tears down when actionId matches the live overlay. */
  abort(actionId: string): void;
  /** Unconditional teardown (window close / quit). */
  destroyAll(): void;
  isActive(): boolean;
  getSessionId(): string | null;
}

/**
 * Two window levels, one per reason class, ported from Codex's
 * `OverlayWindowLevelReasons`.
 *
 * FLIGHT is `NSPopUpMenuWindowLevel + 1` = 102 = `kCGOverlayWindowLevel`, the
 * exact level Codex raises its cursor to while a reason holds. Above every
 * application window and above open menus (the agent drives menus, so the
 * cursor has to be visible over them), below the screen saver and below the
 * real hardware cursor. `'screen-saver'` — which this used to sit at
 * unconditionally — is 1000, high enough to paint over the screen saver and
 * over system alerts.
 *
 * REST is Codex's ordering, done the way Codex does it. Codex sinks the cursor
 * to the TARGET window's own level and calls `orderWindow(.above, relativeTo:)`
 * with the target's window number, so a window later raised over the target
 * covers the cursor too.
 *
 * This comment used to say Electron exposes no ordering relative to a foreign
 * window, and settled for `'floating'` (3) — above every ordinary application
 * window. That is the level a person reported twice as the cursor "leaking to
 * the foreground": an arrow hanging over whatever they were reading, pointing
 * at a window buried behind it.
 *
 * The claim was false for this Electron. `BrowserWindow.moveAbove(mediaSourceId)`
 * parses `window:<CGWindowID>:<n>` and calls
 * `orderWindowByShuffling:NSWindowAbove relativeTo:` — the same AppKit
 * primitive. Verified against foreign windows owned by other processes:
 *
 *   - `moveAbove` while always-on-top is a silent no-op. AppKit ordering is
 *     confined within a window level, so the level has to go first.
 *   - `setAlwaysOnTop(false)` alone is also not enough: it drops to layer 0 but
 *     leaves the overlay at the FRONT of it, still covering everything.
 *   - The two together both promote and demote, landing the overlay
 *     immediately above the named window, still unfocused.
 *   - An id that no longer names a window throws; a window that is alive but
 *     not in the ordered list (hidden, minimised, another Space) returns ok and
 *     orders the overlay to the front of its layer.
 *
 * `CURSOR_LEVEL.rest` therefore stays, as the fallback for the two cases where
 * ordering cannot be done: no usable target id, and a reorder that threw.
 */
const CURSOR_LEVEL = {
  flight: { name: 'pop-up-menu', relative: 1 },
  rest: { name: 'floating', relative: 0 },
} as const;

type CursorLevel = keyof typeof CURSOR_LEVEL;

/** S14 window options — the focus/click-through contract surface, one literal. */
export function cursorOverlayWindowOptions(bounds: Rectangle, preloadPath: string): BrowserWindowConstructorOptions {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    focusable: false, // S14: never take keyboard focus from the driven app
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: false,
    show: false, // shown via showInactive() only after click-through is armed
    backgroundColor: '#00000000',
    enableLargerThanScreen: true,
    webPreferences: {
      // Receive-only preload: exposes ipcRenderer.on callbacks, never send/invoke.
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}

export function createCursorOverlayController(
  deps: CreateCursorOverlayControllerDeps = {},
): CursorOverlayController {
  const createOverlayWindow = deps.createOverlayWindow ?? defaultCreateOverlayWindow;
  const resolveOverlayBounds = deps.resolveOverlayBounds ?? defaultResolveOverlayBounds;
  const overlayAssetDir = resolveOverlayAssetDir(import.meta.url);
  const preloadPath = deps.preloadPath ?? join(overlayAssetDir, 'cursor-overlay-preload.cjs');
  const htmlPath = deps.htmlPath ?? join(overlayAssetDir, 'cursor-overlay.html');
  const subscribeDisplayChanges = deps.subscribeDisplayChanges
    ?? defaultSubscribeDisplayChanges;

  let win: CursorOverlayWindowLike | null = null;
  let sessionId: string | null = null;
  let actionId: string | null = null;
  let bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  let ready = false;
  let generation = 0;
  let level: CursorLevel | null = null;
  /**
   * Codex's `petLaunch` reason, minus the launch: it is cleared when the motion
   * settles, and only if the observation said the target is exposed under the
   * cursor. Sticky across a settle we never hear about (cancel, teardown,
   * a renderer that goes away), because staying up is the safe direction.
   */
  let mayRest = false;
  /**
   * The window the resting cursor should sit directly above.
   *
   * Held rather than passed, because the rest transition happens later than the
   * move that knows it: the renderer reports `'finished'` and only then does the
   * cursor sink.
   */
  let restTargetWindowId: number | null = null;
  /**
   * The window the overlay was last actually ordered above, so a rest that
   * names a different window is recognised as a new state rather than a repeat
   * of the level it is already at.
   */
  let orderedWindowId: number | null = null;
  let queue: Array<{ channel: string; payload: unknown }> = [];
  let unsubscribeDisplayChanges: (() => void) | undefined;
  let presentation:
    | {
        actionId: string;
        ready: () => void;
        finish: () => void;
        fence: CuPresentationFence;
        completedAt?: number;
      }
    | undefined;

  function createPresentation(action: string): NonNullable<typeof presentation> {
    let readyForInteraction!: () => void;
    let finished!: () => void;
    const fence: CuPresentationFence = {
      readyForInteraction: new Promise<void>((resolve) => { readyForInteraction = resolve; }),
      finished: new Promise<void>((resolve) => { finished = resolve; }),
      // What the renderer's release gate needs at worst, derived from the very
      // spring that gate is read against. The runtime's own backstop was picked
      // independently and is shorter than a long move takes, so it used to
      // resolve the action with the glyph still hundreds of points out.
      readyTimeoutMs: cursorPresentationReadyDeadlineMs(),
    };
    return {
      actionId: action,
      ready: readyForInteraction,
      finish: finished,
      fence,
    };
  }

  function settlePresentation(): void {
    presentation?.ready();
    presentation?.finish();
    presentation = undefined;
  }

  function applyLevel(next: CursorLevel): void {
    if (!win) return;
    // Resting is not a level alone, it is a level plus a position in another
    // window's z-order, so "already resting" is not the same state when the
    // window to rest above has changed. Re-order in that case; a plain repeat
    // of the same level against the same window is still a no-op.
    if (level === next && !(next === 'rest' && restTargetWindowId !== orderedWindowId)) return;
    // Both calls are needed and the order matters: the level has to come off
    // before AppKit will order across it, and dropping the level without
    // ordering leaves the overlay at the front of the layer, covering exactly
    // what it was supposed to stop covering.
    if (next === 'rest' && restTargetWindowId !== null) {
      win.setAlwaysOnTop(false);
      try {
        win.moveAbove(`window:${restTargetWindowId}:0`);
        orderedWindowId = restTargetWindowId;
      } catch {
        // The target went away between the action and the settle. Without
        // putting the level back the cursor is stranded at normal level,
        // buried, and stays there until the next action.
        win.setAlwaysOnTop(true, CURSOR_LEVEL.rest.name, CURSOR_LEVEL.rest.relative);
        orderedWindowId = null;
      }
      level = next;
      return;
    }
    level = next;
    orderedWindowId = null;
    const { name, relative } = CURSOR_LEVEL[next];
    // The flag decides whether a level applies at all. `false` here would drop
    // the overlay to normal level with no ordering guarantee against the app
    // being driven — which is what the rest branch above pairs with an order.
    win.setAlwaysOnTop(true, name, relative);
  }

  function teardown(): void {
    const w = win;
    win = null;
    sessionId = null;
    actionId = null;
    settlePresentation();
    ready = false;
    level = null;
    mayRest = false;
    restTargetWindowId = null;
    orderedWindowId = null;
    queue = [];
    unsubscribeDisplayChanges?.();
    unsubscribeDisplayChanges = undefined;
    if (w && !w.isDestroyed()) w.destroy();
  }

  function push(channel: string, payload: unknown): void {
    if (!win) return;
    if (ready) win.send(channel, payload);
    else queue.push({ channel, payload });
  }

  function ensure(nextSessionId: string): void {
    if (typeof nextSessionId !== 'string' || nextSessionId.length === 0) return;
    if (win && !win.isDestroyed() && sessionId === nextSessionId) return;
    // Different session (or dead window) → supersede so no orphan survives.
    if (win) teardown();

    bounds = resolveOverlayBounds();
    generation += 1;
    const windowGeneration = generation;
    const w = createOverlayWindow(cursorOverlayWindowOptions(bounds, preloadPath));
    // S14 (load-bearing): arm click + focus pass-through BEFORE the window shows.
    w.setIgnoreMouseEvents(true, { forward: true });
    win = w;
    level = null;
    mayRest = false;
    orderedWindowId = null;
    applyLevel('flight');
    try {
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* not supported everywhere; best-effort */
    }
    sessionId = nextSessionId;
    ready = false;
    queue = [];
    // Rebuild only when the screen area this window has to cover has actually
    // moved. The overlay spans the union of every display's *bounds*, and the
    // event this subscribes to reports any metrics change at all — including
    // `workArea`, which twitches by a couple of points whenever the menu bar or
    // the Dock changes shape and says nothing about where the displays are.
    //
    // Tearing down on the bare event destroyed the overlay for reasons that had
    // nothing to do with it. Measured on this machine with a second display
    // attached: `display-metrics-changed` arrives with `["workArea"]` and the
    // primary display's work area alternating between 875 and 873 points high,
    // roughly every two seconds, with no windows open at all. The overlay is
    // created when an action begins and its HTML takes longer than that to
    // load, so the window was routinely destroyed before `onReady` ever fired —
    // never shown, never on screen, and reported by the scenario harness as
    // "the agent cursor overlay — never appeared" on any turn short enough to
    // dispatch only once.
    unsubscribeDisplayChanges = subscribeDisplayChanges(() => {
      if (win !== w) return;
      if (sameRect(resolveOverlayBounds(), bounds)) return;
      teardown();
    });
    w.onReady(() => {
      if (win !== w) return; // superseded during load
      ready = true;
      w.send('overlay:reset', {
        sessionId: nextSessionId,
        generation: windowGeneration,
      });
      for (const m of queue) w.send(m.channel, m.payload);
      queue = [];
      w.showInactive();
    });
    w.onGone(() => {
      if (win === w) teardown();
    });
    w.onPresentationPhase((payload) => {
      if (
        win !== w
        || payload.sessionId !== sessionId
        || payload.generation !== windowGeneration
        || !presentation
        || payload.actionId !== presentation.actionId
      ) return;
      if (payload.phase === 'readyForInteraction') presentation.ready();
      else {
        const completed = presentation;
        presentation = undefined;
        completed.ready();
        completed.finish();
        // The motion has landed. Codex clears `petLaunch` here, and only here.
        if (mayRest) applyLevel('rest');
        if (completed.completedAt !== undefined) {
          deps.onDisplayFrame?.({
            actionId: completed.actionId,
            completedAt: completed.completedAt,
            displayedAt: Date.now(),
          });
        }
        if (actionId === completed.actionId) actionId = null;
      }
    });
    void w.loadFile(htmlPath).catch(() => {
      if (win === w) teardown();
    });
  }

  function resolveRestTarget(targetWindowId: number | undefined): number | null {
    return Number.isInteger(targetWindowId) && (targetWindowId as number) > 0
      ? (targetWindowId as number)
      : null;
  }

  function move(input: CursorMoveInput): CuPresentationFence {
    if (
      typeof input.sessionId !== 'string'
      || input.sessionId.length === 0
      || !Number.isFinite(input.screenX)
      || !Number.isFinite(input.screenY)
    ) {
      return { readyForInteraction: Promise.resolve(), finished: Promise.resolve() };
    }
    ensure(input.sessionId);
    settlePresentation();
    actionId = input.actionId;
    restTargetWindowId = resolveRestTarget(input.targetWindowId);
    // A launch: up while it flies, and it stays up unless this action's
    // observation positively said the target is exposed right where the cursor
    // lands. Silence is not that evidence.
    mayRest = input.keepElevated === false;
    applyLevel('flight');
    const nextPresentation = createPresentation(input.actionId);
    presentation = nextPresentation;
    // Screen → window-local so the renderer paints at origin (0,0).
    push('overlay:move', {
      actionId: input.actionId,
      x: input.screenX - bounds.x,
      y: input.screenY - bounds.y,
      kind: input.kind,
      pressed: input.pressed === true,
      ...(input.instant === true ? { instant: true } : {}),
    });
    return nextPresentation.fence;
  }

  function complete(input: CursorCompleteInput): void {
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return;
    if (!Number.isFinite(input.screenX) || !Number.isFinite(input.screenY)) return;
    if (input.sessionId !== sessionId) return;
    if (presentation && input.actionId !== presentation.actionId) return;
    actionId = input.actionId;
    // The landing is the last thing that happens before the cursor sinks, and
    // it is allowed to name a different window than the move did: an action
    // whose `onActionBegin` never ran (no presentation point to fly to) reaches
    // here with the only window id this action ever carried. Reading it only in
    // `move()` left the sink ordering the cursor above the *previous* action's
    // window — behind the one it is now pointing at.
    const landingTarget = resolveRestTarget(input.targetWindowId);
    if (landingTarget !== null) restTargetWindowId = landingTarget;
    if (presentation?.actionId === input.actionId) {
      // Reconciling to the executor's coordinate is another launch, so the
      // cursor goes back up for the trip. Only while a presentation is live:
      // without one there is no `finished` to come back down on, and a level
      // raised with no way down is the static `'screen-saver'` again.
      applyLevel('flight');
      presentation.completedAt = Date.now();
    } else if (level === 'rest') {
      // No presentation means no `finished` will arrive to sink the cursor, so
      // this is the only chance to put it above the window it just landed on.
      // Without it the cursor stays ordered above the previous action's window
      // — behind the one it is now pointing at.
      applyLevel('rest');
    }
    push('overlay:complete', {
      actionId: input.actionId,
      x: input.screenX - bounds.x,
      y: input.screenY - bounds.y,
      kind: input.kind,
      pulse: input.pulse,
    });
  }

  function cancel(input: CursorCancelInput): void {
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return;
    if (input.sessionId !== sessionId || input.actionId !== actionId) return;
    push('overlay:cancel', { actionId: input.actionId });
  }

  function clearForSession(id: string): void {
    if (typeof id !== 'string' || id.length === 0) return;
    if (id !== sessionId) return;
    teardown();
  }
  function abort(id: string): void {
    if (typeof id !== 'string' || id.length === 0) return;
    if (id !== actionId) return;
    teardown();
  }

  return {
    ensure,
    move,
    complete,
    cancel,
    clearForSession,
    abort,
    destroyAll: teardown,
    isActive: () => win !== null,
    getSessionId: () => sessionId,
  };
}

function defaultCreateOverlayWindow(options: BrowserWindowConstructorOptions): CursorOverlayWindowLike {
  const { BrowserWindow } = requireElectron('electron') as typeof import('electron');
  const bw = new BrowserWindow(options);
  return {
    setIgnoreMouseEvents: (ignore, opts) => bw.setIgnoreMouseEvents(ignore, opts),
    setAlwaysOnTop: (flag, level, relativeLevel) =>
      bw.setAlwaysOnTop(flag, level as Parameters<typeof bw.setAlwaysOnTop>[1], relativeLevel),
    // The id is built by hand rather than taken from `desktopCapturer`: that
    // would raise a Screen Recording prompt for a string the frame binding
    // already gave us.
    moveAbove: (mediaSourceId) => bw.moveAbove(mediaSourceId),
    setVisibleOnAllWorkspaces: (visible, opts) => bw.setVisibleOnAllWorkspaces(visible, opts),
    loadFile: (path) => bw.loadFile(path),
    showInactive: () => bw.showInactive(),
    isDestroyed: () => bw.isDestroyed(),
    destroy: () => bw.destroy(),
    send: (channel, payload) => { if (!bw.isDestroyed()) bw.webContents.send(channel, payload); },
    onReady: (cb) => bw.webContents.once('did-finish-load', cb),
    onGone: (cb) => {
      bw.once('closed', cb);
      bw.webContents.once('render-process-gone', cb);
      bw.webContents.once('destroyed', cb);
    },
    onPresentationPhase: (cb) => {
      bw.webContents.on('ipc-message', (_event, channel, payload) => {
        if (channel !== 'overlay:presentation-phase') return;
        if (!payload || typeof payload !== 'object') return;
        const candidate = payload as Record<string, unknown>;
        if (
          typeof candidate.actionId !== 'string'
          || typeof candidate.sessionId !== 'string'
          || !Number.isInteger(candidate.generation)
          || (
            candidate.phase !== 'readyForInteraction'
            && candidate.phase !== 'finished'
          )
        ) return;
        cb({
          sessionId: candidate.sessionId,
          generation: candidate.generation as number,
          actionId: candidate.actionId,
          phase: candidate.phase,
        });
      });
    },
  };
}

function defaultSubscribeDisplayChanges(cb: () => void): () => void {
  const { screen } = requireElectron('electron') as typeof import('electron');
  const added = () => cb();
  const removed = () => cb();
  const changed = () => cb();
  screen.on('display-added', added);
  screen.on('display-removed', removed);
  screen.on('display-metrics-changed', changed);
  return () => {
    screen.removeListener('display-added', added);
    screen.removeListener('display-removed', removed);
    screen.removeListener('display-metrics-changed', changed);
  };
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function defaultResolveOverlayBounds(): Rectangle {
  const { screen } = requireElectron('electron') as typeof import('electron');
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return screen.getPrimaryDisplay().bounds;
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map(
    (display) => display.bounds.x + display.bounds.width,
  ));
  const bottom = Math.max(...displays.map(
    (display) => display.bounds.y + display.bounds.height,
  ));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}
