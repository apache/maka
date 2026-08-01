/**
 * PR-SHOW-AFTER-FIRST-COMMIT contract.
 *
 * The BrowserWindow is now created `show: false` on every run so the OS never
 * flashes the index.html `.maka-preload` skeleton before React paints. The
 * renderer signals `window:notifyRendererReady` after its first React commit,
 * and a fallback timer reveals the window if that signal never arrives. Under
 * e2e-fixture capture the window must stay hidden for its whole life.
 *
 * The reveal decision lives in showWindowOnceReady (window-reveal.ts) precisely
 * so it can be exercised behaviorally here — main-window.ts can't be imported
 * under plain `node --test` because it pulls in `electron`, whose API is only
 * present inside the Electron binary.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createWindowRevealGate,
  showWindowOnceReady,
  type FocusableRevealableWindow,
  type RevealableWindow,
} from '../window-reveal.js';

/** Fake window that flips visible on show() and records every show() call. */
function makeFakeWindow(): RevealableWindow & { showCount: number; destroy(): void } {
  let visible = false;
  let destroyed = false;
  let showCount = 0;
  return {
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    show() {
      showCount += 1;
      visible = true;
    },
    destroy() {
      destroyed = true;
    },
    get showCount() {
      return showCount;
    },
  };
}

/** Fake window with the focus surface the reveal gate's deferred focus touches. */
function makeFakeFocusableWindow(): FocusableRevealableWindow & {
  showCount: number;
  focusCount: number;
  maximizeCount: number;
  destroy(): void;
} {
  let visible = false;
  let destroyed = false;
  let showCount = 0;
  let focusCount = 0;
  let maximizeCount = 0;
  return {
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore() {},
    show() {
      showCount += 1;
      visible = true;
    },
    focus() {
      focusCount += 1;
    },
    maximize() {
      // Mirror the real Electron behavior this gate exists to contain:
      // maximize() on a hidden window reveals it (verified on macOS).
      maximizeCount += 1;
      visible = true;
    },
    destroy() {
      destroyed = true;
    },
    get showCount() {
      return showCount;
    },
    get focusCount() {
      return focusCount;
    },
    get maximizeCount() {
      return maximizeCount;
    },
  };
}

