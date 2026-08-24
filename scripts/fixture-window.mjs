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

// Boot an e2e-fixture window and evaluate in its renderer.
//
// This is the same launch the Playwright E2E suite performs, driven from a
// plain script so the migration contract harness can run outside the test
// runner. The environment builder and the bounded teardown are shared with
// that suite rather than restated; the launch, readiness wait, and teardown
// go through Playwright's Electron support rather than a second hand-rolled
// CDP client.
//
// An earlier version of this file did roll its own: fixed debug ports, a
// `/json/list` poll, a raw WebSocket, and a process-group kill. It attached to
// whatever was listening on the port, which meant a leftover Electron from a
// previous run was captured instead of the window this call launched — a
// silent wrong-window pass on a contract whose entire value is "no diff means
// the migration did not move this element".
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { closeElectronApplication } from './electron-lifecycle.mjs';
import { buildFixtureEnv, isCiLinuxDisplay } from './fixture-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_DIR = join(ROOT, 'apps', 'desktop');

export const DEFAULT_READY_TIMEOUT_MS = Number(process.env.FIXTURE_READY_TIMEOUT_MS ?? 30_000);
export const DEFAULT_SETTLE_MS = Number(process.env.FIXTURE_SETTLE_MS ?? 1_000);
// Playwright's evaluate has no deadline of its own: a renderer that wedges or
// an expression that returns a never-settling promise would hang the run
// forever. Generous, because a capture expression walks the whole tree.
const EVALUATE_TIMEOUT_MS = Number(process.env.FIXTURE_EVALUATE_TIMEOUT_MS ?? 60_000);
// Grace for ElectronApplication.close() before the process tree is SIGKILLed.
const CLOSE_GRACE_MS = 5_000;
/**
 * Pinned so a capture taken here matches one taken anywhere else. Any IANA
 * name works; UTC is the one nobody has to look up.
 */
export const CAPTURE_TIMEZONE = process.env.FIXTURE_TIMEZONE ?? 'UTC';

/**
 * Electron 43 defaults to native Wayland when XDG_SESSION_TYPE=wayland, where
 * BrowserWindow.showInactive() is unsupported. Keep inactive fixtures on
 * XWayland; other launches retain Electron's platform default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function inactiveWindowElectronArgs(env = process.env, platform = process.platform) {
  return platform === 'linux' && env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland'
    ? ['.', '--ozone-platform=x11']
    : ['.'];
}

/**
 * Map the BrowserWindow owned by this launch without focusing it.
 *
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {import('@playwright/test').Page} page
 */
async function mapFixtureWindowInactive(app, page) {
  const windowHandle = await app.browserWindow(page);
  try {
    const state = await windowHandle.evaluate((window) => {
      window.showInactive();
      return {
        visible: window.isVisible(),
        focused: window.isFocused(),
      };
    });
    if (!state.visible || state.focused) {
      throw new Error(
        `inactive fixture mapping failed: visible=${state.visible} focused=${state.focused}`,
      );
    }
  } finally {
    await windowHandle.dispose();
  }
}

