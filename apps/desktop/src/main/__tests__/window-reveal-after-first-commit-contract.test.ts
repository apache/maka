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
 * present inside the Electron binary. The timer / IPC / creation wiring around
 * the gate is pinned with source-contract assertions below.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  createWindowRevealGate,
  showWindowOnceReady,
  type FocusableRevealableWindow,
  type RevealableWindow,
} from '../window-reveal.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const readRepoFile = (repoPath: string): Promise<string> =>
  readFile(resolve(REPO_ROOT, repoPath), 'utf8');

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

describe('window reveal wiring (PR-SHOW-AFTER-FIRST-COMMIT)', () => {
  it('only reveals fixture windows for Linux CI under xvfb, or when a caller asks', async () => {
    // The rule lives in the launch-environment builder shared by the E2E suite
    // and the migration contract harness, so both get the same isolation. The
    // builder itself is a pure function of its arguments — the one ambient
    // read (CI + linux) lives in isCiLinuxDisplay for callers to compose, so
    // its tests mean the same thing on a laptop and on the CI runner.
    const src = await readRepoFile('scripts/fixture-env.mjs');
    assert.match(
      src,
      /platform === 'linux'/,
      'visible windows are only needed for Linux compositor pacing under xvfb',
    );
    assert.match(
      src,
      /env\.MAKA_E2E_SHOW_WINDOW = '1'/,
      'the builder owns the variable; nothing else may set it',
    );
    assert.match(
      src,
      /if \(options\.showWindow\) env\.MAKA_E2E_SHOW_WINDOW/,
      'a caller that needs the compositor (hit testing, real input) must ask for a visible window explicitly rather than exporting the variable',
    );
    const e2e = await readRepoFile('apps/desktop/e2e/fixtures.ts');
    assert.match(
      e2e,
      /showWindow: isCiLinuxDisplay\(\)/,
      'the E2E suite composes the ambient Linux-CI escape hatch explicitly',
    );
  });

  it('owns Electron launch before waiting for the first E2E window so startup failures can be cleaned up', async () => {
    const src = await readRepoFile('apps/desktop/e2e/fixtures.ts');
    const helperStart = src.indexOf('async function withE2eWindow(');
    const helperEnd = src.indexOf('\nexport const test =', helperStart);
    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);
    const helper = src.slice(helperStart, helperEnd);
    const tryIndex = helper.indexOf('try {');
    const launchIndex = helper.indexOf('app = await electron.launch(');
    const firstWindowIndex = helper.indexOf('await app.firstWindow(');
    assert.ok(tryIndex !== -1 && launchIndex > tryIndex, 'Electron must be assigned inside the lifecycle try block');
    assert.ok(firstWindowIndex > launchIndex, 'the app handle must be retained before firstWindow can time out');
  });

  it('main-window creates the window hidden and wires the reveal fallback timer', async () => {
    const src = await readRepoFile('apps/desktop/src/main/main-window.ts');
    // Every run now creates hidden — no `!app.isPackaged && startHidden` gate.
    assert.match(
      src,
      /new BrowserWindow\(\{[\s\S]*?\n\s*show: false,/,
      'BrowserWindow must be created with show: false unconditionally',
    );
    assert.doesNotMatch(
      src,
      /\?\?\?|!app\.isPackaged && startHidden \? \{ show: false \} : \{\}/,
      'the old conditional show: false creation gate must be gone',
    );
    // Fallback timer with the documented 4s budget, routed through the gate.
    assert.match(src, /SHOW_FALLBACK_TIMEOUT_MS\s*=\s*4000/);
    assert.match(
      src,
      /setTimeout\([\s\S]*?revealGate\.markReady\(mainWindow\)[\s\S]*?SHOW_FALLBACK_TIMEOUT_MS\)/,
      'the fallback timer must reveal through the reveal gate',
    );
    // The countdown starts after the document load, otherwise a cold Vite
    // transform can consume the timeout and reveal the preload skeleton.
    const rendererLoadIndex = src.indexOf('await mainWindow.loadURL');
    const fallbackTimerIndex = src.indexOf('showFallbackTimer = setTimeout');
    assert.notEqual(rendererLoadIndex, -1);
    assert.notEqual(fallbackTimerIndex, -1);
    assert.ok(fallbackTimerIndex > rendererLoadIndex, 'fallback must start after renderer load');
    // Timer must not run for e2e-fixture or already-revealed windows, and
    // must clear on close.
    assert.match(
      src,
      /if \(!keepHiddenForE2eFixture && !mainWindow\.isVisible\(\)\) \{\s*showFallbackTimer = setTimeout/,
    );
    assert.match(
      src,
      /mainWindow\.on\('close', \(\) => \{\s*clearShowFallbackTimer\(\);/,
      'the fallback timer must be cleared when the window closes',
    );
    // Renderer-ready controller method cancels the timer then reveals.
    assert.match(
      src,
      /notifyRendererReady\(\) \{[\s\S]*?clearShowFallbackTimer\(\);[\s\S]*?revealGate\.markReady\(mainWindow\);/,
      'notifyRendererReady must clear the timer and reveal through the gate',
    );
    // ChatGPT Pro review P2: focus() (second-instance / activate) must route
    // through the gate instead of calling mainWindow.show() directly, so a
    // pre-first-commit focus request can never flash the skeleton.
    assert.match(
      src,
      /focus\(\) \{[\s\S]*?revealGate\.requestFocus\(mainWindow\);\s*\},/,
      'controller focus() must defer through revealGate.requestFocus',
    );
    // A fresh window re-arms the gate before creation.
    assert.match(
      src,
      /revealGate\.reset\(\);\s*mainWindow = new BrowserWindow\(/,
      'createWindow must reset the reveal gate for each window lifecycle',
    );
    // ChatGPT Pro review P2 (round 2): the saved-maximized restore must defer
    // through the gate — a direct mainWindow.maximize() reveals the hidden
    // window before the renderer's first commit.
    assert.match(
      src,
      /if \(bounds\.isMaximized\) \{\s*revealGate\.requestMaximize\(mainWindow\);/,
      'saved-maximized restore must route through revealGate.requestMaximize',
    );
    assert.doesNotMatch(
      src,
      /mainWindow\.maximize\(\)/,
      'createWindow must never call mainWindow.maximize() directly',
    );
  });

  it('main registers the window:notifyRendererReady IPC handler', async () => {
    const src = await readMainProcessCombinedSource();
    assert.match(
      src,
      /ipcMain\.handle\('window:notifyRendererReady',[\s\S]*?mainWindowController\.notifyRendererReady\(\)/,
      'main must forward window:notifyRendererReady to the controller',
    );
  });

  it('preload exposes appWindow.notifyRendererReady over the same channel', async () => {
    const src = await readRepoFile('apps/desktop/src/preload/preload.ts');
    assert.match(
      src,
      /notifyRendererReady\(\): Promise<void> \{\s*return ipcRenderer\.invoke\('window:notifyRendererReady'\);/,
    );
  });

  it('the renderer signals ready only after the committed UI has painted', async () => {
    const src = await readRepoFile('apps/desktop/src/renderer/app.tsx');
    // A layout effect is still before paint and can reveal the BrowserWindow
    // while Chromium's last composited frame is the preload skeleton. A nested
    // animation frame waits through one paint before notifying main.
    assert.doesNotMatch(src, /useLayoutEffect/);
    assert.match(
      src,
      /useEffect\(\(\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?notifyRendererReady\?\.\(\)/,
    );
    assert.match(src, /cancelAnimationFrame\(firstFrame\)/);
    assert.match(src, /cancelAnimationFrame\(secondFrame\)/);
  });
});