// ChatGPT Pro review P2: second-instance / 'activate' land in controller
// focus() while the window may still be pre-first-commit. The gate must defer
// (not show) those requests, then flush them when the renderer signals ready.
describe('window reveal gate defers early focus (ChatGPT Pro review P2)', () => {
  it('focus before renderer-ready does not show; markReady flushes show+focus', () => {
    const gate = createWindowRevealGate(false);
    const win = makeFakeFocusableWindow();
    // User re-launches / clicks the dock icon while the window is hidden.
    gate.requestFocus(win);
    assert.equal(win.showCount, 0, 'pre-ready focus must not reveal the skeleton');
    assert.equal(win.isVisible(), false);
    // First commit arrives: reveal once and honor the deferred foreground intent.
    gate.markReady(win);
    assert.equal(win.isVisible(), true);
    assert.equal(win.focusCount, 1);
  });

  it('focus after renderer-ready shows and focuses immediately (old behavior)', () => {
    const gate = createWindowRevealGate(false);
    const win = makeFakeFocusableWindow();
    gate.markReady(win);
    gate.requestFocus(win);
    assert.equal(win.isVisible(), true);
    assert.equal(win.focusCount, 1);
  });

  it('keepHidden (e2e-fixture / E2E) never shows or focuses from any path', () => {
    const gate = createWindowRevealGate(true);
    const win = makeFakeFocusableWindow();
    gate.requestFocus(win);
    gate.markReady(win);
    gate.requestFocus(win);
    assert.equal(win.showCount, 0);
    assert.equal(win.focusCount, 0);
  });

  // ChatGPT Pro review P2 (round 2): Electron's maximize() reveals a hidden
  // window, so restoring a saved maximized state in createWindow() bypassed
  // the gate — a user who closed the app maximized saw the skeleton again on
  // every launch. The gate must defer the maximize alongside focus.
  it('saved-maximized restore before renderer-ready stays hidden; markReady applies it', () => {
    const gate = createWindowRevealGate(false);
    const win = makeFakeFocusableWindow();
    // createWindow() restores the persisted maximized state on a hidden window.
    gate.requestMaximize(win);
    assert.equal(win.maximizeCount, 0, 'pre-ready maximize must not reveal the skeleton');
    assert.equal(win.isVisible(), false);
    // First commit: maximize lands first, so the first visible frame is
    // already maximized and the reveal itself becomes a no-op.
    gate.markReady(win);
    assert.equal(win.maximizeCount, 1);
    assert.equal(win.isVisible(), true);
    assert.equal(win.showCount, 0, 'maximize() already revealed; show() must not fire again');
  });

  it('maximize after renderer-ready applies immediately; keepHidden never maximizes', () => {
    const readyGate = createWindowRevealGate(false);
    const readyWin = makeFakeFocusableWindow();
    readyGate.markReady(readyWin);
    readyGate.requestMaximize(readyWin);
    assert.equal(readyWin.maximizeCount, 1);

    const fixtureGate = createWindowRevealGate(true);
    const fixtureWin = makeFakeFocusableWindow();
    fixtureGate.requestMaximize(fixtureWin);
    fixtureGate.markReady(fixtureWin);
    fixtureGate.requestMaximize(fixtureWin);
    assert.equal(fixtureWin.maximizeCount, 0);
    assert.equal(fixtureWin.isVisible(), false);
  });

  it('reset() re-arms the gate for a recreated window (macOS close-all)', () => {
    const gate = createWindowRevealGate(false);
    const first = makeFakeFocusableWindow();
    gate.markReady(first);
    gate.reset();
    const second = makeFakeFocusableWindow();
    // Stale readiness from the first window must not leak: focus and maximize
    // requests on the fresh hidden window defer again until its own first commit.
    gate.requestFocus(second);
    gate.requestMaximize(second);
    assert.equal(second.showCount, 0);
    assert.equal(second.maximizeCount, 0);
    gate.markReady(second);
    assert.equal(second.isVisible(), true);
    assert.equal(second.focusCount, 1);
    assert.equal(second.maximizeCount, 1);
  });
});

describe('window reveal gate (PR-SHOW-AFTER-FIRST-COMMIT)', () => {
  it('renderer-ready reveals the hidden window exactly once (idempotent)', () => {
    const win = makeFakeWindow();
    // First commit signal reveals the hidden window.
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 1);
    assert.equal(win.isVisible(), true);
    // HMR reload re-fires the signal, and the fallback timer may race it — the
    // isVisible() guard makes every later call a no-op so focus is never stolen.
    showWindowOnceReady(win, false);
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 1);
  });

  it('fallback timer path reveals a window that never signaled', () => {
    // The timer routes through the same gate with keepHidden=false: a wedged
    // renderer still gets a visible window.
    const win = makeFakeWindow();
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 1);
    assert.equal(win.isVisible(), true);
  });

  it('e2e-fixture (keepHidden) never reveals, from either the signal or the timer', () => {
    const win = makeFakeWindow();
    // Renderer-ready path.
    showWindowOnceReady(win, true);
    // Fallback-timer path.
    showWindowOnceReady(win, true);
    assert.equal(win.showCount, 0);
    assert.equal(win.isVisible(), false);
  });

  it('never reveals a null or destroyed window (teardown raced the timer/IPC)', () => {
    assert.doesNotThrow(() => showWindowOnceReady(null, false));
    const win = makeFakeWindow();
    win.destroy();
    showWindowOnceReady(win, false);
    assert.equal(win.showCount, 0);
  });
});