// Freeze everything that would otherwise make two captures of the same build
// differ: in-flight transitions and animations, caret blink, and text that
// reflows when a webfont swaps in. Returns once the renderer has painted twice
// with all of that settled.
// Durations go to zero rather than the animation being removed. `animation:
// none` cancels the animation and leaves the element at its static value —
// for an entry animation that starts at `opacity: 0` and fills forwards, that
// static value is invisible, so freezing that way would hide the very surface
// a capture is meant to look at. Zero duration runs the animation to its final
// frame instantly instead.
const SETTLE_EXPR = `(async () => {
  if (!document.getElementById('maka-contract-freeze')) {
    const style = document.createElement('style');
    style.id = 'maka-contract-freeze';
    style.textContent = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}';
    document.head.appendChild(style);
  }
  try { await document.fonts.ready; } catch {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

/**
 * Boot one fixture window, hand a renderer evaluator to `fn`, then tear the
 * window down.
 *
 * `fn` receives `{ evaluate, page }`. `evaluate(expression)` returns the
 * expression's value, awaited if it is a promise. `page` is the Playwright
 * page, for the cases that want a selector wait or an input event rather than
 * an expression.
 *
 * @param {string} scenario MAKA_E2E_FIXTURE scenario name.
 * @param {{
 *   theme?: 'light' | 'dark',
 *   platform?: 'darwin' | 'win32' | 'linux',
 *   mapWindowInactive?: boolean,
 *   readySelector?: string,
 *   readyTimeoutMs?: number,
 *   settleMs?: number,
 *   desktopDir?: string,
 * }} [options]
 * @param {(ctx: { evaluate: (expression: string) => Promise<any>, page: import('@playwright/test').Page }) => Promise<any>} fn
 */
export async function withFixtureWindow(scenario, options, fn) {
  const {
    theme = 'light',
    platform,
    // Hit testing needs a mapped window, not foreground focus. Keep the app
    // accessory/Dock-hidden and map only this launch's BrowserWindow.
    mapWindowInactive = false,
    // Every route names the element that means "this surface has rendered".
    // Without one the only alternative is a fixed sleep, which reports a
    // half-mounted route as a clean one on a slow machine.
    readySelector = '#root',
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleMs = DEFAULT_SETTLE_MS,
    // Which build to boot. The two-sided visual compare launches the base
    // ref's build from a temporary worktree through the same launcher.
    desktopDir = DESKTOP_DIR,
  } = options ?? {};
  // xvfb throttles a hidden window's compositor to ~1fps; only that isolated
  // display gets a visible window. Local hit tests stay accessory/Dock-hidden.
  const ciVisible = isCiLinuxDisplay();
  const launchArgs = mapWindowInactive && !ciVisible ? inactiveWindowElectronArgs() : ['.'];

  const userDataDir = await mkdtemp(join(tmpdir(), 'maka-fixture-'));
  // Inside the throwaway userData dir so the same teardown removes it; there
  // is no second path to leak.
  const homeDir = join(userDataDir, 'home');
  await mkdir(homeDir, { recursive: true });
  /** @type {import('@playwright/test').ElectronApplication | undefined} */
  let app;
  const rendererLogs = [];
  try {
    app = await electron.launch({
      args: launchArgs,
      cwd: desktopDir,
      env: buildFixtureEnv(userDataDir, homeDir, {
        scenario,
        theme,
        platform,
        showWindow: ciVisible,
        timezone: CAPTURE_TIMEZONE,
      }),
    });
    const page = await app.firstWindow();
    if (mapWindowInactive && !ciVisible) await mapFixtureWindowInactive(app, page);
    page.on('console', (message) => {
      rendererLogs.push(`[console:${message.type()}] ${message.text()}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    page.on('pageerror', (error) => {
      rendererLogs.push(`[pageerror] ${error.stack ?? error.message}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    try {
      await page.waitForSelector(readySelector, { timeout: readyTimeoutMs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const logs = rendererLogs.length > 0 ? `\nRenderer console:\n${rendererLogs.join('\n')}` : '';
      throw new Error(
        `${scenario}: readiness selector ${readySelector} never appeared${logs}\n${detail}`,
      );
    }
    // Readiness says the surface mounted; this covers the paint after it.
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    const evaluate = (expression) =>
      withDeadline(page.evaluate(expression), EVALUATE_TIMEOUT_MS, `${scenario}: evaluate`);
    await evaluate(SETTLE_EXPR);
    return await fn({ evaluate, page });
  } finally {
    try {
      // Bounded: a wedged Electron must cost seconds, not a hung run. The
      // same close the E2E suite uses — grace, then SIGKILL the tree.
      if (app) await closeElectronApplication(app, CLOSE_GRACE_MS);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
}

/**
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 * @param {string} label
 */
async function withDeadline(promise, timeoutMs, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
