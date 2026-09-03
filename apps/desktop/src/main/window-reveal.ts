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
 * PR-SHOW-AFTER-FIRST-COMMIT: shared reveal gate for the hidden main window.
 *
 * The BrowserWindow is created with `show: false` (main-window.ts) so the OS
 * never flashes the index.html `.maka-preload` skeleton before React paints.
 * Two callers reveal it: the `window:notifyRendererReady` IPC (fired from the
 * renderer's first React commit) and a fallback timer for a wedged renderer.
 * Both route through here so the show() decision lives in one place — and so
 * it stays unit-testable without an Electron runtime (main-window.ts itself
 * can't be imported under plain `node --test` because it pulls in `electron`).
 */

/**
 * How far this run is allowed to go when it reveals the main window.
 *
 *  - `hidden`: never reveal. E2E-fixture captures paint the hidden window via
 *    `paintWhenInitiallyHidden`, so pixels arrive without a window on screen.
 *  - `inactive`: reveal, never raise. An E2E run that asked for a visible
 *    window (`MAKA_E2E_SHOW_WINDOW`) needs the compositor and a real layout —
 *    a hidden window is throttled to ~1fps under xvfb and geometry assertions
 *    need one — but taking the foreground from the developer running the suite
 *    is never part of that.
 *  - `active`: the product. Reveal and honor foreground intent.
 */
export type WindowRevealMode = 'hidden' | 'inactive' | 'active';

/**
 * The run's reveal mode. `showWindowRequested` (MAKA_E2E_SHOW_WINDOW) asks for
 * a visible window; it does not ask for focus, so it can only lift `hidden` to
 * `inactive`. Only a run that is not an E2E run at all is `active`.
 *
 * A packaged build ignores a stray E2E flag entirely. That rule lives here
 * rather than in one consumer, because both of them — the reveal gate and the
 * dock rule — have to read the same answer; a build whose window may take
 * focus while the dock treats it as an accessory app is neither mode.
 */
export function resolveWindowRevealMode(
  isE2eRun: boolean,
  showWindowRequested: boolean,
  isPackaged: boolean,
): WindowRevealMode {
  if (isPackaged || !isE2eRun) return 'active';
  return showWindowRequested ? 'inactive' : 'hidden';
}

/** Minimal structural view of the BrowserWindow surface the gate touches. */
export interface RevealableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  /** Reveals without activating the app — the `inactive` mode's only reveal. */
  showInactive(): void;
}

/**
 * Reveal `win` unless it must stay hidden. Idempotent and focus-safe:
 * - `hidden` mode: never reveal.
 * - `inactive` mode: reveal with showInactive(), so the window appears where
 *   it belongs without pulling the app to the front.
 * - null / destroyed window: no-op (teardown raced the timer or the IPC).
 * - already visible: no-op, so a second signal (HMR reload re-fires
 *   notifyRendererReady, or the timer races the signal) never re-shows and
 *   never steals foreground focus.
 */
export function showWindowOnceReady(win: RevealableWindow | null, mode: WindowRevealMode): void {
  if (mode === 'hidden') return;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) return;
  if (mode === 'inactive') win.showInactive();
  else win.show();
}

/** Focus surface for deferred focus requests (see createWindowRevealGate). */
export interface FocusableRevealableWindow extends RevealableWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  maximize(): void;
}

export interface WindowRevealGate {
  /** Re-arm for a freshly created window (macOS recreate after close-all). */
  reset(): void;
  /** Renderer first commit or fallback timeout: reveal + flush deferred work. */
  markReady(win: FocusableRevealableWindow | null): void;
  /** Focus request (second-instance / activate): deferred until markReady. */
  requestFocus(win: FocusableRevealableWindow | null): void;
  /** Saved-bounds maximize restore: deferred until markReady — Electron's
   * maximize() shows a hidden window, which would bypass the gate. */
  requestMaximize(win: FocusableRevealableWindow | null): void;
}

/**
 * Readiness-aware wrapper around showWindowOnceReady. Focus requests that
 * arrive before the renderer's first commit (user re-launches or clicks the
 * dock icon while the window is still hidden) must NOT show() the window —
 * that would flash the `.maka-preload` skeleton the hidden creation exists to
 * suppress. They are remembered and flushed as show()+focus() when markReady
 * fires, so the user's foreground intent is honored, just not early.
 *
 * The same deferral applies to restoring a saved maximized state: Electron's
 * BrowserWindow.maximize() reveals a still-hidden window (verified on macOS),
 * so createWindow must not call it directly — requestMaximize holds the
 * intent and markReady applies it right before the reveal. In `active` mode
 * that means the window's first on-screen frame is already maximized. An
 * `inactive` window cannot have both: the reveal that maximize() performs is
 * an activating one, so it is revealed inactively first and then maximized,
 * and the zoom is visible. Not taking the foreground is worth more than the
 * single frame, and an E2E run has no saved maximized bounds to restore.
 *
 * `hidden` windows (e2e-fixture capture / E2E) never show, maximize, or take
 * focus from any path — captures run while the developer works elsewhere.
 * `inactive` windows appear but stay behind: a focus request reveals them and
 * stops there, so an E2E run's own activate / second-instance traffic cannot
 * pull the app in front of whatever the developer is doing.
 */
export function createWindowRevealGate(mode: WindowRevealMode): WindowRevealGate {
  let ready = false;
  let pendingFocus = false;
  let pendingMaximize = false;

  const focusNow = (win: FocusableRevealableWindow | null): void => {
    if (mode === 'hidden') return;
    if (!win || win.isDestroyed()) return;
    if (mode === 'inactive') {
      showWindowOnceReady(win, mode);
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const maximizeNow = (win: FocusableRevealableWindow | null): void => {
    if (mode === 'hidden') return;
    if (!win || win.isDestroyed()) return;
    // maximize() reveals a still-hidden window, and that reveal activates the
    // app. Reveal it inactively first so the maximize has nothing left to show.
    if (mode === 'inactive') showWindowOnceReady(win, mode);
    win.maximize();
  };

  return {
    reset() {
      ready = false;
      pendingFocus = false;
      pendingMaximize = false;
    },
    markReady(win) {
      ready = true;
      // Maximize first: in `active` mode it implicitly shows the window, so
      // the reveal below becomes a no-op and the first visible frame is
      // already maximized.
      if (pendingMaximize) {
        pendingMaximize = false;
        maximizeNow(win);
      }
      showWindowOnceReady(win, mode);
      if (pendingFocus) {
        pendingFocus = false;
        focusNow(win);
      }
    },
    requestFocus(win) {
      if (!ready) {
        pendingFocus = true;
        return;
      }
      focusNow(win);
    },
    requestMaximize(win) {
      if (!ready) {
        pendingMaximize = true;
        return;
      }
      maximizeNow(win);
    },
  };
}
